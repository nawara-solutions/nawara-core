import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure } from '@nawara/service-kit';
import { NOTIFICATION_CONFIG } from '../config/notification-config.token.js';
import type { NotificationConfig } from '../config/notification-config.js';

/**
 * The `SecretPurge` loop (SDD §12.1; Stage 16.7). A sealed secret (a one-time code) is kept only while it may still be sent: once every
 * delivery of its notification is terminal, or once `expiresAt` has passed, `secretCiphertext` and `secretKeyId` become NULL. It runs
 * whether or not a provider is configured, so a code never outlives its expiry at rest. The delivery engine also purges in the
 * transaction that makes the last delivery terminal; this loop catches everything else (expiry while PENDING, a crash between the two).
 *
 * Bounded: one batch per pass, `FOR UPDATE SKIP LOCKED` (competing instances split the work), oldest expiry first. It logs a count only.
 */
@Injectable()
export class SecretPurgeWorker implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly log = new Logger('SecretPurgeWorker');
  private readonly loop: PollLoop;
  private stopping?: Promise<unknown>;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {
    this.loop = new PollLoop(
      () => this.purgeOnce(),
      (e) => this.log.error(`notification_secret_purge_pass_failure ${describeFailure(e)} — the next pass retries`),
      (ms) => this.log.warn(`worker_drain_timeout worker=notification_secret_purge drainTimeoutMs=${ms}`),
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start(this.config.delivery.intervalMs);
  }

  get running(): boolean {
    return this.loop.running;
  }

  onModuleDestroy(): void {
    this.stopping ??= this.loop.stop(this.config.delivery.drainTimeoutMs);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await (this.stopping ??= this.loop.stop(this.config.delivery.drainTimeoutMs));
  }

  /** Stops the poll loop only (tests drive `purgeOnce` themselves). */
  stopPolling(): Promise<unknown> {
    return this.loop.stop(this.config.delivery.drainTimeoutMs);
  }

  /** One batch; returns how many secrets were purged. */
  async purgeOnce(): Promise<number> {
    const { rowCount } = await this.db.query(
      `WITH due AS MATERIALIZED (
          SELECT n.id FROM notification n
           WHERE n."secretCiphertext" IS NOT NULL
             AND (n."expiresAt" <= now()
                  OR NOT EXISTS (SELECT 1 FROM notification_delivery d WHERE d."notificationId" = n.id AND d.status IN ('PENDING', 'SENDING')))
           ORDER BY n."expiresAt" NULLS LAST, n.id LIMIT $1 FOR UPDATE SKIP LOCKED)
       UPDATE notification SET "secretCiphertext" = NULL, "secretKeyId" = NULL FROM due WHERE notification.id = due.id`,
      [this.config.delivery.batchSize],
    );
    const purged = rowCount ?? 0;
    if (purged > 0) this.log.log(`notification_secret_purged count=${purged}`);
    return purged;
  }
}
