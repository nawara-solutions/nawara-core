import { Controller, Get, HttpException, Inject, Param, Req, Res, UseGuards, applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import { AuditPageDto } from './query.dto.js';
import { AuditQueryService, type AuditPage } from './query.service.js';

const FILTERS: Array<[string, string]> = [
  ['from', 'required: UTC instant, inclusive (occurredAt >= from)'],
  ['to', 'required: UTC instant, exclusive (occurredAt < to)'],
  ['limit', '1–100, default 50'],
  ['cursor', 'the previous page\'s nextCursor, with the SAME query'],
  ['action', 'a cataloged action'],
  ['category', 'security | business | commercial | administrative'],
  ['actorType', 'with actorId: user | service | system'],
  ['actorId', 'with actorType'],
  ['resourceType', 'with resourceId'],
  ['resourceId', 'UUID, with resourceType'],
  ['subjectType', 'with subjectId'],
  ['subjectId', 'UUID, with subjectType'],
  ['sourceService', 'a cataloged producer'],
  ['outcome', 'succeeded | denied'],
  ['correlationId', 'navigation only'],
];
const ApiFilters = () => applyDecorators(...FILTERS.map(([name, description]) => ApiQuery({ name, required: name === 'from' || name === 'to', description })));
const ApiErrors = () =>
  applyDecorators(
    ApiResponse({ status: 400, description: 'invalid_query | invalid_scope | invalid_cursor | window_too_large | unexpected_body' }),
    ApiResponse({ status: 401, description: 'Missing or invalid service token' }),
    ApiResponse({ status: 403, description: 'operation_not_allowed | category_not_allowed | source_not_allowed' }),
    ApiResponse({ status: 429, description: 'rate_limited' }),
  );

/**
 * Audit reads (Stage 18.6) for trusted internal services only: a service token (the kit guard), then the caller policy. No end-user
 * authentication, no call to any other service, no display enrichment: identifiers and codes. Responses are never cached
 * (`Cache-Control: no-store`); a GET with a body is refused.
 */
@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
@UseGuards(ServiceTokenGuard)
export class AuditQueryController {
  constructor(@Inject(AuditQueryService) private readonly queries: AuditQueryService) {}

  @Get('organizations/:organizationId/records')
  @ApiOperation({ summary: 'Audit records of ONE organization (read_organization)', description: 'Only records whose organization is the path\'s; platform-level records never. Newest first (occurredAt, then insertion). An organization without records is an empty page (Audit does not know which organizations exist).' })
  @ApiParam({ name: 'organizationId', format: 'uuid' })
  @ApiFilters()
  @ApiResponse({ status: 200, type: AuditPageDto })
  @ApiErrors()
  organization(@CallerService() caller: string, @Param('organizationId') organizationId: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuditPage> {
    prepare(req, res);
    return this.queries.organization(caller, organizationId, req.query);
  }

  @Get('platform/records')
  @ApiOperation({ summary: 'Platform-scope audit records (read_platform)', description: 'Every organization and platform-level records; narrow with organizationId (one organization) or platform=true (platform-level only). At most 31 days per request. Every page read is itself recorded (platform_query.executed); if that record cannot be written, nothing is returned (503).' })
  @ApiQuery({ name: 'organizationId', required: false, description: 'UUID: only this organization' })
  @ApiQuery({ name: 'platform', required: false, description: 'true: only platform-level records (organizationId null)' })
  @ApiFilters()
  @ApiResponse({ status: 200, type: AuditPageDto })
  @ApiResponse({ status: 503, description: 'accountability_unavailable: the read could not be recorded, so nothing is returned' })
  @ApiErrors()
  platform(@CallerService() caller: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuditPage> {
    prepare(req, res);
    return this.queries.platform(caller, req.query);
  }
}

/** Evidence is never cached anywhere; a read carries no body (nothing ambiguous, nothing large). */
function prepare(req: Request, res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > 0 || req.headers['transfer-encoding'] !== undefined) throw new HttpException({ message: 'A read takes no request body.', code: 'unexpected_body' }, 400);
}
