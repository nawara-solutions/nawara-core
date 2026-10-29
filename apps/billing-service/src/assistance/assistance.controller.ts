import { Body, Controller, Get, Header, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RateLimitService, RequireServiceOperation, ServiceOperationGuard, resolveLocale, type AuthIdentity } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { requestTransitionContext } from '../domain/actors.js';
import { notFound } from '../domain/errors.js';
import { idempotencyKey } from '../fees/fee-input.js';
import type { AssistanceCommandResult } from './assistance-idempotency.js';
import {
  CORRECTABLE_FIELDS, CORRECTION_REASONS, DISPUTE_POSITIONS, DISPUTE_REASONS, RESOLUTION_OUTCOMES, isAssistanceId, normaliseAssistanceCreateInput, normaliseCashCollectionInput,
  normaliseCashReturnInput, normaliseCorrectionInput, normaliseDeclineInput, normaliseDisputeInput, normaliseDisputeResponseInput, normaliseResolutionInput,
} from './assistance-input.js';
import { AssistanceOwner, AssistanceOwnerGuard } from './assistance-owner.guard.js';
import { AssistanceResolutionService, type VerifiedAssistanceOwner } from './assistance-resolution.service.js';
import { AssistanceRestrictionService } from './assistance-restriction.service.js';
import { RESTRICTION_KINDS } from './assistance-restrictions.js';
import { AssistanceSettlementService } from './assistance-settlement.service.js';
import { Reader, RestrictionReaderGuard, type RestrictionReader } from './restriction-reader.guard.js';
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
  @ApiProperty({ enum: ['pending', 'declined', 'cash_collected', 'settled', 'returned'], description: 'returned (Core V2 S5c): the beneficiary confirmed the full cash back; resolved.' }) status!: string;
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

class SettlementResultDto {
  @ApiProperty({ format: 'uuid' }) invoiceId!: string;
  @ApiProperty({ format: 'uuid', description: 'Read the request (GET /billing/assistance-requests/{id}) for its progress.' }) paymentRequestId!: string;
  @ApiProperty({ type: String, nullable: true, description: 'null until Payment supplies an identifier; never invented.' }) paymentId!: string | null;
}

class CashReturnDto {
  @ApiProperty({ format: 'date-time', description: 'When the full cash was returned (RFC 3339 with a zone, at most milliseconds): no earlier than the collection, no later than now.' }) returnedAt!: string;
}

class CashReturnObligationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) assistanceRequestId!: string;
  @ApiProperty({ enum: ['open', 'return_reported', 'confirmed_returned'], description: 'confirmed_returned (Core V2 S5c): only the beneficiary confirms; a report alone never discharges.' }) status!: string;
  @ApiProperty({ description: 'The frozen total (base + Organization fee), minor units.' }) amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ format: 'date-time' }) openedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) returnedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) returnReportedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: "returnedAt after the Owner's corrections, if any (derived; the original stays)." }) effectiveReturnedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: "The beneficiary's confirmation (Billing's time)." }) confirmedAt!: string | null;
}

class DisputeCreateDto {
  @ApiProperty({ enum: DISPUTE_REASONS, description: 'cash_not_returned needs a cash-return obligation; return_time_incorrect a reported return. No free text.' }) reasonCode!: string;
}

class DisputeResponseCreateDto {
  @ApiProperty({ enum: DISPUTE_POSITIONS }) position!: string;
}

class DisputeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) assistanceRequestId!: string;
  @ApiProperty({ enum: DISPUTE_REASONS }) reasonCode!: string;
  @ApiProperty({ enum: ['open', 'resolved'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) openedAt!: string;
  @ApiProperty({ description: 'Derived: open for more than seven days. An escalation target only; it closes nothing.' }) escalationDue!: boolean;
  @ApiProperty({ nullable: true, description: "The Organization's answer {position, respondedAt}, evidence only." }) response!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, description: "The Owner's nonfinancial resolution {outcome: timestamp_corrected, correctionId, resolvedAt}." }) resolution!: Record<string, unknown> | null;
}

