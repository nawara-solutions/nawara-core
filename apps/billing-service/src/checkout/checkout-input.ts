import { billingError } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message: (typeof BILLING_MESSAGES)[keyof typeof BILLING_MESSAGES], params?: Record<string, string>) =>
  billingError(400, 'invalid_checkout_request', message, params);

export interface CheckoutInput {
  platformId: string;
  productId: string;
  priceId: string;
}

/**
 * Core V2 S3f (BIL-10; D2): the member chooses exactly `{platformId, productId, priceId}`; Billing derives everything else. Any other field
 * (a payer, a seller, an Organization, a beneficiary, an amount, a quantity, a template, a snapshot) is a 400: never trusted, never read.
 */
export function normaliseCheckoutInput(raw: unknown): CheckoutInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw bad(BILLING_MESSAGES.requestMustBeObject);
  const b = raw as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['platformId', 'productId', 'priceId'].includes(k)) throw bad(BILLING_MESSAGES.unknownField, { name: k });
  const out: Record<string, string> = {};
  for (const field of ['platformId', 'productId', 'priceId'] as const) {
    const v = b[field];
    if (typeof v !== 'string' || !UUID.test(v)) throw bad(BILLING_MESSAGES.mustBeUuid, { field });
    out[field] = v.toLowerCase();
  }
  return out as unknown as CheckoutInput;
}
