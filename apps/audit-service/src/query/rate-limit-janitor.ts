import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { DbService, PollLoop, describeFailure } from '@nawara/service-kit';
import { QUERY_LIMITER_BUCKETS, QUERY_WINDOW_SECONDS } from './query.service.js';

/** How often expired limiter windows are purged, and how many rows one statement removes (bounded work; a pass drains in batches). */
export const JANITOR_INTERVAL_MS = 60_000;
export const JANITOR_BATCH = 500;
const MAX_BATCHES_PER_PASS = 20;

/**
 * Stage 18.8 (18.6 finding F3): retention of the query limiter's state. The organization-pair bucket is keyed per (caller, organization),
 * so without a purge `kit_rate_limit` grows with every organization a caller ever reads. A row whose window has ENDED carries nothing the
 * next hit needs (`hit` resets it to 1), so deleting it can never grant an extra request: the File / Notification rule, applied to this
 * service's own buckets only, in bounded batches, `SKIP LOCKED` (a row being hit right now is left for the next pass). Keys are sha256
 * digests (the kit hashes them): no caller or organization id is stored or logged here.
 */
@Injectable()
export class RateLimitJanitor implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly log = new Logger('AuditQuery');
  private readonly loop = new PollLoop(
    () => this.pass(),
    (e) => this.log.warn(`audit_limiter_purge_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.log.warn(`worker_drain_timeout worker=audit_limiter_purge drainTimeoutMs=${ms}`),
  );

  constructor(@Inject(DbService) private readonly db: DbService) {}

  onApplicationBootstrap(): void {
    this.loop.start(JANITOR_INTERVAL_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /** One pass: expired windows of the audit buckets, batch after batch, bounded. Returns the rows removed. */
  async pass(): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES_PER_PASS; i++) {
      const n = await this.purgeBatch(JANITOR_BATCH);
      total += n;
      if (n < JANITOR_BATCH) break;
    }
    if (total > 0) this.log.log(`audit_limiter_purged rows=${total}`);
    return total;
  }

  async purgeBatch(limit: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `WITH doomed AS MATERIALIZED (
         SELECT bucket, key FROM kit_rate_limit
          WHERE bucket = ANY($1::text[]) AND "windowStart" <= now() - make_interval(secs => $2)
          LIMIT $3 FOR UPDATE SKIP LOCKED)
       DELETE FROM kit_rate_limit k USING doomed WHERE k.bucket = doomed.bucket AND k.key = doomed.key`,
      [[...QUERY_LIMITER_BUCKETS], QUERY_WINDOW_SECONDS, limit],
    );
    return rowCount ?? 0;
  }
}
