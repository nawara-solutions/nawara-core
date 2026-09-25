import { BillingAudit, sellerOrganization } from '../audit/billing-audit.js';
import { actorOf, requestTransitionContext } from '../domain/actors.js';
import { Injectable } from '@nestjs/common';
import { DbService, isUniqueViolation, type Queryable } from '@nawara/service-kit';
import type { Caller } from '../domain/actors.js';
import { billingError, notFound } from '../domain/errors.js';
import { catalogRelationTo } from '../domain/relations.js';
import type { NormalisedCreatePriceInput } from '../domain/price-input.js';
import type { PriceRow, PriceWithProducer } from './catalog.types.js';

export interface PriceWriteResult {
  price: PriceRow;
  /** false on an identical replay or an already-retired repeat: nothing was written. */
  changed: boolean;
}

/**
 * The only writer of `price` (SDD sections 6, 12). Natural key is `(productId, clientReference)`. A price is reached only
 * through its product (SDD 11): the caller must be the producer that created the PARENT product — this checks that chain
 * of custody, never a seller scope (which services may act for which sellers is B-029, B-031, not decided).
 */
@Injectable()
export class PriceRepository {
  constructor(
    private readonly db: DbService,
    private readonly audit: BillingAudit,
  ) {}

  /**
   * Creates a price for a product the caller produced, or replays the identical earlier request. `404` if the product is
   * not the caller's; `422 unsupported_currency` if `currency` is not in this deployment's configured list (BI-11).
   * Whether the product is active is not checked here: archiving never blocks NEW price creation, only NEW invoices from
   * using a price of an archived product (SDD section 11) — that is enforced at invoice creation.
   */
  async create(caller: Caller, input: NormalisedCreatePriceInput, supportedCurrencies: string[]): Promise<PriceWriteResult> {
    if (!supportedCurrencies.includes(input.currency)) throw billingError(422, 'unsupported_currency', 'The currency is not supported.');
    return this.db.tx(async (q) => {
      const product = await this.assertOwnsProduct(q, input.productId, caller);

      try {
        const { rows } = await q.query<PriceRow>(
          `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [input.productId, input.clientReference, input.currency, input.unitAmount.toString(), input.interval, input.intervalUnit, input.intervalCount, input.effectiveFrom],
        );
        const price = rows[0]!;
        await this.audit.record(q, 'price.created', { organizationId: sellerOrganization(product), resource: { type: 'price', id: price.id }, changes: { product_id: product.id } }, requestTransitionContext(actorOf(caller))); // Stage 18.7.2 (G4)
        return { price, changed: true };
      } catch (e) {
        if (!isUniqueViolation(e, 'price_reference_unique')) throw e;
        const { rows } = await q.query<PriceRow>(`SELECT * FROM price WHERE "productId" = $1 AND "clientReference" = $2`, [input.productId, input.clientReference]);
        const existing = rows[0];
        if (!existing) throw e;
        const identical =
          existing.currency === input.currency &&
          existing.unitAmount === input.unitAmount.toString() &&
          existing.interval === input.interval &&
          existing.intervalUnit === input.intervalUnit &&
          existing.intervalCount === input.intervalCount &&
          existing.effectiveFrom.getTime() === input.effectiveFrom.getTime();
        if (!identical) throw billingError(409, 'price_conflict', 'This productId and clientReference were used with different content.');
        return { price: existing, changed: false };
      }
    });
  }

  /** Reads one price for a caller (the producer of its PARENT product). No relation is indistinguishable from "does not exist". */
  async findForCaller(id: string, caller: Caller): Promise<PriceRow> {
    const { rows } = await this.db.query<PriceWithProducer>(
      `SELECT pr.*, p.producer FROM price pr JOIN product p ON p.id = pr."productId" WHERE pr.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row || catalogRelationTo(row, caller) === null) throw notFound();
    const { producer: _producer, ...price } = row;
    return price;
  }

  /** Sets `retiredAt` once (SDD endpoint 6). Existing invoices are untouched (BI-06): a retired price's past lines are unaffected. */
  async retire(id: string, caller: Caller): Promise<PriceWriteResult> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<PriceWithProducer>(
        `SELECT pr.*, p.producer, p."sellerType", p."sellerId" FROM price pr JOIN product p ON p.id = pr."productId" WHERE pr.id = $1 FOR UPDATE OF pr`,
        [id],
      );
      const row = rows[0];
      if (!row) throw notFound();
      if (catalogRelationTo(row, caller) === null) throw notFound();
      const { producer: _producer, sellerType, sellerId, ...price } = row as typeof row & { sellerType: string; sellerId: string };
      if (price.retiredAt !== null) return { price, changed: false };
      const updated = await q.query<PriceRow>(`UPDATE price SET "retiredAt" = now() WHERE id = $1 RETURNING *`, [id]);
      await this.audit.record(q, 'price.retired', { organizationId: sellerOrganization({ sellerType, sellerId }), resource: { type: 'price', id }, changes: { product_id: price.productId } }, requestTransitionContext(actorOf(caller))); // Stage 18.7.2 (G4)
      return { price: updated.rows[0]!, changed: true };
    });
  }

  private async assertOwnsProduct(q: Queryable, productId: string, caller: Caller): Promise<{ id: string; producer: string; status: string; sellerType: string; sellerId: string }> {
    const { rows } = await q.query<{ id: string; producer: string; status: string; sellerType: string; sellerId: string }>(`SELECT id, producer, status, "sellerType", "sellerId" FROM product WHERE id = $1`, [productId]);
    const product = rows[0];
    if (!product || catalogRelationTo(product, caller) === null) throw notFound();
    return product;
  }
}
