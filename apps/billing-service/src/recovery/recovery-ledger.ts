import type { Queryable } from '@nawara/service-kit';
import { lockOrganization } from '../assistance/assistance-restrictions.js';
import type { BillingAudit } from '../audit/billing-audit.js';
import type { TransitionContext } from '../domain/actors.js';

/**
 * Core V2 S6f (ADR-0044 B8; S0 §3.5, R-1, R-5; DB-9; the Owner's R6F-2, R6F-6). The ONE place a verified success of a recovery-settlement
 * invoice is accounted for, in the transaction that applied it (`PaymentRequestRepository`, from Payment's verified `payment.succeeded`):
 *   - a `recovery_payment`, once per payment request and receipt; the DATABASE splits it into the principal that recovers the base (never more
 *     than what is outstanding) and the surplus beyond it;
 *   - a surplus is a `recovery_surplus` owed to the Organization (R-1): never revenue, never offset, no expiry;
 *   - when the principal reaches the base, the obligation becomes `recovered`, once, and its T3 ends (a surplus never re-opens it, R-5).
 * Under the Organization lock (S5D-5: the documented order), then the obligation's lock. No purchase, entitlement or event.
 */
export async function applyRecoveryPayment(
  q: Queryable, audit: BillingAudit,
  p: { obligationId: string; invoiceId: string; paymentRequestId: string; amount: string | number; currency: string }
    // the evidence: the applied `payment.succeeded` receipt (S6f), or one of Payment's verified late successes (Core V2 S6h-B, R6H-4)
    & ({ receiptId: string; lateSuccessId?: undefined } | { lateSuccessId: string; receiptId?: undefined }),
  ctx: TransitionContext,
): Promise<'recovered' | 'recovery'> {
  const o = (await q.query<{ organizationId: string; status: string }>(`SELECT "organizationId", status FROM recovery_obligation WHERE id = $1`, [p.obligationId])).rows[0]!;
  await lockOrganization(q, o.organizationId);
  const pay = (await q.query<{ id: string; principalAmount: string; surplusAmount: string }>(
    `INSERT INTO recovery_payment ("obligationId", "invoiceId", "paymentRequestId", "receiptId", "lateSuccessId", amount, currency, "principalAmount", "surplusAmount")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0) RETURNING id, "principalAmount", "surplusAmount"`,
    [p.obligationId, p.invoiceId, p.paymentRequestId, p.receiptId ?? null, p.lateSuccessId ?? null, p.amount, p.currency])).rows[0]!;
  await audit.record(q, 'recovery_payment.recorded', {
    organizationId: o.organizationId, resource: { type: 'recovery_obligation', id: p.obligationId },
    changes: { payment_request_id: p.paymentRequestId, recovered_amount: Number(pay.principalAmount), surplus_amount: Number(pay.surplusAmount) }, identity: pay.id,
  }, ctx);
  if (Number(pay.surplusAmount) > 0) {
    const s = (await q.query<{ id: string }>(
      `INSERT INTO recovery_surplus ("recoveryPaymentId", "obligationId", "organizationId", amount, currency) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [pay.id, p.obligationId, o.organizationId, pay.surplusAmount, p.currency])).rows[0]!;
    await audit.record(q, 'recovery_surplus.recorded', {
      organizationId: o.organizationId, resource: { type: 'recovery_surplus', id: s.id }, changes: { amount: Number(pay.surplusAmount) },
    }, ctx);
  }
  // Core V2 S6h-B (R6H-8): a recovery of a WRITTEN-OFF obligation reduces the recognized loss by the principal it recovered, append-only, once,
  // never below zero (the loss record itself never changes; the obligation and T3 follow verified recoveries only)
  if (Number(pay.principalAmount) > 0) {
    const loss = (await q.query<{ id: string; remaining: string }>(
      `SELECT f.id, f.amount + coalesce((SELECT sum(a.amount) FROM financial_loss_adjustment a WHERE a."lossId" = f.id), 0) AS remaining
         FROM financial_loss f WHERE f.kind = 'recovery_write_off' AND f."obligationId" = $1 FOR UPDATE OF f`, [p.obligationId])).rows[0];
    if (loss && Number(loss.remaining) > 0) {
      const reduce = Math.min(Number(pay.principalAmount), Number(loss.remaining));
      await q.query(`INSERT INTO financial_loss_adjustment ("lossId", reason, amount, "recoveryPaymentId") VALUES ($1, 'recovered_after_write_off', $2, $3)`,
        [loss.id, -reduce, pay.id]);
      await audit.record(q, 'financial_loss.adjusted', {
        organizationId: o.organizationId, resource: { type: 'financial_loss', id: loss.id }, changes: { reason: 'recovered_after_write_off', amount: reduce }, identity: pay.id,
      }, ctx);
    }
  }
  const done = await q.query(
    `UPDATE recovery_obligation SET status = 'recovered' WHERE id = $1 AND status = 'open' AND billing_recovery_outstanding($1) <= 0 RETURNING id`, [p.obligationId]);
  if (done.rows.length > 0) {
    await audit.record(q, 'recovery_obligation.recovered', { organizationId: o.organizationId, resource: { type: 'recovery_obligation', id: p.obligationId } }, ctx);
    return 'recovered';
  }
  return 'recovery';
}
