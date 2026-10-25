import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, HttpCode, HttpException, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { SERVICE_TOKENS, hashServiceToken, type ServiceTokenEntry } from '@nawara/service-kit';
import { LegalHoldService, type PlacedHold, type ReleasedHold } from './legal-hold.service.js';

class PlaceHoldBody {
  @ApiProperty({ format: 'uuid', description: 'A fresh, factor-only step-up proof of purpose audit.legal_hold.place (single use)' }) stepUpToken!: string;
  @ApiProperty({ pattern: '^[a-z][a-z0-9_]{0,63}$', description: 'A bounded reason code, never free text' }) reasonCode!: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Occurrence window start (inclusive); with `to`, or neither' }) from?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Occurrence window end (exclusive); with `from`, or neither' }) to?: string;
}
class ReleaseHoldBody {
  @ApiProperty({ format: 'uuid', description: 'A fresh, factor-only step-up proof of purpose audit.legal_hold.release (single use)' }) stepUpToken!: string;
  @ApiProperty({ pattern: '^[a-z][a-z0-9_]{0,63}$' }) reasonCode!: string;
}
class PlacedHoldDto {
  @ApiProperty({ format: 'uuid' }) holdId!: string;
  @ApiProperty({ format: 'uuid', description: 'The owner\'s Company, from Auth' }) companyId!: string;
  @ApiProperty() reasonCode!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) from!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) to!: string | null;
  @ApiProperty({ format: 'date-time' }) placedAt!: string;
}
class ReleasedHoldDto {
  @ApiProperty({ format: 'uuid' }) holdId!: string;
  @ApiProperty({ format: 'date-time' }) releasedAt!: string;
}

/**
 * Core V2 S2-Audit.4 (register AUD-05; OD-13 resolved, Owner decisions H1 to H7): an active Company Owner places or releases a legal hold on
 * their Company's TRUSTED audit evidence, with their own bearer and a fresh factor-only step-up. A hold covers ONLY records with a trusted
 * Company scope row for that Company (written for broker-verified deliveries), within the optional occurrence window: unverified, unscoped
 * and historical records without trusted Company scope are NOT covered. It has no expiry. A service token is refused here.
 */
@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit/owner/company/legal-holds')
export class LegalHoldController {
  constructor(
    @Inject(LegalHoldService) private readonly holds: LegalHoldService,
    @Inject(SERVICE_TOKENS) private readonly serviceTokens: ServiceTokenEntry[],
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'AUD-05: place a legal hold on the caller\'s Company\'s trusted audit evidence (Company owner, factor step-up audit.legal_hold.place)', description: 'Covers only records with a trusted Company scope row (broker-verified producers), optionally within [from, to) on occurrence time. Unverified, unscoped and historical records are not covered. No expiry: until released.' })
  @ApiBody({ type: PlaceHoldBody })
  @ApiResponse({ status: 201, type: PlacedHoldDto })
  @ApiResponse({ status: 400, description: 'invalid_request' })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer (a service token is refused here)' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed (not a Company owner) | step_up_required (missing, used, expired or other-purpose proof)' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  @ApiResponse({ status: 503, description: 'Auth could not be asked, or the hold could not be stored and recorded: nothing changed (a fresh step-up is needed)' })
  async place(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<PlacedHold> {
    res.setHeader('Cache-Control', 'no-store');
    return this.holds.place(this.humanBearer(req), body);
  }

  @Post(':holdId/release')
  @HttpCode(200)
  @ApiOperation({ summary: 'AUD-05: release ONE active legal hold of the caller\'s Company (Company owner, factor step-up audit.legal_hold.release)' })
  @ApiParam({ name: 'holdId', format: 'uuid' })
  @ApiBody({ type: ReleaseHoldBody })
  @ApiResponse({ status: 200, type: ReleasedHoldDto })
  @ApiResponse({ status: 400, description: 'invalid_request' })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer (a service token is refused here)' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed | step_up_required' })
  @ApiResponse({ status: 404, description: 'No such active hold of your Company (unknown, another Company\'s, or already released): indistinguishable' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  @ApiResponse({ status: 503, description: 'Auth could not be asked, or the release could not be stored and recorded: the hold stays active' })
  async release(@Param('holdId') holdId: string, @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ReleasedHold> {
    res.setHeader('Cache-Control', 'no-store');
    return this.holds.release(this.humanBearer(req), holdId, body);
  }

  /** The caller's own bearer; a service token (any configured digest, compared in constant time) is refused and never sent to Auth. */
  private humanBearer(req: Request): string {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._~+/=-]{1,4096})$/.exec(header) : null;
    const unauthenticated = new HttpException({ message: 'Unauthorized', code: 'unauthenticated' }, 401);
    if (!match) throw unauthenticated;
    const presented = Buffer.from(hashServiceToken(match[1]!), 'hex');
    let service = false;
    for (const e of this.serviceTokens) if (timingSafeEqual(presented, Buffer.from(e.digest, 'hex'))) service = true;
    if (service) throw unauthenticated;
    return match[1]!;
  }
}