class CorrectionCreateDto {
  @ApiProperty({ enum: CORRECTABLE_FIELDS, description: 'An Organization-asserted time that was reported. Nothing monetary is correctable.' }) field!: string;
  @ApiProperty({ format: 'date-time', description: 'The corrected instant (RFC 3339 with a zone, at most milliseconds); it must keep the recorded time order.' }) value!: string;
  @ApiProperty({ enum: CORRECTION_REASONS }) reasonCode!: string;
}

class CorrectionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) assistanceRequestId!: string;
  @ApiProperty({ description: 'The order corrections of this request apply in.' }) sequence!: number;
  @ApiProperty({ enum: CORRECTABLE_FIELDS }) field!: string;
  @ApiProperty({ format: 'date-time' }) correctedValue!: string;
  @ApiProperty({ format: 'date-time', description: 'The effective value this correction supersedes (kept on record).' }) supersededValue!: string;
  @ApiProperty({ enum: CORRECTION_REASONS }) reasonCode!: string;
  @ApiProperty({ format: 'date-time' }) correctedAt!: string;
}

class ResolutionCreateDto {
  @ApiProperty({ enum: RESOLUTION_OUTCOMES, description: 'The only outcome Core V2 S5c admits: nonfinancial.' }) outcome!: string;
  @ApiProperty({ format: 'uuid', description: 'An Owner correction of exactly the disputed time, appended after the dispute opened.' }) correctionId!: string;
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
    private readonly settlement: AssistanceSettlementService,
    private readonly resolution: AssistanceResolutionService,
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
  @ApiResponse({ status: 409, description: 'assistance_restricted (Core V2 S5d: the Organization is under T1 and/or T2; the body adds `restrictions` (every kind, deterministic) and `restriction` (the first); kinds only) | platform_not_configured | product_not_available | fee_not_usable | assistance_request_open | idempotency_key_conflict' })
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

  @Post(':id/settlement')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "Start the Organization's electronic settlement of an assistance request (an administrator of its Organization, never its beneficiary).",
    description: 'Only after cash collection and before settleBy. Creates and issues an invoice paid by the Organization for the frozen BASE price only ' +
      '(never the Organization fee), routed assisted_settlement to the beneficiary, and its payment request; Payment is contacted asynchronously ' +
      '(paymentId is null until Payment supplies one). The administrator then pays it at Payment. Only Payment\'s verified success records the ' +
      "beneficiary's purchase; nothing here settles, activates or grants anything. One open or uncertain settlement at a time.",
  })
  @ApiParam(ID)
  @ApiHeader(KEY)
  @ApiResponse({ status: 201, type: SettlementResultDto, description: 'Started (or a replay of this key, Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_assistance_request (no body is accepted) | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: you are the beneficiary of this request' })
  @ApiResponse(R404)
  @ApiResponse({ status: 409, description: 'assistance_request_not_settleable (not cash_collected, past settleBy, purchased or a cash-return obligation exists) | settlement_channel_open | idempotency_key_conflict' })
  @ApiResponse(R503)
  async settle(@AssistanceUser() user: AuthIdentity, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Headers('accept-language') acceptLanguage: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    normaliseDeclineInput(body);
    if (!isAssistanceId(id)) throw notFound();
    return answer(res, await this.settlement.settle(user, k, id.toLowerCase(), resolveLocale(acceptLanguage), requestTransitionContext({ type: 'user', id: user.id, userKind: 'member' })));
  }
  @Post(':id/disputes')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "Dispute the cash evidence of your assistance request (its beneficiary only; no filing cutoff).",
    description: 'Core V2 S5c (H-4, J-1 to J-4). One open dispute per request. While open it blocks the confirmation of a cash return; it never ' +
      'blocks a verified electronic settlement or the obligation sweep, and it changes no financial fact. Seven days open is an escalation ' +
      'target only (escalationDue). Simulation and development only.',
  })
  @ApiParam(ID)
  @ApiHeader(KEY)
  @ApiBody({ type: DisputeCreateDto })
  @ApiResponse({ status: 201, type: DisputeDto, description: 'Opened (or a replay of this key, Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_assistance_request | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: you administer the Organization but are not the beneficiary' })
  @ApiResponse(R404)
  @ApiResponse({ status: 409, description: 'dispute_not_permitted (no recorded evidence of that kind) | assistance_dispute_open | idempotency_key_conflict' })
  @ApiResponse(R503)
  async openDispute(@AssistanceUser() user: AuthIdentity, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    const input = normaliseDisputeInput(body);
    if (!isAssistanceId(id)) throw notFound();
    return answer(res, await this.resolution.openDispute(user, k, id.toLowerCase(), input, requestTransitionContext({ type: 'user', id: user.id, userKind: 'member' })));
  }
}

