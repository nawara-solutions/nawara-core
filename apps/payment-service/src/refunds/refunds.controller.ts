import { Body, Controller, Get, Header, Headers, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CallerService, RequireServiceOperation, ServiceOperationGuard, ServiceOrUserGuard, ServiceTokenGuard, type CallerRequest,
} from '@nawara/service-kit';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { REFUND_CREATE_OPERATION } from '../authorization/caller-admission.policy.js';
import { requestContext } from '../events/payment-events.js';
import { notFound, paymentError } from '../errors.js';
import { PAYMENT_MESSAGES } from '../messages.js';
import { PaymentService } from '../payments/payment.service.js';
import { RefundAttemptService, type CaptureEvidence } from './refund-attempt.service.js';
import { normaliseRefundRequest } from './refund-input.js';
import type { RefundAttemptRow } from './refund.types.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/** A refund attempt as Payment reports it: its authoritative state. Never the receipt secret or its digest. */
export function representRefundAttempt(a: RefundAttemptRow) {
  return {
    refundAttemptId: a.id, paymentId: a.paymentId, refundCaseId: a.refundCaseId, amount: Number(a.amount), currency: a.currency.trim(), reason: a.reason,
    legalOverride: a.legalOverride, status: a.status, approvedBy: a.approvedByUserId ? { userId: a.approvedByUserId } : null, receiptId: a.receiptId,
    authorizationRefusal: a.authorizationRefusal, providerRefundId: a.providerRefundId, failureCode: a.failureCode, requestedAt: iso(a.requestedAt),
    authorizedAt: iso(a.authorizedAt), submittedAt: iso(a.submittedAt), completedAt: iso(a.completedAt),
    // Core V2 R6H-5: the capture this attempt returns; `captureSpecific` when its receipt names it (an ordinary attempt returns the sale's capture)
    captureFactId: a.captureFactId, captureSpecific: a.captureSpecific,
  };
}

/**
 * Core V2 S6b refund attempts (register PAY-07, PAY-08; ADR-0067 decisions 5 to 7; the Owner's R6B-1 to R6B-10). DEVELOPMENT AND SIMULATION
 * ONLY: mounted only where `PAYMENT_SERVICE_POLICY` grants `payment.refund.create`, which production configuration refuses.
 */
