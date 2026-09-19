import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CallerService, DbService, RateLimitService, ServiceTokenGuard } from '@nawara/service-kit';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import type { PaymentConfig } from '../config/payment-config.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { CallerRequest } from '../auth/service-or-user.guard.js';
import { ServiceOrUserGuard } from '../auth/service-or-user.guard.js';
import { notFound } from '../errors.js';
import { CreatePaymentDto } from './dto/create-payment.dto.js';
import { representPayment } from './payment.representation.js';
import { PaymentService } from './payment.service.js';

@ApiTags('payments')
@Controller('payment/payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentService,
    private readonly authorization: AuthorizationService,
    private readonly db: DbService,
    private readonly rateLimit: RateLimitService,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
  ) {}

  @Post()
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a payment (producer service only). Identical replay of the same paymentRequestId returns the existing payment.' })
  @ApiResponse({ status: 201, description: 'Payment created.' })
  @ApiResponse({ status: 200, description: 'Identical replay of an existing payment (Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_payment_request' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 409, description: 'payment_request_conflict: same paymentRequestId, different snapshot' })
  @ApiResponse({ status: 422, description: 'unsupported_currency' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  async create(@CallerService() producer: string, @Body() dto: CreatePaymentDto, @Res({ passthrough: true }) res: Response) {
    // Keyed by the AUTHENTICATED producer (the guard already ran), so an unauthenticated caller cannot write limiter rows.
    await this.rateLimit.assert('payment-create', producer, { limit: this.config.rateLimits.createPerMinute, windowSec: 60 });
    const { payment, replayed } = await this.payments.create(producer, dto);
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return representPayment(this.db, payment);
  }

  @Get(':id')
  @UseGuards(ServiceOrUserGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a payment. 404 (collapsed) when the caller has no relation to it — never distinguishes "missing" from "forbidden".' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  async get(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: CallerRequest) {
    const payment = await this.payments.findById(id);
    if (!payment || !req.caller) throw notFound();
    this.authorization.assertCanRead(payment, req.caller);
    return representPayment(this.db, payment);
  }
}