/** Core V2 S5b (register BIL-17; the Owner's E-8, E-9): an Organization's cash-return obligation to a beneficiary. Simulation only, as above. */
@ApiTags('organization assistance')
@ApiBearerAuth()
@Controller('billing/cash-return-obligations')
@UseGuards(AssistanceUserGuard)
export class CashReturnObligationController {
  constructor(
    private readonly settlement: AssistanceSettlementService,
    private readonly resolution: AssistanceResolutionService,
  ) {}

  @Post(':id/confirm')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Confirm that you received the full cash back (the beneficiary only).',
    description: 'Core V2 S5c (H-3, J-4, J-6). Only after the Organization reported the return, and never while a dispute of the request is open. ' +
      'The obligation becomes confirmed_returned and the request returned (resolved), together. Nothing is purchased, paid or granted.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader(KEY)
  @ApiResponse({ status: 200, type: CashReturnObligationDto, description: 'Confirmed (or a replay of this key).' })
  @ApiResponse({ status: 400, description: 'invalid_assistance_request (no body is accepted) | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: you administer the Organization but are not the beneficiary' })
  @ApiResponse({ status: 404, description: 'an unknown obligation, or you are neither its beneficiary nor an administrator of its Organization (one answer)' })
  @ApiResponse({ status: 409, description: 'cash_return_not_reported | cash_return_already_confirmed | assistance_dispute_open | idempotency_key_conflict' })
  @ApiResponse(R503)
  async confirm(@AssistanceUser() user: AuthIdentity, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    normaliseDeclineInput(body);
    if (!isAssistanceId(id)) throw notFound();
    return answer(res, await this.resolution.confirmReturn(user, k, id.toLowerCase(), requestTransitionContext({ type: 'user', id: user.id, userKind: 'member' })));
  }

  @Post(':id/return')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Report that the full cash (base and fee) was returned to the beneficiary (an administrator of the Organization, never the beneficiary).',
    description: 'Moves the obligation open -> return_reported. It does NOT discharge it: the beneficiary confirms or disputes later. No partial return.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader(KEY)
  @ApiBody({ type: CashReturnDto })
  @ApiResponse({ status: 200, type: CashReturnObligationDto, description: 'Reported (or a replay of this key).' })
  @ApiResponse({ status: 400, description: 'invalid_assistance_request | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: you are the beneficiary' })
  @ApiResponse({ status: 404, description: 'an unknown obligation, or you are not an administrator of its Organization (one answer)' })
  @ApiResponse({ status: 409, description: 'cash_return_not_open | idempotency_key_conflict' })
  @ApiResponse({ status: 422, description: 'cash_return_time_invalid: before the cash collection or in the future' })
  @ApiResponse(R503)
  async reportReturn(@AssistanceUser() user: AuthIdentity, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    const input = normaliseCashReturnInput(body);
    if (!isAssistanceId(id)) throw notFound();
    return answer(res, await this.settlement.reportReturn(user, k, id.toLowerCase(), input, requestTransitionContext({ type: 'user', id: user.id, userKind: 'member' })));
  }
}

/** Core V2 S5c (register BIL-21; the Owner's H-5): the Organization's answer to a beneficiary's dispute. Simulation only, as above. */
@ApiTags('organization assistance')
@ApiBearerAuth()
@Controller('billing/assistance-disputes')
@UseGuards(AssistanceUserGuard)
export class AssistanceDisputeController {
  constructor(private readonly resolution: AssistanceResolutionService) {}

