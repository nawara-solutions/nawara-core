import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import type { TransitionContext } from '../domain/actors.js';

/** Payment's authoritative financial completion of a refund case (its `refund.case_completed` payload, or its PAY-08 read). */
export interface PaymentRefundCompletion {
  refundCaseId: string;
  refundAuthorizationId: string;
  refundAttemptId: string;
  paymentId: string;
  approvedAmount: number;
  currency: string;
  /** Payment's completion instant (ISO-8601, as Payment published it). */
  completedAt: string;
}

export type CompletionOutcome = 'completed' | 'duplicate' | 'binding_mismatch' | 'conflict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/**
 * Core V2 S6c (register BIL-24, BIL-25, EVT-02; S0 FC-3, V-3; the Owner's R6C-9, R6C-10). DEVELOPMENT AND SIMULATION ONLY (the refund module is
 * never mounted in production). Billing completes its refund case, once, from Payment's authoritative completion, never from a request, a
 * relay status or a time alone. Strict binding before anything is written: the case exists and is Billing's, its payment is the completion's
 * payment, its full amount and currency are the approved ones, and the completed refund attempt is one Billing itself relayed for this case.
 *
 * One transaction under the case's row lock: the completion evidence (`refund_case_completion`, with the verified event id when it came from
 * the event: the receipt that de-duplicates a redelivery), the case's `open -> completed` at Payment's completion time and the audit intent
 * `refund_case.completed`. An identical repeat (a redelivery, the event after the reconciler, or the reverse) is a `duplicate` and changes
 * nothing. Nothing else: no purchase reversal, entitlement change or obligation (S6d), and Payment is never called.
 */
@Injectable()
export class RefundCompletionService {
  private readonly log = new Logger('BillingRefundCompletion');

  constructor(private readonly db: DbService, private readonly audit: BillingAudit) {}

  async complete(c: PaymentRefundCompletion, source: { kind: 'event'; eventId: string } | { kind: 'reconciliation' }, ctx: TransitionContext): Promise<CompletionOutcome> {
    if (![c.refundCaseId, c.refundAuthorizationId, c.refundAttemptId, c.paymentId].every((v) => typeof v === 'string' && UUID.test(v))
      || !Number.isSafeInteger(c.approvedAmount) || c.approvedAmount < 1 || typeof c.currency !== 'string' || !/^[A-Z]{3}$/.test(c.currency)
      || typeof c.completedAt !== 'string' || !ISO.test(c.completedAt) || Number.isNaN(new Date(c.completedAt).getTime())) {
      return this.refused('binding_mismatch', c, 'malformed');
    }
    const outcome = await this.db.tx(async (q) => {
      const kase = (await q.query<{ id: string; paymentId: string; amount: string; currency: string; status: string; organizationId: string | null }>(
        `SELECT id, "paymentId", amount, trim(currency) AS currency, status, "organizationId" FROM refund_case WHERE id = $1 FOR UPDATE`, [c.refundCaseId])).rows[0];
      if (!kase) return { o: 'binding_mismatch' as const, why: 'unknown_case' };
      const prior = (await q.query<{ refundAuthorizationId: string }>(`SELECT "refundAuthorizationId" FROM refund_case_completion WHERE "refundCaseId" = $1`, [c.refundCaseId])).rows[0];
      if (prior) return prior.refundAuthorizationId === c.refundAuthorizationId ? { o: 'duplicate' as const } : { o: 'conflict' as const, why: 'another_authorization' };
      if (kase.paymentId !== c.paymentId) return { o: 'binding_mismatch' as const, why: 'payment' };
      if (Number(kase.amount) !== c.approvedAmount || kase.currency !== c.currency) return { o: 'binding_mismatch' as const, why: 'amount_or_currency' };
      const relay = (await q.query(`SELECT 1 FROM refund_authorization_relay WHERE id = $1 AND "refundCaseId" = $2 AND "paymentId" = $3`, [c.refundAttemptId, c.refundCaseId, c.paymentId])).rows[0];
      if (!relay) return { o: 'binding_mismatch' as const, why: 'attempt_not_relayed' };
      if (kase.status !== 'open') return { o: 'conflict' as const, why: `case_${kase.status}` };
      await q.query(
        `INSERT INTO refund_case_completion ("refundCaseId", "paymentId", "refundAttemptId", "refundAuthorizationId", "approvedAmount", currency, "completedAt", source, "eventId")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [c.refundCaseId, c.paymentId, c.refundAttemptId, c.refundAuthorizationId, c.approvedAmount, c.currency, c.completedAt, source.kind, source.kind === 'event' ? source.eventId : null],
      );
      await q.query(`UPDATE refund_case SET status = 'completed', "completedAt" = $2 WHERE id = $1`, [c.refundCaseId, c.completedAt]);
      await this.audit.record(q, 'refund_case.completed', {
        organizationId: kase.organizationId, resource: { type: 'refund_case', id: c.refundCaseId },
        changes: { payment_id: c.paymentId, refund_approval_id: c.refundAuthorizationId, refund_attempt_id: c.refundAttemptId },
      }, ctx);
      return { o: 'completed' as const };
    });
    if (outcome.o === 'completed') this.log.log(`refund_case_completed refundCase=${c.refundCaseId} authorization=${c.refundAuthorizationId} source=${source.kind}`);
    if (outcome.o === 'binding_mismatch' || outcome.o === 'conflict') return this.refused(outcome.o, c, outcome.why);
    return outcome.o;
  }

  private refused(o: 'binding_mismatch' | 'conflict', c: PaymentRefundCompletion, why: string): CompletionOutcome {
    const id = typeof c.refundCaseId === 'string' && UUID.test(c.refundCaseId) ? c.refundCaseId : '[invalid]';
    this.log.error(`refund_case_completion_refused refundCase=${id} outcome=${o} reason=${why} — nothing changed; needs review`);
    return o;
  }
}
