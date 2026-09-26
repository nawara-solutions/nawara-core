/** The bounded outcome classes of the public compatibility read (closed set; no product, component, version, address or id). */
export const COMPATIBILITY_OUTCOMES = [
  'required_withdrawn', 'required_below_minimum', 'available', 'none', 'not_modified', 'invalid_version', 'invalid_request',
  'unknown_component', 'unknown_release', 'rate_limited', 'failed',
] as const;
export type CompatibilityOutcome = (typeof COMPATIBILITY_OUTCOMES)[number];

/** Process-local counters for the `release_compatibility_snapshot` line (the Audit / File operational-snapshot pattern). */
export class CompatibilityCounters {
  private counts = new Map<CompatibilityOutcome, number>();
  private latency = { count: 0, totalMs: 0, maxMs: 0 };

  count(outcome: CompatibilityOutcome, ms?: number): void {
    this.counts.set(outcome, (this.counts.get(outcome) ?? 0) + 1);
    if (ms !== undefined) {
      this.latency.count += 1;
      this.latency.totalMs += ms;
      this.latency.maxMs = Math.max(this.latency.maxMs, ms);
    }
  }

  /** The counts since the last drain (every outcome, zeros included, in a fixed order), then reset. */
  drain(): { counts: Record<CompatibilityOutcome, number>; latency: { count: number; avgMs: number; maxMs: number } } {
    const counts = Object.fromEntries(COMPATIBILITY_OUTCOMES.map((o) => [o, this.counts.get(o) ?? 0])) as Record<CompatibilityOutcome, number>;
    const l = this.latency;
    const out = { counts, latency: { count: l.count, avgMs: l.count ? Math.round(l.totalMs / l.count) : 0, maxMs: Math.round(l.maxMs) } };
    this.counts = new Map();
    this.latency = { count: 0, totalMs: 0, maxMs: 0 };
    return out;
  }
}
