import { describe, expect, it } from 'vitest';
import { MoneyError } from './money.js';
import { MAX_LINES, MAX_QUANTITY, computeTotals } from './totals.js';

describe('totals are computed from the lines, never supplied (BI-05)', () => {
  it('quantity x unit per line, subtotal is their sum, no tax is determined (B-006), total = subtotal + tax', () => {
    const t = computeTotals([{ quantity: 3, unitAmount: 1500n }, { quantity: 1, unitAmount: 250n }]);
    expect(t.lines.map((l) => [l.lineNumber, l.lineTotal, l.taxAmount])).toEqual([[1, 4500n, 0n], [2, 250n, 0n]]);
    expect(t).toMatchObject({ subtotal: 4750n, taxTotal: 0n, total: 4750n });
  });

  it('is exact where floating point is not (0.1 + 0.2 class): sums of odd minor units stay integers', () => {
    const t = computeTotals(Array.from({ length: 100 }, () => ({ quantity: 7, unitAmount: 333n })));
    expect(t.subtotal).toBe(100n * 7n * 333n);
  });

  it('refuses no lines, more than the maximum lines, a bad quantity and a bad unit amount', () => {
    expect(() => computeTotals([])).toThrow(MoneyError);
    expect(() => computeTotals(Array.from({ length: MAX_LINES + 1 }, () => ({ quantity: 1, unitAmount: 1n })))).toThrow(MoneyError);
    for (const quantity of [0, -1, 1.5, NaN, MAX_QUANTITY + 1]) expect(() => computeTotals([{ quantity, unitAmount: 1n }]), String(quantity)).toThrow(MoneyError);
    expect(() => computeTotals([{ quantity: 1, unitAmount: 0n }])).toThrow(MoneyError);
    expect(() => computeTotals([{ quantity: 1, unitAmount: -5n }])).toThrow(MoneyError);
  });

  it('refuses a line or a subtotal above the cap instead of wrapping', () => {
    expect(() => computeTotals([{ quantity: 2, unitAmount: 9007199254740991n }])).toThrow(MoneyError);
    expect(() => computeTotals([{ quantity: 1, unitAmount: 9007199254740991n }, { quantity: 1, unitAmount: 1n }])).toThrow(MoneyError);
    expect(computeTotals([{ quantity: 1, unitAmount: 9007199254740991n }]).total).toBe(9007199254740991n);
  });
});
