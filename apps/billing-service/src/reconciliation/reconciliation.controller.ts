import { Body, Controller, Get, Header, Headers, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { requestTransitionContext } from '../domain/actors.js';
import { idempotencyKey } from '../fees/fee-input.js';
import { RefundOwner, RefundOwnerGuard, type VerifiedRefundOwner } from '../refunds/refund-owner.guard.js';
import { ACKNOWLEDGEMENT_REASONS, CASE_TYPES } from './reconciliation-cases.js';
import { ReconciliationService } from './reconciliation.service.js';

const ID = { name: 'id', format: 'uuid' };
const R401 = { status: 401, description: 'no bearer, a bearer Auth refuses, or a SERVICE token (never forwarded to Auth)' };
const R403 = { status: 403, description: 'operation_not_permitted: not an Owner' };
const R503 = { status: 503, description: 'auth_timeout | auth_unavailable: nothing was changed' };
const ownerContext = (owner: VerifiedRefundOwner) => requestTransitionContext({ type: 'user', id: owner.userId, userKind: 'owner' });
const asBody = (body: unknown): Record<string, unknown> => (body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {});

/**
 * Core V2 S6h-B (register BIL-33, BIL-34; the Owner's R6H-1, R6H-2, R6H-7, R6H-8). DEVELOPMENT AND SIMULATION ONLY: not mounted in production.
 * The Owner of the seller Company, with their OWN bearer verified live (`RefundOwnerGuard`), and the Platform verified live per record.
 */
@ApiTags('reconciliation')
@ApiBearerAuth()
@Controller('billing/admin')
@UseGuards(RefundOwnerGuard)
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get('reconciliation-cases')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "BIL-33: the Owner's Company's reconciliation cases (keyset by id), each with its evidence and, once resolved, the resolution that settled it." })
  @ApiQuery({ name: 'status', required: false, enum: ['open', 'resolved'] })
  @ApiQuery({ name: 'type', required: false, enum: CASE_TYPES })
  @ApiQuery({ name: 'after', required: false, description: 'the last id of the previous page' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 200 (default 100)' })
  @ApiResponse({ status: 200, description: '{ items }' })
  @ApiResponse({ status: 400, description: 'invalid_reconciliation_request' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R503)
  async list(@RefundOwner() owner: VerifiedRefundOwner, @Query('status') status?: string, @Query('type') type?: string, @Query('after') after?: string, @Query('limit') limit?: string) {
    return this.reconciliation.list(owner, { status, type, after, limit });
  }

  @Get('reconciliation-cases/:id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'BIL-33: one reconciliation case of the Owner\'s Company.' })
  @ApiParam(ID)
  @ApiResponse({ status: 200 })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, description: 'not_found: unknown, or another Company\'s or Platform\'s (one answer)' })
  async read(@RefundOwner() owner: VerifiedRefundOwner, @Param('id') id: string) {
    return this.reconciliation.read(owner, id.toLowerCase());
  }

  @Post('reconciliation-cases/:id/acknowledgement')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'R6H-2: acknowledge a REVIEW-ONLY case (refund_discrepancy, partial_chargeback, second_reversal_cause) with a bounded reason; the evidence stays.',
    description: `Body {reason: ${ACKNOWLEDGEMENT_REASONS.join(' | ')}}. Every other case is resolved only by its own financial evidence (a completed refund, an applied `
      + 'settlement, a resolved surplus, a recognized loss, an applied effect, a definitive authorization outcome): 409 reconciliation_case_not_acknowledgeable.',
  })
  @ApiParam(ID)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 200, description: 'The case, resolved (or the identical replay: Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_reconciliation_request | idempotency_key_required' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, description: 'not_found' })
  @ApiResponse({ status: 409, description: 'reconciliation_case_not_acknowledgeable | reconciliation_case_resolved | idempotency_key_conflict' })
  async acknowledge(@RefundOwner() owner: VerifiedRefundOwner, @Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response) {
    const r = await this.reconciliation.acknowledge(owner, idempotencyKey(key), id.toLowerCase(), asBody(body), ownerContext(owner));
    res.status(r.status);
    if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return r.body;
  }

  @Get('financial-losses')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "BIL-34: the Owner's Company's FinancialLoss records (over_return, direct_chargeback_write_off, recovery_write_off), each with its append-only adjustments and net amount." })
  @ApiResponse({ status: 200, description: '{ items }' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  async losses(@RefundOwner() owner: VerifiedRefundOwner) {
    return this.reconciliation.losses(owner);
  }

  @Post('recovery-obligations/:id/write-off')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "R6H-8 (BIL-34): write off an open recovery obligation's OUTSTANDING principal as a loss, with Auth's recovery_write_off receipt (factor-only step-up).",
    description: 'Body {receiptSecret}. The receipt binds the Company, the obligation, its Organization, the outstanding amount and the currency; consumed once. '
      + 'Accounting only, never forgiveness: the obligation stays open and T3 stays until verified recoveries reach the base; a later recovery adjusts the loss.',
  })
  @ApiParam(ID)
  @ApiResponse({ status: 201, description: 'The write-off: {obligationId, lossId, amount, currency, receiptId, writtenOffBy, recordedAt, obligationStatus}.' })
  @ApiResponse({ status: 200, description: 'The same request again (same obligation and receipt): answered, nothing consumed again.' })
  @ApiResponse({ status: 400, description: 'invalid_reconciliation_request' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, description: 'not_found' })
  @ApiResponse({ status: 409, description: 'write_off_not_permitted | recovery_authorization_refused' })
  @ApiResponse({ status: 503, description: 'recovery_authorization_unresolved (repeat the same request) | recovery_authorization_unavailable' })
  async writeOff(@RefundOwner() owner: VerifiedRefundOwner, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.reconciliation.writeOff(owner, id.toLowerCase(), asBody(body), ownerContext(owner));
    res.status(r.created ? 201 : 200);
    return r.body;
  }
}
