import type { ProvenanceOptions } from './provenance.js';

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
  /**
   * Stage 18.8 (optional; RabbitMQ implementation): what the DEAD-LETTER copy of a failed delivery may keep. Without it the copy is the
   * original message, body and headers, plus the kit annotations (unchanged). With it, the bus asks once per dead-lettering and:
   * - `original`: keeps the body byte-for-byte (so it stays replayable) but ONLY the headers returned here, plus the annotations;
   * - `redacted`: replaces the body with a small kit document (`{"redacted":true,…}`: no byte of the original), keeps only the returned
   *   headers, marks the copy `x-nawara-body-redacted`, and keeps the message id / type only when they are safe tokens.
   * A consumer that must not become a store of what an untrusted publisher sent (audit-service) uses it. If it throws, the copy is
   * redacted with no header (fail closed); if a copy cannot be confirmed, the delivery is requeued rather than left to the broker's own
   * dead-lettering (which would move the untouched original).
   */
  deadLetterPolicy?(input: DeadLetterInput): DeadLetterDecision;
  /**
   * Core V2 S1b (optional; RabbitMQ implementation; ADR-0057 §13.2, §13.3, observe-only): record the provenance of every delivery that
   * arrives through the event exchange in the consumer's own database BEFORE the handler runs. The handler is called only once that record
   * is committed; if it cannot be, the delivery is held for the retry delay and requeued (never retried through `<queue>.retry`, never
   * dead-lettered). Whether the delivery was verified, or differed from what was stored, never changes what the handler is given or
   * whether it runs. Without it the bus behaves exactly as before. The in-memory bus has no broker metadata and ignores it.
   * The record keeps an UNKEYED SHA-256 of every delivered body, permanently: never opt in for a queue that can receive a low-entropy
   * secret (a code-bearing event, ADR-0052 decision 5). `npm run check:repo` allows it only for reviewed services (`EVENT_PROVENANCE_APPROVED_SERVICES`).
   */
  provenance?: ProvenanceOptions;
  /**
   * Core V2 S1b-2 (optional; RabbitMQ implementation; ADR-0057 §13.2 "Audit admission"): a deterministic, side-effect-free check of every
   * delivery (through the event exchange or the default exchange alike) that runs after the kit's envelope checks and BEFORE provenance
   * and the handler, given the parsed envelope and the raw delivered bytes. Anything but `{ admitted: true }` (a refusal, an exception, a
   * promise) is a permanent failure with no handler, no retry and no provenance: the delivery is dead-lettered at once (under
   * `deadLetterPolicy`, if any) with the refusal's reason, or `admission_error`. It must never read a message field as authenticated
   * identity. Without it the bus behaves exactly as before. The in-memory bus has no raw bytes and ignores it.
   */
  admission?(event: EventEnvelope, body: Buffer): EventAdmission;
}

/** What an `admission` check answers: admitted, or refused with a short stable reason code (never payload data). */
export type EventAdmission = { admitted: true } | { admitted: false; reason: string };

/** What a dead-letter policy is told: the parsed envelope (absent when the message was not an event at all) and why it failed. */
export interface DeadLetterInput {
  event: EventEnvelope | undefined;
  failure: 'malformed' | 'permanent' | 'retries_exhausted';
  reason?: string;
  /** Core V2 S1b-2: the raw delivered bytes (the RabbitMQ bus always passes them), so a policy can judge what it would keep. */
  body?: Buffer;
}

export interface DeadLetterDecision {
  body: 'original' | 'redacted';
  /** The only original headers the copy keeps (the kit annotations are added to them). */
  headers: Record<string, string | number>;
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
