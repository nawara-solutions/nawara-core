import { describeFailure, failureFacts, type FailureKind } from '../logging/failure.js';
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

/** V2 A12.3: at most one outbox aggregate per this interval, per instance, and only while an observer is set. */
export const OUTBOX_STATS_MIN_INTERVAL_MS = 15_000;

/** V2 A12.3: the same aggregate `nawara-check-outbox-lag` reads (pending rows, the oldest one's age in whole seconds, rows retrying). */
export const OUTBOX_STATS_SQL = `SELECT count(*)::bigint AS pending, EXTRACT(EPOCH FROM (now() - min("occurredAt")))::int AS oldest_pending_seconds,
              count(*) FILTER (WHERE attempts > 0)::bigint AS retrying
         FROM outbox WHERE "publishedAt" IS NULL`;

/** What the relay reports to its observer (the metrics). Counts and a bounded failure kind only: never an id, name, payload or text. */
export type RelayObservation =
  | { type: 'pass_failure'; kind: FailureKind | undefined }
  | { type: 'stats'; pending: number; retrying: number; oldestPendingSeconds: number; at: number };
export type RelayObserver = (observation: RelayObservation) => void;

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
  private observer?: RelayObserver;
  private lastStatsAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly db: { tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>; query?: Queryable['query'] },
    private readonly bus: EventBus,
    private readonly opts: RelayOptions,
    private readonly onError: (message: string) => void = () => undefined,
  ) {
    // V2 A12.3: a pass is the drain, then (only with an observer, throttled) the outbox aggregate; the drain's result or error is
    // returned unchanged, and the aggregate never throws, so the loop, its error reporting and its timing stay what they were.
    this.loop = new PollLoop(
      async () => {
        try {
          return await this.drainPass();
        } finally {
          await this.refreshStats();
        }
      },
      (e) => {
        this.onError(`outbox_relay_pass_failure ${describeFailure(e)} — the next pass retries`);
        this.observe({ type: 'pass_failure', kind: failureFacts(e).kind });
      },
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

  /**
   * V2 A12.3: one observer (the metrics), set once. It is told about pass failures (after they are reported) and, at most every
   * `OUTBOX_STATS_MIN_INTERVAL_MS`, the outbox aggregate. A throwing observer is ignored.
   */
  setObserver(observer: RelayObserver): void {
    if (this.observer) throw new Error('an outbox relay observer is already set');
    this.observer = observer;
  }

  /**
   * The aggregate, outside the claim transaction, bounded by the pool's statement and query timeouts. Runs only with an observer and
   * at most every `OUTBOX_STATS_MIN_INTERVAL_MS`; any failure is swallowed (the stats timestamp then goes stale). It never claims,
   * publishes, stamps or backs off anything.
   */
  private async refreshStats(): Promise<void> {
    if (!this.observer) return;
    const now = Date.now();
    if (now - this.lastStatsAt < OUTBOX_STATS_MIN_INTERVAL_MS) return;
    this.lastStatsAt = now;
    try {
      type Row = { pending: string; oldest_pending_seconds: number | null; retrying: string };
      const { rows } = this.db.query ? await this.db.query<Row>(OUTBOX_STATS_SQL) : await this.db.tx((q) => q.query<Row>(OUTBOX_STATS_SQL));
      const r = rows[0];
      this.observe({
        type: 'stats',
        pending: Number(r?.pending ?? 0),
        retrying: Number(r?.retrying ?? 0),
        oldestPendingSeconds: Number(r?.oldest_pending_seconds ?? 0),
        at: Date.now() / 1000,
      });
    } catch {
      // A metrics read never affects the relay.
    }
  }

  private observe(observation: RelayObservation): void {
    if (!this.observer) return;
    try {
      this.observer(observation);
    } catch {
      // An observer never changes what the relay does.
    }
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
