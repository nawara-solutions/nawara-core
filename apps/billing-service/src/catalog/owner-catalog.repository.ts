import { Injectable, Logger } from '@nestjs/common';
import { DbService, isUniqueViolation, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import { OWNER_CATALOG_PRODUCER } from '../config/billing-config.js';
import { requestTransitionContext, type TransitionContext } from '../domain/actors.js';
import { billingError, notFound } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';
import type { VerifiedPlatformOwner } from '../platforms/owner-authority.client.js';
import type { OwnerPriceInput, OwnerProductInput } from './owner-catalog-input.js';
import type { PriceRow, ProductRow } from './catalog.types.js';

export interface OwnerWriteResult<T> {
  row: T;
  /** false on an identical replay or an already-completed transition: nothing was written. */
  changed: boolean;
}

/**
 * Core V2 S3g (register BIL-02, BIL-03; D-CAT-1 to D-CAT-10): the Owner's catalog of personal subscription products and their prices, on
 * the Owner's own configured Platform. Every call carries the Owner Auth verified live for this request (their Company included) and the
 * Platform in the path; nothing here reads a seller, a Company, a Platform or a target from a request.
 *
 *  - Provenance (D-CAT-8): an Owner product is written with the reserved producer `billing-owner`, which no service can hold. The Owner
 *    reaches only those products: a producer's product on the same Platform is answered as missing (404), exactly like another
 *    Platform's or another Company's, and a producer can never reach an Owner product through its own routes (`catalogRelationTo`).
 *  - Seller (D-CAT-2): `company:<billing_platform.companyId>`, a SIMULATION reference to the Platform's Company, not a legal issuer.
 *  - Idempotency (D-CAT-4): the natural identities, compared over the full immutable content before a replay; a different content is a
 *    conflict, never an update. Archive and retire repeat their completed transition.
 *  - Concurrency (D-CAT-6): every price write and retirement locks its product row (`FOR NO KEY UPDATE`, which never blocks a sale's
 *    key-share reference) and an archive takes the stronger `FOR UPDATE`, so the commands on one product apply one at a time, in one
 *    order (product, then price). Prices may coexist: a sale always names its price explicitly.
 *  - Nothing here touches an invoice, a purchase, a subscription or an entitlement (D-CAT-7): retiring and archiving only stop NEW sales,
 *    as invoice creation, checkout and fee proposals already enforce.
 */
@Injectable()
export class OwnerCatalogRepository {
  private readonly log = new Logger('OwnerCatalog');

  constructor(
    private readonly db: DbService,
    private readonly audit: BillingAudit,
  ) {}

  /** BIL-02: a personal subscription product of the Owner's Platform, or the identical earlier one. `409 product_conflict` otherwise. */
  async createProduct(owner: VerifiedPlatformOwner, platformId: string, input: OwnerProductInput): Promise<OwnerWriteResult<ProductRow>> {
    return this.db.tx(async (q) => {
      const platform = await this.platform(q, owner, platformId);
      await q.query('SAVEPOINT owner_product');
      try {
        const { rows } = await q.query<ProductRow>(
          `INSERT INTO product (producer, "sellerType", "sellerId", code, name, description, "entitlementKind", "subscriptionTarget", "platformId")
           VALUES ($1, 'company', $2, $3, $4, $5, $6, 'personal', $7) RETURNING *`,
          [OWNER_CATALOG_PRODUCER, platform.companyId, input.code, input.name, input.description, input.entitlementKind, platformId],
        );
        const product = rows[0]!;
        await this.audit.record(q, 'product.created', { organizationId: null, resource: { type: 'product', id: product.id } }, ownerContext(owner));
        return { row: product, changed: true };
      } catch (e) {
        if (!isUniqueViolation(e, 'product_code_unique')) throw e;
        await q.query('ROLLBACK TO SAVEPOINT owner_product');
        const { rows } = await q.query<ProductRow>(`SELECT * FROM product WHERE "sellerType" = 'company' AND "sellerId" = $1 AND code = $2`, [platform.companyId, input.code]);
        const existing = rows[0];
        if (!existing) throw e;
        // the full immutable content, provenance and Platform included: the Company's code on another Platform, or a producer's product
        // under the same Company reference, is a conflict (codes are unique per Company, D-CAT-10), never a silent replay
        const identical = existing.producer === OWNER_CATALOG_PRODUCER && existing.platformId === platformId && existing.subscriptionTarget === 'personal'
          && existing.name === input.name && existing.description === input.description && existing.entitlementKind === input.entitlementKind;
        if (!identical) throw billingError(409, 'product_conflict', BILLING_MESSAGES.productConflict);
        return { row: existing, changed: false };
      }
    });
  }

  /** BIL-03: a recurring price of an Owner product, in the Platform's one currency, or the identical earlier one (`409 price_conflict`). */
  async createPrice(owner: VerifiedPlatformOwner, platformId: string, productId: string, input: OwnerPriceInput, supportedCurrencies: string[]): Promise<OwnerWriteResult<PriceRow>> {
    return this.db.tx(async (q) => {
      const platform = await this.platform(q, owner, platformId);
      await this.lockProduct(q, platformId, productId, 'FOR NO KEY UPDATE');
      const currency = platform.currency.trim();
      // the Platform's currency is fixed (S3d); a deployment that stopped supporting it sells nothing new in it
      if (!supportedCurrencies.includes(currency)) throw billingError(422, 'unsupported_currency', BILLING_MESSAGES.currencyNotSupported);
      const { rows } = await q.query<PriceRow>(
        `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom")
         VALUES ($1, $2, $3, $4, 'recurring', $5, $6, $7) ON CONFLICT ("productId", "clientReference") DO NOTHING RETURNING *`,
        [productId, input.clientReference, currency, input.unitAmount.toString(), input.intervalUnit, input.intervalCount, input.effectiveFrom],
      );
      if (rows[0]) {
        await this.audit.record(q, 'price.created', { organizationId: null, resource: { type: 'price', id: rows[0].id }, changes: { product_id: productId } }, ownerContext(owner));
        return { row: rows[0], changed: true };
      }
      // the product lock serializes every write of this product's prices, so the conflicting row is visible here
      const existing = (await q.query<PriceRow>(`SELECT * FROM price WHERE "productId" = $1 AND "clientReference" = $2`, [productId, input.clientReference])).rows[0]!;
      const identical = existing.currency === currency && existing.unitAmount === input.unitAmount.toString() && existing.interval === 'recurring'
        && existing.intervalUnit === input.intervalUnit && existing.intervalCount === input.intervalCount && existing.effectiveFrom.getTime() === input.effectiveFrom.getTime();
      if (!identical) throw billingError(409, 'price_conflict', BILLING_MESSAGES.priceConflict);
      return { row: existing, changed: false };
    });
  }

  /** `active -> archived`, one way. A repeat answers the archived product. Existing invoices, purchases and entitlements are untouched. */
  async archive(owner: VerifiedPlatformOwner, platformId: string, productId: string): Promise<OwnerWriteResult<ProductRow>> {
    return this.db.tx(async (q) => {
      await this.platform(q, owner, platformId);
      const product = await this.lockProduct(q, platformId, productId, 'FOR UPDATE');
      if (product.status === 'archived') return { row: product, changed: false };
      const { rows } = await q.query<ProductRow>(`UPDATE product SET status = 'archived' WHERE id = $1 RETURNING *`, [productId]);
      await this.audit.record(q, 'product.archived', { organizationId: null, resource: { type: 'product', id: productId } }, ownerContext(owner));
      return { row: rows[0]!, changed: true };
    });
  }

  /** Sets `retiredAt` once. A repeat answers the retired price. Existing invoices, purchases and entitlements are untouched. */
  async retire(owner: VerifiedPlatformOwner, platformId: string, priceId: string): Promise<OwnerWriteResult<PriceRow>> {
    return this.db.tx(async (q) => {
      await this.platform(q, owner, platformId);
      const productId = (await q.query<{ productId: string }>(`SELECT "productId" FROM price WHERE id = $1`, [priceId])).rows[0]?.productId;
      if (!productId) throw notFound();
      await this.lockProduct(q, platformId, productId, 'FOR NO KEY UPDATE'); // product first, then price: the one lock order
      const price = (await q.query<PriceRow>(`SELECT * FROM price WHERE id = $1 FOR UPDATE`, [priceId])).rows[0]!;
      if (price.retiredAt !== null) return { row: price, changed: false };
      const { rows } = await q.query<PriceRow>(`UPDATE price SET "retiredAt" = now() WHERE id = $1 RETURNING *`, [priceId]);
      await this.audit.record(q, 'price.retired', { organizationId: null, resource: { type: 'price', id: priceId }, changes: { product_id: productId } }, ownerContext(owner));
      return { row: rows[0]!, changed: true };
    });
  }

  /** The Owner's products of this Platform (every status), each with its prices (every state), oldest first. */
  async list(owner: VerifiedPlatformOwner, platformId: string): Promise<Array<{ product: ProductRow; prices: PriceRow[] }>> {
    return this.db.tx(async (q) => {
      await this.platform(q, owner, platformId);
      const products = (await q.query<ProductRow>(
        `SELECT * FROM product WHERE producer = $1 AND "platformId" = $2 ORDER BY "createdAt", id`, [OWNER_CATALOG_PRODUCER, platformId])).rows;
      const prices = (await q.query<PriceRow>(
        `SELECT pr.* FROM price pr JOIN product p ON p.id = pr."productId" WHERE p.producer = $1 AND p."platformId" = $2 ORDER BY pr."createdAt", pr.id`,
        [OWNER_CATALOG_PRODUCER, platformId])).rows;
      return products.map((product) => ({ product, prices: prices.filter((pr) => pr.productId === product.id) }));
    });
  }

  /**
   * The Owner's configured Platform: `409 platform_not_configured` when there is no `billing_platform` row (S3d); a row recorded for
   * another Company is answered as missing (404), exactly as S3d does (Billing never re-points it and never confirms it).
   */
  private async platform(q: Queryable, owner: VerifiedPlatformOwner, platformId: string): Promise<{ companyId: string; currency: string }> {
    const row = (await q.query<{ companyId: string; currency: string }>(`SELECT "companyId", currency FROM billing_platform WHERE "platformId" = $1`, [platformId])).rows[0];
    if (!row) throw billingError(409, 'platform_not_configured', BILLING_MESSAGES.platformNotConfigured);
    if (row.companyId !== owner.companyId) {
      this.log.warn('owner_catalog_company_mismatch'); // a class only, never an identifier
      throw notFound();
    }
    return row;
  }

  /** Locks an Owner product of this Platform; anything else (a producer's, another Platform's, unknown) is one answer: 404. */
  private async lockProduct(q: Queryable, platformId: string, productId: string, mode: 'FOR UPDATE' | 'FOR NO KEY UPDATE'): Promise<ProductRow> {
    const { rows } = await q.query<ProductRow>(`SELECT * FROM product WHERE id = $1 AND producer = $2 AND "platformId" = $3 ${mode}`, [productId, OWNER_CATALOG_PRODUCER, platformId]);
    if (!rows[0]) throw notFound();
    return rows[0];
  }
}

/** The verified Owner as the actor of the change (D-CAT-9): never a service identity, never a request value. */
function ownerContext(owner: VerifiedPlatformOwner): TransitionContext {
  return requestTransitionContext({ type: 'user', id: owner.userId, userKind: 'owner' });
}
