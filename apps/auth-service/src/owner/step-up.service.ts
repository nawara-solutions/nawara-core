import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/ports.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { authError } from '../errors.js';
import { ThrottleService } from '../throttle/throttle.service.js';
import { ChallengeService } from './challenge.service.js';
import { FactorService } from './factor.service.js';
import { SecretKeyService } from './secret-key.service.js';
import { AUTH_MESSAGES } from '../messages.js';

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
  // Member account suspension / restoration (Stage 19.2, ADR-0050 decision 5): a security intervention on a whole identity, factor only.
  'account.suspend': ['totp', 'webauthn'],
  'account.restore': ['totp', 'webauthn'],
  // Release Management administration (Stage 20.4, ADR-0051 decision 8): the verified owner of the operating Company withdraws a release or
  // changes a component's minimum supported version. Each has its own purpose (a withdrawal proof cannot change a policy); factor only.
  // Verified and consumed by release-service through POST /auth/step-up/verify.
  'release.withdraw': ['totp', 'webauthn'],
  'compatibility_policy.change': ['totp', 'webauthn'],
  // Hierarchy reference repair (ADR-0061 §3, §4; A5.4-A1): a fresh, factor-only step-up, never the bare key. Consumed only by the
  // repair route, through consumeForReferenceRepair (A5.4-A3). The generic POST /auth/step-up/verify refuses it without consuming it
  // (ADR-0065 §4, S1: verifyForService), so a calling service can never burn a repair proof.
  'hierarchy.reference.repair': ['totp', 'webauthn'],
} as const satisfies Record<string, readonly StepUpMethod[]>;
export type StepUpPurpose = keyof typeof STEP_UP_METHODS;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The purpose of the hierarchy reference repair (ADR-0061 §3). The literal stays in this file (A5.4-A3 O10). */
const REFERENCE_REPAIR_PURPOSE = 'hierarchy.reference.repair' satisfies StepUpPurpose;

/**
 * What `consumeForReferenceRepair` knows after its one statement (ADR-0065 §5; A5.4-A3 O8):
 * - `consumed`: the statement completed and consumed the proof. It is spent for good.
 * - `rejected`: the statement completed and matched nothing (unknown, expired, already used, or not this owner, session, purpose or an
 *   allowed method), or no well-formed proof was presented. Nothing was consumed.
 * - `not_consumed`: the DATABASE reported that the statement failed and its implicit transaction was rolled back. Nothing was consumed.
 * - `uncertain`: anything else. The proof may or may not have been consumed; the caller must fail closed, must not retry the
 *   consumption, and must never report the proof as unused.
 */
export type RepairProofConsumption = 'consumed' | 'rejected' | 'not_consumed' | 'uncertain';

/**
 * Whether a failure of the single autocommit consume statement PROVES that nothing was committed. Deliberately narrow: only an error
 * report sent by PostgreSQL itself, at severity ERROR (the statement's implicit transaction is aborted and the session lives on), whose
 * status code does not say that completion is unknown. A status code alone is never enough: a FATAL or PANIC report carries one too and
 * can follow a commit. A connection failure, a client-side deadline, a lost answer or any other error proves nothing.
 */
function provesNothingCommitted(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const { severity, code } = e as { severity?: unknown; code?: unknown };
  if (severity !== 'ERROR') return false; // FATAL, PANIC, a localized severity, or not a database report at all
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return false;
  return !code.startsWith('08') && code !== '40003'; // connection exceptions; statement_completion_unknown
}

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
    if (!this.allowed(purpose, 'webauthn')) throw authError(400, 'step_up_unsupported', AUTH_MESSAGES.unsupportedStepUp);
    await this.throttle.hit('step_up_ip', ip);
    await this.throttle.hit('step_up_owner', ownerId);
    const options = await this.factors.webauthnAuthenticationOptions(ownerId);
    const ch = await this.challenges.create(this.db, {
      ownerId, kind: 'step_up', ttlSec: this.cfg.stepUp.ttlSec, webauthnChallenge: options.challenge, sessionFamilyId: sid, purpose,
    });
    return { challengeId: ch.id, options };
  }

  async issue(r: StepUpRequest, ip: string): Promise<{ stepUpToken: string; expiresAt: Date }> {
    if (!this.allowed(r.purpose, r.method)) throw authError(400, 'step_up_unsupported', AUTH_MESSAGES.unsupportedStepUp);
    await this.throttle.hit('step_up_ip', ip);
    await this.throttle.hit('step_up_owner', r.ownerId);

    const { rows: u } = await this.db.query(`SELECT "isActive" FROM "user" WHERE id=$1 AND kind='owner'`, [r.ownerId]);
    if (!u[0]?.isActive) throw authError(401, 'verification_failed', AUTH_MESSAGES.verificationFailed);

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
      throw authError(401, 'verification_failed', AUTH_MESSAGES.verificationFailed);
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
      return authError(403, 'step_up_required', AUTH_MESSAGES.stepUpRequired);
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

  /**
   * The generic, service-facing verification (POST /auth/step-up/verify; ADR-0042 Amendment 1 A.1, as clarified by ADR-0065 §4, S1).
   * A reference-repair proof is Auth-local: it is refused here BEFORE any consuming statement, with the endpoint's existing answer
   * (`403 step_up_required`) and the same local denial record `consume` writes for its own refusals, so it stays usable by the repair
   * route. Every other purpose goes through `consume`, unchanged.
   */
  async verifyForService(q: Queryable, a: { ownerId: string; sid: string; purpose: string; token: string | undefined }): Promise<void> {
    if (a.purpose === REFERENCE_REPAIR_PURPOSE) {
      await this.audit.tryRecord({ type: 'owner.step_up.consume', outcome: 'denied', actorId: a.ownerId, sessionFamilyId: a.sid, metadata: { purpose: a.purpose } });
      throw authError(403, 'step_up_required', AUTH_MESSAGES.stepUpRequired);
    }
    await this.consume(q, { ownerId: a.ownerId, sid: a.sid, purpose: a.purpose as StepUpPurpose, token: a.token });
  }

  /**
   * Consumes a reference-repair proof on its own (ADR-0061 §4 step 3; ADR-0065 §5, S2; A5.4-A3 O8). Unlike `consume`, this is ONE
   * statement sent in autocommit, outside any transaction of the caller: once it has completed, no later rollback restores the proof.
   * The whole security context is checked by that statement, the allowed method included, so a proof that fails any condition is not
   * consumed. It records nothing and throws nothing: the caller decides the answer and the evidence from the outcome it returns.
   */
  async consumeForReferenceRepair(a: { ownerId: string; sid: string; token: string | undefined }): Promise<RepairProofConsumption> {
    if (!a.token || !UUID_RE.test(a.token)) return 'rejected'; // no statement is sent for an absent or malformed proof
    try {
      const { rows } = await this.db.query(
        `UPDATE owner_step_up SET "consumedAt"=$5
          WHERE id=$1 AND "ownerId"=$2 AND "sessionFamilyId"=$3 AND purpose=$4 AND method::text = ANY($6::text[])
            AND "consumedAt" IS NULL AND "expiresAt" > $5
          RETURNING id`,
        [a.token, a.ownerId, a.sid, REFERENCE_REPAIR_PURPOSE, this.clock.now(), STEP_UP_METHODS[REFERENCE_REPAIR_PURPOSE]],
      );
      return rows.length === 1 ? 'consumed' : 'rejected';
    } catch (e) {
      return provesNothingCommitted(e) ? 'not_consumed' : 'uncertain';
    }
  }
}
