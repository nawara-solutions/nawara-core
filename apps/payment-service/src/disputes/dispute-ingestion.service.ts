import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, OutboxService, type Queryable } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import { disputeLostEvent, disputeOpenedEvent, type EventContext } from '../events/payment-events.js';
import type { AttemptRow } from '../attempts/attempt.types.js';
import type { PaymentRow } from '../payments/payment.types.js';
import type { DisputeNotice, DisputeRow } from './dispute.types.js';

type Disposition = 'applied' | 'duplicate' | 'conflict';
type Outcome = { disposition: Disposition | 'held'; reason: string | null; disputeId: string | null };
type ConflictReason = 'capture_unverified' | 'exposure_mismatch' | 'payment_mismatch' | 'terminal_contradiction' | 'chargeback_mismatch' | 'chargeback_unverifiable';

/** Core V2 S0-C9 (CB-5): the outcome a held dispute notification keeps on its webhook event while its capture is not yet verified. */
export const DISPUTE_HELD_OUTCOME = 'dispute_held:capture_pending';

/** The payment states a late capture may follow (CB-1): the payment's workflow ended without its money. */
const FINAL_WITHOUT_SUCCESS = new Set(['failed', 'cancelled', 'expired']);

type Capture = { id: string; amount: string; currency: string };
/** How a new dispute's referenced attempt relates to a verified capture (CB-1, CB-5). */
type Attribution = { kind: 'bound'; capture: Capture; basis: 'settling_capture' | 'late_capture' } | { kind: 'held' } | { kind: 'unverified' };

/**
 * What the webhook pipeline records for the notification: `processed` (applied or duplicate), `conflict` (preserved for S6h), `unmatched`
 * (no attempt of this provider) or, Core V2 S0-C9 (CB-5), `held`: its capture is not verified yet, so the webhook event stays retryable.
 */
export interface DisputeIngestionResult {
  state: 'processed' | 'conflict' | 'unmatched' | 'held';
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
 *
 * Core V2 S0-C9 (register PAY-09 G, EVT-03 M; the Owner's CB-1, CB-2, CB-5, CB-6; FC-1, FC-4, FC-5):
 *   - attribution (CB-1): an unknown dispute is bound to the payment's settling capture (S6e, unchanged) or, when the payment is final
 *     `failed` / `cancelled` / `expired`, to the referenced attempt's single, uncontested capture fact named by a recorded late success
 *     (`late_capture`). The payment, its attempts and its facts never change. Two captures of the attempt, a contested fact, an exposure above
 *     the capture or in another currency, and a further capture of a SUCCEEDED payment stay conflicts, as before;
 *   - out of order (CB-5): a notification whose capture is not verified YET (no capture fact, or no late success naming it, while the
 *     payment is not succeeded through another attempt) is held: nothing is recorded, its webhook event stays retryable for the retrier's
 *     existing bound, and it is processed once attribution succeeds. On its last permitted processing it becomes the `capture_unverified`
 *     conflict (no dispute, no chargeback fact, no event), never before;
 *   - existing observations (CB-6) are never rewritten.
 */
@Injectable()
export class DisputeIngestionService {
  private readonly log = new Logger('PaymentDisputes');

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PaymentAudit) private readonly audit: PaymentAudit,
  ) {}

