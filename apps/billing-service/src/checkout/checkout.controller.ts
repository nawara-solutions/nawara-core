import { Body, Controller, Header, Headers, Inject, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RateLimitService, resolveLocale, type AuthIdentity } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { requestTransitionContext } from '../domain/actors.js';
import { idempotencyKey } from '../fees/fee-input.js';
import { normaliseCheckoutInput } from './checkout-input.js';
import { CheckoutMember, CheckoutMemberGuard } from './checkout-member.guard.js';
import { CheckoutService } from './checkout.service.js';

class CheckoutDto {
  @ApiProperty({ format: 'uuid', description: 'A configured Platform.' }) platformId!: string;
  @ApiProperty({ format: 'uuid', description: 'An active personal subscription product of that Platform (no universal plan).' }) productId!: string;
  @ApiProperty({ format: 'uuid', description: 'An effective, unretired recurring price of that product, in the Platform currency.' }) priceId!: string;
}

class CheckoutResultDto {
  @ApiProperty({ format: 'uuid' }) invoiceId!: string;
  @ApiProperty({ format: 'uuid', description: 'Poll GET /billing/payment-requests/{id} (your own request) for its progress.' }) paymentRequestId!: string;
  @ApiProperty({ type: String, nullable: true, description: 'null until the asynchronous dispatcher has an identifier from Payment; never invented.' }) paymentId!: string | null;
  @ApiProperty({ enum: ['created', 'sending', 'requested'], description: "The payment request's status. Never settlement: entitlement follows only Payment's verified success." }) status!: string;
}

/**
 * Core V2 S3f (register BIL-10; FC-12): direct checkout of a personal subscription product. DEVELOPMENT AND SIMULATION ONLY (G-2): this
 * controller is not mounted in production (B-001, B-007 unresolved).
 */
@ApiTags('checkout')
@ApiBearerAuth()
@Controller('billing/checkout')
@UseGuards(CheckoutMemberGuard) // the verified member BEFORE body validation
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly rateLimit: RateLimitService,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  @Post('direct')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Check out one personal subscription product (simulation and development only; never in production).',
    description: 'Creates, issues and requests payment for an invoice in one transaction: one line, quantity 1, routed `direct_purchase` to you, ' +
      'the Platform\'s Company as the SIMULATION seller reference (not a legal seller), reference snapshots with an undetermined legal identity. ' +
      'Payment is contacted asynchronously. A second checkout of the same product and price while yours is unfinished returns that one (200); ' +
      'another price is 409 checkout_uncertain. Nothing here grants entitlement.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8-128 of [A-Za-z0-9._:-], bound to you and this exact request; replays the original result (Idempotent-Replayed: true).' })
  @ApiBody({ type: CheckoutDto })
  @ApiResponse({ status: 201, type: CheckoutResultDto, description: 'Created: an issued invoice and a payment request (paymentId usually null).' })
  @ApiResponse({ status: 200, type: CheckoutResultDto, description: 'Your unfinished checkout of this product and price, or a replay of this key.' })
  @ApiResponse({ status: 400, description: 'invalid_checkout_request | idempotency_key_required' })
  @ApiResponse({ status: 401, description: 'no bearer, a bearer Auth refuses, or a SERVICE token (never forwarded)' })
  @ApiResponse({ status: 403, description: 'member_not_eligible: inactive, or an Owner or Operator' })
  @ApiResponse({ status: 409, description: 'platform_not_configured | product_not_available | checkout_uncertain | idempotency_key_conflict' })
  @ApiResponse({ status: 422, description: 'price_not_available' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  @ApiResponse({ status: 503, description: 'Auth could not verify you; nothing was created' })
  async direct(@CheckoutMember() member: AuthIdentity, @Headers('idempotency-key') key: unknown, @Headers('accept-language') acceptLanguage: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const k = idempotencyKey(key);
    const input = normaliseCheckoutInput(body);
    await this.rateLimit.assert('billing-checkout', member.id, { limit: this.config.rateLimits.invoiceCreatePerMinute, windowSec: 60 });
    const ctx = requestTransitionContext({ type: 'user', id: member.id, userKind: 'member' }); // the kind Auth verified (guard), never the request
    const r = await this.checkout.checkout(member.id, k, input, resolveLocale(acceptLanguage), ctx);
    res.status(r.status);
    if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return r.body;
  }
}
