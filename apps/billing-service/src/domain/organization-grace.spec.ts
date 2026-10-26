import { describe, expect, it } from 'vitest';
import { personalEntitlementAt } from '../subscriptions/personal-subscription.repository.js';
import { deriveEntitlement, type SubscriptionForEntitlement } from './entitlement.js';
import { isLateRenewal, renewalAnchor } from './subscription-period.js';

const ms = 1;
const hour = 3_600_000;
const start = new Date('2026-10-01T00:00:00.000Z');
const end = new Date('2026-11-01T00:00:00.000Z');
/** Core V2 S3e (ADR-0044 B13.1): the Organization grace is exactly 24 hours after the period end, as the database stores it. */
const graceUntil = new Date(end.getTime() + 24 * hour);
const at = (offsetMs: number) => new Date(end.getTime() + offsetMs);

const subscription = (o: Partial<SubscriptionForEntitlement> = {}): SubscriptionForEntitlement => ({
  status: 'active', currentPeriodStart: start, currentPeriodEnd: end, graceUntil, effectiveTerminationAt: null, ...o,
});

/**
 * Core V2 S3e: the fixed grace at every boundary (half-open intervals, millisecond precision, UTC instants). Organization: valid through
 * `[currentPeriodStart, currentPeriodEnd + 24 h)`; Personal: valid only inside a paid span, never one millisecond after it.
 */
describe('Organization grace: exactly 24 hours (B13.1)', () => {
  it.each([
    ['one millisecond before the period end', -ms, true],
    ['exactly at the period end (grace begins)', 0, true],
    ['one hour into grace', hour, true],
    ['one millisecond before the 24-hour deadline', 24 * hour - ms, true],
    ['exactly at the 24-hour deadline', 24 * hour, false],
    ['one millisecond after the deadline', 24 * hour + ms, false],
    ['a week after the period end (the retired V1 7 days)', 7 * 24 * hour - ms, false],
  ])('%s', (_n, offset, valid) => {
    expect(deriveEntitlement(subscription(), at(offset))).toEqual(valid ? { valid: true, expiresAt: graceUntil } : { valid: false, expiresAt: null });
  });

  it('the status label never extends or revives access: grace or expired with the same timestamps answer the same', () => {
    for (const status of ['grace', 'expired'] as const) {
      expect(deriveEntitlement(subscription({ status }), at(24 * hour - ms))).toEqual({ valid: true, expiresAt: graceUntil });
      expect(deriveEntitlement(subscription({ status }), at(24 * hour))).toEqual({ valid: false, expiresAt: null });
    }
  });

  it('termination during grace is stronger than grace: access ends at effectiveTerminationAt', () => {
    const terminatedAt = at(2 * hour);
    const terminated = subscription({ status: 'expired', effectiveTerminationAt: terminatedAt });
    expect(deriveEntitlement(terminated, at(hour))).toEqual({ valid: true, expiresAt: terminatedAt });
    expect(deriveEntitlement(terminated, terminatedAt)).toEqual({ valid: false, expiresAt: null });
  });

  it('renewal anchors: before, at, during and at the last instant of grace keep the original period end; after grace is late', () => {
    const basis = { currentPeriodEnd: end, graceUntil };
    for (const offset of [-hour, 0, hour, 24 * hour]) {
      expect(isLateRenewal(basis, at(offset))).toBe(false);
      expect(renewalAnchor(basis, at(offset))).toEqual(end); // no purchased time lost, grace never credited on top
    }
    expect(isLateRenewal(basis, at(24 * hour + ms))).toBe(true);
    expect(renewalAnchor(basis, at(24 * hour + ms))).toEqual(at(24 * hour + ms)); // no back-charging for the lapsed time
  });
});

describe('Personal: no grace (B13.2)', () => {
  const span = { purchaseId: 'p1', effectiveStart: start, effectiveEnd: end };
  it.each([
    ['one millisecond before the paid end', -ms, true],
    ['exactly at the paid end', 0, false],
    ['one millisecond after', ms, false],
    ['inside what would be an Organization grace', hour, false],
  ])('%s', (_n, offset, valid) => {
    expect(personalEntitlementAt([span], at(offset))).toEqual(valid ? { valid: true, expiresAt: end } : { valid: false, expiresAt: null });
  });

  it('a renewal before expiry continues the run; a lapse is a gap with no access, then the new span', () => {
    const next = { purchaseId: 'p2', effectiveStart: end, effectiveEnd: new Date('2026-12-01T00:00:00Z') };
    expect(personalEntitlementAt([span, next], at(-ms))).toEqual({ valid: true, expiresAt: next.effectiveEnd });
    const afterLapse = { purchaseId: 'p3', effectiveStart: at(48 * hour), effectiveEnd: new Date('2026-12-03T00:00:00Z') };
    expect(personalEntitlementAt([span, afterLapse], at(hour))).toEqual({ valid: false, expiresAt: null });
    expect(personalEntitlementAt([span, afterLapse], at(-ms))).toEqual({ valid: true, expiresAt: end });
    expect(personalEntitlementAt([span, afterLapse], at(48 * hour))).toEqual({ valid: true, expiresAt: afterLapse.effectiveEnd });
  });
});
