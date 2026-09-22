import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../auth/session.service.js';
import type { ClientInfo } from '../common/client-info.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DbService } from '../db/db.service.js';
import { authError } from '../errors.js';
import { ThrottleService } from '../throttle/throttle.service.js';
import type { UserRow } from '../users/users.service.js';
import { UsersService } from '../users/users.service.js';
import { AdminDeviceService } from './admin-device.service.js';
import { ChallengeService } from './challenge.service.js';
import { FactorService } from './factor.service.js';

export type LoginChallengeResponse =
  | { status: 'mfa_required'; challengeToken: string; methods: Array<'totp' | 'webauthn'> }
  | { status: 'enrollment_required'; enrollmentToken: string }
  | { status: 'recovery_required' };

const GENERIC = 'Verification failed.';

/**
 * Owner sign-in: password (checked by AuthService) -> second factor (here) -> session.
 * There is NO path from a correct password to tokens: an owner without any confirmed factor gets a
 * restricted enrollment token (valid only to enroll a first factor), never a session. Nothing here
 * falls back to password-only, and the secret key is not accepted at all.
 */
@Injectable()
export class OwnerAuthService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(ChallengeService) private readonly challenges: ChallengeService,
    @Inject(FactorService) private readonly factors: FactorService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(AdminDeviceService) private readonly devices: AdminDeviceService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Called by AuthService after the PASSWORD is verified for an owner. */
  async beginLogin(owner: UserRow): Promise<LoginChallengeResponse> {
    const methods = await this.factors.methods(owner.id);
    if (methods.length > 0) {
      const ch = await this.challenges.create(this.db, { ownerId: owner.id, kind: 'login_mfa', ttlSec: this.cfg.challengeTtlSec, bearer: true });
      return { status: 'mfa_required', challengeToken: ch.token!, methods };
    }
    // Password-only enrollment exists for ONE situation: an owner who has NEVER had a factor (the
    // bootstrapped account). If a factor ever existed and is now gone (clone detection, recovery in
    // progress, ...), a password alone must not be able to plant a new one — that path is recovery
    // (secret key + cool-down), which issues its own enrollment token.
    if (await this.factors.everConfirmed(owner.id)) return { status: 'recovery_required' };
    const ch = await this.challenges.create(this.db, { ownerId: owner.id, kind: 'enrollment', ttlSec: this.cfg.challengeTtlSec, bearer: true });
    return { status: 'enrollment_required', enrollmentToken: ch.token! };
  }

  async webauthnLoginOptions(challengeToken: string, ip: string) {
    await this.throttle.hit('owner_verify_ip', ip);
    const ch = await this.challenges.findByToken('login_mfa', challengeToken);
    if (!ch) throw authError(401, 'verification_failed', GENERIC);
    await this.throttle.hit('owner_verify_owner', ch.ownerId);
    const options = await this.factors.webauthnAuthenticationOptions(ch.ownerId);
    await this.challenges.setWebauthnChallenge(this.db, ch.id, options.challenge);
    return options;
  }

  async verify(
    a: { challengeToken: string; method: 'totp' | 'webauthn'; code?: string; assertion?: AuthenticationResponseJSON },
    client: ClientInfo,
  ) {
    await this.throttle.hit('owner_verify_ip', client.ip);
    const ch = await this.challenges.findByToken('login_mfa', a.challengeToken);
    if (!ch) {
      await this.audit.tryRecord({ type: 'owner.login', outcome: 'failure', ip: client.ip, metadata: { stage: 'challenge' } });
      throw authError(401, 'verification_failed', GENERIC);
    }
    await this.throttle.hit('owner_verify_owner', ch.ownerId);
    const owner = await this.users.findById(ch.ownerId);
    if (!owner || owner.kind !== 'owner' || !owner.isActive) {
      await this.audit.tryRecord({ type: 'owner.login', outcome: 'denied', actorId: ch.ownerId, ip: client.ip, metadata: { stage: 'account' } });
      throw authError(401, 'verification_failed', GENERIC);
    }

    const session = await this.db.tx(async (q) => {
      let ok: { factorId: string } | null = null;
      if (a.method === 'totp' && a.code) ok = await this.factors.verifyTotp(q, owner.id, a.code);
      else if (a.method === 'webauthn' && a.assertion && ch.webauthnChallenge) ok = await this.factors.verifyWebauthn(q, owner.id, a.assertion, ch.webauthnChallenge);
      if (!ok) return null;
      if (!(await this.challenges.consume(q, ch.id))) return null; // single use, race-safe
      const s = await this.sessions.issue(q, owner);
      await this.audit.record({ type: 'owner.login', outcome: 'success', actorId: owner.id, sessionFamilyId: s.sid, ip: client.ip, metadata: { method: a.method } }, q);
      return s;
    });

    if (!session) {
      await this.challenges.recordFailure(ch.id);
      await this.audit.tryRecord({ type: 'owner.login', outcome: 'failure', actorId: owner.id, ip: client.ip, metadata: { stage: 'factor', method: a.method } });
      throw authError(401, 'verification_failed', GENERIC);
    }
    await this.throttle.reset('owner_verify_owner', owner.id);
    await this.devices.checkAndRecord(owner.id, client.userAgent, client.ip, owner.email ? { channel: 'email', destination: owner.email } : owner.phone ? { channel: 'phone', destination: owner.phone } : null);
    const { sid: _sid, ...tokens } = session;
    return tokens;
  }
}
