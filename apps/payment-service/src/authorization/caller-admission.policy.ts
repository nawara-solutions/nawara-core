import { ConfigError, parseCallerPolicy, policyList, type CallerPolicyMap } from '@nawara/service-kit';

/**
 * Stage 21.C.2 (ADR-0052 decision 2; ADR-0042 D3, AD-2, AD-3 and Amendment 3): the Payment operations a SERVICE caller may be granted.
 * Payment's own vocabulary; the kit knows none of it. There is deliberately no attempt operation: starting an attempt is the payer's
 * (a user's), and AD-2 denies services the sync route.
 *
 * Core V2 S4f (PAY-14, the Owner's F-S2): `payment.simulation.resolve` lets ONE dedicated non-production harness identity tell the
 * `simulation` provider what to answer. It is a service operation only (never a user's, an Organization administrator's or an Owner's), it
 * is held alone (a caller that creates or reads payments cannot also decide their outcomes), and granting it is refused unless the
 * simulation provider is enabled, so it can never be in force in production.
 *
 * Core V2 S4e (PAY-03, the Owner's A-5): `payment.create.organization_payer` is the explicitly inactive capability to create a payment whose
 * payer is an Organization (`assisted_settlement`, `recovery_settlement`). Denied by default and never implied: `payment.create` alone does
 * not include it (no wildcard exists). Refused in production configuration, so only isolated test policies hold it until a separate Owner
 * decision grants it to a real Billing producer (S5b / S6f).
 *
 * Core V2 S5b (the Owner's E-2): `payment.create.assisted_settlement` is the NARROW, purpose-bound grant for exactly one Organization-payer
 * purpose, `assisted_settlement`. It is the only operation that admits that purpose (the broad `payment.create.organization_payer` no longer
 * does: it is left to `recovery_settlement`, still default-denied, S6f); only the caller `billing-service` may hold it, never implied, no
 * wildcard, and production configuration refuses it like the broad grant.
 */
export const PAYMENT_OPERATIONS = ['payment.create', 'payment.read', 'payment.cancel', 'payment.simulation.resolve', 'payment.create.organization_payer', 'payment.create.assisted_settlement'] as const;
export const SIMULATION_RESOLVE_OPERATION = 'payment.simulation.resolve';
export const ORGANIZATION_PAYER_CREATE_OPERATION = 'payment.create.organization_payer';
export const ASSISTED_SETTLEMENT_CREATE_OPERATION = 'payment.create.assisted_settlement';
/** Core V2 S5b (E-2): the one service identity that may hold the assisted-settlement grant. */
export const ASSISTED_SETTLEMENT_CALLER = 'billing-service';
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
  const policy = parseCallerPolicy<PaymentCallerPolicy>(raw, registered, {
    variable: 'PAYMENT_SERVICE_POLICY',
    keys: ['operations', 'allowedPlatforms'],
    entry: (at, e) => {
      const operations = policyList(`${at}.operations`, e.operations, { allowed: PAYMENT_OPERATIONS });
      if (operations.has(SIMULATION_RESOLVE_OPERATION) && operations.size > 1) {
        throw new ConfigError(`${at}.operations: ${SIMULATION_RESOLVE_OPERATION} is held alone, by a dedicated simulation harness caller`);
      }
      return { operations, allowedPlatforms: policyList(`${at}.allowedPlatforms`, e.allowedPlatforms, { pattern: UUID, allowEmpty: true }) };
    },
  });
  // Core V2 S5b (E-2): the assisted-settlement grant belongs to the Billing service identity alone
  for (const caller of policy.callers()) {
    if (caller !== ASSISTED_SETTLEMENT_CALLER && policy.of(caller)?.operations.has(ASSISTED_SETTLEMENT_CREATE_OPERATION)) {
      throw new ConfigError(`PAYMENT_SERVICE_POLICY: ${ASSISTED_SETTLEMENT_CREATE_OPERATION} may be held only by ${ASSISTED_SETTLEMENT_CALLER} (Core V2 S5b, E-2)`);
    }
  }
  return policy;
}

/** Core V2 S4f (F-S2, F-S5): the simulation authority is refused outright unless the simulation provider is enabled (never in production). */
export function assertSimulationGrant(policy: CallerPolicyMap<PaymentCallerPolicy>, simulationEnabled: boolean): void {
  if (simulationEnabled) return;
  for (const caller of policy.callers()) {
    if (policy.of(caller)?.operations.has(SIMULATION_RESOLVE_OPERATION)) {
      throw new ConfigError(`PAYMENT_SERVICE_POLICY grants ${SIMULATION_RESOLVE_OPERATION}, which requires PAYMENT_SIMULATION_PROVIDER (never in production)`);
    }
  }
}

/**
 * Core V2 S4e (A-5), S5b (E-2): no production configuration grants Organization-payer creation, broad or assisted; production activation
 * needs its own Owner decision.
 */
export function assertOrganizationPayerGrant(policy: CallerPolicyMap<PaymentCallerPolicy>, isProduction: boolean): void {
  if (!isProduction) return;
  for (const caller of policy.callers()) {
    for (const op of [ORGANIZATION_PAYER_CREATE_OPERATION, ASSISTED_SETTLEMENT_CREATE_OPERATION]) {
      if (policy.of(caller)?.operations.has(op)) {
        throw new ConfigError(`PAYMENT_SERVICE_POLICY grants ${op}, which no production configuration may hold yet (a separate Owner decision)`);
      }
    }
  }
}