  @Post(':id/responses')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Answer a dispute: accepts or contests (an administrator of the Organization, never the beneficiary). Once per dispute.',
    description: 'Evidence only: it closes nothing, discharges nothing and changes no financial state.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader(KEY)
  @ApiBody({ type: DisputeResponseCreateDto })
  @ApiResponse({ status: 201, type: DisputeDto, description: 'Answered (or a replay of this key, Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_assistance_request | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: you are the beneficiary' })
  @ApiResponse({ status: 404, description: 'an unknown dispute, or you are not an administrator of its Organization (one answer)' })
  @ApiResponse({ status: 409, description: 'assistance_dispute_not_open | dispute_response_exists | idempotency_key_conflict' })
  @ApiResponse(R503)
  async respond(@AssistanceUser() user: AuthIdentity, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    const input = normaliseDisputeResponseInput(body);
    if (!isAssistanceId(id)) throw notFound();
    return answer(res, await this.resolution.respond(user, k, id.toLowerCase(), input, requestTransitionContext({ type: 'user', id: user.id, userKind: 'member' })));
  }
}

const STEP_UP = 'x-step-up-token';
const R403_OWNER = { status: 403, description: 'operation_not_permitted: not an Owner (an operator or a member) | step_up_required: missing, expired, reused, or another purpose, owner or session' };
const R503_OWNER = { status: 503, description: 'auth_timeout | auth_unavailable: Auth could not verify the Owner, the Platform or the step-up; nothing was changed' };

/**
 * Core V2 S5c (register BIL-19, BIL-22; the Owner's H-1, H-2, H-6, J-2): the Owner's append-only timestamp corrections and nonfinancial
 * dispute resolutions. Human only: the caller's own Auth bearer, an Owner (live), of the request's Platform (live), with a fresh factor
 * step-up of the operation's OWN purpose, consumed once through Auth. No Operator. No Owner action here discharges, confirms, pays, refunds
 * or reverses anything. Simulation only, as above.
 */
@ApiTags('organization assistance')
@ApiBearerAuth()
@Controller('billing/admin')
@UseGuards(AssistanceOwnerGuard)
export class AssistanceAdminController {
  constructor(private readonly resolution: AssistanceResolutionService) {}

