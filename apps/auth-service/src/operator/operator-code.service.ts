import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../auth/session.service.js';
import type { ClientInfo } from '../common/client-info.js';
import { CLOCK, EVENT_BUS, type Clock, type EventBus } from '../common/ports.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { hmacHex } from '../crypto/hmac.js';
import { randomSixDigitCode, safeEqualHex } from '../crypto/random.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { ThrottleService } from '../throttle/throttle.service.js';
import { UsersService, toIdentifier, type UserRow } from '../users/users.service.js';
import { OperatorAvailabilityService } from './availability.service.js';

export type CodePurpose = 'confirmation' | 'login';
export const MAX_CODE_ATTEMPTS = 5; // mirrors the DB CHECK on admin_operator_code.attemptCount
const GENERIC = 'Invalid or expired code.';

/**
 * Operator working code (no operator password exists).
 *  - 6 digits, uniform, from the OS CSPRNG (`randomInt`); never derived from time, ids or names.
 *  - stored only as HMAC-SHA-256(pepper, operatorId | purpose | code); the pepper is not in the DB.
 *  - login codes expire at the end of the operator's shift (or a flat fallback with no schedule);
 *    confirmation codes use a flat, configured lifetime.
 *  - issuing supersedes (never deletes) the previous live code; a code is one-time.
 *  - verification is throttled per operator (independent of IP), per IP, and globally; a wrong guess
 *    costs an attempt, 5 kill the code; every failure returns the same generic 401.
 */
