import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { OPS_SNAPSHOT_INTERVAL_MS } from '../ingestion/ingestion.constants.js';
import { QueryCounters } from './query-counters.js';

/** The `audit_query_snapshot` line: every 60 s and once at shutdown. Closed labels only (scope × outcome). */
@Injectable()
export class QueryReporter implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('AuditQuery');
  private timer?: NodeJS.Timeout;

  constructor(@Inject(QueryCounters) private readonly counters: QueryCounters) {}

  onApplicationBootstrap(): void {
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
    this.log.log(`audit_query_snapshot ${counts} rows=${s.rows} latency_count=${s.latency.count} latency_avg_ms=${s.latency.avgMs} latency_max_ms=${s.latency.maxMs}`);
  }
}
