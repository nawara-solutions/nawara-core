import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DbService, PollLoop, describeFailure } from '@nawara/service-kit';
import { CompatibilityCounters } from './compatibility-counters.js';

/** The one limiter bucket of the public read, and its window. */
export const COMPATIBILITY_BUCKET = 'release_compatibility';
export const COMPATIBILITY_WINDOW_S = 60;
const SNAPSHOT_INTERVAL_MS = 60_000;
const JANITOR_INTERVAL_MS = 60_000;
const JANITOR_BATCH = 500;
const MAX_BATCHES_PER_PASS = 20;

/** The `release_compatibility_snapshot` line: every 60 s and once at shutdown. Closed labels only. */
@Injectable()
export class CompatibilityReporter implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('ReleaseCompatibility');
  private timer?: NodeJS.Timeout;

  constructor(@Inject(CompatibilityCounters) private readonly counters: CompatibilityCounters) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.snapshot(), SNAPSHOT_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.snapshot();
  }

  snapshot(): void {
    const s = this.counters.drain();
    const counts = Object.entries(s.counts).map(([k, v]) => `${k}=${v}`).join(' ');
    this.log.log(`release_compatibility_snapshot ${counts} latency_count=${s.latency.count} latency_avg_ms=${s.latency.avgMs} latency_max_ms=${s.latency.maxMs}`);
  }
}

/**
 * Retention of the public limiter's state (the Audit 18.8 janitor, for this bucket only): a row whose window has ENDED carries nothing the
 * next hit needs (`hit` resets it to 1), so deleting it never grants an extra request, and no history of client addresses accumulates.
 * Keys are digests of HMAC-keyed addresses; nothing is logged but a row count. Bounded batches, `SKIP LOCKED`.
 */
@Injectable()
export class CompatibilityLimiterJanitor implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly log = new Logger('ReleaseCompatibility');
  private readonly loop = new PollLoop(
    () => this.pass(),
    (e) => this.log.warn(`release_limiter_purge_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.log.warn(`worker_drain_timeout worker=release_limiter_purge drainTimeoutMs=${ms}`),
  );

  constructor(@Inject(DbService) private readonly db: DbService) {}

  onApplicationBootstrap(): void {
    this.loop.start(JANITOR_INTERVAL_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  async pass(): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES_PER_PASS; i++) {
      const { rowCount } = await this.db.query(
        `WITH doomed AS MATERIALIZED (
           SELECT bucket, key FROM kit_rate_limit WHERE bucket = $1 AND "windowStart" <= now() - make_interval(secs => $2) LIMIT $3 FOR UPDATE SKIP LOCKED)
         DELETE FROM kit_rate_limit k USING doomed WHERE k.bucket = doomed.bucket AND k.key = doomed.key`,
        [COMPATIBILITY_BUCKET, COMPATIBILITY_WINDOW_S, JANITOR_BATCH],
      );
      const n = rowCount ?? 0;
      total += n;
      if (n < JANITOR_BATCH) break;
    }
    if (total > 0) this.log.log(`release_limiter_purged rows=${total}`);
    return total;
  }
}
