import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Actors, type AuthedRequest } from '../auth/auth.guard.js';
import { clientInfo } from '../common/client-info.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { CreateAdminInvitationDto, CreateJoinCodeDto, ListMembershipsQuery } from '../onboarding/dto.js';
import { InvitationService } from '../onboarding/invitation.service.js';
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
 *   owner (step-up) | org admin : admin invitations (create/list/revoke, ADR-0029); OPERATORS are refused (same
 *                                 collapsed 404). An Owner needs a factor-only step-up; an org admin acts on the session.
 */
@ApiTags('organization-admin')
@ApiBearerAuth()
@Controller('auth/organizations/:organizationId')
export class OrganizationController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
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

  @Post('memberships/:membershipId/revoke')
  @HttpCode(200)
  @Actors('owner', 'operator', 'member')
  @ApiOperation({ summary: 'Revoke an ACTIVE membership (active -> revoked, final). Clears the organization-management capability in the same statement; only this organization is affected.' })
  @ApiResponse({ status: 409, description: 'Not an active membership.' })
  @ApiResponse({ status: 404, description: 'Unknown, not yours, your own membership, or (for an organization admin) another administrator.' })
  revoke(@Param('organizationId', ParseUUIDPipe) org: string, @Param('membershipId', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.memberships.revoke(this.actor(req), org, id, this.ip(req));
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

  // ------------------------------------------------------------------------- admin invitations (ADR-0029)
  @Post('admin-invitations')
  @Actors('owner', 'operator', 'member')
  @ApiHeader({ name: STEP_UP, required: false, description: 'Required when the caller is an Owner (purpose admin_invitation.create, factor only).' })
  @ApiOperation({ summary: 'Create an administrator invitation. The plaintext code is returned ONCE; the server computes expiresAt from expiresInMinutes.' })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 400, description: 'expiresInMinutes outside the configured range, reserved or malformed type.' })
  @ApiResponse({ status: 404, description: 'No such organization, not yours, or not allowed (operators are not allowed) — indistinguishable.' })
  createInvitation(@Param('organizationId', ParseUUIDPipe) org: string, @Body() dto: CreateAdminInvitationDto, @Req() req: AuthedRequest, @Headers(STEP_UP) su?: string) {
    return this.invitations.create(this.actor(req), org, dto, su, this.ip(req));
  }

  @Get('admin-invitations')
  @Actors('owner', 'operator', 'member')
  @ApiOperation({ summary: 'List administrator invitations: metadata and a derived status (active, consumed, revoked, expired); never the code.' })
  listInvitations(@Param('organizationId', ParseUUIDPipe) org: string, @Req() req: AuthedRequest) {
    return this.invitations.list(this.actor(req), org);
  }

  @Post('admin-invitations/:invitationId/revoke')
  @HttpCode(204)
  @Actors('owner', 'operator', 'member')
  @ApiHeader({ name: STEP_UP, required: false, description: 'Required when the caller is an Owner (purpose admin_invitation.revoke, factor only).' })
  @ApiOperation({ summary: 'Revoke an unused invitation immediately (final). An already used or revoked invitation is a 404.' })
  async revokeInvitation(@Param('organizationId', ParseUUIDPipe) org: string, @Param('invitationId', ParseUUIDPipe) id: string, @Req() req: AuthedRequest, @Headers(STEP_UP) su?: string) {
    await this.invitations.revoke(this.actor(req), org, id, su, this.ip(req));
  }
}
