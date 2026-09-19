import { describe, expect, it } from 'vitest';
import { MAX_MINOR_UNITS, MoneyError, addMinor, assertPositive, fromDbAmount, mulMinor, toJsonAmount, toMinorUnits } from './money.js';

describe('money is bigint minor units (BI-01, BI-02)', () => {
  it('accepts safe integers and bigints in range', () => {
    expect(toMinorUnits(0)).toBe(0n);
    expect(toMinorUnits(1500)).toBe(1500n);
    expect(toMinorUnits(9007199254740991n)).toBe(MAX_MINOR_UNITS);
    expect(toMinorUnits(Number.MAX_SAFE_INTEGER)).toBe(MAX_MINOR_UNITS);
  });

  it.each([['a fraction', 10.5], ['NaN', NaN], ['Infinity', Infinity], ['1e21', 1e21], ['a string', '10'], ['null', null], ['undefined', undefined], ['negative', -1], ['negative bigint', -1n], ['above the cap', MAX_MINOR_UNITS + 1n], ['a number above safe', 2 ** 53]])('refuses %s', (_n, v) => {
    expect(() => toMinorUnits(v)).toThrow(MoneyError);
  });

  it('reads a database bigint from its decimal string without going through a float', () => {
    expect(fromDbAmount('9007199254740991')).toBe(MAX_MINOR_UNITS);
    expect(fromDbAmount('0')).toBe(0n);
    for (const bad of ['1.5', '1e3', ' 1', '', 'abc', '9007199254740992', '99999999999999999999']) expect(() => fromDbAmount(bad), bad).toThrow(MoneyError);
  });

  it('checked arithmetic refuses an overflow instead of wrapping or rounding', () => {
    expect(mulMinor(3n, 1500n)).toBe(4500n);
    expect(addMinor(1n, 2n)).toBe(3n);
    expect(() => mulMinor(MAX_MINOR_UNITS, 2n)).toThrow(MoneyError);
    expect(() => addMinor(MAX_MINOR_UNITS, 1n)).toThrow(MoneyError);
    expect(mulMinor(2n, MAX_MINOR_UNITS / 2n)).toBeLessThanOrEqual(MAX_MINOR_UNITS);
  });

  it('positive means strictly greater than zero', () => {
    expect(assertPositive(1n, 'x')).toBe(1n);
    expect(() => assertPositive(0n, 'x')).toThrow(MoneyError);
  });

  it('JSON output is exact for every allowed value and refuses what a JSON number cannot carry', () => {
    expect(toJsonAmount(MAX_MINOR_UNITS)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => toJsonAmount(MAX_MINOR_UNITS + 1n)).toThrow(MoneyError);
    expect(() => toJsonAmount(-1n)).toThrow(MoneyError);
  });
});
