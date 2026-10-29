import { randomUUID } from 'node:crypto';
import { getRequestContext, type NewEvent } from '@nawara/service-kit';
import { deterministicEventId } from './deterministic-id.js';
import type { PaymentEventName } from './event-catalog.js';
import type { PaymentRow } from '../payments/payment.types.js';

/** Who caused a state change (SDD section 11: `actor{type,id}`). */
export interface EventActor {
  type: 'user' | 'service' | 'provider' | 'system';
  id: string | null;
}

/** What caused it (SDD section 11: `cause{type,id}`): the request, webhook event, sweep or resolver run. */
export interface EventCause {
  type: 'request' | 'webhook_event' | 'expiry_sweep' | 'attempt_resolver' | 'refund_worker'; // Core V2 S6b: the refund worker's runs
  id: string | null;
}

/**
 * Attribution carried by every event a transition enqueues. `correlationId` is optional because a request already has one;
 * system-initiated work (webhook processing, sweeps, the resolver) sets it to the webhook event id or to a fresh id per
 * job run, so no event is ever published without one (SDD section 11).
 */
export interface EventContext {
  actor: EventActor;
  cause: EventCause;
  correlationId?: string;
  /**
   * Stage 18.7: for a USER actor only, the kind Auth verified for it (its admin tier, else member), used by the central audit evidence.
   * Deliberately not part of `actor` (which domain events carry unchanged); never taken from a request value.
   */
  userKind?: 'member' | 'owner' | 'operator';
}

/** Context for work started by an HTTP request: the caller is the actor, the request id the cause. */
export function requestContext(actor: EventActor): EventContext {
  return { actor, cause: { type: 'request', id: getRequestContext()?.requestId ?? null } };
}

/** Context for one run of a background job. The fresh run id doubles as cause id and correlation id. */
export function jobContext(cause: 'expiry_sweep' | 'attempt_resolver' | 'refund_worker'): EventContext {
  const runId = randomUUID();
  return { actor: { type: 'system', id: null }, cause: { type: cause, id: runId }, correlationId: runId };
}

/** Context for processing one verified provider webhook: the provider is the actor, the stored event the cause. */
export function webhookContext(providerId: string, webhookEventId: string): EventContext {
  return { actor: { type: 'provider', id: providerId }, cause: { type: 'webhook_event', id: webhookEventId }, correlationId: webhookEventId };
}

/** V2 A3M.2: the names come from the event catalog (`event-catalog.ts`), the one place the published contract is declared. */
export type { PaymentEventName };

/**
 * Builds a payment event exactly as SDD section 11 defines it: the common payload (opaque ids and plain facts, never a
 * secret or provider data) plus the event's extra fields. The id is derived from (payment, event name) so a retried
 * transition can never enqueue a second event. `payment` must be the row AFTER the transition (`RETURNING *`) so `status`
 * and `revision` describe the state the event announces.
 */
export function paymentEvent(name: Exclude<PaymentEventName, 'refund.case_completed' | 'payment.dispute.opened' | 'payment.dispute.lost'>, payment: PaymentRow, ctx: EventContext, extra: Record<string, unknown> = {}): NewEvent {
  return {
    id: deterministicEventId(payment.id, name),
    name,
    correlationId: ctx.correlationId,
    payload: {
      paymentId: payment.id,
      paymentRequestId: payment.paymentRequestId,
      sourceType: payment.sourceType,
      sourceId: payment.sourceId,
      organizationId: payment.organizationId,
      payer: { type: payment.payerType, id: payment.payerId },
      seller: { type: payment.sellerType, id: payment.sellerId },
      amount: Number(payment.amount), // bigint arrives as a string; the database caps it at Number.MAX_SAFE_INTEGER
      currency: payment.currency,
      status: payment.status,
      revision: payment.revision,
      actor: ctx.actor,
      cause: ctx.cause,
      ...extra,
      // Core V2 S4a (P-1, P-3, P-6; ADR-0057 §5: added OPTIONAL fields keep version 1): present on every payment created since S4a and
      // absent on an earlier one, which is never re-interpreted. After `...extra`, like `producer`: never overridable. Billing compares
      // the purpose with its routing record and, in production, refuses an event that is not live (FC-10).
      ...(payment.purpose !== null ? { purpose: payment.purpose } : {}),
      ...(payment.beneficiaryUserId !== null ? { beneficiaryUserId: payment.beneficiaryUserId } : {}),
      ...(payment.liveMode !== null ? { liveMode: payment.liveMode } : {}),
      // Placed AFTER `...extra` so nothing an event-specific caller passes can ever override Payment's own authoritative
      // producer (Billing SDD R-6): additional isolation evidence, never a replacement for full snapshot validation.
      producer: payment.producer,
    },
  };
}

