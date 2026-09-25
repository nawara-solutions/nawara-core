import { randomUUID } from 'node:crypto';
import { getRequestContext, type NewEvent } from '@nawara/service-kit';
import { deterministicEventId } from './deterministic-id.js';
import type { PaymentRow } from '../payments/payment.types.js';

/** Who caused a state change (SDD section 11: `actor{type,id}`). */
export interface EventActor {
  type: 'user' | 'service' | 'provider' | 'system';
  id: string | null;
}

/** What caused it (SDD section 11: `cause{type,id}`): the request, webhook event, sweep or resolver run. */
export interface EventCause {
  type: 'request' | 'webhook_event' | 'expiry_sweep' | 'attempt_resolver';
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
export function jobContext(cause: 'expiry_sweep' | 'attempt_resolver'): EventContext {
  const runId = randomUUID();
  return { actor: { type: 'system', id: null }, cause: { type: cause, id: runId }, correlationId: runId };
}

/** Context for processing one verified provider webhook: the provider is the actor, the stored event the cause. */
export function webhookContext(providerId: string, webhookEventId: string): EventContext {
  return { actor: { type: 'provider', id: providerId }, cause: { type: 'webhook_event', id: webhookEventId }, correlationId: webhookEventId };
}

export type PaymentEventName = 'payment.created' | 'payment.succeeded' | 'payment.failed' | 'payment.cancelled' | 'payment.expired';

/**
 * Builds a payment event exactly as SDD section 11 defines it: the common payload (opaque ids and plain facts, never a
 * secret or provider data) plus the event's extra fields. The id is derived from (payment, event name) so a retried
 * transition can never enqueue a second event. `payment` must be the row AFTER the transition (`RETURNING *`) so `status`
 * and `revision` describe the state the event announces.
 */
export function paymentEvent(name: PaymentEventName, payment: PaymentRow, ctx: EventContext, extra: Record<string, unknown> = {}): NewEvent {
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
      // Placed AFTER `...extra` so nothing an event-specific caller passes can ever override Payment's own authoritative
      // producer (Billing SDD R-6): additional isolation evidence, never a replacement for full snapshot validation.
      producer: payment.producer,
    },
  };
}
