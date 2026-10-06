import type { PoolErrorObserver } from '../db/db.service.js';
import { closedSet, growingSet } from './label-policy.js';
import type { BoundedMetrics } from './metrics.js';
import { FAILURE_KINDS } from './outbox-metrics.js';

/** What a database pool offers the metrics: passive counters (no query) and, optionally, its idle-client errors. */
export interface PoolSource {
  poolStats(): { total: number; idle: number; waiting: number };
  readonly poolMax: number;
  setPoolObserver?(observer: PoolErrorObserver): void;
}

export function isPoolSource(value: unknown): value is PoolSource {
  const v = value as Partial<PoolSource> | null | undefined;
  return !!v && typeof v === 'object' && typeof v.poolStats === 'function' && typeof v.poolMax === 'number';
}

/** A pool name, as code names it (`main`); at most 8 per process. */
const POOL = /^[a-z][a-z0-9_]{0,30}$/;
const MAX_POOLS = 8;

/**
 * V2 A12.3: passive pool metrics. The gauges are read AT SCRAPE from the pool's own counters (getters; no query, no timer); an
 * idle-client error is counted by its bounded failure kind. Database-side metrics (connections against `max_connections`, locks,
 * deadlocks, sizes) belong to the PostgreSQL exporter, not here.
 */
export class PoolMetrics {
  private readonly sources = new Map<string, PoolSource>();
  private readonly errors: ReturnType<BoundedMetrics['counter']>;

  constructor(metrics: BoundedMetrics) {
    const pool = growingSet('pool', POOL, MAX_POOLS);
    const each = (read: (s: PoolSource) => number) => (set: (l: { pool: string }, v: number) => void) => {
      for (const [name, source] of this.sources) set({ pool: name }, read(source));
    };
    const gauge = (name: string, help: string, read: (s: PoolSource) => number) =>
      metrics.gauge({ name, help, labels: [pool], maxSeries: MAX_POOLS + 1, collect: each(read) });
    gauge('nawara_db_pool_connections', 'Database pool clients open (in use and idle).', (s) => s.poolStats().total);
    gauge('nawara_db_pool_idle_connections', 'Database pool clients open and idle.', (s) => s.poolStats().idle);
    gauge('nawara_db_pool_waiting_clients', 'Requests waiting for a database pool client (sustained > 0 is saturation).', (s) => s.poolStats().waiting);
    gauge('nawara_db_pool_max_connections', 'The database pool maximum (DB_POOL_MAX).', (s) => s.poolMax);
    this.errors = metrics.counter({
      name: 'nawara_db_pool_errors_total',
      help: 'Database pool idle-client errors, by pool and bounded failure kind.',
      labels: [pool, closedSet('kind', FAILURE_KINDS)],
      maxSeries: (MAX_POOLS + 1) * (FAILURE_KINDS.length + 1),
    });
  }

  add(name: string, source: PoolSource): void {
    if (!POOL.test(name) || this.sources.has(name) || this.sources.size >= MAX_POOLS) return;
    this.sources.set(name, source);
    try {
      source.setPoolObserver?.((kind) => this.errors.inc({ pool: name, kind }));
    } catch {
      // Already observed elsewhere: the gauges still apply.
    }
  }
}
