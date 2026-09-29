import { describe, expect, it } from 'vitest';
import { isLateRenewal, renewalAnchor } from './subscription-period.js';

const d = (s: string) => new Date(s);

describe('renewalAnchor (Stage 12.2 sections 22-25, 50)', () => {
  it('early renewal: anchors on the ORIGINAL currentPeriodEnd, never on now', () => {
    // Oct 1 -> Nov 1, paid Oct 20 while still active (no grace)
    const anchor = renewalAnchor({ currentPeriodEnd: d('2026-11-01T00:00:00Z'), graceUntil: null }, d('2026-10-20T00:00:00Z'));
    expect(anchor).toEqual(d('2026-11-01T00:00:00Z'));
  });

  it('multiple early renewals stay deterministic: each one anchors on the end the PREVIOUS renewal produced', () => {
    const first = renewalAnchor({ currentPeriodEnd: d('2026-11-01T00:00:00Z'), graceUntil: null }, d('2026-10-20T00:00:00Z'));
    expect(first).toEqual(d('2026-11-01T00:00:00Z')); // renew #1 anchors here; the caller then computes Dec 1 as the new end
    const second = renewalAnchor({ currentPeriodEnd: d('2026-12-01T00:00:00Z'), graceUntil: null }, d('2026-11-15T00:00:00Z'));
    expect(second).toEqual(d('2026-12-01T00:00:00Z')); // renew #2 anchors on Dec 1, not on "now" or on Nov 1 again
  });

  it('renewal during grace: anchors on the ORIGINAL currentPeriodEnd, NOT on now and NOT on graceUntil', () => {
    // paid Oct 1 -> Nov 1; grace Nov 1 -> Nov 8; renewal settles Nov 5
    const anchor = renewalAnchor({ currentPeriodEnd: d('2026-11-01T00:00:00Z'), graceUntil: d('2026-11-08T00:00:00Z') }, d('2026-11-05T00:00:00Z'));
    expect(anchor).toEqual(d('2026-11-01T00:00:00Z'));
  });

  it('fully late renewal (past any grace, or no grace at all): anchors on NOW, never back-charging inaccessible days', () => {
    // expired Nov 1 (no grace configured); payment succeeds Nov 5
    const anchor = renewalAnchor({ currentPeriodEnd: d('2026-11-01T00:00:00Z'), graceUntil: null }, d('2026-11-05T00:00:00Z'));
    expect(anchor).toEqual(d('2026-11-05T00:00:00Z'));
  });

  it('late renewal past an elapsed grace window: anchors on now, not on the stale graceUntil', () => {
    // period ended Nov 1, grace ran out Nov 8, payment finally succeeds Nov 20
    const anchor = renewalAnchor({ currentPeriodEnd: d('2026-11-01T00:00:00Z'), graceUntil: d('2026-11-08T00:00:00Z') }, d('2026-11-20T00:00:00Z'));
    expect(anchor).toEqual(d('2026-11-20T00:00:00Z'));
  });

  describe('time boundary (half-open period, section 17/50)', () => {
    const periodEnd = d('2026-11-01T00:00:00Z');

    it('now < currentPeriodEnd (no grace): anchors on currentPeriodEnd', () => {
      expect(renewalAnchor({ currentPeriodEnd: periodEnd, graceUntil: null }, d('2026-10-31T23:59:59Z'))).toEqual(periodEnd);
    });

    it('now === currentPeriodEnd (no grace): still anchors on currentPeriodEnd — the two branches coincide exactly at the edge', () => {
      expect(renewalAnchor({ currentPeriodEnd: periodEnd, graceUntil: null }, periodEnd)).toEqual(periodEnd);
    });

    it('now > currentPeriodEnd (no grace): anchors on now', () => {
      const now = d('2026-11-01T00:00:01Z');
      expect(renewalAnchor({ currentPeriodEnd: periodEnd, graceUntil: null }, now)).toEqual(now);
    });

    it('now === graceUntil exactly: still within grace, anchors on the original currentPeriodEnd', () => {
      const graceUntil = d('2026-11-08T00:00:00Z');
      expect(renewalAnchor({ currentPeriodEnd: periodEnd, graceUntil }, graceUntil)).toEqual(periodEnd);
    });

    it('now one instant past graceUntil: anchors on now', () => {
      const graceUntil = d('2026-11-08T00:00:00Z');
      const now = d('2026-11-08T00:00:01Z');
      expect(renewalAnchor({ currentPeriodEnd: periodEnd, graceUntil }, now)).toEqual(now);
    });
  });
});

describe('isLateRenewal: when a monthly/yearly renewal resets the billing anchor (ADR-0044 B-025)', () => {
  const periodEnd = d('2027-02-28T09:30:00Z');
  const graceUntil = d('2027-03-07T09:30:00Z');

  it('early, exactly at the period end, and inside grace (to its last instant) are NOT late: the anchor is kept', () => {
    expect(isLateRenewal({ currentPeriodEnd: periodEnd, graceUntil: null }, d('2027-02-01T00:00:00Z'))).toBe(false);
    expect(isLateRenewal({ currentPeriodEnd: periodEnd, graceUntil: null }, periodEnd)).toBe(false);
    expect(isLateRenewal({ currentPeriodEnd: periodEnd, graceUntil }, d('2027-03-03T00:00:00Z'))).toBe(false);
    expect(isLateRenewal({ currentPeriodEnd: periodEnd, graceUntil }, graceUntil)).toBe(false);
  });

  it('strictly after the paid period (no grace) or after the grace window is late: the anchor restarts at the settlement', () => {
    expect(isLateRenewal({ currentPeriodEnd: periodEnd, graceUntil: null }, d('2027-02-28T09:30:00.001Z'))).toBe(true);
    expect(isLateRenewal({ currentPeriodEnd: periodEnd, graceUntil }, d('2027-03-07T09:30:00.001Z'))).toBe(true);
  });

  it('agrees with renewalAnchor exactly: late means the period starts at now, otherwise at the original period end', () => {
    for (const [now, grace] of [[d('2027-02-01T00:00:00Z'), null], [periodEnd, null], [d('2027-04-12T15:00:00Z'), null], [d('2027-03-05T00:00:00Z'), graceUntil], [d('2027-03-08T00:00:00Z'), graceUntil]] as const) {
      const basis = { currentPeriodEnd: periodEnd, graceUntil: grace };
      expect(renewalAnchor(basis, now)).toEqual(isLateRenewal(basis, now) ? now : periodEnd);
    }
  });
});
