import { Body, Controller, Get, Header, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RateLimitService, type AuthIdentity } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { requestTransitionContext } from '../domain/actors.js';
import { notFound } from '../domain/errors.js';
import { idempotencyKey } from '../fees/fee-input.js';
import type { AssistanceCommandResult } from './assistance-idempotency.js';
import { isAssistanceId, normaliseAssistanceCreateInput, normaliseCashCollectionInput, normaliseDeclineInput } from './assistance-input.js';
import { AssistanceUser, AssistanceUserGuard } from './assistance-user.guard.js';
import { AssistanceService } from './assistance.service.js';

class AssistanceCreateDto {
  @ApiProperty({ format: 'uuid', description: 'An Organization in which you hold an active membership.' }) organizationId!: string;
  @ApiProperty({ format: 'uuid', description: "An active personal subscription product of that Organization's Platform (the Owner's catalog)." }) productId!: string;
  @ApiProperty({ format: 'uuid', description: 'An effective, unretired recurring price of that product, in the Platform currency.' }) priceId!: string;
  @ApiProperty({ enum: [true], description: 'Required, literally true: your explicit consent to the frozen terms returned (base price plus the approved Organization fee).' }) consent!: boolean;
}

class CashCollectionDto {
  @ApiProperty({ format: 'date-time', description: 'When the cash was physically collected (RFC 3339 with a zone, at most milliseconds): no earlier than the consent, no later than now. Starts the 72-hour settlement deadline.' }) cashCollectedAt!: string;
}

class AssistanceRequestDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['pending', 'declined', 'cash_collected'] }) status!: string;
  @ApiProperty({ format: 'uuid' }) beneficiaryUserId!: string;
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
  @ApiProperty({ format: 'uuid' }) platformId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ format: 'uuid' }) priceId!: string;
  @ApiProperty({ description: 'The Platform currency (ISO 4217).' }) currency!: string;
  @ApiProperty({ description: "The product price, minor units (frozen at consent)." }) baseAmount!: number;
  @ApiProperty({ description: "The Organization's approved fee, minor units, 0 when none (frozen at consent)." }) feeAmount!: number;
  @ApiProperty({ description: 'baseAmount + feeAmount: what the beneficiary accepted and the Organization collects in cash.' }) totalAmount!: number;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) feeProposalId!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: "The Platform's fee-cap version the fee satisfied at consent." }) feeCapVersion!: number | null;
  @ApiProperty({ enum: [true] }) consent!: boolean;
  @ApiProperty({ format: 'date-time' }) consentAt!: string;
  @ApiProperty({ type: String, nullable: true, enum: ['beneficiary', 'organization_actor'] }) declinedByRole!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) declinedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'Asserted by the Organization actor.' }) cashCollectedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: "Billing's time of the report." }) reportedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'cashCollectedAt + 72 hours.' }) settleBy!: string | null;
  @ApiProperty({ description: "Derived now: unresolved and past settleBy. A cash report is never settlement." }) overdue!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

const KEY = { name: 'Idempotency-Key', required: true, description: 'Required: 8-128 of [A-Za-z0-9._:-], bound to you and this exact command. The same key and command replays the first success (Idempotent-Replayed: true); a different command with it is 409 idempotency_key_conflict.' };
const R401 = { status: 401, description: 'no bearer, a bearer Auth refuses, or a SERVICE token (never forwarded to Auth)' };
const R404 = { status: 404, description: 'an unknown request, or you are neither its beneficiary nor an administrator of its Organization (one answer)' };
const R503 = { status: 503, description: 'Auth or the Organization reference could not answer; nothing was read or changed' };
const ID = { name: 'id', format: 'uuid' };

function answer(res: Response, r: AssistanceCommandResult & { replayed: boolean }) {
  res.status(r.status);
  if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return r.body;
}

/**
 * Core V2 S5a Organization assistance (register BIL-13, BIL-14, BIL-15 and the assistance read; the Owner's D-1 to D-12). DEVELOPMENT AND
 * SIMULATION ONLY: this controller is not mounted in production (D-8, D-12). The caller is always their own live Auth identity
 * (guard, before any body is read); the beneficiary and the Organization actor are decided per request.
 */
