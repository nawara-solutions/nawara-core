import { Logger } from '@nestjs/common';
import { DbService, OutboxService, describeFailure, type Queryable } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import { jobContext, type EventContext } from '../events/payment-events.js';
import { RefundDispatchResponseService, type DispatchApplicationEffect, type DispatchObservationRow } from './refund-dispatch-response.service.js';
import { RefundSafetyService } from './refund-safety.service.js';
import type { RefundAttemptRow } from './refund.types.js';

/**
 * Core V2 D-R1D / D-R1E (0039, 0040; the Owner's Q1 and the A1 correction): ONE decision for a stored provider dispatch answer, shared by the dispatch
 * (in the Payment service, as its runtime role) and by recovery (a SEPARATE process, as the separate recovery role). Which of the two applies an answer is
 * never a caller's claim: the decision records finality only when it is given a finality recorder (the dispatch has one; the recovery process is never
 * built with one), and the database derives `appliedBy` from the connected role's authority (0040): a role without finality INSERT is `recovery`.
 */

/** The attempt states in which a provider failure can contradict the attempt's own verified refund fact (0036). */
export const FAILURE_CONTRADICTABLE = new Set(['dispatching', 'submitted', 'unknown', 'succeeded', 'discrepancy', 'failed']);
/** What the provider's answer moves an in-flight attempt to (an observation's classification). */
const TARGET_STATUS = { accepted: 'submitted', rejected: 'failed', ambiguous: 'unknown', transport_error: 'unknown' } as const;

