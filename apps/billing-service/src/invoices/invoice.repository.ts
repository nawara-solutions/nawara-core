import { Injectable } from '@nestjs/common';
import { DbService, OutboxService, type Queryable } from '@nawara/service-kit';
import { type Caller, type TransitionContext } from '../domain/actors.js';
import { requestHash } from '../domain/canonical.js';
import { billingError, notFound, operationNotPermitted } from '../domain/errors.js';
import { fromDbAmount } from '../domain/money.js';
import { relationTo } from '../domain/relations.js';
import { SnapshotError, buildPresentationSnapshot } from '../domain/snapshots.js';
import { computeTotals } from '../domain/totals.js';
import type { NormalisedCreateInvoiceInput } from '../domain/invoice-input.js';
import { invoiceCreatedEvent } from './billing-events.js';
import { INVOICE_COLUMNS, type InvoiceLineRow, type InvoiceRecord, type InvoiceRow, type PriceForInvoice } from './invoice.types.js';
import { recordTransition } from './transitions.js';

export interface WriteResult {
  invoice: InvoiceRecord;
  /** false on an identical replay or a state-idempotent repeat: nothing was written. */
  changed: boolean;
}

/**
 * The ONLY writer of `invoice` and `invoice_line` (SDD 6). Every state change is one transaction that holds: the invoice row lock, the
 * change, its `billing_transition` row and (on issue) the outbox event. The database enforces the invariants; this layer decides intent
 * and maps a refusal to a stable error. Nothing here trusts a client amount: totals come from `computeTotals` over catalog prices.
 */
@Injectable()
export class InvoiceRepository {
  constructor(
    private readonly db: DbService,
    private readonly outbox: OutboxService,
  ) {}