@Injectable()
export class OperatorCodeService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(OperatorAvailabilityService) private readonly availability: OperatorAvailabilityService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  digest(operatorId: string, purpose: CodePurpose, code: string) {
    return hmacHex(this.cfg.secrets.operatorCodePepper, 'operator.code', operatorId, purpose, code);
  }

  /** Supersede-then-insert as two sequential statements (never one CTE) inside the caller's tx. */
  async issue(q: Queryable, operatorId: string, purpose: CodePurpose, expiresAt: Date): Promise<string> {
    const now = this.clock.now();
    const code = randomSixDigitCode();
    await q.query(
      `UPDATE admin_operator_code SET "supersededAt"=$3 WHERE "userId"=$1 AND purpose=$2 AND "consumedAt" IS NULL AND "supersededAt" IS NULL`,
      [operatorId, purpose, now],
    );
    await q.query(
      `INSERT INTO admin_operator_code("userId",purpose,"codeHash","expiresAt","createdAt") VALUES ($1,$2,$3,$4,$5)`,
      [operatorId, purpose, this.digest(operatorId, purpose, code), expiresAt, now],
    );
    return code;
  }

  private contactOf(u: UserRow) {
    return { channel: u.email ? 'email' : 'phone', destination: u.email ?? u.phone };
  }

  private async operatorRow(u: UserRow | null): Promise<{ user: UserRow; confirmed: boolean } | null> {
    if (!u || u.kind !== 'operator' || !u.isActive) return null;
    const { rows } = await this.db.query(`SELECT "contactVerifiedAt" FROM operator WHERE "userId"=$1`, [u.id]);
    return { user: u, confirmed: !!rows[0]?.contactVerifiedAt };
  }

  /** Always resolves (the endpoint answers 204 whatever happened): no operator/eligibility oracle. */
  async requestLoginCode(ident: { email?: string; phone?: string }, client: ClientInfo): Promise<void> {
    const id = toIdentifier(ident);
    const idKey = 'email' in id ? id.email : id.phone;
    await this.throttle.hit('operator_request_ip', client.ip);
    await this.throttle.hit('operator_request_identifier', idKey);
    const op = await this.operatorRow(await this.users.findByIdentifier(ident));
    const now = this.clock.now();
    const ok = op?.confirmed ? await this.availability.check(op.user.id, now) : null;
    if (!op || !op.confirmed || !ok?.available) {
      await this.audit.tryRecord({ type: 'operator.code.request', outcome: 'denied', actorId: op?.user.id, ip: client.ip, metadata: { reason: !op ? 'unknown_or_inactive' : !op.confirmed ? 'unconfirmed' : ok!.reason } });
      return;
    }
    const expiresAt = await this.availability.shiftEndOrFallback(op.user.id, now);
    if (expiresAt <= now) return;
    const code = await this.db.tx(async (q) => {
      const c = await this.issue(q, op.user.id, 'login', expiresAt);
      await this.audit.record({ type: 'operator.code.issued', outcome: 'success', actorId: op.user.id, ip: client.ip, metadata: { purpose: 'login' } }, q);
      return c;
    });
    // The raw code leaves this process only toward the notification channel (never logged/stored).
    this.bus.publish('admin.operator_code_issued', { userId: op.user.id, ...this.contactOf(op.user), code, expiresAt: expiresAt.toISOString(), timestamp: now.toISOString() });
  }

  /** Issues the confirmation code for a freshly created operator (flat lifetime, ADR-0015). */
  async issueConfirmation(q: Queryable, operator: UserRow): Promise<void> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.cfg.operator.confirmationTtlSec * 1000);
    const code = await this.issue(q, operator.id, 'confirmation', expiresAt);
    this.bus.publish('admin.operator_confirmation_code_issued', { userId: operator.id, ...this.contactOf(operator), code, expiresAt: expiresAt.toISOString(), timestamp: now.toISOString() });
  }

  /**
   * Core verification. Returns the operator on success. Wrong guesses increment attemptCount and the
   * increment is COMMITTED (the transaction returns, it does not throw).
   */
  private async verify(
    user: UserRow, purpose: CodePurpose, code: string,
    onSuccess: (q: Queryable, ceiling: Date | null) => Promise<unknown>,
    needsShift: boolean,
  ): Promise<{ ok: boolean; result?: unknown }> {
    const now = this.clock.now();
    return this.db.tx(async (q) => {
      const { rows } = await q.query(
        `SELECT id, "codeHash", "expiresAt", "attemptCount" FROM admin_operator_code
          WHERE "userId"=$1 AND purpose=$2 AND "consumedAt" IS NULL AND "supersededAt" IS NULL FOR UPDATE`,
        [user.id, purpose],
      );
      const c = rows[0];
      if (!c || c.expiresAt <= now || c.attemptCount >= MAX_CODE_ATTEMPTS) return { ok: false };
      if (!safeEqualHex(this.digest(user.id, purpose, code), c.codeHash)) {
        await q.query(`UPDATE admin_operator_code SET "attemptCount" = "attemptCount" + 1 WHERE id=$1`, [c.id]);
        return { ok: false };
      }
      let ceiling: Date | null = null;
      if (needsShift) {
        // Re-checked at redemption: the schedule/time-off may have changed since the code was issued.
        if (!(await this.availability.check(user.id, now, q)).available) return { ok: false };
        ceiling = await this.availability.shiftEndOrFallback(user.id, now, q);
        if (ceiling <= now) return { ok: false };
      }
      await q.query(`UPDATE admin_operator_code SET "consumedAt"=$2 WHERE id=$1`, [c.id, now]);
      return { ok: true, result: await onSuccess(q, ceiling) };
    });
  }

  /** Redeems a working code for a temporary session that cannot outlive today's shift ceiling. */
  async verifyLogin(ident: { email?: string; phone?: string; code: string }, client: ClientInfo) {
    const id = toIdentifier(ident);
    const idKey = 'email' in id ? id.email : id.phone;
    await this.throttle.hit('operator_verify_global', 'all');
    await this.throttle.hit('operator_verify_ip', client.ip);
    await this.throttle.hit('operator_verify_identifier', idKey);
    const op = await this.operatorRow(await this.users.findByIdentifier(ident));
    let outcome: { ok: boolean; result?: any } = { ok: false };
    if (op?.confirmed) {
      outcome = await this.verify(op.user, 'login', ident.code, async (q, ceiling) => {
        const s = await this.sessions.issue(q, op.user, ceiling);
        await this.audit.record({ type: 'operator.login', outcome: 'success', actorId: op.user.id, sessionFamilyId: s.sid, ip: client.ip }, q);
        return s;
      }, true);
    } else {
      this.digest('00000000-0000-0000-0000-000000000000', 'login', ident.code); // equalise work
    }
    if (!outcome.ok) {
      await this.audit.tryRecord({ type: 'operator.login', outcome: 'failure', actorId: op?.user.id, ip: client.ip });
      throw new UnauthorizedException(GENERIC);
    }
    await this.throttle.reset('operator_verify_identifier', idKey);
    const { sid: _sid, ...tokens } = outcome.result;
    return tokens as { accessToken: string; refreshToken: string; expiresIn: number };
  }

  /** Public confirmation of an operator's contact (proves they own the email/phone). */
  async confirm(ident: { email?: string; phone?: string; code: string }, client: ClientInfo): Promise<void> {
    const id = toIdentifier(ident);
    const idKey = 'email' in id ? id.email : id.phone;
    await this.throttle.hit('operator_confirm_ip', client.ip);
    await this.throttle.hit('operator_verify_identifier', idKey);
    const u = await this.users.findByIdentifier(ident);
    const op = await this.operatorRow(u);
    if (op?.confirmed) return; // idempotent, no oracle
    let ok = false;
    if (op) {
      ok = (await this.verify(op.user, 'confirmation', ident.code, async (q) => {
        await q.query(`UPDATE operator SET "contactVerifiedAt"=$2, "updatedAt"=$2 WHERE "userId"=$1`, [op.user.id, this.clock.now()]);
        await this.audit.record({ type: 'operator.contact.confirmed', outcome: 'success', actorId: op.user.id, ip: client.ip }, q);
      }, false)).ok;
    }
    if (!ok) throw new UnauthorizedException(GENERIC);
  }
}
