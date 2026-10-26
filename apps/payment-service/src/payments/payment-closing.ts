import type { OutboxService, Queryable } from '@nawara/service-kit';
import type { PaymentAudit } from '../audit/payment-audit.js';
import { paymentEvent, type EventContext } from '../events/payment-events.js';
import type { PaymentRow } from './payment.types.js';

/**
 * Core V2 S4c (F-2): whether an attempt may still produce a verified financial result for the payment — an `initiated`, `submitted` or
 * `unknown` attempt, or a failure that was only INFERRED and that no provider evidence has confirmed since. The database's own
 * `payment_is_uncertain` is the one definition (the transition and insert guards use it too), so the application can never disagree.
 */
export async function isPaymentUncertain(q: Queryable, paymentId: string): Promise<boolean> {
  const { rows } = await q.query<{ uncertain: boolean }>('SELECT payment_is_uncertain($1) AS uncertain', [paymentId]);
  return rows[0]!.uncertain;
}

/**
 * Core V2 S4c (F-1): ends a `closing` payment once nothing is uncertain any more, as its reason says (`cancel` → `cancelled`, `expiry` →
 * `expired`), with the SAME event and audit a direct cancel or expiry has (no new event, F-7). The completion is attributed to whoever asked
 * for the closing — the producer's cancel, or the expiry sweep — and caused by the evidence that resolved it. No-op otherwise.
 * The caller holds the payment row lock.
 */
export async function completeClosingIfResolved(
  q: Queryable, deps: { outbox: OutboxService; audit: PaymentAudit }, paymentId: string, resolvedBy: EventContext,
): Promise<PaymentRow | null> {
  const { rows } = await q.query<PaymentRow>('SELECT * FROM payment WHERE id = $1', [paymentId]);
  const payment = rows[0];
  if (!payment || payment.status !== 'closing' || (await isPaymentUncertain(q, paymentId))) return null;
  const to = payment.closingReason === 'cancel' ? 'cancelled' : 'expired';
  const { rows: updated } = await q.query<PaymentRow>(`UPDATE payment SET status = $2, "closedAt" = now() WHERE id = $1 RETURNING *`, [paymentId, to]);
  const closed = updated[0]!;
  const ctx: EventContext = to === 'cancelled'
    ? { actor: { type: 'service', id: closed.producer }, cause: resolvedBy.cause, correlationId: resolvedBy.correlationId }
    : { actor: { type: 'system', id: null }, cause: { type: 'expiry_sweep', id: resolvedBy.cause.id }, correlationId: resolvedBy.correlationId };
  if (to === 'cancelled') {
    await deps.outbox.enqueue(q, paymentEvent('payment.cancelled', closed, ctx));
    await deps.audit.record(q, 'payment.cancelled', closed, ctx);
  } else {
    await deps.outbox.enqueue(q, paymentEvent('payment.expired', closed, ctx, { expiresAt: closed.expiresAt?.toISOString() }));
    await deps.audit.record(q, 'payment.expired', closed, ctx);
  }
  return closed;
}
