import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure, isUniqueViolation, type DrainOutcome, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import type { TransitionContext } from '../domain/actors.js';
import { PAYMENT_DISPUTE_CLIENT, type PaymentDisputeClient } from './payment-dispute-client.js';

/** The worker's system identity (Audit catalog: `subscription_purchase.reversed`). */
export const DISPUTE_LOSS_WORKER = 'dispute_loss_worker';
const BATCH_SIZE = 50;
const REVIEW_RECHECK_SECONDS = 3600;
const retryBackoffSeconds = (attempts: number) => Math.min(3600, 2 ** Math.min(attempts, 12));

/** Payment's verified final loss, as its event or its losses read states it. */
export interface PaymentLoss {
  disputeId: string;
  paymentId: string;
  amount: number;
  currency: string;
  lostAt: string;
  chargeback: { factId: string; amount: number; currency: string } | null;
}

export type LossOutcome = 'recorded' | 'duplicate' | 'no_chargeback' | 'binding_mismatch' | 'conflict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

export type DisputeEffectOutcome =
  | { kind: 'applied'; outcome: 'reversed_purchase' | 'none'; reason?: string }
  | { kind: 'already_applied' }
  | { kind: 'review'; reason: string };

class Review extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Core V2 S6e-D (register EVT-03, BIL-24; ADR-0044 B5, B10; S0 FC-1, FC-4, V-1, K-3 Option D; the Owner's R6E-5, R6E-6). DEVELOPMENT AND
 * SIMULATION ONLY (the refund module is never mounted in production).
 *
 * `record`: Payment's VERIFIED final loss of a dispute, once (`payment_dispute_loss`), only with its verified chargeback fact (a loss without
 * one is not acted on: Payment's losses read delivers it once the chargeback is reported), and only for a payment Billing requested. The same
 * loss again is a duplicate; a different statement of it is a conflict (never applied, kept for review).
 *
 * `apply` (the dispute loss worker, asynchronous, once per loss in `dispute_loss_effect`), re-verified from Billing's own rows:
 *   - a DIRECT Personal purchase whose payment was charged back IN FULL (the chargeback equals the payment request's amount, in its currency)
 *     is reversed once (`subscription_purchase_reversal`, cause `final_lost_chargeback`, with this dispute as its recorded cause); the ledger
 *     fold re-lays later periods (K-3 Option D). Already reversed by a completed refund: no second reversal, the cause appended (S6h);
 *   - an ASSISTED purchase keeps its entitlement: nothing is reversed and no obligation opened (`assisted_purchase_preserved`; S6f recovers
 *     the base and applies T3 from the recorded loss);
 *   - no Personal purchase: `none`.
 * A PARTIAL chargeback of a direct purchase is never applied: the frozen rules define no threshold for it, so it stays a non-terminal review
 * (`partial_chargeback_threshold_open`) — the contract gap reported to the Owner. A technical failure rolls back and is retried with backoff.
 */
@Injectable()
export class DisputeLossService {
  private readonly log = new Logger('BillingDisputeLosses');
  private readonly loop = new PollLoop(
    () => this.drainOnce(),
    (e) => this.log.error(`dispute_loss_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.log.warn(`worker_drain_timeout worker=dispute_loss_worker drainTimeoutMs=${ms} — resumed after restart`),
  );
  private running = false;

  constructor(private readonly db: DbService, private readonly audit: BillingAudit, @Inject(PAYMENT_DISPUTE_CLIENT) private readonly payments: PaymentDisputeClient) {}

  start(intervalMs = 5000): void {
    this.loop.start(intervalMs);
  }

  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  async record(l: PaymentLoss, source: { kind: 'event'; eventId: string } | { kind: 'reconciliation' }): Promise<LossOutcome> {
    if (![l.disputeId, l.paymentId].every((v) => typeof v === 'string' && UUID.test(v)) || !isAmount(l.amount) || typeof l.currency !== 'string'
      || !/^[A-Z]{3}$/.test(l.currency) || typeof l.lostAt !== 'string' || !ISO.test(l.lostAt)) return this.refused('binding_mismatch', l, 'malformed');
    const c = l.chargeback;
    if (!c) {
      this.log.warn(`dispute_loss_without_chargeback dispute=${l.disputeId} — no money movement reported yet; Payment's losses read delivers it once reported`);
      return 'no_chargeback';
    }
    if (typeof c.factId !== 'string' || !UUID.test(c.factId) || !isAmount(c.amount) || typeof c.currency !== 'string' || c.currency.length > 16) return this.refused('binding_mismatch', l, 'malformed_chargeback');
    try {
      return await this.db.tx(async (q) => {
        const pr = (await q.query<{ id: string }>(`SELECT id FROM payment_request WHERE "paymentId" = $1`, [l.paymentId])).rows[0];
        if (!pr) return this.refused('binding_mismatch', l, 'unknown_payment');
        const prior = (await q.query<{ chargebackFactId: string; chargebackAmount: string; disputeAmount: string }>(
          `SELECT "chargebackFactId", "chargebackAmount", "disputeAmount" FROM payment_dispute_loss WHERE "disputeId" = $1`, [l.disputeId])).rows[0];
        if (prior) {
          const same = prior.chargebackFactId === c.factId && Number(prior.chargebackAmount) === c.amount && Number(prior.disputeAmount) === l.amount;
          return same ? 'duplicate' : this.refused('conflict', l, 'another_statement');
        }
        await q.query(
          `INSERT INTO payment_dispute_loss ("disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency, "chargebackFactId", "chargebackAmount", "chargebackCurrency", "lostAt", source, "eventId")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [l.disputeId, l.paymentId, pr.id, l.amount, l.currency, c.factId, c.amount, c.currency, l.lostAt, source.kind, source.kind === 'event' ? source.eventId : null],
        );
        this.log.log(`dispute_loss_recorded dispute=${l.disputeId} payment=${l.paymentId} source=${source.kind}`);
        return 'recorded' as const;
      });
    } catch (e) {
      if (isUniqueViolation(e)) return 'duplicate'; // a concurrent record of the same loss (the event and the reconciler) won
      throw e;
    }
  }

  private refused(o: 'binding_mismatch' | 'conflict', l: PaymentLoss, why: string): LossOutcome {
    const id = typeof l.disputeId === 'string' && UUID.test(l.disputeId) ? l.disputeId : '[invalid]';
    this.log.error(`dispute_loss_refused dispute=${id} outcome=${o} reason=${why} — nothing changed; needs review`);
    return o;
  }

  /**
   * One pass: Payment's losses read first (a delivery of `payment.dispute.lost` lost, or a chargeback reported after the loss), then every
   * recorded loss without an effect. Exposed for tests.
   */
  async drainOnce(): Promise<{ recorded: number; applied: number; review: number; failed: number }> {
    if (this.running) return { recorded: 0, applied: 0, review: 0, failed: 0 };
    this.running = true;
    try {
      const tally = { recorded: 0, applied: 0, review: 0, failed: 0 };
      try {
        tally.recorded = await this.reconcile();
      } catch (e) {
        this.log.warn(`dispute_loss_read_unavailable ${describeFailure(e)} — recorded losses are still applied; the next pass reads again`);
      }
      const { rows } = await this.db.query<{ disputeId: string }>(
        `SELECT l."disputeId" FROM payment_dispute_loss l LEFT JOIN dispute_loss_effect_attempt t ON t."disputeId" = l."disputeId"
          WHERE NOT EXISTS (SELECT 1 FROM dispute_loss_effect e WHERE e."disputeId" = l."disputeId") AND (t."workAfter" IS NULL OR t."workAfter" <= now())
          ORDER BY l."recordedAt", l."disputeId" LIMIT $1`, [BATCH_SIZE]);
      for (const r of rows) {
        try {
          const o = await this.apply(r.disputeId);
          if (o.kind === 'applied') tally.applied++;
          if (o.kind === 'review') tally.review++;
        } catch (e) {
          tally.failed++;
          await this.note(r.disputeId, 'retry', 'technical_failure').catch(() => undefined);
          this.log.warn(`dispute_loss_effect_retry dispute=${r.disputeId} ${describeFailure(e)} — nothing was applied; retried with backoff`);
        }
      }
      return tally;
    } finally {
      this.running = false;
    }
  }

  /** Payment's losses read, paged by dispute id; every loss Billing has not recorded yet is recorded (source `reconciliation`). */
  private async reconcile(): Promise<number> {
    let after: string | undefined;
    let recorded = 0;
    for (;;) {
      const page = await this.payments.losses(after, 200);
      for (const l of page) {
        if ((await this.db.query(`SELECT 1 FROM payment_dispute_loss WHERE "disputeId" = $1`, [l.disputeId])).rows.length > 0) continue;
        if ((await this.record(l, { kind: 'reconciliation' })) === 'recorded') recorded++;
      }
      if (page.length < 200) return recorded;
      after = page.at(-1)!.disputeId;
    }
  }

  async apply(disputeId: string): Promise<DisputeEffectOutcome> {
    const ctx: TransitionContext = { actor: { type: 'system', id: DISPUTE_LOSS_WORKER }, cause: { type: 'sweep', id: disputeId }, correlationId: `dispute-loss:${disputeId}` };
    try {
      const outcome = await this.db.tx(async (q) => {
        const l = (await q.query<{ disputeId: string; paymentId: string; paymentRequestId: string; disputeAmount: string; currency: string; chargebackAmount: string; chargebackCurrency: string }>(
          `SELECT "disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency, "chargebackAmount", "chargebackCurrency" FROM payment_dispute_loss WHERE "disputeId" = $1 FOR UPDATE`,
          [disputeId])).rows[0];
        if (!l) throw new Review('loss_missing');
        if ((await q.query(`SELECT 1 FROM dispute_loss_effect WHERE "disputeId" = $1`, [disputeId])).rows.length > 0) return { kind: 'already_applied' as const };
        const pr = (await q.query<{ id: string; paymentId: string; amount: string; currency: string; organizationId: string | null }>(
          `SELECT pr.id, pr."paymentId", pr.amount, trim(pr.currency) AS currency, i."organizationId" FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" WHERE pr.id = $1`,
          [l.paymentRequestId])).rows[0];
        if (!pr || pr.paymentId !== l.paymentId) throw new Review('payment_mismatch');
        const p = (await q.query<{ id: string; purpose: string; beneficiaryUserId: string; productId: string }>(
          `SELECT id, purpose, "beneficiaryUserId", "productId" FROM subscription_purchase WHERE "paymentRequestId" = $1`, [pr.id])).rows[0];
        if (!p) return this.recordEffect(q, disputeId, 'none', null, 'not_a_personal_purchase');
        if (l.currency !== pr.currency || l.chargebackCurrency !== pr.currency) throw new Review('currency_mismatch');
        // FC-4: an assisted purchase lost at final stage is never reversed; its beneficiary keeps the entitlement (S6f recovers the base)
        if (p.purpose === 'assisted_settlement') return this.recordEffect(q, disputeId, 'none', p.id, 'assisted_purchase_preserved');
        if (p.purpose !== 'direct_purchase') throw new Review('purchase_mismatch');
        // B10: a direct purchase LOST is reversed; only a chargeback of the whole payment is that loss (no partial threshold is frozen)
        if (Number(l.chargebackAmount) < Number(pr.amount)) throw new Review('partial_chargeback_threshold_open');
        if (Number(l.chargebackAmount) > Number(pr.amount)) throw new Review('chargeback_exceeds_payment');
        await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing.personal_subscription:' || $1 || ':' || $2, 0))`, [p.beneficiaryUserId, p.productId]);
        const prior = (await q.query<{ cause: string }>(`SELECT cause FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [p.id])).rows[0];
        if (prior?.cause === 'final_lost_chargeback') throw new Review('reversed_by_another_chargeback');
        await q.query(`INSERT INTO subscription_purchase_reversal_cause ("purchaseId", cause, "disputeId") VALUES ($1, 'final_lost_chargeback', $2)`, [p.id, disputeId]);
        if (prior) {
          // FC-4: already reversed by a completed refund; this cause is appended, no second reversal, no entitlement change (S6h)
          this.log.warn(`dispute_loss_second_cause dispute=${disputeId} purchase=${p.id} priorCause=${prior.cause} — no second reversal; kept for reconciliation (S6h)`);
          return this.recordEffect(q, disputeId, 'none', p.id, 'already_reversed');
        }
        await q.query(`INSERT INTO subscription_purchase_reversal ("purchaseId", cause) VALUES ($1, 'final_lost_chargeback')`, [p.id]);
        await this.audit.record(q, 'subscription_purchase.reversed', {
          organizationId: pr.organizationId, resource: { type: 'subscription_purchase', id: p.id }, changes: { dispute_id: disputeId, cause: 'final_lost_chargeback' },
        }, ctx);
        return this.recordEffect(q, disputeId, 'reversed_purchase', p.id, null);
      });
      if (outcome.kind === 'applied') this.log.log(`dispute_loss_effect_applied dispute=${disputeId} outcome=${outcome.outcome}${outcome.reason ? ` reason=${outcome.reason}` : ''}`);
      return outcome;
    } catch (e) {
      if (!(e instanceof Review)) throw e;
      await this.note(disputeId, 'review', e.reason);
      this.log.error(`dispute_loss_effect_review dispute=${disputeId} reason=${e.reason} — nothing applied; kept for review and re-checked`);
      return { kind: 'review', reason: e.reason };
    }
  }

  private async recordEffect(q: Queryable, disputeId: string, outcome: 'reversed_purchase' | 'none', purchaseId: string | null, reason: string | null): Promise<DisputeEffectOutcome> {
    await q.query(`INSERT INTO dispute_loss_effect ("disputeId", outcome, "purchaseId", reason) VALUES ($1, $2, $3, $4)`, [disputeId, outcome, purchaseId, reason]);
    return { kind: 'applied', outcome, ...(reason ? { reason } : {}) };
  }

  private async note(disputeId: string, state: 'retry' | 'review', reason: string): Promise<void> {
    await this.db.query(
      `INSERT INTO dispute_loss_effect_attempt ("disputeId", state, reason, "workAfter") VALUES ($1, $2, $3, now() + make_interval(secs => $4))
       ON CONFLICT ("disputeId") DO UPDATE SET state = $2, reason = $3, attempts = dispute_loss_effect_attempt.attempts + 1, "lastSeenAt" = now(),
         "workAfter" = now() + make_interval(secs => CASE WHEN $2 = 'review' THEN $5 ELSE LEAST(3600, power(2, LEAST(dispute_loss_effect_attempt.attempts + 1, 12))) END)`,
      [disputeId, state, reason, state === 'review' ? REVIEW_RECHECK_SECONDS : retryBackoffSeconds(1), REVIEW_RECHECK_SECONDS],
    );
  }
}

@Injectable()
export class DisputeLossWorkerService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly worker: DisputeLossService) {}
  onApplicationBootstrap(): void {
    this.worker.start();
  }
  onModuleDestroy(): void {
    void this.worker.stop();
  }
  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
}
