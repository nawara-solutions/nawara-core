import { getRequestContext } from '@nawara/service-kit';

/** Who did it and what caused it (SDD section 23: `actor{type,id}` and `cause{type,id}`); recorded in the history and carried in events. */
export interface Actor {
  type: 'user' | 'service' | 'system';
  id: string | null;
}

export interface Cause {
  type: 'request' | 'payment_event' | 'sweep' | 'reconciliation' | 'dispatcher';
  id: string | null;
}

/** Attribution for one state change. `correlationId` follows a business operation across services and into event headers. */
export interface TransitionContext {
  actor: Actor;
  cause: Cause;
  correlationId?: string | null;
}

/** Context for work started by an HTTP request: the caller is the actor, the request id the cause. */
export function requestTransitionContext(actor: Actor): TransitionContext {
  const ctx = getRequestContext();
  return { actor, cause: { type: 'request', id: ctx?.requestId ?? null }, correlationId: ctx?.correlationId ?? null };
}

/**
 * Context for one unit of background-job work (dispatcher, reconciler): there is never an ambient request context
 * here (SDD 21.5's dispatcher/reconciler run off `setInterval`, not an HTTP request), so unlike
 * `requestTransitionContext` this never returns a null correlation id — the caller always supplies one, preferring
 * the payment request's own originating correlation id and falling back to a deterministic per-request id.
 * Mirrors payment-service's `jobContext` (`apps/payment-service/src/events/payment-events.ts`).
 */
export function jobTransitionContext(cause: 'sweep' | 'reconciliation' | 'dispatcher', id: string | null, correlationId: string): TransitionContext {
  return { actor: { type: 'system', id: null }, cause: { type: cause, id }, correlationId };
}

/** The caller a service method acts for. Authentication established it; it says WHO, never what they may do. */
export type Caller = { kind: 'service'; service: string } | { kind: 'user'; userId: string };

export function actorOf(caller: Caller): Actor {
  return caller.kind === 'service' ? { type: 'service', id: caller.service } : { type: 'user', id: caller.userId };
}
