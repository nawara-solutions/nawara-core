import { randomUUID } from 'node:crypto';
import type { Channel } from 'amqplib';
import { AUDIT_CATALOG, type AuditAction } from '@nawara/audit-contract';
import { sampleAuditPayload } from '@nawara/audit-contract/testing';
import type { EventEnvelope } from '@nawara/service-kit';
import { AUDIT_EXCHANGE, AUDIT_QUEUE } from '../../src/ingestion/ingestion.constants.js';

export const RETRY_QUEUE = `${AUDIT_QUEUE}.retry`;
export const DEAD_QUEUE = `${AUDIT_QUEUE}.dead`;

/**
 * A kit envelope EXACTLY as a producer's outbox relay emits an audit event (`OutboxRelay.drainOnce`): id = headers.eventId (a new UUID),
 * name `audit.<action>`, the catalog producer as `source`, version 1, the relay's `toISOString()` time. `over` replaces any part.
 */
export function auditEnvelope(
  action: AuditAction,
  over: { id?: string; name?: string; payload?: Record<string, unknown>; headers?: Record<string, unknown>; variant?: 'minimal' | 'complete' } = {},
): EventEnvelope {
  const id = over.id ?? randomUUID();
  return {
    id,
    name: over.name ?? `audit.${action}`,
    payload: over.payload ?? JSON.parse(JSON.stringify(sampleAuditPayload(action, over.variant ?? 'complete'))),
    headers: {
      eventId: id,
      occurredAt: new Date().toISOString(),
      correlationId: `corr-${id.slice(0, 8)}`,
      source: AUDIT_CATALOG.get(action)!.producer,
      version: 1,
      ...over.headers,
    } as EventEnvelope['headers'],
  };
}

/**
 * Publishes arbitrary bytes and properties, as a hostile or broken publisher could (the helper's writer can never produce these). To the
 * exchange with `routingKey`, or straight into the audit work queue (a name the `audit.#` binding would not route).
 */
export async function publishRaw(
  ch: Channel,
  m: { routingKey?: string; toQueue?: boolean; body: Buffer | string; messageId?: string; type?: string; headers?: Record<string, unknown> },
): Promise<void> {
  const content = Buffer.isBuffer(m.body) ? m.body : Buffer.from(m.body);
  const props = { persistent: true, contentType: 'application/json', messageId: m.messageId, type: m.type, headers: m.headers ?? {} };
  if (m.toQueue) ch.sendToQueue(AUDIT_QUEUE, content, props);
  else ch.publish(AUDIT_EXCHANGE, m.routingKey ?? m.type ?? 'audit.unknown', content, props);
}

export interface DeadLetter {
  messageId: unknown;
  type: unknown;
  failure: unknown;
  reason: unknown;
  retryCount: unknown;
  consumer: unknown;
  content: string;
}

/** Removes and returns every message currently in the audit dead-letter queue. */
export async function drainDead(ch: Channel): Promise<DeadLetter[]> {
  const out: DeadLetter[] = [];
  for (;;) {
    const m = await ch.get(DEAD_QUEUE, { noAck: true });
    if (!m) return out;
    const h = m.properties.headers ?? {};
    out.push({
      messageId: m.properties.messageId,
      type: m.properties.type,
      failure: h['x-nawara-failure'],
      reason: h['x-nawara-failure-reason'],
      retryCount: h['x-nawara-retry-count'],
      consumer: h['x-nawara-consumer'],
      content: m.content.toString('utf8'),
    });
  }
}

export async function deleteAuditQueues(ch: Channel): Promise<void> {
  for (const q of [AUDIT_QUEUE, RETRY_QUEUE, DEAD_QUEUE]) await ch.deleteQueue(q).catch(() => undefined);
}

export async function depth(ch: Channel, q: string): Promise<number> {
  return (await ch.checkQueue(q)).messageCount;
}
