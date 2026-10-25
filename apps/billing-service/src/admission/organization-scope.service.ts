import { Inject, Injectable, Logger } from '@nestjs/common';
import { ORGANIZATION_REFERENCE, getRequestContext, httpError, type OrganizationReferenceResolver } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { BILLING_MESSAGES } from '../messages.js';

/** One answer for an Organization that does not exist and one outside the caller's scope: no existence oracle. */
export const organizationNotPermitted = () =>
  httpError(403, 'organization_not_permitted', BILLING_MESSAGES.organizationNotPermitted);

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

  /** Core V2 S3a: a Platform the caller names (a product's) must be one of its explicit `allowedPlatforms`. No call to any authority. */
  assertPlatformInScope(caller: string, platformId: string): void {
    if (this.config.servicePolicy.of(caller)?.allowedPlatforms.has(platformId)) return;
    this.log.warn(`platform_scope_denied caller=${caller} platformId=${platformId} correlationId=${getRequestContext()?.correlationId ?? '-'}`);
    throw httpError(403, 'platform_not_permitted', BILLING_MESSAGES.platformNotPermitted);
  }

  /**
   * Core V2 S3a: the Platform of an Organization (through the same authority as `assertInScope`), only when the Organization is in the
   * caller's scope; otherwise 403 `organization_not_permitted` (503 when the authority cannot answer).
   */
  async platformOf(caller: string, organizationId: string): Promise<string> {
    const allowed = this.config.servicePolicy.of(caller)?.allowedPlatforms;
    const ref = await this.reference.resolve(organizationId);
    if (!allowed || !ref || !allowed.has(ref.platformId)) throw organizationNotPermitted();
    return ref.platformId;
  }

  async assertInScope(caller: string, organizationId: string): Promise<void> {
    const allowed = this.config.servicePolicy.of(caller)?.allowedPlatforms;
    const ref = await this.reference.resolve(organizationId);
    if (!allowed || !ref || !allowed.has(ref.platformId)) {
      this.log.warn(`organization_scope_denied caller=${caller} organizationId=${organizationId} reason=${!ref ? 'unresolved' : 'platform_out_of_scope'} correlationId=${getRequestContext()?.correlationId ?? '-'}`);
      throw organizationNotPermitted();
    }
  }
}
