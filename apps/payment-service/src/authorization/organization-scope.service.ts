import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { ORGANIZATION_REFERENCE, getRequestContext, type OrganizationReferenceResolver } from '@nawara/service-kit';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import type { PaymentConfig } from '../config/payment-config.js';

/** One answer for an Organization that does not exist and one outside the caller's scope: no existence oracle. */
export const organizationNotPermitted = () =>
  new HttpException({ message: 'The organization is not within the calling service\'s scope.', code: 'organization_not_permitted' }, 403);

/**
 * Stage 21.C.2 (ADR-0052 decision 3; ADR-0042 decision 5, A.3, A.5): an Organization a SERVICE caller names on a create is resolved through
 * Organization Service (the only authority; memoized positively) and must belong to a Platform inside the caller's explicit
 * `allowedPlatforms`. Unknown, or outside Payment's own credential scope at Organization Service, or outside the caller's Platforms: 403
 * `organization_not_permitted`. The authority unable to answer (before the cutover: `409 not_authoritative`): 503 `hierarchy_unavailable`,
 * thrown by the resolver. Either way the caller has written nothing. Called OUTSIDE any database transaction.
 */
@Injectable()
export class OrganizationScopeService {
  private readonly log = new Logger(OrganizationScopeService.name);

  constructor(
    @Inject(ORGANIZATION_REFERENCE) private readonly reference: OrganizationReferenceResolver,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
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
