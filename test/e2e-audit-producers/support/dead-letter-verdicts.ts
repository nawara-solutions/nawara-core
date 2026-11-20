/**
 * Core V2 DO-43c (the Owner's D43-6, D43-7, D43-8 and safety requirements 1 to 4, 7, 10; DEVELOPMENT AND CERTIFICATION TEST TOOL ONLY):
 * the G6-D comparator's reading of audit-service's dead-letter observations (migration 0009). Pure: no I/O, no clock of its own.
 *
 * Coverage is decided from TWO independent inputs, never from the observation tables alone:
 *   - `expected`: the consumer process instances the caller knows were running (established outside the Audit database, e.g. the
 *     processes a test launched and the instance ids they logged). Absent or empty: coverage is unknown, whatever the tables say.
 *   - the coverage facts those instances wrote (started / heartbeat / stopped, cumulative counters).
 * A window is COVERED only if every expected instance's facts span it with no heartbeat gap over two intervals, no observation was dropped
 * or rejected across it, nothing was still buffered when it was last checked, and no instance the caller did not expect wrote facts in it.
 *
 * Verdicts, per event id (D43-7):
 *   confirmed           at least one attempt has `transfer_confirmed` (the broker accepted a copy into `<queue>.dead` at that moment)
 *   within_grace        an attempt has only `attempted`, younger than the unresolved threshold (10 min)
 *   unresolved          an attempt has only `attempted`, older than the threshold
 *   unconfirmed         every observed attempt ended `transfer_unconfirmed` (never promoted to confirmed)
 *   coverage_unknown    no observation, and the window is not covered: a dead letter may exist unobserved
 *   not_observed        no observation in a covered window. NOT proof that no dead letter exists: the observation is best effort, the
 *                       broker copy can exist without a fact (a crash after the confirm, a lost flush counted only in totals), and a
 *                       delivery that never reached the consumer is outside what this can see
 * Precedence: confirmed > unresolved / within_grace > unconfirmed > (no facts) coverage_unknown / not_observed. Only `confirmed` may ever
 * explain an absence from Audit as a dead letter.
 */
export type DeadLetterVerdict = 'confirmed' | 'unconfirmed' | 'within_grace' | 'unresolved' | 'coverage_unknown' | 'not_observed';

export interface TransitionFact { attemptId: string; transition: 'attempted' | 'transfer_confirmed' | 'transfer_unconfirmed'; instanceId: string; consumer: string; eventId: string; observedAt: Date }
export interface CoverageFact {
  instanceId: string; kind: 'started' | 'heartbeat' | 'stopped'; seq: number; consumers: readonly string[];
  droppedOverflow: number; droppedSink: number; rejectedTotal: number; buffered: number; observedAt: Date;
}

/** The Owner's development thresholds (D43-6, D43-8). */
export const UNRESOLVED_AFTER_MS = 10 * 60_000;
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_MISSING_AFTER_MS = 2 * HEARTBEAT_INTERVAL_MS;
export const ALERT_WINDOW_MS = 15 * 60_000;

export interface CoverageInput {
  consumer: string;
  from: Date;
  to: Date;
  now: Date;
  /** The instances established independently of the Audit database; undefined or empty → coverage unknown. */
  expected: ReadonlySet<string> | undefined;
  coverage: readonly CoverageFact[];
}

export interface CoverageResult { covered: boolean; reasons: string[] }

const lost = (f: CoverageFact) => f.droppedOverflow + f.droppedSink + f.rejectedTotal;