  /** `lastChance`: this is the notification's last processing the retrier permits (CB-5): an unattributable capture is then a conflict. */
  async ingest(webhookEventId: string, providerId: string, reference: string, n: DisputeNotice, ctx: EventContext, lastChance = false): Promise<DisputeIngestionResult> {
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
      const outcome: Outcome = d ? await this.onKnown(q, d, payment, attempt, n, webhookEventId, ctx) : await this.onNew(q, payment, attempt, n, webhookEventId, ctx, lastChance);
      // CB-5: held, not observed: the observation is written once, when the notification is finally applied or preserved as a conflict
      if (outcome.disposition === 'held') return { state: 'held' as const, outcome: DISPUTE_HELD_OUTCOME, attemptId: attempt.id };
      const observation = (await q.query<{ id: string }>(
        `INSERT INTO payment_dispute_observation ("webhookEventId", provider, "providerDisputeId", kind, "paymentId", "attemptId", "disputeId", amount, currency,
           "chargebackTxnId", "chargebackAmount", "chargebackCurrency", "providerOccurredAt", disposition, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [webhookEventId, providerId, n.providerDisputeId, n.kind, payment.id, attempt.id, outcome.disputeId, n.amount, n.currency,
          n.chargeback?.txnId ?? null, n.chargeback?.amount ?? null, n.chargeback?.currency ?? null, n.providerOccurredAt, outcome.disposition, outcome.reason],
      )).rows[0]!;
      // Core V2 S0-C13 Part A: once, with its observation; a replay answered above, before this. Another payment's dispute is never named.
      if (outcome.disposition === 'conflict') {
        await this.audit.recordDisputeConflict(q, { observationId: observation.id, paymentId: payment.id, attemptId: attempt.id, reason: outcome.reason as string, kind: n.kind,
          disputeId: d?.paymentId === payment.id ? d.id : null }, payment.organizationId, ctx);
      }
      return this.answer(outcome.disposition, outcome.reason, outcome.disputeId, attempt.id);
    });
    if (result.state === 'held') this.log.warn(`payment_dispute_held providerDispute=${n.providerDisputeId} kind=${n.kind} — its capture is not verified yet; retried within the webhook retry bound (CB-5)`);
    else if (result.state === 'conflict') this.log.warn(`payment_dispute_conflict providerDispute=${n.providerDisputeId} kind=${n.kind} outcome=${result.outcome} — preserved for reconciliation (S6h)`);
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

  /**
   * CB-1, CB-5: the verified capture a new dispute of this attempt is bound to, under the payment's row lock (the late success and the capture
   * fact are recorded in their own transactions, so either may still be missing when the provider's dispute arrives: held, never guessed).
   */
  private async attribute(q: Queryable, payment: PaymentRow, attempt: AttemptRow): Promise<Attribution> {
    if (payment.liveMode !== false) return { kind: 'unverified' };
    const facts = (await q.query<Capture & { contested: boolean; named: boolean }>(
      `SELECT f.id, f.amount, f.currency, EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id) AS contested,
              EXISTS (SELECT 1 FROM payment_late_success l WHERE l."factId" = f.id AND l."attemptId" = f."attemptId" AND l."paymentId" = f."paymentId") AS named
         FROM provider_transaction_fact f WHERE f."attemptId" = $1 AND f."paymentId" = $2 AND f.kind = 'capture'`, [attempt.id, payment.id])).rows;
    // ambiguous evidence is never resolved by waiting: two captures of the attempt, or a contested one
    if (facts.length > 1 || facts.some((f) => f.contested)) return { kind: 'unverified' };
    const fact = facts[0];
    if (payment.succeededAttemptId === attempt.id) return fact ? { kind: 'bound', capture: fact, basis: 'settling_capture' } : { kind: 'unverified' };
    if (payment.status === 'succeeded') return { kind: 'unverified' }; // a further capture of a SUCCEEDED payment: out of scope (CB-1)
    if (fact && fact.named && FINAL_WITHOUT_SUCCESS.has(payment.status)) return { kind: 'bound', capture: fact, basis: 'late_capture' };
    return { kind: 'held' }; // the capture, its late success or the payment's final state may still be recorded (CB-5)
  }

  /** A dispute Payment has not recorded yet: bound to a verified capture (CB-1), in the provider's stated exposure; or held (CB-5). */
  private async onNew(q: Queryable, payment: PaymentRow, attempt: AttemptRow, n: DisputeNotice, webhookEventId: string, ctx: EventContext, lastChance: boolean) {
    const a = await this.attribute(q, payment, attempt);
    if (a.kind === 'held' && !lastChance) return { disposition: 'held' as const, reason: null, disputeId: null };
    if (a.kind !== 'bound') return this.conflict('capture_unverified', null);
    const capture = a.capture;
    if (n.currency !== capture.currency.trim() || n.amount > Number(capture.amount)) return this.conflict('exposure_mismatch', null);
    if (n.chargeback && (await this.chargebackTaken(q, attempt.provider, n.chargeback.txnId))) return this.conflict('chargeback_unverifiable', null);

    const status = n.kind === 'opened' ? 'open' : n.kind;
    const d = (await q.query<DisputeRow>(
      `INSERT INTO payment_dispute (provider, "providerDisputeId", "paymentId", "attemptId", "captureFactId", "captureBasis", amount, currency, reason, status,
         "providerOpenedAt", "providerClosedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [attempt.provider, n.providerDisputeId, payment.id, attempt.id, capture.id, a.basis, n.amount, n.currency, n.reason, status,
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
