import { serviceActor } from '../audit/organization-audit.js';
import { Body, Controller, Get, Headers, Logger, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import { parseListQuery } from '../common/pagination.js';
import { representCompany, representPage } from '../common/representation.js';
import { normaliseCreateCompany, normaliseUpdateCompany } from '../domain/company-input.js';
import { requireIdempotencyKey } from '../idempotency/idempotency.service.js';
import { CompanyPageDto, CompanyDto, CreateCompanyDto, UpdateCompanyDto } from './company.dto.js';
import { CompanyRepository } from './company.repository.js';
import { ServicePolicyGuard } from '../authorization/service-policy.guard.js';
import { RequireCapability } from '../authorization/capability.js';
import { COMPANY_UPDATE } from '../authorization/service-policy.js';

/**
 * Companies. Service-token authentication ONLY, deny by default (ADR-0033): a user's bearer is never accepted here and never
 * sent anywhere. The calling service is recorded in the log; per-caller SCOPES are an open decision (ADR-0039: B-029/O-13/O-14),
 * so every registered caller currently has the same access. There is deliberately no DELETE route.
 */
@ApiTags('companies')
@ApiBearerAuth()
@UseGuards(ServiceTokenGuard, ServicePolicyGuard)
@Controller('organization/companies')
export class CompaniesController {
  private readonly log = new Logger('Companies');
  constructor(private readonly companies: CompanyRepository) {}

  @Post()
  @RequireCapability('hierarchy.provision')
  @ApiOperation({ summary: 'Create a company. Requires Idempotency-Key; an identical replay returns the same company.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8 to 128 characters of A-Z a-z 0-9 . _ : -' })
  @ApiBody({ type: CreateCompanyDto })
  @ApiResponse({ status: 201, type: CompanyDto, description: 'Company created.' })
  @ApiResponse({ status: 200, type: CompanyDto, description: 'Identical replay of an earlier create (Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_company_request or idempotency_key_required' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 422, description: 'idempotency_key_reused: the key was used with a different request' })
  async create(@CallerService() caller: string, @Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined, @Res({ passthrough: true }) res: Response) {
    const key = requireIdempotencyKey(idempotencyKey);
    const { company, replayed } = await this.companies.create(caller, key, normaliseCreateCompany(body), serviceActor(caller), { bootstrap: true });
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    else this.log.log(`company_created id=${company.id} caller=${caller}`);
    return representCompany(company);
  }

  @Get()
  @RequireCapability('hierarchy.read')
  @ApiOperation({ summary: 'List companies, newest first.' })
  @ApiQuery({ name: 'limit', required: false, description: 'Integer 1 to 100 (default 20).' })
  @ApiQuery({ name: 'cursor', required: false, description: 'The nextCursor of the previous page.' })
  @ApiResponse({ status: 200, type: CompanyPageDto })
  @ApiResponse({ status: 400, description: 'invalid_query' })
  @ApiResponse({ status: 401 })
  async list(@Query() query: Record<string, unknown>) {
    return representPage(await this.companies.list(parseListQuery(query)), representCompany);
  }

  @Get(':id')
  @RequireCapability('hierarchy.read')
  @ApiOperation({ summary: 'Get a company.' })
  @ApiResponse({ status: 200, type: CompanyDto })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return representCompany(await this.companies.get(id));
  }

  @Patch(':id')
  @RequireCapability(COMPANY_UPDATE)
  @ApiOperation({ summary: 'Update a company\'s name. Nothing else is client-writable.' })
  @ApiBody({ type: UpdateCompanyDto })
  @ApiResponse({ status: 200, type: CompanyDto })
  @ApiResponse({ status: 400, description: 'invalid_company_request' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  async update(@CallerService() caller: string, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const company = await this.companies.update(id, normaliseUpdateCompany(body), serviceActor(caller));
    this.log.log(`company_updated id=${id} caller=${caller}`);
    return representCompany(company);
  }
}
