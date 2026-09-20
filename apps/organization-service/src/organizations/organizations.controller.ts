import { Body, Controller, Get, Headers, Logger, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import { parseListQuery } from '../common/pagination.js';
import { representOrganization, representPage } from '../common/representation.js';
import { normaliseCreateOrganization, normaliseUpdateOrganization } from '../domain/organization-input.js';
import { requireIdempotencyKey } from '../idempotency/idempotency.service.js';
import { CreateOrganizationDto, OrganizationDto, OrganizationPageDto, UpdateOrganizationDto } from './organization.dto.js';
import { OrganizationRepository } from './organization.repository.js';

/**
 * Organizations: each belongs to exactly one platform (`platformId`, immutable) and reaches its company only through it.
 * Service-token authentication only, no DELETE route, and NO membership routes: a user's relationship to an organization
 * (OrganizationMembership) is owned by auth-service and never here.
 */
@ApiTags('organizations')
@ApiBearerAuth()
@UseGuards(ServiceTokenGuard)
@Controller('organization/organizations')
export class OrganizationsController {
  private readonly log = new Logger('Organizations');
  constructor(private readonly organizations: OrganizationRepository) {}

  @Post()
  @ApiOperation({ summary: 'Create an organization under an existing platform. Requires Idempotency-Key.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8 to 128 characters of A-Z a-z 0-9 . _ : -' })
  @ApiBody({ type: CreateOrganizationDto })
  @ApiResponse({ status: 201, type: OrganizationDto })
  @ApiResponse({ status: 200, type: OrganizationDto, description: 'Identical replay of an earlier create (Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_organization_request or idempotency_key_required' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404, description: 'platform_not_found: platformId does not name a platform in this service' })
  @ApiResponse({ status: 422, description: 'idempotency_key_reused' })
  async create(@CallerService() caller: string, @Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined, @Res({ passthrough: true }) res: Response) {
    const key = requireIdempotencyKey(idempotencyKey);
    const { organization, replayed } = await this.organizations.create(caller, key, normaliseCreateOrganization(body));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    else this.log.log(`organization_created id=${organization.id} platformId=${organization.platformId} caller=${caller}`);
    return representOrganization(organization);
  }

  @Get()
  @ApiOperation({ summary: 'List organizations, newest first, optionally of one platform.' })
  @ApiQuery({ name: 'platformId', required: false, description: 'Only the organizations of this platform.' })
  @ApiQuery({ name: 'limit', required: false, description: 'Integer 1 to 100 (default 20).' })
  @ApiQuery({ name: 'cursor', required: false, description: 'The nextCursor of the previous page.' })
  @ApiResponse({ status: 200, type: OrganizationPageDto })
  @ApiResponse({ status: 400, description: 'invalid_query' })
  @ApiResponse({ status: 401 })
  async list(@Query() query: Record<string, unknown>) {
    return representPage(await this.organizations.list(parseListQuery(query, ['platformId'])), representOrganization);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an organization.' })
  @ApiResponse({ status: 200, type: OrganizationDto })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return representOrganization(await this.organizations.get(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an organization\'s name and descriptive fields. `platformId` is immutable and refused; null clears an optional field.' })
  @ApiBody({ type: UpdateOrganizationDto })
  @ApiResponse({ status: 200, type: OrganizationDto })
  @ApiResponse({ status: 400, description: 'invalid_organization_request' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  async update(@CallerService() caller: string, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const organization = await this.organizations.update(id, normaliseUpdateOrganization(body));
    this.log.log(`organization_updated id=${id} caller=${caller}`);
    return representOrganization(organization);
  }
}
