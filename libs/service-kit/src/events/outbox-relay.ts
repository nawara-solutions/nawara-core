import { describeFailure } from '../logging/failure.js';
import { redactString } from '../logging/redact.js';
import { PollLoop, type DrainOutcome } from '../workers/poll-loop.js';
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
  private readonly loop: PollLoop;

  constructor(
    private readonly db: { tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> },
    private readonly bus: EventBus,
    private readonly opts: RelayOptions,
    private readonly onError: (message: string) => void = () => undefined,
  ) {
    this.loop = new PollLoop(
      () => this.drainOnce(),
      (e) => this.onError(`outbox_relay_pass_failure ${describeFailure(e)} — the next pass retries`),
      (ms) => this.onError(`worker_drain_timeout worker=outbox_relay drainTimeoutMs=${ms} — shutdown proceeds; the batch's rows stay unpublished and are relayed again (at least once)`),
    );
  }

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
          // Stage 14.7: enough to follow ONE event (id, correlation id) and to tell a brief broker blip (attempt 1, seconds old) from an
          // event that has been retrying for a long time (attempts, age). Retries stay unlimited: this only reports them.
          const ageSeconds = Math.max(0, Math.round((Date.now() - r.occurredAt.getTime()) / 1000));
          this.onError(
            `outbox_publish_failure eventId=${r.id} name=${r.name} correlationId=${r.correlationId ?? '-'} attempt=${r.attempts + 1} ageSeconds=${ageSeconds} retryInMs=${delay} ${describeFailure(e)} — the event stays pending and is published again (at least once)`,
          );
          return { published, failed: 1 };
        }
        await q.query(`UPDATE outbox SET "publishedAt" = now(), attempts = attempts + 1, "lastError" = NULL WHERE id = $1`, [r.id]);
        published++;
      }
      return { published, failed: 0 };
    });
  }

  /** Starts polling (first pass right away). The broker being down only delays delivery; it never affects the business transactions. */
  start(intervalMs = 1000): void {
    this.loop.start(intervalMs, 0);
  }

  /**
   * Stops polling and waits, at most `drainTimeoutMs`, for an in-flight batch (graceful shutdown). A batch waiting on the broker is
   * itself bounded by the bus's publisher-confirm timeout, so a timeout here means only that shutdown proceeds; the batch's
   * transaction then ends with the database pool (its rows stay unpublished and are relayed again: at least once).
   */
  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }
}
