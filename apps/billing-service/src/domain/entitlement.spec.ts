import { describe, expect, it } from 'vitest';
import { deriveEntitlement, EntitlementError, type SubscriptionForEntitlement } from './entitlement.js';

const d = (s: string) => new Date(s);

// Oct 1 -> Nov 1 paid, Nov 1 -> Nov 8 grace: the exact worked example throughout Stage 12.2/12.3.
const PERIOD_START = d('2026-10-01T00:00:00Z');
const PERIOD_END = d('2026-11-01T00:00:00Z');
const GRACE_UNTIL = d('2026-11-08T00:00:00Z');

const base = (over: Partial<SubscriptionForEntitlement> = {}): SubscriptionForEntitlement => ({
  status: 'active',
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  graceUntil: null,
  effectiveTerminationAt: null,
  ...over,
});

describe('deriveEntitlement — the frozen V1 truth table (Stage 12.3 section 39)', () => {
  it('1. pending -> invalid, regardless of any period fields', () => {
    expect(deriveEntitlement(base({ status: 'pending', currentPeriodStart: null, currentPeriodEnd: null }), d('2026-10-15T00:00:00Z'))).toEqual({ valid: false, expiresAt: null });
  });

  it('2. before period start -> invalid, even though status says active (section 13)', () => {
    expect(deriveEntitlement(base(), d('2026-09-30T23:59:59.999Z'))).toEqual({ valid: false, expiresAt: null });
  });

  it('3. exact period start -> valid (the start boundary is inclusive)', () => {
    expect(deriveEntitlement(base(), PERIOD_START)).toEqual({ valid: true, expiresAt: PERIOD_END });
  });

  it('4. middle of the paid period -> valid', () => {
    expect(deriveEntitlement(base(), d('2026-10-15T00:00:00Z'))).toEqual({ valid: true, expiresAt: PERIOD_END });
  });

  it('5. immediately before period end -> valid', () => {
    expect(deriveEntitlement(base(), d('2026-10-31T23:59:59.999Z'))).toEqual({ valid: true, expiresAt: PERIOD_END });
  });

  it('6. exact period end, no grace -> invalid (the end boundary is exclusive)', () => {
    expect(deriveEntitlement(base(), PERIOD_END)).toEqual({ valid: false, expiresAt: null });
  });

  it('7. after period end, no grace -> invalid', () => {
    expect(deriveEntitlement(base(), d('2026-11-02T00:00:00Z'))).toEqual({ valid: false, expiresAt: null });
  });

  it('8. stale `active` status inside a precomputed grace window -> valid (sweeper independence, section 15)', () => {
    const sub = base({ status: 'active', graceUntil: GRACE_UNTIL });
    expect(deriveEntitlement(sub, d('2026-11-05T00:00:00Z'))).toEqual({ valid: true, expiresAt: GRACE_UNTIL });
  });

  it('9. explicit `grace` status inside the grace window -> valid, identically to a stale `active`', () => {
    const sub = base({ status: 'grace', graceUntil: GRACE_UNTIL });
    expect(deriveEntitlement(sub, d('2026-11-05T00:00:00Z'))).toEqual({ valid: true, expiresAt: GRACE_UNTIL });
  });

  it('10. immediately before graceUntil -> valid', () => {
    const sub = base({ status: 'grace', graceUntil: GRACE_UNTIL });
    expect(deriveEntitlement(sub, d('2026-11-07T23:59:59.999Z'))).toEqual({ valid: true, expiresAt: GRACE_UNTIL });
  });

  it('11. exact graceUntil -> invalid', () => {
    const sub = base({ status: 'grace', graceUntil: GRACE_UNTIL });
    expect(deriveEntitlement(sub, GRACE_UNTIL)).toEqual({ valid: false, expiresAt: null });
  });

  it('12. after graceUntil -> invalid', () => {
    const sub = base({ status: 'grace', graceUntil: GRACE_UNTIL });
    expect(deriveEntitlement(sub, d('2026-11-09T00:00:00Z'))).toEqual({ valid: false, expiresAt: null });
  });

  it('13. cancelAtPeriodEnd during the paid period -> still valid: the field is not even part of the input type (section 21/45)', () => {
    // cancelAtPeriodEnd is deliberately absent from SubscriptionForEntitlement: a caller who passes a full
    // SubscriptionRow-shaped object (which DOES carry it) sees it structurally ignored, not merely behaviorally ignored.
    const cancelled = { ...base(), cancelAtPeriodEnd: true };
    const notCancelled = { ...base(), cancelAtPeriodEnd: false };
    const now = d('2026-10-20T00:00:00Z');
    expect(deriveEntitlement(cancelled, now)).toEqual(deriveEntitlement(notCancelled, now));
    expect(deriveEntitlement(cancelled, now)).toEqual({ valid: true, expiresAt: PERIOD_END });
  });

  it('14. a future administrative termination during the paid period -> valid, expiresAt is the termination (section 19/46)', () => {
    const termination = d('2026-10-20T00:00:00Z');
    const sub = base({ status: 'expired', effectiveTerminationAt: termination });
    expect(deriveEntitlement(sub, d('2026-10-15T00:00:00Z'))).toEqual({ valid: true, expiresAt: termination });
  });

  it('15. exact termination instant -> invalid', () => {
    const termination = d('2026-10-20T00:00:00Z');
    const sub = base({ status: 'expired', effectiveTerminationAt: termination });
    expect(deriveEntitlement(sub, termination)).toEqual({ valid: false, expiresAt: null });
  });

  it('16. termination already passed -> invalid', () => {
    const termination = d('2026-10-20T00:00:00Z');
    const sub = base({ status: 'expired', effectiveTerminationAt: termination });
    expect(deriveEntitlement(sub, d('2026-10-25T00:00:00Z'))).toEqual({ valid: false, expiresAt: null });
  });

  it('17. termination during grace -> valid until the termination, never until graceUntil (boundary precedence, section 20/46)', () => {
    const termination = d('2026-11-06T00:00:00Z'); // inside [periodEnd Nov 1, graceUntil Nov 8)
    const sub = base({ status: 'grace', graceUntil: GRACE_UNTIL, effectiveTerminationAt: termination });
    expect(deriveEntitlement(sub, d('2026-11-05T00:00:00Z'))).toEqual({ valid: true, expiresAt: termination });
    expect(deriveEntitlement(sub, termination)).toEqual({ valid: false, expiresAt: null });
  });

  it('18. no subscription at all -> invalid', () => {
    expect(deriveEntitlement(null, d('2026-10-15T00:00:00Z'))).toEqual({ valid: false, expiresAt: null });
  });

  describe('19. malformed/inconsistent input: a domain error, never a silently-granted access (section 24, matches MoneyError/SnapshotError convention)', () => {
    it('a non-pending subscription with no period at all', () => {
      expect(() => deriveEntitlement(base({ currentPeriodStart: null, currentPeriodEnd: null }), d('2026-10-15T00:00:00Z'))).toThrow(EntitlementError);
    });

    it('currentPeriodEnd not after currentPeriodStart', () => {
      expect(() => deriveEntitlement(base({ currentPeriodEnd: PERIOD_START }), d('2026-10-15T00:00:00Z'))).toThrow(EntitlementError);
    });

    it('graceUntil not after currentPeriodEnd', () => {
      expect(() => deriveEntitlement(base({ graceUntil: PERIOD_END }), d('2026-10-15T00:00:00Z'))).toThrow(EntitlementError);
    });

    it('effectiveTerminationAt extending access past the period/grace boundary', () => {
      expect(() => deriveEntitlement(base({ effectiveTerminationAt: d('2026-12-01T00:00:00Z') }), d('2026-10-15T00:00:00Z'))).toThrow(EntitlementError);
    });

    it('an invalid Date anywhere in the input, or as `now`', () => {
      expect(() => deriveEntitlement(base(), new Date('not a date'))).toThrow(EntitlementError);
      expect(() => deriveEntitlement(base({ currentPeriodEnd: new Date('not a date') }), d('2026-10-15T00:00:00Z'))).toThrow(EntitlementError);
    });
  });

  describe('20. persisted `expired` is NOT authoritative on its own: it is evaluated identically to active/grace (section 23)', () => {
    // Evidence: SubscriptionRepository.expire() never checks `now` against currentPeriodEnd/graceUntil before writing
    // `status = 'expired'`, and no database CHECK in 0013_subscription.sql relates `status` to `now` at all — a
    // Stage 12.2 test (test/subscriptions.e2e-spec.ts, "renewing an 'expired' row that is STILL inside its precomputed
    // grace window...") already relies on exactly this: a premature `expired` write coexisting with a still-open
    // access window. Only `pending` short-circuits; every other status defers entirely to the timestamps.
    it('expired but still inside the paid period -> valid (a premature expire() call, or any equivalent staleness)', () => {
      const sub = base({ status: 'expired' });
      expect(deriveEntitlement(sub, d('2026-10-15T00:00:00Z'))).toEqual({ valid: true, expiresAt: PERIOD_END });
    });

    it('expired and genuinely past the boundary -> invalid, for the same timestamp reason active/grace would be', () => {
      const sub = base({ status: 'expired' });
      expect(deriveEntitlement(sub, d('2026-11-02T00:00:00Z'))).toEqual({ valid: false, expiresAt: null });
    });
  });
});

