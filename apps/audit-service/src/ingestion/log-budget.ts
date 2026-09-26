/**
 * Stage 18.9: a per-key log budget. Every occurrence is still COUNTED by its caller; only the first `perInterval` of each key are
 * written between two snapshots, the rest are reported as a number in the next `audit_ops_snapshot` (so a flood of hostile or broken
 * messages, or a long outage, cannot turn into a log storm, and nothing is hidden: the counters are exact). Keys come from closed sets.
 */
export class LogBudget {
  private used = new Map<string, number>();
  private suppressedNow = 0;

  constructor(private readonly perInterval = 20) {}

  /** True when this occurrence may be logged; false (and counted as suppressed) once the key's budget for the interval is spent. */
  allow(key: string): boolean {
    const n = (this.used.get(key) ?? 0) + 1;
    this.used.set(key, n);
    if (n <= this.perInterval) return true;
    this.suppressedNow += 1;
    return false;
  }

  /** Lines suppressed since the last call; starts a new interval. */
  drain(): number {
    const s = this.suppressedNow;
    this.used.clear();
    this.suppressedNow = 0;
    return s;
  }
}
