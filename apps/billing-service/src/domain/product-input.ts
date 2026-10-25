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
  subscriptionTarget?: unknown;
  platformId?: unknown;
}

export interface NormalisedCreateProductInput {
  seller: { type: string; id: string };
  code: string;
  name: string;
  description: string | null;
  entitlementKind: string;
  /** Core V2 S3a (ADR-0044 B1): `none` (ordinary), `organization` or `personal` (a subscription product). Never derived from `entitlementKind`. */
  subscriptionTarget: SubscriptionTarget;
  /** The Platform a subscription product belongs to (required for `organization` / `personal`); optional for an ordinary product. */
  platformId: string | null;
}

export const SUBSCRIPTION_TARGETS = ['none', 'organization', 'personal'] as const;
export type SubscriptionTarget = (typeof SUBSCRIPTION_TARGETS)[number];

const PARTY_TYPES = ['user', 'organization', 'company'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_-]{1,62}$/;
const ENTITLEMENT_KINDS = ['none', 'organization_license', 'user_subscription'];
const ALLOWED_TOP = new Set(['seller', 'code', 'name', 'description', 'entitlementKind', 'subscriptionTarget', 'platformId']);

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

  let subscriptionTarget: SubscriptionTarget = 'none';
  if (raw.subscriptionTarget !== undefined && raw.subscriptionTarget !== null) {
    if (typeof raw.subscriptionTarget !== 'string' || !(SUBSCRIPTION_TARGETS as readonly string[]).includes(raw.subscriptionTarget)) throw bad(BILLING_MESSAGES.subscriptionTargetValues);
    subscriptionTarget = raw.subscriptionTarget as SubscriptionTarget;
  }
  let platformId: string | null = null;
  if (raw.platformId !== undefined && raw.platformId !== null) {
    if (typeof raw.platformId !== 'string' || !UUID.test(raw.platformId)) throw bad(BILLING_MESSAGES.platformIdUuid);
    platformId = raw.platformId.toLowerCase();
  }
  // a subscription product belongs to exactly one Platform (B1); an ordinary product may name one
  if (subscriptionTarget !== 'none' && platformId === null) throw bad(BILLING_MESSAGES.subscriptionProductNeedsPlatform);
  return { seller: { type: raw.seller.type, id: sellerId }, code: raw.code, name: raw.name, description, entitlementKind, subscriptionTarget, platformId };
}
