import type { MessageParams, MessageTexts } from '@nawara/service-kit';
import { billingError } from './errors.js';
import { BILLING_MESSAGES } from '../messages.js';

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

const bad = (message: string | MessageTexts, params?: MessageParams) => billingError(400, 'invalid_price_request', message, params);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates and normalises a create-price request. Unknown fields are a 400 (mass assignment): a client can never
 * smuggle `pricingModel`, `retiredAt` or `revision`. Throws 400 `invalid_price_request`.
 */
export function normaliseCreatePriceInput(raw: unknown): NormalisedCreatePriceInput {
  if (!isObject(raw)) throw bad(BILLING_MESSAGES.requestMustBeObject);
  for (const k of Object.keys(raw)) if (!ALLOWED_TOP.has(k)) throw bad(BILLING_MESSAGES.unknownField, { name: k });

  if (typeof raw.productId !== 'string' || !UUID.test(raw.productId)) throw bad(BILLING_MESSAGES.mustBeUuid, { field: 'productId' });
  if (typeof raw.clientReference !== 'string' || !CLIENT_REFERENCE.test(raw.clientReference)) throw bad(BILLING_MESSAGES.clientReferencePattern);
  if (typeof raw.currency !== 'string' || !CURRENCY.test(raw.currency)) throw bad(BILLING_MESSAGES.currencyIso);

  if (typeof raw.unitAmount !== 'number' || !Number.isSafeInteger(raw.unitAmount) || raw.unitAmount < 1) throw bad(BILLING_MESSAGES.unitAmountPositive);
  const unitAmount = BigInt(raw.unitAmount);
  if (unitAmount > MAX_MINOR_UNITS) throw bad(BILLING_MESSAGES.unitAmountMax, { max: String(MAX_MINOR_UNITS) });

  if (raw.interval !== 'one_time' && raw.interval !== 'recurring') throw bad(BILLING_MESSAGES.intervalValues);
  let intervalUnit: string | null = null;
  let intervalCount: number | null = null;
  if (raw.interval === 'recurring') {
    if (typeof raw.intervalUnit !== 'string' || !INTERVAL_UNITS.includes(raw.intervalUnit)) throw bad(BILLING_MESSAGES.intervalUnitValues);
    if (typeof raw.intervalCount !== 'number' || !Number.isInteger(raw.intervalCount) || raw.intervalCount < 1) throw bad(BILLING_MESSAGES.intervalCountPositive);
    intervalUnit = raw.intervalUnit;
    intervalCount = raw.intervalCount;
  } else if (raw.intervalUnit !== undefined || raw.intervalCount !== undefined) {
    throw bad(BILLING_MESSAGES.oneTimeNoInterval);
  }

  if (typeof raw.effectiveFrom !== 'string' || !OFFSET_TIMESTAMP.test(raw.effectiveFrom)) throw bad(BILLING_MESSAGES.timestampWithOffset, { field: 'effectiveFrom' });
  const effectiveFrom = new Date(raw.effectiveFrom);
  if (Number.isNaN(effectiveFrom.getTime())) throw bad(BILLING_MESSAGES.timestampWithOffset, { field: 'effectiveFrom' });

  return { productId: raw.productId.toLowerCase(), clientReference: raw.clientReference, currency: raw.currency, unitAmount, interval: raw.interval, intervalUnit, intervalCount, effectiveFrom };
}
