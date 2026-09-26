import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { ORGANIZATION_REFERENCE, getRequestContext, type OrganizationReferenceResolver } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';

/** One answer for an Organization that does not exist and one outside the caller's scope: no existence oracle. */
export const organizationNotPermitted = () =>
  new HttpException({ message: 'The organization is not within the calling service\'s scope.', code: 'organization_not_permitted' }, 403);

/**
 * Stage 21.C.2 (ADR-0052 decision 3; ADR-0042 decision 5, A.3, A.5): an Organization a SERVICE caller names (a create's seller or
 * `organizationId`, the entitlement read's path) is resolved through Organization Service (the only authority; memoized positively) and
 * must belong to a Platform in the caller's explicit `allowedPlatforms`. Otherwise 403 `organization_not_permitted`; the authority unable
 * to answer: 503 `hierarchy_unavailable` (thrown by the resolver). It answers identity and anchors only, never commercial state: Billing
 * alone owns subscription and entitlement. Called OUTSIDE any database transaction.
 */
@Injectable()
export class OrganizationScopeService {
  private readonly log = new Logger(OrganizationScopeService.name);

  constructor(
    @Inject(ORGANIZATION_REFERENCE) private readonly reference: OrganizationReferenceResolver,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  async assertInScope(caller: string, organizationId: string): Promise<void> {
    const allowed = this.config.servicePolicy.of(caller)?.allowedPlatforms;
    const ref = await this.reference.resolve(organizationId);
    if (!allowed || !ref || !allowed.has(ref.platformId)) {
      this.log.warn(`organization_scope_denied caller=${caller} organizationId=${organizationId} reason=${!ref ? 'unresolved' : 'platform_out_of_scope'} correlationId=${getRequestContext()?.correlationId ?? '-'}`);
      throw organizationNotPermitted();
    }
  }
}
