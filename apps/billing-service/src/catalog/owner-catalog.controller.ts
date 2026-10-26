import { Body, Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import type { VerifiedPlatformOwner } from '../platforms/owner-authority.client.js';
import { PlatformOwner, PlatformOwnerGuard } from '../platforms/owner.guard.js';
import { representPrice, representProduct } from './catalog.representation.js';
import { normaliseOwnerPriceInput, normaliseOwnerProductInput } from './owner-catalog-input.js';
import { OwnerCatalogRepository, type OwnerWriteResult } from './owner-catalog.repository.js';

class OwnerProductDto {
  @ApiProperty({ description: "^[a-z][a-z0-9_-]{1,62}$; unique per seller, i.e. per Company (D-CAT-10). With name, description and entitlementKind it is the product's immutable content." }) code!: string;
  @ApiProperty({ description: 'At most 140 characters, not blank.' }) name!: string;
  @ApiPropertyOptional({ description: 'At most 280 characters, not blank; null or absent for none.' }) description?: string | null;
  @ApiPropertyOptional({ enum: ['none', 'organization_license', 'user_subscription'], description: 'A compatibility field, never commercial authority (ADR-0045); default none.' }) entitlementKind?: string;
}

class OwnerPriceDto {
  @ApiProperty({ description: "^[A-Za-z0-9._:-]{1,128}$; the price's identity within its product (the natural key of a replay)." }) clientReference!: string;
  @ApiProperty({ description: "A positive integer in minor units of the Platform's one currency (S3d), at most 2^53 - 1." }) unitAmount!: number;
  @ApiProperty({ enum: ['day', 'week', 'month', 'year'] }) intervalUnit!: string;
  @ApiProperty({ description: 'An integer >= 1: the period is intervalCount × intervalUnit.' }) intervalCount!: number;
  @ApiProperty({ format: 'date-time', description: 'An RFC 3339 timestamp with an offset; the price is sellable from then (it may lie in the future).' }) effectiveFrom!: string;
}

const PLATFORM = { name: 'platformId', format: 'uuid', description: "A Platform of the calling Owner's Company (Auth decides, live)." };
const PRODUCT = { name: 'productId', format: 'uuid', description: "An Owner product of this Platform." };
const PRICE = { name: 'priceId', format: 'uuid', description: "A price of an Owner product of this Platform." };
const R400_ID = { status: 400, description: 'a platformId, productId or priceId that is not a uuid' };
const R401 = { status: 401, description: 'no bearer, a bearer Auth refuses (expired, revoked, blocked), or a SERVICE token (never forwarded to Auth)' };
const R403 = { status: 403, description: 'operation_not_permitted: the caller is not an Owner (an operator or a member: one answer)' };
const R404 = { status: 404, description: "not_found: an unknown Platform or one outside the Owner's Company; an unknown product or price, another Platform's, or a producer's (one answer)" };
const R409_PLATFORM = { status: 409, description: "platform_not_configured: the Owner's Platform has no billing configuration (S3d)" };
const R503 = { status: 503, description: 'auth_timeout | auth_unavailable: Auth could not verify the Owner or the Platform; nothing was changed' };

function answer<T>(res: Response, r: OwnerWriteResult<T>, created: boolean): void {
  res.status(r.changed && created ? 201 : 200);
  if (!r.changed) res.setHeader('Idempotent-Replayed', 'true');
}

/**
 * Core V2 S3g (register BIL-02, BIL-03; D-CAT-1 to D-CAT-10): the Owner's catalog administration for Core V2 development and simulation.
 * Human only: the caller's own Auth bearer, verified live as an Owner whose Company the Platform belongs to (`/auth/grants` then
 * `/auth/platform-access`), before any body validation. No step-up (D-CAT-3). Personal subscription products only (D-CAT-5a); the seller
 * is the Platform's Company reference (D-CAT-2, not a legal issuer). These routes configure no catalog VALUE themselves: names, durations,
 * amounts and dates are the Owner's input (OD-05). The producer routes (`/billing/products`, `/billing/prices`) are unchanged.
 */
@ApiTags('owner catalog')
@ApiBearerAuth()
@Controller('billing/admin/platforms/:platformId')
@UseGuards(PlatformOwnerGuard)
export class OwnerCatalogController {
  constructor(
    private readonly catalog: OwnerCatalogRepository,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  @Post('products')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Create a personal subscription product of this Platform (Owner of its Company).',
    description: "Seller company:<the Platform's Company>, target personal, this Platform: Billing's, never the body's. An identical repeat " +
      "of (Company, code) answers 200 with the existing product (Idempotent-Replayed: true); any other content is 409 product_conflict.",
  })
  @ApiParam(PLATFORM)
  @ApiBody({ type: OwnerProductDto })
  @ApiResponse({ status: 201, description: 'Created: the product, as the producer route represents it.' })
  @ApiResponse({ status: 200, description: 'Identical repeat: nothing was written (Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_product_request: an unknown field (seller, platformId, subscriptionTarget, ...) or an invalid value; or a platformId that is not a uuid' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse({ status: 409, description: "product_conflict: the Company's code exists with other content (another Platform, or a producer's product) | platform_not_configured" })
  @ApiResponse(R503)
  async createProduct(@PlatformOwner() owner: VerifiedPlatformOwner, @Param('platformId') platformId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.catalog.createProduct(owner, platformId.toLowerCase(), normaliseOwnerProductInput(body));
    answer(res, r, true);
    return representProduct(r.row);
  }

  @Post('products/:productId/prices')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Create a recurring price of an Owner product, in the Platform\'s one currency (Owner of its Company).',
    description: 'Prices are immutable and may coexist: several periods, amounts or start dates of one product are all sellable, each by its ' +
      'own priceId. An identical repeat of (product, clientReference) answers 200 (Idempotent-Replayed: true); other content is 409 price_conflict.',
  })
  @ApiParam(PLATFORM)
  @ApiParam(PRODUCT)
  @ApiBody({ type: OwnerPriceDto })
  @ApiResponse({ status: 201, description: 'Created: the price, as the producer route represents it.' })
  @ApiResponse({ status: 200, description: 'Identical repeat: nothing was written (Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_price_request: an unknown field (currency, interval, productId, ...) or an invalid value; or an id that is not a uuid' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse({ status: 409, description: 'price_conflict: the clientReference exists on this product with other terms | platform_not_configured' })
  @ApiResponse({ status: 422, description: "unsupported_currency: this deployment no longer supports the Platform's currency" })
  @ApiResponse(R503)
  async createPrice(
    @PlatformOwner() owner: VerifiedPlatformOwner, @Param('platformId') platformId: string, @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body() body: unknown, @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.catalog.createPrice(owner, platformId.toLowerCase(), productId.toLowerCase(), normaliseOwnerPriceInput(body), this.config.supportedCurrencies);
    answer(res, r, true);
    return representPrice(r.row);
  }

  @Post('products/:productId/archive')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Archive an Owner product (active -> archived, one way): no new sale of any of its prices. Nothing sold is changed.' })
  @ApiParam(PLATFORM)
  @ApiParam(PRODUCT)
  @ApiResponse({ status: 200, description: 'The archived product (Idempotent-Replayed: true when it already was).' })
  @ApiResponse(R400_ID)
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse(R409_PLATFORM)
  @ApiResponse(R503)
  async archive(@PlatformOwner() owner: VerifiedPlatformOwner, @Param('platformId') platformId: string, @Param('productId', new ParseUUIDPipe()) productId: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.catalog.archive(owner, platformId.toLowerCase(), productId.toLowerCase());
    answer(res, r, false);
    return representProduct(r.row);
  }

  @Post('prices/:priceId/retire')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Retire a price of an Owner product (retiredAt set once): no new sale or renewal on it. Nothing sold is changed.' })
  @ApiParam(PLATFORM)
  @ApiParam(PRICE)
  @ApiResponse({ status: 200, description: 'The retired price (Idempotent-Replayed: true when it already was).' })
  @ApiResponse(R400_ID)
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse(R409_PLATFORM)
  @ApiResponse(R503)
  async retire(@PlatformOwner() owner: VerifiedPlatformOwner, @Param('platformId') platformId: string, @Param('priceId', new ParseUUIDPipe()) priceId: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.catalog.retire(owner, platformId.toLowerCase(), priceId.toLowerCase());
    answer(res, r, false);
    return representPrice(r.row);
  }

  @Get('products')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "The Owner's products of this Platform, every status, each with its prices (every state), oldest first." })
  @ApiParam(PLATFORM)
  @ApiResponse({ status: 200, description: '{products: [{...product, prices: [price]}]}' })
  @ApiResponse({ status: 400, description: 'a platformId that is not a uuid' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, description: "not_found: an unknown Platform, or one outside the Owner's Company (one answer)" })
  @ApiResponse(R409_PLATFORM)
  @ApiResponse(R503)
  async list(@PlatformOwner() owner: VerifiedPlatformOwner, @Param('platformId') platformId: string) {
    const entries = await this.catalog.list(owner, platformId.toLowerCase());
    return { products: entries.map((e) => ({ ...representProduct(e.product), prices: e.prices.map(representPrice) })) };
  }
}
