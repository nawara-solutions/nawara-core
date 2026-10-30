import { Body, Controller, Get, Header, Headers, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CallerService, RequireServiceOperation, ServiceOperationGuard, ServiceOrUserGuard, ServiceTokenGuard, type CallerRequest } from '@nawara/service-kit';
import { RECONCILIATION_READ_OPERATION } from '../authorization/caller-admission.policy.js';
import type { VerifiedOwner } from '../disputes/owner-company.authority.js';
import { operationNotPermitted } from '../errors.js';
import { ITEM_KINDS, PRODUCER_ITEM_KINDS, ReconciliationService, type AssociationRow } from './reconciliation.service.js';

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const representAssociation = (a: AssociationRow) => ({
  associationId: a.id, factId: a.factId, targetType: a.targetType, paymentId: a.paymentId, refundAuthorizationId: a.refundAuthorizationId, status: a.status,
  refusal: a.refusal, requestedBy: { userId: a.requestedByUserId }, approvedBy: a.approvedByUserId ? { userId: a.approvedByUserId } : null, receiptId: a.receiptId,
  requestedAt: iso(a.requestedAt), associatedAt: iso(a.associatedAt),
});
const limitOf = (limit?: string) => (limit === undefined ? 100 : Number(limit));

/**
 * Core V2 S6h-P (register PAY-12, PAY-13; the Owner's R6H-1, R6H-3, R6H-12). DEVELOPMENT AND SIMULATION ONLY (mounted only where refunds are).
 * The Owner of the payments' seller Company, with their OWN bearer verified live on every request; a service token is never accepted here.
 */
@ApiTags('reconciliation')
@Controller('payment/admin')
@UseGuards(ServiceOrUserGuard)
@ApiBearerAuth()
export class ReconciliationOwnerController {
  constructor(@Inject(ReconciliationService) private readonly reconciliation: ReconciliationService) {}

  private async owner(req: CallerRequest): Promise<VerifiedOwner> {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!req.caller || req.caller.kind !== 'user' || !bearer) throw operationNotPermitted();
    return this.reconciliation.owner(bearer, req.caller.identity);
  }

  @Get('reconciliation-items')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "PAY-12: one kind of Payment's reconciliation items for the Owner's Company (keyset by id); `unmatched_fact` lists the verified movements that match no payment yet.",
    description: 'Read-only evidence: nothing here creates, changes or resolves a fact. authorization_pending lists intents with no definitive Auth answer after '
      + '15 minutes (Q8: fail closed; never released on missing evidence). capture_refund_unavailable lists the captures no original-payment refund can return.',
  })
  @ApiQuery({ name: 'kind', required: true, enum: ITEM_KINDS })
  @ApiQuery({ name: 'after', required: false, description: 'the last id of the previous page' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 200 (default 100)' })
  @ApiResponse({ status: 200, description: '{ items }' })
  @ApiResponse({ status: 400, description: 'invalid_reconciliation_request' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an Owner (or a service)' })
  @ApiResponse({ status: 503, description: 'owner_authority_unavailable' })
  async items(@Req() req: CallerRequest, @Query('kind') kind: string, @Query('after') after?: string, @Query('limit') limit?: string) {
    const owner = await this.owner(req);
    return { items: await this.reconciliation.items({ kind: 'owner', companyId: owner.companyId }, kind, after, limitOf(limit)) };
  }

  @Get('balances')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "R6H-12 (FC-5): the Owner's Company's signed balances from verified facts, per currency: captured, refundedNet, chargebackNet, netRetained (never clamped)." })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  async balances(@Req() req: CallerRequest) {
    return this.reconciliation.companyBalances(await this.owner(req));
  }

  @Get('payments/:paymentId/balance')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'R6H-12 (FC-5): one payment of the Owner\'s Company: signed balance per currency, in-flight refunds and unresolved evidence, apart.' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: "not_found: unknown, or another Company's (one answer)" })
  async paymentBalance(@Param('paymentId') paymentId: string, @Req() req: CallerRequest) {
    return this.reconciliation.paymentBalance(await this.owner(req), paymentId.toLowerCase());
  }

  @Post('provider-facts/:id/associations')
  @Header('Cache-Control', 'no-store')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8 to 128 of A-Z a-z 0-9 . _ : -' })
  @ApiOperation({
    summary: "PAY-13: associate one unmatched verified provider fact with one payment (a capture) or refund authorization (a refund) of the Owner's Company.",
    description: 'Body {targetType: payment | refund_authorization, targetId, receiptSecret}. The Auth provider_fact_associate receipt (factor-only step-up) must name '
      + 'this Company, the fact, its kind, amount and currency, and the destination; it is consumed once under the association id. The database re-checks the '
      + 'destination (kind, currency, amount for a capture, provider, Company). The fact never changes; a refund fact is then allocated by the refund worker. '
      + 'A pending association (503) resumes with the same key and receipt.',
  })
  @ApiResponse({ status: 201, description: 'The recorded association.' })
  @ApiResponse({ status: 200, description: 'The association this key already recorded.' })
  @ApiResponse({ status: 400, description: 'invalid_reconciliation_request | idempotency_key_required' })
  @ApiResponse({ status: 404, description: "not_found: an unknown fact, or a destination outside the Owner's Company" })
  @ApiResponse({ status: 409, description: 'provider_fact_matched | fact_already_associated | provider_fact_association_invalid | provider_fact_association_refused | provider_fact_association_conflict' })
  @ApiResponse({ status: 422, description: 'idempotency_key_reused' })
  @ApiResponse({ status: 503, description: 'provider_fact_association_unresolved (repeat the same request) | owner_authority_unavailable' })
  async associate(@Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: { targetType?: unknown; targetId?: unknown; receiptSecret?: unknown },
    @Req() req: CallerRequest, @Res({ passthrough: true }) res: Response) {
    const owner = await this.owner(req);
    const { association, created } = await this.reconciliation.associate(owner, id.toLowerCase(), key, body ?? {});
    res.status(created ? 201 : 200);
    return representAssociation(association);
  }
}

/**
 * Core V2 S6h-P (R6H-6): the Billing producer's narrow reconciliation read, with its OWN service token and `payment.reconciliation.read`: only
 * its own payments' evidence (late successes for event-loss recovery, chargebacks, over-returns, associations, unresolved refund outcomes).
 */
@ApiTags('reconciliation')
@Controller('payment/reconciliation')
@UseGuards(ServiceTokenGuard, ServiceOperationGuard)
@RequireServiceOperation(RECONCILIATION_READ_OPERATION)
@ApiBearerAuth()
export class ReconciliationServiceController {
  constructor(@Inject(ReconciliationService) private readonly reconciliation: ReconciliationService) {}

  @Get('items')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "R6H-6: one kind of reconciliation evidence of the caller's own payments, by id (keyset): e.g. late_success for a consumer that missed payment.late_success.recorded." })
  @ApiQuery({ name: 'kind', required: true, enum: PRODUCER_ITEM_KINDS })
  @ApiQuery({ name: 'after', required: false })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 200 (default 100)' })
  @ApiResponse({ status: 200, description: '{ items }' })
  @ApiResponse({ status: 400, description: 'invalid_reconciliation_request' })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  async items(@CallerService() caller: string, @Query('kind') kind: string, @Query('after') after?: string, @Query('limit') limit?: string) {
    return { items: await this.reconciliation.items({ kind: 'producer', producer: caller }, kind, after, limitOf(limit)) };
  }
}
