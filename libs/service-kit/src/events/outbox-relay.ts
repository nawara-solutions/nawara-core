import { redactString } from '../logging/redact.js';
import type { Queryable } from '../db/db.service.js';
import type { EventBus, EventEnvelope } from './types.js';

export interface RelayOptions {
  /** Producing service name, stamped into the event headers. */
  source: string;
  batchSize?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

interface OutboxRow {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  correlationId: string | null;
  eventVersion: number;
  occurredAt: Date;
  attempts: number;
}

/**
 * Publishes unsent outbox rows to the bus, AT LEAST ONCE. A batch is claimed with FOR UPDATE SKIP LOCKED, so several
 * instances can run without publishing the same row twice concurrently. A failing publish stops the batch, records the error
 * class with exponential backoff, and leaves the remaining rows untouched. A published row is stamped in the same
 * transaction that claimed it; a crash between publish and stamp re-publishes it, which consumers absorb via the inbox.
 */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<unknown>;
  private stopped = true;

  constructor(
    private readonly db: { tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> },
    private readonly bus: EventBus,
    private readonly opts: RelayOptions,
    private readonly onError: (message: string) => void = () => undefined,
  ) {}

  async drainOnce(): Promise<{ published: number; failed: number }> {
    const batch = this.opts.batchSize ?? 50;
    const base = this.opts.baseBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 60_000;
    return this.db.tx(async (q) => {
      const { rows } = await q.query<OutboxRow>(
        `SELECT id, name, payload, "correlationId", "eventVersion", "occurredAt", attempts
           FROM outbox WHERE "publishedAt" IS NULL AND "availableAt" <= now()
          ORDER BY "occurredAt", id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batch],
      );
      let published = 0;
      for (const r of rows) {
        const event: EventEnvelope = {
          id: r.id,
          name: r.name,
          payload: r.payload,
          headers: { eventId: r.id, occurredAt: r.occurredAt.toISOString(), correlationId: r.correlationId ?? undefined, source: this.opts.source, version: r.eventVersion },
        };
        try {
          await this.bus.publish(event);
        } catch (e) {
          const delay = Math.min(max, base * 2 ** Math.min(r.attempts, 20));
          const reason = redactString(e instanceof Error ? `${e.name}: ${e.message}` : 'publish failed').slice(0, 200);
          await q.query(
            `UPDATE outbox SET attempts = attempts + 1, "lastError" = $2, "availableAt" = now() + ($3 || ' milliseconds')::interval WHERE id = $1`,
            [r.id, reason, String(delay)],
          );
          this.onError(`outbox publish failed for ${r.name}`);
          return { published, failed: 1 };
        }
        await q.query(`UPDATE outbox SET "publishedAt" = now(), attempts = attempts + 1, "lastError" = NULL WHERE id = $1`, [r.id]);
        published++;
      }
      return { published, failed: 0 };
    });
  }

  /** Starts polling. The broker being down only delays delivery; it never affects the business transactions. */
  start(intervalMs = 1000): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      this.inFlight = this.drainOnce()
        .catch((e) => this.onError(`outbox relay error: ${e instanceof Error ? e.name : 'unknown'}`))
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, intervalMs);
        });
    };
    tick();
  }

  /** Stops polling and waits for an in-flight batch to finish (graceful shutdown). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }
}
