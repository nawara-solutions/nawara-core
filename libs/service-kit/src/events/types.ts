/** Metadata carried in message HEADERS so the payload keeps the flat shape each service documents. */
export interface EventHeaders {
  eventId: string;
  occurredAt: string;
  correlationId?: string;
  /** The producing service. */
  source: string;
  /** Payload version; a breaking payload change publishes version + 1 under the same event name. */
  version: number;
}

export interface EventEnvelope {
  id: string;
  /** Stable dotted name, also the routing key: `payment.succeeded`. */
  name: string;
  /** Opaque ids and plain facts only: never secrets, tokens or card/bank data. */
  payload: Record<string, unknown>;
  headers: EventHeaders;
}

export interface EventSubscription {
  /** Durable queue owned by the consuming service. */
  queue: string;
  /** Routing-key patterns: `*` matches one word, `#` zero or more. */
  bindings: string[];
  /** Resolve = processed (acknowledge). Reject = failed (dead-lettered, never silently dropped). */
  handler(event: EventEnvelope): Promise<void>;
}

/**
 * Port to the message broker. The kit ships an in-memory implementation (tests, local runs) and a RabbitMQ one.
 * Delivery is AT LEAST ONCE: consumers must tolerate duplicates (see InboxService).
 */
export interface EventBus {
  publish(event: EventEnvelope): Promise<void>;
  subscribe(subscription: EventSubscription): Promise<{ close(): Promise<void> }>;
  close(): Promise<void>;
}

export const EVENT_BUS = Symbol('EVENT_BUS');
export const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
