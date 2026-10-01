import type { MessageParams, MessageTexts } from '@nawara/service-kit';
import { billingError } from './errors.js';
import { BILLING_MESSAGES } from '../messages.js';

/** What a producer asks for when it creates a product (SDD 18.1, endpoint 1). No `producer`: that comes from the authenticated caller. */
export interface RawCreateProductInput {
  seller: unknown;
  code: unknown;
  name: unknown;
  description?: unknown;
  entitlementKind?: unknown;
}

export interface NormalisedCreateProductInput {
  seller: { type: string; id: string };
  code: string;
  name: string;
  description: string | null;
  entitlementKind: string;
}

const PARTY_TYPES = ['user', 'organization', 'company'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_-]{1,62}$/;
const ENTITLEMENT_KINDS = ['none', 'organization_license', 'user_subscription'];
const ALLOWED_TOP = new Set(['seller', 'code', 'name', 'description', 'entitlementKind']);

const bad = (message: string | MessageTexts, params?: MessageParams) => billingError(400, 'invalid_product_request', message, params);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates and normalises a create-product request. An unknown field is a 400 (mass assignment): a client can never
 * smuggle `producer`, `status` or `revision`. Throws 400 `invalid_product_request`.
 */
export function normaliseCreateProductInput(raw: unknown): NormalisedCreateProductInput {
  if (!isObject(raw)) throw bad(BILLING_MESSAGES.requestMustBeObject);
  for (const k of Object.keys(raw)) if (!ALLOWED_TOP.has(k)) throw bad(BILLING_MESSAGES.unknownField, { name: k });

  if (!isObject(raw.seller)) throw bad(BILLING_MESSAGES.mustBeObject, { field: 'seller' });
  for (const k of Object.keys(raw.seller)) if (k !== 'type' && k !== 'id') throw bad(BILLING_MESSAGES.unknownField, { name: `seller.${k}` });
  if (typeof raw.seller.type !== 'string' || !PARTY_TYPES.includes(raw.seller.type)) throw bad(BILLING_MESSAGES.partyTypeValues, { field: 'seller.type' });
  let sellerId: string;
  if (raw.seller.type === 'organization') {
    // an organization seller names itself, in canonical (lower-case) form (Payment's contract, BI-18 analogue)
    if (typeof raw.seller.id !== 'string' || !UUID.test(raw.seller.id)) throw bad(BILLING_MESSAGES.sellerIdUuidWhenOrganization);
    sellerId = raw.seller.id.toLowerCase();
  } else {
    if (typeof raw.seller.id !== 'string' || raw.seller.id.length < 1 || raw.seller.id.length > 128) throw bad(BILLING_MESSAGES.lengthRange, { field: 'seller.id', max: 128 });
    sellerId = raw.seller.id;
  }

  if (typeof raw.code !== 'string' || !CODE.test(raw.code)) throw bad(BILLING_MESSAGES.patternMatch, { field: 'code', pattern: '^[a-z][a-z0-9_-]{1,62}$' });
  if (typeof raw.name !== 'string' || raw.name.trim() === '' || raw.name.length > 140) throw bad(BILLING_MESSAGES.lengthRange, { field: 'name', max: 140 });

  let description: string | null = null;
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== 'string' || raw.description.trim() === '' || raw.description.length > 280) throw bad(BILLING_MESSAGES.lengthRange, { field: 'description', max: 280 });
    description = raw.description;
  }

  let entitlementKind = 'none';
  if (raw.entitlementKind !== undefined && raw.entitlementKind !== null) {
    if (typeof raw.entitlementKind !== 'string' || !ENTITLEMENT_KINDS.includes(raw.entitlementKind)) throw bad(BILLING_MESSAGES.entitlementKindValues);
    entitlementKind = raw.entitlementKind;
  }

  return { seller: { type: raw.seller.type, id: sellerId }, code: raw.code, name: raw.name, description, entitlementKind };
}
