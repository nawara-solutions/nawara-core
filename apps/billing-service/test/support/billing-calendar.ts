/**
 * Test oracle for the billing-anchor contract (ADR-0044 B-025): where a monthly or yearly subscription's periods end.
 *
 * Deliberately independent of the service: it is built from a days-per-month table and the Gregorian leap-year rule, not
 * from PostgreSQL's interval arithmetic (what `billing_subscription_period_end` uses), and never from `Date.UTC` month
 * overflow (which turns Jan 31 + 1 month into Mar 3). `Date.UTC` below only ever receives a day that exists in its month.
 *
 * The contract, in these terms: a subscription's billing anchor fixes a day of month and a UTC time of day (and, for a
 * yearly price, the month). Its k-th occurrence is k months after the anchor's month, on the anchor's day, or on that
 * month's last day when the month is too short. A short month clamps that occurrence only; the anchor itself never moves.
 */

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAY_MS = 86_400_000;

export const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** `month` is 0-based (January = 0), as in `Date`. */
export const daysInMonth = (year: number, month: number): number => (month === 1 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month]!);

/** Months per interval unit on the anchor cadence; `day`/`week` have no calendar-month cadence. */
export const MONTHS_PER_UNIT = { month: 1, year: 12 } as const;

/** The anchor's k-th occurrence (k may be negative): k months after its month, on its day clamped to that month, at its time of day. */
export function anchorOccurrence(anchor: Date, k: number): Date {
  const monthIndex = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + k;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12;
  const day = Math.min(anchor.getUTCDate(), daysInMonth(year, month));
  const timeOfDay = ((anchor.getTime() % DAY_MS) + DAY_MS) % DAY_MS;
  return new Date(Date.UTC(year, month, day) + timeOfDay);
}

/** The first `n` period ends of a `count` x `unit` price whose billing anchor is `anchor` and whose first period starts at it. */
export function periodEnds(anchor: Date, unit: keyof typeof MONTHS_PER_UNIT, count: number, n: number): Date[] {
  return Array.from({ length: n }, (_, i) => anchorOccurrence(anchor, (i + 1) * count * MONTHS_PER_UNIT[unit]));
}

/**
 * A monthly first period on the anchor cadence (the anchor is its start) that ends at `target` or, when the month before
 * `target` is too short for `target`'s day, up to three days earlier (Mar 31 gives Feb 28 -> Mar 28). For tests that need a
 * period ending near a wall-clock instant: an activation must end exactly on its anchor's cadence (ADR-0044 B-025).
 */
export function monthlyPeriodEndingBy(target: Date): { start: Date; end: Date } {
  const start = anchorOccurrence(target, -1);
  return { start, end: anchorOccurrence(start, 1) };
}
