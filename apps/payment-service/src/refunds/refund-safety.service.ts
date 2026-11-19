import { Inject, Injectable } from '@nestjs/common';
import type { Queryable } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import type { EventContext } from '../events/payment-events.js';

/** Core V2 DO-76 S1: the two escalation kinds (migration 0032); Core V2 RLSC-1: `failed_attempt_refund_evidence` (migration 0033). */
export type RefundSafetyEscalationKind = 'dispatch_held' | 'refund_fact_without_authorization' | 'failed_attempt_refund_evidence' | 'dispatch_stalled'; // + Core V2 G3 (DO-44, 0034)

/** A `refund_safety_escalation` row (migration 0032): append-only; payment, Company, capture and status are derived by the database. */
export interface RefundSafetyEscalationRow {
  id: string;
  kind: RefundSafetyEscalationKind;
  refundAttemptId: string;
  factId: string | null; // Core V2 G3: null for `dispatch_stalled` only (0034's shape check)
  paymentId: string;
  companyId: string;
  captureFactId: string;
  attemptStatus: string;
  escalatedAt: Date;
  /** Core V2 RLSC-1 (0033): the effective attempt that made `discrepancy` impossible, and its status when recorded; null for the other kinds. */
  competingAttemptId: string | null;
  competingAttemptStatus: string | null;
}

const CONFLICT_TARGET: Record<RefundSafetyEscalationKind, string> = {
  dispatch_held: `("refundAttemptId") WHERE kind = 'dispatch_held'`,
  refund_fact_without_authorization: `("factId") WHERE kind = 'refund_fact_without_authorization'`,
  failed_attempt_refund_evidence: `("factId") WHERE kind = 'failed_attempt_refund_evidence'`,
  dispatch_stalled: `("refundAttemptId") WHERE kind = 'dispatch_stalled'`,
};

/**
 * Core V2 DO-76 S1 (the Owner's D-76-1, D-76-2, D-76-4): one durable, deduplicated escalation for the Owner's review, written in the caller's
 * transaction with its audit intent (`refund_safety.escalated`, a deterministic event id per row), so an escalation never exists without its audit
 * record nor the reverse. At most one per held attempt and one per `no_authorization` fact: a repeat (another worker, a redelivery, a retried pass)
 * writes nothing and returns null. An escalation is a request for review, never a finding: nothing here releases, retries, abandons, allocates,
 * resolves or declares a provider or a secret compromised. The database checks that the fact IS the evidence the kind names (0032).
 */
@Injectable()
export class RefundSafetyService {
  constructor(@Inject(PaymentAudit) private readonly audit: PaymentAudit) {}

  async escalate(q: Queryable, e: { kind: RefundSafetyEscalationKind; refundAttemptId: string; factId: string | null; competingAttemptId?: string }, ctx: EventContext): Promise<string | null> {
    const { rows } = await q.query<RefundSafetyEscalationRow>(
      `INSERT INTO refund_safety_escalation (kind, "refundAttemptId", "factId", "paymentId", "companyId", "captureFactId", "attemptStatus", "competingAttemptId")
       SELECT $1, a.id, $3, a."paymentId", a."companyId", a."captureFactId", a.status, $4::uuid FROM refund_attempt a WHERE a.id = $2
       ON CONFLICT ${CONFLICT_TARGET[e.kind]} DO NOTHING RETURNING *`,
      [e.kind, e.refundAttemptId, e.factId, e.competingAttemptId ?? null],
    );
    const row = rows[0];
    if (!row) return null;
    const { rows: pay } = await q.query<{ organizationId: string | null }>('SELECT "organizationId" FROM payment WHERE id = $1', [row.paymentId]);
    await this.audit.recordSafetyEscalation(q, row, pay[0]?.organizationId ?? null, ctx);
    return row.id;
  }

  /**
   * Core V2 G3 (DO-44; the Owner's G3 rule 1): the one exit observation of a `dispatch_stalled` escalation whose attempt has left the stuck state, with
   * its audit intent, in the caller's transaction. The database derives the status and refuses it while the attempt is still stuck (0034); a repeat
   * writes nothing and returns false. The escalation itself never changes.
   */
  async observeStalledExit(q: Queryable, escalationId: string, ctx: EventContext): Promise<boolean> {
    const { rows } = await q.query<{ exitedStatus: string }>(
      `INSERT INTO refund_safety_escalation_exit ("escalationId", "exitedStatus") VALUES ($1, '') ON CONFLICT ("escalationId") DO NOTHING RETURNING "exitedStatus"`, [escalationId]);
    if (!rows[0]) return false;
    const { rows: e } = await q.query<{ refundAttemptId: string; paymentId: string; organizationId: string | null }>(
      `SELECT e."refundAttemptId", e."paymentId", p."organizationId" FROM refund_safety_escalation e JOIN payment p ON p.id = e."paymentId" WHERE e.id = $1`, [escalationId]);
    await this.audit.recordSafetyExit(q, { escalationId, refundAttemptId: e[0]!.refundAttemptId, paymentId: e[0]!.paymentId, exitedStatus: rows[0].exitedStatus },
      e[0]!.organizationId, ctx);
    return true;
  }

  /** Core V2 RLSC-1: the exception already recorded for this fact (a redelivery, another instance, a retried pass), or null. */
  async failedAttemptEvidenceOf(q: Queryable, factId: string): Promise<string | null> {
    const { rows } = await q.query<{ id: string }>(
      `SELECT id FROM refund_safety_escalation WHERE "factId" = $1 AND kind = 'failed_attempt_refund_evidence'`, [factId]);
    return rows[0]?.id ?? null;
  }
}
