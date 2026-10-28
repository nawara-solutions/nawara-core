import { Inject, Injectable } from '@nestjs/common';
import { DbService, ORGANIZATION_REFERENCE, type OrganizationReferenceResolver } from '@nawara/service-kit';
import { OrganizationScopeService } from '../admission/organization-scope.service.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { notFound } from '../domain/errors.js';
import { OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import { AssistanceAuthority } from './assistance-authority.js';
import { organizationRestrictions } from './assistance-restrictions.js';
import type { RestrictionReader } from './restriction-reader.guard.js';

/**
 * Core V2 S5d BIL-26 (S5D-6): `GET /billing/organizations/:organizationId/restrictions` → `{restrictions: [{kind, sourceId, since}]}`, from
 * the one authoritative model at the database's current clock. Read-only: it never creates, clears or caches a restriction. Authorized:
 *   1. an Owner (live `/auth/grants`) whose Company owns the Organization's Platform (Organization reference, then live
 *      `/auth/platform-access`);
 *   2. the Organization actor of exactly this Organization (live `/auth/me`, D-5);
 *   3. a service holding `restriction.read` (exact) whose explicit `allowedPlatforms` contain the Organization's Platform (403
 *      `organization_not_permitted` otherwise, the existing service-scope answer).
 * Every other human (a beneficiary, a revoked administrator, an operator, another Company's Owner) and an unknown Organization get the one
 * collapsed 404. Auth or the Organization reference unavailable: 503, nothing read. DEVELOPMENT AND SIMULATION ONLY (not mounted in
 * production; refused there too).
 */
@Injectable()
export class AssistanceRestrictionService {
  constructor(
    private readonly db: DbService,
    private readonly authority: AssistanceAuthority,
    private readonly scope: OrganizationScopeService,
    @Inject(ORGANIZATION_REFERENCE) private readonly reference: OrganizationReferenceResolver,
    @Inject(OWNER_AUTHORITY) private readonly owners: OwnerAuthority,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  async read(reader: RestrictionReader, organizationId: string) {
    if (this.config.isProduction) throw notFound();
    if (reader.kind === 'service') await this.scope.assertInScope(reader.service, organizationId);
    else if (!(await this.humanMayRead(reader, organizationId))) throw notFound();
    const rows = await organizationRestrictions(this.db, organizationId);
    return { restrictions: rows.map((r) => ({ kind: r.kind, sourceId: r.sourceId, since: r.since.toISOString() })) };
  }

  private async humanMayRead(reader: Extract<RestrictionReader, { kind: 'user' }>, organizationId: string): Promise<boolean> {
    if (reader.identity.adminTier === 'owner') {
      const deadline = AbortSignal.timeout(this.config.authTimeoutMs);
      if ((await this.owners.actor(reader.bearer, deadline)).kind !== 'owner') return false;
      const ref = await this.reference.resolve(organizationId); // 503 hierarchy_unavailable when it cannot answer
      return ref !== null && (await this.owners.platformAllowed(reader.bearer, ref.platformId, deadline));
    }
    return this.authority.isOrganizationActor(reader.identity, organizationId); // an operator tier is never one
  }
}
