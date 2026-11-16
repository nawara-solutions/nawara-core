import { Inject, Injectable } from '@nestjs/common';
import type { Queryable } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import type { EventContext } from '../events/payment-events.js';

/** Core V2 DO-76 S1: the two escalation kinds (migration 0032). */
export type RefundSafetyEscalationKind = 'dispatch_held' | 'refund_fact_without_authorization';

/** A `refund_safety_escalation` row (migration 0032): append-only; payment, Company, capture and status are derived by the database. */
export interface RefundSafetyEscalationRow {
  id: string;
  kind: RefundSafetyEscalationKind;
  refundAttemptId: string;
  factId: string;
  paymentId: string;
  companyId: string;
  captureFactId: string;
  attemptStatus: string;
  escalatedAt: Date;
}

const CONFLICT_TARGET: Record<RefundSafetyEscalationKind, string> = {
  dispatch_held: `("refundAttemptId") WHERE kind = 'dispatch_held'`,
  refund_fact_without_authorization: `("factId") WHERE kind = 'refund_fact_without_authorization'`,
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

  async escalate(q: Queryable, e: { kind: RefundSafetyEscalationKind; refundAttemptId: string; factId: string }, ctx: EventContext): Promise<string | null> {
    const { rows } = await q.query<RefundSafetyEscalationRow>(
      `INSERT INTO refund_safety_escalation (kind, "refundAttemptId", "factId", "paymentId", "companyId", "captureFactId", "attemptStatus")
       SELECT $1, a.id, $3, a."paymentId", a."companyId", a."captureFactId", a.status FROM refund_attempt a WHERE a.id = $2
       ON CONFLICT ${CONFLICT_TARGET[e.kind]} DO NOTHING RETURNING *`,
      [e.kind, e.refundAttemptId, e.factId],
    );
    const row = rows[0];
    if (!row) return null;
    const { rows: pay } = await q.query<{ organizationId: string | null }>('SELECT "organizationId" FROM payment WHERE id = $1', [row.paymentId]);
    await this.audit.recordSafetyEscalation(q, row, pay[0]?.organizationId ?? null, ctx);
    return row.id;
  }
}
