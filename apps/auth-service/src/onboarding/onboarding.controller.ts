import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Actors, type AuthedRequest } from '../auth/auth.guard.js';
import { clientInfo } from '../common/client-info.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { ContactVerificationService } from './contact-verification.service.js';
import { ResolveJoinCodeDto, VerifyContactDto } from './dto.js';
import { OnboardingService } from './onboarding.service.js';

/**
 * Route classes:
 *   public            : POST onboarding/resolve
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
