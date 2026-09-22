import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CallerService, RateLimitService, ServiceOrUserGuard, ServiceTokenGuard, type CallerRequest } from '@nawara/service-kit';
import { toDomainCaller } from '../auth/domain-caller.js';
import type { BillingConfig } from '../config/billing-config.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { Caller } from '../domain/actors.js';
import { actorOf, requestTransitionContext } from '../domain/actors.js';
import { PAYMENT_CLIENT } from '../payment-integration/payment-client.token.js';
import type { PaymentClient } from '../payment-integration/payment-client.js';
import { representPaymentRequest } from './payment-request.representation.js';
import { PaymentRequestRepository } from './payment-request.repository.js';

/**
 * Payment requests (SDD 18.1, endpoints 13-15). Creation and read (13, 14) only ever touch Billing's own record —
 * a created request answers `status: "created"`, `paymentId: null` until the dispatcher (Stage 4, now built) sends
 * it. Cancel (15, Stage 4) has two distinct cases (SDD 17.3): a request never sent is cancelled locally, no Payment
 * call; a request already sent to Payment has `cancelRequestedAt` stamped and Payment's own cancel is called — the
 * request's terminal `cancelled` status still arrives only through the normal event/reconciliation path, never set
 * directly here, so the response never claims Payment has confirmed anything this endpoint alone cannot know.
 */
@ApiTags('payment-requests')
@Controller('billing')
export class PaymentRequestsController {
  constructor(
    private readonly paymentRequests: PaymentRequestRepository,
    private readonly rateLimit: RateLimitService,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    @Inject(PAYMENT_CLIENT) private readonly paymentClient: PaymentClient,
  ) {}

  @Post('invoices/:invoiceId/payment-requests')
  @UseGuards(ServiceOrUserGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Create Billing\'s record of a request to collect an invoice (the payer, or the producer). This call itself does NOT contact Payment ' +
      '— it durably records the request, and the dispatcher sends it asynchronously shortly after. State-idempotent: a second call while ' +
      'a request is still active (created/sending/requested) returns that SAME request, never a duplicate (BI-13).',
  })
  @ApiResponse({ status: 201, description: 'Request created (status: created, paymentId: null — the dispatcher has not sent it yet).' })
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
  @ApiOperation({ summary: "Get a Billing payment request. 404 (collapsed) when the caller has no relation to its invoice. Reflects Billing's OWN durable record, kept current by the event consumer and reconciler — never a synchronous live call to Payment." })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  async get(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: CallerRequest) {
    const caller = toDomainCaller(req.caller!);
    return representPaymentRequest(await this.paymentRequests.findForCaller(id, caller));
  }

  @Post('payment-requests/:id/cancel')
  @HttpCode(200)
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cancel a payment request (producer only). A request never sent to Payment is cancelled locally (200). A request already ' +
      'sent has cancellation requested at Payment; the request itself is NOT marked cancelled here — that arrives only through ' +
      'the normal event/reconciliation path once Payment confirms it, so a 200 here never claims Payment has already done so.',
  })
  @ApiResponse({ status: 200, description: 'Cancelled locally (never sent), or cancellation requested at Payment (terminal state arrives later).' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409, description: 'payment_request_in_flight: still being sent, or already closed' })
  async cancel(@CallerService() producer: string, @Param('id', new ParseUUIDPipe()) id: string) {
    const caller: Caller = { kind: 'service', service: producer };
    const ctx = requestTransitionContext(actorOf(caller));
    const request = await this.paymentRequests.findForCaller(id, caller);

    if (request.status === 'created') {
      return representPaymentRequest(await this.paymentRequests.cancelUnsent(id, caller, ctx));
    }

    const marked = await this.paymentRequests.markCancelRequested(id, caller); // throws 409 payment_request_in_flight for any other status
    // The deterministic key means a retried cancel call is a safe replay at Payment (SDD 21.2).
    await this.paymentClient.cancelPayment(marked.paymentId!, `billing-cancel-${marked.id}`);
    // Whatever Payment answered, Billing's own request status changes ONLY through the event/reconciliation path —
    // never directly from this response, so a lost or slow Payment answer can never leave Billing's record wrong.
    return representPaymentRequest(marked);
  }
}
