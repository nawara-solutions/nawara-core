import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { AUDIT_CONFIG } from '../config/audit-config.token.js';
import type { AuditConfig } from '../config/audit-config.js';
import { OPS_SNAPSHOT_INTERVAL_MS } from '../ingestion/ingestion.constants.js';
import { QueryCounters } from './query-counters.js';

/** The `audit_query_snapshot` line: every 60 s and once at shutdown. Closed labels only (scope × outcome). */
@Injectable()
export class QueryReporter implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('AuditQuery');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(QueryCounters) private readonly counters: QueryCounters,
    @Inject(AUDIT_CONFIG) private readonly config: AuditConfig,
  ) {}

  onApplicationBootstrap(): void {
    // Stage 19.5: whether the Company owner read (Audit-X) is mounted, and its bounds. Never Auth's address (it may carry a path).
    const access = this.config.ownerAccess;
    this.log.log(access
      ? `audit_owner_access enabled auth_timeout_ms=${access.authTimeoutMs} rate_per_owner=${access.ratePerOwner}`
      : 'audit_owner_access disabled (AUTH_SERVICE_URL not set)');
    this.timer = setInterval(() => this.snapshot(), OPS_SNAPSHOT_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.snapshot();
  }

  snapshot(): void {
    const s = this.counters.drain();
    const counts = Object.entries(s.counts).map(([k, v]) => `${k}=${v}`).join(' ');
    this.log.log(`audit_query_snapshot ${counts} rows=${s.rows} latency_count=${s.latency.count} latency_avg_ms=${s.latency.avgMs} latency_max_ms=${s.latency.maxMs} owner_auth_count=${s.ownerAuthLatency.count} owner_auth_avg_ms=${s.ownerAuthLatency.avgMs} owner_auth_max_ms=${s.ownerAuthLatency.maxMs}`);
  }
}
