import { Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import { actorOf, type Caller, type TransitionContext } from '../domain/actors.js';
import { billingError, notFound } from '../domain/errors.js';
import { fromDbAmount } from '../domain/money.js';
import { decidePaymentEvent, type Decision, type PaymentEventFacts } from '../domain/payment-event-decision.js';
import { relationTo } from '../domain/relations.js';
import { ACTIVE_PAYMENT_REQUEST_STATUSES } from '../domain/state-machines.js';
import { INVOICE_COLUMNS, type InvoiceRow, type PaymentRequestRow } from './invoice.types.js';
import { recordTransition } from './transitions.js';

export interface PaymentRequestResult {
  request: PaymentRequestRow;
  /** false when the current active request was returned (state idempotency, BI-13). */
  created: boolean;
}

export interface EventApplication {
  outcome: Decision['outcome'];
  detail: string | null;
  /** false for a redelivery: the recorded outcome of the first delivery is returned and nothing is written. */
  firstDelivery: boolean;
}

/**
 * Persistence of the payment-request mapping and of the consumption of Payment events (SDD 13, 21.4). Lock order is always invoice first,
 * then payment request. Nothing here calls Payment: sending is Stage 4, and a `paymentId` is NEVER bound from an event.
 */
@Injectable()
export class PaymentRequestRepository {
  constructor(private readonly db: DbService) {}

  /** State-idempotent creation (BI-13): the current active request is returned instead of a second one. */
  async createForInvoice(invoiceId: string, caller: Caller, ctx: TransitionContext): Promise<PaymentRequestResult> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} FROM invoice WHERE id = $1 FOR UPDATE`, [invoiceId]);
      const invoice = rows[0];
      if (!invoice || relationTo(invoice, caller) === null) throw notFound();
      if (invoice.status !== 'open') throw billingError(409, 'invoice_not_payable', 'Only an open invoice can be paid.');
      if (invoice.payerType !== 'user') throw billingError(409, 'payment_request_not_supported', 'Only a user payer can pay an invoice for now.');

      const active = await q.query<PaymentRequestRow>(
        `SELECT * FROM payment_request WHERE "invoiceId" = $1 AND status = ANY($2::text[])`,
        [invoiceId, [...ACTIVE_PAYMENT_REQUEST_STATUSES]],
      );
      if (active.rows[0]) return { request: active.rows[0], created: false };

      const actor = actorOf(caller);
      const inserted = await q.query<PaymentRequestRow>(
        `INSERT INTO payment_request ("invoiceId", amount, currency, "createdByType", "createdById") VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [invoiceId, invoice.total, invoice.currency, actor.type, actor.id],
      );
      const request = inserted.rows[0]!;
      await recordTransition(q, { entityType: 'payment_request', entityId: request.id, from: null, to: 'created', revision: request.revision, ctx });
      return { request, created: true };
    });
  }

  async findForCaller(requestId: string, caller: Caller): Promise<PaymentRequestRow> {
    const { rows } = await this.db.query<PaymentRequestRow & { producer: string; payerType: string; payerId: string }>(
      `SELECT pr.*, i.producer, i."payerType", i."payerId" FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" WHERE pr.id = $1`,
      [requestId],
    );
    const row = rows[0];
    if (!row || relationTo(row, caller) === null) throw notFound();
    const { producer: _p, payerType: _t, payerId: _i, ...request } = row;
    return request;
  }

  /**
   * Applies one Payment event exactly once. The decision is the pure `decidePaymentEvent`, evaluated UNDER the invoice lock; the receipt (the
   * durable twin of the inbox) records what happened. Duplicates, out-of-order, unknown and early events are all handled here and none of them
   * can bind a `paymentId`. A `conflict` or `deferred` outcome changes no state.
   */
  async applyPaymentEvent(eventId: string, event: PaymentEventFacts, ctx: TransitionContext): Promise<EventApplication> {
    return this.db.tx(async (q) => {
      // Find the invoice without a lock, lock it, then re-read the request under the lock (lock order: invoice, then payment_request).
      const probe = await q.query<{ invoiceId: string }>(`SELECT "invoiceId" FROM payment_request WHERE id = $1`, [event.paymentRequestId]);
      const invoiceId = probe.rows[0]?.invoiceId ?? null;
      let invoice: InvoiceRow | null = null;
      let request: PaymentRequestRow | null = null;
      if (invoiceId) {
        invoice = (await q.query<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} FROM invoice WHERE id = $1 FOR UPDATE`, [invoiceId])).rows[0] ?? null;
        request = (await q.query<PaymentRequestRow>(`SELECT * FROM payment_request WHERE id = $1 FOR UPDATE`, [event.paymentRequestId])).rows[0] ?? null;
      }

      const seen = await q.query<{ outcome: string; detailCode: string | null }>(`SELECT outcome, "detailCode" FROM payment_event_receipt WHERE "eventId" = $1`, [eventId]);
      if (seen.rows[0]) return { outcome: seen.rows[0].outcome as Decision['outcome'], detail: seen.rows[0].detailCode, firstDelivery: false };

      const decision = decidePaymentEvent(
        event,
        request && { id: request.id, status: request.status, paymentId: request.paymentId, amount: fromDbAmount(request.amount), currency: request.currency },
        invoice && {
          id: invoice.id, status: invoice.status, payerType: invoice.payerType, payerId: invoice.payerId, sellerType: invoice.sellerType, sellerId: invoice.sellerId,
          organizationId: invoice.organizationId, currency: invoice.currency, total: fromDbAmount(invoice.total),
        },
      );

      // Record first: ON CONFLICT settles two concurrent deliveries of the same event with no error, so this transaction stays usable.
      const receipt = await q.query(
        `INSERT INTO payment_event_receipt ("eventId", "eventName", "paymentRequestId", "paymentId", outcome, "detailCode", "paymentRevision", "causeType")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'payment_event') ON CONFLICT ("eventId") WHERE "eventId" IS NOT NULL DO NOTHING RETURNING id`,
        [eventId, event.name, event.paymentRequestId, request ? request.paymentId : null, decision.outcome, 'detail' in decision ? decision.detail : null, event.revision],
      );
      const detail = 'detail' in decision ? decision.detail : null;
      if (receipt.rowCount === 0) return { outcome: decision.outcome, detail, firstDelivery: false };

      if (decision.outcome === 'applied' && request && invoice) {
        await this.transitionRequest(q, request, decision.requestTo, ctx);
        if (decision.invoiceTo === 'paid') {
          // the request is `paid` first: the invoice trigger insists on it (BI-14)
          const updated = await q.query<InvoiceRow>(`UPDATE invoice SET status = 'paid', "paidAt" = now() WHERE id = $1 RETURNING *`, [invoice.id]);
          await recordTransition(q, { entityType: 'invoice', entityId: invoice.id, from: 'open', to: 'paid', revision: updated.rows[0]!.revision, ctx });
        }
      }
      return { outcome: decision.outcome, detail, firstDelivery: true };
    });
  }

  private async transitionRequest(q: Queryable, request: PaymentRequestRow, to: string, ctx: TransitionContext): Promise<void> {
    const { rows } = await q.query<PaymentRequestRow>(`UPDATE payment_request SET status = $2 WHERE id = $1 RETURNING *`, [request.id, to]);
    await recordTransition(q, { entityType: 'payment_request', entityId: request.id, from: request.status, to, revision: rows[0]!.revision, ctx });
  }
}
