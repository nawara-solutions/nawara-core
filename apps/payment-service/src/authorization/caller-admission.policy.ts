import { parseCallerPolicy, policyList, type CallerPolicyMap } from '@nawara/service-kit';

/**
 * Stage 21.C.2 (ADR-0052 decision 2; ADR-0042 D3, AD-2, AD-3 and Amendment 3): the Payment operations a SERVICE caller may be granted.
 * Payment's own vocabulary; the kit knows none of it. There is deliberately no attempt operation: starting an attempt is the payer's
 * (a user's), and AD-2 denies services the sync route.
 */
export const PAYMENT_OPERATIONS = ['payment.create', 'payment.read', 'payment.cancel'] as const;
export type PaymentOperation = (typeof PAYMENT_OPERATIONS)[number];

export interface PaymentCallerPolicy {
  operations: ReadonlySet<string>;
  /** AD-3: the Platforms whose Organizations this caller may name. Explicit, possibly empty (then no Organization at all); no wildcard. */
  allowedPlatforms: ReadonlySet<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `PAYMENT_SERVICE_POLICY`:
 *
 *   { "callers": { "billing-service": { "operations": ["payment.create", "payment.read", "payment.cancel"], "allowedPlatforms": ["<uuid>"] } } }
 *
 * Deny by default (the kit's rules): every caller registered in `SERVICE_TOKENS` needs an entry and every entry a registered token. The
 * approved V1 content is exactly one caller, `billing-service`, with those three operations (AD-2); `auth-service` holds no Payment
 * authority (ADR-0042 Amendment 3) and cannot be expressed with an empty operation list.
 */
export function parsePaymentServicePolicy(raw: string | undefined, registered: readonly string[]): CallerPolicyMap<PaymentCallerPolicy> {
  return parseCallerPolicy(raw, registered, {
    variable: 'PAYMENT_SERVICE_POLICY',
    keys: ['operations', 'allowedPlatforms'],
    entry: (at, e) => ({
      operations: policyList(`${at}.operations`, e.operations, { allowed: PAYMENT_OPERATIONS }),
      allowedPlatforms: policyList(`${at}.allowedPlatforms`, e.allowedPlatforms, { pattern: UUID, allowEmpty: true }),
    }),
  });
}
