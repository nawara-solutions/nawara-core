import type { Queryable } from '../db/db.service.js';

/** Time source. Injected so session ceilings, expiries and shifts are testable without sleeping. */
export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('CLOCK');
export class SystemClock implements Clock {
  now() {
    return new Date();
  }
}

/**
 * Auth's domain events (Stage 21.C.2, ADR-0052 decision 4): written into Auth's transactional outbox ON THE CALLER'S TRANSACTION `q`, so an
 * event exists if and only if its change commits (no lost event, no phantom event), then published by the one kit relay Auth runs, at least
 * once, and de-duplicated by the consumer on its event id. Nothing is sent to the broker from a request. `AUTH_EVENTS=off` writes no row.
 * Three events carry a one-time code for delivery; their rows are short-lived (deleted once published or expired) and never logged.
 */
export interface DomainEvents {
  emit(q: Queryable, name: string, payload: Record<string, unknown>): Promise<void>;
}
export const DOMAIN_EVENTS = Symbol('DOMAIN_EVENTS');