@ApiTags('organization assistance')
@ApiBearerAuth()
@Controller('billing/assistance-requests')
@UseGuards(AssistanceUserGuard)
export class AssistanceController {
  constructor(
    private readonly assistance: AssistanceService,
    private readonly rateLimit: RateLimitService,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Request that an Organization pay for one personal product, consenting to its frozen terms (simulation and development only).',
    description: "Billing freezes the product's price, the Organization's approved fee (0 when none; refused above the Platform's current cap) " +
      'and their total; you consent to exactly those. Nothing is invoiced, paid or granted here: the Organization collects the total in cash and ' +
      'must later settle electronically (a later stage). One unresolved request per Organization and product.',
  })
  @ApiHeader(KEY)
  @ApiBody({ type: AssistanceCreateDto })
  @ApiResponse({ status: 201, type: AssistanceRequestDto, description: 'Created, pending.' })
  @ApiResponse({ status: 200, type: AssistanceRequestDto, description: 'A replay of this key (Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_assistance_request (consent must be true) | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'member_not_eligible: inactive, an Owner or Operator, or no active membership in that Organization on its Platform' })
  @ApiResponse({ status: 409, description: 'platform_not_configured | product_not_available | fee_not_usable | assistance_request_open | idempotency_key_conflict' })
  @ApiResponse({ status: 422, description: 'price_not_available' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  @ApiResponse(R503)
  async create(@AssistanceUser() user: AuthIdentity, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    const input = normaliseAssistanceCreateInput(body);
    await this.rateLimit.assert('billing-assistance', user.id, { limit: this.config.rateLimits.invoiceCreatePerMinute, windowSec: 60 });
    return answer(res, await this.assistance.create(user, k, input, requestTransitionContext({ type: 'user', id: user.id, userKind: 'member' })));
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read an assistance request: its beneficiary, or an administrator of its Organization (live).' })
  @ApiParam(ID)
  @ApiResponse({ status: 200, type: AssistanceRequestDto })
  @ApiResponse(R401)
  @ApiResponse(R404)
  @ApiResponse(R503)
  async read(@AssistanceUser() user: AuthIdentity, @Param('id') id: string) {
    if (!isAssistanceId(id)) throw notFound();
    return this.assistance.read(user, id.toLowerCase());
  }

  @Post(':id/decline')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Decline a pending assistance request (its beneficiary, or an administrator of its Organization). Final.' })
  @ApiParam(ID)
  @ApiHeader(KEY)
  @ApiResponse({ status: 200, type: AssistanceRequestDto, description: 'Declined (or a replay of this key).' })
  @ApiResponse({ status: 400, description: 'invalid_assistance_request (no body is accepted) | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse(R404)
  @ApiResponse({ status: 409, description: 'assistance_request_not_pending | idempotency_key_conflict' })
  @ApiResponse(R503)
  async decline(@AssistanceUser() user: AuthIdentity, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    normaliseDeclineInput(body);
    if (!isAssistanceId(id)) throw notFound();
    return answer(res, await this.assistance.decline(user, k, id.toLowerCase(), requestTransitionContext({ type: 'user', id: user.id, userKind: 'member' })));
  }

  @Post(':id/cash-collection')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "Report the physical collection of the request's full frozen total in cash (an administrator of its Organization, never its beneficiary).",
    description: 'Evidence only: starts the 72-hour electronic settlement deadline (settleBy). It never settles, activates, pays or grants anything. Once per request.',
  })
  @ApiParam(ID)
  @ApiHeader(KEY)
  @ApiBody({ type: CashCollectionDto })
  @ApiResponse({ status: 200, type: AssistanceRequestDto, description: 'Reported (or a replay of this key): reportedAt, settleBy and overdue.' })
  @ApiResponse({ status: 400, description: 'invalid_assistance_request | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: you are the beneficiary of this request' })
  @ApiResponse(R404)
  @ApiResponse({ status: 409, description: 'cash_collection_already_reported | assistance_request_not_pending | idempotency_key_conflict' })
  @ApiResponse({ status: 422, description: 'cash_collection_time_invalid: before the consent or in the future' })
  @ApiResponse(R503)
  async reportCashCollection(@AssistanceUser() user: AuthIdentity, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    const input = normaliseCashCollectionInput(body);
    if (!isAssistanceId(id)) throw notFound();
    return answer(res, await this.assistance.reportCashCollection(user, k, id.toLowerCase(), input, requestTransitionContext({ type: 'user', id: user.id, userKind: 'member' })));
  }
}
