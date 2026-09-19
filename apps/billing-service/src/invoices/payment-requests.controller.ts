import { Controller, Get, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RateLimitService } from '@nawara/service-kit';
import { toDomainCaller } from '../auth/domain-caller.js';
import type { CallerRequest } from '../auth/service-or-user.guard.js';
import { ServiceOrUserGuard } from '../auth/service-or-user.guard.js';
import type { BillingConfig } from '../config/billing-config.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import { actorOf, requestTransitionContext } from '../domain/actors.js';
import { representPaymentRequest } from './payment-request.representation.js';
import { PaymentRequestRepository } from './payment-request.repository.js';

/**
 * Payment requests (SDD 18.1, endpoints 13-14). STAGE BOUNDARY (SDD stage 4; this Stage 3 delivery): this creates
 * Billing's OWN record of asking Payment to collect an invoice. It does NOT send anything to Payment — the dispatcher,
 * the Payment client, the reconciler and the event consumer are all Stage 4 and are not implemented here. A created
 * request therefore always answers with `status: "created"` and `paymentId: null`; a `sending`/`requested` status or a
 * non-null `paymentId` would mean the dispatcher had run, which it never does in this build. The API never claims a
 * payment was "sent" or "accepted" by Payment — only that Billing recorded the request.
 */
@ApiTags('payment-requests')
@Controller('billing')
export class PaymentRequestsController {
  constructor(
    private readonly paymentRequests: PaymentRequestRepository,
    private readonly rateLimit: RateLimitService,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  @Post('invoices/:invoiceId/payment-requests')
  @UseGuards(ServiceOrUserGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Create Billing\'s record of a request to collect an invoice (the payer, or the producer). This does NOT contact Payment: it only ' +
      'durably records the request in Billing. Sending it to Payment is Stage 4 (not implemented). State-idempotent: a second call while ' +
      'a request is still active (created/sending/requested) returns that SAME request, never a duplicate (BI-13).',
  })
  @ApiResponse({ status: 201, description: 'Request created (status: created, paymentId: null — not yet sent to Payment).' })
  @ApiResponse({ status: 200, description: 'The current active request was returned (state idempotency).' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409, description: 'invoice_not_payable (not open) or payment_request_not_supported (payer is not a user, B-026)' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  async create(@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string, @Req() req: CallerRequest, @Res({ passthrough: true }) res: Response) {
    // req.caller is always set here: ServiceOrUserGuard either sets it or throws 401 before this handler runs.
    const authCaller = req.caller!;
    const rateLimitKey = authCaller.kind === 'service' ? authCaller.service : authCaller.identity.id;
    await this.rateLimit.assert('billing-payment-request-create', rateLimitKey, { limit: this.config.rateLimits.paymentRequestCreatePerMinute, windowSec: 60 });

    const caller = toDomainCaller(authCaller);
    const ctx = requestTransitionContext(actorOf(caller));
    const { request, created } = await this.paymentRequests.createForInvoice(invoiceId, caller, ctx);
    res.status(created ? 201 : 200);
    if (!created) res.setHeader('Idempotent-Replayed', 'true');
    return representPaymentRequest(request);
  }

  @Get('payment-requests/:id')
  @UseGuards(ServiceOrUserGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get a Billing payment request. 404 (collapsed) when the caller has no relation to its invoice. Reflects Billing's OWN record only — never a live Payment status (that call is Stage 4)." })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  async get(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: CallerRequest) {
    const caller = toDomainCaller(req.caller!);
    return representPaymentRequest(await this.paymentRequests.findForCaller(id, caller));
  }
}