/** The payment row, then the attempt row, FOR UPDATE (0037's order). Null when the attempt does not exist. */
export async function lockRefundAttempt(q: Queryable, id: string): Promise<RefundAttemptRow | null> {
  const { rows: u } = await q.query<{ paymentId: string }>('SELECT "paymentId" FROM refund_attempt WHERE id = $1', [id]);
  if (!u[0]) return null;
  await q.query('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [u[0].paymentId]);
  const { rows } = await q.query<RefundAttemptRow>('SELECT * FROM refund_attempt WHERE id = $1 FOR UPDATE', [id]);
  return rows[0] ?? null;
}

export async function organizationOfPayment(q: Queryable, paymentId: string): Promise<string | null> {
  const { rows } = await q.query<{ organizationId: string | null }>('SELECT "organizationId" FROM payment WHERE id = $1', [paymentId]);
  return rows[0]?.organizationId ?? null;
}

/**
 * Core V2 D-R1A (Q4), in the caller's transaction under the payment and attempt locks: the attempt's earliest OWN verified refund fact, if any, and the
 * reported failure, kept once per attempt. Returns the escalation id (new or existing), or null when the attempt has no such fact. The database
 * re-validates the fact and the state (0036).
 */
export async function preserveFailureAfterEvidence(q: Queryable, safety: RefundSafetyService, log: Logger, a: RefundAttemptRow, code: string, ctx: EventContext): Promise<string | null> {
  const { rows: own } = await q.query<{ id: string }>(
    `SELECT id FROM provider_transaction_fact WHERE kind = 'refund' AND "refundAttemptId" = $1 AND "paymentId" = $2 ORDER BY "observedAt", id LIMIT 1`, [a.id, a.paymentId]);
  if (!own[0]) return null;
  const created = await safety.escalate(q, { kind: 'failure_after_refund_evidence', refundAttemptId: a.id, factId: own[0].id, observedFailureCode: code }, ctx);
  const id = created ?? (await safety.escalationOf(q, a.id, 'failure_after_refund_evidence'));
  if (!id) throw new Error('refund_failure_after_evidence_unrecorded'); // never acknowledged without its row
  if (created) log.error(`refund_failure_after_refund_evidence refundAttempt=${a.id} payment=${a.paymentId} status=${a.status} fact=${own[0].id} code=${code} escalation=${id} — a provider failure contradicts verified refund evidence of this attempt; both kept for the Owner's review (D-R1 Q4)`);
  return id;
}

/** Records D-R1B finality for a dispatch rejection naming its own stored observation (the dispatch only; the recovery process has none). */
export type FinalityRecorder = (q: Queryable, a: RefundAttemptRow, code: string, ctx: EventContext, observationId: string) => Promise<unknown>;

export interface DispatchDecisionDeps {
  audit: PaymentAudit;
  safety: RefundSafetyService;
  responses: RefundDispatchResponseService;
  log: Logger;
  /** Present for the dispatch only. Absent: the decision is a recovery and records no finality. */
  finality?: FinalityRecorder;
}

/**
 * The provider's stored answer, applied ONCE under the attempt lock in one transaction, with its application row: exactly the approved dispatch logic
 * (accepted -> `submitted`; rejected -> D-R1A preservation, OD-DR1-1, else `failed`; ambiguous or transport error -> `unknown` while `dispatching`).
 * Returns whether it applied (false: applied already, never twice).
 */
export async function applyDispatchObservation(db: DbService, deps: DispatchDecisionDeps, o: DispatchObservationRow, ctx: EventContext): Promise<boolean> {
  const appliedBy = deps.finality ? 'dispatch' : 'recovery';
  return db.tx(async (q) => {
    const current = await lockRefundAttempt(q, o.refundAttemptId);
    if (!current) throw new Error('refund_dispatch_observation_without_attempt');
    if (await deps.responses.applicationOf(q, o.id)) return false; // applied already (the dispatch or another recovery): never twice
    const before = current.status;
    let effect: DispatchApplicationEffect = 'no_effect';
    let preserved: string | null = null;
    if (o.classification === 'rejected' && FAILURE_CONTRADICTABLE.has(current.status)) {
      preserved = await preserveFailureAfterEvidence(q, deps.safety, deps.log, current, o.providerCode!, ctx);
      if (preserved) effect = 'preserved_contradiction';
    }
    // evidence got there first: it wins
    if ((current.status === 'dispatching' || current.status === 'unknown') && !preserved) {
      if (o.classification === 'accepted') {
        await q.query(
          `UPDATE refund_attempt SET status = 'submitted', "providerRefundId" = COALESCE("providerRefundId", $2), "submittedAt" = now() WHERE id = $1`,
          [current.id, o.providerRefundId]);
        effect = 'transitioned';
      } else if (o.classification === 'rejected') { // (preserved: OD-DR1-1 (D-R1B): its own verified refund fact stands; it is never `failed`)
        const code = o.providerCode!;
        if (deps.finality) await deps.finality(q, current, code, ctx, o.id);
        else deps.log.log(`refund_failure_not_final refundAttempt=${current.id} payment=${current.paymentId} observation=dispatch_rejected reason=recovered_response — a recovered refusal records no finality; no replacement is permitted (D-R1B, D-R1D)`);
        const { rows } = await q.query<RefundAttemptRow>(
          `UPDATE refund_attempt SET status = 'failed', "failureCode" = $2, "completedAt" = now(), "workAfter" = NULL WHERE id = $1 RETURNING *`, [current.id, code]);
        await deps.audit.recordRefund(q, 'refund_attempt.failed', rows[0]!, await organizationOfPayment(q, current.paymentId), ctx);
        effect = 'transitioned';
      } else if (current.status === 'dispatching') {
        await q.query(`UPDATE refund_attempt SET status = 'unknown' WHERE id = $1`, [current.id]);
        effect = 'transitioned';
      }
    }
    const after = effect === 'transitioned' ? TARGET_STATUS[o.classification] : before;
    await deps.responses.recordApplication(q, o, effect, before, after, appliedBy);
    if (appliedBy === 'recovery') {
      deps.log.warn(`refund_dispatch_response_recovered refundAttempt=${current.id} observation=${o.id} answer=${o.classification} effect=${effect} status=${before}->${after} — applied without calling the provider; no finality (D-R1D)`);
    }
    return true;
  });
}

/** Core V2 D-R1E: what the connected role may do, as the database answers it (never configuration). */
export interface RecoveryAuthority {
  role: string;
  canRecordFinality: boolean;
  canSend: boolean;
  canObserve: boolean;
  superuser: boolean;
  memberships: number;
  switchedRole: boolean;
  /** Registered by `payment_grant_refund_recovery` (0040): the database refuses it finality, sends and answers whatever it is granted. */
  registered: boolean;
}

export async function recoveryAuthorityOf(db: DbService): Promise<RecoveryAuthority> {
  const { rows } = await db.query<RecoveryAuthority>(
    `SELECT current_user::text AS role,
            has_any_column_privilege(current_user, 'refund_attempt_failure_finality', 'INSERT') AS "canRecordFinality",
            has_any_column_privilege(current_user, 'refund_dispatch_send', 'INSERT') AS "canSend",
            has_any_column_privilege(current_user, 'refund_dispatch_observation', 'INSERT') AS "canObserve",
            refund_is_recovery_session() AS registered,
            (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS superuser,
            (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = current_user) AS memberships,
            current_user <> session_user AS "switchedRole"`);
  return rows[0]!;
}

/** Why a role must not run recovery, or null when it is a proper recovery role (no finality, send or observation authority; no other role). */
export function recoveryAuthorityRefusal(a: RecoveryAuthority): string | null {
  if (a.superuser) return 'the role is a superuser (or bypasses row security)';
  if (a.canRecordFinality) return 'the role can record refund failure finality: recovery must run as the separate recovery role';
  if (a.canSend || a.canObserve) return 'the role can record dispatch sends or answers: recovery must run as the separate recovery role';
  if (a.memberships > 0) return 'the role is a member of another role';
  if (a.switchedRole) return 'the session switched roles';
  if (!a.registered) return 'the role is not a registered recovery role (payment_grant_refund_recovery)';
  return null;
}

/**
 * Core V2 D-R1E (the A1 correction): the recovery pass, OUTSIDE the Payment service, as the separate recovery role. It never calls a provider, never
 * records a send or an answer, and holds no finality recorder; the database refuses it finality in any case (no INSERT on
 * `refund_attempt_failure_finality`) and labels its applications `recovery` from its own authority (0040).
 */
export class RefundResponseRecovery {
  private readonly log = new Logger('PaymentRefundResponseRecovery');
  private readonly deps: DispatchDecisionDeps;
  private readonly responses: RefundDispatchResponseService;

  constructor(private readonly db: DbService, public recoveryAfterMs: number) {
    const audit = new PaymentAudit(new OutboxService());
    this.responses = new RefundDispatchResponseService(db);
    this.deps = { audit, safety: new RefundSafetyService(audit), responses: this.responses, log: this.log };
  }

  /** Refuses to run as any role that could record finality, a send or an answer (fail closed: nothing is applied). */
  async assertAuthority(): Promise<RecoveryAuthority> {
    const a = await recoveryAuthorityOf(this.db);
    const refusal = recoveryAuthorityRefusal(a);
    if (refusal) throw new Error(`refund_recovery_refused: ${refusal}`);
    return a;
  }

  /** One pass: stored answers no transaction applied, older than the window (database time), oldest first. Returns how many it applied. */
  async recoverOnce(limit = 50): Promise<number> {
    await this.assertAuthority();
    const ctx = jobContext('refund_worker');
    let applied = 0;
    for (const o of await this.responses.recoverable(this.recoveryAfterMs, limit)) {
      try {
        if (await applyDispatchObservation(this.db, this.deps, o, ctx)) applied++;
      } catch (e) {
        this.log.warn(`refund_dispatch_response_recovery_failure observation=${o.id} refundAttempt=${o.refundAttemptId} ${describeFailure(e)} — kept; retried on a later pass`);
      }
    }
    return applied;
  }
}
