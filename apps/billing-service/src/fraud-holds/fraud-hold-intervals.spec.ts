import { HOLD_REVIEW_MS, compensation, deniedByHold, effective, entitlementAt, intersect, length, merge, subtract, type HoldWindow, type Interval } from './fraud-hold-intervals.js';

const H = 3600_000;
const D = 24 * H;
const iv = (start: number, end: number): Interval => ({ start, end });
const hold = (id: string, start: number, end: number): HoldWindow => ({ id, start, end });

/** Core V2 S6e-H (C-1): the exact interval algebra of fraud holds and their compensation. */
describe('fraud-hold interval algebra (Core V2 S6e-H, C-1)', () => {
  it('merge, intersect, subtract and length are exact and half-open', () => {
    expect(merge([iv(5, 10), iv(0, 5), iv(12, 12), iv(11, 13)])).toEqual([iv(0, 10), iv(11, 13)]); // touching merged, empty dropped
    expect(intersect([iv(0, 10), iv(20, 30)], [iv(5, 25)])).toEqual([iv(5, 10), iv(20, 25)]);
    expect(subtract([iv(0, 30)], [iv(5, 10), iv(20, 25)])).toEqual([iv(0, 5), iv(10, 20), iv(25, 30)]);
    expect(length([iv(0, 10), iv(5, 15)])).toBe(15);
  });

  it('a hold inside one paid month: exactly the held time is compensated after the run, starting where the hold ended (or the run ended)', () => {
    const paid = [iv(0, 30 * D)];
    const h = hold('h1', 3 * D + 17, 5 * D + 4 * H + 12 * 60_000 + 31); // sub-day precision
    const c = compensation(paid, [h]);
    expect(c).toEqual([iv(30 * D, 30 * D + (h.end - h.start))]);
    expect(entitlementAt(paid, [h], 4 * D).valid).toBe(false);
    expect(entitlementAt(paid, [h], 6 * D)).toEqual({ valid: true, expiresAt: 30 * D + (h.end - h.start) });
    expect(entitlementAt(paid, [h], 30 * D + 1)).toEqual({ valid: true, expiresAt: 30 * D + (h.end - h.start) }); // compensation time
  });

  it('entitlement expiring during the hold: only the paid part is compensated, and only after the hold ends (never swallowed by it)', () => {
    const paid = [iv(0, 10 * D)];
    const h = hold('h', 8 * D, 8 * D + HOLD_REVIEW_MS); // runs to day 22, past the paid end
    expect(compensation(paid, [h])).toEqual([iv(22 * D, 24 * D)]); // 2 paid days denied
    expect(entitlementAt(paid, [h], 12 * D).valid).toBe(false); // no paid entitlement (nor hold-free time) there
    expect(entitlementAt(paid, [h], 22 * D)).toEqual({ valid: true, expiresAt: 24 * D });
  });

  it('no compensation for time without otherwise-valid paid entitlement', () => {
    expect(compensation([iv(10 * D, 20 * D)], [hold('h', 0, 5 * D)])).toEqual([]);
    expect(compensation([], [hold('h', 0, 5 * D)])).toEqual([]);
  });

  it('overlapping holds never compensate twice; their evidence sums to the union', () => {
    const paid = [iv(0, 30 * D)];
    const holds = [hold('a', 2 * D, 6 * D), hold('b', 4 * D, 9 * D)];
    expect(length(compensation(paid, holds))).toBe(7 * D);
    const ev = deniedByHold(paid, holds);
    expect([ev.get('a'), ev.get('b')]).toEqual([4 * D, 3 * D]);
    expect([...ev.values()].reduce((a, b) => a + b, 0)).toBe(7 * D);
  });

  it('paid periods keep their dates: a later paid run after a lapse is never moved; overflowing compensation continues after it', () => {
    const paid = [iv(0, 10 * D), iv(12 * D, 20 * D)];
    const h = hold('h', 2 * D, 7 * D); // 5 paid days denied in the first run
    const c = compensation(paid, [h]);
    expect(c).toEqual([iv(10 * D, 12 * D), iv(20 * D, 23 * D)]); // 2 fill the gap, 3 after the next run
    expect(merge(effective(paid, [h]))).toEqual([iv(0, 2 * D), iv(7 * D, 23 * D)]);
  });

  it('consecutive paid periods (one run) are compensated once, at the end of the whole run', () => {
    const paid = [iv(0, 30 * D), iv(30 * D, 61 * D)];
    expect(compensation(paid, [hold('h', 29 * D, 31 * D)])).toEqual([iv(61 * D, 63 * D)]);
  });

  it('a reversal removes the span and the compensation it earned; nothing is resurrected', () => {
    const before = [iv(0, 30 * D), iv(30 * D, 60 * D)];
    const h = hold('h', 40 * D, 45 * D);
    expect(length(compensation(before, [h]))).toBe(5 * D);
    const afterReversingTheSecond = [iv(0, 30 * D)];
    expect(compensation(afterReversingTheSecond, [h])).toEqual([]);
    expect(entitlementAt(afterReversingTheSecond, [h], 61 * D).valid).toBe(false);
  });

  it('a later hold over compensation time restricts it but earns nothing (it is not paid time)', () => {
    const paid = [iv(0, 10 * D)];
    const holds = [hold('a', 2 * D, 4 * D), hold('b', 11 * D, 11 * D + H)];
    expect(compensation(paid, holds)).toEqual([iv(10 * D, 12 * D)]);
    expect(entitlementAt(paid, holds, 11 * D + 30 * 60_000).valid).toBe(false);
    expect(entitlementAt(paid, holds, 11 * D + 2 * H)).toEqual({ valid: true, expiresAt: 12 * D });
  });

  it('property: for random ledgers and holds, compensation equals the union of denied paid time, never overlaps paid time, and the effective time is conserved', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    for (let k = 0; k < 400; k++) {
      const paid: Interval[] = [];
      let t = rnd(5) * D;
      for (let n = rnd(4); n >= 0; n--) {
        const len = (1 + rnd(40)) * D + rnd(H);
        paid.push(iv(t, t + len));
        t += len + (rnd(2) ? 0 : rnd(10) * D);
      }
      const holds: HoldWindow[] = [];
      for (let n = rnd(4); n > 0; n--) {
        const s = rnd(Math.max(1, t)) + rnd(H);
        holds.push(hold(`h${n}`, s, s + 1 + rnd(HOLD_REVIEW_MS)));
      }
      const denied = length(intersect(paid, holds));
      const c = compensation(paid, holds);
      expect(length(c)).toBe(denied);
      expect(length(intersect(c, paid))).toBe(0);
      expect([...deniedByHold(paid, holds).values()].reduce((a, b) => a + b, 0)).toBe(denied);
      // effective = paid + compensation - held (of that union)
      expect(length(effective(paid, holds))).toBe(length(paid) + denied - length(intersect(merge([...paid, ...c]), holds)));
    }
  });
});
