import { billingError } from './errors.js';

/** What a producer asks for when it creates a price (SDD 18.1, endpoint 4; SDD 12). `pricingModel` is not an input: `flat` only. */
export interface RawCreatePriceInput {
  productId: unknown;
  clientReference: unknown;
  currency: unknown;
  unitAmount: unknown;
  interval: unknown;
  intervalUnit?: unknown;
  intervalCount?: unknown;
  effectiveFrom: unknown;
}

export interface NormalisedCreatePriceInput {
  productId: string;
  clientReference: string;
  currency: string;
  unitAmount: bigint;
  interval: 'one_time' | 'recurring';
  intervalUnit: string | null;
  intervalCount: number | null;
  effectiveFrom: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_REFERENCE = /^[A-Za-z0-9._:-]{1,128}$/;
const CURRENCY = /^[A-Z]{3}$/;
const INTERVAL_UNITS = ['day', 'week', 'month', 'year'];
const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_MINOR_UNITS = 9007199254740991n;
const ALLOWED_TOP = new Set(['productId', 'clientReference', 'currency', 'unitAmount', 'interval', 'intervalUnit', 'intervalCount', 'effectiveFrom']);

const bad = (message: string) => billingError(400, 'invalid_price_request', message);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates and normalises a create-price request. Unknown fields are a 400 (mass assignment): a client can never
 * smuggle `pricingModel`, `retiredAt` or `revision`. Throws 400 `invalid_price_request`.
 */
export function normaliseCreatePriceInput(raw: unknown): NormalisedCreatePriceInput {
  if (!isObject(raw)) throw bad('the request must be an object');
  for (const k of Object.keys(raw)) if (!ALLOWED_TOP.has(k)) throw bad(`unknown field: ${k}`);

  if (typeof raw.productId !== 'string' || !UUID.test(raw.productId)) throw bad('productId must be a uuid');
  if (typeof raw.clientReference !== 'string' || !CLIENT_REFERENCE.test(raw.clientReference)) throw bad('clientReference must be 1 to 128 characters of [A-Za-z0-9._:-]');
  if (typeof raw.currency !== 'string' || !CURRENCY.test(raw.currency)) throw bad('currency must be a three-letter ISO 4217 code');

  if (typeof raw.unitAmount !== 'number' || !Number.isSafeInteger(raw.unitAmount) || raw.unitAmount < 1) throw bad('unitAmount must be a positive integer number of minor units');
  const unitAmount = BigInt(raw.unitAmount);
  if (unitAmount > MAX_MINOR_UNITS) throw bad(`unitAmount must be at most ${MAX_MINOR_UNITS}`);

  if (raw.interval !== 'one_time' && raw.interval !== 'recurring') throw bad('interval must be one_time or recurring');
  let intervalUnit: string | null = null;
  let intervalCount: number | null = null;
  if (raw.interval === 'recurring') {
    if (typeof raw.intervalUnit !== 'string' || !INTERVAL_UNITS.includes(raw.intervalUnit)) throw bad('intervalUnit must be day, week, month or year for a recurring price');
    if (typeof raw.intervalCount !== 'number' || !Number.isInteger(raw.intervalCount) || raw.intervalCount < 1) throw bad('intervalCount must be a positive integer for a recurring price');
    intervalUnit = raw.intervalUnit;
    intervalCount = raw.intervalCount;
  } else if (raw.intervalUnit !== undefined || raw.intervalCount !== undefined) {
    throw bad('a one_time price cannot carry intervalUnit or intervalCount');
  }

  if (typeof raw.effectiveFrom !== 'string' || !OFFSET_TIMESTAMP.test(raw.effectiveFrom)) throw bad('effectiveFrom must be an absolute timestamp with an offset');
  const effectiveFrom = new Date(raw.effectiveFrom);
  if (Number.isNaN(effectiveFrom.getTime())) throw bad('effectiveFrom must be an absolute timestamp with an offset');

  return { productId: raw.productId.toLowerCase(), clientReference: raw.clientReference, currency: raw.currency, unitAmount, interval: raw.interval, intervalUnit, intervalCount, effectiveFrom };
}
