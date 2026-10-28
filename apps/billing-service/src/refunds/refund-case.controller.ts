import { Body, Controller, Get, Header, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { requestTransitionContext } from '../domain/actors.js';
import { notFound } from '../domain/errors.js';
import { idempotencyKey } from '../fees/fee-input.js';
import { RefundCaseService } from './refund-case.service.js';
import type { RefundCommandResult } from './refund-idempotency.js';
import { REFUND_REASONS, isRefundId, normaliseEmptyInput, normaliseRefundAuthorizationInput, normaliseRefundCaseInput } from './refund-input.js';
import { RefundAuthorizationService } from './refund-authorization.service.js';
import { RefundOwner, RefundOwnerGuard, type VerifiedRefundOwner } from './refund-owner.guard.js';

class RefundCaseCreateDto {
  @ApiProperty({ format: 'uuid', description: "Payment's id of one verified captured payment sold by your Company." }) paymentId!: string;
  @ApiProperty({ enum: REFUND_REASONS, description: 'Classification and audit context only: it bypasses no constraint.' }) reason!: string;
  @ApiPropertyOptional({ default: false, description: 'Recorded in the case and its audit evidence; grants no permission and bypasses nothing.' }) legalOverride?: boolean;
}

class RefundCaseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ format: 'uuid', description: 'The seller Company.' }) companyId!: string;
  @ApiProperty({ format: 'uuid' }) platformId!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) organizationId!: string | null;
  @ApiProperty({ description: 'The full captured amount, minor units, computed by Billing (no partial refund).' }) amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: ['open', 'cancelled', 'completed'], description: 'completed is reserved for verified refund completion (a later stage).' }) status!: string;
  @ApiProperty({ enum: ['personal_purchase', 'late_assisted_settlement', 'non_entitlement'] }) eligibility!: string;
  @ApiProperty({ enum: REFUND_REASONS }) reason!: string;
  @ApiProperty() legalOverride!: boolean;
  @ApiProperty({ format: 'date-time' }) openedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) cancelledAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) completedAt!: string | null;
  @ApiProperty({ type: [Object], description: 'Core V2 S6b: the authorization relays, each {refundAttemptId, status (Payment\'s authoritative attempt status, or unconfirmed), refusal, requestedAt, statusAt}.' }) attempts!: unknown[];
}

class RefundAuthorizationDto {
  @ApiProperty({ description: 'The secret of the Auth refund authorization receipt you obtained for exactly this case (AUTH-01, factor step-up). Relayed to Payment in memory only; never stored.' })
  receiptSecret!: string;
}

const KEY = { name: 'Idempotency-Key', required: true, description: 'Required: 8-128 of [A-Za-z0-9._:-], bound to you and this exact command. The same key and command replays the first success (Idempotent-Replayed: true); another command with it is 409 idempotency_key_conflict.' };
const R401 = { status: 401, description: 'no bearer, a bearer Auth refuses, or a SERVICE token (never forwarded to Auth)' };
const R403 = { status: 403, description: 'operation_not_permitted: not an Owner (an operator, a member or an Organization administrator: one answer)' };
const R503 = { status: 503, description: 'auth_timeout | auth_unavailable, or the dispute source could not answer: nothing was changed' };

function answer(res: Response, r: RefundCommandResult & { replayed: boolean }) {
  res.status(r.status);
  if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return r.body;
}

/**
 * Core V2 S6a refund cases (register BIL-23, BIL-25; ADR-0067 decision 6; the Owner's R6A-1 to R6A-9). DEVELOPMENT AND SIMULATION ONLY:
 * not mounted in production. The Owner of the seller Company only, verified live; no step-up (refund authorization is S6b's separate,
 * factor-only refund-authorization step-up (Auth's own purpose, S6b)). Opening a case moves no money and creates no refund attempt.
 */
