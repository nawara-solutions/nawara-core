/**
 * Process-local query counters for the `audit_query_snapshot` line (Stage 18.6; the File / Notification operational-snapshot pattern).
 * Closed labels only: the scope and the outcome. Never an organization, caller, actor, resource, event or correlation id, never a
 * filter value. Recording `platform_query.executed` is not a query and is never counted here.
 */
export const QUERY_SCOPES = ['organization', 'platform', 'owner'] as const;
export const QUERY_OUTCOMES = ['ok', 'denied', 'invalid', 'rate_limited', 'unavailable', 'error'] as const;
/**
 * Stage 19.5: the owner read (Audit-X) also depends on Auth, so it separates Auth's failures from its own: `auth_timeout` (the request's
 * Auth budget ran out) and `auth_unavailable` (any other Auth failure). `unavailable` stays "the read could not be recorded" and `denied`
 * is every refusal of the caller (401, 403, 404), never a system failure.
 */
export const OWNER_ONLY_OUTCOMES = ['auth_timeout', 'auth_unavailable'] as const;
export type QueryScopeLabel = (typeof QUERY_SCOPES)[number];
export type QueryOutcome = (typeof QUERY_OUTCOMES)[number] | (typeof OWNER_ONLY_OUTCOMES)[number];
const OUTCOMES_OF: Record<QueryScopeLabel, readonly QueryOutcome[]> = {
  organization: QUERY_OUTCOMES,
  platform: QUERY_OUTCOMES,
  owner: [...QUERY_OUTCOMES, ...OWNER_ONLY_OUTCOMES],
};

export interface QuerySnapshot {
  counts: Record<string, number>;
  /** Successful queries: rows returned and latency (ms). */
  rows: number;
  latency: { count: number; avgMs: number; maxMs: number };
  /** Stage 19.5: time spent asking Auth per owner read (both calls, success or failure), so a slowing Auth is visible before it times out. */
  ownerAuthLatency: { count: number; avgMs: number; maxMs: number };
}

export class QueryCounters {
  private counts = new Map<string, number>();
  private rows = 0;
  private latency = { count: 0, sumMs: 0, maxMs: 0 };
  private authLatency = { count: 0, sumMs: 0, maxMs: 0 };

  count(scope: QueryScopeLabel, outcome: QueryOutcome): void {
    if (!OUTCOMES_OF[scope].includes(outcome)) outcome = 'error'; // closed per scope: an owner-only outcome never appears elsewhere
    const k = `${scope}_${outcome}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  ownerAuth(ms: number): void {
    this.authLatency.count += 1;
    this.authLatency.sumMs += ms;
    this.authLatency.maxMs = Math.max(this.authLatency.maxMs, ms);
  }

  success(rows: number, ms: number): void {
    this.rows += rows;
    this.latency.count += 1;
    this.latency.sumMs += ms;
    this.latency.maxMs = Math.max(this.latency.maxMs, ms);
  }

  drain(): QuerySnapshot {
    const counts = Object.fromEntries(QUERY_SCOPES.flatMap((s) => OUTCOMES_OF[s].map((o) => [`${s}_${o}`, this.counts.get(`${s}_${o}`) ?? 0])));
    const agg = (l: { count: number; sumMs: number; maxMs: number }) => ({ count: l.count, avgMs: l.count ? Math.round(l.sumMs / l.count) : 0, maxMs: Math.round(l.maxMs) });
    const out = { counts, rows: this.rows, latency: agg(this.latency), ownerAuthLatency: agg(this.authLatency) };
    this.counts.clear();
    this.rows = 0;
    this.latency = { count: 0, sumMs: 0, maxMs: 0 };
    this.authLatency = { count: 0, sumMs: 0, maxMs: 0 };
    return out;
  }
}
