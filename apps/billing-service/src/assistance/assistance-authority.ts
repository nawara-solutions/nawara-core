import { Inject, Injectable, Logger } from '@nestjs/common';
import { ORGANIZATION_REFERENCE, getRequestContext, type AuthIdentity, type AuthMembership, type OrganizationReferenceResolver } from '@nawara/service-kit';

/** A caller's relation to one assistance request. `organization_actor` is the S4e actor of the request's Organization (D-5). */
export type AssistanceRelation = 'beneficiary' | 'organization_actor';

/** The parties of a request, from Billing's own row (never from a request value). */
export interface AssistanceParties {
  beneficiaryUserId: string;
  organizationId: string;
  platformId: string;
}

/** An active, ordinary member (no Owner or Operator tier), from Auth's live answer. */
export const isOrdinaryActiveMember = (identity: AuthIdentity): boolean => identity.isActive === true && identity.adminTier === null;

/**
 * Core V2 S5a authority (the Owner's D-2, D-4, D-5, D-10, D-12), decided per request from Auth's LIVE `/auth/me` answer for the caller's
 * own bearer and the Organization reference (Organization Service, the existing authoritative anchor read; unavailable throws 503
 * `hierarchy_unavailable`, so nothing is read or written). Never inferred from Billing's rows alone:
 *   - a beneficiary (D-2) is an active ordinary member with an `active` membership in the Organization, and that membership's Platform is
 *     the Organization reference's Platform;
 *   - an Organization actor (D-5, the S4e A-2 model) is the same, with `isOrganizationAdmin` on that membership;
 *   - an existing request's beneficiary relation needs the caller to be that beneficiary and still an active ordinary member.
 * An Owner or Operator tier alone grants nothing. This is the ACTIVE-Organization actor set only: no scope can be inactive yet (S0 §3.6.4),
 * so Auth's membership facts suffice; V-4 (effective lifecycle state), V-5 (the inactive-Organization actor set) and OD-R6a must be
 * enforced here before any scope can become inactive.
 */
@Injectable()
export class AssistanceAuthority {
  private readonly log = new Logger('BillingAssistanceAuthorization');

  constructor(@Inject(ORGANIZATION_REFERENCE) private readonly reference: OrganizationReferenceResolver) {}

  /**
   * D-2: the Platform of the Organization the caller may request assistance from, or null (no active membership, an unknown Organization,
   * or a membership whose Platform is not the Organization's). Called OUTSIDE any database transaction.
   */
  async beneficiaryPlatform(identity: AuthIdentity, organizationId: string): Promise<string | null> {
    if (!isOrdinaryActiveMember(identity)) return null;
    const membership = identity.memberships.find((m) => m.organization.id === organizationId && m.status === 'active');
    return membership ? this.anchored(membership, organizationId, 'beneficiary') : null;
  }

  /** The caller's relation to an existing request, or null. Called OUTSIDE any database transaction. */
  async relation(identity: AuthIdentity, parties: AssistanceParties): Promise<{ beneficiary: boolean; organizationActor: boolean }> {
    if (!isOrdinaryActiveMember(identity)) return { beneficiary: false, organizationActor: false };
    const beneficiary = identity.id === parties.beneficiaryUserId;
    const membership = identity.memberships.find((m) => m.organization.id === parties.organizationId && m.status === 'active' && m.isOrganizationAdmin === true);
    if (!membership) return { beneficiary, organizationActor: false };
    const platformId = await this.anchored(membership, parties.organizationId, 'organization_actor');
    return { beneficiary, organizationActor: platformId !== null && platformId === parties.platformId };
  }

  /** The membership's Platform when it is the Organization reference's Platform; null otherwise (an unknown Organization included). */
  private async anchored(membership: AuthMembership, organizationId: string, as: AssistanceRelation): Promise<string | null> {
    const ref = await this.reference.resolve(organizationId); // throws (503 hierarchy_unavailable) when the authority cannot answer
    if (!ref || ref.platformId !== membership.platform.id) {
      this.log.warn(`assistance_${as}_denied organizationId=${organizationId} reason=${!ref ? 'unresolved' : 'platform_mismatch'} correlationId=${getRequestContext()?.correlationId ?? '-'}`);
      return null;
    }
    return ref.platformId;
  }
}
