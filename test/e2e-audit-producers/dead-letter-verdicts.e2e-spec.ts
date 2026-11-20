import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  coverageAlerts, coverageOf, deadLetterVerdicts, HEARTBEAT_INTERVAL_MS, type CoverageFact, type TransitionFact,
} from './support/dead-letter-verdicts.js';
import { classify, DEVELOPMENT_GRACE_MS, failures, type ComparisonInput } from './support/outbox-audit-comparator.js';

/**
 * Core V2 DO-43c (the Owner's D43-6 to D43-8 and safety requirements 1 to 4, 6, 7, 10): the G6-D dead-letter verdicts, coverage and
 * monitoring rules, pure. Crashes, restarts, outages, buffer overflow, metric absence and counter resets are expressed as the coverage
 * facts they leave behind (the real-process cases are audit-service's `dead-letter-observation-wiring.e2e-spec.ts`).
 */
const Q = 'audit-service.audit';
const T0 = new Date('2026-11-20T12:00:00.000Z').getTime();
const at = (min: number) => new Date(T0 + min * 60_000);

/** An instance's facts: started at `startMin`, a heartbeat every minute until `endMin`, optionally stopped; `lostFrom` adds drops. */
function instance(o: { id?: string; startMin: number; endMin: number; stopped?: boolean; lostAt?: number; bufferedAt?: number; skip?: [number, number] }): { id: string; facts: CoverageFact[] } {
  const id = o.id ?? randomUUID();
  const facts: CoverageFact[] = [];
  let seq = 0;
  for (let m = o.startMin; m <= o.endMin; m += HEARTBEAT_INTERVAL_MS / 60_000) {
    if (o.skip && m > o.skip[0] && m < o.skip[1]) continue;
    const kind = m === o.startMin ? 'started' : o.stopped && m === o.endMin ? 'stopped' : 'heartbeat';
    facts.push({ instanceId: id, kind, seq: seq++, consumers: [Q], droppedOverflow: 0, droppedSink: o.lostAt !== undefined && m >= o.lostAt ? 3 : 0, rejectedTotal: 0,
      buffered: o.bufferedAt !== undefined && m >= o.bufferedAt ? 2 : 0, observedAt: at(m) });
  }
  return { id, facts };
}
const tr = (eventId: string, attemptId: string, transition: TransitionFact['transition'], min: number, instanceId = 'i'): TransitionFact => ({ attemptId, transition, instanceId, consumer: Q, eventId, observedAt: at(min) });
const window = { consumer: Q, from: at(10), to: at(20), now: at(40) };

describe('DO-43c coverage: established only from an independent expected-instance set AND continuous facts', () => {
  it('covered: one expected instance, started before the window, continuous heartbeats, nothing lost or buffered, a fact after the window', () => {
    const a = instance({ startMin: 0, endMin: 40 });
    expect(coverageOf({ ...window, expected: new Set([a.id]), coverage: a.facts })).toEqual({ covered: true, reasons: [] });
  });

  it('unknown without an expected set (never inferred from the observation tables alone), or with an empty one', () => {
    const a = instance({ startMin: 0, endMin: 40 });
    expect(coverageOf({ ...window, expected: undefined, coverage: a.facts }).reasons).toEqual(['expected_instances_unknown']);
    expect(coverageOf({ ...window, expected: new Set(), coverage: a.facts }).covered).toBe(false);
  });

  it('unknown when an expected instance wrote nothing (metrics absent: the Audit database down for its whole life)', () => {
    const a = instance({ startMin: 0, endMin: 40 });
    const ghost = randomUUID();
    expect(coverageOf({ ...window, expected: new Set([a.id, ghost]), coverage: a.facts }).reasons).toEqual([`no_coverage_facts:${ghost}`]);
  });

  it('unknown after a CRASH inside the window: heartbeats end, no `stopped`, no fact after the window', () => {
    const a = instance({ startMin: 0, endMin: 15 });
    expect(coverageOf({ ...window, expected: new Set([a.id]), coverage: a.facts }).reasons).toEqual([`no_fact_after_window:${a.id}`]);
  });

  it('unknown across a RESTART: the new instance started inside the window, and an unexpected instance is never silently trusted', () => {
    const old = instance({ startMin: 0, endMin: 14 });
    const fresh = instance({ startMin: 15, endMin: 40 });
    const both = [...old.facts, ...fresh.facts];
    expect(coverageOf({ ...window, expected: new Set([old.id, fresh.id]), coverage: both }).covered).toBe(false);
    expect(coverageOf({ ...window, expected: new Set([old.id, fresh.id]), coverage: both }).reasons).toEqual(expect.arrayContaining([`no_fact_after_window:${old.id}`, `started_inside_window:${fresh.id}`]));
    expect(coverageOf({ ...window, expected: new Set([old.id]), coverage: both }).reasons).toEqual(expect.arrayContaining([`unexpected_instance:${fresh.id}`]));
  });

  it('a counter reset is a NEW instance, never a decrease: the old instance\'s drops are not erased by the new one\'s zeros', () => {
    const old = instance({ startMin: 0, endMin: 14, lostAt: 12 });
    const fresh = instance({ startMin: 15, endMin: 40 });
    const alerts = coverageAlerts({ consumer: Q, now: at(20), expected: new Set([old.id, fresh.id]), coverage: [...old.facts, ...fresh.facts], transitions: [] });
    expect(alerts).toEqual(expect.arrayContaining([{ kind: 'observation_dropped', instanceId: old.id, lost: 3 }, { kind: 'instance_restarted', instanceId: fresh.id }]));
  });

  it('unknown when observations were dropped (buffer overflow, a failed flush) or were still buffered after the window', () => {
    const dropped = instance({ startMin: 0, endMin: 40, lostAt: 15 });
    expect(coverageOf({ ...window, expected: new Set([dropped.id]), coverage: dropped.facts }).reasons).toEqual([`observations_lost:${dropped.id}`]);
    const buffered = instance({ startMin: 0, endMin: 40, bufferedAt: 20 });
    expect(coverageOf({ ...window, expected: new Set([buffered.id]), coverage: buffered.facts }).reasons).toEqual([`observations_buffered:${buffered.id}`]);
  });

  it('unknown across an Audit database OUTAGE: heartbeats could not be written, so the gap itself is the evidence', () => {
    const a = instance({ startMin: 0, endMin: 40, skip: [11, 19] });
    expect(coverageOf({ ...window, expected: new Set([a.id]), coverage: a.facts }).reasons).toEqual([`heartbeat_gap:${a.id}`]);
  });

  it('a window that is not over yet is never covered', () => {
    const a = instance({ startMin: 0, endMin: 40 });
    expect(coverageOf({ ...window, now: at(19), expected: new Set([a.id]), coverage: a.facts }).reasons).toContain('window_not_over');
  });
});

