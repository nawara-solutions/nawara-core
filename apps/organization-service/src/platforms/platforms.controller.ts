import { Body, Controller, Get, Headers, Logger, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import { parseListQuery } from '../common/pagination.js';
import { representPage, representPlatform } from '../common/representation.js';
import { normaliseCreatePlatform, normaliseUpdatePlatform } from '../domain/platform-input.js';
import { requireIdempotencyKey } from '../idempotency/idempotency.service.js';
import { CreatePlatformDto, PlatformDto, PlatformPageDto, UpdatePlatformDto } from './platform.dto.js';
import { PlatformRepository } from './platform.repository.js';

/** Platforms: each belongs to exactly one company (`companyId`, immutable). Service-token authentication only, no DELETE route. */
@ApiTags('platforms')
@ApiBearerAuth()
@UseGuards(ServiceTokenGuard)
@Controller('organization/platforms')
export class PlatformsController {
  private readonly log = new Logger('Platforms');
  constructor(private readonly platforms: PlatformRepository) {}

  @Post()
  @ApiOperation({ summary: 'Create a platform under an existing company. Requires Idempotency-Key.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8 to 128 characters of A-Z a-z 0-9 . _ : -' })
  @ApiBody({ type: CreatePlatformDto })
  @ApiResponse({ status: 201, type: PlatformDto })
  @ApiResponse({ status: 200, type: PlatformDto, description: 'Identical replay of an earlier create (Idempotent-Replayed: true).' })
  @ApiResponse({ status: 400, description: 'invalid_platform_request or idempotency_key_required' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404, description: 'company_not_found: companyId does not name a company in this service' })
  @ApiResponse({ status: 422, description: 'idempotency_key_reused' })
  async create(@CallerService() caller: string, @Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined, @Res({ passthrough: true }) res: Response) {
    const key = requireIdempotencyKey(idempotencyKey);
    const { platform, replayed } = await this.platforms.create(caller, key, normaliseCreatePlatform(body));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    else this.log.log(`platform_created id=${platform.id} companyId=${platform.companyId} caller=${caller}`);
    return representPlatform(platform);
  }

  @Get()
  @ApiOperation({ summary: 'List platforms, newest first, optionally of one company.' })
  @ApiQuery({ name: 'companyId', required: false, description: 'Only the platforms of this company.' })
  @ApiQuery({ name: 'limit', required: false, description: 'Integer 1 to 100 (default 20).' })
  @ApiQuery({ name: 'cursor', required: false, description: 'The nextCursor of the previous page.' })
  @ApiResponse({ status: 200, type: PlatformPageDto })
  @ApiResponse({ status: 400, description: 'invalid_query' })
  @ApiResponse({ status: 401 })
  async list(@Query() query: Record<string, unknown>) {
    return representPage(await this.platforms.list(parseListQuery(query, ['companyId'])), representPlatform);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a platform.' })
  @ApiResponse({ status: 200, type: PlatformDto })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return representPlatform(await this.platforms.get(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a platform\'s name. `companyId` is immutable and refused.' })
  @ApiBody({ type: UpdatePlatformDto })
  @ApiResponse({ status: 200, type: PlatformDto })
  @ApiResponse({ status: 400, description: 'invalid_platform_request' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 404 })
  async update(@CallerService() caller: string, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const platform = await this.platforms.update(id, normaliseUpdatePlatform(body));
    this.log.log(`platform_updated id=${id} caller=${caller}`);
    return representPlatform(platform);
  }
}