@ApiTags('refund cases')
@ApiBearerAuth()
@Controller('billing/admin/refund-cases')
@UseGuards(RefundOwnerGuard)
export class RefundCaseController {
  constructor(private readonly cases: RefundCaseService, private readonly authorizations: RefundAuthorizationService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Open a refund case for one verified captured payment, in full (the Owner of the seller Company).',
    description: 'Eligible: a verified personal purchase (direct or assisted), a late assisted settlement held for reconciliation, or a non-entitlement payment. ' +
      'Organization-subscription payments are not. Billing computes the full amount; nothing is refunded here.',
  })
  @ApiHeader(KEY)
  @ApiBody({ type: RefundCaseCreateDto })
  @ApiResponse({ status: 201, type: RefundCaseDto, description: 'Opened (or a replay of this key, Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_refund_request (an unknown field such as amount, a non-uuid payment, an unknown reason) | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, description: "an unknown payment, or one outside your Company or Platform (one answer)" })
  @ApiResponse({ status: 409, description: 'refund_not_eligible | refund_case_exists | refund_dispute_open | idempotency_key_conflict' })
  @ApiResponse(R503)
  async open(@RefundOwner() owner: VerifiedRefundOwner, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    const input = normaliseRefundCaseInput(body);
    return answer(res, await this.cases.open(owner, k, input, requestTransitionContext({ type: 'user', id: owner.userId, userKind: 'owner' })));
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read a refund case (the Owner of its Company).' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: RefundCaseDto })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, description: 'an unknown case, or another Company\'s (one answer)' })
  @ApiResponse(R503)
  async read(@RefundOwner() owner: VerifiedRefundOwner, @Param('id') id: string) {
    if (!isRefundId(id)) throw notFound();
    return this.cases.read(owner, id.toLowerCase());
  }

  @Post(':id/authorizations')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'BIL-24: relay your refund authorization receipt for this case to Payment, as one refund attempt (the Owner of its Company).',
    description: 'Billing records the relay and its refund attempt id first, then Payment verifies the payment and its capture, consumes the receipt at Auth and '
      + 'answers. The provider refund is sent asynchronously; completion is a later stage. Retry with the same Idempotency-Key and receipt when the answer is 503.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader({ ...KEY, description: 'Required (class M): bound to you and this case. The fingerprint never covers the receipt secret; the same key resumes the same relay.' })
  @ApiBody({ type: RefundAuthorizationDto })
  @ApiResponse({ status: 201, type: RefundCaseDto, description: 'Authorized (or later): the case with its attempts.' })
  @ApiResponse({ status: 200, type: RefundCaseDto, description: 'A retry of this key (Idempotent-Replayed: true): the current state.' })
  @ApiResponse({ status: 400, description: 'invalid_refund_request (anything but receiptSecret) | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, description: 'an unknown case, or another Company\'s (one answer)' })
  @ApiResponse({ status: 409, description: 'refund_case_completed | refund_case_not_open | refund_dispute_open | refund_authorization_in_progress | refund_authorization_invalid | refund_authorization_expired | refund_authorization_conflict | refund_rejected_by_payment | idempotency_key_conflict' })
  @ApiResponse({ status: 503, description: 'refund_authorization_unresolved | refund_payment_unavailable (the relay is recorded; its outcome is confirmed from Payment) | auth_timeout | auth_unavailable' })
  async authorize(@RefundOwner() owner: VerifiedRefundOwner, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    const { receiptSecret } = normaliseRefundAuthorizationInput(body);
    if (!isRefundId(id)) throw notFound();
    const r = await this.authorizations.relay(owner, k, id.toLowerCase(), receiptSecret, requestTransitionContext({ type: 'user', id: owner.userId, userKind: 'owner' }));
    return answer(res, r);
  }

  @Post(':id/cancel')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Cancel an open refund case before any refund processing (the Owner of its Company). Refused once a refund authorization was relayed, unless Payment proved every one ended unconsumed. The payment may get a new case.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader(KEY)
  @ApiResponse({ status: 200, type: RefundCaseDto, description: 'Cancelled (or a replay of this key).' })
  @ApiResponse({ status: 400, description: 'invalid_refund_request (no body is accepted) | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, description: 'an unknown case, or another Company\'s (one answer)' })
  @ApiResponse({ status: 409, description: 'refund_case_not_open | refund_processing_started | idempotency_key_conflict' })
  @ApiResponse(R503)
  async cancel(@RefundOwner() owner: VerifiedRefundOwner, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    normaliseEmptyInput(body);
    if (!isRefundId(id)) throw notFound();
    return answer(res, await this.cases.cancel(owner, k, id.toLowerCase(), requestTransitionContext({ type: 'user', id: owner.userId, userKind: 'owner' })));
  }
}
