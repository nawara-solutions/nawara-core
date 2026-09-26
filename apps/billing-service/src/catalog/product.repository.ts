import { BillingAudit, sellerOrganization } from '../audit/billing-audit.js';
import { actorOf, requestTransitionContext } from '../domain/actors.js';
import { Injectable } from '@nestjs/common';
import { DbService, isUniqueViolation, type Queryable } from '@nawara/service-kit';
import type { Caller } from '../domain/actors.js';
import { billingError, notFound } from '../domain/errors.js';
import type { NormalisedCreateProductInput } from '../domain/product-input.js';
import { catalogRelationTo } from '../domain/relations.js';
import type { ProductRow } from './catalog.types.js';

export interface ProductWriteResult {
  product: ProductRow;
  /** false on an identical replay or an already-archived repeat: nothing was written. */
  changed: boolean;
}

/**
 * The only writer of `product` (SDD sections 6, 11). Natural key is `(sellerType, sellerId, code)` — the SDD's own words
 * ("natural key (seller, code)", endpoint 1) — never the producer: `producer` is an isolation column, not part of the
 * idempotency key. Nothing here trusts a client id beyond shape; the seller is whatever the caller asserted (producer
 * scoping is B-029, B-031, not decided).
 */
@Injectable()
export class ProductRepository {
  constructor(
    private readonly db: DbService,
    private readonly audit: BillingAudit,
  ) {}

  /** Creates a product, or replays the identical earlier request for the same `(seller, code)`. `409 product_conflict` when the content differs. */
  async create(producer: string, input: NormalisedCreateProductInput): Promise<ProductWriteResult> {
    // Stage 18.7.2: one transaction, so the product and its central audit intent commit together. A savepoint (not a bare catch) keeps
    // the transaction usable for the replay lookup after a unique violation (the Payment `create` pattern).
    return this.db.tx(async (q) => {
      await q.query('SAVEPOINT create_product');
      try {
        const { rows } = await q.query<ProductRow>(
          `INSERT INTO product (producer, "sellerType", "sellerId", code, name, description, "entitlementKind")
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [producer, input.seller.type, input.seller.id, input.code, input.name, input.description, input.entitlementKind],
        );
        const product = rows[0]!;
        await this.audit.record(q, 'product.created', { organizationId: sellerOrganization(product), resource: { type: 'product', id: product.id } }, requestTransitionContext({ type: 'service', id: producer }));
        return { product, changed: true };
      } catch (e) {
        if (!isUniqueViolation(e, 'product_code_unique')) throw e;
        await q.query('ROLLBACK TO SAVEPOINT create_product');
        return this.replayCreate(q, e, input);
      }
    });
  }

  /** Stage 21.C.2: whether (seller, code) already exists, so a replay is answered without asking Organization Service again. */
  async naturalKeyExists(input: NormalisedCreateProductInput): Promise<boolean> {
    const { rows } = await this.db.query(`SELECT 1 FROM product WHERE "sellerType" = $1 AND "sellerId" = $2 AND code = $3`, [input.seller.type, input.seller.id, input.code]);
    return rows.length > 0;
  }

  private async replayCreate(q: Queryable, e: unknown, input: NormalisedCreateProductInput): Promise<ProductWriteResult> {
    const { rows } = await q.query<ProductRow>(
      `SELECT * FROM product WHERE "sellerType" = $1 AND "sellerId" = $2 AND code = $3`,
      [input.seller.type, input.seller.id, input.code],
    );
    const existing = rows[0];
    if (!existing) throw e; // lost the race in a way that also lost the row: surface the original error
    if (existing.name !== input.name || existing.description !== input.description || existing.entitlementKind !== input.entitlementKind) {
      throw billingError(409, 'product_conflict', 'This seller and code were used with different content.');
    }
    return { product: existing, changed: false };
  }

  /** Reads one product for a caller. No relation is indistinguishable from "does not exist" (SDD 19.2). */
  async findForCaller(id: string, caller: Caller): Promise<ProductRow> {
    const { rows } = await this.db.query<ProductRow>(`SELECT * FROM product WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row || catalogRelationTo(row, caller) === null) throw notFound();
    return row;
  }

  /** `active -> archived`, one way (SDD endpoint 3). Existing invoices are untouched (BI-06): nothing here touches `invoice_line`. */
  async archive(id: string, caller: Caller): Promise<ProductWriteResult> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<ProductRow>(`SELECT * FROM product WHERE id = $1 FOR UPDATE`, [id]);
      const row = rows[0];
      if (!row) throw notFound();
      if (catalogRelationTo(row, caller) === null) throw notFound();
      if (row.status === 'archived') return { product: row, changed: false };
      const updated = await q.query<ProductRow>(`UPDATE product SET status = 'archived' WHERE id = $1 RETURNING *`, [id]);
      await this.audit.record(q, 'product.archived', { organizationId: sellerOrganization(row), resource: { type: 'product', id } }, requestTransitionContext(actorOf(caller))); // Stage 18.7.2 (G4)
      return { product: updated.rows[0]!, changed: true };
    });
  }
}
