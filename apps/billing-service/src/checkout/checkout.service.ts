import { Inject, Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import { CHECKOUT_PRODUCER, OWNER_CATALOG_PRODUCER, type BillingConfig } from '../config/billing-config.js';
import type { Caller, TransitionContext } from '../domain/actors.js';
import { requestHash } from '../domain/canonical.js';
import { billingError, notFound } from '../domain/errors.js';
import { normaliseCreateInvoiceInput } from '../domain/invoice-input.js';
import { SYSTEM_TEMPLATE_V1 } from '../domain/snapshots.js';
import { ACTIVE_PAYMENT_REQUEST_STATUSES } from '../domain/state-machines.js';
import { InvoiceRepository } from '../invoices/invoice.repository.js';
import { PaymentRequestRepository } from '../invoices/payment-request.repository.js';
import { BILLING_MESSAGES } from '../messages.js';
import type { CheckoutInput } from './checkout-input.js';

export interface CheckoutResult {
  status: number;
  body: { invoiceId: string; paymentRequestId: string; paymentId: string | null; status: string };
  replayed: boolean;
}

/**
 * Core V2 S3f direct checkout (register BIL-10; FC-12; the Owner's D1 to D6, D4 Option A). DEVELOPMENT AND SIMULATION ONLY: production
 * never mounts the route and this service refuses there too (B-001 and B-007 are unresolved: no legal issuer, no legal snapshot content).
 *
 * ONE transaction: the checkout's idempotency record, the invoice (reserved producer `billing-checkout`, D3), its issue with the
 * `direct_purchase` routing to the buyer (S3a), and its payment request commit together or not at all. Payment is NOT called here: the
 * existing asynchronous dispatcher sends the request; `paymentId` is null until Payment has returned one. A checkout is never settlement:
 * only Payment's verified `payment.succeeded`, applied by the existing consumer, records the purchase and grants entitlement (S3c).
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly db: DbService,
    private readonly invoices: InvoiceRepository,
    private readonly requests: PaymentRequestRepository,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  async checkout(buyerUserId: string, key: string, input: CheckoutInput, locale: string, ctx: TransitionContext): Promise<CheckoutResult> {
    if (this.config.isProduction) throw notFound(); // second line of the production refusal (the route is not mounted there)
    const hash = requestHash({ operation: 'checkout.direct', ...input });
    return this.db.tx(async (q) => {
      // D5: one key per buyer is serialized; so is the buyer's checkout of one product (different keys), so two can never both create
      await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing.checkout_key:' || $1 || ':' || $2, 0))`, [buyerUserId, key]);
      await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing.checkout_product:' || $1 || ':' || $2, 0))`, [buyerUserId, input.productId]);
      const stored = (await q.query<{ requestHash: string; responseStatus: number; responseBody: CheckoutResult['body'] }>(
        `SELECT "requestHash", "responseStatus", "responseBody" FROM checkout_idempotency WHERE "buyerUserId" = $1 AND "idempotencyKey" = $2`, [buyerUserId, key])).rows[0];
      if (stored) {
        if (stored.requestHash !== hash) throw billingError(409, 'idempotency_key_conflict', BILLING_MESSAGES.idempotencyKeyConflict);
        return { status: stored.responseStatus, body: stored.responseBody, replayed: true }; // the ORIGINAL result; poll the request for its progress
      }
      const result = await this.perform(q, buyerUserId, input, locale, ctx);
      await q.query(
        `INSERT INTO checkout_idempotency ("buyerUserId", "idempotencyKey", "requestHash", "responseStatus", "responseBody") VALUES ($1, $2, $3, $4, $5)`,
        [buyerUserId, key, hash, result.status, JSON.stringify(result.body)],
      );
      return { ...result, replayed: false };
    });
  }

  private async perform(q: Queryable, buyerUserId: string, input: CheckoutInput, locale: string, ctx: TransitionContext): Promise<Omit<CheckoutResult, 'replayed'>> {
    // the Platform's S3d projection: its Company (the SIMULATION SELLER REFERENCE, D4) and its one currency
    const platform = (await q.query<{ companyId: string; currency: string }>(`SELECT "companyId", currency FROM billing_platform WHERE "platformId" = $1`, [input.platformId])).rows[0];
    if (!platform) throw billingError(409, 'platform_not_configured', BILLING_MESSAGES.platformNotConfigured);
    const sellerReference = platform.companyId;
    // FC-12: an ACTIVE personal subscription product of THIS Platform whose Company seller reference is that Company (D4), created by the
    // Owner (S3g D-CAT-8: the reserved `billing-owner` provenance; the database refuses any other line too); any other product (a
    // producer's, another Platform's, an Organization's, a conflicting Company reference, archived, unknown) is one answer
    const product = (await q.query(
      `SELECT 1 FROM product WHERE id = $1 AND "platformId" = $2 AND "subscriptionTarget" = 'personal' AND status = 'active' AND "sellerType" = 'company' AND "sellerId" = $3 AND producer = $4`,
      [input.productId, input.platformId, sellerReference, OWNER_CATALOG_PRODUCER])).rows[0];
    if (!product) throw billingError(409, 'product_not_available', BILLING_MESSAGES.productNotAvailable);
    const price = (await q.query(
      `SELECT 1 FROM price WHERE id = $1 AND "productId" = $2 AND "retiredAt" IS NULL AND "effectiveFrom" <= now() AND "interval" = 'recurring' AND currency = $3`,
      [input.priceId, input.productId, platform.currency.trim()])).rows[0];
    if (!price) throw billingError(422, 'price_not_available', BILLING_MESSAGES.priceNotAvailable);

    // D5 / I-10: the buyer's unfinished checkout of this product (its request created, sending or requested). The same price is
    // answered with that request (no new obligation); another price waits until it ends (409 checkout_uncertain).
    const active = (await q.query<{ invoiceId: string; paymentRequestId: string; paymentId: string | null; status: string; priceId: string }>(
      `SELECT r."invoiceId", r.id AS "paymentRequestId", r."paymentId", r.status, l."priceId"
         FROM payment_request r JOIN invoice i ON i.id = r."invoiceId" JOIN invoice_line l ON l."invoiceId" = i.id
        WHERE i.producer = $1 AND i."payerType" = 'user' AND i."payerId" = $2 AND l."productId" = $3 AND r.status = ANY($4::text[])
        ORDER BY r."createdAt" DESC LIMIT 1`,
      [CHECKOUT_PRODUCER, buyerUserId, input.productId, [...ACTIVE_PAYMENT_REQUEST_STATUSES]])).rows[0];
    if (active) {
      if (active.priceId !== input.priceId) throw billingError(409, 'checkout_uncertain', BILLING_MESSAGES.checkoutUncertain);
      return { status: 200, body: { invoiceId: active.invoiceId, paymentRequestId: active.paymentRequestId, paymentId: active.paymentId, status: active.status } };
    }

    // D1: version-2 REFERENCE snapshots built only from verified facts; the legal identity is explicitly not determined (B-001, B-007)
    const invoiceRequestId = crypto.randomUUID();
    const draft = normaliseCreateInvoiceInput({
      invoiceRequestId,
      seller: { type: 'company', id: sellerReference },
      payer: { type: 'user', id: buyerUserId },
      sourceType: 'direct_checkout',
      sourceId: invoiceRequestId,
      issuerSnapshot: { schemaVersion: 2, partyType: 'company', companyId: sellerReference, platformId: input.platformId, legalIdentity: 'not_determined' },
      billToSnapshot: { schemaVersion: 2, partyType: 'user', userId: buyerUserId, legalIdentity: 'not_determined' },
      lines: [{ priceId: input.priceId, quantity: 1 }],
    });
    // Billing issues as its reserved producer (a payer may never issue: B-028 stays closed for every other path); the ACTOR recorded in
    // history and audit is the verified member (`ctx`). The payment request is the payer's own (SDD endpoint 13's relation).
    const issuer: Caller = { kind: 'service', service: CHECKOUT_PRODUCER };
    const buyer: Caller = { kind: 'user', userId: buyerUserId };
    const { invoice } = await this.invoices.createDraftIn(q, CHECKOUT_PRODUCER, draft, this.config.supportedCurrencies, ctx);
    await this.invoices.issueIn(q, invoice.id, issuer, { template: SYSTEM_TEMPLATE_V1, locale }, ctx, { callerPlatforms: new Set([input.platformId]), organizationPlatformId: null });
    const { request } = await this.requests.createForInvoiceIn(q, invoice.id, buyer, ctx);
    return { status: 201, body: { invoiceId: invoice.id, paymentRequestId: request.id, paymentId: request.paymentId, status: request.status } };
  }
}
