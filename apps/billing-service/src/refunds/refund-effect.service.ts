import { Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure, type DrainOutcome, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import type { TransitionContext } from '../domain/actors.js';

/** The worker's system identity (Audit catalog: `subscription_purchase.reversed`, `cash_return_obligation.opened`). */
export const REFUND_EFFECT_WORKER = 'refund_effect_worker';
const BATCH_SIZE = 50;
/** How long contradictory evidence waits before it is checked again (it is never final: R6D-6). */
const REVIEW_RECHECK_SECONDS = 3600;
/** A technical failure's bounded backoff: 2^attempts seconds, at most one hour. */
const retryBackoffSeconds = (attempts: number) => Math.min(3600, 2 ** Math.min(attempts, 12));

export type EffectOutcome =
  | { kind: 'applied'; outcome: 'reversed_purchase' | 'reversed_purchase_and_obligation_opened' | 'none'; reason?: string }
  | { kind: 'already_applied' }
  | { kind: 'review'; reason: string };

interface CaseRow {
  id: string; status: string; eligibility: string; paymentId: string; paymentRequestId: string; invoiceId: string; purchaseId: string | null; lateSettlementId: string | null;
  companyId: string; platformId: string; organizationId: string | null; amount: string; currency: string;
}
interface PurchaseRow { id: string; purpose: string; beneficiaryUserId: string; productId: string; paymentRequestId: string; invoiceId: string; assistanceRequestId: string | null; platformId: string }

/** A contradiction: never applied, kept visible and re-checked (R6D-6). */
class Contradiction extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Core V2 S6d (register BIL-24, BIL-25, BIL-26; ADR-0044 B4, B5; S0 FC-4, V-1, K-3 Option D, §1.1, L-3; the Owner's R6D-1 to R6D-6). DEVELOPMENT
 * AND SIMULATION ONLY (the refund module is never mounted in production). The commercial effects of ONE completed refund case, from S6c's
 * authoritative `refund_case_completion` only (a refund request, a relay status or a provider callback never reaches here), in ONE
 * transaction, exactly once per case (`refund_case_effect`, its primary key):
 *
 *   * `personal_purchase`, direct (R6D-1): the case's purchase is reversed once (`subscription_purchase_reversal`, cause
 *     `refund_completion`) with its cause recorded; the entitlement is re-derived by the K-3 Option D fold. Already reversed by ANOTHER cause
 *     (a final-lost chargeback): no second reversal and no entitlement change; this refund cause is appended for S6h (R6D-4).
 *   * `personal_purchase`, assisted (R6D-1, R6D-2): the same reversal AND the Organization's `refund_completion` cash-return obligation to the
 *     beneficiary for the request's full frozen total (base + fee), in the same transaction. An assisted purchase can never already be
 *     reversed (FC-4: a chargeback never reverses one), and its request can never already have an obligation: either is a contradiction.
 *   * `late_assisted_settlement` (L-3): no purchase, the request keeps its existing obligation: `none`. `non_entitlement`: `none`.
 *
 * R6D-6: everything is re-verified from Billing's own rows first (the completion against the case, the basis, the purchase against the case's
 * payment request, invoice, seller Company and Platform, the request's Organization and beneficiary, the existing reversal and obligation).
 * A contradiction applies nothing and is kept as a NON-terminal `review` attempt, re-checked later; a technical failure rolls everything
 * back and is retried with backoff. Lock order: the case, the Organization (assisted, S5D-5), the request, the personal subscription (the
 * purchase path's own lock), then the rows.
 */
@Injectable()
export class RefundEffectService {
  private readonly log = new Logger('BillingRefundEffects');
  private readonly loop = new PollLoop(
    () => this.drainOnce(),
    (e) => this.log.error(`refund_effect_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.log.warn(`worker_drain_timeout worker=refund_effect_worker drainTimeoutMs=${ms} — resumed after restart`),
  );
  private running = false;

  constructor(private readonly db: DbService, private readonly audit: BillingAudit) {}

  start(intervalMs = 5000): void {
    this.loop.start(intervalMs);
  }

  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  /** One pass over every completed case without an effect (including those completed before this worker existed). Exposed for tests. */
  async drainOnce(): Promise<{ applied: number; review: number; failed: number }> {
    if (this.running) return { applied: 0, review: 0, failed: 0 };
    this.running = true;
    try {
      const { rows } = await this.db.query<{ refundCaseId: string }>(
        `SELECT k."refundCaseId" FROM refund_case_completion k
           LEFT JOIN refund_case_effect_attempt t ON t."refundCaseId" = k."refundCaseId"
          WHERE NOT EXISTS (SELECT 1 FROM refund_case_effect e WHERE e."refundCaseId" = k."refundCaseId")
            AND (t."workAfter" IS NULL OR t."workAfter" <= now())
          ORDER BY k."recordedAt", k."refundCaseId" LIMIT $1`, [BATCH_SIZE]);
      const tally = { applied: 0, review: 0, failed: 0 };
      for (const r of rows) {
        try {
          const o = await this.apply(r.refundCaseId);
          if (o.kind === 'applied') tally.applied++;
          if (o.kind === 'review') tally.review++;
        } catch (e) {
          tally.failed++;
          await this.note(r.refundCaseId, 'retry', 'technical_failure').catch(() => undefined);
          this.log.warn(`refund_effect_retry refundCase=${r.refundCaseId} ${describeFailure(e)} — nothing was applied; retried with backoff`);
        }
      }
      return tally;
    } finally {
      this.running = false;
    }
  }

  async apply(refundCaseId: string): Promise<EffectOutcome> {
    const ctx: TransitionContext = {
      actor: { type: 'system', id: REFUND_EFFECT_WORKER }, cause: { type: 'sweep', id: refundCaseId }, correlationId: `refund-effect:${refundCaseId}`,
    };
    try {
      const outcome = await this.db.tx(async (q) => {
        const c = (await q.query<CaseRow>(
          `SELECT id, status, eligibility, "paymentId", "paymentRequestId", "invoiceId", "purchaseId", "lateSettlementId", "companyId", "platformId", "organizationId",
                  amount, trim(currency) AS currency FROM refund_case WHERE id = $1 FOR UPDATE`, [refundCaseId])).rows[0];
        if ((await q.query(`SELECT 1 FROM refund_case_effect WHERE "refundCaseId" = $1`, [refundCaseId])).rows.length > 0) return { kind: 'already_applied' as const };
        const k = (await q.query<{ paymentId: string; approvedAmount: string; currency: string }>(
          `SELECT "paymentId", "approvedAmount", trim(currency) AS currency FROM refund_case_completion WHERE "refundCaseId" = $1`, [refundCaseId])).rows[0];
        if (!c || !k || c.status !== 'completed') throw new Contradiction('case_not_completed');
        if (k.paymentId !== c.paymentId || Number(k.approvedAmount) !== Number(c.amount) || k.currency !== c.currency) throw new Contradiction('completion_mismatch');
        // Core V2 S6f (R6F-5 Path A, R-3a): the completed full refund of an entirely surplus recovery payment resolves that surplus; no purchase,
        // no entitlement, no obligation
        if (c.eligibility === 'recovery_surplus') {
          const s = (await q.query<{ surplusId: string; organizationId: string }>(
            `SELECT rc."surplusId", su."organizationId" FROM refund_case rc JOIN recovery_surplus su ON su.id = rc."surplusId" WHERE rc.id = $1`, [c.id])).rows[0];
          if (!s || c.purchaseId || c.lateSettlementId) throw new Contradiction('basis_mismatch');
          await q.query(`INSERT INTO recovery_surplus_refund ("surplusId", "refundCaseId") VALUES ($1, $2)`, [s.surplusId, c.id]);
          await this.audit.record(q, 'recovery_surplus.resolved', {
            organizationId: s.organizationId, resource: { type: 'recovery_surplus', id: s.surplusId }, changes: { method: 'full_refund', refund_case_id: c.id },
          }, ctx);
          return this.record(q, c.id, 'none', null, null, 'recovery_surplus_refunded');
        }
        if (c.eligibility === 'non_entitlement') {
          if (c.purchaseId || c.lateSettlementId) throw new Contradiction('basis_mismatch');
          return this.record(q, c.id, 'none', null, null, 'no_entitlement_basis');
        }
        if (c.eligibility === 'late_assisted_settlement') {
          const late = (await q.query(`SELECT 1 FROM assistance_late_settlement WHERE id = $1 AND "invoiceId" = $2 AND "paymentRequestId" = $3`,
            [c.lateSettlementId, c.invoiceId, c.paymentRequestId])).rows[0];
          if (!late || c.purchaseId) throw new Contradiction('basis_mismatch');
          if ((await q.query(`SELECT 1 FROM subscription_purchase WHERE "invoiceId" = $1`, [c.invoiceId])).rows.length > 0) throw new Contradiction('late_settlement_has_purchase');
          return this.record(q, c.id, 'none', null, null, 'late_assisted_settlement'); // L-3: the request keeps its existing obligation
        }
        if (c.eligibility !== 'personal_purchase' || !c.purchaseId) throw new Contradiction('basis_mismatch');
        const p = await this.purchase(q, c);
        if (p.purpose === 'assisted_settlement') return this.assisted(q, c, p, ctx);
        // direct purchase: the purchase path's own lock, then the reversal state
        await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing.personal_subscription:' || $1 || ':' || $2, 0))`, [p.beneficiaryUserId, p.productId]);
        const prior = (await q.query<{ cause: string }>(`SELECT cause FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [p.id])).rows[0];
        await q.query(`INSERT INTO subscription_purchase_reversal_cause ("purchaseId", cause, "refundCaseId") VALUES ($1, 'refund_completion', $2)`, [p.id, c.id]);
        if (prior) {
          if (prior.cause === 'refund_completion') throw new Contradiction('reversed_by_another_refund');
          // R6D-4: already reversed by another cause; this refund cause is appended, no second reversal, no entitlement change (S6h)
          this.log.warn(`refund_effect_second_cause refundCase=${c.id} purchase=${p.id} priorCause=${prior.cause} — no second reversal; kept for reconciliation (S6h)`);
          return this.record(q, c.id, 'none', p.id, null, 'already_reversed');
        }
        await this.reverse(q, c, p, ctx);
        return this.record(q, c.id, 'reversed_purchase', p.id, null, null);
      });
      if (outcome.kind === 'applied') {
        // the attempt bookkeeping, if any, stays as history; it is never read once the effect exists
        this.log.log(`refund_effect_applied refundCase=${refundCaseId} outcome=${outcome.outcome}${outcome.reason ? ` reason=${outcome.reason}` : ''}`);
      }
      return outcome;
    } catch (e) {
      if (!(e instanceof Contradiction)) throw e;
      await this.note(refundCaseId, 'review', e.reason);
      this.log.error(`refund_effect_review refundCase=${refundCaseId} reason=${e.reason} — nothing applied; kept for reconciliation and re-checked`);
      return { kind: 'review', reason: e.reason };
    }
  }

  /** The case's purchase, bound to the case's payment request, invoice, Platform and seller Company (R6D-6). */
  private async purchase(q: Queryable, c: CaseRow): Promise<PurchaseRow> {
    const p = (await q.query<PurchaseRow>(
      `SELECT sp.id, sp.purpose, sp."beneficiaryUserId", sp."productId", sp."paymentRequestId", sp."invoiceId", sp."assistanceRequestId", pr."platformId"
         FROM subscription_purchase sp JOIN product pr ON pr.id = sp."productId" WHERE sp.id = $1`, [c.purchaseId])).rows[0];
    if (!p || p.paymentRequestId !== c.paymentRequestId || p.invoiceId !== c.invoiceId || p.platformId !== c.platformId
      || !['direct_purchase', 'assisted_settlement'].includes(p.purpose)) throw new Contradiction('purchase_mismatch');
    const seller = (await q.query<{ sellerType: string; sellerId: string }>(`SELECT "sellerType", "sellerId" FROM invoice WHERE id = $1`, [c.invoiceId])).rows[0];
    if (!seller || seller.sellerType !== 'company' || seller.sellerId !== c.companyId) throw new Contradiction('seller_mismatch');
    return p;
  }

  /** R6D-1 + R6D-2: the assisted purchase's reversal and the Organization's full-cash obligation, together. */
  private async assisted(q: Queryable, c: CaseRow, p: PurchaseRow, ctx: TransitionContext): Promise<EffectOutcome> {
    if (!p.assistanceRequestId) throw new Contradiction('purchase_mismatch');
    const head = (await q.query<{ organizationId: string }>(`SELECT "organizationId" FROM assistance_request WHERE id = $1`, [p.assistanceRequestId])).rows[0];
    if (!head) throw new Contradiction('request_missing');
    await q.query(`SELECT billing_assistance_organization_lock($1)`, [head.organizationId]); // S5D-5: the Organization first
    const r = (await q.query<{ id: string; status: string; organizationId: string; beneficiaryUserId: string; totalAmount: string; currency: string; cashCollectedAt: Date }>(
      `SELECT id, status, "organizationId", "beneficiaryUserId", "totalAmount", trim(currency) AS currency, "cashCollectedAt" FROM assistance_request WHERE id = $1 FOR UPDATE`,
      [p.assistanceRequestId])).rows[0]!;
    if (r.organizationId !== c.organizationId || r.beneficiaryUserId !== p.beneficiaryUserId) throw new Contradiction('request_mismatch');
    if (r.status !== 'settled') throw new Contradiction('request_not_settled');
    if ((await q.query(`SELECT 1 FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [r.id])).rows.length > 0) throw new Contradiction('obligation_exists');
    await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing.personal_subscription:' || $1 || ':' || $2, 0))`, [p.beneficiaryUserId, p.productId]);
    if ((await q.query(`SELECT 1 FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [p.id])).rows.length > 0) throw new Contradiction('assisted_purchase_already_reversed');
    await q.query(`INSERT INTO subscription_purchase_reversal_cause ("purchaseId", cause, "refundCaseId") VALUES ($1, 'refund_completion', $2)`, [p.id, c.id]);
    await this.reverse(q, c, p, ctx);
    // the full frozen cash total (base + fee): the request's own terms, never repriced; never netted with the electronic refund of the base
    const o = (await q.query<{ id: string }>(
      `INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt", origin, "refundCaseId")
       VALUES ($1, $2, $3, $4, $5, $6, 'refund_completion', $7) RETURNING id`,
      [r.id, r.organizationId, r.beneficiaryUserId, r.totalAmount, r.currency, r.cashCollectedAt, c.id])).rows[0]!;
    await this.audit.record(q, 'cash_return_obligation.opened', {
      organizationId: r.organizationId, resource: { type: 'cash_return_obligation', id: o.id },
      changes: { assistance_request_id: r.id, amount: Number(r.totalAmount), origin: 'refund_completion' },
    }, ctx);
    return this.record(q, c.id, 'reversed_purchase_and_obligation_opened', p.id, o.id, null);
  }

  /** One reversal (V-1: the primary key refuses a second), with its audit intent; the ledger fold re-derives the entitlement. */
  private async reverse(q: Queryable, c: CaseRow, p: PurchaseRow, ctx: TransitionContext): Promise<void> {
    await q.query(`INSERT INTO subscription_purchase_reversal ("purchaseId", cause) VALUES ($1, 'refund_completion')`, [p.id]);
    await this.audit.record(q, 'subscription_purchase.reversed', {
      organizationId: c.organizationId, resource: { type: 'subscription_purchase', id: p.id },
      changes: { refund_case_id: c.id, cause: 'refund_completion' },
    }, ctx);
  }

  private async record(q: Queryable, caseId: string, outcome: 'reversed_purchase' | 'reversed_purchase_and_obligation_opened' | 'none', purchaseId: string | null,
    obligationId: string | null, reason: string | null): Promise<EffectOutcome> {
    await q.query(`INSERT INTO refund_case_effect ("refundCaseId", outcome, "purchaseId", "obligationId", reason) VALUES ($1, $2, $3, $4, $5)`,
      [caseId, outcome, purchaseId, obligationId, reason]);
    return { kind: 'applied', outcome, ...(reason ? { reason } : {}) };
  }

  /** The worker's NON-terminal bookkeeping: a retry with backoff, or a review re-checked hourly (R6D-6). */
  private async note(caseId: string, state: 'retry' | 'review', reason: string): Promise<void> {
    await this.db.query(
      `INSERT INTO refund_case_effect_attempt ("refundCaseId", state, reason, "workAfter") VALUES ($1, $2, $3, now() + make_interval(secs => $4))
       ON CONFLICT ("refundCaseId") DO UPDATE SET state = $2, reason = $3, attempts = refund_case_effect_attempt.attempts + 1, "lastSeenAt" = now(),
         "workAfter" = now() + make_interval(secs => CASE WHEN $2 = 'review' THEN $5 ELSE LEAST(3600, power(2, LEAST(refund_case_effect_attempt.attempts + 1, 12))) END)`,
      [caseId, state, reason, state === 'review' ? REVIEW_RECHECK_SECONDS : retryBackoffSeconds(1), REVIEW_RECHECK_SECONDS],
    );
  }
}

@Injectable()
export class RefundEffectWorkerService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly worker: RefundEffectService) {}
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
