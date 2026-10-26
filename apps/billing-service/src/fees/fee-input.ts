import { billingError } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (message: (typeof BILLING_MESSAGES)[keyof typeof BILLING_MESSAGES], params?: Record<string, string>) =>
  billingError(400, 'invalid_fee_request', message, params);

/** Exactly these fields, nothing else (mass assignment): the actor, Company, currency and status are never request values. */
function fields(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isObject(raw)) throw bad(BILLING_MESSAGES.requestMustBeObject);
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) throw bad(BILLING_MESSAGES.unknownField, { name: k });
  return raw;
}

const uuid = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw bad(BILLING_MESSAGES.mustBeUuid, { field });
  return v.toLowerCase();
};

/** A fee or cap: an integer number of the Platform currency's minor units, >= 0 (A1); never a percentage. */
const amount = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw bad(BILLING_MESSAGES.feeAmountRange);
  return v;
};

export const normaliseFeeCapInput = (raw: unknown) => ({ amount: amount(fields(raw, ['amount']).amount) });
export const normaliseFeeDelegationInput = (raw: unknown) => ({ operatorUserId: uuid(fields(raw, ['operatorUserId']).operatorUserId, 'operatorUserId') });
export function normaliseFeeProposalInput(raw: unknown) {
  const b = fields(raw, ['organizationId', 'productId', 'amount']);
  return { organizationId: uuid(b.organizationId, 'organizationId'), productId: uuid(b.productId, 'productId'), amount: amount(b.amount) };
}
/** Commands carrying no body: an empty body (or none) only. */
export const normaliseEmptyInput = (raw: unknown) => {
  if (raw !== undefined && raw !== null && !(isObject(raw) && Object.keys(raw).length === 0)) fields(raw, []);
  return {};
};

/** A5: every fee command carries an Idempotency-Key, bound to the verified actor and the exact request. */
export function idempotencyKey(header: unknown): string {
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY.test(header)) throw billingError(400, 'idempotency_key_required', BILLING_MESSAGES.idempotencyKeyRequired);
  return header;
}

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
