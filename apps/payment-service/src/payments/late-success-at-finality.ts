import type { OutboxService, Queryable } from '@nawara/service-kit';
import { observationActor, type ObservationActor, type PaymentAudit } from '../audit/payment-audit.js';
import { lateSuccessEvent, type EventContext } from '../events/payment-events.js';
import type { PaymentRow } from './payment.types.js';

/** The workflow-final statuses after which an uncontested capture that settled nothing is a late success (S4c F-4; S0-C12 items 2, 6). */
export const FINAL_UNSUCCESSFUL = ['failed', 'cancelled', 'expired'] as const;
/** S0-C12 item 8: only an ISO 4217-shaped currency can be a late success (Billing's record holds `^[A-Z]{3}$` only). */
export const ISO_CURRENCY = /^[A-Z]{3}$/;

/**
 * Core V2 S0-C12 items 6 and 7 (register PAY-02 H, PAY-05 J): records, in the CALLER's transaction and under the payment lock the caller holds, the late
 * success (with its EVT-10 and its audit record) of every capture fact of a payment that is `failed`, `cancelled` or `expired` and that:
 *   - is uncontested (S0-C11 item 1) and has a currency matching `^[A-Z]{3}$` (S0-C12 item 8);
 *   - settled nothing (the payment never succeeded with it: the payment is final unsuccessful);
 *   - has no late success yet (never a second record of the same fact).
 * The row reuses the fact's own source and webhook event, so it is the very row the observation's own processing would have written: the
 * `payment_late_success_once` key turns any concurrent or later write of it into a no-op. The database re-checks the fact binding (`0024`).
 * A final status is never reopened, and nothing is settled, sold or refunded here. `onlyFactId` limits the pass to one fact (the reconciler).
 */
export async function recordQualifyingLateSuccesses(
  q: Queryable, deps: { outbox: OutboxService; audit: PaymentAudit }, payment: PaymentRow, ctx: EventContext,
  opts: { onlyFactId?: string; actor?: ObservationActor } = {},
): Promise<number> {
  if (!(FINAL_UNSUCCESSFUL as readonly string[]).includes(payment.status)) return 0;
  const { rows: facts } = await q.query<{ id: string; attemptId: string; amount: string; currency: string; source: 'webhook' | 'status_check'; webhookEventId: string | null }>(
    `SELECT f.id, f."attemptId", f.amount, trim(f.currency) AS currency, f.source, f."webhookEventId" FROM provider_transaction_fact f
      WHERE f."paymentId" = $1 AND f.kind = 'capture' AND trim(f.currency) ~ '^[A-Z]{3}$'
        AND NOT EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id)
        AND NOT EXISTS (SELECT 1 FROM payment_late_success l WHERE l."factId" = f.id)
        AND ($2::uuid IS NULL OR f.id = $2)
      ORDER BY f."observedAt", f.id`, [payment.id, opts.onlyFactId ?? null]);
  let recorded = 0;
  for (const f of facts) {
    const { rows } = await q.query<{ id: string; attemptId: string; factId: string; amount: string; currency: string; paymentStatus: string; recordedAt: Date }>(
      `INSERT INTO payment_late_success ("paymentId", "attemptId", source, "webhookEventId", amount, currency, "paymentStatus", "factId") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT ON CONSTRAINT payment_late_success_once DO NOTHING RETURNING id, "attemptId", "factId", amount, currency, "paymentStatus", "recordedAt"`,
      [payment.id, f.attemptId, f.source, f.webhookEventId, f.amount, f.currency, payment.status, f.id]);
    const row = rows[0];
    if (!row) continue; // that observation's own row already exists
    await deps.outbox.enqueue(q, lateSuccessEvent(row, payment, ctx));
    await deps.audit.recordLateSuccess(q, { id: row.id, factId: row.factId, attemptId: row.attemptId, amount: Number(row.amount), paymentStatus: row.paymentStatus }, payment,
      opts.actor ?? observationActor(f.source), ctx);
    recorded++;
  }
  return recorded;
}
