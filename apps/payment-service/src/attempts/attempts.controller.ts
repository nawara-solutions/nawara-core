import { Body, Controller, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RateLimitService, ServiceOrUserGuard, type CallerRequest } from '@nawara/service-kit';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import type { PaymentConfig } from '../config/payment-config.js';
import { requestContext } from '../events/payment-events.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { paymentError } from '../errors.js';
import { PaymentService } from '../payments/payment.service.js';
import { AttemptService } from './attempt.service.js';
import { StartAttemptDto } from './dto/start-attempt.dto.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

@ApiTags('attempts')
@Controller('payment/payments/:paymentId/attempts')
export class AttemptsController {
  constructor(
    private readonly attempts: AttemptService,
    private readonly payments: PaymentService,
    private readonly authorization: AuthorizationService,
    private readonly rateLimit: RateLimitService,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
  ) {}

  @Post()
  @UseGuards(ServiceOrUserGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start a payment attempt against a provider (the payer only). Requires Idempotency-Key.' })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 400, description: 'idempotency_key_required' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted' })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409, description: 'payment_not_payable / payment_expired / payment_has_open_attempt' })
  @ApiResponse({ status: 422, description: 'invalid_provider' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  async start(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Body() dto: StartAttemptDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: CallerRequest,
  ) {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw paymentError(400, 'idempotency_key_required', 'A valid Idempotency-Key header is required.');
    }
    const payment = await this.payments.findById(paymentId);
    if (!payment || !req.caller) throw paymentError(404, 'not_found', 'Not found.');
    this.authorization.assertCanStartAttempt(payment, req.caller);
    const callerId = req.caller.kind === 'user' ? req.caller.identity.id : req.caller.service;
    // After authentication and authorization, so only a real payer consumes (and can exhaust) their own budget.
    await this.rateLimit.assert('payment-attempt', callerId, { limit: this.config.rateLimits.attemptPerMinute, windowSec: 60 });
    const userKind = req.caller.kind === 'user' ? (req.caller.identity.adminTier ?? 'member') : undefined; // Auth-verified, never the body
    const { attempt } = await this.attempts.start(paymentId, callerId, idempotencyKey, dto, userKind);
    return representAttempt(attempt);
  }

  @Post(':attemptId/sync')
  @HttpCode(200)
  @UseGuards(ServiceOrUserGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Ask the provider for the attempt's current status and apply it if valid. The client's own claim is never used." })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  async sync(@Param('paymentId', new ParseUUIDPipe()) paymentId: string, @Param('attemptId', new ParseUUIDPipe()) attemptId: string, @Req() req: CallerRequest) {
    const payment = await this.payments.findById(paymentId);
    if (!payment || !req.caller) throw paymentError(404, 'not_found', 'Not found.');
    this.authorization.assertCanSync(payment, req.caller);
    const attempt = await this.attempts.findById(attemptId);
    if (!attempt || attempt.paymentId !== paymentId) throw paymentError(404, 'not_found', 'Not found.');
    const actor = req.caller.kind === 'user' ? ({ type: 'user', id: req.caller.identity.id } as const) : ({ type: 'service', id: req.caller.service } as const);
    // Stage 18.7 (G1): a user's kind comes from Auth's verified identity (its admin tier), never from the request.
    const userKind = req.caller.kind === 'user' ? (req.caller.identity.adminTier ?? 'member') : undefined;
    const synced = await this.attempts.sync(attemptId, { ...requestContext(actor), ...(userKind ? { userKind } : {}) });
    return representAttempt(synced);
  }
}

function representAttempt(attempt: { id: string; attemptNumber: number; provider: string; status: string; failureCode: string | null; providerData: unknown }) {
  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    provider: attempt.provider,
    status: attempt.status,
    failureCode: attempt.failureCode,
    nextAction: attempt.providerData ?? null,
  };
}
