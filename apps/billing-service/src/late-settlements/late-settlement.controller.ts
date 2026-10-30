import { Body, Controller, Get, Header, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthIdentity } from '@nawara/service-kit';
import type { AssistanceCommandResult } from '../assistance/assistance-idempotency.js';
import { isAssistanceId } from '../assistance/assistance-input.js';
import { AssistanceUser, AssistanceUserGuard } from '../assistance/assistance-user.guard.js';
import { requestTransitionContext } from '../domain/actors.js';
import { billingError, notFound } from '../domain/errors.js';
import { idempotencyKey } from '../fees/fee-input.js';
import { BILLING_MESSAGES } from '../messages.js';
import { RefundOwner, RefundOwnerGuard, type VerifiedRefundOwner } from '../refunds/refund-owner.guard.js';
import { ATTESTATION_STATEMENTS, LATE_SETTLEMENT_REASONS, LATE_SETTLEMENT_REFUSALS, LateSettlementService, normaliseApplicationInput, type AttestationStatement } from './late-settlement.service.js';

const KEY = { name: 'Idempotency-Key', required: true, description: 'Required: 8-128 of [A-Za-z0-9._:-], bound to you and this exact command. The same key and command replays the first success (Idempotent-Replayed: true); a different command with it is 409 idempotency_key_conflict.' };
const R401 = { status: 401, description: 'no bearer, a bearer Auth refuses, or a SERVICE token (never forwarded to Auth)' };
const R503 = { status: 503, description: 'Auth or the Organization reference could not answer; nothing was read or changed' };
const ID = { name: 'id', format: 'uuid' };

function answer(res: Response, r: AssistanceCommandResult & { replayed: boolean }) {
  res.status(r.status);
  if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return r.body;
}

class AttestationDto {
  @ApiProperty({ enum: ATTESTATION_STATEMENTS, description: "Your statement about the Organization's cash for this request: a statement, never a financial fact. Once per late settlement." }) statement!: string;
}

class EvidenceRefDto {
  @ApiProperty({ format: 'uuid', description: 'A live File settlement_evidence grant to billing-service for exactly this late settlement (caseRef).' }) grantId!: string;
  @ApiProperty({ format: 'uuid' }) fileId!: string;
}

class ApplicationDto {
  @ApiProperty({ enum: LATE_SETTLEMENT_REASONS, description: 'cash_not_returned_attested needs the beneficiary\'s cash_not_returned attestation; cash_not_returned_evidenced needs evidence and ownerDetermination. No other reason; no override.' }) reasonCode!: string;
  @ApiProperty({ description: "The Auth receipt secret of the Owner's late_settlement_apply step-up for exactly this Company, late settlement, request, beneficiary and reason code." }) receiptSecret!: string;
  @ApiProperty({ type: [EvidenceRefDto], required: false, description: 'cash_not_returned_evidenced only: 1 to 5 references.' }) evidence?: EvidenceRefDto[];
  @ApiProperty({ enum: ['cash_not_returned'], required: false, description: "cash_not_returned_evidenced only: the Owner's explicit determination that the evidence shows the cash was not returned." }) ownerDetermination?: string;
}

/**
 * Core V2 S6g (register BIL-32; R6G-2 Path A, R6G-4). DEVELOPMENT AND SIMULATION ONLY. The request's beneficiary and its Organization's
 * administrator, live; only the beneficiary attests.
 */
@ApiTags('late assisted settlements')
@ApiBearerAuth()
@Controller('billing')
@UseGuards(AssistanceUserGuard)
export class LateSettlementController {
  constructor(private readonly late: LateSettlementService) {}

