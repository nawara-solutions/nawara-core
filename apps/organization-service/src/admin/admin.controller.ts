import { Body, Controller, Headers, Inject, Logger, Param, ParseUUIDPipe, Patch, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DbService, getRequestContext } from '@nawara/service-kit';
import { OrganizationAudit, humanActor, type DeniedOperation, type DeniedReason } from '../audit/organization-audit.js';
import { CompanyRepository } from '../companies/company.repository.js';
import { normaliseCreateOrganization, normaliseUpdateOrganization } from '../domain/organization-input.js';
import { normaliseCreatePlatform, normaliseUpdatePlatform } from '../domain/platform-input.js';
import { organizationError } from '../domain/errors.js';
import { requireIdempotencyKey } from '../idempotency/idempotency.service.js';
import { representOrganization, representPlatform } from '../common/representation.js';
import { OrganizationRepository } from '../organizations/organization.repository.js';
import { PlatformRepository } from '../platforms/platform.repository.js';
import { CreateOrganizationDto, OrganizationDto, UpdateOrganizationDto } from '../organizations/organization.dto.js';
import { CreatePlatformDto, PlatformDto, UpdatePlatformDto } from '../platforms/platform.dto.js';
import { ActorRecordService } from './actor-record.service.js';
import type { AuthGrantFacts, AuthGrantsClient } from './auth-grants-client.js';
import { AUTH_GRANTS_CLIENT, HumanActor, HumanAuthGuard, HumanBearer } from './human-auth.guard.js';
import { canCreateOrganization, canCreatePlatform, canUpdateOrganization, canUpdatePlatform } from './authorization-evaluator.js';

const STEP_UP_HEADER = 'x-step-up-token';

