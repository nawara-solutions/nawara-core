import { billingError } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An RFC 3339 date-time with an explicit zone (`Z` or an offset) and at most millisecond precision: never read in a local time zone. */
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;

/** A real calendar instant as written (no rolled-over day such as February 31, no hour 24, no leap second, an offset within ±23:59). */
function isRealTimestamp(v: string): boolean {
  const m = TIMESTAMP.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const local = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const written = local.getUTCFullYear() === y && local.getUTCMonth() === mo - 1 && local.getUTCDate() === d && local.getUTCHours() === h && local.getUTCMinutes() === mi && local.getUTCSeconds() === s;
  return written && (m[8] === 'Z' || (Number(m[9]) <= 23 && Number(m[10]) <= 59)) && !Number.isNaN(Date.parse(v));
}
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (message: (typeof BILLING_MESSAGES)[keyof typeof BILLING_MESSAGES], params?: Record<string, string>) =>
  billingError(400, 'invalid_assistance_request', message, params);

/** Exactly these fields, nothing else (mass assignment): the beneficiary, amounts, fee, currency, status and times are never request values. */
function fields(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isObject(raw)) throw bad(BILLING_MESSAGES.requestMustBeObject);
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) throw bad(BILLING_MESSAGES.unknownField, { name: k });
  return raw;
}

const uuid = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw bad(BILLING_MESSAGES.mustBeUuid, { field });
  return v.toLowerCase();
};

export interface AssistanceCreateInput {
  organizationId: string;
  productId: string;
  priceId: string;
}

/**
 * Core V2 S5a (BIL-13; D-1 to D-3): the beneficiary names the Organization and the offering, and consents explicitly (`consent: true`,
 * the literal boolean; anything else, or its absence, is refused: consent is never implied). Billing derives every financial term.
 */
export function normaliseAssistanceCreateInput(raw: unknown): AssistanceCreateInput {
  const b = fields(raw, ['organizationId', 'productId', 'priceId', 'consent']);
  if (b.consent !== true) throw bad(BILLING_MESSAGES.assistanceConsentRequired);
  return { organizationId: uuid(b.organizationId, 'organizationId'), productId: uuid(b.productId, 'productId'), priceId: uuid(b.priceId, 'priceId') };
}

/** BIL-15 (D-6, D-11): only the asserted time of the physical collection. No amount: the collection is the complete frozen total. */
export function normaliseCashCollectionInput(raw: unknown): { cashCollectedAt: string } {
  const v = fields(raw, ['cashCollectedAt']).cashCollectedAt;
  if (typeof v !== 'string' || !isRealTimestamp(v)) throw bad(BILLING_MESSAGES.mustBeTimestamp, { field: 'cashCollectedAt' });
  return { cashCollectedAt: v };
}

/** BIL-14: a decline carries no body (an empty object, or none). */
export function normaliseDeclineInput(raw: unknown): Record<string, never> {
  if (raw !== undefined && raw !== null && !(isObject(raw) && Object.keys(raw).length === 0)) fields(raw, []);
  return {};
}

export const isAssistanceId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
