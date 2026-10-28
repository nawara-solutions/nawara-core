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
import { RefundCommandIdempotency, type RefundCommandResult } from './refund-idempotency.js';
import type { RefundCaseInput } from './refund-input.js';
import type { VerifiedRefundOwner } from './refund-owner.guard.js';

const notEligible = () => billingError(409, 'refund_not_eligible', BILLING_MESSAGES.refundNotEligible);
const caseExists = () => billingError(409, 'refund_case_exists', BILLING_MESSAGES.refundCaseExists);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

interface CaseRow {
  id: string; paymentId: string; companyId: string; platformId: string; organizationId: string | null; amount: string; currency: string;
  status: string; eligibility: string; reason: string; legalOverride: boolean; openedAt: Date; cancelledAt: Date | null; completedAt: Date | null;
}
const CASE_COLUMNS = `id, "paymentId", "companyId", "platformId", "organizationId", amount, trim(currency) AS currency, status, eligibility, reason,
  "legalOverride", "openedAt", "cancelledAt", "completedAt"`;

/** A refund case as its Owner reads it (BIL-23, BIL-25). Refund attempts are S6b: none can exist yet. */
function representCase(c: CaseRow) {
  return {
    id: c.id, paymentId: c.paymentId, companyId: c.companyId, platformId: c.platformId, organizationId: c.organizationId,
    amount: Number(c.amount), currency: c.currency, status: c.status, eligibility: c.eligibility, reason: c.reason, legalOverride: c.legalOverride,
    openedAt: iso(c.openedAt), cancelledAt: iso(c.cancelledAt), completedAt: iso(c.completedAt), attempts: [] as unknown[],
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
    return this.idempotency.run(owner.userId, key, 'refund_case.open', { ...input }, async (q): Promise<RefundCommandResult> => {
      const pr = (await q.query<{ id: string; status: string; amount: string; currency: string; organizationId: string | null; purpose: string | null }>(
        `SELECT pr.id, pr.status, pr.amount, pr.currency, i."organizationId", e.purpose
           FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" LEFT JOIN invoice_entitlement e ON e."invoiceId" = pr."invoiceId"
          WHERE pr.id = $1 FOR UPDATE OF pr`, [facts.paymentRequestId])).rows[0]!;
      if (pr.status !== 'paid' || !pr.purpose || pr.purpose === 'organization_subscription') throw notEligible();
      const basis = await this.basis(q, facts.paymentRequestId, facts.invoiceId, pr.purpose);
      if (!basis) throw notEligible();
      if ((await q.query(`SELECT 1 FROM refund_case WHERE "paymentId" = $1 AND status IN ('open', 'completed')`, [input.paymentId])).rows.length > 0) throw caseExists();
      const { id } = (await q.query<{ id: string }>(
        `INSERT INTO refund_case ("paymentId", "paymentRequestId", "invoiceId", "receiptId", eligibility, "purchaseId", "lateSettlementId", "companyId", "platformId",
           "organizationId", amount, currency, reason, "legalOverride", "openedBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [input.paymentId, facts.paymentRequestId, facts.invoiceId, basis.receiptId, basis.eligibility, basis.purchaseId, basis.lateSettlementId, owner.companyId, platformId,
          pr.organizationId, pr.amount, pr.currency, input.reason, input.legalOverride, owner.userId])).rows[0]!;
      const c = await this.load(q, id);
      await this.audit.record(q, 'refund_case.opened', {
        organizationId: c.organizationId, resource: { type: 'refund_case', id },
        changes: { payment_id: c.paymentId, company_id: c.companyId, platform_id: c.platformId, amount: Number(c.amount), eligibility: c.eligibility as never, reason: c.reason as never,
          legal_override: c.legalOverride },
      }, ctx);
      return { status: 201, body: representCase(c) };
    });
  }

  /**
   * R6A-6: `POST /billing/admin/refund-cases/:id/cancel` → `200` the case, `cancelled`. Only an `open` case (`409 refund_case_not_open`);
   * no refund attempt can exist before S6b (which must refuse a cancellation once refund processing has begun). The payment may get a new
   * case afterwards. Same authority as opening; the collapsed 404 otherwise.
   */
  async cancel(owner: VerifiedRefundOwner, key: string, id: string, ctx: TransitionContext) {
    this.refuseInProduction();
    const c0 = await this.authorizedCase(owner, id);
    return this.idempotency.run(owner.userId, key, 'refund_case.cancel', { id }, async (q): Promise<RefundCommandResult> => {
      const current = (await q.query<{ status: string }>(`SELECT status FROM refund_case WHERE id = $1 FOR UPDATE`, [id])).rows[0]!;
      if (current.status !== 'open') throw billingError(409, 'refund_case_not_open', BILLING_MESSAGES.refundCaseNotOpen);
      await q.query(`UPDATE refund_case SET status = 'cancelled', "cancelledBy" = $2 WHERE id = $1`, [id, owner.userId]);
      const c = await this.load(q, id);
      await this.audit.record(q, 'refund_case.cancelled', {
        organizationId: c0.organizationId, resource: { type: 'refund_case', id },
        changes: { payment_id: c0.paymentId, company_id: c0.companyId, platform_id: c0.platformId },
      }, ctx);
      return { status: 200, body: representCase(c) };
    });
  }

  /** BIL-25: `GET /billing/admin/refund-cases/:id`, the Owner of its Company and Platform (live); everyone else the collapsed 404. */
  async read(owner: VerifiedRefundOwner, id: string) {
    this.refuseInProduction();
    return representCase(await this.authorizedCase(owner, id));
  }

  private async authorizedCase(owner: VerifiedRefundOwner, id: string): Promise<CaseRow> {
    const c = (await this.db.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM refund_case WHERE id = $1`, [id])).rows[0];
    if (!c || c.companyId !== owner.companyId || !(await this.owners.platformAllowed(owner.bearer, c.platformId, this.deadline()))) throw notFound();
    return c;
  }

  /**
   * R6A-1: the eligible basis of a paid payment request, with its verified capture: a personal purchase (direct or assisted, not reversed),
   * else a late assisted settlement (no purchase), else a `non_entitlement` invoice. Anything else (a routed purchase whose settlement was
   * never recorded, for one) is not eligible: a Payment record alone never makes a payment refundable.
   */
  private async basis(q: Queryable, paymentRequestId: string, invoiceId: string, purpose: string) {
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
