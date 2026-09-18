import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { ClientInfo } from '../common/client-info.js';
import { CLOCK, EVENT_BUS, type Clock, type EventBus } from '../common/ports.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PasswordService } from '../crypto/password.js';
import { randomToken, sha256Hex } from '../crypto/random.js';
import { DbService } from '../db/db.service.js';
import { RefreshTokenService } from '../tokens/refresh-token.service.js';
import { ThrottleService } from '../throttle/throttle.service.js';
import { UsersService, toIdentifier } from '../users/users.service.js';
import { ChallengeService } from './challenge.service.js';
import { FactorService } from './factor.service.js';
import { SecretKeyService } from './secret-key.service.js';

const GENERIC = 'Recovery failed.';

/**
 * Owner recovery — the highest-risk path, so it is deliberately NOT "password + key = new factors".
 *
 *   start    password + secret key  ->  a PENDING request with a mandatory COOL-DOWN. Nothing is
 *            revoked, spent or issued. The owner is alerted on every channel. Any existing session
 *            that still has a working factor can cancel it.
 *   complete (after the cool-down) recovery token + secret key AGAIN -> revokes all factors and all
 *            sessions, spends the key, returns ONLY an enrollment token. Never a session.
 *   enroll   the enrollment token can enroll a first factor (and only that); a session is issued
 *            only after a new factor is confirmed.
 *
 * What an attacker holding X can do: password only -> nothing beyond the MFA challenge; secret key
 * only -> cannot start (needs password); password + key -> can START, then must survive the cool-down
 * during which the real owner is alerted and can cancel; a stolen live session -> cannot recover at
 * all (no password/key) and every account-changing action needs a factor step-up (the key is not
 * accepted for factor changes, rotation, or password change). Residual risk: an attacker who holds
 * password + key AND stays unnoticed for the whole cool-down wins — see the security review.
 */
