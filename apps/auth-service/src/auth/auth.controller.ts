import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { clientInfo } from '../common/client-info.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DbService } from '../db/db.service.js';
import { notFound } from '../errors.js';
import { StepUpService, type StepUpPurpose } from '../owner/step-up.service.js';
import { PlatformAccessService } from '../platform/platform-access.service.js';
import { Actors, type AuthedRequest } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { GrantsService } from './grants.service.js';
import { ResolveJoinCodeDto } from '../onboarding/dto.js';
import { LoginDto, RefreshDto, RegisterDto, VerifyStepUpDto } from './dto.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PlatformAccessService) private readonly access: PlatformAccessService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(StepUpService) private readonly stepUp: StepUpService,
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private client(req: Request) {
    return clientInfo(req, this.cfg.trustProxy);
  }

  /** public */
  @Post('register')
  @ApiOperation({ summary: 'Register a member with an organization join code (public). Always kind=member; organization, platform and audience come from the code.' })
  @ApiResponse({ status: 201, description: 'Tokens plus the onboarding context (audience, membership status, hints).' })
  @ApiResponse({ status: 403, description: 'Bad, expired or exhausted join code (same response for every case, since Stage 12.1: no commercial/entitlement check runs here).' })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, this.client(req));
  }

  /** authenticated member */
  @Post('onboarding/join')
  @Actors('member')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Join ANOTHER organization with a join code, using the existing account (one identity, many organizations).' })
  @ApiResponse({ status: 201, description: 'The onboarding context (membership pending or active). Creates no account; other memberships and the session are untouched.' })
  @ApiResponse({ status: 403, description: 'Bad, expired or exhausted join code (same response for every case, since Stage 12.1: no commercial/entitlement check runs here).' })
  @ApiResponse({ status: 409, description: 'You already have a membership in that organization.' })
  join(@Body() dto: ResolveJoinCodeDto, @Req() req: AuthedRequest) {
    return this.auth.join(req.actor.userId, dto, this.client(req));
  }

  /** public */
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email/phone + password. Members get tokens; owners get a second-factor challenge.' })
  @ApiResponse({ status: 200, description: 'Tokens, or an owner mfa_required / enrollment_required challenge.' })
  @ApiResponse({ status: 401, description: 'Generic failure.' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, this.client(req));
  }

  /** public (the refresh token is the credential) */
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate a refresh token. Reuse of a rotated token revokes the whole session.' })
  @ApiResponse({ status: 200, description: 'New token pair.' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refreshSession(dto.refreshToken, this.client(req));
  }

  /** authenticated (any kind) */
  @Post('logout')
  @HttpCode(204)
  @Actors()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the session of the given refresh token.' })
  async logout(@Body() dto: RefreshDto, @Req() req: AuthedRequest) {
    await this.auth.logout(req.actor.userId, dto.refreshToken);
  }

  /** authenticated (any kind) */
  @Get('me')
  @Actors()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The authenticated identity.' })
  me(@Req() req: AuthedRequest) {
    return this.auth.me(req.actor.userId);
  }

  /** authenticated (any kind) — ADR-0042 decision 6: server-derived authorization facts for a
   *  service (e.g. organization-service) evaluating this caller's human administrative authority.
   *  Bearer-authenticated only; Auth has no service-token callee side for this. */
  @Get('grants')
  @Actors()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Server-derived authorization facts for the authenticated caller (ADR-0042 decision 6). Not a general identity/profile API.' })
  @ApiResponse({ status: 200, description: 'Company ownership (owner), active Platform assignments (operator), active org-admin memberships (member) — whichever apply to this caller\'s kind.' })
  grantsForCaller(@Req() req: AuthedRequest) {
    return this.grants.forUser(req.actor.userId);
  }

  /** authenticated (any kind) — ADR-0042 Amendment 1 A.1: verifies and consumes a step-up proof on
   *  behalf of a caller service (e.g. organization-service), for the user whose bearer is presented
   *  here. Only owners hold a step-up today (operator step-up is a separate, not-yet-built extension);
   *  a non-owner caller is denied because no owner_step_up row can exist for them. */
  @Post('step-up/verify')
  @HttpCode(204)
  @Actors()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify and consume a step-up proof for the named purpose, for the authenticated caller (ADR-0042 Amendment 1 A.1). Single-use, session-bound, purpose-bound, short-lived.' })
  @ApiResponse({ status: 204, description: 'Verified and consumed.' })
  @ApiResponse({ status: 403, description: 'Missing, expired, reused, wrong-purpose or wrong-session step-up.' })
  async verifyStepUp(@Body() dto: VerifyStepUpDto, @Req() req: AuthedRequest) {
    await this.db.tx((q) =>
      this.stepUp.consume(q, { ownerId: req.actor.userId, sid: req.actor.sid, purpose: dto.purpose as StepUpPurpose, token: dto.stepUpToken }),
    );
  }

  /** authenticated member: tenancy check other services can rely on */
  @Get('organizations/:id/membership')
  @HttpCode(204)
  @Actors('member')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Does the calling member belong to this organization? 204, else 404.' })
  async membership(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    if (!(await this.access.memberBelongsTo(req.actor.userId, id))) throw notFound();
  }
}
