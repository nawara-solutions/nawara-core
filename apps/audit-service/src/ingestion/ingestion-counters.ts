import { AUDIT_REFUSALS } from '@nawara/audit-contract';
import { LogBudget } from './log-budget.js';

/**
 * Process-local ingestion counters for the `audit_ops_snapshot` line (the File / Notification pattern: Core has no metrics platform yet;
 * Stage 18.9 owns more). Every label comes from a CLOSED set: the outcomes below and the refusal reasons of the contract plus the two of
 * ingestion. No event, organization, actor, resource or correlation id, no action and no source service can ever become a label.
 */
// (`transaction_required` is the producer writer's and never occurs here; it stays in the set only because the type is the contract's.)
export const INGESTION_REFUSALS = [...AUDIT_REFUSALS, 'event_id_conflict', 'invalid_record'] as const;
export type IngestionRefusal = (typeof INGESTION_REFUSALS)[number];

const OUTCOMES = ['received', 'persisted', 'duplicate', 'refused', 'transient_failure', 'clock_skew_future'] as const;
type Outcome = (typeof OUTCOMES)[number];

export interface IngestionSnapshot {
  counts: Record<Outcome, number>;
  refused: Partial<Record<IngestionRefusal, number>>;
  /** `recordedAt − occurredAt` of the records persisted in the interval (ms; negative for a producer clock ahead of Audit's). */
  lag: { count: number; avgMs: number; maxMs: number };
  inFlight: number;
  /** Stage 18.9: per-event log lines the budget suppressed in the interval (their events are all counted above). */
  logsSuppressed: number;
}

export class IngestionCounters {
  private counts = new Map<Outcome, number>();
  private refusals = new Map<IngestionRefusal, number>();
  private lag = { count: 0, sumMs: 0, maxMs: 0 };
  private inFlightNow = 0;
  private readonly logBudget = new LogBudget();

  /** Stage 18.9: may this per-event line be written (the first N per key and interval)? */
  mayLog(key: string): boolean {
    return this.logBudget.allow(key);
  }

  bump(o: Outcome): void {
    this.counts.set(o, (this.counts.get(o) ?? 0) + 1);
  }

  refused(reason: IngestionRefusal): void {
    this.bump('refused');
    this.refusals.set(reason, (this.refusals.get(reason) ?? 0) + 1);
  }

  observeLag(ms: number): void {
    this.lag.count += 1;
    this.lag.sumMs += ms;
    this.lag.maxMs = this.lag.count === 1 ? ms : Math.max(this.lag.maxMs, ms);
  }

  enter(): () => void {
    this.inFlightNow += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.inFlightNow -= 1;
      }
    };
  }

  get inFlight(): number {
    return this.inFlightNow;
  }

  /** The interval's counts (then reset) and the live in-flight gauge. */
  drain(): IngestionSnapshot {
    const counts = Object.fromEntries(OUTCOMES.map((o) => [o, this.counts.get(o) ?? 0])) as Record<Outcome, number>;
    const refused = Object.fromEntries(this.refusals) as Partial<Record<IngestionRefusal, number>>;
    const lag = { count: this.lag.count, avgMs: this.lag.count ? Math.round(this.lag.sumMs / this.lag.count) : 0, maxMs: this.lag.maxMs };
    this.counts.clear();
    this.refusals.clear();
    this.lag = { count: 0, sumMs: 0, maxMs: 0 };
    return { counts, refused, lag, inFlight: this.inFlightNow, logsSuppressed: this.logBudget.drain() };
  }
}
