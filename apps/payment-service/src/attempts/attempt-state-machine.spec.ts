import { describe, expect, it } from 'vitest';
import { ATTEMPT_STATUSES, OPEN_ATTEMPT_STATUSES, canTransitionAttempt, isOpenAttemptStatus, type AttemptStatus } from './attempt-state-machine.js';

const ALLOWED_PAIRS: [AttemptStatus, AttemptStatus][] = [
  ['initiated', 'submitted'], ['initiated', 'failed'], ['initiated', 'unknown'],
  ['submitted', 'succeeded'], ['submitted', 'failed'], ['submitted', 'expired'],
  ['unknown', 'submitted'], ['unknown', 'succeeded'], ['unknown', 'failed'],
];

describe('payment attempt state machine (SDD section 5.2)', () => {
  it('allows exactly the transitions the SDD lists', () => {
    for (const [from, to] of ALLOWED_PAIRS) expect(canTransitionAttempt(from, to)).toBe(true);
  });

  it('forbids every other transition', () => {
    const allowed = new Set(ALLOWED_PAIRS.map(([f, t]) => `${f}->${t}`));
    for (const from of ATTEMPT_STATUSES) {
      for (const to of ATTEMPT_STATUSES) {
        if (allowed.has(`${from}->${to}`)) continue;
        expect(canTransitionAttempt(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('never retries blindly: unknown cannot go back to initiated', () => {
    expect(canTransitionAttempt('unknown', 'initiated')).toBe(false);
  });

  it('late success: failed -> succeeded is allowed ONLY when the failure was inferred (a guess), never a confirmed one', () => {
    expect(canTransitionAttempt('failed', 'succeeded', { failureInferred: true })).toBe(true);
    expect(canTransitionAttempt('failed', 'succeeded', { failureInferred: false })).toBe(false);
    expect(canTransitionAttempt('failed', 'succeeded')).toBe(false); // defaults closed
  });

  it('classifies initiated, submitted and unknown as open; nothing else', () => {
    expect(OPEN_ATTEMPT_STATUSES).toEqual(['initiated', 'submitted', 'unknown']);
    for (const s of ATTEMPT_STATUSES) expect(isOpenAttemptStatus(s)).toBe(OPEN_ATTEMPT_STATUSES.includes(s));
  });
});