/** Whether the window [from, to) is covered for `consumer`, with every reason it is not. */
export function coverageOf(input: CoverageInput): CoverageResult {
  const reasons: string[] = [];
  if (!input.expected || input.expected.size === 0) return { covered: false, reasons: ['expected_instances_unknown'] };
  if (input.to.getTime() > input.now.getTime()) reasons.push('window_not_over');
  const byInstance = new Map<string, CoverageFact[]>();
  for (const f of input.coverage) {
    if (!f.consumers.includes(input.consumer)) continue;
    const list = byInstance.get(f.instanceId) ?? [];
    list.push(f);
    byInstance.set(f.instanceId, list);
  }
  for (const [id, facts] of byInstance) {
    const first = facts.reduce((a, b) => (a.seq <= b.seq ? a : b));
    const last = facts.reduce((a, b) => (a.seq >= b.seq ? a : b));
    const overlaps = first.observedAt.getTime() < input.to.getTime() && (last.kind !== 'stopped' || last.observedAt.getTime() > input.from.getTime());
    if (!input.expected.has(id) && overlaps) reasons.push(`unexpected_instance:${id}`);
  }
  for (const id of input.expected) {
    const facts = [...(byInstance.get(id) ?? [])].sort((a, b) => a.seq - b.seq);
    if (facts.length === 0) { reasons.push(`no_coverage_facts:${id}`); continue; }
    const started = facts[0]!;
    if (started.kind !== 'started' || started.seq !== 0) { reasons.push(`start_not_recorded:${id}`); continue; }
    if (started.observedAt.getTime() > input.from.getTime()) reasons.push(`started_inside_window:${id}`);
    // the fact just before the window (the baseline of the counters) and the first one after it (everything in the window flushed)
    const before = [...facts].reverse().find((f) => f.observedAt.getTime() <= input.from.getTime());
    const after = facts.find((f) => f.observedAt.getTime() >= input.to.getTime());
    if (!before) reasons.push(`no_fact_before_window:${id}`);
    if (!after) reasons.push(facts.at(-1)!.kind === 'stopped' ? `stopped_inside_window:${id}` : `no_fact_after_window:${id}`);
    // heartbeat continuity across [from, to]: consecutive facts no more than two intervals apart (a crash or an outage leaves a gap)
    const span = facts.filter((f) => (!before || f.seq >= before.seq) && (!after || f.seq <= after.seq));
    for (let i = 1; i < span.length; i++) {
      if (span[i]!.observedAt.getTime() - span[i - 1]!.observedAt.getTime() > HEARTBEAT_MISSING_AFTER_MS) { reasons.push(`heartbeat_gap:${id}`); break; }
    }
    if (before && after) {
      if (lost(after) > lost(before)) reasons.push(`observations_lost:${id}`);
      if (after.buffered > 0) reasons.push(`observations_buffered:${id}`);
    }
  }
  return { covered: reasons.length === 0, reasons };
}

/** The verdict for each requested event id (the comparator asks only for events it could not find in Audit). */
export function deadLetterVerdicts(input: CoverageInput & { eventIds: readonly string[]; transitions: readonly TransitionFact[] }): Map<string, DeadLetterVerdict> {
  const out = new Map<string, DeadLetterVerdict>();
  let coverage: CoverageResult | undefined;
  for (const eventId of input.eventIds) {
    const attempts = new Map<string, Set<string>>();
    const firstSeen = new Map<string, number>();
    for (const t of input.transitions) {
      if (t.consumer !== input.consumer || t.eventId !== eventId || eventId === '') continue;
      const set = attempts.get(t.attemptId) ?? new Set<string>();
      set.add(t.transition);
      attempts.set(t.attemptId, set);
      firstSeen.set(t.attemptId, Math.min(firstSeen.get(t.attemptId) ?? Infinity, t.observedAt.getTime()));
    }
    const all = [...attempts.entries()];
    if (all.some(([, s]) => s.has('transfer_confirmed'))) { out.set(eventId, 'confirmed'); continue; }
    const open = all.filter(([, s]) => !s.has('transfer_unconfirmed'));
    if (open.length > 0) {
      const oldest = Math.min(...open.map(([id]) => firstSeen.get(id)!));
      out.set(eventId, input.now.getTime() - oldest > UNRESOLVED_AFTER_MS ? 'unresolved' : 'within_grace');
      continue;
    }
    if (all.length > 0) { out.set(eventId, 'unconfirmed'); continue; }
    coverage ??= coverageOf(input);
    out.set(eventId, coverage.covered ? 'not_observed' : 'coverage_unknown');
  }
  return out;
}