describe('deriveEntitlement — named regressions protecting specific Stage 12.2/12.3 decisions', () => {
  it('derives grace access from timestamps even when status normalization is delayed (sweeper independence, section 44)', () => {
    // The exact named scenario from the brief: status still `active`, now inside the precomputed grace window.
    const sub: SubscriptionForEntitlement = { status: 'active', currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END, graceUntil: GRACE_UNTIL, effectiveTerminationAt: null };
    expect(deriveEntitlement(sub, d('2026-11-05T00:00:00Z'))).toEqual({ valid: true, expiresAt: GRACE_UNTIL });
  });

  it('cancellation is never immediate revocation: cancelAtPeriodEnd changes nothing before the purchased horizon (section 45)', () => {
    const now = d('2026-10-31T00:00:00Z'); // one day before period end
    const sub = { ...base(), cancelAtPeriodEnd: true };
    expect(deriveEntitlement(sub, now)).toEqual({ valid: true, expiresAt: PERIOD_END });
  });

  it('termination precedence: the boundary is always the EARLIEST applicable one, never period end or grace end (section 46)', () => {
    const periodEnd = d('2026-11-30T00:00:00Z');
    const graceUntil = d('2026-12-07T00:00:00Z');
    const termination = d('2026-11-20T00:00:00Z');
    const sub = base({ currentPeriodEnd: periodEnd, graceUntil, effectiveTerminationAt: termination });
    const result = deriveEntitlement(sub, d('2026-11-15T00:00:00Z'));
    expect(result.expiresAt).toEqual(termination);
    expect(result.expiresAt).not.toEqual(periodEnd);
    expect(result.expiresAt).not.toEqual(graceUntil);
  });

  it('the derivation never mutates its inputs', () => {
    const sub = base({ graceUntil: GRACE_UNTIL });
    const snapshotBefore = JSON.stringify(sub);
    const now = d('2026-11-05T00:00:00Z');
    const nowBefore = now.getTime();
    deriveEntitlement(sub, now);
    expect(JSON.stringify(sub)).toBe(snapshotBefore);
    expect(now.getTime()).toBe(nowBefore);
  });
});
