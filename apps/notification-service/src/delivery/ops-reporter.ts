import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure } from '@nawara/service-kit';
import { NOTIFICATION_CONFIG } from '../config/notification-config.token.js';
import type { NotificationConfig } from '../config/notification-config.js';
import { secretKeyUsage } from './secret-keys.js';

export interface OpsSnapshot {
  due: number;
  oldestDueAgeSec: number;
  retrying: number;
  scheduled: number;
  sending: number;
  staleLeases: number;
  liveSecrets: number;
  missingSecretKeys: string[];
}

/**
 * The operational snapshot (Stage 16.9). Core has no metrics platform (SDD §16), so the backlog is published as one structured log line
 * every NOTIFICATION_OPS_REPORT_INTERVAL_MS, built from counts over the partial indexes only (no scan of terminal history):
 *
 *   notification_ops_snapshot due=… oldestDueAgeSec=… retrying=… scheduled=… sending=… staleLeases=… liveSecrets=…
 *
 * Counts and ages only: no destination, id or content. A live ciphertext whose key id is missing from NOTIFICATION_SECRET_KEYS is
 * reported as an error (`notification_secret_key_missing`): a key was removed too early and those codes cannot be sent.
 */
@Injectable()
export class OpsReporter implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly log = new Logger('NotificationOps');
  private readonly loop: PollLoop;
  private stopping?: Promise<unknown>;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {
    this.loop = new PollLoop(
      () => this.report(),
      (e) => this.log.error(`notification_ops_snapshot_pass_failure ${describeFailure(e)} — the next pass retries`),
      (ms) => this.log.warn(`worker_drain_timeout worker=notification_ops drainTimeoutMs=${ms}`),
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start(this.config.opsReportIntervalMs);
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

  async snapshot(): Promise<OpsSnapshot> {
    const { rows } = await this.db.query<Omit<OpsSnapshot, 'missingSecretKeys'>>(
      `SELECT
         (SELECT count(*) FROM notification_delivery WHERE status = 'PENDING' AND "nextAttemptAt" <= now())::int AS due,
         COALESCE((SELECT floor(extract(epoch FROM now() - min("nextAttemptAt"))) FROM notification_delivery
                    WHERE status = 'PENDING' AND "nextAttemptAt" <= now()), 0)::int AS "oldestDueAgeSec",
         (SELECT count(*) FROM notification_delivery WHERE status = 'PENDING' AND "nextAttemptAt" <= now() AND attempts > 0)::int AS retrying,
         (SELECT count(*) FROM notification_delivery WHERE status = 'PENDING' AND "nextAttemptAt" > now())::int AS scheduled,
         (SELECT count(*) FROM notification_delivery WHERE status = 'SENDING' AND "leaseUntil" >= now())::int AS sending,
         (SELECT count(*) FROM notification_delivery WHERE status = 'SENDING' AND "leaseUntil" < now())::int AS "staleLeases",
         (SELECT count(*) FROM notification WHERE "secretCiphertext" IS NOT NULL)::int AS "liveSecrets"`,
    );
    const usage = await secretKeyUsage(this.db);
    const missingSecretKeys = usage.filter((u) => !this.config.secretKeys.has(u.keyId)).map((u) => u.keyId);
    return { ...rows[0], missingSecretKeys };
  }

  async report(): Promise<OpsSnapshot> {
    const s = await this.snapshot();
    this.log.log(`notification_ops_snapshot due=${s.due} oldestDueAgeSec=${s.oldestDueAgeSec} retrying=${s.retrying} scheduled=${s.scheduled} sending=${s.sending} staleLeases=${s.staleLeases} liveSecrets=${s.liveSecrets}`);
    for (const keyId of s.missingSecretKeys) this.log.error(`notification_secret_key_missing keyId=${keyId} — live ciphertext references a key absent from NOTIFICATION_SECRET_KEYS`);
    return s;
  }
}
