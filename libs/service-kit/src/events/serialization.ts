import type { Options } from 'amqplib';
import type { EventEnvelope } from './types.js';

/**
 * Core V2 S1c-3 R1 (ADR-0057 §13.7 "S0-C4", serialization pipeline version 1): the ONE path from an outbox row to the bytes and properties
 * of the message on the broker. The relay (`OutboxRelay`) and the bus (`RabbitMqEventBus.publish`) build every ordinary publication through
 * these two functions, and an authorized re-emission builds its message through the same two, never through a separately maintained
 * serializer. Pipeline version 1 is:
 *
 *   business payload → `OutboxService.enqueue` stores `JSON.stringify(payload)` as PostgreSQL `jsonb` (PostgreSQL normalizes it: key order,
 *   duplicate keys, whitespace, numbers) → the relay reads the row and node-postgres parses the `jsonb` text with `JSON.parse` →
 *   `outboxEnvelope` → `eventMessage` → the body is exactly `JSON.stringify(envelope.payload)`.
 *
 * So the body is NOT the application object's serialization: it is the serialization of what PostgreSQL returns. A row published by
 * version 1 is reproduced byte for byte by these functions over the same stored row, because the row is immutable once written (the
 * `outbox_immutable` trigger). The exact-byte fixtures in `test/serialization-pipeline.spec.ts` and `test/reemission.int-spec.ts` pin the
 * pipeline: a change to what these functions produce for the same row is a NEW pipeline version, with its own reviewed compatibility
 * decision, never an edit under version 1.
 */
export const SERIALIZATION_PIPELINE_VERSION = 1;

/** The outbox columns the envelope is built from (all immutable once the row is written). */
export interface OutboxEnvelopeRow {
  id: string;
  name: string;
  /** As node-postgres returns the `jsonb` column: the result of `JSON.parse` of PostgreSQL's text form. */
  payload: Record<string, unknown>;
  correlationId: string | null;
  eventVersion: number;
  occurredAt: Date;
}

/** Pipeline v1: the envelope the relay publishes for an outbox row. `source` is the producing service (its own configuration). */
export function outboxEnvelope(row: OutboxEnvelopeRow, source: string): EventEnvelope {
  return {
    id: row.id,
    name: row.name,
    payload: row.payload,
    headers: { eventId: row.id, occurredAt: row.occurredAt.toISOString(), correlationId: row.correlationId ?? undefined, source, version: row.eventVersion },
  };
}

/** What one publication puts on the broker, apart from the exchange (the bus's own) and `mandatory` (never set by the ordinary path). */
export interface EventMessage {
  routingKey: string;
  content: Buffer;
  options: Options.Publish;
}

/**
 * Pipeline v1: the routing key, body bytes and AMQP properties of an envelope's publication. `userId` is the bus's own broker user
 * (ADR-0057 §13.1), never a value taken from the envelope.
 */
export function eventMessage(event: EventEnvelope, userId: string): EventMessage {
  return {
    routingKey: event.name,
    content: Buffer.from(JSON.stringify(event.payload)),
    options: {
      persistent: true,
      contentType: 'application/json',
      messageId: event.id,
      type: event.name,
      userId,
      timestamp: Math.floor(new Date(event.headers.occurredAt).getTime() / 1000),
      headers: { ...event.headers },
    },
  };
}