@ApiTags('refunds')
@Controller('payment/payments/:paymentId/refunds')
export class RefundsController {
  constructor(
    private readonly refunds: RefundAttemptService,
    private readonly payments: PaymentService,
    private readonly authorization: AuthorizationService,
  ) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @UseGuards(ServiceTokenGuard, ServiceOperationGuard)
  @RequireServiceOperation(REFUND_CREATE_OPERATION)
  @ApiBearerAuth()
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Class M (90 days). The replay fingerprint never covers the receipt secret.' })
  @ApiOperation({
    summary: 'PAY-07: relay an Owner refund authorization (an Auth receipt) as one durable refund attempt, then consume the receipt (the payment\'s producer, billing-service only).',
    description: 'Body {refundAttemptId, refundCaseId, amount, currency, reason, legalOverride, receiptSecret}. Payment verifies the payment and its verified capture '
      + 'itself, commits the intent (refundAttemptId = the receipt consumeRef = the provider idempotency key), consumes the receipt at Auth, then answers. '
      + 'The provider refund is sent asynchronously. Repeating the same request (same key and receipt) resumes the same attempt.',
  })
  @ApiResponse({ status: 201, description: 'The attempt, authorized (or later), created by this call.' })
  @ApiResponse({ status: 200, description: 'The existing attempt (Idempotent-Replayed: true): its current authoritative state.' })
  @ApiResponse({ status: 400, description: 'invalid_refund_request | idempotency_key_required' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted: the caller does not hold payment.refund.create' })
  @ApiResponse({ status: 404, description: 'not_found: an unknown payment, or not this caller\'s (one answer)' })
  @ApiResponse({ status: 409, description: 'payment_not_refundable | refund_capture_unverified | refund_dispute_open | refund_in_progress | refund_already_recorded (each permanent for this refundAttemptId) | refund_attempt_conflict | refund_authorization_invalid | refund_authorization_expired (terminal for this attempt)' })
  @ApiResponse({ status: 422, description: 'refund_amount_not_full (permanent for this refundAttemptId) | idempotency_key_reused' })
  @ApiResponse({ status: 503, description: 'refund_authorization_unresolved: the attempt exists, its authorization is not yet confirmed (retry with the same key and receipt) | refund_dispute_unavailable: nothing was written' })
  async create(
    @CallerService() caller: string,
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.refunds.assertEnabled();
    if (!key || !IDEMPOTENCY_KEY.test(key)) throw paymentError(400, 'idempotency_key_required', PAYMENT_MESSAGES.idempotencyKeyRequired);
    const input = normaliseRefundRequest(body);
    const { attempt, created } = await this.refunds.request(caller, key, paymentId.toLowerCase(), input, requestContext({ type: 'service', id: caller }));
    res.status(created ? 201 : 200);
    if (!created) res.setHeader('Idempotent-Replayed', 'true');
    return representRefundAttempt(attempt);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @UseGuards(ServiceOrUserGuard, ServiceOperationGuard)
  @RequireServiceOperation('payment.read')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'PAY-08: the refund attempts of a payment and their authoritative state, the refund authorizations with their verified allocations and completion; for its producer, also the refused refund attempt ids and the refund facts not allocated (pending or blocked).' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  @ApiResponse({ status: 404, description: 'collapsed: unknown, or no relation to the payment' })
  async list(@Param('paymentId', new ParseUUIDPipe()) paymentId: string, @Req() req: CallerRequest) {
    this.refunds.assertEnabled();
    const payment = await this.payments.findById(paymentId.toLowerCase());
    if (!payment || !req.caller) throw notFound();
    const relation = await this.authorization.assertCanRead(payment, req.caller);
    const { attempts, refusals, authorizations, allocations, unallocated } = await this.refunds.listForPayment(payment.id, relation === 'producer');
    return {
      paymentId: payment.id,
      attempts: attempts.map(representRefundAttempt),
      // Core V2 S6c (R6C-12): each authorization's approved amount, cumulative intended allocation, completion and verified allocations
      authorizations: authorizations.map((z) => ({
        refundAuthorizationId: z.id, refundAttemptId: z.refundAttemptId, refundCaseId: z.refundCaseId, approvedAmount: Number(z.approvedAmount), currency: z.currency.trim(),
        allocatedIntended: Number(z.allocatedIntended), completedAt: iso(z.completedAt),
        allocations: allocations.filter((a) => a.refundAuthorizationId === z.id).map((a) => ({
          factId: a.factId, amount: Number(a.amount), currency: a.currency.trim(), intended: Number(a.intended), excess: Number(a.excess), allocatedAt: iso(a.allocatedAt) })),
      })),
      ...(unallocated ? { unallocatedFacts: unallocated.map((f) => ({ factId: f.factId, refundAttemptId: f.refundAttemptId, amount: Number(f.amount), currency: f.currency,
        observedAt: iso(f.observedAt), state: f.blockedReason ? 'blocked' : 'pending', blockedReason: f.blockedReason })) } : {}),
      ...(refusals ? { refusals: refusals.map((r) => ({ refundAttemptId: r.id, refundCaseId: r.refundCaseId, code: r.code, refusedAt: iso(r.refusedAt) })) } : {}),
    };
  }
}

const representCapture = (c: CaptureEvidence) => ({
  factId: c.factId, paymentId: c.paymentId, provider: c.provider, amount: c.amount, currency: c.currency, paymentStatus: c.paymentStatus, basis: c.basis,
  conflicted: c.conflicted, refund: c.refund, refundableOnItsOwn: c.refundableOnItsOwn, observedAt: iso(c.observedAt),
});

/**
 * Core V2 R6H-5 (the Owner's decision, 2026-10-30): Payment's evidence of ONE verified capture of a payment, for the payment's own producer
 * (`payment.read`; another caller, or a fact that is not a capture of this payment, is 404). Billing reads it to bind a capture-specific
 * refund case to exactly that capture, with the amount and currency of the capture itself (never a caller's). DEVELOPMENT AND SIMULATION ONLY.
 */
@ApiTags('refunds')
@Controller('payment/payments/:paymentId/captures')
export class RefundCapturesController {
  constructor(@Inject(RefundAttemptService) private readonly refunds: RefundAttemptService) {}

  @Get(':factId')
  @Header('Cache-Control', 'no-store')
  @UseGuards(ServiceTokenGuard, ServiceOperationGuard)
  @RequireServiceOperation('payment.read')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'R6H-5: one verified capture of the caller\'s own payment: amount, currency, provider, the payment status, its basis '
      + '(settling_capture | duplicate_capture | other_attempt_capture | late_capture | associated_capture), whether it is contested, and the refund '
      + 'state of THIS captured money (none | in_progress | refunded).',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  @ApiResponse({ status: 404, description: 'not_found (the payment, or not its producer) | capture_not_found' })
  async read(@Param('paymentId', new ParseUUIDPipe()) paymentId: string, @Param('factId', new ParseUUIDPipe()) factId: string, @CallerService() caller: string) {
    return representCapture(await this.refunds.capture(caller, paymentId.toLowerCase(), factId.toLowerCase()));
  }
}