@Injectable()
export class RecoveryService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SecretKeyService) private readonly secretKeys: SecretKeyService,
    @Inject(FactorService) private readonly factors: FactorService,
    @Inject(ChallengeService) private readonly challenges: ChallengeService,
    @Inject(RefreshTokenService) private readonly refresh: RefreshTokenService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async start(a: { email?: string; phone?: string; password: string; secretKey: string }, client: ClientInfo) {
    const id = toIdentifier(a);
    await this.throttle.hit('recovery_ip', client.ip);
    await this.throttle.hit('recovery_identifier', 'email' in id ? id.email : id.phone);
    const user = await this.users.findByIdentifier(a);
    const owner = user?.kind === 'owner' && user.isActive ? user : null;
    // Both checks always run (dummy work when the account is unknown) so timing does not reveal state.
    const passwordOk = await this.passwords.verify(owner?.passwordHash, a.password);
    const keyOk = await this.secretKeys.verify(owner?.id ?? randomUUID(), a.secretKey);
    if (!owner || !passwordOk || !keyOk) {
      await this.audit.tryRecord({ type: 'owner.recovery.start', outcome: 'failure', ip: client.ip, actorId: owner?.id });
      throw new UnauthorizedException(GENERIC);
    }
    const now = this.clock.now();
    const token = randomToken();
    const availableAt = new Date(now.getTime() + this.cfg.recovery.cooldownSec * 1000);
    await this.db.tx(async (q) => {
      // One start at a time per owner: without this, two concurrent starts both cancel "nothing" and
      // then collide on owner_recovery_one_pending (a 500). The later start supersedes the earlier one.
      await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('owner_recovery:' || $1::text, 0))`, [owner.id]);
      await q.query(`UPDATE owner_recovery_request SET status='cancelled', "resolvedAt"=$2 WHERE "ownerId"=$1 AND status='pending'`, [owner.id, now]);
      await q.query(
        `INSERT INTO owner_recovery_request("ownerId","tokenHash","requestIp","createdAt","availableAt","expiresAt") VALUES ($1,$2,$3,$4,$5,$6)`,
        [owner.id, sha256Hex(token), client.ip, now, availableAt, new Date(availableAt.getTime() + this.cfg.recovery.requestTtlSec * 1000)],
      );
      await this.audit.record({ type: 'owner.recovery.start', outcome: 'success', actorId: owner.id, ip: client.ip, metadata: { cooldownSec: this.cfg.recovery.cooldownSec } }, q);
    });
    this.bus.publish('admin.owner_recovery_requested', {
      userId: owner.id, channel: owner.email ? 'email' : 'phone', destination: owner.email ?? owner.phone,
      availableAt: availableAt.toISOString(), ipAddress: client.ip, timestamp: now.toISOString(),
    });
    return { recoveryToken: token, availableAt };
  }

  /** Cancel from an authenticated owner session (one that still has a working factor). */
  async cancel(ownerId: string, sid: string, ip: string): Promise<void> {
    const { rowCount } = await this.db.query(
      `UPDATE owner_recovery_request SET status='cancelled', "resolvedAt"=$2 WHERE "ownerId"=$1 AND status='pending'`,
      [ownerId, this.clock.now()],
    );
    if (rowCount) await this.audit.record({ type: 'owner.recovery.cancel', outcome: 'success', actorId: ownerId, sessionFamilyId: sid, ip });
  }

  async complete(a: { recoveryToken: string; secretKey: string }, client: ClientInfo) {
    await this.throttle.hit('recovery_ip', client.ip);
    const now = this.clock.now();
    const { rows } = await this.db.query(
      `SELECT id, "ownerId", "availableAt", "expiresAt" FROM owner_recovery_request WHERE "tokenHash"=$1 AND status='pending'`,
      [sha256Hex(a.recoveryToken)],
    );
    const req = rows[0];
    if (!req || req.expiresAt <= now) {
      await this.audit.tryRecord({ type: 'owner.recovery.complete', outcome: 'failure', ip: client.ip });
      throw new UnauthorizedException(GENERIC);
    }
    await this.throttle.hit('recovery_identifier', req.ownerId);
    const owner = await this.users.findById(req.ownerId);
    if (!owner?.isActive || !(await this.secretKeys.verify(req.ownerId, a.secretKey))) {
      await this.audit.tryRecord({ type: 'owner.recovery.complete', outcome: 'failure', actorId: req.ownerId, ip: client.ip });
      throw new UnauthorizedException(GENERIC);
    }
    if (now < req.availableAt) {
      await this.audit.tryRecord({ type: 'owner.recovery.complete', outcome: 'denied', actorId: req.ownerId, ip: client.ip, metadata: { reason: 'cooldown' } });
      throw new ForbiddenException(`Recovery is not available until ${req.availableAt.toISOString()}.`);
    }
    const enrollment = await this.db.tx(async (q) => {
      const { rowCount } = await q.query(`UPDATE owner_recovery_request SET status='completed', "resolvedAt"=$2 WHERE id=$1 AND status='pending'`, [req.id, now]);
      if (rowCount !== 1) throw new UnauthorizedException(GENERIC); // lost a race: single use
      await this.factors.revokeAll(q, req.ownerId);
      await this.refresh.revokeAllForUser(q, req.ownerId);
      await this.secretKeys.spend(q, req.ownerId);
      await q.query(`UPDATE owner_auth_challenge SET "consumedAt"=$2 WHERE "ownerId"=$1 AND "consumedAt" IS NULL`, [req.ownerId, now]);
      const ch = await this.challenges.create(q, { ownerId: req.ownerId, kind: 'enrollment', ttlSec: this.cfg.recovery.enrollmentTtlSec, bearer: true });
      await this.audit.record({ type: 'owner.recovery.complete', outcome: 'success', actorId: req.ownerId, ip: client.ip }, q);
      return ch.token!;
    });
    this.bus.publish('admin.owner_recovery_completed', {
      userId: owner.id, channel: owner.email ? 'email' : 'phone', destination: owner.email ?? owner.phone, ipAddress: client.ip, timestamp: now.toISOString(),
    });
    return { status: 'enrollment_required' as const, enrollmentToken: enrollment };
  }
}