describe('DO-43c verdicts (D43-7)', () => {
  const covered = instance({ startMin: 0, endMin: 40 });
  const base = { ...window, expected: new Set([covered.id]), coverage: covered.facts };

  it('confirmed > unresolved / within_grace > unconfirmed; no facts → not_observed (covered) or coverage_unknown', () => {
    const [c, g, u, n, x, y] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const transitions = [
      tr(c, 'a1', 'attempted', 12), tr(c, 'a1', 'transfer_unconfirmed', 12), tr(c, 'a2', 'transfer_confirmed', 13), // an outcome without its attempted row
      tr(g, 'b1', 'attempted', 35),
      tr(u, 'c1', 'attempted', 12),
      tr(n, 'd1', 'attempted', 12), tr(n, 'd1', 'transfer_unconfirmed', 12), tr(n, 'd2', 'attempted', 13), tr(n, 'd2', 'transfer_unconfirmed', 13),
    ];
    const v = deadLetterVerdicts({ ...base, transitions, eventIds: [c, g, u, n, x] });
    expect(Object.fromEntries(v)).toEqual({ [c]: 'confirmed', [g]: 'within_grace', [u]: 'unresolved', [n]: 'unconfirmed', [x]: 'not_observed' });
    expect(deadLetterVerdicts({ ...base, expected: undefined, transitions, eventIds: [y] }).get(y)).toBe('coverage_unknown');
  });

  it('a MISSING observation never becomes confirmed, and an unconfirmed transfer is never promoted', () => {
    const e = randomUUID();
    const lostOutcome = deadLetterVerdicts({ ...base, transitions: [tr(e, 'a', 'attempted', 12)], eventIds: [e] }).get(e);
    expect(lostOutcome).toBe('unresolved');
    const unconfirmed = deadLetterVerdicts({ ...base, transitions: [tr(e, 'a', 'attempted', 12), tr(e, 'a', 'transfer_unconfirmed', 12)], eventIds: [e] }).get(e);
    expect(unconfirmed).toBe('unconfirmed');
    const nothing = deadLetterVerdicts({ ...base, expected: undefined, transitions: [], eventIds: [e] }).get(e);
    expect(nothing).toBe('coverage_unknown');
  });

  it('separate physical transfers stay separate: a confirmed replay does not hide an unresolved earlier attempt, and vice versa', () => {
    const e = randomUUID();
    expect(deadLetterVerdicts({ ...base, transitions: [tr(e, 'r0', 'attempted', 12), tr(e, 'r1', 'attempted', 30)], eventIds: [e] }).get(e)).toBe('unresolved');
    expect(deadLetterVerdicts({ ...base, transitions: [tr(e, 'r0', 'attempted', 12), tr(e, 'r1', 'attempted', 13), tr(e, 'r1', 'transfer_confirmed', 13)], eventIds: [e] }).get(e)).toBe('confirmed');
  });
});

