import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, OutboxService, type Queryable } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import { disputeLostEvent, disputeOpenedEvent, type EventContext } from '../events/payment-events.js';
import type { AttemptRow } from '../attempts/attempt.types.js';
import type { PaymentRow } from '../payments/payment.types.js';
import type { DisputeNotice, DisputeRow } from './dispute.types.js';

type Disposition = 'applied' | 'duplicate' | 'conflict';
type ConflictReason = 'capture_unverified' | 'exposure_mismatch' | 'payment_mismatch' | 'terminal_contradiction' | 'chargeback_mismatch' | 'chargeback_unverifiable';

/** What the webhook pipeline records for the notification: `processed` (applied or duplicate), `conflict` (preserved for S6h) or `unmatched`. */
export interface DisputeIngestionResult {
  state: 'processed' | 'conflict' | 'unmatched';
  outcome: string | null;
  attemptId?: string;
}

/**
 * Core V2 S6e-D (register PAY-09, EVT-03; ADR-0044 B10; S0 FC-1, FC-4, FC-5; the Owner's R6E-1, R6E-2, R6E-5, R6E-6, R6E-8). DEVELOPMENT AND
 * SIMULATION ONLY (mounted only where refunds are, never production).
 *
 * One verified provider notification about a dispute, in ONE transaction under the payment's row lock (the lock refund admission takes, so a
 * dispute and a new refund attempt are serialized: the dispute is either seen by the admission or arrives after an attempt that then
 * continues): the dispute's change, its verified chargeback fact, the observation, the domain event and the audit intent commit together.
 *
 * Rules (R6E-1, R6E-2), the observation always kept:
 *   - an unknown dispute is recorded against the payment's VERIFIED capture (exactly one uncontested capture fact of the succeeded attempt);
 *     its exposure is what the provider states, in the capture's currency and never above it; otherwise a `conflict`;
 *   - a known dispute must name the same payment, attempt, exposure and currency, else a `conflict`;
 *   - `opened` again is a `duplicate` (after a terminal outcome too: a late notification); `won`/`lost` close an open dispute once;
 *     the same terminal outcome again is a `duplicate`; the OTHER terminal outcome is a `conflict` and never replaces the first;
 *   - a terminal notification for a dispute Payment never saw opened records it directly in that outcome (out-of-order delivery);
 *   - a loss moves no money by itself: only a chargeback the provider reports with it becomes a `chargeback` fact linked to the dispute
 *     (once; reported later, it completes the loss; a different chargeback for the same loss is a `conflict`).
 * A conflict changes nothing and keeps the payment's exposure `unresolved` (no new refund) until S6h reconciles it.
 */
