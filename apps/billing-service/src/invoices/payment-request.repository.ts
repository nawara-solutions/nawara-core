import { BillingAudit } from '../audit/billing-audit.js';
import { HttpException, Injectable } from '@nestjs/common';
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
import { recordTransition } from '../domain/transitions.js';
import { SubscriptionRepository } from '../subscriptions/subscription.repository.js';

export interface PaymentRequestResult {
  request: PaymentRequestRow;
  /** false when the current active request was returned (state idempotency, BI-13). */
  created: boolean;
}

/** Stage 12.4: what a successfully-applied `payment.succeeded` did to the Organization's Subscription, if anything.
 * `null` whenever there is nothing to report — the event was not applied at all, the invoice has no organization, or
 * its lines do not identify exactly one recurring (Subscription) obligation (never guessed from more than one). */
export type SubscriptionSettlementOutcome = 'settled' | 'conflict' | null;

export interface EventApplication {
  outcome: Decision['outcome'];
  detail: string | null;
  /** false for a redelivery: the recorded outcome of the first delivery is returned and nothing is written. */
  firstDelivery: boolean;
  subscription: SubscriptionSettlementOutcome;
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
  /** This row's position in the reconciler's scan order, to resume after it. `updatedAt` is carried as text: a JS Date would drop its microseconds. */
  position: ScanPosition;
}

/** Where a reconciliation pass stopped: the next pass resumes strictly after this `(updatedAt, id)`. */
export interface ScanPosition {
  updatedAt: string;
  id: string;
}

/**
 * Persistence of the payment-request mapping and of the consumption of Payment events (SDD 13, 21.4). Lock order is always invoice first,
 * then payment request. Nothing here calls Payment: sending is Stage 4, and a `paymentId` is NEVER bound from an event.
 */
@Injectable()
export class PaymentRequestRepository {
  constructor(
    private readonly db: DbService,
    private readonly subscriptions: SubscriptionRepository,
    private readonly audit: BillingAudit,
  ) {}

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
      await this.audit.record(q, 'payment_request.created', { organizationId: invoice.organizationId, resource: { type: 'payment_request', id: request.id }, changes: { invoice_id: invoiceId } }, ctx); // Stage 18.7.2 (G3)
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
          // `sendingSince` is (re)stamped on EVERY claim: the lifecycle trigger stamps it only on a status change, so a stale `sending` row that is
          // re-claimed (a same-status update) would otherwise stay stale and be re-claimed by every following pass, pinning the head of the batch.
          // With the refresh, `staleSendingMs` is the interval between two attempts at the same request.
          `UPDATE payment_request SET status = 'sending', "sendAttempts" = "sendAttempts" + 1, "sendingSince" = now() WHERE id = $1 RETURNING *`,
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

