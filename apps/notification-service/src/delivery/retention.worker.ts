import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure } from '@nawara/service-kit';
import { NOTIFICATION_CONFIG } from '../config/notification-config.token.js';
import type { NotificationConfig } from '../config/notification-config.js';

/** At most this many batches per pass, so one pass stays short even after a long outage. */
const MAX_BATCHES_PER_PASS = 20;

/**
 * Retention of TECHNICAL state (Stage 16.9, D10). The only class whose rule is frozen (SDD §17: "expired windows are safe to delete")
 * is the rate-limiter state: a `kit_rate_limit` row whose fixed window has ended carries no information the next hit needs (the hit
 * resets it). Rows are deleted per known bucket and its own window, in bounded batches, `FOR UPDATE SKIP LOCKED` (a row a limiter hit
 * is updating is simply left for the next pass). Buckets this service does not own are never touched. Notification history
 * (intents, deliveries, attempts) is NOT deleted: its retention is an owner / legal decision (D10), and the sealed secrets already have
 * their own purge (SecretPurgeWorker).
 */
@Injectable()
export class RetentionWorker implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly log = new Logger('NotificationRetention');
  private readonly loop: PollLoop;
  private stopping?: Promise<unknown>;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {
    this.loop = new PollLoop(
      () => this.cleanOnce(),
      (e) => this.log.error(`notification_retention_pass_failure ${describeFailure(e)} — the next pass retries`),
      (ms) => this.log.warn(`worker_drain_timeout worker=notification_retention drainTimeoutMs=${ms}`),
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start(this.config.retention.intervalMs);
  }

  onModuleDestroy(): void {
    this.stopping ??= this.loop.stop(5_000);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await (this.stopping ??= this.loop.stop(5_000));
  }

  stopPolling(): Promise<unknown> {
    return this.loop.stop(5_000);
  }

  /** The window of each bucket this service writes (seconds). */
  private windows(): Array<[string, number]> {
    return [['notif_api_caller', 60], ['notif_caller_template', 60], ['notif_dest', this.config.delivery.destinationLimit?.windowSec ?? 86_400]];
  }

  /** One bounded batch; returns the rows deleted. */
  async deleteExpiredWindows(): Promise<number> {
    const w = this.windows();
    // A MATERIALIZED CTE on the primary key: the batch is chosen once. (`WHERE ctid IN (SELECT … LIMIT … SKIP LOCKED)` may re-run the
    // subquery and delete more than the batch: found by the retention test.)
    const { rowCount } = await this.db.query(
      `WITH doomed AS MATERIALIZED (
         SELECT r.bucket, r.key FROM kit_rate_limit r JOIN unnest($1::text[], $2::int[]) AS b(bucket, secs) ON b.bucket = r.bucket
          WHERE r."windowStart" <= now() - make_interval(secs => b.secs)
          LIMIT $3 FOR UPDATE OF r SKIP LOCKED)
       DELETE FROM kit_rate_limit k USING doomed WHERE k.bucket = doomed.bucket AND k.key = doomed.key`,
      [w.map((x) => x[0]), w.map((x) => x[1]), this.config.retention.batchSize],
    );
    return rowCount ?? 0;
  }

  async cleanOnce(): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES_PER_PASS; i++) {
      const n = await this.deleteExpiredWindows();
      total += n;
      if (n < this.config.retention.batchSize) break;
    }
    if (total > 0) this.log.log(`notification_retention_cleaned table=kit_rate_limit rows=${total}`);
    return total;
  }
}
