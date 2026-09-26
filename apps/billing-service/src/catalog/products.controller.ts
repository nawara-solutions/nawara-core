import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CallerService, ServiceTokenGuard, RequireServiceOperation, ServiceOperationGuard } from '@nawara/service-kit';
import { OrganizationScopeService } from '../admission/organization-scope.service.js';
import type { Caller } from '../domain/actors.js';
import { normaliseCreateProductInput } from '../domain/product-input.js';
import { representProduct } from './catalog.representation.js';
import { ProductRepository } from './product.repository.js';

/**
 * Products (SDD 18.1, endpoints 1-3): a generic billable thing a seller offers. Service-token authentication only — a
 * product has no payer concept, and organization/user read access is not designed for the catalog. Controllers stay
 * thin: DTO/body normalisation, one repository call, the response shape.
 */
@ApiTags('products')
@Controller('billing/products')
export class ProductsController {
  constructor(private readonly products: ProductRepository, private readonly organizationScope: OrganizationScopeService) {}

  @Post()
  @UseGuards(ServiceTokenGuard, ServiceOperationGuard)
  @RequireServiceOperation('product.create')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a product (producer service only). Identical replay of the same (seller, code) returns the existing product.' })
  @ApiResponse({ status: 201, description: 'Product created.' })
  @ApiResponse({ status: 200, description: 'Identical replay of an existing product (Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_product_request' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted / organization_not_permitted (unknown or outside the caller\'s Platform scope: one answer)' })
  @ApiResponse({ status: 409, description: 'product_conflict: same (seller, code), different content' })
  @ApiResponse({ status: 503, description: 'hierarchy_unavailable: the organization could not be verified; nothing was written' })
  async create(@CallerService() producer: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = normaliseCreateProductInput(body);
    // Stage 21.C.2 (ADR-0052 decision 3): an Organization seller is verified BEFORE anything is written, unless (seller, code) already
    // exists (then this is a replay or a conflict of a product whose Organization was verified when it was created).
    if (input.seller.type === 'organization' && !(await this.products.naturalKeyExists(input))) await this.organizationScope.assertInScope(producer, input.seller.id);
    const { product, changed } = await this.products.create(producer, input);
    res.status(changed ? 201 : 200);
    if (!changed) res.setHeader('Idempotent-Replayed', 'true');
    return representProduct(product);
  }

  @Get(':id')
  @UseGuards(ServiceTokenGuard, ServiceOperationGuard)
  @RequireServiceOperation('product.read')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a product. 404 (collapsed) when the caller is not the producer that created it — never distinguishes "missing" from "forbidden".' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted: the calling service does not hold product.read' })
  @ApiResponse({ status: 404 })
  async get(@CallerService() producer: string, @Param('id', new ParseUUIDPipe()) id: string) {
    const caller: Caller = { kind: 'service', service: producer };
    return representProduct(await this.products.findForCaller(id, caller));
  }

  @Post(':id/archive')
  @HttpCode(200)
  @UseGuards(ServiceTokenGuard, ServiceOperationGuard)
  @RequireServiceOperation('product.archive')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Archive a product (active -> archived, one way). Existing invoices are untouched. Replays if already archived.' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted: the calling service does not hold product.archive' })
  @ApiResponse({ status: 404 })
  async archive(@CallerService() producer: string, @Param('id', new ParseUUIDPipe()) id: string) {
    const caller: Caller = { kind: 'service', service: producer };
    const { product } = await this.products.archive(id, caller);
    return representProduct(product);
  }
}
