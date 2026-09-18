import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Actors, type AuthedRequest } from '../auth/auth.guard.js';
import { clientInfo } from '../common/client-info.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { CreateJoinCodeDto, ListMembershipsQuery } from '../onboarding/dto.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';
import { MembershipService } from './membership.service.js';

const STEP_UP = 'x-step-up-token';

/**
 * Organization administration (ADR-0028). Authority is decided per request from CURRENT state by
 * PlatformAccessService.organizationAuthority: an Owner of the organization's company, an Operator with
 * an active assignment on its platform, or a member holding an ACTIVE organization-admin membership of
 * that organization. Everything else is one collapsed 404.
 *
 *   owner|operator|org admin : join codes (create/list/revoke), memberships (list/approve/reject)
 *   owner + step-up          : grant/revoke organization admin; join-code create/revoke when the caller is an owner
 */
@ApiTags('organization-admin')
@ApiBearerAuth()
@Controller('auth/organizations/:organizationId')
export class OrganizationController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
    @Inject(MembershipService) private readonly memberships: MembershipService,
  ) {}

  private ip(req: Request) {
    return clientInfo(req, this.cfg.trustProxy).ip;
  }
  private actor(req: AuthedRequest) {
    return { userId: req.actor.userId, kind: req.actor.kind, sid: req.actor.sid };
  }

  @Post('join-codes')
  @Actors('owner', 'operator', 'member')
  @ApiHeader({ name: STEP_UP, required: false, description: 'Required when the caller is an Owner (purpose join_code.create).' })
  @ApiOperation({ summary: 'Create a join code. The plaintext is returned ONCE.' })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 404, description: 'No such organization, not yours, or not allowed — indistinguishable.' })
  createJoinCode(@Param('organizationId', ParseUUIDPipe) org: string, @Body() dto: CreateJoinCodeDto, @Req() req: AuthedRequest, @Headers(STEP_UP) su?: string) {
    return this.onboarding.create(this.actor(req), org, dto, su, this.ip(req));
  }

  @Get('join-codes')
  @Actors('owner', 'operator', 'member')
  @ApiOperation({ summary: 'List join codes (metadata only; plaintext is never recoverable).' })
  listJoinCodes(@Param('organizationId', ParseUUIDPipe) org: string, @Req() req: AuthedRequest) {
    return this.onboarding.list(this.actor(req), org);
  }

  @Post('join-codes/:codeId/revoke')
  @HttpCode(204)
  @Actors('owner', 'operator', 'member')
  @ApiHeader({ name: STEP_UP, required: false, description: 'Required when the caller is an Owner (purpose join_code.revoke).' })
  @ApiOperation({ summary: 'Revoke a join code (final).' })
  async revokeJoinCode(@Param('organizationId', ParseUUIDPipe) org: string, @Param('codeId', ParseUUIDPipe) codeId: string, @Req() req: AuthedRequest, @Headers(STEP_UP) su?: string) {
    await this.onboarding.revoke(this.actor(req), org, codeId, su, this.ip(req));
  }

  @Get('memberships')
  @Actors('owner', 'operator', 'member')
  @ApiOperation({ summary: 'List memberships by status (default pending).' })
  list(@Param('organizationId', ParseUUIDPipe) org: string, @Query() q: ListMembershipsQuery, @Req() req: AuthedRequest) {
    return this.memberships.listByStatus(this.actor(req), org, q.status ?? 'pending');
  }

  @Post('memberships/:membershipId/approve')
  @HttpCode(200)
  @Actors('owner', 'operator', 'member')
  @ApiOperation({ summary: 'Approve a pending membership (pending -> active). approvedBy is derived from the session.' })
  @ApiResponse({ status: 409, description: 'Already decided.' })
  approve(@Param('organizationId', ParseUUIDPipe) org: string, @Param('membershipId', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.memberships.decide(this.actor(req), org, id, 'approve', this.ip(req));
  }

  @Post('memberships/:membershipId/reject')
  @HttpCode(200)
  @Actors('owner', 'operator', 'member')
  @ApiOperation({ summary: 'Reject a pending membership (pending -> rejected).' })
  @ApiResponse({ status: 409, description: 'Already decided.' })
  reject(@Param('organizationId', ParseUUIDPipe) org: string, @Param('membershipId', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.memberships.decide(this.actor(req), org, id, 'reject', this.ip(req));
  }

  @Post('memberships/:membershipId/admin')
  @HttpCode(204)
  @Actors('owner')
  @ApiHeader({ name: STEP_UP, required: true, description: 'Purpose organization.admin.grant.' })
  @ApiOperation({ summary: 'Grant organization-admin authority to an ACTIVE member (owner + step-up only).' })
  async grantAdmin(@Param('organizationId', ParseUUIDPipe) org: string, @Param('membershipId', ParseUUIDPipe) id: string, @Req() req: AuthedRequest, @Headers(STEP_UP) su?: string) {
    await this.memberships.setAdmin(this.actor(req), org, id, true, su, this.ip(req));
  }

  @Delete('memberships/:membershipId/admin')
  @HttpCode(204)
  @Actors('owner')
  @ApiHeader({ name: STEP_UP, required: true, description: 'Purpose organization.admin.revoke.' })
  @ApiOperation({ summary: 'Revoke organization-admin authority (owner + step-up only).' })
  async revokeAdmin(@Param('organizationId', ParseUUIDPipe) org: string, @Param('membershipId', ParseUUIDPipe) id: string, @Req() req: AuthedRequest, @Headers(STEP_UP) su?: string) {
    await this.memberships.setAdmin(this.actor(req), org, id, false, su, this.ip(req));
  }
}
