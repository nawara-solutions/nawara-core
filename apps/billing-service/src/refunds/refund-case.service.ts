import { Inject, Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import type { TransitionContext } from '../domain/actors.js';
import { billingError, notFound } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';
import { OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import { PAYMENT_DISPUTE_EXPOSURE, type DisputeExposure } from './dispute-exposure.js';
import { PAYMENT_REFUND_CLIENT, type PaymentCapture, type PaymentRefundClient } from './payment-refund-client.js';
import { RefundCommandIdempotency, type RefundCommandResult } from './refund-idempotency.js';
import type { RefundCaseInput } from './refund-input.js';
import type { VerifiedRefundOwner } from './refund-owner.guard.js';

const notEligible = () => billingError(409, 'refund_not_eligible', BILLING_MESSAGES.refundNotEligible);
const caseExists = () => billingError(409, 'refund_case_exists', BILLING_MESSAGES.refundCaseExists);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export interface CaseRow {
  id: string; paymentId: string; companyId: string; platformId: string; organizationId: string | null; amount: string; currency: string;
  status: string; eligibility: string; reason: string; legalOverride: boolean; openedAt: Date; cancelledAt: Date | null; completedAt: Date | null;
  captureFactId: string | null; captureBasis: string | null;
}
const CASE_COLUMNS = `id, "paymentId", "companyId", "platformId", "organizationId", amount, trim(currency) AS currency, status, eligibility, reason,
  "legalOverride", "openedAt", "cancelledAt", "completedAt", "captureFactId", "captureBasis"`;
/** Core V2 R6H-5: the Billing basis of a capture-specific case, from Payment's evidence of the capture (null: no capture-specific basis). */
type CaptureCaseBasis = 'late_capture' | 'duplicate_capture' | 'unrouted_capture';
const TERMINAL_UNPAID = ['failed', 'expired', 'cancelled'];

interface RelayView { id: string; attemptStatus: string | null; refusal: string | null; requestedAt: Date; statusAt: Date | null }

/**
 * A refund case as its Owner reads it (BIL-23, BIL-25). Core V2 S6b: `attempts` are the authorization relays, each with Payment's
 * authoritative attempt status as last confirmed (`unconfirmed` until Payment's answer proved one); never a receipt or its secret.
 */
interface CompletionView { refundAuthorizationId: string; refundAttemptId: string; completedAt: Date; source: string }

interface EffectView { outcome: string; purchaseId: string | null; obligationId: string | null; reason: string | null; recordedAt: Date }
interface ReviewView { state: string; reason: string; firstSeenAt: Date; lastSeenAt: Date }

function representCase(c: CaseRow, relays: RelayView[], completion: CompletionView | null = null, effect: EffectView | null = null, review: ReviewView | null = null) {
  return {
    id: c.id, paymentId: c.paymentId, companyId: c.companyId, platformId: c.platformId, organizationId: c.organizationId,
    amount: Number(c.amount), currency: c.currency, status: c.status, eligibility: c.eligibility, reason: c.reason, legalOverride: c.legalOverride,
    openedAt: iso(c.openedAt), cancelledAt: iso(c.cancelledAt), completedAt: iso(c.completedAt),
    // Core V2 R6H-5: the one verified capture a capture-specific case refunds, and why (null for an ordinary case)
    capture: c.captureFactId ? { captureFactId: c.captureFactId, basis: c.captureBasis } : null,
    attempts: relays.map((r) => ({ refundAttemptId: r.id, status: r.attemptStatus ?? 'unconfirmed', refusal: r.refusal, requestedAt: iso(r.requestedAt), statusAt: iso(r.statusAt) })),
    // Core V2 S6c (R6C-12): Billing's own record of Payment's financial completion (null until the case is completed)
    completion: completion ? { refundAuthorizationId: completion.refundAuthorizationId, refundAttemptId: completion.refundAttemptId, completedAt: iso(completion.completedAt),
      source: completion.source } : null,
    // Core V2 S6d (R6D-3, R6D-6): the commercial effect applied once, or, until then, the worker's non-terminal state (null when none)
    commercialEffect: effect ? { outcome: effect.outcome, purchaseId: effect.purchaseId, obligationId: effect.obligationId, reason: effect.reason, recordedAt: iso(effect.recordedAt) } : null,
    commercialEffectPending: !effect && review ? { state: review.state, reason: review.reason, firstSeenAt: iso(review.firstSeenAt), lastSeenAt: iso(review.lastSeenAt) } : null,
  };
}

/** What Billing's records say about one payment, read outside any transaction to decide authority (the guard re-derives it all). */
interface PaymentFacts {
  paymentRequestId: string; invoiceId: string; sellerType: string; sellerId: string; platforms: string[] | null;
}

/**
 * Core V2 S6a refund cases (register BIL-23, BIL-25; ADR-0067 decision 6; S0 D3, D4, FC-3; the Owner's R6A-1 to R6A-9). DEVELOPMENT AND
 * SIMULATION ONLY: production never mounts the routes and every method refuses there too.
 *
 * Authority (R6A-2), decided BEFORE the transaction (never a network call while holding a lock): the Owner verified live (guard) must own
 * the payment's seller Company, and Auth must say live (`/auth/platform-access`) that the Platform of what was sold is in it; otherwise the
 * collapsed 404, so another Company never learns a payment exists. Then the dispute boundary (R6A-3): an open dispute is 409
 * `refund_dispute_open`, an unanswerable one 503. Then ONE class-K transaction holds the effect, its idempotency record and its audit
 * intent; the database re-derives eligibility, the full amount and every reference (migration 0033). What S6a never does (R6A-6, R6A-8):
 * create a refund attempt, call Payment or Auth's receipts, move money, change an invoice, payment request, purchase, entitlement or
 * obligation, or complete a case.
 */
@Injectable()
export class RefundCaseService {
  constructor(
    private readonly db: DbService,
    private readonly idempotency: RefundCommandIdempotency,
    private readonly audit: BillingAudit,
    @Inject(OWNER_AUTHORITY) private readonly owners: OwnerAuthority,
    @Inject(PAYMENT_DISPUTE_EXPOSURE) private readonly disputes: DisputeExposure,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    @Inject(PAYMENT_REFUND_CLIENT) private readonly payment: PaymentRefundClient,
  ) {}

  private refuseInProduction(): void {
    if (this.config.isProduction) throw notFound();
  }

  private deadline(): AbortSignal {
    return AbortSignal.timeout(this.config.authTimeoutMs);
  }

  /**
   * BIL-23 (R6A-1 to R6A-5): `POST /billing/admin/refund-cases` `{paymentId, reason, legalOverride?}` → `201` the case. 404 for an unknown
   * payment or one outside the Owner's Company or Platform; 409 `refund_not_eligible` (no verified capture, an Organization-subscription
   * payment, no eligible basis, a reversed purchase, a sale naming several Platforms), `refund_case_exists`, `refund_dispute_open`.
   */
  async open(owner: VerifiedRefundOwner, key: string, input: RefundCaseInput, ctx: TransitionContext) {
    this.refuseInProduction();
    const facts = await this.facts(this.db, input.paymentId);
    if (!facts || facts.sellerType !== 'company' || facts.sellerId !== owner.companyId) throw notFound();
    if (!facts.platforms || facts.platforms.length !== 1 || !facts.platforms[0]) throw notEligible();
    const platformId = facts.platforms[0];
    if (!(await this.owners.platformAllowed(owner.bearer, platformId, this.deadline()))) throw notFound();
    // R6A-3: the dispute boundary, outside any transaction; an implementation that cannot answer throws (fail closed, nothing written)
    if ((await this.disputes.status(input.paymentId, this.deadline())) !== 'none') throw billingError(409, 'refund_dispute_open', BILLING_MESSAGES.refundDisputeOpen);
    if (input.captureFactId) return this.openCapture(owner, key, input, input.captureFactId, facts, platformId, ctx);
    return this.idempotency.run(owner.userId, key, 'refund_case.open', { ...input }, async (q): Promise<RefundCommandResult> => {
      const pr = (await q.query<{ id: string; status: string; amount: string; currency: string; organizationId: string | null; purpose: string | null }>(
        `SELECT pr.id, pr.status, pr.amount, pr.currency, i."organizationId", e.purpose
           FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" LEFT JOIN invoice_entitlement e ON e."invoiceId" = pr."invoiceId"
          WHERE pr.id = $1 FOR UPDATE OF pr`, [facts.paymentRequestId])).rows[0]!;
      if (!pr.purpose || pr.purpose === 'organization_subscription') throw notEligible();
      const basis = await this.basis(q, facts.paymentRequestId, facts.invoiceId, pr.purpose);
      // Core V2 S6h-B: only a LATE-success surplus (its request stays failed or cancelled) is refunded from an unpaid request
      if (!basis || (pr.status !== 'paid' && !basis.captureFactId)) throw notEligible();
      // Core V2 S6f (R6F-5 Path A): the recovery-surplus reason is required for, and only for, the recovery-surplus basis
      if ((input.reason === 'recovery_surplus') !== (basis.eligibility === 'recovery_surplus')) throw notEligible();
      // Core V2 R6H-5: one live ORDINARY case per payment; an open capture-specific case (unresolved exposure) or the settling capture's own
      // capture-specific case also refuses it (the database guard enforces both)
      if ((await q.query(`SELECT 1 FROM refund_case WHERE "paymentId" = $1 AND status IN ('open', 'completed') AND eligibility <> 'capture_specific'
            UNION ALL SELECT 1 FROM refund_case WHERE "paymentId" = $1 AND eligibility = 'capture_specific'
              AND (status = 'open' OR (status = 'completed' AND "captureBasis" = 'unrouted_capture'))`, [input.paymentId])).rows.length > 0) throw caseExists();
      const { id } = (await q.query<{ id: string }>(
        `INSERT INTO refund_case ("paymentId", "paymentRequestId", "invoiceId", "receiptId", eligibility, "purchaseId", "lateSettlementId", "companyId", "platformId",
           "organizationId", amount, currency, reason, "legalOverride", "openedBy", "surplusId", "captureFactId", "captureBasis")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
        [input.paymentId, facts.paymentRequestId, facts.invoiceId, basis.receiptId, basis.eligibility, basis.purchaseId, basis.lateSettlementId, owner.companyId, platformId,
          pr.organizationId, basis.amount ?? pr.amount, pr.currency, input.reason, input.legalOverride, owner.userId, basis.surplusId ?? null,
          basis.captureFactId ?? null, basis.captureFactId ? 'late_capture' : null])).rows[0]!;
      const c = await this.load(q, id);
      await this.audit.record(q, 'refund_case.opened', {
        organizationId: c.organizationId, resource: { type: 'refund_case', id },
        changes: { payment_id: c.paymentId, company_id: c.companyId, platform_id: c.platformId, amount: Number(c.amount), eligibility: c.eligibility as never, reason: c.reason as never,
          legal_override: c.legalOverride },
      }, ctx);
      return { status: 201, body: representCase(c, []) };
    });
  }

  /**
   * Core V2 R6H-5 (the Owner's decision, 2026-10-30): `{paymentId, captureFactId, reason, legalOverride?}` opens a CAPTURE-SPECIFIC case for
   * one verified capture the ordinary refund cannot return. Authority and the dispute boundary are the ordinary case's (checked by the caller).
   * Then Payment's evidence of the capture, read OUTSIDE any transaction with Billing's own service token: it must be a capture of this
   * payment, uncontested, with no refund of that money done or in flight. Its basis maps to Billing's: `late_capture` (the payment ended
   * without success; the request too), `duplicate_capture` (a further capture of a succeeded payment), `unrouted_capture` (the settling capture
   * of a paid request with no routing record). The amount and currency are the capture's (Payment's), never a request value. Payment
   * unanswerable is 503, nothing written; the database re-derives Billing's side under the request's row lock (migration 0041).
   */
  private async openCapture(owner: VerifiedRefundOwner, key: string, input: RefundCaseInput, factId: string, facts: PaymentFacts, platformId: string,
    ctx: TransitionContext) {
    const read = await this.payment.capture(input.paymentId, factId);
    if (read.kind === 'unknown') throw billingError(503, 'refund_payment_unavailable', BILLING_MESSAGES.refundPaymentUnavailable);
    if (read.kind === 'not_found') throw notEligible();
    const capture = read.capture;
    if (capture.conflicted) throw notEligible();
    if (capture.refund !== 'none') throw caseExists();
    return this.idempotency.run(owner.userId, key, 'refund_case.open', { ...input }, async (q): Promise<RefundCommandResult> => {
      const pr = (await q.query<{ id: string; status: string; organizationId: string | null; purpose: string | null; routed: boolean }>(
        `SELECT pr.id, pr.status, i."organizationId", e.purpose, e."invoiceId" IS NOT NULL AS routed
           FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" LEFT JOIN invoice_entitlement e ON e."invoiceId" = pr."invoiceId"
          WHERE pr.id = $1 FOR UPDATE OF pr`, [facts.paymentRequestId])).rows[0]!;
      if (pr.purpose === 'organization_subscription' || pr.purpose === 'recovery_settlement') throw notEligible();
      const basis = await this.captureBasis(q, capture, pr, facts);
      if (!basis) throw notEligible();
      if ((await q.query(`SELECT 1 FROM refund_case WHERE "captureFactId" = $1 AND status IN ('open', 'completed')
            UNION ALL SELECT 1 FROM refund_case WHERE "paymentId" = $2 AND eligibility <> 'capture_specific'
              AND (status = 'open' OR (status = 'completed' AND $3::text = 'unrouted_capture'))`, [factId, input.paymentId, basis.basis])).rows.length > 0) throw caseExists();
      const { id } = (await q.query<{ id: string }>(
        `INSERT INTO refund_case ("paymentId", "paymentRequestId", "invoiceId", "receiptId", eligibility, "companyId", "platformId", "organizationId", amount, currency,
           reason, "legalOverride", "openedBy", "captureFactId", "captureBasis")
         VALUES ($1, $2, $3, $4, 'capture_specific', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [input.paymentId, facts.paymentRequestId, facts.invoiceId, basis.receiptId, owner.companyId, platformId, pr.organizationId, capture.amount, capture.currency,
          input.reason, input.legalOverride, owner.userId, factId, basis.basis])).rows[0]!;
      const c = await this.load(q, id);
      await this.audit.record(q, 'refund_case.opened', {
        organizationId: c.organizationId, resource: { type: 'refund_case', id },
        changes: { payment_id: c.paymentId, company_id: c.companyId, platform_id: c.platformId, amount: Number(c.amount), eligibility: 'capture_specific', reason: c.reason as never,
          legal_override: c.legalOverride },
      }, ctx);
      return { status: 201, body: representCase(c, []) };
    });
  }

  /** R6H-5: Payment's basis of the capture, checked against Billing's own payment request (the database guard re-checks Billing's side). */
  private async captureBasis(q: Queryable, capture: PaymentCapture, pr: { id: string; status: string; routed: boolean }, facts: PaymentFacts)
    : Promise<{ basis: CaptureCaseBasis; receiptId: string | null } | null> {
    if (capture.basis !== 'associated_capture' && capture.basis !== 'late_capture' && TERMINAL_UNPAID.includes(capture.paymentStatus)) return null; // defensive
    if (TERMINAL_UNPAID.includes(capture.paymentStatus)) {
      if (!TERMINAL_UNPAID.includes(pr.status)) return null;
      if ((await q.query(`SELECT 1 FROM subscription_purchase WHERE "paymentRequestId" = $1`, [pr.id])).rows.length > 0) return null;
      return { basis: 'late_capture', receiptId: null };
    }
    if (capture.paymentStatus !== 'succeeded' || pr.status !== 'paid') return null;
    if (capture.basis === 'duplicate_capture' || capture.basis === 'other_attempt_capture' || capture.basis === 'associated_capture') {
      return { basis: 'duplicate_capture', receiptId: null };
    }
    if (capture.basis !== 'settling_capture' || pr.routed) return null; // the ordinary refund returns a routed sale's own capture
    if ((await q.query(`SELECT 1 FROM subscription_purchase WHERE "invoiceId" = $1 UNION ALL SELECT 1 FROM assistance_late_settlement WHERE "paymentRequestId" = $2`,
      [facts.invoiceId, pr.id])).rows.length > 0) return null;
    const receipt = (await q.query<{ id: string }>(
      `SELECT id FROM payment_event_receipt WHERE "paymentRequestId" = $1 AND "eventName" = 'payment.succeeded' AND outcome = 'applied' ORDER BY "receivedAt", id LIMIT 1`,
      [pr.id])).rows[0];
    return receipt ? { basis: 'unrouted_capture', receiptId: receipt.id } : null;
  }

  /**
   * R6A-6: `POST /billing/admin/refund-cases/:id/cancel` → `200` the case, `cancelled`. Only an `open` case (`409 refund_case_not_open`).
   * Core V2 S6b (R6B-10): refused (`409 refund_processing_started`) once refund processing has begun, i.e. unless EVERY relay of the case
   * is proven by Payment to have ended without a consumed receipt and without a dispatch (`authorization_expired`, `authorization_refused`,
   * `rejected`); an unconfirmed relay is never treated as refused. The database enforces it too (migration 0034). The payment may get a new
   * case afterwards. Same authority as opening; the collapsed 404 otherwise.
   */
  async cancel(owner: VerifiedRefundOwner, key: string, id: string, ctx: TransitionContext) {
    this.refuseInProduction();
    const c0 = await this.authorizedCase(owner, id);
    return this.idempotency.run(owner.userId, key, 'refund_case.cancel', { id }, async (q): Promise<RefundCommandResult> => {
      const current = (await q.query<{ status: string }>(`SELECT status FROM refund_case WHERE id = $1 FOR UPDATE`, [id])).rows[0]!;
      if (current.status !== 'open') throw billingError(409, 'refund_case_not_open', BILLING_MESSAGES.refundCaseNotOpen);
      const started = await q.query(`SELECT 1 FROM refund_authorization_relay WHERE "refundCaseId" = $1
          AND ("attemptStatus" IS NULL OR "attemptStatus" NOT IN ('authorization_expired', 'authorization_refused', 'rejected'))`, [id]);
      if (started.rows.length > 0) throw billingError(409, 'refund_processing_started', BILLING_MESSAGES.refundProcessingStarted);
      await q.query(`UPDATE refund_case SET status = 'cancelled', "cancelledBy" = $2 WHERE id = $1`, [id, owner.userId]);
      const c = await this.load(q, id);
      await this.audit.record(q, 'refund_case.cancelled', {
        organizationId: c0.organizationId, resource: { type: 'refund_case', id },
        changes: { payment_id: c0.paymentId, company_id: c0.companyId, platform_id: c0.platformId },
      }, ctx);
      return { status: 200, body: representCase(c, await this.relays(q, id)) };
    });
  }

  /** BIL-25: `GET /billing/admin/refund-cases/:id`, the Owner of its Company and Platform (live); everyone else the collapsed 404. */
  async read(owner: VerifiedRefundOwner, id: string) {
    this.refuseInProduction();
    const completion = (await this.db.query<CompletionView>(
      `SELECT "refundAuthorizationId", "refundAttemptId", "completedAt", source FROM refund_case_completion WHERE "refundCaseId" = $1`, [id])).rows[0] ?? null;
    const effect = (await this.db.query<EffectView>(`SELECT outcome, "purchaseId", "obligationId", reason, "recordedAt" FROM refund_case_effect WHERE "refundCaseId" = $1`, [id])).rows[0] ?? null;
    const review = (await this.db.query<ReviewView>(`SELECT state, reason, "firstSeenAt", "lastSeenAt" FROM refund_case_effect_attempt WHERE "refundCaseId" = $1`, [id])).rows[0] ?? null;
    return representCase(await this.authorizedCase(owner, id), await this.relays(this.db, id), completion, effect, review);
  }

  private async relays(q: Queryable, caseId: string): Promise<RelayView[]> {
    return (await q.query<RelayView>(
      `SELECT id, "attemptStatus", refusal, "requestedAt", "statusAt" FROM refund_authorization_relay WHERE "refundCaseId" = $1 ORDER BY "requestedAt", id`, [caseId])).rows;
  }

  /** The case, if the Owner holds its Company and (live) its Platform; the collapsed 404 otherwise. Also BIL-24's authority check. */
  async authorizedCase(owner: VerifiedRefundOwner, id: string): Promise<CaseRow> {
    const c = (await this.db.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM refund_case WHERE id = $1`, [id])).rows[0];
    if (!c || c.companyId !== owner.companyId || !(await this.owners.platformAllowed(owner.bearer, c.platformId, this.deadline()))) throw notFound();
    return c;
  }

  /**
   * R6A-1: the eligible basis of a paid payment request, with its verified capture: a personal purchase (direct or assisted, not reversed),
   * else a late assisted settlement (no purchase), else a `non_entitlement` invoice. Anything else (a routed purchase whose settlement was
   * never recorded, for one) is not eligible: a Payment record alone never makes a payment refundable.
   */
  private async basis(q: Queryable, paymentRequestId: string, invoiceId: string, purpose: string): Promise<{ eligibility: string; receiptId: string | null; purchaseId: string | null;
    lateSettlementId: string | null; surplusId?: string; captureFactId?: string | null; amount?: string } | null> {
    // Core V2 S6f (R6F-5 Path A): a recovery payment is refundable only when it is ENTIRELY surplus owed to the Organization and no external
    // repayment of that surplus was recorded; a mixed payment (principal and surplus) is never refunded
    if (purpose === 'recovery_settlement') {
      // Core V2 S6h-B: a surplus from a LATE success names its capture fact (refunded as exactly that captured movement, R6H-5)
      const s = (await q.query<{ id: string; receiptId: string | null; factId: string | null; amount: string }>(
        `SELECT su.id, p."receiptId", l."factId", su.amount FROM recovery_surplus su JOIN recovery_payment p ON p.id = su."recoveryPaymentId"
           LEFT JOIN payment_late_success l ON l."lateSuccessId" = p."lateSuccessId"
          WHERE p."paymentRequestId" = $1 AND p."principalAmount" = 0 AND su.amount = p.amount
            AND NOT EXISTS (SELECT 1 FROM recovery_surplus_external x WHERE x."surplusId" = su.id)
          ORDER BY su."recordedAt", su.id LIMIT 1`, [paymentRequestId])).rows[0];
      if (!s || (s.receiptId === null && s.factId === null)) return null;
      return { eligibility: 'recovery_surplus', receiptId: s.receiptId, purchaseId: null, lateSettlementId: null, surplusId: s.id, captureFactId: s.factId, amount: s.amount };
    }
    const purchase = (await q.query<{ id: string; receiptId: string; reversed: boolean }>(
      `SELECT s.id, s."receiptId", EXISTS (SELECT 1 FROM subscription_purchase_reversal v WHERE v."purchaseId" = s.id) AS reversed
         FROM subscription_purchase s WHERE s."invoiceId" = $1 AND s."paymentRequestId" = $2 AND s.purpose IN ('direct_purchase', 'assisted_settlement')`,
      [invoiceId, paymentRequestId])).rows[0];
    if (purchase) return purchase.reversed ? null : { eligibility: 'personal_purchase', receiptId: purchase.receiptId, purchaseId: purchase.id, lateSettlementId: null };
    const late = (await q.query<{ id: string; receiptId: string }>(
      `SELECT id, "receiptId" FROM assistance_late_settlement WHERE "invoiceId" = $1 AND "paymentRequestId" = $2`, [invoiceId, paymentRequestId])).rows[0];
    if (late) return { eligibility: 'late_assisted_settlement', receiptId: late.receiptId, purchaseId: null, lateSettlementId: late.id };
    if (purpose !== 'non_entitlement') return null;
    const receipt = (await q.query<{ id: string }>(
      `SELECT id FROM payment_event_receipt WHERE "paymentRequestId" = $1 AND "eventName" = 'payment.succeeded' AND outcome = 'applied' ORDER BY "receivedAt", id LIMIT 1`,
      [paymentRequestId])).rows[0];
    return receipt ? { eligibility: 'non_entitlement', receiptId: receipt.id, purchaseId: null, lateSettlementId: null } : null;
  }

  private async facts(q: Queryable, paymentId: string): Promise<PaymentFacts | null> {
    return (await q.query<PaymentFacts>(
      `SELECT pr.id AS "paymentRequestId", pr."invoiceId", i."sellerType", i."sellerId",
              (SELECT array_agg(DISTINCT p."platformId") FROM invoice_line l JOIN product p ON p.id = l."productId" WHERE l."invoiceId" = pr."invoiceId") AS platforms
         FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" WHERE pr."paymentId" = $1`, [paymentId])).rows[0] ?? null;
  }

  private async load(q: Queryable, id: string): Promise<CaseRow> {
    return (await q.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM refund_case WHERE id = $1`, [id])).rows[0]!;
  }
}
