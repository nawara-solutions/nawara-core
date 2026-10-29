import { Body, Controller, Get, Header, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { resolveLocale, type AuthIdentity } from '@nawara/service-kit';
import type { AssistanceCommandResult } from '../assistance/assistance-idempotency.js';
import { isAssistanceId } from '../assistance/assistance-input.js';
import { AssistanceUser, AssistanceUserGuard } from '../assistance/assistance-user.guard.js';
import { requestTransitionContext } from '../domain/actors.js';
import { billingError, notFound } from '../domain/errors.js';
import { idempotencyKey } from '../fees/fee-input.js';
import { BILLING_MESSAGES } from '../messages.js';
import { RefundOwner, RefundOwnerGuard, type VerifiedRefundOwner } from '../refunds/refund-owner.guard.js';
import { RecoveryService } from './recovery.service.js';

const KEY = { name: 'Idempotency-Key', required: true, description: 'Required: 8-128 of [A-Za-z0-9._:-], bound to you and this exact command. The same key and command replays the first success (Idempotent-Replayed: true); a different command with it is 409 idempotency_key_conflict.' };
const R401 = { status: 401, description: 'no bearer, a bearer Auth refuses, or a SERVICE token (never forwarded to Auth)' };
const R404 = { status: 404, description: 'an unknown obligation or surplus, or you are not an administrator of its Organization (one answer)' };
const R503 = { status: 503, description: 'Auth or the Organization reference could not answer; nothing was read or changed' };
const ID = { name: 'id', format: 'uuid' };

function answer(res: Response, r: AssistanceCommandResult & { replayed: boolean }) {
  res.status(r.status);
  if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return r.body;
}

/** No body is accepted by the Organization's commands (an empty object is tolerated). */
function noBody(body: unknown): void {
  if (body === undefined || body === null) return;
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) throw billingError(400, 'invalid_recovery_request', BILLING_MESSAGES.invalidRecoveryRequest);
}

class RecoverySettlementDto {
  @ApiProperty({ format: 'uuid' }) invoiceId!: string;
  @ApiProperty({ format: 'uuid', description: 'Pay it at Payment; read the obligation for its progress.' }) paymentRequestId!: string;
  @ApiProperty({ type: String, nullable: true, description: 'null until Payment supplies an identifier; never invented.' }) paymentId!: string | null;
  @ApiProperty({ description: 'The outstanding principal at the start, minor units: the invoice total.' }) amount!: number;
}

class RecoveryObligationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
  @ApiProperty({ format: 'uuid' }) companyId!: string;
  @ApiProperty({ format: 'uuid' }) platformId!: string;
  @ApiProperty({ format: 'uuid' }) assistanceRequestId!: string;
  @ApiProperty({ format: 'uuid', description: 'The verified final dispute loss (S6e-D) the obligation recovers.' }) disputeId!: string;
  @ApiProperty({ description: 'The frozen base price of the assisted purchase, minor units (never the Organization fee, never the chargeback fee).' }) baseAmount!: number;
  @ApiProperty({ description: 'Verified recovered principal, minor units (Payment-verified successes only).' }) recovered!: number;
  @ApiProperty({ description: 'baseAmount - recovered, never below 0.' }) outstanding!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: ['open', 'recovered'], description: 'open: T3 applies to the Organization; recovered: verified principal reached the base.' }) status!: string;
  @ApiProperty({ format: 'date-time' }) openedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) recoveredAt!: string | null;
  @ApiProperty({ type: [Object], description: 'Verified recovery payments: amount, principalAmount, surplusAmount.' }) payments!: unknown[];
  @ApiProperty({ type: [Object], description: 'Settlement channels (invoice, payment request, its status, active).' }) channels!: unknown[];
  @ApiProperty({ type: [Object], description: 'Surpluses owed to the Organization: owed_to_organization | external_execution_evidenced | resolved.' }) surpluses!: unknown[];
}

class ExternalRepaymentDto {
  @ApiProperty({ enum: ['external_execution_evidenced'] }) kind!: string;
  @ApiProperty({ format: 'uuid', description: 'A live File surplus_evidence grant to billing-service for exactly this surplus (caseRef).' }) grantId!: string;
  @ApiProperty({ format: 'uuid' }) fileId!: string;
  @ApiProperty({ description: "The Auth receipt secret of the Owner's recovery_surplus_external step-up for exactly this Company, surplus, Organization, amount and currency." }) receiptSecret!: string;
}

/**
 * Core V2 S6f (register BIL-28, BIL-29, BIL-31; R6F-1). DEVELOPMENT AND SIMULATION ONLY. The Organization's administrator, live, never the
 * beneficiary of the assisted purchase; T3 never blocks these discharge actions.
 */