@Injectable()
export class DisputeIngestionService {
  private readonly log = new Logger('PaymentDisputes');

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PaymentAudit) private readonly audit: PaymentAudit,
  ) {}

  async ingest(webhookEventId: string, providerId: string, reference: string, n: DisputeNotice, ctx: EventContext): Promise<DisputeIngestionResult> {
    const result = await this.db.tx(async (q) => {
      const attempt = (await q.query<AttemptRow>(
        `SELECT * FROM payment_attempt WHERE provider = $1 AND ("providerTransactionId" = $2 OR id::text = $2)`, [providerId, reference])).rows[0];
      if (!attempt) return { state: 'unmatched' as const, outcome: null };
      const payment = (await q.query<PaymentRow>('SELECT * FROM payment WHERE id = $1 FOR UPDATE', [attempt.paymentId])).rows[0]!;
      // a crash after this notification's transaction committed: its observation answers again, nothing is applied twice
      const prior = (await q.query<{ disposition: Disposition; reason: string | null; disputeId: string | null }>(
        `SELECT disposition, reason, "disputeId" FROM payment_dispute_observation WHERE "webhookEventId" = $1`, [webhookEventId])).rows[0];
      if (prior) return this.answer(prior.disposition, prior.reason, prior.disputeId, attempt.id);

      const d = (await q.query<DisputeRow>(
        `SELECT * FROM payment_dispute WHERE provider = $1 AND "providerDisputeId" = $2 FOR UPDATE`, [providerId, n.providerDisputeId])).rows[0];
      const outcome = d ? await this.onKnown(q, d, payment, attempt, n, webhookEventId, ctx) : await this.onNew(q, payment, attempt, n, webhookEventId, ctx);
      await q.query(
        `INSERT INTO payment_dispute_observation ("webhookEventId", provider, "providerDisputeId", kind, "paymentId", "attemptId", "disputeId", amount, currency,
           "chargebackTxnId", "chargebackAmount", "chargebackCurrency", "providerOccurredAt", disposition, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [webhookEventId, providerId, n.providerDisputeId, n.kind, payment.id, attempt.id, outcome.disputeId, n.amount, n.currency,
          n.chargeback?.txnId ?? null, n.chargeback?.amount ?? null, n.chargeback?.currency ?? null, n.providerOccurredAt, outcome.disposition, outcome.reason],
      );
      return this.answer(outcome.disposition, outcome.reason, outcome.disputeId, attempt.id);
    });
    if (result.state === 'conflict') this.log.warn(`payment_dispute_conflict providerDispute=${n.providerDisputeId} kind=${n.kind} outcome=${result.outcome} — preserved for reconciliation (S6h)`);
    else if (result.state === 'processed') this.log.log(`payment_dispute_observed providerDispute=${n.providerDisputeId} kind=${n.kind} outcome=${result.outcome}`);
    return result;
  }

  private answer(disposition: Disposition, reason: string | null, disputeId: string | null, attemptId: string): DisputeIngestionResult {
    if (disposition === 'conflict') return { state: 'conflict', outcome: `dispute_${reason}`, attemptId };
    return { state: 'processed', outcome: `payment_dispute:${disputeId}:${disposition}${reason ? `:${reason}` : ''}`, attemptId };
  }

  private conflict(reason: ConflictReason, disputeId: string | null) {
    return { disposition: 'conflict' as const, reason, disputeId };
  }

  /** A dispute Payment has not recorded yet: bound to the payment's verified capture, in the provider's stated exposure. */
  private async onNew(q: Queryable, payment: PaymentRow, attempt: AttemptRow, n: DisputeNotice, webhookEventId: string, ctx: EventContext) {
    const facts = (await q.query<{ id: string; amount: string; currency: string; contested: boolean }>(
      `SELECT f.id, f.amount, f.currency, EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id) AS contested
         FROM provider_transaction_fact f WHERE f."attemptId" = $1 AND f."paymentId" = $2 AND f.kind = 'capture'`, [attempt.id, payment.id])).rows;
    if (payment.succeededAttemptId !== attempt.id || payment.liveMode !== false || facts.length !== 1 || facts[0]!.contested) return this.conflict('capture_unverified', null);
    const capture = facts[0]!;
    if (n.currency !== capture.currency.trim() || n.amount > Number(capture.amount)) return this.conflict('exposure_mismatch', null);
    if (n.chargeback && (await this.chargebackTaken(q, attempt.provider, n.chargeback.txnId))) return this.conflict('chargeback_unverifiable', null);

    const status = n.kind === 'opened' ? 'open' : n.kind;
    const d = (await q.query<DisputeRow>(
      `INSERT INTO payment_dispute (provider, "providerDisputeId", "paymentId", "attemptId", "captureFactId", amount, currency, reason, status, "providerOpenedAt", "providerClosedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [attempt.provider, n.providerDisputeId, payment.id, attempt.id, capture.id, n.amount, n.currency, n.reason, status,
        n.kind === 'opened' ? n.providerOccurredAt : null, n.kind === 'opened' ? null : n.providerOccurredAt],
    )).rows[0]!;
    await this.outbox.enqueue(q, disputeOpenedEvent(d, payment, ctx));
    await this.audit.recordDispute(q, 'payment_dispute.opened', d, payment.organizationId, ctx);
    if (status !== 'open') await this.close(q, d, payment, n, webhookEventId, ctx);
    return { disposition: 'applied' as const, reason: null, disputeId: d.id };
  }

  private async onKnown(q: Queryable, d: DisputeRow, payment: PaymentRow, attempt: AttemptRow, n: DisputeNotice, webhookEventId: string, ctx: EventContext) {
    if (d.paymentId !== payment.id || d.attemptId !== attempt.id) return this.conflict('payment_mismatch', d.id);
    if (Number(d.amount) !== n.amount || d.currency.trim() !== n.currency) return this.conflict('exposure_mismatch', d.id);
    if (n.kind === 'opened') return { disposition: 'duplicate' as const, reason: d.status === 'open' ? null : 'after_terminal', disputeId: d.id };
    if (d.status === 'open') {
      if (n.chargeback && (await this.chargebackTaken(q, d.provider, n.chargeback.txnId))) return this.conflict('chargeback_unverifiable', d.id);
      const closed = (await q.query<DisputeRow>(
        `UPDATE payment_dispute SET status = $2, "providerClosedAt" = $3 WHERE id = $1 RETURNING *`, [d.id, n.kind, n.providerOccurredAt])).rows[0]!;
      await this.close(q, closed, payment, n, webhookEventId, ctx);
      return { disposition: 'applied' as const, reason: null, disputeId: d.id };
    }
    if (d.status !== n.kind) return this.conflict('terminal_contradiction', d.id); // a final outcome is never replaced
    if (n.kind === 'lost' && n.chargeback) {
      if (!d.chargebackFactId) {
        if (await this.chargebackTaken(q, d.provider, n.chargeback.txnId)) return this.conflict('chargeback_unverifiable', d.id);
        await this.linkChargeback(q, d, payment, n.chargeback, webhookEventId, n.providerOccurredAt);
        return { disposition: 'applied' as const, reason: 'chargeback_evidence', disputeId: d.id };
      }
      const f = (await q.query<{ providerTxnId: string; amount: string; currency: string }>(
        `SELECT "providerTxnId", amount, currency FROM provider_transaction_fact WHERE id = $1`, [d.chargebackFactId])).rows[0]!;
      if (f.providerTxnId !== n.chargeback.txnId || Number(f.amount) !== n.chargeback.amount || f.currency !== n.chargeback.currency) return this.conflict('chargeback_mismatch', d.id);
    }
    return { disposition: 'duplicate' as const, reason: null, disputeId: d.id };
  }

  /** The terminal outcome, its audit intent and, for a loss, its verified chargeback fact (if reported) and `payment.dispute.lost`. */
  private async close(q: Queryable, d: DisputeRow, payment: PaymentRow, n: DisputeNotice, webhookEventId: string, ctx: EventContext): Promise<void> {
    await this.audit.recordDispute(q, 'payment_dispute.closed', d, payment.organizationId, ctx, { outcome: d.status as 'won' | 'lost' });
    if (d.status !== 'lost') return;
    const fact = n.chargeback ? await this.linkChargeback(q, d, payment, n.chargeback, webhookEventId, n.providerOccurredAt) : null;
    await this.outbox.enqueue(q, disputeLostEvent(d, payment, fact, ctx));
  }

  private async chargebackTaken(q: Queryable, provider: string, txnId: string): Promise<boolean> {
    return (await q.query(`SELECT 1 FROM provider_transaction_fact WHERE provider = $1 AND "providerTxnId" = $2 AND kind = 'chargeback'`, [provider, txnId])).rows.length > 0;
  }

  /** FC-1: the provider's chargeback as an immutable fact (its own reference, amount and currency, as reported), linked to the dispute once. */
  private async linkChargeback(q: Queryable, d: DisputeRow, payment: PaymentRow, c: NonNullable<DisputeNotice['chargeback']>, webhookEventId: string, occurredAt: Date | null) {
    const fact = (await q.query<{ id: string; amount: string; currency: string }>(
      `INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", amount, currency, "liveMode", source, "webhookEventId", "providerOccurredAt", "disputeId")
       VALUES ($1, $2, 'chargeback', $3, $4, $5, $6, false, 'webhook', $7, $8, $9) RETURNING id, amount, currency`,
      [d.provider, c.txnId, payment.id, d.attemptId, c.amount, c.currency, webhookEventId, occurredAt, d.id],
    )).rows[0]!;
    await q.query(`UPDATE payment_dispute SET "chargebackFactId" = $2 WHERE id = $1`, [d.id, fact.id]);
    return fact;
  }
}
