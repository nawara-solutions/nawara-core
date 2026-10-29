/**
 * Core V2 S3a (ADR-0044 B2 as amended by the Owner's S3a decision, Option C; S0 DB-3, DB-7): the routing of an invoice as it leaves
 * `draft`, decided by the SERVER from its own rows only: the invoice's payer and Organization and, per line, the product's
 * `subscriptionTarget`. Never from `entitlementKind` (ADR-0045), never from a request. Pure: no database, no clock, no authority call.
 *
 *   purpose                    target         payer                  beneficiary   reference
 *   organization_subscription  organization   user                   —             the invoice's Organization, the product
 *   direct_purchase            personal       user (= beneficiary)   the payer     the product
 *   assisted_settlement        personal       organization           the consenting beneficiary   the assistance request (DB-5)
 *   non_entitlement            none           any                    —             —   (no subscription line at all)
 *
 * Core V2 S5b (E-3): `assisted_settlement` is routed only when the invoice is a settlement channel of an assistance request of THAT
 * Organization (`assistance`, read by the repository from Billing's own channel row, never from a request); any other Organization payer of
 * a personal product is still refused. Core V2 S6f: `recovery_settlement` is routed only for a recovery channel's invoice of THAT Organization
 * (`recovery`, from Billing's own channel row). An invoice carries at most one subscription line.
 */
export type RoutingPurpose = 'organization_subscription' | 'direct_purchase' | 'assisted_settlement' | 'non_entitlement' | 'recovery_settlement';
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
  /** Core V2 S5b: the assistance request whose settlement channel this invoice is, from Billing's own rows (null otherwise). */
  assistance?: { id: string; beneficiaryUserId: string; organizationId: string; productId: string } | null;
  /** Core V2 S6f: the recovery obligation whose settlement channel this invoice is, from Billing's own rows (null otherwise). */
  recovery?: { obligationId: string; organizationId: string } | null;
}

export interface Routing {
  purpose: RoutingPurpose;
  target: RoutingTarget;
  beneficiaryUserId: string | null;
  organizationId: string | null;
  productId: string | null;
  /** The subscription product's Platform (null for `non_entitlement`): the issuing caller and the Organization must belong to it. */
  platformId: string | null;
  /** Core V2 S5b: the assistance request an `assisted_settlement` references (DB-5); null for every other purpose. */
  assistanceRequestId?: string | null;
  /** Core V2 S6f: the recovery obligation a `recovery_settlement` references (DB-6); null for every other purpose. */
  recoveryObligationId?: string | null;
}

/** Why an invoice cannot be routed (the `reason` of `422 invoice_routing_invalid`): codes, never client data. */
export type RoutingRefusal =
  | 'multiple_subscription_lines' // at most one entitlement-bearing line (B2)
  | 'organization_payer' // an Organization pays only assisted or recovery settlements (B7): never an Organization subscription, nor an ordinary invoice (S4a P-1)
  | 'organization_missing' // an Organization subscription names its Organization
  | 'assisted_settlement_unavailable' // an Organization paying a personal product outside an assistance request's settlement channel (S5b)
  | 'payer_not_user' // a personal purchase is paid by its beneficiary, a user
  | 'recovery_settlement_unavailable'; // Core V2 S6f: a recovery invoice is its obligation's Organization's, with no subscription line

export type RoutingDecision = { routed: Routing } | { refused: RoutingRefusal };

export function decideRouting(input: RoutingInput): RoutingDecision {
  const subscriptionLines = input.lines.filter((l) => l.subscriptionTarget !== 'none');
  // Core V2 S6f (B8, DB-4, DB-6; R6F-2): the recovery channel's invoice: the obligation's Organization pays, nothing is a subscription line
  if (input.recovery) {
    const r = input.recovery;
    if (input.payerType !== 'organization' || input.payerId !== r.organizationId || input.organizationId !== r.organizationId || subscriptionLines.length > 0) {
      return { refused: 'recovery_settlement_unavailable' };
    }
    return { routed: { purpose: 'recovery_settlement', target: 'none', beneficiaryUserId: null, organizationId: r.organizationId, productId: null,
      platformId: input.lines[0]?.platformId ?? null, recoveryObligationId: r.obligationId } };
  }
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
  if (input.payerType === 'organization') {
    // Core V2 S5b (E-3, B2, B7): the Organization pays its own request's frozen product, for that request's beneficiary
    const a = input.assistance;
    if (!a || a.organizationId !== input.organizationId || input.payerId !== a.organizationId || a.productId !== line.productId) return { refused: 'assisted_settlement_unavailable' };
    return { routed: { purpose: 'assisted_settlement', target: 'personal', beneficiaryUserId: a.beneficiaryUserId, organizationId: a.organizationId, productId: line.productId, platformId: line.platformId, assistanceRequestId: a.id } };
  }
  if (input.payerType !== 'user') return { refused: 'payer_not_user' };
  return { routed: { purpose: 'direct_purchase', target: 'personal', beneficiaryUserId: input.payerId, organizationId: null, productId: line.productId, platformId: line.platformId } };
}
