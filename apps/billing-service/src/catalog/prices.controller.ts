import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import type { Caller } from '../domain/actors.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { normaliseCreatePriceInput } from '../domain/price-input.js';
import { representPrice } from './catalog.representation.js';
import { PriceRepository } from './price.repository.js';

/** Prices (SDD 18.1, endpoints 4-6): a reusable, immutable price of a product. Reached only through its parent product's producer. */
@ApiTags('prices')
@Controller('billing/prices')
export class PricesController {
  constructor(
    private readonly prices: PriceRepository,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  @Post()
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a price for a product the caller produced. Identical replay of the same (productId, clientReference) returns the existing price.' })
  @ApiResponse({ status: 201, description: 'Price created.' })
  @ApiResponse({ status: 200, description: 'Identical replay of an existing price (Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_price_request' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404, description: 'the product does not exist, or was not created by this producer' })
  @ApiResponse({ status: 409, description: 'price_conflict: same (productId, clientReference), different content' })
  @ApiResponse({ status: 422, description: 'unsupported_currency' })
  async create(@CallerService() producer: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = normaliseCreatePriceInput(body);
    const caller: Caller = { kind: 'service', service: producer };
    const { price, changed } = await this.prices.create(caller, input, this.config.supportedCurrencies);
    res.status(changed ? 201 : 200);
    if (!changed) res.setHeader('Idempotent-Replayed', 'true');
    return representPrice(price);
  }

  @Get(':id')
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get a price. 404 (collapsed) when the caller did not produce this price's product." })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  async get(@CallerService() producer: string, @Param('id', new ParseUUIDPipe()) id: string) {
    const caller: Caller = { kind: 'service', service: producer };
    return representPrice(await this.prices.findForCaller(id, caller));
  }

  @Post(':id/retire')
  @HttpCode(200)
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Retire a price (sets retiredAt once). Existing invoices are untouched. Replays if already retired.' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  async retire(@CallerService() producer: string, @Param('id', new ParseUUIDPipe()) id: string) {
    const caller: Caller = { kind: 'service', service: producer };
    const { price } = await this.prices.retire(id, caller);
    return representPrice(price);
  }
}
