import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CallerService, RateLimitService, ServiceOrUserGuard, ServiceTokenGuard, type CallerRequest } from '@nawara/service-kit';
import { toDomainCaller } from '../auth/domain-caller.js';
import type { BillingConfig } from '../config/billing-config.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import { actorOf, requestTransitionContext } from '../domain/actors.js';
import { normaliseCreateInvoiceInput, normaliseInvoiceListFilters, normaliseIssueInvoiceInput } from '../domain/invoice-input.js';
import { SYSTEM_TEMPLATE_V1 } from '../domain/snapshots.js';
import { decodeCursor, parseLimit, toPage } from '../common/pagination.js';
import { representInvoice, representInvoiceSummary } from './invoice.representation.js';
import { InvoiceRepository } from './invoice.repository.js';
import { PaymentRequestRepository } from './payment-request.repository.js';

/**
 * Invoices (SDD 18.1, endpoints 7-11). Controllers stay thin: body/query normalisation, one repository call, the
 * response shape. Every financial value (totals, currency, number) is server-computed by the repository/domain layer;
 * nothing here ever accepts one from the client (section 19.5).
 */
@ApiTags('invoices')
@Controller('billing/invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoiceRepository,
    private readonly paymentRequests: PaymentRequestRepository,
    private readonly rateLimit: RateLimitService,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  @Post()
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a draft invoice (producer service only). Identical replay of the same invoiceRequestId returns the existing draft. No amount, total, tax, currency or status field: everything is computed server-side from catalog prices.' })
  @ApiResponse({ status: 201, description: 'Draft created.' })
  @ApiResponse({ status: 200, description: 'Identical replay of an existing draft (Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_invoice_request' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 409, description: 'invoice_request_conflict: same invoiceRequestId, different content' })
  @ApiResponse({ status: 422, description: 'unsupported_currency or price_not_available' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  async create(@CallerService() producer: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    await this.rateLimit.assert('billing-invoice-create', producer, { limit: this.config.rateLimits.invoiceCreatePerMinute, windowSec: 60 });
    const input = normaliseCreateInvoiceInput(body);
    const ctx = requestTransitionContext({ type: 'service', id: producer });
    const { invoice, changed } = await this.invoices.createDraft(producer, input, this.config.supportedCurrencies, ctx);
    res.status(changed ? 201 : 200);
    if (!changed) res.setHeader('Idempotent-Replayed', 'true');
    return representInvoice(invoice, null); // a fresh draft can never have a payment request (open-only, BI-13)
  }

  @Get(':id')
  @UseGuards(ServiceOrUserGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get an invoice. 404 (collapsed) when the caller has no relation to it (not the producer, not the payer) — never distinguishes "missing" from "forbidden".' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  async get(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: CallerRequest) {
    // req.caller is always set here: ServiceOrUserGuard either sets it or throws 401 before this handler runs.
    const caller = toDomainCaller(req.caller!);
    const invoice = await this.invoices.findForCaller(id, caller);
    const active = await this.paymentRequests.findActiveForInvoice(id);
    return representInvoice(invoice, active);
  }

  @Get()
  @UseGuards(ServiceOrUserGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'List invoices in the caller\'s own scope only: a producer sees only what it created; a user bearer sees only invoices where they are the payer. ' +
      'A filter that does not match the caller\'s own scope narrows to an empty page, never to another caller\'s data. Organization-member visibility is not implemented (B-027).',
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'sourceType', required: false })
  @ApiQuery({ name: 'sourceId', required: false })
  @ApiQuery({ name: 'payerType', required: false })
  @ApiQuery({ name: 'payerId', required: false })
  @ApiQuery({ name: 'dueBefore', required: false })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  async list(@Req() req: CallerRequest, @Query() query: Record<string, unknown>) {
    // req.caller is always set here: ServiceOrUserGuard either sets it or throws 401 before this handler runs.
    const caller = toDomainCaller(req.caller!);
    const limit = parseLimit(query.limit);
    const cursor = typeof query.cursor === 'string' && query.cursor !== '' ? decodeCursor(query.cursor) : null;
    const filters = normaliseInvoiceListFilters(query);
    const rows = await this.invoices.listForCaller(caller, filters, limit, cursor);
    const page = toPage(rows, limit);
    return { items: page.items.map(representInvoiceSummary), nextCursor: page.nextCursor };
  }

  @Post(':id/issue')
  @HttpCode(200)
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Issue a draft (draft -> open): assigns the number, sets the presentation snapshot, enqueues invoice.created. Replays if already open. Producer only.' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 400, description: 'invalid_invoice_request: a bad optional locale' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403 })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409, description: 'invalid_state_transition: the invoice is paid or void' })
  async issue(@CallerService() producer: string, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const { locale } = normaliseIssueInvoiceInput(body);
    const caller = { kind: 'service' as const, service: producer };
    const ctx = requestTransitionContext(actorOf(caller));
    const { invoice } = await this.invoices.issue(id, caller, { template: SYSTEM_TEMPLATE_V1, locale }, ctx);
    return representInvoice(invoice, await this.paymentRequests.findActiveForInvoice(id));
  }

  @Post(':id/discard')
  @HttpCode(200)
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Discard a draft (draft -> void): abandoning a draft that was never announced. No number consumed, no event. Producer only.' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403 })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409, description: 'invalid_state_transition: the invoice is not a draft' })
  async discard(@CallerService() producer: string, @Param('id', new ParseUUIDPipe()) id: string) {
    const caller = { kind: 'service' as const, service: producer };
    const ctx = requestTransitionContext(actorOf(caller));
    const { invoice } = await this.invoices.discard(id, caller, ctx);
    return representInvoice(invoice, null); // a void draft never had an active request (BI-13 requires `open`)
  }
}
