import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Actors, type AuthedRequest } from '../auth/auth.guard.js';
import { clientInfo } from '../common/client-info.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { ContactVerificationService } from './contact-verification.service.js';
import { AcceptInvitationDto, ResolveInvitationDto, ResolveJoinCodeDto, VerifyContactDto } from './dto.js';
import { InvitationService } from './invitation.service.js';
import { OnboardingService } from './onboarding.service.js';

/**
 * Route classes:
 *   public            : POST onboarding/resolve, POST onboarding/invitations/resolve, POST onboarding/invitations/accept
 *   member (live)     : POST contact/request-code, POST contact/verify
 * Registration itself is POST /auth/register (AuthController).
 */
@ApiTags('onboarding')
@Controller('auth')
export class OnboardingController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
    @Inject(ContactVerificationService) private readonly contact: ContactVerificationService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
  ) {}

  private client(req: Request) {
    return clientInfo(req, this.cfg.trustProxy);
  }

  /** public */
  @Post('onboarding/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resolve an organization join code to a safe onboarding context (public, rate limited).' })
  @ApiResponse({ status: 200, description: 'Platform, organization, audience and the approval/subscription hints derived by the server.' })
  @ApiResponse({ status: 404, description: 'Invalid or expired code — one generic answer for every reason.' })
  @ApiResponse({ status: 429, description: 'Too many attempts.' })
  resolve(@Body() dto: ResolveJoinCodeDto, @Req() req: Request) {
    return this.onboarding.resolve(dto.joinCode, this.client(req));
  }

  /** public — a DIFFERENT credential from a join code (ADR-0029) */
  @Post('onboarding/invitations/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resolve an administrator invitation to a safe context (public, rate limited).' })
  @ApiResponse({ status: 200, description: 'Platform, organization, opaque invitation type, whether it is bound to a contact, expiry.' })
  @ApiResponse({ status: 404, description: 'Invalid, expired, revoked or already used invitation — one generic answer.' })
  @ApiResponse({ status: 429, description: 'Too many attempts.' })
  resolveInvitation(@Body() dto: ResolveInvitationDto, @Req() req: Request) {
    return this.invitations.resolve(dto.invitationCode, this.client(req));
  }

  /** public */
  @Post('onboarding/invitations/accept')
  @ApiOperation({ summary: 'Accept an administrator invitation: creates the account, an ACTIVE membership with the organization-management capability, and a normal session. Single use.' })
  @ApiResponse({ status: 201, description: 'Tokens plus the onboarding context. The invitation lifetime is unrelated to the session lifetime.' })
  @ApiResponse({ status: 403, description: 'Invitation cannot be accepted (any reason, including a contact that does not match a bound invitation).' })
  acceptInvitation(@Body() dto: AcceptInvitationDto, @Req() req: Request) {
    return this.invitations.accept(dto, this.client(req));
  }

  /** authenticated member */
  @Post('contact/request-code')
  @HttpCode(204)
  @Actors('member')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send a verification code to the member’s e-mail/phone. Always 204.' })
  async requestCode(@Req() req: AuthedRequest) {
    await this.contact.request(req.actor.userId, this.client(req));
  }

  /** authenticated member */
  @Post('contact/verify')
  @HttpCode(204)
  @Actors('member')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify the e-mail/phone with the delivered code (5 attempts).' })
  @ApiResponse({ status: 400, description: 'Invalid or expired code.' })
  async verify(@Body() dto: VerifyContactDto, @Req() req: AuthedRequest) {
    await this.contact.verify(req.actor.userId, dto.code, this.client(req));
  }
}
