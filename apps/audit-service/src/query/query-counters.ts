/**
 * Process-local query counters for the `audit_query_snapshot` line (Stage 18.6; the File / Notification operational-snapshot pattern).
 * Closed labels only: the scope and the outcome. Never an organization, caller, actor, resource, event or correlation id, never a
 * filter value. Recording `platform_query.executed` is not a query and is never counted here.
 */
export const QUERY_SCOPES = ['organization', 'platform', 'owner'] as const;
export const QUERY_OUTCOMES = ['ok', 'denied', 'invalid', 'rate_limited', 'unavailable', 'error'] as const;
export type QueryScopeLabel = (typeof QUERY_SCOPES)[number];
export type QueryOutcome = (typeof QUERY_OUTCOMES)[number];

export interface QuerySnapshot {
  counts: Record<`${QueryScopeLabel}_${QueryOutcome}`, number>;
  /** Successful queries: rows returned and latency (ms). */
  rows: number;
  latency: { count: number; avgMs: number; maxMs: number };
}

export class QueryCounters {
  private counts = new Map<string, number>();
  private rows = 0;
  private latency = { count: 0, sumMs: 0, maxMs: 0 };

  count(scope: QueryScopeLabel, outcome: QueryOutcome): void {
    const k = `${scope}_${outcome}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  success(rows: number, ms: number): void {
    this.rows += rows;
    this.latency.count += 1;
    this.latency.sumMs += ms;
    this.latency.maxMs = Math.max(this.latency.maxMs, ms);
  }

  drain(): QuerySnapshot {
    const counts = Object.fromEntries(QUERY_SCOPES.flatMap((s) => QUERY_OUTCOMES.map((o) => [`${s}_${o}`, this.counts.get(`${s}_${o}`) ?? 0]))) as QuerySnapshot['counts'];
    const l = this.latency;
    const out = { counts, rows: this.rows, latency: { count: l.count, avgMs: l.count ? Math.round(l.sumMs / l.count) : 0, maxMs: Math.round(l.maxMs) } };
    this.counts.clear();
    this.rows = 0;
    this.latency = { count: 0, sumMs: 0, maxMs: 0 };
    return out;
  }
}
