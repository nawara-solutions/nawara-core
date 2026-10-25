import { Controller, Get, Header, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProperty, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { COMPONENT_KINDS, RELEASE_STATUSES } from '../domain/model.js';
import { OwnerGuard } from './owner.guard.js';
import { ReadService } from './read.service.js';

class ComponentRefDto {
  @ApiProperty({ example: 'mobile-app' }) component!: string;
  @ApiProperty({ enum: COMPONENT_KINDS }) kind!: string;
}
class ProductDto {
  @ApiProperty({ example: 'example-product' }) product!: string;
  @ApiProperty({ type: [ComponentRefDto] }) components!: ComponentRefDto[];
}
class ProductsDto {
  @ApiProperty({ type: [ProductDto] }) products!: ProductDto[];
}
class ReleaseDto {
  @ApiProperty({ example: '2.1.0' }) version!: string;
  @ApiProperty({ enum: RELEASE_STATUSES }) status!: string;
  @ApiProperty({ nullable: true, type: String }) buildId!: string | null;
  @ApiProperty({ nullable: true, type: String }) sourceRevision!: string | null;
  @ApiProperty({ nullable: true, type: String }) notesRef!: string | null;
  @ApiProperty({ format: 'date-time' }) registeredAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) publishedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) withdrawnAt!: string | null;
}
class ReleasePageDto {
  @ApiProperty() product!: string;
  @ApiProperty() component!: string;
  @ApiProperty({ enum: COMPONENT_KINDS }) kind!: string;
  @ApiProperty({ type: [ReleaseDto] }) releases!: ReleaseDto[];
  @ApiProperty({ nullable: true, type: String, description: 'Opaque; valid only with the same product, component and status; null at the end' }) nextCursor!: string | null;
}
class PolicyEntryDto {
  @ApiProperty() policyVersion!: number;
  @ApiProperty({ example: '2.0.0' }) minimumVersion!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
class PolicyHistoryDto {
  @ApiProperty() product!: string;
  @ApiProperty() component!: string;
  @ApiProperty({ enum: COMPONENT_KINDS.filter((k) => k !== 'backend') }) kind!: string;
  @ApiProperty({ type: [PolicyEntryDto] }) entries!: PolicyEntryDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

const PRODUCT = { name: 'product', description: 'Product registry key.', example: 'example-product' };
const COMPONENT = { name: 'component', description: 'Component registry key.', example: 'mobile-app' };
const AUTH_401 = { status: 401, description: 'no bearer, a bearer Auth refuses (expired, revoked, blocked), or a SERVICE token (never forwarded to Auth)' };
const AUTH_403 = { status: 403, description: 'operation_not_allowed: not the owner of the operating Company (a member, an operator or another Company\'s owner: one answer)' };
const AUTH_503 = { status: 503, description: 'auth_timeout | auth_unavailable: Auth could not verify the caller; nothing is returned' };

/**
 * Core V2 S2-Release.1 (register REL-01, REL-02, REL-03): the owner's READS of the release registry. The same guard as the Stage 20.4
 * writes: the caller's own Auth bearer, verified live as the owner of the configured operating Company (ADR-0050 decision 1). No step-up
 * (nothing changes), no CI, operator or member access, no request value as identity or scope. Mounted with the owner administration only.
 */
@ApiTags('owner administration')
@ApiBearerAuth()
@Controller('release/admin/products')
@UseGuards(OwnerGuard)
export class ReadController {
  constructor(@Inject(ReadService) private readonly reads: ReadService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'REL-01: the products of the release registry and their components (owner of the operating Company).' })
  @ApiResponse({ status: 200, type: ProductsDto })
  @ApiResponse({ status: 400, description: 'validation_error: a query parameter (none is accepted)' })
  @ApiResponse(AUTH_401)
  @ApiResponse(AUTH_403)
  @ApiResponse(AUTH_503)
  listProducts(@Query() query: unknown) {
    return this.reads.products(query);
  }

  @Get(':product/components/:component/releases')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'REL-02: a component\'s releases with their state and timestamps, newest registration first (owner of the operating Company).' })
  @ApiParam(PRODUCT)
  @ApiParam(COMPONENT)
  @ApiQuery({ name: 'status', required: false, enum: RELEASE_STATUSES })
  @ApiQuery({ name: 'limit', required: false, description: '1–100, default 50' })
  @ApiQuery({ name: 'cursor', required: false, description: 'the previous page\'s nextCursor, with the same product, component and status' })
  @ApiResponse({ status: 200, type: ReleasePageDto })
  @ApiResponse({ status: 400, description: 'validation_error: malformed key, status, limit or an unknown parameter | invalid_cursor' })
  @ApiResponse(AUTH_401)
  @ApiResponse(AUTH_403)
  @ApiResponse({ status: 404, description: 'component_not_found' })
  @ApiResponse(AUTH_503)
  listReleases(@Param('product') product: string, @Param('component') component: string, @Query() query: unknown) {
    return this.reads.releases(product, component, query);
  }

  @Get(':product/components/:component/compatibility-policy/history')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'REL-03: a client component\'s append-only compatibility-policy history, newest version first (owner of the operating Company).' })
  @ApiParam(PRODUCT)
  @ApiParam(COMPONENT)
  @ApiQuery({ name: 'limit', required: false, description: '1–100, default 50' })
  @ApiQuery({ name: 'cursor', required: false, description: 'the previous page\'s nextCursor, with the same product and component' })
  @ApiResponse({ status: 200, type: PolicyHistoryDto })
  @ApiResponse({ status: 400, description: 'validation_error | invalid_cursor' })
  @ApiResponse(AUTH_401)
  @ApiResponse(AUTH_403)
  @ApiResponse({ status: 404, description: 'component_not_found' })
  @ApiResponse({ status: 409, description: 'policy_not_applicable: a backend component has no compatibility policy' })
  @ApiResponse(AUTH_503)
  policyHistory(@Param('product') product: string, @Param('component') component: string, @Query() query: unknown) {
    return this.reads.policyHistory(product, component, query);
  }
}