/**
 * Human administration of Platform and Organization (ADR-0042 decision 6, Amendment 1 A.1-A.2). Bearer
 * authentication of the END USER only — never a service credential (that is every other controller in
 * this service). Company creation is out of scope here: it is the dedicated provisioning identity's
 * job (ADR-0042 D1), not a human-admin capability, and Company metadata has no holder yet (OPEN-4).
 *
 * Sensitive operations (create Platform, create Organization) require a fresh step-up, verified through
 * Auth (`POST /auth/step-up/verify`) — not evaluated locally, and never satisfied by a client claim.
 * Ordinary metadata updates (Platform name, Organization metadata) are NOT sensitive (OPEN-3 default)
 * and need no step-up. Every mutation and every denial is recorded (ActorRecordService, ADR-0042
 * decision 9) before the response is returned.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(HumanAuthGuard)
@Controller('organization/admin')
export class AdminController {
  private readonly log = new Logger('Admin');
  constructor(
    private readonly platforms: PlatformRepository,
    private readonly organizations: OrganizationRepository,
    private readonly companies: CompanyRepository,
    private readonly actorRecord: ActorRecordService,
    @Inject(AUTH_GRANTS_CLIENT) private readonly authGrants: AuthGrantsClient,
    @Inject(DbService) private readonly db: DbService,
    @Inject(OrganizationAudit) private readonly audit: OrganizationAudit,
  ) {}

  private correlationId(): string | undefined {
    return getRequestContext()?.correlationId;
  }

  /**
   * Stage 18.7.3: a refused hierarchy operation writes its local `admin_actor_event` AND its central audit intent
   * (`hierarchy.admin_operation_denied`) in ONE transaction: both or neither; if they cannot be written, the request fails.
   */
  private async denied(actor: AuthGrantFacts, operation: string, target: { type: 'company' | 'platform' | 'organization'; id: string }, reason: DeniedReason): Promise<void> {
    await this.db.tx(async (q) => {
      await this.actorRecord.record({ actor, operation, targetType: target.type, targetId: target.id, correlationId: this.correlationId(), outcome: 'denied', reason }, q);
      await this.audit.denied(q, humanActor(actor), operation as DeniedOperation, target, reason);
    });
  }

  /** `target` is the parent the create was aimed at (company for a platform, platform for an organization): known here, so recorded, like the authority denial before it. */
  private async requireStepUp(actor: AuthGrantFacts, bearer: string, purpose: string, token: string | undefined, target: { type: 'company' | 'platform'; id: string }) {
    if (!token || !(await this.authGrants.verifyStepUp(bearer, purpose, token))) {
      await this.denied(actor, purpose, { type: target.type, id: target.id }, 'step_up_required');
      throw organizationError(403, 'step_up_required', 'A fresh step-up is required for this operation.');
    }
  }

  // ------------------------------------------------------------------------------------------- Platform

  @Post('platforms')
  @ApiOperation({ summary: 'Create a Platform under a Company (owner only, step-up required). Requires Idempotency-Key.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: STEP_UP_HEADER, required: true, description: 'A step-up proof for purpose "platform.create", verified through Auth.' })
  @ApiBody({ type: CreatePlatformDto })
  @ApiResponse({ status: 201, type: PlatformDto })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'admin_forbidden (not the company\'s owner) or step_up_required.' })
  @ApiResponse({ status: 404, description: 'company_not_found' })
  async createPlatform(
    @HumanActor() actor: AuthGrantFacts,
    @HumanBearer() bearer: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers(STEP_UP_HEADER) stepUpToken: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const input = normaliseCreatePlatform(body);
    const company = await this.companies.get(input.companyId); // 404 if unknown, before authority is even evaluated
    const authority = canCreatePlatform(actor, company);
    if (!authority) {
      await this.denied(actor, 'platform.create', { type: 'company', id: company.id }, 'no_authority');
      throw organizationError(403, 'admin_forbidden', 'Not authorized to create a platform for this company.');
    }
    await this.requireStepUp(actor, bearer, 'platform.create', stepUpToken, { type: 'company', id: company.id });
    // The success record is written inside the mutation's transaction (`within`): both commit, or neither does.
    const { platform, replayed } = await this.platforms.create(`user:${actor.userId}`, key, input, humanActor(actor), (q, p) =>
      this.actorRecord.record({ actor, operation: 'platform.create', targetType: 'platform', targetId: p.id, correlationId: this.correlationId(), outcome: 'succeeded', authority }, q));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    this.log.log(`admin_platform_created id=${platform.id} companyId=${platform.companyId} actor=${actor.userId}`);
    return representPlatform(platform);
  }

  @Patch('platforms/:id')
  @ApiOperation({ summary: 'Update a Platform\'s name (owner only; NOT sensitive, no step-up — OPEN-3 default).' })
  @ApiBody({ type: UpdatePlatformDto })
  @ApiResponse({ status: 200, type: PlatformDto })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'admin_forbidden' })
  @ApiResponse({ status: 404 })
  async updatePlatform(@HumanActor() actor: AuthGrantFacts, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const input = normaliseUpdatePlatform(body);
    const current = await this.platforms.get(id);
    const authority = canUpdatePlatform(actor, current);
    if (!authority) {
      await this.denied(actor, 'platform.update', { type: 'platform', id: id }, 'no_authority');
      throw organizationError(403, 'admin_forbidden', 'Not authorized to update this platform.');
    }
    const platform = await this.platforms.update(id, input, humanActor(actor), (q) =>
      this.actorRecord.record({ actor, operation: 'platform.update', targetType: 'platform', targetId: id, correlationId: this.correlationId(), outcome: 'succeeded', authority }, q));
    this.log.log(`admin_platform_updated id=${id} actor=${actor.userId}`);
    return representPlatform(platform);
  }

  // --------------------------------------------------------------------------------------- Organization

  @Post('organizations')
  @ApiOperation({ summary: 'Create an Organization under a Platform (owner, or an operator assigned to that platform; step-up required). Requires Idempotency-Key.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: STEP_UP_HEADER, required: true, description: 'A step-up proof for purpose "organization.create", verified through Auth. Operators have no step-up mechanism yet (deferred): this always denies operators today.' })
  @ApiBody({ type: CreateOrganizationDto })
  @ApiResponse({ status: 201, type: OrganizationDto })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'admin_forbidden or step_up_required.' })
  @ApiResponse({ status: 404, description: 'platform_not_found' })
  async createOrganization(
    @HumanActor() actor: AuthGrantFacts,
    @HumanBearer() bearer: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers(STEP_UP_HEADER) stepUpToken: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const input = normaliseCreateOrganization(body);
    const platform = await this.platforms.get(input.platformId); // 404 if unknown, before authority is even evaluated
    const authority = canCreateOrganization(actor, platform);
    if (!authority) {
      await this.denied(actor, 'organization.create', { type: 'platform', id: platform.id }, 'no_authority');
      throw organizationError(403, 'admin_forbidden', 'Not authorized to create an organization on this platform.');
    }
    await this.requireStepUp(actor, bearer, 'organization.create', stepUpToken, { type: 'platform', id: platform.id });
    const { organization, replayed } = await this.organizations.create(`user:${actor.userId}`, key, input, humanActor(actor), (q, o) =>
      this.actorRecord.record({ actor, operation: 'organization.create', targetType: 'organization', targetId: o.id, correlationId: this.correlationId(), outcome: 'succeeded', authority }, q));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    this.log.log(`admin_organization_created id=${organization.id} platformId=${organization.platformId} actor=${actor.userId}`);
    return representOrganization(organization);
  }

  @Patch('organizations/:id')
  @ApiOperation({ summary: 'Update an Organization\'s metadata (owner, assigned operator, or organization admin; NOT sensitive, no step-up).' })
  @ApiBody({ type: UpdateOrganizationDto })
  @ApiResponse({ status: 200, type: OrganizationDto })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'admin_forbidden' })
  @ApiResponse({ status: 404 })
  async updateOrganization(@HumanActor() actor: AuthGrantFacts, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const input = normaliseUpdateOrganization(body);
    const current = await this.organizations.get(id);
    const platform = await this.platforms.get(current.platformId);
    const authority = canUpdateOrganization(actor, current, platform);
    if (!authority) {
      await this.denied(actor, 'organization.update', { type: 'organization', id: id }, 'no_authority');
      throw organizationError(403, 'admin_forbidden', 'Not authorized to update this organization.');
    }
    const organization = await this.organizations.update(id, input, humanActor(actor), (q) =>
      this.actorRecord.record({ actor, operation: 'organization.update', targetType: 'organization', targetId: id, correlationId: this.correlationId(), outcome: 'succeeded', authority }, q));
    this.log.log(`admin_organization_updated id=${id} actor=${actor.userId}`);
    return representOrganization(organization);
  }
}
