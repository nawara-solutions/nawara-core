import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../auth/session.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { authError } from '../errors.js';
import { ThrottleService } from '../throttle/throttle.service.js';
import { UsersService } from '../users/users.service.js';
import { ChallengeService } from './challenge.service.js';
import { FactorService } from './factor.service.js';
import { StepUpService } from './step-up.service.js';

/**
 * Who is enrolling a factor, and how they proved the right to:
 *  - `enrollment` : holds an enrollment token (bootstrap or post-recovery). Allowed ONLY while the
 *                   owner has ZERO confirmed factors — once any factor exists, an enrollment token can
 *                   no longer add one, so a stale/stolen token cannot plant an attacker's factor.
 *                   Confirming the first factor consumes the token and starts the first session.
 *  - `session`    : an authenticated owner session. Adding a factor when one already exists needs a
 *                   fresh step-up (`owner.factor.enroll`, factor methods only), consumed atomically
 *                   with the confirmation.
 */
export type EnrollCtx = { ownerId: string; enrollmentChallengeId?: string; sid?: string };

@Injectable()
export class EnrollmentService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(ChallengeService) private readonly challenges: ChallengeService,
    @Inject(FactorService) private readonly factors: FactorService,
    @Inject(StepUpService) private readonly stepUp: StepUpService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async fromToken(token: string): Promise<EnrollCtx> {
    const ch = await this.challenges.findByToken('enrollment', token);
    if (!ch) throw authError(401, 'verification_failed', 'Verification failed.');
    if ((await this.factors.countConfirmed(ch.ownerId)) > 0) throw authError(403, 'factor_already_enrolled', 'Forbidden');
    // A token minted before the owner's FIRST confirmed factor is a bootstrap token, and bootstrap
    // enrollment is a one-time state: once any factor has existed, only a recovery-issued token
    // (created afterwards) may enroll. This holds however the factor came to be revoked.
    const { rows } = await this.db.query(`SELECT min("confirmedAt") AS first FROM owner_auth_factor WHERE "ownerId"=$1`, [ch.ownerId]);
    if (rows[0].first && ch.createdAt <= rows[0].first) throw authError(401, 'verification_failed', 'Verification failed.');
    const u = await this.users.findById(ch.ownerId);
    if (!u?.isActive) throw authError(401, 'verification_failed', 'Verification failed.');
    return { ownerId: ch.ownerId, enrollmentChallengeId: ch.id };
  }

  private bindingId(c: EnrollCtx) {
    return (c.sid ?? c.enrollmentChallengeId)!;
  }

  private async label(ownerId: string) {
    const u = await this.users.findById(ownerId);
    return u?.email ?? u?.phone ?? ownerId;
  }

  async beginTotp(c: EnrollCtx) {
    await this.throttle.hit('factor_enroll_owner', c.ownerId);
    return this.factors.beginTotp(this.db, c.ownerId, await this.label(c.ownerId));
  }

  /**
   * Runs the extra requirements and completes enrollment ATOMICALLY; issues a session on a first
   * factor. Any failure throws, which rolls the whole transaction back — a wrong code therefore does
   * not burn the enrollment token or the step-up. (Failed attempts against an enrollment token are
   * still counted, outside the transaction, so it cannot be guessed at forever.)
   */
  private async finish(c: EnrollCtx, stepUpToken: string | undefined, confirm: (q: Queryable) => Promise<boolean>, method: string) {
    try {
      return await this.db.tx(async (q) => {
        const hadFactors = (await this.factors.countConfirmed(c.ownerId, q)) > 0;
        if (c.enrollmentChallengeId) {
          if (hadFactors) throw authError(403, 'factor_already_enrolled', 'Forbidden');
          if (!(await this.challenges.consume(q, c.enrollmentChallengeId))) throw authError(401, 'verification_failed', 'Verification failed.');
        } else if (hadFactors) {
          await this.stepUp.consume(q, { ownerId: c.ownerId, sid: c.sid!, purpose: 'owner.factor.enroll', token: stepUpToken });
        }
        if (!(await confirm(q))) throw authError(400, 'verification_failed', 'Verification failed.');
        await this.audit.record({ type: 'owner.factor.enrolled', outcome: 'success', actorId: c.ownerId, sessionFamilyId: c.sid, metadata: { method, first: !hadFactors } }, q);
        if (!c.enrollmentChallengeId) return { session: null };
        const owner = (await this.users.findById(c.ownerId, q))!;
        const s = await this.sessions.issue(q, owner);
        await this.audit.record({ type: 'owner.login', outcome: 'success', actorId: owner.id, sessionFamilyId: s.sid, metadata: { method: 'enrollment' } }, q);
        const { sid: _sid, ...tokens } = s;
        return { session: tokens };
      });
    } catch (e) {
      if (c.enrollmentChallengeId) await this.challenges.recordFailure(c.enrollmentChallengeId);
      await this.audit.tryRecord({ type: 'owner.factor.enrolled', outcome: 'failure', actorId: c.ownerId, sessionFamilyId: c.sid, metadata: { method } });
      throw e;
    }
  }

  async confirmTotp(c: EnrollCtx, factorId: string, code: string, stepUpToken?: string) {
    await this.throttle.hit('factor_enroll_owner', c.ownerId);
    return this.finish(c, stepUpToken, (q) => this.factors.confirmTotp(q, c.ownerId, factorId, code), 'totp');
  }

  async webauthnOptions(c: EnrollCtx) {
    await this.throttle.hit('factor_enroll_owner', c.ownerId);
    const options = await this.factors.webauthnRegistrationOptions(c.ownerId, await this.label(c.ownerId));
    const ch = await this.challenges.create(this.db, {
      ownerId: c.ownerId, kind: 'webauthn_registration', ttlSec: this.cfg.challengeTtlSec, webauthnChallenge: options.challenge, sessionFamilyId: this.bindingId(c),
    });
    return { challengeId: ch.id, options };
  }

  async registerWebauthn(c: EnrollCtx, challengeId: string, response: RegistrationResponseJSON, stepUpToken?: string) {
    await this.throttle.hit('factor_enroll_owner', c.ownerId);
    const ch = await this.challenges.findById(challengeId, 'webauthn_registration', c.ownerId);
    // The registration challenge must be bound to THIS session (or this enrollment) and is single use.
    if (!ch || ch.sessionFamilyId !== this.bindingId(c) || !ch.webauthnChallenge) throw authError(400, 'verification_failed', 'Verification failed.');
    const expected = ch.webauthnChallenge;
    try {
      return await this.finish(c, stepUpToken, async (q) => {
        if (!(await this.challenges.consume(q, ch.id))) return false;
        await this.factors.registerWebauthn(q, c.ownerId, response, expected);
        return true;
      }, 'webauthn');
    } catch (e) {
      if (e instanceof HttpException) throw e;
      if ((e as { status?: number }).status) throw e;
      throw authError(400, 'verification_failed', 'Verification failed.'); // protocol verification error: no detail to the client
    }
  }
}
