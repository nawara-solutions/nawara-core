import { describe, expect, it } from 'vitest';
import { personalEntitlementAt, type PersonalSpan } from './personal-subscription.repository.js';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const span = (id: string, start: string, end: string): PersonalSpan => ({ purchaseId: id, effectiveStart: d(start), effectiveEnd: d(end) });

/** Core V2 S3c (ADR-0044 B6, B13.2): the personal entitlement from the kept periods; half-open, no grace. */
describe('personalEntitlementAt', () => {
  const spans = [span('a', '2030-01-01', '2030-02-01'), span('b', '2030-02-01', '2030-03-01'), span('c', '2030-05-10', '2030-06-10')];

  it('no periods, before the first, inside a gap or after the last: not entitled', () => {
    expect(personalEntitlementAt([], d('2030-01-15'))).toEqual({ valid: false, expiresAt: null });
    for (const at of ['2029-12-31', '2030-03-01', '2030-04-01', '2030-06-10', '2031-01-01']) expect(personalEntitlementAt(spans, d(at))).toEqual({ valid: false, expiresAt: null });
  });

  it('inside a run of contiguous periods: valid until the END OF THE RUN (renewals stack), never past a gap', () => {
    expect(personalEntitlementAt(spans, d('2030-01-01'))).toEqual({ valid: true, expiresAt: d('2030-03-01') });
    expect(personalEntitlementAt(spans, d('2030-02-15'))).toEqual({ valid: true, expiresAt: d('2030-03-01') });
    expect(personalEntitlementAt(spans, d('2030-05-10'))).toEqual({ valid: true, expiresAt: d('2030-06-10') });
  });

  it('the end is exclusive and there is no grace window', () => {
    expect(personalEntitlementAt([span('a', '2030-01-01', '2030-02-01')], new Date(d('2030-02-01').getTime() - 1))).toMatchObject({ valid: true });
    expect(personalEntitlementAt([span('a', '2030-01-01', '2030-02-01')], d('2030-02-01'))).toEqual({ valid: false, expiresAt: null });
  });
});
