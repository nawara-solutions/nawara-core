import { CanActivate, Controller, ExecutionContext, Get, Header, Injectable, Logger, Param, ParseUUIDPipe, Query, UnauthorizedException, UseGuards, createParamDecorator } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProperty, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthIdentity } from '@nawara/service-kit';
import { MemberVerifier } from '../auth/verified-member.js';
import { decodeCursor, parseLimit } from '../common/pagination.js';
import { billingError } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';
import { MemberPersonalSubscriptionsService } from './member-personal-subscriptions.service.js';

type MemberRequest = Request & { personalSubscriptionsMember?: AuthIdentity };

/**
 * BIL-12 (D-B4): the caller's OWN bearer, verified live through `/auth/me` on every request, by BIL-10's member rule (`MemberVerifier`):
 * 401 for no, a malformed, an unknown or a revoked bearer and for a service token (never forwarded to Auth); 403 `member_not_eligible`
 * for an inactive user, an Owner or an Operator; Auth unavailable is the kit client's 503. No membership is required.
 */
@Injectable()
export class PersonalSubscriptionsMemberGuard implements CanActivate {
  private readonly log = new Logger('BillingPersonalSubscriptionsAuthorization');

  constructor(private readonly members: MemberVerifier) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<MemberRequest>();
    const check = await this.members.check(req.headers.authorization);
    if (check.ok) {
      req.personalSubscriptionsMember = check.identity;
      return true;
    }
    if (check.reason === 'no_bearer' || check.reason === 'unknown_bearer') throw new UnauthorizedException();
    this.log.warn(`billing_personal_subscriptions_denied reason=${check.reason}`);
    if (check.reason === 'service_credential') throw new UnauthorizedException();
    throw billingError(403, 'member_not_eligible', BILLING_MESSAGES.memberNotEligible);
  }
}

const VerifiedMember = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthIdentity => ctx.switchToHttp().getRequest<MemberRequest>().personalSubscriptionsMember!);

class MemberPersonalSubscriptionDto {
  @ApiProperty({ format: 'uuid', description: 'A personal subscription product of the Platform in the path.' }) productId!: string;
  @ApiProperty({ description: 'B6\'s answer at the instant of this request: whether a kept paid period covers it (no grace).' }) valid!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'B6\'s answer: the exclusive end of the uninterrupted paid run covering this instant; null when not valid.' }) expiresAt!: string | null;
}

class MemberPersonalSubscriptionsPageDto {
  @ApiProperty({ type: [MemberPersonalSubscriptionDto], description: 'Newest subscription first; expired, reversed and held subscriptions included.' }) items!: MemberPersonalSubscriptionDto[];
  @ApiProperty({ type: String, nullable: true, description: 'Opaque; pass it as `cursor` for the next page. Null on the last page.' }) nextCursor!: string | null;
}

/**
 * Core V2 BIL-12 (register BIL-12; the Owner's D-B1 to D-B7, 2026-11-01): the member's own Personal Subscriptions on one Platform.
 * INFORMATIONAL ONLY: never the authority for application access, which stays B6 (BIL-11, service-token only). The user is the verified
 * member, never a path, query or cursor value; an unknown, unconfigured or other tenant's Platform is the caller's empty result.
 * Development and simulation only: never mounted in production (`MemberPersonalSubscriptionsModule`).
 */
@ApiTags('entitlement')
@ApiBearerAuth()
@Controller('billing/me/platforms')
@UseGuards(PersonalSubscriptionsMemberGuard) // the verified member BEFORE the path and query are read
export class MemberPersonalSubscriptionsController {
  constructor(private readonly reads: MemberPersonalSubscriptionsService) {}

  @Get(':platformId/personal-subscriptions')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Your own personal subscriptions on one Platform, with their current validity (informational; simulation and development only).',
    description: 'Every personal subscription recorded for you on this Platform, newest first, each with B6\'s `valid` and `expiresAt` at one instant. ' +
      'Not an access decision: products decide access through the service-only entitlement read. No membership is required.',
  })
  @ApiParam({ name: 'platformId', format: 'uuid' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100; default 20.' })
  @ApiQuery({ name: 'cursor', required: false, description: 'The previous page\'s nextCursor.' })
  @ApiResponse({ status: 200, type: MemberPersonalSubscriptionsPageDto })
  @ApiResponse({ status: 400, description: 'platformId is not a UUID, limit is outside 1-100, or cursor is not one Billing issued' })
  @ApiResponse({ status: 401, description: 'no bearer, a bearer Auth refuses, or a SERVICE token (never forwarded)' })
  @ApiResponse({ status: 403, description: 'member_not_eligible: inactive, or an Owner or Operator' })
  @ApiResponse({ status: 503, description: 'Auth could not verify you; nothing was read' })
  async list(@VerifiedMember() member: AuthIdentity, @Param('platformId', new ParseUUIDPipe()) platformId: string, @Query() query: Record<string, unknown>) {
    const limit = parseLimit(query.limit);
    const cursor = typeof query.cursor === 'string' && query.cursor !== '' ? decodeCursor(query.cursor) : null;
    return this.reads.page(member.id, platformId.toLowerCase(), limit, cursor, new Date());
  }
}
