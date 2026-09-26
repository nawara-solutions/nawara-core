import { Controller, Get, HttpCode, Inject, Logger, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CallerService, RateLimitService, ServiceOrUserGuard, ServiceTokenGuard, type CallerRequest, RequireServiceOperation, ServiceOperationGuard } from '@nawara/service-kit';
import { toDomainCaller } from '../auth/domain-caller.js';
import type { BillingConfig } from '../config/billing-config.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { Caller } from '../domain/actors.js';
import { actorOf, requestTransitionContext, withVerifiedKind } from '../domain/actors.js';
import { PAYMENT_CLIENT } from '../payment-integration/payment-client.token.js';
import type { PaymentClient } from '../payment-integration/payment-client.js';
import { billingError } from '../domain/errors.js';
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
  private readonly logger = new Logger('PaymentRequests');

  constructor(
    private readonly paymentRequests: PaymentRequestRepository,
    private readonly rateLimit: RateLimitService,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    @Inject(PAYMENT_CLIENT) private readonly paymentClient: PaymentClient,
  ) {}

  @Post('invoices/:invoiceId/payment-requests')
  @UseGuards(ServiceOrUserGuard, ServiceOperationGuard)
  @RequireServiceOperation('payment_request.create')
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
  @ApiResponse({ status: 403, description: 'operation_not_permitted: the calling service does not hold payment_request.create' })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409, description: 'invoice_not_payable (not open) or payment_request_not_supported (payer is not a user, B-026)' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  async create(@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string, @Req() req: CallerRequest, @Res({ passthrough: true }) res: Response) {
    // req.caller is always set here: ServiceOrUserGuard either sets it or throws 401 before this handler runs.
    const authCaller = req.caller!;
    const rateLimitKey = authCaller.kind === 'service' ? authCaller.service : authCaller.identity.id;
    await this.rateLimit.assert('billing-payment-request-create', rateLimitKey, { limit: this.config.rateLimits.paymentRequestCreatePerMinute, windowSec: 60 });

    const caller = toDomainCaller(authCaller);
    const ctx = requestTransitionContext(withVerifiedKind(actorOf(caller), authCaller)); // Stage 18.7: the kind Auth verified, never the request
    const { request, created } = await this.paymentRequests.createForInvoice(invoiceId, caller, ctx);
    res.status(created ? 201 : 200);
    if (!created) res.setHeader('Idempotent-Replayed', 'true');
    return representPaymentRequest(request);
  }

  @Get('payment-requests/:id')
  @UseGuards(ServiceOrUserGuard, ServiceOperationGuard)
  @RequireServiceOperation('payment_request.read')
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get a Billing payment request. 404 (collapsed) when the caller has no relation to its invoice. Reflects Billing's OWN durable record, kept current by the event consumer and reconciler — never a synchronous live call to Payment." })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted: the calling service does not hold payment_request.read' })
  @ApiResponse({ status: 404 })
  async get(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: CallerRequest) {
    const caller = toDomainCaller(req.caller!);
    return representPaymentRequest(await this.paymentRequests.findForCaller(id, caller));
  }

  @Post('payment-requests/:id/cancel')
  @HttpCode(200)
  @UseGuards(ServiceTokenGuard, ServiceOperationGuard)
  @RequireServiceOperation('payment_request.cancel')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cancel a payment request (producer only). A request never sent to Payment is cancelled locally (200). A request already ' +
      'sent has cancellation requested at Payment; the request itself is NOT marked cancelled here — that arrives only through ' +
      'the normal event/reconciliation path once Payment confirms it, so a 200 here never claims Payment has already done so.',
  })
  @ApiResponse({ status: 200, description: 'Cancelled locally (never sent), or cancellation requested at Payment (terminal state arrives later).' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted: the calling service does not hold payment_request.cancel' })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409, description: 'payment_request_in_flight: still being sent, already closed, or Payment refused (an attempt or cash submission is in progress)' })
  @ApiResponse({ status: 503, description: 'payment_unavailable: Payment could not confirm the cancellation; nothing was accepted. Retrying the same call is safe.' })
  async cancel(@CallerService() producer: string, @Param('id', new ParseUUIDPipe()) id: string) {
    const caller: Caller = { kind: 'service', service: producer };
    const ctx = requestTransitionContext(actorOf(caller)); // service-only route: the actor is the authenticated service
    const request = await this.paymentRequests.findForCaller(id, caller);

    if (request.status === 'created') {
      return representPaymentRequest(await this.paymentRequests.cancelUnsent(id, caller, ctx));
    }
    // Stage 15.5 (F-B): a retry after a lost answer may find the cancellation already applied; that is its success, not a conflict.
    if (request.status === 'cancelled') return representPaymentRequest(request);

    const marked = await this.paymentRequests.markCancelRequested(id, caller); // throws 409 payment_request_in_flight for any other status
    // The deterministic key means a retried cancel call is a safe replay at Payment (SDD 21.2).
    const outcome = await this.paymentClient.cancelPayment(marked.paymentId!, `billing-cancel-${marked.id}`);
    // Stage 15.5 (F-B): success is answered ONLY when Payment confirmed the cancellation (or already reached a terminal state, which
    // the event/reconciliation path settles, SDD 21.2). Anything else used to be answered 200 too, and nothing ever re-sent it: a
    // cancellation made while Payment was unavailable was silently lost and the payment stayed payable. The caller now gets a
    // retryable 503 (a retry is a safe replay: same idempotency key, marker not re-stamped).
    switch (outcome.kind) {
      case 'cancelled':
      case 'already_terminal':
        // Billing's own request status still changes ONLY through the event/reconciliation path, never from this response.
        return representPaymentRequest(marked);
      case 'in_flight':
        throw billingError(409, 'payment_request_in_flight', 'Payment refused the cancellation: a payment attempt or cash submission is in progress.');
      default:
        this.logger[outcome.kind === 'transient' ? 'warn' : 'error'](
          `payment_cancel_unconfirmed request=${marked.id} outcome=${outcome.kind} — answered 503; the caller must retry`,
        );
        throw billingError(503, 'payment_unavailable', 'Payment could not confirm the cancellation. Retry the same request.');
    }
  }
}