@ApiTags('organization recovery')
@ApiBearerAuth()
@Controller('billing')
@UseGuards(AssistanceUserGuard)
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @Get('recovery-obligations/:id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "BIL-28: a recovery obligation of your Organization: base, verified recovered principal, outstanding, payments, channels and surpluses." })
  @ApiParam(ID)
  @ApiResponse({ status: 200, type: RecoveryObligationDto })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: you are the beneficiary of the assisted purchase' })
  @ApiResponse(R404)
  @ApiResponse(R503)
  async read(@AssistanceUser() user: AuthIdentity, @Param('id') id: string) {
    if (!isAssistanceId(id)) throw notFound();
    return this.recovery.readAsOrganization(user, id.toLowerCase());
  }

  @Post('recovery-obligations/:id/settlement')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "BIL-29: start the Organization's settlement of a recovery obligation (an administrator of its Organization, never the beneficiary).",
    description: 'Creates and issues an invoice paid by the Organization for the outstanding principal only (routed recovery_settlement: no entitlement, no product ' +
      'grant), and its payment request; the administrator then pays it at Payment. Only Payment\'s verified success is a recovery payment; a response, a ' +
      'timeout or a submission never is. One open or uncertain channel at a time. Simulation only.',
  })
  @ApiParam(ID)
  @ApiHeader(KEY)
  @ApiResponse({ status: 201, type: RecoverySettlementDto, description: 'Started (or a replay of this key, Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_recovery_request (no body is accepted) | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: you are the beneficiary of the assisted purchase' })
  @ApiResponse(R404)
  @ApiResponse({ status: 409, description: 'recovery_obligation_closed | settlement_channel_open | idempotency_key_conflict' })
  @ApiResponse(R503)
  async settle(@AssistanceUser() user: AuthIdentity, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Headers('accept-language') acceptLanguage: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    noBody(body);
    if (!isAssistanceId(id)) throw notFound();
    return answer(res, await this.recovery.settle(user, k, id.toLowerCase(), resolveLocale(acceptLanguage), requestTransitionContext({ type: 'user', id: user.id, userKind: 'member' })));
  }

  @Post('recovery-surpluses/:id/recipient-confirmation')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "BIL-31: confirm, as the receiving Organization's administrator, that the Owner's recorded external repayment of a surplus was received.",
    description: 'Resolves the surplus, once. Never the Owner or the recorder. Owner assertion alone never resolves a surplus.',
  })
  @ApiParam(ID)
  @ApiHeader(KEY)
  @ApiResponse({ status: 200, description: '{surplusId, status: resolved} (or a replay, Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_recovery_request | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: you are the beneficiary of the assisted purchase' })
  @ApiResponse(R404)
  @ApiResponse({ status: 409, description: 'surplus_not_evidenced (no external repayment recorded) | idempotency_key_conflict' })
  @ApiResponse(R503)
  async confirm(@AssistanceUser() user: AuthIdentity, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    noBody(body);
    if (!isAssistanceId(id)) throw notFound();
    return answer(res, await this.recovery.confirm(user, k, id.toLowerCase(), requestTransitionContext({ type: 'user', id: user.id, userKind: 'member' })));
  }
}

/**
 * Core V2 S6f (register BIL-28, BIL-30; R6F-1, R6F-5 Path B). DEVELOPMENT AND SIMULATION ONLY. The Owner of the obligation's Company and
 * Platform, with their OWN bearer verified live (`RefundOwnerGuard`); the Owner reads, and records an external repayment, but never confirms.
 */
@ApiTags('organization recovery')
@ApiBearerAuth()
@Controller('billing/admin')
@UseGuards(RefundOwnerGuard)
export class RecoveryAdminController {
  constructor(private readonly recovery: RecoveryService) {}

  @Get('recovery-obligations/:id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "BIL-28: a recovery obligation of the Owner's Company and Platform (read-only)." })
  @ApiParam(ID)
  @ApiResponse({ status: 200, type: RecoveryObligationDto })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an Owner' })
  @ApiResponse({ status: 404, description: 'not_found' })
  @ApiResponse(R503)
  async read(@RefundOwner() owner: VerifiedRefundOwner, @Param('id') id: string) {
    if (!isAssistanceId(id)) throw notFound();
    return this.recovery.readAsOwner(owner, id.toLowerCase());
  }

  @Post('recovery-surpluses/:id/resolution')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'BIL-30: record that a surplus owed to an Organization was repaid outside Core (File evidence and a recovery_surplus_external receipt).',
    description: 'Not a provider-verified Payment fact; it moves no money. The surplus stays unresolved until the receiving Organization\'s administrator confirms ' +
      '(BIL-31). The receipt is consumed once under the surplus id; a surplus being refunded (Path A) refuses.',
  })
  @ApiParam(ID)
  @ApiBody({ type: ExternalRepaymentDto })
  @ApiResponse({ status: 201, description: '{surplusId, status: external_execution_evidenced}' })
  @ApiResponse({ status: 200, description: 'The same record repeated (same grant and file): answered, nothing consumed again.' })
  @ApiResponse({ status: 400, description: 'invalid_recovery_request' })
  @ApiResponse(R401)
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an Owner' })
  @ApiResponse({ status: 404, description: 'not_found' })
  @ApiResponse({ status: 409, description: 'surplus_not_owed | recovery_authorization_refused' })
  @ApiResponse({ status: 422, description: 'surplus_evidence_invalid' })
  @ApiResponse({ status: 503, description: 'surplus_evidence_unavailable | recovery_authorization_unresolved (repeat the same request) | recovery_authorization_unavailable' })
  async resolve(@RefundOwner() owner: VerifiedRefundOwner, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = (body ?? {}) as Record<string, unknown>;
    if (typeof input !== 'object' || Array.isArray(input) || input.kind !== 'external_execution_evidenced'
      || Object.keys(input).some((k) => !['kind', 'grantId', 'fileId', 'receiptSecret'].includes(k))) {
      throw billingError(400, 'invalid_recovery_request', BILLING_MESSAGES.invalidRecoveryRequest);
    }
    const r = await this.recovery.recordExternal(owner, id.toLowerCase(), input, requestTransitionContext({ type: 'user', id: owner.userId, userKind: 'owner' }));
    res.status(r.created ? 201 : 200);
    return r.body;
  }
}
