import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure, isUniqueViolation, pgConstraint, type DrainOutcome, type Queryable } from '@nawara/service-kit';
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
  /**
   * Core V2 S0-C9 (CB-2, register EVT-03): the disputed captured movement, as Payment states it. Both ABSENT (`undefined`) is a legacy
   * version-1 statement and means `settling_capture`; anything else must be a known basis with a capture fact, or the loss is refused.
   */
  captureFactId?: unknown;
  captureBasis?: unknown;
}

export type CaptureBasis = 'settling_capture' | 'late_capture';
export const CAPTURE_BASES: readonly CaptureBasis[] = ['settling_capture', 'late_capture'];

/**
 * CB-2 compatibility: a statement without both fields is legacy (`settling_capture`, no fact Billing knows); a basis without a fact, a fact
 * without a basis, an unknown basis or a malformed fact is `null` (a `binding_mismatch`: refused, never applied).
 */
export function captureOf(l: Pick<PaymentLoss, 'captureFactId' | 'captureBasis'>): { basis: CaptureBasis; factId: string | null } | null {
  if (l.captureFactId === undefined && l.captureBasis === undefined) return { basis: 'settling_capture', factId: null };
  if (typeof l.captureBasis !== 'string' || !(CAPTURE_BASES as readonly string[]).includes(l.captureBasis)) return null;
  if (typeof l.captureFactId !== 'string' || !UUID.test(l.captureFactId)) return null;
  return { basis: l.captureBasis as CaptureBasis, factId: l.captureFactId };
}

/** Core V2 S0-C10 item 3: a loss's place in its capture's cumulative verified loss, as the database derived it (migration 0049). */
export interface CaptureLoss {
  gross: number;
  chargebackAmount: number;
  withinCap: boolean;
  firstFull: boolean;
}

/**
 * Core V2 S0-C10 (Constraint A, O-1): writes the loss's `capture_loss_cap` row once, in its own transaction, before anything is decided from it.
 * The database derives every column under the capture's lock. A late capture whose late success Billing has not recorded has no capture yet:
 * nothing is written, and the caller holds the loss (S0-C9 item 2). Replays and crashes find the row already written.
 */
export async function recordCaptureLoss(db: DbService, disputeId: string): Promise<void> {
  try {
    await db.tx((q) => q.query(`INSERT INTO capture_loss_cap ("disputeId") VALUES ($1) ON CONFLICT ("disputeId") DO NOTHING`, [disputeId]));
  } catch (e) {
    if (pgConstraint(e) !== 'capture_loss_cap_capture') throw e;
  }
}

/** The loss's recorded place in its capture's cumulative loss; missing is a technical failure (retried), never an eligibility. */
export async function captureLossOf(q: Queryable, disputeId: string): Promise<CaptureLoss> {
  const c = (await q.query<{ gross: string; chargebackAmount: string; withinCap: boolean; firstFull: boolean }>(
    `SELECT gross, "chargebackAmount", "withinCap", "firstFull" FROM capture_loss_cap WHERE "disputeId" = $1`, [disputeId])).rows[0];
  if (!c) throw new Error('capture_loss_cap_missing');
  return { gross: Number(c.gross), chargebackAmount: Number(c.chargebackAmount), withinCap: c.withinCap, firstFull: c.firstFull };
}

export type LossOutcome = 'recorded' | 'duplicate' | 'no_chargeback' | 'binding_mismatch' | 'conflict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

export type DisputeEffectOutcome =
  | { kind: 'applied'; outcome: 'reversed_purchase' | 'none'; reason?: string }
  | { kind: 'already_applied' }
  | { kind: 'review'; reason: string }
  | { kind: 'held'; reason: string };

