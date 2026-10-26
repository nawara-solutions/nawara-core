import type { MessageParams, MessageTexts } from '@nawara/service-kit';
import { billingError } from '../domain/errors.js';
import { normaliseCreatePriceInput } from '../domain/price-input.js';
import { normaliseCreateProductInput } from '../domain/product-input.js';
import { BILLING_MESSAGES } from '../messages.js';

/** Core V2 S3g (BIL-02, D-CAT-5): what the Owner names when creating a product. Everything else is Billing's (seller, Platform, target, provenance). */
export interface OwnerProductInput {
  code: string;
  name: string;
  description: string | null;
  entitlementKind: string;
}

/** Core V2 S3g (BIL-03, D-CAT-5): what the Owner names when creating a price. The currency is the Platform's, the interval `recurring`. */
export interface OwnerPriceInput {
  clientReference: string;
  unitAmount: bigint;
  intervalUnit: string;
  intervalCount: number;
  effectiveFrom: Date;
}

const PRODUCT_FIELDS = new Set(['code', 'name', 'description', 'entitlementKind']);
const PRICE_FIELDS = new Set(['clientReference', 'unitAmount', 'intervalUnit', 'intervalCount', 'effectiveFrom']);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function onlyFields(raw: unknown, allowed: Set<string>, code: 'invalid_product_request' | 'invalid_price_request'): Record<string, unknown> {
  const bad = (message: string | MessageTexts, params?: MessageParams) => billingError(400, code, message, params);
  if (!isObject(raw)) throw bad(BILLING_MESSAGES.requestMustBeObject);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw bad(BILLING_MESSAGES.unknownField, { name: k });
  return raw;
}

/**
 * The body is exactly `{code, name, description?, entitlementKind?}`. Unknown fields are a 400 (mass assignment): a client can never name
 * the seller, the Platform, the subscription target, the producer or the status. The field rules are the producer route's, unchanged
 * (`normaliseCreateProductInput`, given Billing's own seller and target), so a product means the same whoever created it.
 */
export function normaliseOwnerProductInput(raw: unknown): OwnerProductInput {
  const body = onlyFields(raw, PRODUCT_FIELDS, 'invalid_product_request');
  const n = normaliseCreateProductInput({ ...body, seller: { type: 'company', id: 'validation-only' } });
  return { code: n.code, name: n.name, description: n.description, entitlementKind: n.entitlementKind };
}

/**
 * The body is exactly `{clientReference, unitAmount, intervalUnit, intervalCount, effectiveFrom}`. Unknown fields are a 400: the product
 * comes from the path, the currency from the Platform's configuration, and a subscription price always recurs, so a client can name none
 * of them (nor `pricingModel`, `retiredAt` or `revision`). The field rules are the producer route's, unchanged.
 */
export function normaliseOwnerPriceInput(raw: unknown): OwnerPriceInput {
  const body = onlyFields(raw, PRICE_FIELDS, 'invalid_price_request');
  const n = normaliseCreatePriceInput({ ...body, productId: '00000000-0000-4000-8000-000000000000', currency: 'XXX', interval: 'recurring' });
  return { clientReference: n.clientReference, unitAmount: n.unitAmount, intervalUnit: n.intervalUnit!, intervalCount: n.intervalCount!, effectiveFrom: n.effectiveFrom };
}
