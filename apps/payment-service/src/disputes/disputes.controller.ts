import { Body, Controller, Get, Header, Headers, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CallerService, DbService, RequireServiceOperation, ServiceOperationGuard, ServiceOrUserGuard, ServiceTokenGuard, type CallerRequest,
} from '@nawara/service-kit';
import { notFound, operationNotPermitted, paymentError } from '../errors.js';
import { PAYMENT_MESSAGES } from '../messages.js';
import type { PaymentRow } from '../payments/payment.types.js';
import { DisputeOwnerService, type DisputeDecisionRow, type DisputeEvidenceRow } from './dispute-owner.service.js';
import { disputeExposure, type DisputeRow } from './dispute.types.js';
import type { VerifiedOwner } from './owner-company.authority.js';

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A dispute as the Owner sees it (PAY-09). Never evidence content, a receipt or its secret. */
export function representDispute(d: DisputeRow & { paymentRequestId?: string }) {
  return {
    disputeId: d.id, paymentId: d.paymentId, paymentRequestId: d.paymentRequestId ?? null, provider: d.provider, providerDisputeId: d.providerDisputeId, status: d.status,
    amount: Number(d.amount), currency: d.currency.trim(), reason: d.reason, recordedAt: iso(d.recordedAt), providerOpenedAt: iso(d.providerOpenedAt),
    closedAt: iso(d.closedAt), providerClosedAt: iso(d.providerClosedAt), chargebackFactId: d.chargebackFactId, liveMode: false,
  };
}
const representEvidence = (e: DisputeEvidenceRow) => ({ evidenceId: e.id, disputeId: e.disputeId, grantId: e.grantId, fileId: e.fileId, addedBy: { userId: e.addedByUserId }, addedAt: iso(e.addedAt) });
const representDecision = (z: DisputeDecisionRow) => ({
  decisionId: z.id, disputeId: z.disputeId, decision: z.decision, status: z.status, requestedBy: { userId: z.requestedByUserId },
  approvedBy: z.approvedByUserId ? { userId: z.approvedByUserId } : null, receiptId: z.receiptId, refusal: z.refusal, requestedAt: iso(z.requestedAt), decidedAt: iso(z.decidedAt),
});

/**
 * Core V2 S6e-D (register PAY-09 to PAY-11; the Owner's R6E-3). DEVELOPMENT AND SIMULATION ONLY (mounted only where refunds are). The Owner of
 * the payment's seller Company, with their OWN bearer, verified live on every request; a service token is never accepted here.
 */
@ApiTags('disputes')
@Controller('payment/admin/disputes')
@UseGuards(ServiceOrUserGuard)
@ApiBearerAuth()
export class DisputeOwnerController {
  constructor(@Inject(DisputeOwnerService) private readonly disputes: DisputeOwnerService) {}

  private async owner(req: CallerRequest): Promise<VerifiedOwner> {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!req.caller || req.caller.kind !== 'user' || !bearer) throw operationNotPermitted();
    return this.disputes.owner(bearer, req.caller.identity);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "PAY-09: the disputes of the Owner's Company, newest first (Owner, verified live)." })
  @ApiQuery({ name: 'status', required: false, enum: ['open', 'won', 'lost'] })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100 (default 50)' })
  @ApiResponse({ status: 200, description: '{ items: Dispute[] }' })
  @ApiResponse({ status: 400, description: 'invalid_dispute_request' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted: not an Owner (or a service)' })
  @ApiResponse({ status: 503, description: 'owner_authority_unavailable' })
  async list(@Req() req: CallerRequest, @Query('status') status?: string, @Query('limit') limit?: string) {
    const owner = await this.owner(req);
    const n = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw paymentError(400, 'invalid_dispute_request', PAYMENT_MESSAGES.invalidDisputeRequest);
    return { items: (await this.disputes.list(owner, status, n)).map(representDispute) };
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "PAY-09: one dispute of the Owner's Company: its verified chargeback fact, observations (with their dispositions), evidence references and decisions." })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  @ApiResponse({ status: 404, description: "not_found: unknown, or another Company's (one answer)" })
  @ApiResponse({ status: 503, description: 'owner_authority_unavailable' })
  async get(@Param('id') id: string, @Req() req: CallerRequest) {
    const owner = await this.owner(req);
    const x = await this.disputes.get(owner, id.toLowerCase());
    return {
      ...representDispute(x.dispute),
      chargeback: x.chargeback ? { factId: x.chargeback.id, providerTxnId: x.chargeback.providerTxnId, amount: Number(x.chargeback.amount), currency: x.chargeback.currency, observedAt: iso(x.chargeback.observedAt) } : null,
      observations: x.observations.map((o) => ({ kind: o.kind, disposition: o.disposition, reason: o.reason, observedAt: iso(o.observedAt) })),
      evidence: x.evidence.map(representEvidence),
      decisions: x.decisions.map(representDecision),
    };
  }

  @Post(':id/evidence')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'PAY-10: add an evidence reference to an open dispute (Owner): a file granted to payment-service as dispute_evidence for exactly this dispute.',
    description: 'Body {grantId, fileId}. File verifies the grant live (grantee, file, purpose, case). Append-only; the same file again answers the existing reference (200).',
  })
  @ApiResponse({ status: 201, description: 'The evidence reference.' })
  @ApiResponse({ status: 200, description: 'This file is already evidence of this dispute.' })
  @ApiResponse({ status: 400, description: 'invalid_dispute_request' })
  @ApiResponse({ status: 404, description: 'not_found' })
  @ApiResponse({ status: 409, description: 'dispute_not_open' })
  @ApiResponse({ status: 422, description: 'dispute_evidence_invalid: File does not grant this file to Payment as evidence of this dispute' })
  @ApiResponse({ status: 503, description: 'dispute_evidence_unavailable | owner_authority_unavailable (nothing recorded)' })
  async evidence(@Param('id') id: string, @Body() body: { grantId?: unknown; fileId?: unknown }, @Req() req: CallerRequest, @Res({ passthrough: true }) res: Response) {
    const owner = await this.owner(req);
    const { evidence, created } = await this.disputes.addEvidence(owner, id.toLowerCase(), body ?? {});
    res.status(created ? 201 : 200);
    return representEvidence(evidence);
  }

  @Post(':id/decision')
  @Header('Cache-Control', 'no-store')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8 to 128 of A-Z a-z 0-9 . _ : -' })
  @ApiOperation({
    summary: "PAY-11: record the Owner's contest-or-accept decision, authorized by an Auth dispute_decision receipt bound to this dispute, payment, decision and Company.",
    description: 'Body {decision: contest | accept, receiptSecret}. The receipt (factor-only dispute-decision step-up) is consumed once under the decision id. '
      + 'The decision never changes the dispute: the provider decides won or lost. A pending decision (503) resumes with the same key and receipt.',
  })
  @ApiResponse({ status: 201, description: 'The recorded decision.' })
  @ApiResponse({ status: 200, description: 'The decision this key already recorded.' })
  @ApiResponse({ status: 400, description: 'invalid_dispute_request | idempotency_key_required' })
  @ApiResponse({ status: 404, description: 'not_found' })
  @ApiResponse({ status: 409, description: 'dispute_not_open | dispute_decision_exists | dispute_decision_refused | dispute_decision_conflict' })
  @ApiResponse({ status: 422, description: 'idempotency_key_reused' })
  @ApiResponse({ status: 503, description: 'dispute_decision_unresolved (repeat the same request) | owner_authority_unavailable' })
  async decision(@Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: { decision?: unknown; receiptSecret?: unknown },
    @Req() req: CallerRequest, @Res({ passthrough: true }) res: Response) {
    const owner = await this.owner(req);
    const { decision, created } = await this.disputes.decide(owner, id.toLowerCase(), key, body ?? {});
    res.status(created ? 201 : 200);
    return representDecision(decision);
  }
}

