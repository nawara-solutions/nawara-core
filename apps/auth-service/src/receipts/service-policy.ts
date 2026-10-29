import { ConfigError, parseCallerPolicy, policyList, type CallerPolicyMap } from '@nawara/service-kit';

/**
 * Core V2 S2-Auth.2 (ADR-0067 decision 3, F-7, F-20; D-A2 receipt contract §11.2): the operations a SERVICE caller may be granted on
 * Auth. Auth's own vocabulary; the kit knows none of it. Only the authorization receipts' consumption and its recovery lookup exist.
 */
export const AUTH_SERVICE_OPERATIONS = ['authorization_receipt.consume', 'authorization_receipt.lookup'] as const;
export type AuthServiceOperation = (typeof AUTH_SERVICE_OPERATIONS)[number];

/** F-7: the receipts' audiences. A receipt operation can be granted to no other service. Core V2 S6e-H (H-2): billing-service, for fraud holds only
 * (each binding names its one audience, and consumption requires the caller to be it). */
const RECEIPT_CALLERS: readonly string[] = ['payment-service', 'billing-service'];

export interface AuthCallerPolicy {
  operations: ReadonlySet<string>;
}

/**
 * `AUTH_SERVICE_POLICY`:
 *
 *   { "callers": { "payment-service": { "operations": ["authorization_receipt.consume", "authorization_receipt.lookup"] } } }
 *
 * Deny by default (the kit's rules): no document and no `SERVICE_TOKENS` means no service may call Auth; every caller registered in
 * `SERVICE_TOKENS` needs an entry and every entry a registered token; unknown and repeated keys, an empty or unknown operation and any
 * wildcard refuse to boot. On top of the kit: an entry for any caller other than `payment-service` or (S6e-H) `billing-service` refuses to boot (F-7: the policy
 * admits exactly the receipts' audience). The caller's identity always comes from its authenticated service token, never a request value.
 */
export function parseAuthServicePolicy(raw: string | undefined, registered: readonly string[]): CallerPolicyMap<AuthCallerPolicy> {
  const map = parseCallerPolicy<AuthCallerPolicy>(raw, registered, {
    variable: 'AUTH_SERVICE_POLICY',
    keys: ['operations'],
    entry: (at, e) => ({ operations: policyList(`${at}.operations`, e.operations, { allowed: AUTH_SERVICE_OPERATIONS }) }),
  });
  for (const caller of map.callers()) {
    if (!RECEIPT_CALLERS.includes(caller)) {
      throw new ConfigError(`AUTH_SERVICE_POLICY: "${caller}" cannot be granted authorization receipt operations (only ${RECEIPT_CALLERS.join(', ')}, F-7)`);
    }
  }
  return map;
}
