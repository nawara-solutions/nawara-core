import { describe, expect, it } from 'vitest';
import { anchorOccurrence, daysInMonth, isLeapYear, monthlyPeriodEndingBy, periodEnds } from './billing-calendar.js';

/** The oracle the Subscription tests assert against must itself be right: checked here against hand-written calendar facts. */
describe('billing-anchor test oracle (ADR-0044 B-025)', () => {
  const ymd = (ds: Date[]) => ds.map((d) => d.toISOString().slice(0, 10));

  it('knows the Gregorian calendar', () => {
    expect([2024, 2027, 2028, 2100, 2000].map(isLeapYear)).toEqual([true, false, true, false, true]);
    expect([daysInMonth(2027, 1), daysInMonth(2028, 1), daysInMonth(2027, 3), daysInMonth(2027, 11)]).toEqual([28, 29, 30, 31]);
  });

  it('clamps a short month without losing the anchor: Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31 (never Mar 3)', () => {
    expect(ymd(periodEnds(new Date('2027-01-31T00:00:00Z'), 'month', 1, 4))).toEqual(['2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  });

  it('monthly anchors on the 28th to the 31st, and Aug 31 across the 30-day months', () => {
    expect(ymd(periodEnds(new Date('2027-01-28T00:00:00Z'), 'month', 1, 2))).toEqual(['2027-02-28', '2027-03-28']);
    expect(ymd(periodEnds(new Date('2027-01-29T00:00:00Z'), 'month', 1, 2))).toEqual(['2027-02-28', '2027-03-29']);
    expect(ymd(periodEnds(new Date('2027-01-30T00:00:00Z'), 'month', 1, 2))).toEqual(['2027-02-28', '2027-03-30']);
    expect(ymd(periodEnds(new Date('2028-01-31T00:00:00Z'), 'month', 1, 2))).toEqual(['2028-02-29', '2028-03-31']);
    expect(ymd(periodEnds(new Date('2026-08-31T00:00:00Z'), 'month', 1, 4))).toEqual(['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']);
  });

  it('several months per interval, and a yearly Feb 29 anchor that recovers in the next leap year', () => {
    expect(ymd(periodEnds(new Date('2027-01-31T00:00:00Z'), 'month', 2, 3))).toEqual(['2027-03-31', '2027-05-31', '2027-07-31']);
    expect(ymd(periodEnds(new Date('2028-02-29T00:00:00Z'), 'year', 1, 4))).toEqual(['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  });

  it('keeps the anchor\'s UTC time of day, and goes backwards for negative k', () => {
    expect(anchorOccurrence(new Date('2027-01-31T09:30:15.250Z'), 1).toISOString()).toBe('2027-02-28T09:30:15.250Z');
    expect(anchorOccurrence(new Date('2027-03-31T09:30:00Z'), -1).toISOString()).toBe('2027-02-28T09:30:00.000Z');
    expect(anchorOccurrence(new Date('2027-01-15T23:59:59.999Z'), -1).toISOString()).toBe('2026-12-15T23:59:59.999Z');
  });

  it('a monthly period ending by a target: exactly at it when the month before has its day, up to three days earlier otherwise', () => {
    const iso = (p: { start: Date; end: Date }) => [p.start.toISOString(), p.end.toISOString()];
    expect(iso(monthlyPeriodEndingBy(new Date('2027-05-20T08:00:00Z')))).toEqual(['2027-04-20T08:00:00.000Z', '2027-05-20T08:00:00.000Z']);
    expect(iso(monthlyPeriodEndingBy(new Date('2027-03-31T08:00:00Z')))).toEqual(['2027-02-28T08:00:00.000Z', '2027-03-28T08:00:00.000Z']);
    expect(iso(monthlyPeriodEndingBy(new Date('2027-05-31T08:00:00Z')))).toEqual(['2027-04-30T08:00:00.000Z', '2027-05-30T08:00:00.000Z']);
    // the result is itself on the cadence: its end is the anchor's (= start's) first occurrence
    const p = monthlyPeriodEndingBy(new Date('2028-03-30T00:00:00Z'));
    expect(p.end).toEqual(anchorOccurrence(p.start, 1));
  });
});
