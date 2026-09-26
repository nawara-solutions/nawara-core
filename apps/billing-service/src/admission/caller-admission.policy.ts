import { parseCallerPolicy, policyList, type CallerPolicyMap } from '@nawara/service-kit';

/**
 * Stage 21.C.2 (ADR-0052 decision 2; ADR-0042 D3 and A.3): every operation Billing exposes to a SERVICE caller, one per route. Billing's own
 * vocabulary; the kit knows none of it. In Core V1 **no service caller is admitted to Billing** (Q5): the approved policy is empty and
 * `SERVICE_TOKENS` registers nobody, so every service-token request is refused. A future caller is admitted only by an explicit
 * architecture decision (ADR-0042 D3) plus its policy entry; granting `product.*` or `price.*` writes also needs B-030/B-031.
 */
export const BILLING_OPERATIONS = [
  'product.create', 'product.read', 'product.archive',
  'price.create', 'price.read', 'price.retire',
  'invoice.create', 'invoice.read', 'invoice.list', 'invoice.issue', 'invoice.discard',
  'payment_request.create', 'payment_request.read', 'payment_request.cancel',
  'entitlement.read',
] as const;
export type BillingOperation = (typeof BILLING_OPERATIONS)[number];

export interface BillingCallerPolicy {
  operations: ReadonlySet<string>;
  /** AD-3: the Platforms whose Organizations this caller may name or read. Explicit, possibly empty; no wildcard. */
  allowedPlatforms: ReadonlySet<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `BILLING_SERVICE_POLICY`: `{ "callers": { "<caller>": { "operations": [...], "allowedPlatforms": [...] } } }`, deny by default. */
export function parseBillingServicePolicy(raw: string | undefined, registered: readonly string[]): CallerPolicyMap<BillingCallerPolicy> {
  return parseCallerPolicy(raw, registered, {
    variable: 'BILLING_SERVICE_POLICY',
    keys: ['operations', 'allowedPlatforms'],
    entry: (at, e) => ({
      operations: policyList(`${at}.operations`, e.operations, { allowed: BILLING_OPERATIONS }),
      allowedPlatforms: policyList(`${at}.allowedPlatforms`, e.allowedPlatforms, { pattern: UUID, allowEmpty: true }),
    }),
  });
}