  /** Creates a draft (header + lines, one transaction) or replays the identical earlier request. `422`/`409`/`400` per SDD endpoint 7. */
  async createDraft(producer: string, input: NormalisedCreateInvoiceInput, supportedCurrencies: string[], ctx: TransitionContext): Promise<WriteResult> {
    const hash = requestHash({ producer, ...input });
    return this.db.tx(async (q) => {
      const existing = await this.findByNaturalKey(q, producer, input.invoiceRequestId);
      if (existing) return this.replay(existing, hash);

      const prices = await this.loadPrices(q, input.lines.map((l) => l.priceId));
      const priced = input.lines.map((l) => {
        const p = prices.get(l.priceId);
        // unknown, retired, not yet effective, archived product, or a price of ANOTHER seller: all one answer (never leaks which)
        if (!p || !p.available || p.sellerType !== input.seller.type || p.sellerId !== input.seller.id) throw billingError(422, 'price_not_available', 'A price is not available.');
        return { line: l, price: p };
      });
      const currency = priced[0]!.price.currency;
      if (priced.some((x) => x.price.currency !== currency)) throw billingError(422, 'price_not_available', 'All lines of an invoice must share one currency.');
      if (!supportedCurrencies.includes(currency)) throw billingError(422, 'unsupported_currency', 'The currency is not supported.');

      const totals = computeTotals(priced.map((x) => ({ quantity: x.line.quantity, unitAmount: fromDbAmount(x.price.unitAmount) })));

      // ON CONFLICT answers a concurrent identical request without raising, so the transaction stays usable.
      const res = await q.query<InvoiceRow>(
        `INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
                              "sourceType", "sourceId", currency, subtotal, "taxTotal", total, description, "dueAt", "issuerSnapshot", "billToSnapshot")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb)
         ON CONFLICT (producer, "invoiceRequestId") DO NOTHING
         RETURNING *`,
        [producer, input.invoiceRequestId, hash, input.seller.type, input.seller.id, input.payer.type, input.payer.id, input.organizationId, input.sourceType, input.sourceId, currency,
         totals.subtotal.toString(), totals.taxTotal.toString(), totals.total.toString(), input.description, input.dueAt, JSON.stringify(input.issuerSnapshot), JSON.stringify(input.billToSnapshot)],
      );
      const inserted = res.rows[0];
      if (!inserted) {
        // Lost a race with a concurrent identical request: the winner committed first (our INSERT waited on its uncommitted row).
        const winner = await this.findByNaturalKey(q, producer, input.invoiceRequestId);
        if (!winner) throw billingError(409, 'invoice_request_conflict', 'The invoice request conflicts with another request.');
        return this.replay(winner, hash);
      }

      for (const [i, x] of priced.entries()) {
        const c = totals.lines[i]!;
        await q.query(
          `INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "taxAmount",
                                     "entitlementKind", "interval", "intervalUnit", "intervalCount", "sourceType", "sourceId")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [inserted.id, currency, c.lineNumber, x.price.priceId, x.price.productId, x.price.productCode, x.line.description ?? x.price.productName, c.quantity, c.unitAmount.toString(), c.lineTotal.toString(),
           c.taxAmount.toString(), x.price.entitlementKind, x.price.interval, x.price.intervalUnit, x.price.intervalCount, x.line.sourceType, x.line.sourceId],
        );
      }
      await recordTransition(q, { entityType: 'invoice', entityId: inserted.id, from: null, to: 'draft', revision: inserted.revision, ctx });
      return { invoice: (await this.load(q, inserted.id))!, changed: true };
    });
  }

  /** `draft -> open`: locks the invoice, assigns the number (DB trigger, counter lock), sets the presentation snapshot, enqueues `invoice.created`. */
  async issue(invoiceId: string, caller: Caller, presentation: { template: string; locale: string }, ctx: TransitionContext): Promise<WriteResult> {
    return this.db.tx(async (q) => {
      const row = await this.lockForCaller(q, invoiceId, caller);
      if (row.status === 'open') return { invoice: (await this.load(q, invoiceId))!, changed: false }; // state-idempotent (SDD 17.2)
      if (row.status !== 'draft') throw billingError(409, 'invalid_state_transition', `An invoice that is ${row.status} cannot be issued.`);
      let snapshot;
      try {
        snapshot = buildPresentationSnapshot(presentation);
      } catch (e) {
        if (e instanceof SnapshotError) throw billingError(400, 'invalid_invoice_request', e.message);
        throw e;
      }
      const { rows } = await q.query<InvoiceRow>(`UPDATE invoice SET status = 'open', presentation = $2::jsonb WHERE id = $1 RETURNING *`, [invoiceId, JSON.stringify(snapshot)]);
      const updated = rows[0]!;
      await recordTransition(q, { entityType: 'invoice', entityId: invoiceId, from: 'draft', to: 'open', revision: updated.revision, ctx });
      const invoice = (await this.load(q, invoiceId))!;
      await this.outbox.enqueue(q, invoiceCreatedEvent(invoice, ctx));
      return { invoice, changed: true };
    });
  }

  /** `draft -> void`: abandoning a draft. No event (a draft was never announced). Repeat is a no-op only for an already-discarded draft. */
  async discard(invoiceId: string, caller: Caller, ctx: TransitionContext): Promise<WriteResult> {
    return this.db.tx(async (q) => {
      const row = await this.lockForCaller(q, invoiceId, caller);
      if (row.status === 'void' && row.number === null) return { invoice: (await this.load(q, invoiceId))!, changed: false };
      if (row.status !== 'draft') throw billingError(409, 'invalid_state_transition', `An invoice that is ${row.status} cannot be discarded.`);
      const { rows } = await q.query<InvoiceRow>(`UPDATE invoice SET status = 'void', "voidReasonCode" = 'discarded' WHERE id = $1 RETURNING *`, [invoiceId]);
      await recordTransition(q, { entityType: 'invoice', entityId: invoiceId, from: 'draft', to: 'void', revision: rows[0]!.revision, ctx });
      return { invoice: (await this.load(q, invoiceId))!, changed: true };
    });
  }

  /** Reads one invoice for a caller. No relation is indistinguishable from "does not exist" (SDD 19.2). */
  async findForCaller(invoiceId: string, caller: Caller): Promise<InvoiceRecord> {
    const invoice = await this.load(this.db, invoiceId);
    if (!invoice || relationTo(invoice, caller) === null) throw notFound();
    return invoice;
  }

  async load(q: Queryable, invoiceId: string): Promise<InvoiceRecord | null> {
    const { rows } = await q.query<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} FROM invoice WHERE id = $1`, [invoiceId]);
    return rows[0] ? this.withLines(q, rows[0]) : null;
  }

  private async findByNaturalKey(q: Queryable, producer: string, invoiceRequestId: string): Promise<(InvoiceRecord & { requestHash: string }) | null> {
    const { rows } = await q.query<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} FROM invoice WHERE producer = $1 AND "invoiceRequestId" = $2`, [producer, invoiceRequestId]);
    return rows[0] ? ((await this.withLines(q, rows[0])) as InvoiceRecord & { requestHash: string }) : null;
  }

  private replay(existing: InvoiceRecord & { requestHash: string }, hash: string): WriteResult {
    if (existing.requestHash !== hash) throw billingError(409, 'invoice_request_conflict', 'This invoiceRequestId was used with different content.');
    return { invoice: existing, changed: false };
  }

  private async withLines(q: Queryable, row: InvoiceRow): Promise<InvoiceRecord> {
    const { rows } = await q.query<InvoiceLineRow>(`SELECT * FROM invoice_line WHERE "invoiceId" = $1 ORDER BY "lineNumber"`, [row.id]);
    return { ...row, lines: rows };
  }

  private async lockForCaller(q: Queryable, invoiceId: string, caller: Caller): Promise<InvoiceRow> {
    const { rows } = await q.query<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} FROM invoice WHERE id = $1 FOR UPDATE`, [invoiceId]);
    const row = rows[0];
    if (!row) throw notFound();
    const relation = relationTo(row, caller);
    if (relation === null) throw notFound();
    if (relation !== 'producer') throw operationNotPermitted(); // a payer may read and pay, never issue or discard
    return row;
  }

  private async loadPrices(q: Queryable, priceIds: string[]): Promise<Map<string, PriceForInvoice>> {
    const { rows } = await q.query<PriceForInvoice>(
      `SELECT pr.id AS "priceId", p.id AS "productId", p.code AS "productCode", p.name AS "productName", p."sellerType", p."sellerId", p."entitlementKind",
              pr.currency, pr."unitAmount", pr."interval", pr."intervalUnit", pr."intervalCount",
              (pr."retiredAt" IS NULL AND pr."effectiveFrom" <= now() AND p.status = 'active') AS available
         FROM price pr JOIN product p ON p.id = pr."productId" WHERE pr.id = ANY($1::uuid[])`,
      [[...new Set(priceIds)]],
    );
    return new Map(rows.map((r) => [r.priceId, r]));
  }
}
