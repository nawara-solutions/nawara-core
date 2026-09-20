import { Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import { actorOf, type Caller, type TransitionContext } from '../domain/actors.js';
import { deterministicEventId } from '../common/deterministic-id.js';
import { billingError, notFound } from '../domain/errors.js';
import { fromDbAmount } from '../domain/money.js';
import { EXPECTED_PRODUCER, decidePaymentEvent, type Decision, type PaymentEventFacts } from '../domain/payment-event-decision.js';
import type { InvoiceForMapping, RequestForMapping } from '../domain/payment-request-mapping.js';
import { relationTo } from '../domain/relations.js';
import { ACTIVE_PAYMENT_REQUEST_STATUSES } from '../domain/state-machines.js';
import type { PaymentSnapshot } from '../payment-integration/payment-client.js';
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

/** A `created`/stale-`sending` request claimed by the dispatcher, joined with exactly what `buildPaymentRequestBody` needs. */
export interface DispatchClaim {
  request: RequestForMapping;
  invoice: InvoiceForMapping;
  /** The claimed request's originating correlation id, or a deterministic fallback if it never had one. */
  correlationId: string;
  /** True when this claim re-sends a row that was ALREADY `sending` past the stale threshold (a prior attempt that
   * never got an answer), rather than a fresh `created` row — the `payment_dispatch_stale_recovery` signal. */
  wasStale: boolean;
}

/** A `requested` request stale enough for the reconciler to ask Payment about directly. */
export interface StaleRequested {
  id: string;
  paymentId: string;
  /** The request's originating correlation id, or a deterministic fallback if it never had one. */
  correlationId: string;
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
        `INSERT INTO payment_request ("invoiceId", amount, currency, "createdByType", "createdById", "correlationId") VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [invoiceId, invoice.total, invoice.currency, actor.type, actor.id, ctx.correlationId ?? null],
      );
      const request = inserted.rows[0]!;
      await recordTransition(q, { entityType: 'payment_request', entityId: request.id, from: null, to: 'created', revision: request.revision, ctx });
      return { request, created: true };
    });
  }

  /**
   * Claims `created` and stale-`sending` requests for dispatch (SDD 21.5): `FOR UPDATE SKIP LOCKED` so several
   * dispatcher instances never claim the same row twice. Marks each claimed row `sending` in the SAME transaction
   * as the claim — the dispatcher's own transitions never lock or fire a trigger on the invoice (SDD 26), so this
   * never contends with the invoice-locking paths (issue, void, event consumption). The provider call itself
   * happens OUTSIDE this transaction, in the caller (SDD 21.5: never hold a lock across a network call).
   */
  async claimForDispatch(limit: number, staleSendingMs: number, ctx: TransitionContext): Promise<DispatchClaim[]> {
    return this.db.tx(async (q) => {
      const { rows: candidates } = await q.query<PaymentRequestRow>(
        `SELECT * FROM payment_request
          WHERE status = 'created' OR (status = 'sending' AND "sendingSince" < now() - make_interval(secs => $1))
          ORDER BY "createdAt" LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [staleSendingMs / 1000, limit],
      );
      const claims: DispatchClaim[] = [];
      for (const row of candidates) {
        // The request's own originating correlation id if it has one, else a deterministic per-request fallback — never
        // null, so the dispatch call and the transition it records are always traceable (Stage 5 hardening).
        const correlationId = row.correlationId ?? `dispatch:${row.id}`;
        const rowCtx: TransitionContext = { actor: ctx.actor, cause: { type: 'dispatcher', id: row.id }, correlationId };
        const { rows: updated } = await q.query<PaymentRequestRow>(
          `UPDATE payment_request SET status = 'sending', "sendAttempts" = "sendAttempts" + 1 WHERE id = $1 RETURNING *`,
          [row.id],
        );
        const next = updated[0]!;
        // A re-claim of an already-stale `sending` row is a SAME-status update: the lifecycle trigger only bumps `revision`
        // on an actual status change (SDD 26), so `next.revision === row.revision` here — recording a transition anyway
        // would collide with the row already recorded for that revision. Only the genuine `created -> sending` move gets one.
        if (row.status !== next.status) await recordTransition(q, { entityType: 'payment_request', entityId: next.id, from: row.status, to: 'sending', revision: next.revision, ctx: rowCtx });
        // Every field read here is immutable (BI-06/BI-07): no lock needed to read it safely.
        const { rows: invRows } = await q.query<InvoiceForMapping>(
          `SELECT id, number, "payerType", "payerId", "sellerType", "sellerId", "organizationId", currency, description FROM invoice WHERE id = $1`,
          [row.invoiceId],
        );
        const invoice = invRows[0];
        if (!invoice) continue; // cannot happen (FK); defensive only
        claims.push({ request: { id: next.id, amount: fromDbAmount(next.amount), expiresAt: next.expiresAt }, invoice, correlationId, wasStale: row.status === 'sending' });
      }
      return claims;
    });
  }

  /** `sending -> requested`: the ONLY way `paymentId` is ever set (SDD 21.4), from Billing's own authenticated dispatch call. A concurrent resolution (e.g. the reconciler got there first) is a safe no-op. */
  async markRequested(requestId: string, paymentId: string, ctx: TransitionContext): Promise<void> {
    await this.db.tx(async (q) => {
      const { rows } = await q.query<PaymentRequestRow>(`SELECT * FROM payment_request WHERE id = $1 FOR UPDATE`, [requestId]);
      const row = rows[0];
      if (!row || row.status !== 'sending') return;
      const { rows: updated } = await q.query<PaymentRequestRow>(`UPDATE payment_request SET status = 'requested', "paymentId" = $2 WHERE id = $1 RETURNING *`, [requestId, paymentId]);
      await recordTransition(q, { entityType: 'payment_request', entityId: requestId, from: 'sending', to: 'requested', revision: updated[0]!.revision, ctx });
    });
  }

  /** `sending -> rejected`: Payment definitively refused the request (a Billing/config defect, never retried). */
  async markRejected(requestId: string, ctx: TransitionContext): Promise<void> {
    await this.db.tx(async (q) => {
      const { rows } = await q.query<PaymentRequestRow>(`SELECT * FROM payment_request WHERE id = $1 FOR UPDATE`, [requestId]);
      const row = rows[0];
      if (!row || row.status !== 'sending') return;
      const { rows: updated } = await q.query<PaymentRequestRow>(`UPDATE payment_request SET status = 'rejected' WHERE id = $1 RETURNING *`, [requestId]);
      await recordTransition(q, { entityType: 'payment_request', entityId: requestId, from: 'sending', to: 'rejected', revision: updated[0]!.revision, ctx });
    });
  }

  /** `requested` rows old enough that the reconciler should ask Payment directly, rather than wait for an event (SDD 21.5). */
  async findStaleRequested(limit: number, staleRequestedMs: number): Promise<StaleRequested[]> {
    const { rows } = await this.db.query<{ id: string; paymentId: string; correlationId: string | null }>(
      `SELECT id, "paymentId", "correlationId" FROM payment_request
        WHERE status = 'requested' AND "paymentId" IS NOT NULL AND "updatedAt" < now() - make_interval(secs => $1)
        ORDER BY "updatedAt" LIMIT $2`,
      [staleRequestedMs / 1000, limit],
    );
    // Never null: falls back to a deterministic per-request id so reconciliation is always traceable (Stage 5 hardening).
    return rows.map((r) => ({ id: r.id, paymentId: r.paymentId, correlationId: r.correlationId ?? `reconcile:${r.id}` }));
  }

  /**
   * Applies a Payment snapshot the RECONCILER read directly (`GET /payment/payments/{id}`), through the exact same
   * decision procedure a live event uses (SDD 21.5: "applies the SAME consumption procedure with cause =
   * reconciliation"). Still/only `created` or `pending` at Payment: nothing terminal to reconcile yet, so `null`.
   * The synthetic event id is deterministic per `(paymentId, status)`, so a repeated reconciliation tick that
   * observes the same status is itself idempotent (on top of `decidePaymentEvent`'s own state-conditional logic).
   */
  async applyReconciledSnapshot(snapshot: PaymentSnapshot, ctx: TransitionContext): Promise<EventApplication | null> {
    const name = ({ succeeded: 'payment.succeeded', failed: 'payment.failed', cancelled: 'payment.cancelled', expired: 'payment.expired' } as const)[
      snapshot.status as 'succeeded' | 'failed' | 'cancelled' | 'expired'
    ];
    if (!name) return null;
    const eventId = deterministicEventId(snapshot.paymentId, snapshot.status, 'reconciliation');
    const facts: PaymentEventFacts = {
      name,
      source: 'payment-service',
      paymentId: snapshot.paymentId,
      // Payment's GET already restricts a producer to its own payments (SDD 8.4), so anything readable here is
      // already known to be Billing's own by construction — the producer check is trivially satisfied, not skipped.
      producer: EXPECTED_PRODUCER,
      paymentRequestId: snapshot.paymentRequestId,
      sourceType: snapshot.sourceType,
      sourceId: snapshot.sourceId,
      payer: snapshot.payer,
      seller: snapshot.seller,
      organizationId: snapshot.organizationId,
      amount: snapshot.amount,
      currency: snapshot.currency,
      revision: 0, // not from a real event; decidePaymentEvent never reads it (informational only, SDD 21.4)
    };
    return this.applyPaymentEvent(eventId, facts, ctx);
  }

  /** Endpoint 15, case 1 (SDD 17.3): a request never sent (still `created`) is cancelled locally — no Payment call, no event. */
  async cancelUnsent(requestId: string, caller: Caller, ctx: TransitionContext): Promise<PaymentRequestRow> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<PaymentRequestRow & { producer: string; payerType: string; payerId: string }>(
        `SELECT pr.*, i.producer, i."payerType", i."payerId" FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" WHERE pr.id = $1 FOR UPDATE OF pr`,
        [requestId],
      );
      const row = rows[0];
      if (!row || relationTo(row, caller) === null) throw notFound();
      if (row.status !== 'created') throw billingError(409, 'payment_request_in_flight', 'This request has already been sent; it cannot be cancelled locally.');
      const { rows: updated } = await q.query<PaymentRequestRow>(`UPDATE payment_request SET status = 'cancelled' WHERE id = $1 RETURNING *`, [requestId]);
      await recordTransition(q, { entityType: 'payment_request', entityId: requestId, from: 'created', to: 'cancelled', revision: updated[0]!.revision, ctx });
      return updated[0]!;
    });
  }

  /** Endpoint 15, case 2 (SDD 17.3): a `requested` request — stamps `cancelRequestedAt` once; the caller then asks Payment to cancel, and the terminal state arrives later via the normal event/reconciliation path. */
  async markCancelRequested(requestId: string, caller: Caller): Promise<PaymentRequestRow> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<PaymentRequestRow & { producer: string; payerType: string; payerId: string }>(
        `SELECT pr.*, i.producer, i."payerType", i."payerId" FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" WHERE pr.id = $1 FOR UPDATE OF pr`,
        [requestId],
      );
      const row = rows[0];
      if (!row || relationTo(row, caller) === null) throw notFound();
      if (row.status !== 'requested' || !row.paymentId) throw billingError(409, 'payment_request_in_flight', 'This request cannot be cancelled yet.');
      const { rows: updated } = await q.query<PaymentRequestRow>(
        `UPDATE payment_request SET "cancelRequestedAt" = now() WHERE id = $1 AND "cancelRequestedAt" IS NULL RETURNING *`,
        [requestId],
      );
      if (updated[0]) return updated[0];
      const { producer: _p, payerType: _t, payerId: _i, ...request } = row; // already marked: idempotent replay of the marker
      return request;
    });
  }

  /** The invoice's current active request, if any (BI-13: at most one), for the invoice representation's `activePaymentRequest`. */
  async findActiveForInvoice(invoiceId: string): Promise<Pick<PaymentRequestRow, 'id' | 'status' | 'paymentId'> | null> {
    const { rows } = await this.db.query<Pick<PaymentRequestRow, 'id' | 'status' | 'paymentId'>>(
      `SELECT id, status, "paymentId" FROM payment_request WHERE "invoiceId" = $1 AND status = ANY($2::text[])`,
      [invoiceId, [...ACTIVE_PAYMENT_REQUEST_STATUSES]],
    );
    return rows[0] ?? null;
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