  @Post('assistance-requests/:id/corrections')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Append a correction of an Organization-asserted time: cashCollectedAt or returnedAt (the Owner, step-up billing.assistance.correct).',
    description: 'The original evidence stays; the effective value is derived. A correction changes no amount, fee, deadline (settleBy), overdue ' +
      'state, obligation, settlement, purchase or payment. A replay of the same key and command answers the stored correction without spending a proof.',
  })
  @ApiParam(ID)
  @ApiHeader(KEY)
  @ApiHeader({ name: STEP_UP, required: true, description: 'A fresh factor step-up for purpose "billing.assistance.correct" (POST /auth/admin/step-up). Consumed once.' })
  @ApiBody({ type: CorrectionCreateDto })
  @ApiResponse({ status: 201, type: CorrectionDto, description: 'Appended (or a replay of this key, Idempotent-Replayed: true; no proof is spent).' })
  @ApiResponse({ status: 400, description: 'invalid_assistance_request | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse(R403_OWNER)
  @ApiResponse({ status: 404, description: "an unknown request, or one outside the Owner's Company (one answer)" })
  @ApiResponse({ status: 409, description: 'correction_not_permitted (that time was not reported, or is unchanged) | idempotency_key_conflict' })
  @ApiResponse({ status: 422, description: 'correction_time_invalid: the corrected time breaks the recorded time order' })
  @ApiResponse(R503_OWNER)
  async correct(@AssistanceOwner() owner: VerifiedAssistanceOwner, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Headers(STEP_UP) stepUp: string | undefined,
    @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    const input = normaliseCorrectionInput(body);
    if (!isAssistanceId(id)) throw notFound();
    return answer(res, await this.resolution.correct(owner, k, id.toLowerCase(), input, stepUp, requestTransitionContext({ type: 'user', id: owner.userId, userKind: 'owner' })));
  }

  @Post('assistance-disputes/:id/resolution')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Close a timestamp dispute on a correction of exactly the disputed time (the Owner, step-up billing.assistance.dispute.resolve).',
    description: 'The only resolution Core V2 S5c admits, nonfinancial (J-2). A cash_not_returned or collection_not_made dispute has none and stays open. ' +
      'Never a discharge or a confirmation: the cash-return obligation is unchanged.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader(KEY)
  @ApiHeader({ name: STEP_UP, required: true, description: 'A fresh factor step-up for purpose "billing.assistance.dispute.resolve" (POST /auth/admin/step-up). Consumed once.' })
  @ApiBody({ type: ResolutionCreateDto })
  @ApiResponse({ status: 200, type: DisputeDto, description: 'Resolved (or a replay of this key).' })
  @ApiResponse({ status: 400, description: 'invalid_assistance_request | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse(R403_OWNER)
  @ApiResponse({ status: 404, description: "an unknown dispute, or one outside the Owner's Company (one answer)" })
  @ApiResponse({ status: 409, description: 'assistance_dispute_not_open | resolution_not_permitted | idempotency_key_conflict' })
  @ApiResponse(R503_OWNER)
  async resolve(@AssistanceOwner() owner: VerifiedAssistanceOwner, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Headers(STEP_UP) stepUp: string | undefined,
    @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    const input = normaliseResolutionInput(body);
    if (!isAssistanceId(id)) throw notFound();
    return answer(res, await this.resolution.resolve(owner, k, id.toLowerCase(), input, stepUp, requestTransitionContext({ type: 'user', id: owner.userId, userKind: 'owner' })));
  }
}

class RestrictionDto {
  @ApiProperty({ enum: RESTRICTION_KINDS, description: 'T1: a request past its settlement deadline, not settled and not confirmed returned. T2: a cash-return obligation not confirmed by the beneficiary. T3 (Core V2 S6f): an open recovery obligation (a verified assisted chargeback loss not yet recovered). (inactive is reserved and never returned.)' }) kind!: string;
  @ApiProperty({ format: 'uuid', description: 'The assistance request (T1), the cash-return obligation (T2) or the recovery obligation (T3).' }) sourceId!: string;
  @ApiProperty({ format: 'date-time', description: 'settleBy (T1) or the obligation\'s opening (T2, T3).' }) since!: string;
}

class RestrictionsDto {
  @ApiProperty({ type: [RestrictionDto], description: 'Ordered by kind, then since, then sourceId. Empty when unrestricted.' }) restrictions!: RestrictionDto[];
}

/**
 * Core V2 S5d (register BIL-26; S5D-6): an Organization's current financial restrictions, derived at the database's clock. Read-only.
 * Simulation only, as above.
 */
@ApiTags('organization assistance')
@ApiBearerAuth()
@Controller('billing/organizations')
@UseGuards(RestrictionReaderGuard, ServiceOperationGuard)
export class OrganizationRestrictionsController {
  constructor(private readonly restrictions: AssistanceRestrictionService) {}

  @Get(':organizationId/restrictions')
  @Header('Cache-Control', 'no-store')
  @RequireServiceOperation('restriction.read')
  @ApiOperation({
    summary: "An Organization's financial restrictions (T1, T2, T3): the Owner of its Platform, its administrator, or a service holding restriction.read.",
    description: 'Restrictions block NEW assistance requests only; every discharge action stays available. Nothing here creates, clears or stores a restriction.',
  })
  @ApiParam({ name: 'organizationId', format: 'uuid' })
  @ApiResponse({ status: 200, type: RestrictionsDto })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted (a service without restriction.read) | organization_not_permitted (a service whose Platforms do not include it)' })
  @ApiResponse({ status: 404, description: 'an unknown Organization, or you are neither the Owner of its Platform nor its administrator (one answer)' })
  @ApiResponse({ status: 503, description: 'Auth or the Organization reference could not answer; nothing was read' })
  async read(@Reader() reader: RestrictionReader, @Param('organizationId') organizationId: string) {
    if (!isAssistanceId(organizationId)) throw notFound();
    return this.restrictions.read(reader, organizationId.toLowerCase());
  }
}
