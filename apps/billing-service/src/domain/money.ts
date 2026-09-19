/**
 * Money is `bigint` minor units, always (SDD section 7, BI-01, ADR-0036). Floating point is never used for an amount: not to parse
 * one, not to add, multiply or compare, not to print. Every value is capped at 2^53 - 1: the largest integer a JSON number (and
 * Payment's contract) carries exactly, so no amount can lose precision in an event, a representation or a Payment request.
 */
export const MAX_MINOR_UNITS = 9007199254740991n;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Accepts an amount from JSON (a safe integer NUMBER) or from code (a bigint). Everything else is refused: a string, a fraction, `1e21`, NaN, null. */
export function toMinorUnits(value: unknown, field = 'amount'): bigint {
  if (typeof value === 'bigint') return assertInRange(value, field);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return assertInRange(BigInt(value), field);
  throw new MoneyError(`${field} must be an integer number of minor units`);
}

/** A bigint column arrives from `pg` as a decimal string. Digits only: never parsed through a float. */
export function fromDbAmount(value: string, field = 'amount'): bigint {
  if (!/^-?\d{1,19}$/.test(value)) throw new MoneyError(`${field} is not a database integer`);
  return assertInRange(BigInt(value), field);
}

function assertInRange(v: bigint, field: string): bigint {
  if (v < 0n || v > MAX_MINOR_UNITS) throw new MoneyError(`${field} must be between 0 and ${MAX_MINOR_UNITS}`);
  return v;
}

export function assertPositive(v: bigint, field: string): bigint {
  if (v <= 0n) throw new MoneyError(`${field} must be greater than zero`);
  return v;
}

/** Checked arithmetic: a result above the cap is refused, never wrapped or rounded. */
export function mulMinor(a: bigint, b: bigint, field = 'amount'): bigint {
  const r = a * b;
  if (r > MAX_MINOR_UNITS) throw new MoneyError(`${field} exceeds the maximum amount`);
  return r;
}

export function addMinor(a: bigint, b: bigint, field = 'amount'): bigint {
  const r = a + b;
  if (r > MAX_MINOR_UNITS) throw new MoneyError(`${field} exceeds the maximum amount`);
  return r;
}

/** For JSON out (events, representations): exact because of the cap. */
export function toJsonAmount(v: bigint): number {
  if (v < 0n || v > MAX_MINOR_UNITS) throw new MoneyError('amount cannot be represented exactly as a JSON number');
  return Number(v);
}