describe('DO-43c monitoring (D43-6, D43-8): testable rules, never settling anything', () => {
  it('M1: a drop inside the 15-minute window, and a heartbeat missing for over two intervals', () => {
    const a = instance({ startMin: 0, endMin: 30, lostAt: 25 });
    const b = instance({ startMin: 0, endMin: 26 }); // silent since minute 26
    const alerts = coverageAlerts({ consumer: Q, now: at(30), expected: new Set([a.id, b.id]), coverage: [...a.facts, ...b.facts], transitions: [] });
    expect(alerts).toEqual(expect.arrayContaining([{ kind: 'observation_dropped', instanceId: a.id, lost: 3 }, { kind: 'heartbeat_missing', instanceId: b.id, sinceMs: 4 * 60_000 }]));
    const quiet = instance({ startMin: 0, endMin: 30 });
    expect(coverageAlerts({ consumer: Q, now: at(30), expected: new Set([quiet.id]), coverage: quiet.facts, transitions: [] })).toEqual([]);
  });

  it('M1: a cleanly stopped instance is not "missing"; a gap inside the window is', () => {
    const stopped = instance({ startMin: 0, endMin: 20, stopped: true });
    expect(coverageAlerts({ consumer: Q, now: at(30), expected: new Set([stopped.id]), coverage: stopped.facts, transitions: [] })).toEqual([]);
    const gap = instance({ startMin: 0, endMin: 30, skip: [20, 25] });
    expect(coverageAlerts({ consumer: Q, now: at(30), expected: new Set([gap.id]), coverage: gap.facts, transitions: [] })).toEqual([expect.objectContaining({ kind: 'heartbeat_missing', instanceId: gap.id })]);
  });

  it('M2: an attempted transfer without an outcome after 10 minutes', () => {
    const a = instance({ startMin: 0, endMin: 30 });
    const e = randomUUID();
    const alerts = coverageAlerts({ consumer: Q, now: at(30), expected: new Set([a.id]), coverage: a.facts, transitions: [tr(e, 'old', 'attempted', 15), tr(e, 'young', 'attempted', 25), tr(e, 'done', 'attempted', 10), tr(e, 'done', 'transfer_confirmed', 10)] });
    expect(alerts).toEqual([{ kind: 'unresolved_attempt', attemptId: 'old', ageMs: 15 * 60_000 }]);
  });

  it('M4: missing or unavailable metrics are an alert, never "no alert" (no expected set; no fact at all in the window)', () => {
    expect(coverageAlerts({ consumer: Q, now: at(30), expected: undefined, coverage: [], transitions: [] })).toEqual([{ kind: 'observation_unavailable', reason: 'expected_instances_unknown' }]);
    const ghost = randomUUID();
    expect(coverageAlerts({ consumer: Q, now: at(30), expected: new Set([ghost]), coverage: [], transitions: [] }))
      .toEqual(expect.arrayContaining([{ kind: 'observation_unavailable', reason: 'no_coverage_fact_in_window' }, expect.objectContaining({ kind: 'heartbeat_missing', instanceId: ghost })]));
  });
});

describe('DO-43c: the comparator consults the verdicts without ever over-claiming', () => {
  const comparison = (over: Partial<ComparisonInput>): ComparisonInput => ({
    outbox: [], audit: [], now: at(40), graceMs: DEVELOPMENT_GRACE_MS, auditCutoffs: {}, deadLettered: new Set(), producerRetainedSince: null, ...over,
  });
  it('only `confirmed` explains an absence as dead_lettered; unknown evidence is coverage_unknown, not missing; not_observed stays missing', () => {
    const ids = Array.from({ length: 6 }, () => randomUUID());
    const verdicts = new Map([[ids[0]!, 'confirmed'], [ids[1]!, 'unconfirmed'], [ids[2]!, 'not_observed'], [ids[3]!, 'unresolved'], [ids[4]!, 'coverage_unknown']] as const);
    const r = classify(comparison({
      outbox: ids.map((id) => ({ id, name: 'audit.invoice.issued', occurredAt: at(10), publishedAt: at(10) })),
      deadLetterVerdicts: verdicts,
    }));
    expect(Object.fromEntries(r.map((x) => [x.eventId, [x.class, x.deadLetter]]))).toEqual({
      [ids[0]!]: ['dead_lettered', 'confirmed'], [ids[1]!]: ['missing', 'unconfirmed'], [ids[2]!]: ['missing', 'not_observed'],
      [ids[3]!]: ['coverage_unknown', 'unresolved'], [ids[4]!]: ['coverage_unknown', 'coverage_unknown'], [ids[5]!]: ['coverage_unknown', undefined],
    });
    expect(failures(r).map((x) => x.eventId).sort()).toEqual([ids[1]!, ids[2]!].sort());
  });

  it('without verdicts the comparator is exactly as before (G6-D)', () => {
    const id = randomUUID();
    const r = classify(comparison({ outbox: [{ id, name: 'audit.invoice.issued', occurredAt: at(10), publishedAt: at(10) }] }));
    expect(r).toEqual([{ eventId: id, action: 'invoice.issued', class: 'missing' }]);
  });
});
