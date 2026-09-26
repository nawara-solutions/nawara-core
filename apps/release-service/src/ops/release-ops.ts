import { Global, Inject, Injectable, Logger, Module, type DynamicModule, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DbService, describeFailure } from '@nawara/service-kit';
import type { ReleaseConfig } from '../config/release-config.js';
import { RELEASE_CONFIG } from '../config/release-config.token.js';
import { ReleaseCounters } from './release-counters.js';

export const OPS_SNAPSHOT_INTERVAL_MS = 60_000;

export interface OutboxBacklog {
  pending: number;
  oldestPendingSeconds: number;
  retrying: number;
  maxAttempts: number;
}

/**
 * Stage 20.6: the operational snapshot of release-service, every 60 s and once at shutdown, as bounded log lines:
 * - `release_automation_snapshot` / `release_admin_snapshot`: operation × outcome counts (closed labels only);
 * - `release_outbox_snapshot`: the audit backlog (pending rows, the oldest pending age, how many are being retried, the highest attempt
 *   count) read from the service's OWN outbox (the query `nawara-check-outbox-lag` runs; the partial unpublished index serves it). It never
 *   touches a payload, never deletes or republishes, and never calls audit-service or the broker. A failed read is one warning line.
 * Plus one startup line naming which surfaces are enabled and their bounds (never an address, key or credential).
 */
@Injectable()
export class ReleaseOpsReporter implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('ReleaseOps');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(ReleaseCounters) private readonly counters: ReleaseCounters,
    @Inject(DbService) private readonly db: DbService,
    @Inject(RELEASE_CONFIG) private readonly config: ReleaseConfig,
  ) {}

  onApplicationBootstrap(): void {
    const c = this.config;
    this.log.log(`release_surfaces automation_callers=${new Set(c.serviceTokens.map((t) => t.caller)).size} owner_admin=${c.ownerAdmin ? `enabled auth_timeout_ms=${c.ownerAdmin.authTimeoutMs}` : 'disabled'} compatibility_max_age_s=${c.compatibility.maxAgeS} compatibility_rate_per_client=${c.compatibility.ratePerClient} trust_proxy=${c.trustProxy} cors_origins=${c.corsOrigins.length}`);
    this.timer = setInterval(() => void this.snapshot(), OPS_SNAPSHOT_INTERVAL_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.counterLines(); // the counts only: the database may already be closing
  }

  counterLines(): void {
    const line = (name: string, cells: Array<[string, number]>) => this.log.log(`${name} ${cells.map(([k, v]) => `${k}=${v}`).join(' ')}`);
    line('release_automation_snapshot', this.counters.automation.drain());
    line('release_admin_snapshot', this.counters.admin.drain());
  }

  async backlog(): Promise<OutboxBacklog> {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS pending, COALESCE(EXTRACT(EPOCH FROM (now() - min("occurredAt")))::int, 0) AS oldest,
              (count(*) FILTER (WHERE attempts > 0))::int AS retrying, COALESCE(max(attempts), 0)::int AS max_attempts
         FROM outbox WHERE "publishedAt" IS NULL`,
    );
    const r = rows[0] as { pending: number; oldest: number; retrying: number; max_attempts: number };
    return { pending: r.pending, oldestPendingSeconds: r.oldest, retrying: r.retrying, maxAttempts: r.max_attempts };
  }

  /** One pass; never overlaps itself (a slow database skips a tick instead of stacking queries). */
  async snapshot(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.counterLines();
      const b = await this.backlog();
      this.log.log(`release_outbox_snapshot pending=${b.pending} oldest_pending_s=${b.oldestPendingSeconds} retrying=${b.retrying} max_attempts=${b.maxAttempts}`);
    } catch (e) {
      this.log.warn(`release_outbox_snapshot_failed ${describeFailure(e)}`);
    } finally {
      this.running = false;
    }
  }
}

/** Global: the automation and admin paths count into the same process-local counters (one set per application). */
@Global()
@Module({})
export class ReleaseOpsModule {
  static forRoot(): DynamicModule {
    return { module: ReleaseOpsModule, providers: [{ provide: ReleaseCounters, useValue: new ReleaseCounters() }, ReleaseOpsReporter], exports: [ReleaseCounters, ReleaseOpsReporter] };
  }
}