  /**
   * Stage 15.8: renews the claim of requests this dispatcher pass claimed but has not sent yet (same status, fresh `sendingSince`), so a
   * slow Payment never makes them look stale to another instance while this one still holds them. A row that left `sending` meanwhile
   * is untouched.
   */
  async renewSending(requestIds: string[]): Promise<void> {
    if (requestIds.length === 0) return;
    await this.db.query(`UPDATE payment_request SET "sendingSince" = now() WHERE id = ANY($1::uuid[]) AND status = 'sending'`, [requestIds]);
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

  /**
   * `requested` rows old enough that the reconciler should ask Payment directly, rather than wait for an event (SDD 21.5), in
   * `(updatedAt, id)` order and strictly AFTER `after` when given. A request that Payment still reports as unpaid is not updated,
   * so it keeps its place: without a resume position, the oldest `limit` unpaid requests would be the only ones ever examined.
   */
  async findStaleRequested(limit: number, staleRequestedMs: number, after: ScanPosition | null = null): Promise<StaleRequested[]> {
    const { rows } = await this.db.query<{ id: string; paymentId: string; correlationId: string | null; updatedAtText: string }>(
      `SELECT id, "paymentId", "correlationId", "updatedAt"::text AS "updatedAtText" FROM payment_request
        WHERE status = 'requested' AND "paymentId" IS NOT NULL AND "updatedAt" < now() - make_interval(secs => $1)
          AND ($3::timestamptz IS NULL OR ("updatedAt", id) > ($3::timestamptz, $4::uuid))
        ORDER BY "updatedAt", id LIMIT $2`,
      [staleRequestedMs / 1000, limit, after?.updatedAt ?? null, after?.id ?? null],
    );
    // Never null: falls back to a deterministic per-request id so reconciliation is always traceable (Stage 5 hardening).
    return rows.map((r) => ({ id: r.id, paymentId: r.paymentId, correlationId: r.correlationId ?? `reconcile:${r.id}`, position: { updatedAt: r.updatedAtText, id: r.id } }));
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
    // Stage 12.4 R2: `snapshot.closedAt` is the SAME authoritative instant a live event's `occurredAt` header would
    // carry for this same settlement fact (Payment sets `closedAt` in the same transaction as the terminal status
    // write, and the outbox row is written in that same transaction too — `now()` is transaction-stable in
    // PostgreSQL) — using it here converges the live-event and reconciliation paths on one Subscription anchor.
    // `closedAt` is structurally always set once `status` is terminal (the only case reachable past the `name`
    // guard above); the `?? new Date()` is a defensive fallback for that theoretically-impossible case only, never
    // the expected path.
    return this.applyPaymentEvent(eventId, facts, ctx, snapshot.closedAt ?? new Date());
  }

  /** Endpoint 15, case 1 (SDD 17.3): a request never sent (still `created`) is cancelled locally — no Payment call, no event. */
  async cancelUnsent(requestId: string, caller: Caller, ctx: TransitionContext): Promise<PaymentRequestRow> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<PaymentRequestRow & { producer: string; payerType: string; payerId: string }>(
        `SELECT pr.*, i.producer, i."payerType", i."payerId", i."organizationId" AS "invoiceOrganizationId" FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" WHERE pr.id = $1 FOR UPDATE OF pr`,
        [requestId],
      );
      const row = rows[0] as (typeof rows)[number] & { invoiceOrganizationId: string | null };
      if (!row || relationTo(row, caller) === null) throw notFound();
      if (row.status !== 'created') throw billingError(409, 'payment_request_in_flight', 'This request has already been sent; it cannot be cancelled locally.');
      const { rows: updated } = await q.query<PaymentRequestRow>(`UPDATE payment_request SET status = 'cancelled' WHERE id = $1 RETURNING *`, [requestId]);
      await recordTransition(q, { entityType: 'payment_request', entityId: requestId, from: 'created', to: 'cancelled', revision: updated[0]!.revision, ctx });
      await this.audit.record(q, 'payment_request.cancelled', { organizationId: row.invoiceOrganizationId, resource: { type: 'payment_request', id: requestId }, changes: { invoice_id: row.invoiceId } }, ctx); // Stage 18.7.2
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
   *
   * `settledAt` (Stage 12.4) anchors any resulting Subscription activation/renewal (`linkSubscription`) — the
   * AUTHORITATIVE settlement instant, never `new Date()` at delivery time (section 21/22): a live event's own
   * `occurredAt` header (immutable across retries/replays, set when Payment recorded the fact, never regenerated on
   * redelivery), or (Stage 12.4 R2) the reconciler's `snapshot.closedAt` (see `applyReconciledSnapshot`) — the same
   * underlying instant Payment recorded, so both paths converge on one anchor for the same settlement fact.
   */
  async applyPaymentEvent(eventId: string, event: PaymentEventFacts, ctx: TransitionContext, settledAt: Date): Promise<EventApplication> {
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
      if (seen.rows[0]) return { outcome: seen.rows[0].outcome as Decision['outcome'], detail: seen.rows[0].detailCode, firstDelivery: false, subscription: null };

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
      if (receipt.rowCount === 0) return { outcome: decision.outcome, detail, firstDelivery: false, subscription: null };

      let subscription: SubscriptionSettlementOutcome = null;
      if (decision.outcome === 'applied' && request && invoice) {
        await this.transitionRequest(q, request, decision.requestTo, ctx);
        if (decision.requestTo === 'cancelled') {
          // Stage 18.7.2 (G2): a requested payment's cancellation completes here, when Payment's event (or the reconciler) confirms it.
          await this.audit.record(q, 'payment_request.cancelled', { organizationId: invoice.organizationId, resource: { type: 'payment_request', id: request.id }, changes: { invoice_id: invoice.id } }, ctx);
        }
        if (decision.invoiceTo === 'paid') {
          // the request is `paid` first: the invoice trigger insists on it (BI-14)
          const updated = await q.query<InvoiceRow>(`UPDATE invoice SET status = 'paid', "paidAt" = now() WHERE id = $1 RETURNING *`, [invoice.id]);
          await recordTransition(q, { entityType: 'invoice', entityId: invoice.id, from: 'open', to: 'paid', revision: updated.rows[0]!.revision, ctx });
          await this.audit.record(q, 'invoice.paid', { organizationId: invoice.organizationId, resource: { type: 'invoice', id: invoice.id } }, ctx); // Stage 18.7.2
          subscription = await this.linkSubscription(q, invoice, settledAt, ctx);
        }
      }
      return { outcome: decision.outcome, detail, firstDelivery: true, subscription };
    });
  }

  /**
   * Stage 12.4: identifies whether the now-paid invoice represents a recurring Subscription obligation and, if so,
   * applies the settlement to it — WITHIN the same transaction as the invoice/payment_request effect (section 15), so
   * the receipt, the financial transition and the Subscription effect commit or roll back as one unit.
   *
   * Classification (section 7/26) reuses the fact Stage 12.2 already requires: a Subscription's price must be
   * `recurring` (its own insert guard). No new "isSubscription" flag is invented. An invoice with anything OTHER than
   * EXACTLY ONE recurring line — zero, or more than one — is NOT treated as a Subscription obligation: never guessed,
   * never defaulted to the first line (section 27). Subscription is organization-scoped only, so an invoice with no
   * `organizationId` at all is likewise not a Subscription obligation, whatever its lines say.
   *
   * An offering that conflicts with the organization's EXISTING subscription (a different product or price — an
   * upgrade/downgrade, deliberately unimplemented, section 24) is reported as `'conflict'`, never silently mutated —
   * and never allowed to roll back the payment itself: the money still genuinely settled regardless of what Billing
   * can or cannot do with the commercial classification.
   */
  private async linkSubscription(q: Queryable, invoice: InvoiceRow, settledAt: Date, ctx: TransitionContext): Promise<SubscriptionSettlementOutcome> {
    if (invoice.organizationId === null) return null;
    const { rows: lines } = await q.query<{ productId: string; priceId: string; interval: string }>(
      `SELECT "productId", "priceId", "interval" FROM invoice_line WHERE "invoiceId" = $1`,
      [invoice.id],
    );
    const recurring = lines.filter((l) => l.interval === 'recurring');
    if (recurring.length !== 1) return null;
    const { productId, priceId } = recurring[0]!;
    try {
      await this.subscriptions.applySuccessfulPayment(q, { organizationId: invoice.organizationId, productId, priceId, settledAt }, ctx);
      return 'settled';
    } catch (e) {
      const response = e instanceof HttpException ? e.getResponse() : null;
      const code = typeof response === 'object' && response !== null ? (response as { code?: string }).code : undefined;
      if (code === 'subscription_conflict') return 'conflict';
      throw e;
    }
  }

  private async transitionRequest(q: Queryable, request: PaymentRequestRow, to: string, ctx: TransitionContext): Promise<void> {
    const { rows } = await q.query<PaymentRequestRow>(`UPDATE payment_request SET status = $2 WHERE id = $1 RETURNING *`, [request.id, to]);
    await recordTransition(q, { entityType: 'payment_request', entityId: request.id, from: request.status, to, revision: rows[0]!.revision, ctx });
  }
}