class Review extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** S0-C9 item 2: a late-capture loss whose late success Billing has not recorded yet: never applied to a purchase until it is. */
class Held extends Error {
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
 *
 * Core V2 S0-C10 (migration 0049): every loss first takes its place in its capture's cumulative loss (`capture_loss_cap`); a direct purchase is
 * reversed only by its capture's first full loss within the cap (a further full loss: `reversed_by_another_chargeback`; a partial above the cap:
 * `chargeback_exceeds_capture`); an L-4 capture's loss above it is the recovery worker's review (O-2); a loss recorded before 0049 that is
 * already in review keeps that review exactly (O-1).
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
    const capture = captureOf(l);
    if (!capture) return this.refused('binding_mismatch', l, 'malformed_capture');
    try {
      return await this.db.tx(async (q) => {
        const pr = (await q.query<{ id: string }>(`SELECT id FROM payment_request WHERE "paymentId" = $1`, [l.paymentId])).rows[0];
        if (!pr) return this.refused('binding_mismatch', l, 'unknown_payment');
        const prior = (await q.query<{ chargebackFactId: string; chargebackAmount: string; disputeAmount: string; captureBasis: string; captureFactId: string | null }>(
          `SELECT "chargebackFactId", "chargebackAmount", "disputeAmount", "captureBasis", "captureFactId" FROM payment_dispute_loss WHERE "disputeId" = $1`, [l.disputeId])).rows[0];
        if (prior) {
          // the same verified loss, stating the same captured movement; any other statement of it is a conflict (S0-C9 item 7)
          const same = prior.chargebackFactId === c.factId && Number(prior.chargebackAmount) === c.amount && Number(prior.disputeAmount) === l.amount
            && prior.captureBasis === capture.basis && prior.captureFactId === capture.factId;
          return same ? 'duplicate' : this.refused('conflict', l, 'another_statement');
        }
        // S0-C9 item 2: a late capture Billing already holds as Payment's late success must be this payment's
        if (capture.basis === 'late_capture') {
          const ls = (await q.query<{ paymentId: string; paymentRequestId: string }>(`SELECT "paymentId", "paymentRequestId" FROM payment_late_success WHERE "factId" = $1`, [capture.factId])).rows[0];
          if (ls && (ls.paymentId !== l.paymentId || ls.paymentRequestId !== pr.id)) return this.refused('binding_mismatch', l, 'capture_of_another_payment');
        }
        await q.query(
          `INSERT INTO payment_dispute_loss ("disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency, "chargebackFactId", "chargebackAmount", "chargebackCurrency", "lostAt", source, "eventId",
                                             "captureBasis", "captureFactId")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [l.disputeId, l.paymentId, pr.id, l.amount, l.currency, c.factId, c.amount, c.currency, l.lostAt, source.kind, source.kind === 'event' ? source.eventId : null,
            capture.basis, capture.factId],
        );
        this.log.log(`dispute_loss_recorded dispute=${l.disputeId} payment=${l.paymentId} source=${source.kind} captureBasis=${capture.basis}`);
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
  async drainOnce(): Promise<{ recorded: number; applied: number; review: number; held: number; failed: number }> {
    if (this.running) return { recorded: 0, applied: 0, review: 0, held: 0, failed: 0 };
    this.running = true;
    try {
      const tally = { recorded: 0, applied: 0, review: 0, held: 0, failed: 0 };
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
          if (o.kind === 'held') tally.held++;
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
      // Core V2 S0-C10 (O-1, O-2): a loss recorded before S0-C10 that is already in review keeps that review exactly, so no historical case is
      // re-derived, duplicated or closed; every other loss is placed in its capture's cumulative loss FIRST, in its own transaction, because a
      // review below rolls its transaction back
      const frozen = (await this.db.query<{ reason: string }>(
        `SELECT t.reason FROM dispute_loss_effect_attempt t JOIN payment_dispute_loss l ON l."disputeId" = t."disputeId"
          WHERE t."disputeId" = $1 AND t.state = 'review' AND l."beforeS0c10"`, [disputeId])).rows[0];
      if (frozen) throw new Review(frozen.reason);
      await recordCaptureLoss(this.db, disputeId);
      const outcome = await this.db.tx(async (q) => {
        const l = (await q.query<{ disputeId: string; paymentId: string; paymentRequestId: string; disputeAmount: string; currency: string; chargebackAmount: string; chargebackCurrency: string;
          captureBasis: CaptureBasis; captureFactId: string | null }>(
          `SELECT "disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency, "chargebackAmount", "chargebackCurrency", "captureBasis", "captureFactId"
             FROM payment_dispute_loss WHERE "disputeId" = $1 FOR UPDATE`,
          [disputeId])).rows[0];
        if (!l) throw new Review('loss_missing');
        if ((await q.query(`SELECT 1 FROM dispute_loss_effect WHERE "disputeId" = $1`, [disputeId])).rows.length > 0) return { kind: 'already_applied' as const };
        // S0-C9 item 7: the payment request's lock, as the L-4 application and the loss's insert take it: a purchase applied concurrently is
        // either committed before this effect (and bound by it) or refused afterwards (`chargeback_recorded`)
        const pr = (await q.query<{ id: string; paymentId: string; amount: string; currency: string; organizationId: string | null }>(
          `SELECT pr.id, pr."paymentId", pr.amount, trim(pr.currency) AS currency, i."organizationId" FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" WHERE pr.id = $1
            FOR UPDATE OF pr`,
          [l.paymentRequestId])).rows[0];
        if (!pr || pr.paymentId !== l.paymentId) throw new Review('payment_mismatch');
        if (l.captureBasis === 'late_capture') return this.applyLateCapture(q, l, pr);
        // `settling_capture` (every legacy loss): the purchase Payment's verified `payment.succeeded` evidences, never an L-4 purchase
        const p = (await q.query<{ id: string; purpose: string; beneficiaryUserId: string; productId: string }>(
          `SELECT id, purpose, "beneficiaryUserId", "productId" FROM subscription_purchase WHERE "paymentRequestId" = $1 AND "lateSuccessId" IS NULL`, [pr.id])).rows[0];
        if (!p) {
          // a settling-capture loss of a request whose only purchase is an L-4 purchase names another captured movement: never applied to it
          if ((await q.query(`SELECT 1 FROM subscription_purchase WHERE "paymentRequestId" = $1`, [pr.id])).rows.length > 0) throw new Review('capture_mismatch');
          return this.recordEffect(q, disputeId, 'none', null, 'not_a_personal_purchase');
        }
        if (l.currency !== pr.currency || l.chargebackCurrency !== pr.currency) throw new Review('currency_mismatch');
        // FC-4: an assisted purchase lost at final stage is never reversed; its beneficiary keeps the entitlement (S6f recovers the base)
        if (p.purpose === 'assisted_settlement') return this.recordEffect(q, disputeId, 'none', p.id, 'assisted_purchase_preserved');
        if (p.purpose !== 'direct_purchase') throw new Review('purchase_mismatch');
        // B10: a direct purchase LOST is reversed; only a chargeback of the whole payment is that loss (no partial threshold is frozen)
        if (Number(l.chargebackAmount) > Number(pr.amount)) throw new Review('chargeback_exceeds_payment');
        const full = Number(l.chargebackAmount) === Number(pr.amount);
        let prior: { cause: string } | undefined;
        if (full) {
          await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing.personal_subscription:' || $1 || ':' || $2, 0))`, [p.beneficiaryUserId, p.productId]);
          prior = (await q.query<{ cause: string }>(`SELECT cause FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [p.id])).rows[0];
          if (prior?.cause === 'final_lost_chargeback') throw new Review('reversed_by_another_chargeback');
        }
        // S0-C10 items 3, 4, 6 (Constraint A): only the capture's first full loss within its cap reverses; a partial that takes the capture's
        // cumulative loss above its gross, or a full loss after any other, is reviewed; both keep their recorded figures
        const cap = await captureLossOf(q, disputeId);
        if (!cap.withinCap || (full && !cap.firstFull)) throw new Review('chargeback_exceeds_capture');
        if (!full) throw new Review('partial_chargeback_threshold_open');
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
      if (e instanceof Held) {
        await this.note(disputeId, 'held', e.reason);
        this.log.warn(`dispute_loss_effect_held dispute=${disputeId} reason=${e.reason} — never applied to a purchase until Billing records its late success`);
        return { kind: 'held', reason: e.reason };
      }
      if (!(e instanceof Review)) throw e;
      await this.note(disputeId, 'review', e.reason);
      this.log.error(`dispute_loss_effect_review dispute=${disputeId} reason=${e.reason} — nothing applied; kept for review and re-checked`);
      return { kind: 'review', reason: e.reason };
    }
  }

  /**
   * Core V2 S0-C9 item 2 (CB-2): a loss of a LATE capture affects only the L-4 purchase evidenced by the late success naming that fact (B10 /
   * FC-4 / S6f: the entitlement preserved, the base-only recovery obligation and T3 from S6f); any other late capture has no purchase effect
   * (`late_capture_unsold`; its reconciliation case may resolve `chargeback_returned`, BIL-33 H). Billing not yet holding the late success:
   * HELD, never applied to a purchase, re-checked until the late success is recorded (event or Payment's read).
   */
  private async applyLateCapture(q: Queryable, l: { disputeId: string; paymentId: string; paymentRequestId: string; currency: string; chargebackAmount: string;
    chargebackCurrency: string; captureFactId: string | null }, pr: { id: string }): Promise<DisputeEffectOutcome> {
    const ls = (await q.query<{ lateSuccessId: string; paymentId: string; paymentRequestId: string; amount: string; currency: string }>(
      `SELECT "lateSuccessId", "paymentId", "paymentRequestId", amount, trim(currency) AS currency FROM payment_late_success WHERE "factId" = $1`, [l.captureFactId])).rows[0];
    if (!ls) throw new Held('late_success_not_recorded');
    if (ls.paymentId !== l.paymentId || ls.paymentRequestId !== pr.id) throw new Review('capture_mismatch');
    if (l.currency !== ls.currency || l.chargebackCurrency !== ls.currency) throw new Review('currency_mismatch');
    const p = (await q.query<{ id: string; purpose: string }>(`SELECT id, purpose FROM subscription_purchase WHERE "lateSuccessId" = $1`, [ls.lateSuccessId])).rows[0];
    // Core V2 S0-C10 item 6 (O-2): an L-4 purchase is assisted, so a loss of its capture above the capture is the recovery worker's review
    // (`recovery_review` and its `chargeback_loss_review` case), never this effect's; a loss of any other late capture above it stays here
    if (p?.purpose === 'assisted_settlement') return this.recordEffect(q, l.disputeId, 'none', p.id, 'assisted_purchase_preserved');
    if (Number(l.chargebackAmount) > Number(ls.amount)) throw new Review('chargeback_exceeds_capture');
    if (!p) {
      // a late success counted as a RECOVERY payment (S6h R6H-4) charged back: no purchase effect, but recovered principal is at stake, which
      // S0-C9 does not define: kept for review (contradictory_effect), never silently closed
      if ((await q.query(`SELECT 1 FROM recovery_payment WHERE "lateSuccessId" = $1`, [ls.lateSuccessId])).rows.length > 0) throw new Review('recovery_payment_capture');
      return this.recordEffect(q, l.disputeId, 'none', null, 'late_capture_unsold');
    }
    // FC-4: the L-4 purchase is assisted; a chargeback never reverses it (S6f recovers the base and applies T3 from this recorded loss)
    if (p.purpose !== 'assisted_settlement') throw new Review('purchase_mismatch');
    return this.recordEffect(q, l.disputeId, 'none', p.id, 'assisted_purchase_preserved');
  }

  private async recordEffect(q: Queryable, disputeId: string, outcome: 'reversed_purchase' | 'none', purchaseId: string | null, reason: string | null): Promise<DisputeEffectOutcome> {
    await q.query(`INSERT INTO dispute_loss_effect ("disputeId", outcome, "purchaseId", reason) VALUES ($1, $2, $3, $4)`, [disputeId, outcome, purchaseId, reason]);
    return { kind: 'applied', outcome, ...(reason ? { reason } : {}) };
  }

  private async note(disputeId: string, state: 'retry' | 'review' | 'held', reason: string): Promise<void> {
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