/** The authorization fields `refund.case_completed` carries (a `refund_authorization` row after completion). */
export interface CompletedRefundAuthorization {
  id: string;
  refundCaseId: string;
  refundAttemptId: string;
  paymentId: string;
  approvedAmount: string | number;
  currency: string;
  completedAt: Date;
}

/**
 * Core V2 S6c (register EVT-02; S0 FC-3; the Owner's R6C-8): the refund case's financial completion, version 1. The id is derived from the
 * authorization (completed once, by FC-3), so a retried completion transaction can never enqueue a second event. Identifiers and the
 * approved amount only; `liveMode` is false (simulation only); `producer`, `paymentRequestId`, `organizationId` and `purpose` are the
 * payment row's own.
 */
export function refundCaseCompletedEvent(z: CompletedRefundAuthorization, payment: PaymentRow, ctx: EventContext): NewEvent {
  return {
    id: deterministicEventId(z.id, 'refund.case_completed'),
    name: 'refund.case_completed',
    correlationId: ctx.correlationId,
    payload: {
      refundCaseId: z.refundCaseId,
      refundAuthorizationId: z.id,
      refundAttemptId: z.refundAttemptId,
      paymentId: z.paymentId,
      paymentRequestId: payment.paymentRequestId,
      producer: payment.producer,
      approvedAmount: Number(z.approvedAmount),
      currency: z.currency.trim(),
      completedAt: new Date(z.completedAt).toISOString(),
      liveMode: false,
      organizationId: payment.organizationId,
      purpose: payment.purpose,
    },
  };
}

/** The dispute fields the dispute events carry (a `payment_dispute` row) and, for a loss, its verified chargeback fact. */
export interface DisputeEventSource {
  id: string;
  paymentId: string;
  amount: string | number;
  currency: string;
  reason: string | null;
  recordedAt: Date;
  closedAt: Date | null;
}

/**
 * Core V2 S6e-D (register EVT-03; the Owner's R6E-6): a verified provider dispute, version 1. Its id is derived from the dispute, so a retried
 * transaction never enqueues a second event. Identifiers, the provider-stated exposure and its currency only; `liveMode` false.
 */
export function disputeOpenedEvent(d: DisputeEventSource, payment: PaymentRow, ctx: EventContext): NewEvent {
  return {
    id: deterministicEventId(d.id, 'payment.dispute.opened'),
    name: 'payment.dispute.opened',
    correlationId: ctx.correlationId,
    payload: {
      disputeId: d.id, paymentId: d.paymentId, paymentRequestId: payment.paymentRequestId, producer: payment.producer, organizationId: payment.organizationId,
      purpose: payment.purpose, amount: Number(d.amount), currency: d.currency.trim(), reason: d.reason, openedAt: new Date(d.recordedAt).toISOString(), liveMode: false,
    },
  };
}

/**
 * Core V2 S6e-D (EVT-03; R6E-5, R6E-6): the provider's final loss, version 1, once per dispute. `chargeback` is the verified chargeback fact
 * linked to the dispute in the same transaction, or null when the provider reported none: the event never implies a movement that has no fact.
 */
export function disputeLostEvent(d: DisputeEventSource, payment: PaymentRow, chargeback: { id: string; amount: string | number; currency: string } | null, ctx: EventContext): NewEvent {
  return {
    id: deterministicEventId(d.id, 'payment.dispute.lost'),
    name: 'payment.dispute.lost',
    correlationId: ctx.correlationId,
    payload: {
      disputeId: d.id, paymentId: d.paymentId, paymentRequestId: payment.paymentRequestId, producer: payment.producer, organizationId: payment.organizationId,
      purpose: payment.purpose, amount: Number(d.amount), currency: d.currency.trim(), lostAt: new Date(d.closedAt ?? d.recordedAt).toISOString(),
      chargeback: chargeback ? { factId: chargeback.id, amount: Number(chargeback.amount), currency: chargeback.currency.trim() } : null, liveMode: false,
    },
  };
}