export type CoverageAlert =
  | { kind: 'observation_dropped'; instanceId: string; lost: number }
  | { kind: 'heartbeat_missing'; instanceId: string; sinceMs: number }
  | { kind: 'instance_restarted'; instanceId: string }
  | { kind: 'unresolved_attempt'; attemptId: string; ageMs: number }
  | { kind: 'observation_unavailable'; reason: string };

/**
 * The development monitoring rules (D43-6, D43-8), evaluated over the 15 minutes ending at `now`. Nothing here settles, holds or redelivers a
 * message: it reads facts and returns alerts.
 *   M1  any increase of dropped or rejected observations inside the window, per instance (`observation_dropped`); any expected instance
 *       without a fact in the last two heartbeat intervals, or with a gap over two intervals inside the window (`heartbeat_missing`)
 *   M2  any attempt with `attempted` only, older than 10 minutes (`unresolved_attempt`)
 *   M3  counters are compared per instance only; a new instance id is a restart (`instance_restarted`), never a decrease of the old one
 *   M4  no expected instances, or none of them with any fact in the window: `observation_unavailable`, never "no alert"
 */
export function coverageAlerts(input: { consumer: string; now: Date; expected: ReadonlySet<string> | undefined; coverage: readonly CoverageFact[]; transitions: readonly TransitionFact[] }): CoverageAlert[] {
  const alerts: CoverageAlert[] = [];
  const from = input.now.getTime() - ALERT_WINDOW_MS;
  if (!input.expected || input.expected.size === 0) return [{ kind: 'observation_unavailable', reason: 'expected_instances_unknown' }];
  const mine = input.coverage.filter((f) => f.consumers.includes(input.consumer));
  let anyFact = false;
  for (const id of input.expected) {
    const facts = mine.filter((f) => f.instanceId === id).sort((a, b) => a.seq - b.seq);
    const inWindow = facts.filter((f) => f.observedAt.getTime() >= from && f.observedAt.getTime() <= input.now.getTime());
    if (inWindow.length > 0) anyFact = true;
    if (facts.some((f) => f.kind === 'started' && f.observedAt.getTime() >= from)) alerts.push({ kind: 'instance_restarted', instanceId: id });
    const before = [...facts].reverse().find((f) => f.observedAt.getTime() < from);
    const last = facts.at(-1);
    if (last && before && lost(last) > lost(before)) alerts.push({ kind: 'observation_dropped', instanceId: id, lost: lost(last) - lost(before) });
    else if (last && !before && lost(last) > 0) alerts.push({ kind: 'observation_dropped', instanceId: id, lost: lost(last) });
    if (last?.kind !== 'stopped') {
      const since = last ? input.now.getTime() - last.observedAt.getTime() : Infinity;
      let gap = since > HEARTBEAT_MISSING_AFTER_MS;
      const span = before ? [before, ...inWindow] : inWindow;
      for (let i = 1; i < span.length && !gap; i++) gap = span[i]!.observedAt.getTime() - span[i - 1]!.observedAt.getTime() > HEARTBEAT_MISSING_AFTER_MS;
      if (gap) alerts.push({ kind: 'heartbeat_missing', instanceId: id, sinceMs: since });
    }
  }
  if (!anyFact) alerts.push({ kind: 'observation_unavailable', reason: 'no_coverage_fact_in_window' });
  const outcome = new Set(input.transitions.filter((t) => t.transition !== 'attempted').map((t) => t.attemptId));
  for (const t of input.transitions) {
    if (t.consumer !== input.consumer || t.transition !== 'attempted' || outcome.has(t.attemptId)) continue;
    const age = input.now.getTime() - t.observedAt.getTime();
    if (age > UNRESOLVED_AFTER_MS) alerts.push({ kind: 'unresolved_attempt', attemptId: t.attemptId, ageMs: age });
  }
  return alerts;
}
