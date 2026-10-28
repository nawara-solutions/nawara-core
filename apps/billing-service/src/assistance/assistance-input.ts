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

/** Core V2 S5b BIL-17 (E-9): only the asserted time the full frozen amount was returned. No amount: partial returns are not supported. */
export function normaliseCashReturnInput(raw: unknown): { returnedAt: string } {
  const v = fields(raw, ['returnedAt']).returnedAt;
  if (typeof v !== 'string' || !isRealTimestamp(v)) throw bad(BILLING_MESSAGES.mustBeTimestamp, { field: 'returnedAt' });
  return { returnedAt: v };
}

/** BIL-14 (and, Core V2 S5b, BIL-16): a decline or a settlement carries no body (an empty object, or none). */
export function normaliseDeclineInput(raw: unknown): Record<string, never> {
  if (raw !== undefined && raw !== null && !(isObject(raw) && Object.keys(raw).length === 0)) fields(raw, []);
  return {};
}

/** Core V2 S5c BIL-20 (H-4): the closed dispute reasons; no free text (no evidence store exists in S5c). */
export const DISPUTE_REASONS = ['cash_not_returned', 'collection_not_made', 'collection_time_incorrect', 'return_time_incorrect'] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];
/** Core V2 S5c BIL-21 (H-5): an Organization's answer to a dispute, evidence only. */
export const DISPUTE_POSITIONS = ['accepts', 'contests'] as const;
/** Core V2 S5c BIL-19 (H-2 option A): the two Organization-asserted times an Owner may correct, and the closed reasons. */
export const CORRECTABLE_FIELDS = ['cashCollectedAt', 'returnedAt'] as const;
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];
export const CORRECTION_REASONS = ['actor_entry_error', 'evidence_contradicts_report'] as const;
/** Core V2 S5c BIL-22 (J-2, H-6): the only resolution S5c admits, nonfinancial. */
export const RESOLUTION_OUTCOMES = ['timestamp_corrected'] as const;

const oneOf = <T extends string>(v: unknown, values: readonly T[], field: string): T => {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw bad(BILLING_MESSAGES.valueOneOf, { field, values: values.join(', ') });
  return v as T;
};

/** BIL-20: `{reasonCode}` only. */
export function normaliseDisputeInput(raw: unknown): { reasonCode: DisputeReason } {
  return { reasonCode: oneOf(fields(raw, ['reasonCode']).reasonCode, DISPUTE_REASONS, 'reasonCode') };
}

/** BIL-21: `{position}` only. */
export function normaliseDisputeResponseInput(raw: unknown): { position: (typeof DISPUTE_POSITIONS)[number] } {
  return { position: oneOf(fields(raw, ['position']).position, DISPUTE_POSITIONS, 'position') };
}

/** BIL-19: `{field, value, reasonCode}`; the value is an RFC 3339 instant with a zone, at most milliseconds. Nothing monetary. */
export function normaliseCorrectionInput(raw: unknown): { field: CorrectableField; value: string; reasonCode: (typeof CORRECTION_REASONS)[number] } {
  const b = fields(raw, ['field', 'value', 'reasonCode']);
  const field = oneOf(b.field, CORRECTABLE_FIELDS, 'field');
  if (typeof b.value !== 'string' || !isRealTimestamp(b.value)) throw bad(BILLING_MESSAGES.mustBeTimestamp, { field: 'value' });
  return { field, value: b.value, reasonCode: oneOf(b.reasonCode, CORRECTION_REASONS, 'reasonCode') };
}

/** BIL-22: `{outcome, correctionId}`: the nonfinancial outcome and the correction it rests on. */
export function normaliseResolutionInput(raw: unknown): { outcome: (typeof RESOLUTION_OUTCOMES)[number]; correctionId: string } {
  const b = fields(raw, ['outcome', 'correctionId']);
  return { outcome: oneOf(b.outcome, RESOLUTION_OUTCOMES, 'outcome'), correctionId: uuid(b.correctionId, 'correctionId') };
}

export const isAssistanceId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
