import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { getRequestContext } from '../context/request-context.js';
import type { Queryable } from '../db/db.service.js';
import { EVENT_NAME } from './types.js';

export interface NewEvent {
  name: string;
  payload: Record<string, unknown>;
  /** Defaults to a new UUID. Supply one to make the write idempotent for a retried business operation. */
  id?: string;
  version?: number;
  /** Defaults to the current request's correlation id. */
  correlationId?: string;
}

const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Records an event in the outbox. It takes the TRANSACTION's client, so the event exists if and only if the business change
 * commits (no lost event, no phantom event). It never touches the network: a broker outage cannot fail a business operation.
 */
@Injectable()
export class OutboxService {
  async enqueue(q: Queryable, ev: NewEvent): Promise<string> {
    if (!EVENT_NAME.test(ev.name)) throw new Error('event name must be dotted lowercase, for example payment.succeeded');
    if (typeof ev.payload !== 'object' || ev.payload === null || Array.isArray(ev.payload)) throw new Error('event payload must be an object');
    const json = JSON.stringify(ev.payload);
    if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) throw new Error('event payload is too large');
    const id = ev.id ?? randomUUID();
    const correlationId = ev.correlationId ?? getRequestContext()?.correlationId ?? null;
    await q.query(
      `INSERT INTO outbox(id, name, payload, "correlationId", "eventVersion") VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [id, ev.name, json, correlationId, ev.version ?? 1],
    );
    return id;
  }
}
