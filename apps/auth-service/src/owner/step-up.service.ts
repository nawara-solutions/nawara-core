import { BadRequestException, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/ports.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { ThrottleService } from '../throttle/throttle.service.js';
import { ChallengeService } from './challenge.service.js';
import { FactorService } from './factor.service.js';
import { SecretKeyService } from './secret-key.service.js';

export type StepUpMethod = 'secret_key' | 'totp' | 'webauthn';

/**
 * The server-side allow-list of sensitive operations and, for each, which re-verification methods
 * are acceptable. Purposes not listed cannot be stepped up for. A factor-only purpose can NOT be
 * satisfied with the secret key: a leaked key must not be able to rotate itself, add an attacker's
 * factor, remove the owner's, or change the password.
 */
export const STEP_UP_METHODS = {
  'platform_assignment.grant': ['totp', 'webauthn', 'secret_key'],
  'platform_assignment.revoke': ['totp', 'webauthn', 'secret_key'],
  'platform.create': ['totp', 'webauthn', 'secret_key'],
  // Organization Service administration (ADR-0042 Amendment 1, A.2): owner-initiated create Organization
  // is sensitive. Verified/consumed for organization-service via POST /auth/step-up/verify.
  'organization.create': ['totp', 'webauthn', 'secret_key'],
  'operator.create': ['totp', 'webauthn', 'secret_key'],
  'owner.secret_key.rotate': ['totp', 'webauthn'],
  'owner.factor.enroll': ['totp', 'webauthn'],
  'owner.factor.remove': ['totp', 'webauthn'],
  'owner.password.change': ['totp', 'webauthn'],
  // Organization onboarding (ADR-0028). An Owner acts with step-up; operators/org admins have none.
  'join_code.create': ['totp', 'webauthn', 'secret_key'],
  'join_code.revoke': ['totp', 'webauthn', 'secret_key'],
  // Minting an organization administrator is a privilege grant: factor only, never the bare key.
  'organization.admin.grant': ['totp', 'webauthn'],
  'organization.admin.revoke': ['totp', 'webauthn'],
  // Minting or revoking an administrator invitation is a privilege grant: factor only, never the bare key.
  'admin_invitation.create': ['totp', 'webauthn'],
  'admin_invitation.revoke': ['totp', 'webauthn'],
} as const satisfies Record<string, readonly StepUpMethod[]>;
export type StepUpPurpose = keyof typeof STEP_UP_METHODS;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StepUpRequest {
  ownerId: string;
  sid: string;
  purpose: string;
  method: StepUpMethod;
  code?: string;
  secretKey?: string;
  challengeId?: string;
  assertion?: AuthenticationResponseJSON;
}

@Injectable()
export class StepUpService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(FactorService) private readonly factors: FactorService,
    @Inject(SecretKeyService) private readonly secretKeys: SecretKeyService,
    @Inject(ChallengeService) private readonly challenges: ChallengeService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private allowed(purpose: string, method: StepUpMethod): boolean {
    const m = (STEP_UP_METHODS as Record<string, readonly StepUpMethod[]>)[purpose];
    return !!m && m.includes(method);
  }

  /** WebAuthn step-up needs a server challenge first; bound to this session and purpose. */
  async webauthnOptions(ownerId: string, sid: string, purpose: string, ip: string) {
    if (!this.allowed(purpose, 'webauthn')) throw new BadRequestException('Unsupported step-up.');
    await this.throttle.hit('step_up_ip', ip);
    await this.throttle.hit('step_up_owner', ownerId);
    const options = await this.factors.webauthnAuthenticationOptions(ownerId);
    const ch = await this.challenges.create(this.db, {
      ownerId, kind: 'step_up', ttlSec: this.cfg.stepUp.ttlSec, webauthnChallenge: options.challenge, sessionFamilyId: sid, purpose,
    });
    return { challengeId: ch.id, options };
  }

  async issue(r: StepUpRequest, ip: string): Promise<{ stepUpToken: string; expiresAt: Date }> {
    if (!this.allowed(r.purpose, r.method)) throw new BadRequestException('Unsupported step-up.');
    await this.throttle.hit('step_up_ip', ip);
    await this.throttle.hit('step_up_owner', r.ownerId);

    const { rows: u } = await this.db.query(`SELECT "isActive" FROM "user" WHERE id=$1 AND kind='owner'`, [r.ownerId]);
    if (!u[0]?.isActive) throw new UnauthorizedException('Verification failed.');

    let factorId: string | null = null;
    let ok = false;
    if (r.method === 'secret_key') {
      ok = !!r.secretKey && (await this.secretKeys.verify(r.ownerId, r.secretKey));
    } else if (r.method === 'totp') {
      const v = r.code ? await this.factors.verifyTotp(this.db, r.ownerId, r.code) : null;
      ok = !!v; factorId = v?.factorId ?? null;
    } else if (r.challengeId && r.assertion) {
      const ch = await this.challenges.findById(r.challengeId, 'step_up', r.ownerId);
      // The challenge must belong to THIS session and THIS purpose, and is spent before verifying.
      if (ch && ch.sessionFamilyId === r.sid && ch.purpose === r.purpose && ch.webauthnChallenge && (await this.challenges.consume(this.db, ch.id))) {
        const v = await this.factors.verifyWebauthn(this.db, r.ownerId, r.assertion, ch.webauthnChallenge);
        ok = !!v; factorId = v?.factorId ?? null;
      }
    }
    if (!ok) {
      await this.audit.tryRecord({ type: 'owner.step_up', outcome: 'failure', actorId: r.ownerId, sessionFamilyId: r.sid, ip, metadata: { purpose: r.purpose, method: r.method } });
      throw new UnauthorizedException('Verification failed.');
    }
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.cfg.stepUp.ttlSec * 1000);
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO owner_step_up(id,"ownerId",method,"factorId",purpose,"sessionFamilyId","verifiedAt","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, r.ownerId, r.method, factorId, r.purpose, r.sid, now, expiresAt],
    );
    await this.audit.record({ type: 'owner.step_up', outcome: 'success', actorId: r.ownerId, sessionFamilyId: r.sid, ip, metadata: { purpose: r.purpose, method: r.method } });
    // The id is not a bearer credential on its own: it is only honoured together with a live access
    // token of THIS owner and THIS session, for THIS purpose, once, before it expires.
    return { stepUpToken: id, expiresAt };
  }

  /**
   * Consumes a step-up INSIDE the caller's transaction, checking the whole security context in one
   * atomic statement: right owner, same session, same purpose, unconsumed, unexpired. If the
   * operation later fails and the transaction rolls back, the step-up is NOT burned.
   */
  async consume(q: Queryable, a: { ownerId: string; sid: string; purpose: StepUpPurpose; token: string | undefined }): Promise<void> {
    const denied = async () => {
      await this.audit.tryRecord({ type: 'owner.step_up.consume', outcome: 'denied', actorId: a.ownerId, sessionFamilyId: a.sid, metadata: { purpose: a.purpose } });
      return new ForbiddenException('A valid step-up verification is required for this action.');
    };
    if (!a.token || !UUID_RE.test(a.token)) throw await denied();
    const { rows } = await q.query(
      `UPDATE owner_step_up SET "consumedAt"=$5
        WHERE id=$1 AND "ownerId"=$2 AND "sessionFamilyId"=$3 AND purpose=$4 AND "consumedAt" IS NULL AND "expiresAt" > $5
        RETURNING method`,
      [a.token, a.ownerId, a.sid, a.purpose, this.clock.now()],
    );
    if (!rows[0] || !this.allowed(a.purpose, rows[0].method)) throw await denied();
  }
}
