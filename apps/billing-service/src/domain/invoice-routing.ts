/**
 * Core V2 S3a (ADR-0044 B2 as amended by the Owner's S3a decision, Option C; S0 DB-3, DB-7): the routing of an invoice as it leaves
 * `draft`, decided by the SERVER from its own rows only: the invoice's payer and Organization and, per line, the product's
 * `subscriptionTarget`. Never from `entitlementKind` (ADR-0045), never from a request. Pure: no database, no clock, no authority call.
 *
 *   purpose                    target         payer                  beneficiary   reference
 *   organization_subscription  organization   user                   —             the invoice's Organization, the product
 *   direct_purchase            personal       user (= beneficiary)   the payer     the product
 *   non_entitlement            none           any                    —             —   (no subscription line at all)
 *
 * `assisted_settlement` (an Organization paying a personal product for one of its members, S5a) and `recovery_settlement` (S6) need records that
 * do not exist yet: such invoices are refused. An invoice carries at most one subscription line.
 */
export type RoutingPurpose = 'organization_subscription' | 'direct_purchase' | 'non_entitlement';
export type RoutingTarget = 'organization' | 'personal' | 'none';

export interface RoutingLine {
  productId: string;
  subscriptionTarget: RoutingTarget;
  platformId: string | null;
}

export interface RoutingInput {
  payerType: string;
  payerId: string;
  organizationId: string | null;
  lines: readonly RoutingLine[];
}

export interface Routing {
  purpose: RoutingPurpose;
  target: RoutingTarget;
  beneficiaryUserId: string | null;
  organizationId: string | null;
  productId: string | null;
  /** The subscription product's Platform (null for `non_entitlement`): the issuing caller and the Organization must belong to it. */
  platformId: string | null;
}

/** Why an invoice cannot be routed (the `reason` of `422 invoice_routing_invalid`): codes, never client data. */
export type RoutingRefusal =
  | 'multiple_subscription_lines' // at most one entitlement-bearing line (B2)
  | 'organization_payer' // an Organization pays only assisted or recovery settlements (B7): never an Organization subscription, nor an ordinary invoice (S4a P-1)
  | 'organization_missing' // an Organization subscription names its Organization
  | 'assisted_settlement_unavailable' // an Organization paying a personal product: an assisted settlement (S5a), not yet available
  | 'payer_not_user'; // a personal purchase is paid by its beneficiary, a user

export type RoutingDecision = { routed: Routing } | { refused: RoutingRefusal };

export function decideRouting(input: RoutingInput): RoutingDecision {
  const subscriptionLines = input.lines.filter((l) => l.subscriptionTarget !== 'none');
  if (subscriptionLines.length === 0) {
    // Core V2 S4a (the Owner's P-1, a prospective narrowing of B2's "any" payer): an Organization never pays an ordinary invoice (B7, DB-15)
    if (input.payerType === 'organization') return { refused: 'organization_payer' };
    return { routed: { purpose: 'non_entitlement', target: 'none', beneficiaryUserId: null, organizationId: null, productId: null, platformId: null } };
  }
  if (subscriptionLines.length > 1) return { refused: 'multiple_subscription_lines' };
  const line = subscriptionLines[0]!;
  if (line.subscriptionTarget === 'organization') {
    if (input.payerType !== 'user') return { refused: 'organization_payer' };
    if (input.organizationId === null) return { refused: 'organization_missing' };
    return { routed: { purpose: 'organization_subscription', target: 'organization', beneficiaryUserId: null, organizationId: input.organizationId, productId: line.productId, platformId: line.platformId } };
  }
  if (input.payerType === 'organization') return { refused: 'assisted_settlement_unavailable' };
  if (input.payerType !== 'user') return { refused: 'payer_not_user' };
  return { routed: { purpose: 'direct_purchase', target: 'personal', beneficiaryUserId: input.payerId, organizationId: null, productId: line.productId, platformId: line.platformId } };
}