/**
 * Core V2 S6e-D (the Owner's R6E-4, R6E-6): the payment's producer's authoritative reads, with its OWN service token and `payment.read`; only its
 * own payments (anything else is the collapsed 404, never "no dispute").
 */
@ApiTags('disputes')
@Controller('payment')
@UseGuards(ServiceTokenGuard, ServiceOperationGuard)
@RequireServiceOperation('payment.read')
@ApiBearerAuth()
export class DisputeServiceController {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  @Get('payments/:paymentId/dispute-exposure')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "R6E-4: a payment's dispute exposure (FC-5), from Payment's own rows: clear, exposed or unresolved (a preserved conflict or a loss without its chargeback fact).",
    description: 'Unresolved is never zero: a new refund case or attempt is refused. 404 is never "no dispute".',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  @ApiResponse({ status: 404, description: "not_found: unknown, or not this producer's payment" })
  async exposure(@Param('paymentId', new ParseUUIDPipe()) paymentId: string, @CallerService() caller: string) {
    const payment = (await this.db.query<PaymentRow>('SELECT * FROM payment WHERE id = $1', [paymentId.toLowerCase()])).rows[0];
    if (!payment || payment.producer !== caller) throw notFound();
    const e = await disputeExposure(this.db, payment.id);
    return { paymentId: payment.id, currency: payment.currency.trim(), ...e, asOf: new Date().toISOString() };
  }

  @Get('disputes/losses')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "R6E-6 recovery: the caller's lost disputes WITH their verified chargeback fact, by dispute id (keyset), for a consumer that missed payment.dispute.lost.",
  })
  @ApiQuery({ name: 'after', required: false, description: 'the last disputeId of the previous page' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 200 (default 100)' })
  @ApiResponse({ status: 200, description: '{ items }' })
  @ApiResponse({ status: 400, description: 'invalid_dispute_request' })
  async losses(@CallerService() caller: string, @Query('after') after?: string, @Query('limit') limit?: string) {
    const n = limit === undefined ? 100 : Number(limit);
    if ((after !== undefined && !UUID.test(after)) || !Number.isInteger(n) || n < 1 || n > 200) throw paymentError(400, 'invalid_dispute_request', PAYMENT_MESSAGES.invalidDisputeRequest);
    const { rows } = await this.db.query<DisputeRow & { paymentRequestId: string; cbAmount: string; cbCurrency: string }>(
      `SELECT d.*, p."paymentRequestId", f.amount AS "cbAmount", f.currency AS "cbCurrency"
         FROM payment_dispute d JOIN payment p ON p.id = d."paymentId" JOIN provider_transaction_fact f ON f.id = d."chargebackFactId"
        WHERE p.producer = $1 AND d.status = 'lost' AND ($2::uuid IS NULL OR d.id > $2::uuid) ORDER BY d.id LIMIT $3`,
      [caller, after ?? null, n],
    );
    return {
      items: rows.map((d) => ({
        disputeId: d.id, paymentId: d.paymentId, paymentRequestId: d.paymentRequestId, amount: Number(d.amount), currency: d.currency.trim(), lostAt: iso(d.closedAt),
        chargeback: { factId: d.chargebackFactId, amount: Number(d.cbAmount), currency: d.cbCurrency.trim() }, liveMode: false,
      })),
    };
  }
}