  @Get('assistance-requests/:id/late-settlements')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "A request's verified late settlements (L-1): recorded, never applied automatically; each with its attestation and application state." })
  @ApiParam(ID)
  @ApiResponse({ status: 200, description: '{lateSettlements: [{id, lateReason, recordedAt, settledAt, status: unapplied | applied, attestation, application}]}' })
  @ApiResponse(R401)
  @ApiResponse({ status: 404, description: 'an unknown request, or you are neither its beneficiary nor an administrator of its Organization (one answer)' })
  @ApiResponse(R503)
  async list(@AssistanceUser() user: AuthIdentity, @Param('id') id: string) {
    if (!isAssistanceId(id)) throw notFound();
    return this.late.listForRequest(user, id.toLowerCase());
  }

  @Post('assistance-late-settlements/:id/attestation')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "R6G-2 Path A: the beneficiary's own statement that the Organization's cash for this request was (or was not) returned.",
    description: 'Once per late settlement, append-only. It never creates a purchase, changes no financial fact and is not an electronic settlement; ' +
      'only the Owner\'s L-4 application can apply the late settlement. A cash_returned statement makes the late settlement inapplicable.',
  })
  @ApiParam(ID)
  @ApiHeader(KEY)
  @ApiBody({ type: AttestationDto })
  @ApiResponse({ status: 201, description: '{lateSettlementId, statement, attestedAt} (or a replay, Idempotent-Replayed: true)' })
  @ApiResponse({ status: 400, description: 'invalid_late_settlement_request | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: "operation_not_permitted: you are the Organization's administrator, not the beneficiary" })
  @ApiResponse({ status: 404, description: 'not_found' })
  @ApiResponse({ status: 409, description: 'late_settlement_already_attested | idempotency_key_conflict' })
  @ApiResponse(R503)
  async attest(@AssistanceUser() user: AuthIdentity, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((x) => x !== 'statement') || !(ATTESTATION_STATEMENTS as readonly unknown[]).includes(b.statement)) {
      throw billingError(400, 'invalid_late_settlement_request', BILLING_MESSAGES.invalidLateSettlementRequest);
    }
    if (!isAssistanceId(id)) throw notFound();
    return answer(res, await this.late.attest(user, k, id.toLowerCase(), b.statement as AttestationStatement, requestTransitionContext({ type: 'user', id: user.id, userKind: 'member' })));
  }
}

/**
 * Core V2 S6g (register BIL-32; R6G-1, R6G-3 to R6G-7). DEVELOPMENT AND SIMULATION ONLY. The Owner of the seller Company, with their OWN bearer
 * verified live (`RefundOwnerGuard`) and the late settlement's Platform (live); the receipt carries the factor step-up.
 */
@ApiTags('late assisted settlements')
@ApiBearerAuth()
@Controller('billing/admin/late-settlements')
@UseGuards(RefundOwnerGuard)
export class LateSettlementAdminController {
  constructor(private readonly late: LateSettlementService) {}

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'R6G-4: a late settlement\'s decision and evidence state: original instant, attestation, application, File evidence, refund cases.' })
  @ApiParam(ID)
  @ApiResponse({ status: 200 })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an Owner' })
  @ApiResponse({ status: 404, description: 'not_found' })
  @ApiResponse(R503)
  async read(@RefundOwner() owner: VerifiedRefundOwner, @Param('id') id: string) {
    if (!isAssistanceId(id)) throw notFound();
    return this.late.readAsOwner(owner, id.toLowerCase());
  }

  @Post(':id/application')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "BIL-32 (L-4): apply a verified late assisted settlement as its request's single purchase.",
    description: 'Only with every L-4 condition and no L-6 refusal: a late_settlement_apply receipt (factor step-up) from this Owner; the beneficiary\'s ' +
      'cash_not_returned attestation or live File evidence with the Owner\'s determination; no purchase; no confirmed or reported return; no open dispute; ' +
      'no other settlement in progress; no refund case on the payment. One transaction supersedes the request\'s open deadline obligation, records the ' +
      'purchase (Payment\'s original instant kept; the entitlement period starts now) and settles the request; T1 and T2 end for that request only.',
  })
  @ApiParam(ID)
  @ApiHeader(KEY)
  @ApiBody({ type: ApplicationDto })
  @ApiResponse({ status: 201, description: 'The applied late settlement (or a replay of this key, Idempotent-Replayed: true; nothing is consumed again).' })
  @ApiResponse({ status: 400, description: 'invalid_late_settlement_request | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an Owner' })
  @ApiResponse({ status: 404, description: 'not_found: unknown, or another Company\'s or Platform\'s' })
  @ApiResponse({ status: 409, description: `late_settlement_refused (body \`reason\` ∈ ${LATE_SETTLEMENT_REFUSALS.join(', ')}) | late_settlement_authorization_refused | idempotency_key_conflict` })
  @ApiResponse({ status: 422, description: 'late_settlement_evidence_invalid' })
  @ApiResponse({ status: 503, description: 'late_settlement_evidence_unavailable | late_settlement_authorization_unresolved (repeat the same request) | late_settlement_authorization_unavailable' })
  async apply(@RefundOwner() owner: VerifiedRefundOwner, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    const input = normaliseApplicationInput(body);
    if (!isAssistanceId(id)) throw notFound();
    return answer(res, await this.late.apply(owner, k, id.toLowerCase(), input, requestTransitionContext({ type: 'user', id: owner.userId, userKind: 'owner' })));
  }
}
