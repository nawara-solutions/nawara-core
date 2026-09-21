/** Metadata carried in message HEADERS so the payload keeps the flat shape each service documents. */
export interface EventHeaders {
  eventId: string;
  occurredAt: string;
  correlationId?: string;
  /** The producing service. */
  source: string;
  /** Payload version; a breaking payload change publishes version + 1 under the same event name. */
  version: number;
  /** Set by the consumer side of the bus, never by a producer: how many automatic retries this delivery is already into. Absent on a first delivery. */
  retryCount?: number;
  /** Set by the `nawara-dlq replay` tool, never by a producer: how many times an operator has replayed this message from its dead-letter queue. Absent on a message that was never replayed. */
  replayCount?: number;
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
  /**
   * Resolve = processed (acknowledge). Reject = failed, and never silently dropped: a rejection is retried a bounded number of times
   * (RabbitMQ implementation) and then dead-lettered for an operator to inspect and replay. A rejection with a
   * `PermanentEventFailure` is dead-lettered at once (retrying cannot change the outcome).
   */
  handler(event: EventEnvelope): Promise<void>;
}

/**
 * Thrown by a handler to say "this event can never succeed as it stands" (a malformed payload, an identifier that is not a valid id):
 * automatic retry would only repeat the failure, so the bus dead-letters it immediately. Any OTHER error is treated as possibly
 * transient and retried a bounded number of times first. `reason` is a short stable code (lowercase, digits, underscore) that is
 * recorded on the dead-lettered message; it must never carry payload data.
 */
export class PermanentEventFailure extends Error {
  constructor(readonly reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = 'PermanentEventFailure';
  }
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
