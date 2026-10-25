import { Body, Controller, Get, Header, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { billingError } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';
import { normaliseBillingPlatformInput } from './billing-platform-input.js';
import { BillingPlatformRepository, representBillingPlatform } from './billing-platform.repository.js';
import type { VerifiedPlatformOwner } from './owner-authority.client.js';
import { PlatformOwner, PlatformOwnerGuard } from './owner.guard.js';

class CreateBillingPlatformDto {
  @ApiProperty({ description: "The Platform's one currency: an ISO 4217 code this deployment supports. The only field accepted." })
  currency!: string;
}

class BillingPlatformDto {
  @ApiProperty({ format: 'uuid' }) platformId!: string;
  @ApiProperty({ format: 'uuid', description: 'The Company Auth names for the verified Owner; never taken from the request. Immutable.' }) companyId!: string;
  @ApiProperty({ description: 'ISO 4217. Immutable.' }) currency!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

const PLATFORM = { name: 'platformId', format: 'uuid', description: 'A Platform of the calling Owner\'s Company (Auth decides, live).' };
const AUTH_401 = { status: 401, description: 'no bearer, a bearer Auth refuses (expired, revoked, blocked), or a SERVICE token (never forwarded to Auth)' };
const AUTH_403 = { status: 403, description: 'operation_not_permitted: the caller is not an Owner (an operator or a member: one answer)' };
const AUTH_404 = { status: 404, description: "not_found: the Platform is unknown, or not in the Owner's Company (one answer; never confirms another Company's Platform)" };
const AUTH_503 = { status: 503, description: 'auth_timeout | auth_unavailable: Auth could not verify the Owner or the Platform; nothing was changed' };

/**
 * Core V2 S3d (register BIL-01, AUTH-07; S0 §3.6): the Platform commercial configuration, `billing_platform`. Human only: the caller's own
 * Auth bearer, verified live as an Owner whose Company the Platform belongs to (`/auth/grants` then `/auth/platform-access`). No step-up
 * (the Owner's Q11 decision for S3d). No service, operator or member route.
 */
@ApiTags('platform configuration')
@ApiBearerAuth()
@Controller('billing/admin/platforms/:platformId')
@UseGuards(PlatformOwnerGuard) // the verified Owner BEFORE body validation
export class BillingPlatformsController {
  constructor(
    private readonly platforms: BillingPlatformRepository,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "Configure a Platform's billing: its Company (from Auth) and its one currency (Owner of the Platform's Company).",
    description: 'Written once and never changed. An identical repeat answers 200 with the existing configuration (Idempotent-Replayed: ' +
      'true); a different currency is 409 billing_platform_exists. A new subscription product requires its Platform to be configured, ' +
      'and its prices use this currency.',
  })
  @ApiParam(PLATFORM)
  @ApiBody({ type: CreateBillingPlatformDto })
  @ApiResponse({ status: 201, type: BillingPlatformDto, description: 'Configured.' })
  @ApiResponse({ status: 200, type: BillingPlatformDto, description: 'Identical repeat: nothing was written (Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_billing_platform_request: the body is not exactly {currency} with an ISO 4217 code; or a platformId that is not a uuid' })
  @ApiResponse(AUTH_401)
  @ApiResponse(AUTH_403)
  @ApiResponse(AUTH_404)
  @ApiResponse({ status: 409, description: "billing_platform_exists: this Owner's Platform is already configured with a different currency" })
  @ApiResponse({ status: 422, description: 'unsupported_currency: not a currency this deployment supports' })
  @ApiResponse(AUTH_503)
  async create(@PlatformOwner() owner: VerifiedPlatformOwner, @Param('platformId') platformId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { currency } = normaliseBillingPlatformInput(body);
    if (!this.config.supportedCurrencies.includes(currency)) throw billingError(422, 'unsupported_currency', BILLING_MESSAGES.currencyNotSupported);
    const { platform, changed } = await this.platforms.create(owner, platformId.toLowerCase(), currency);
    res.status(changed ? 201 : 200);
    if (!changed) res.setHeader('Idempotent-Replayed', 'true');
    return representBillingPlatform(platform);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "Read a Platform's billing configuration (Owner of the Platform's Company)." })
  @ApiParam(PLATFORM)
  @ApiResponse({ status: 200, type: BillingPlatformDto })
  @ApiResponse({ status: 400, description: 'a platformId that is not a uuid' })
  @ApiResponse(AUTH_401)
  @ApiResponse(AUTH_403)
  @ApiResponse({ status: 404, description: "not_found: not configured, unknown, or not in the Owner's Company (one answer)" })
  @ApiResponse(AUTH_503)
  async get(@PlatformOwner() owner: VerifiedPlatformOwner, @Param('platformId') platformId: string) {
    return representBillingPlatform(await this.platforms.findOwned(owner, platformId.toLowerCase()));
  }
}
