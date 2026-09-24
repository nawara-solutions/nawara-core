import { describeFailure } from '../logging/failure.js';
import { redactString } from '../logging/redact.js';
import { PollLoop, type DrainOutcome } from '../workers/poll-loop.js';
import type { Queryable } from '../db/db.service.js';
import type { EventBus, EventEnvelope } from './types.js';

/**
 * Stage 15.8: the ceiling of one row's publish backoff (was 60 s). After a broker outage a row waits out its backoff even though the
 * broker is back, so the ceiling IS the worst delivery delay after recovery (measured: 57.6 s with 60 s, 15.3 s with 15 s, for a
 * 200-event backlog). It costs almost nothing during an outage: a poll stops at its first failure, so failures stay at one per poll
 * (60 per minute) with a large backlog, and a single waiting event is retried 6 instead of 4.7 times a minute.
 */
export const DEFAULT_MAX_BACKOFF_MS = 15_000;

export interface RelayOptions {
  /** Producing service name, stamped into the event headers. */
  source: string;
  batchSize?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Stage 15.8: how long one poll may keep relaying full batches back to back (default 1000 ms). */
  maxPassMs?: number;
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
      () => this.drainPass(),
      (e) => this.onError(`outbox_relay_pass_failure ${describeFailure(e)} — the next pass retries`),
      (ms) => this.onError(`worker_drain_timeout worker=outbox_relay drainTimeoutMs=${ms} — shutdown proceeds; the batch's rows stay unpublished and are relayed again (at least once)`),
    );
  }

  /**
   * Stage 15.8: one poll = batches back to back while they come back FULL (a backlog), for at most `maxPassMs`, then the normal interval.
   * One batch per poll capped a relay at `batchSize` events per interval (about 46 events/s with the defaults), below the rate one Billing
   * instance can create invoices, so a busy period left a growing backlog. Each batch is still its own short transaction (claim, publish
   * with confirms, stamp); the pass stops at the first failure (a broker outage keeps its one-failure-per-poll pace) and when a batch is
   * not full (nothing more is due), and it never runs past `maxPassMs`, which keeps a pass inside the shutdown drain budget.
   */
  async drainPass(): Promise<{ published: number; failed: number; batches: number }> {
    const batch = this.opts.batchSize ?? 50;
    const maxPassMs = this.opts.maxPassMs ?? 1000;
    const started = Date.now();
    let published = 0;
    let batches = 0;
    for (;;) {
      const r = await this.drainOnce();
      batches++;
      published += r.published;
      if (r.failed > 0) return { published, failed: r.failed, batches };
      if (r.published < batch || Date.now() - started >= maxPassMs || !this.loop.running) return { published, failed: 0, batches };
    }
  }

  async drainOnce(): Promise<{ published: number; failed: number }> {
    const batch = this.opts.batchSize ?? 50;
    const base = this.opts.baseBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
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
