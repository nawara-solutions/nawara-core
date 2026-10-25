import { billingError } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';

const CURRENCY = /^[A-Z]{3}$/;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (message: typeof BILLING_MESSAGES[keyof typeof BILLING_MESSAGES], params?: Record<string, string>) =>
  billingError(400, 'invalid_billing_platform_request', message, params);

/**
 * Core V2 S3d (register BIL-01): the body is exactly `{currency}`. Unknown fields are a 400 (mass assignment): a client can never supply
 * `companyId`, `createdBy` or `createdAt`, which Billing takes from Auth and the database only.
 */
export function normaliseBillingPlatformInput(raw: unknown): { currency: string } {
  if (!isObject(raw)) throw bad(BILLING_MESSAGES.requestMustBeObject);
  for (const k of Object.keys(raw)) if (k !== 'currency') throw bad(BILLING_MESSAGES.unknownField, { name: k });
  if (typeof raw.currency !== 'string' || !CURRENCY.test(raw.currency)) throw bad(BILLING_MESSAGES.currencyIso);
  return { currency: raw.currency };
}
