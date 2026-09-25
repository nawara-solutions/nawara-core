import { Inject, Injectable, Logger, Module, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { DbService, PollLoop, describeFailure } from '@nawara/service-kit';
import type { FileConfig } from '../config/file-config.js';
import { FILE_CONFIG } from '../config/file-config.token.js';
import { FILE_LIMITER_BUCKETS, USAGE_WINDOW_SECONDS } from '../limits/usage-limiter.js';
import { OPS_COUNTERS_TOKEN, type OpsCounters } from './ops-counters.js';

export interface FileOpsSnapshot {
  uploading: number;
  staleUploads: number;
  deleting: number;
  deletingDue: number;
  oldestDeletingAgeSec: number;
  deleteRetrying: number;
  maxDeleteAttempts: number;
  temporaryExpired: number;
  limiterRows: number;
  limiterExpired: number;
  /** Retrying deletions per last error code (a bounded storage code, `interrupted`): the persistent-failure view. */
  deleteErrors: Record<string, number>;
}

/**
 * The operational snapshot (Stage 17.9, F27, SDD §15), the Notification 16.9 pattern: Core has no metrics platform, so every
 * FILE_OPS_REPORT_INTERVAL_MS the service writes three kinds of structured lines, counts and bounded codes only:
 *
 *   file_ops_snapshot   — durable backlog from the database (partial indexes only) + live gauges (in-flight, database pool);
 *   file_ops_counters   — what happened during the interval (overload 503s, 429s, invalid tickets, integrity incidents, deadlines);
 *   file_storage_ops    — one line per storage operation and outcome seen during the interval: count, mean and max duration.
 *
 * Never a file id, organization, caller, ticket, key, bucket, endpoint, name or address: a label can only come from a closed set.
 */
@Injectable()
export class FileOpsReporter implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly log = new Logger('FileOps');
  private readonly loop: PollLoop;
  private last = performance.now();

  constructor(
    @Inject(FILE_CONFIG) private readonly config: FileConfig,
    private readonly db: DbService,
    @Inject(OPS_COUNTERS_TOKEN) private readonly counters: OpsCounters,
  ) {
    this.loop = new PollLoop(
      () => this.report(),
      (e) => this.log.error(`file_ops_snapshot_pass_failure ${describeFailure(e)} — the next pass retries`),
      (ms) => this.log.warn(`worker_drain_timeout worker=file_ops drainTimeoutMs=${ms}`),
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start(this.config.ops.reportIntervalMs);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop(this.config.httpDrainTimeoutMs);
  }

  /** The durable backlog (also the tests' entry point). */
  async snapshot(): Promise<FileOpsSnapshot> {
    const { rows } = await this.db.query<Omit<FileOpsSnapshot, 'deleteErrors'> & { deleteErrors: Record<string, number> | null }>(
      `SELECT
         (SELECT count(*) FROM file WHERE status = 'UPLOADING')::int AS uploading,
         (SELECT count(*) FROM file WHERE status = 'UPLOADING' AND "uploadExpiresAt" <= now())::int AS "staleUploads",
         (SELECT count(*) FROM file WHERE status = 'DELETING')::int AS deleting,
         (SELECT count(*) FROM file WHERE status = 'DELETING' AND "deleteNextAttemptAt" <= now())::int AS "deletingDue",
         COALESCE((SELECT floor(extract(epoch FROM now() - min("deletionRequestedAt"))) FROM file WHERE status = 'DELETING'), 0)::int AS "oldestDeletingAgeSec",
         (SELECT count(*) FROM file WHERE status = 'DELETING' AND "deleteLastError" IS NOT NULL)::int AS "deleteRetrying",
         COALESCE((SELECT max("deleteAttempts") FROM file WHERE status = 'DELETING'), 0)::int AS "maxDeleteAttempts",
         (SELECT count(*) FROM file WHERE status = 'AVAILABLE' AND "attachedAt" IS NULL AND "attachDeadline" <= now())::int AS "temporaryExpired",
         (SELECT count(*) FROM kit_rate_limit WHERE bucket = ANY($1::text[]))::int AS "limiterRows",
         (SELECT count(*) FROM kit_rate_limit WHERE bucket = ANY($1::text[]) AND "windowStart" <= now() - make_interval(secs => $2))::int AS "limiterExpired",
         (SELECT jsonb_object_agg(code, n) FROM (SELECT "deleteLastError" AS code, count(*)::int AS n FROM file
            WHERE status = 'DELETING' AND "deleteLastError" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8) e) AS "deleteErrors"`,
      [FILE_LIMITER_BUCKETS, USAGE_WINDOW_SECONDS],
    );
    const r = rows[0]!;
    return { ...r, deleteErrors: r.deleteErrors ?? {} };
  }

  async report(): Promise<FileOpsSnapshot> {
    const s = await this.snapshot();
    const g = this.counters.gauges();
    const pool = this.db.poolStats();
    const errors = Object.entries(s.deleteErrors).map(([k, v]) => `${k}:${v}`).join(',') || 'none';
    this.log.log(
      `file_ops_snapshot uploading=${s.uploading} stale_uploads=${s.staleUploads} deleting=${s.deleting} deleting_due=${s.deletingDue}`
      + ` oldest_deleting_age_s=${s.oldestDeletingAgeSec} delete_retrying=${s.deleteRetrying} max_delete_attempts=${s.maxDeleteAttempts}`
      + ` delete_errors=${errors} temporary_expired=${s.temporaryExpired} limiter_rows=${s.limiterRows} limiter_expired=${s.limiterExpired}`
      + ` uploads_in_flight=${g.uploadsInFlight}/${this.config.limits.uploadMaxInFlight} downloads_in_flight=${g.downloadsInFlight}/${this.config.limits.downloadMaxInFlight}`
      + ` db_pool_total=${pool.total} db_pool_idle=${pool.idle} db_pool_waiting=${pool.waiting}`,
    );
    const now = performance.now();
    const windowS = Math.round((now - this.last) / 1000);
    this.last = now;
    const { counts, storage } = this.counters.drain();
    this.log.log(`file_ops_counters window_s=${windowS} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    for (const [key, st] of storage) {
      const [op, outcome] = key.split('.');
      const line = `file_storage_ops window_s=${windowS} provider=${this.config.storage.provider} op=${op} outcome=${outcome} count=${st.count} mean_ms=${Math.round(st.sumMs / st.count)} max_ms=${st.maxMs}`;
      if (outcome === 'ok' || outcome === 'aborted' || outcome === 'storage_not_found') this.log.log(line);
      else this.log.warn(line);
    }
    if (counts.integrity_digest_mismatch + counts.integrity_size_mismatch + counts.integrity_object_missing > 0) {
      // One aggregate alarm per interval on top of the per-file `file_storage_inconsistent` warnings: an integrity incident.
      this.log.error(`file_integrity_incident window_s=${windowS} digest_mismatch=${counts.integrity_digest_mismatch} size_mismatch=${counts.integrity_size_mismatch} object_missing=${counts.integrity_object_missing}`);
    }
    return s;
  }
}

@Module({ providers: [FileOpsReporter], exports: [FileOpsReporter] })
export class OpsModule {}
