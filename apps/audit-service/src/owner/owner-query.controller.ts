import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, HttpException, Inject, Param, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { SERVICE_TOKENS, hashServiceToken, type ServiceTokenEntry } from '@nawara/service-kit';
import { AuditPageDto } from '../query/query.dto.js';
import { AuditQueryService, type AuditPage } from '../query/query.service.js';

/**
 * Stage 19.3 Audit-X (ADR-0050 decision 6): a Company owner reads the audit records of ONE organization of their own Company, with their OWN
 * Auth bearer. Audit verifies the owner and the organization through Auth; no header, body, claim or correlation id is identity or scope.
 * A service token is refused here and never forwarded to Auth (services keep their own routes). Platform-level records never.
 */
@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit/owner')
export class OwnerAuditQueryController {
  constructor(
    @Inject(AuditQueryService) private readonly queries: AuditQueryService,
    @Inject(SERVICE_TOKENS) private readonly serviceTokens: ServiceTokenEntry[],
  ) {}

  @Get('organizations/:organizationId/records')
  @ApiOperation({
    summary: 'Audit records of ONE organization of the caller\'s Company (Company owner, own bearer)',
    description: 'Only records whose organization is the path\'s; platform-level records never. At most 31 days, 100 per page. The filters of the organization read apply (action, category, actorType/actorId, resourceType/resourceId, subjectType/subjectId, sourceService, outcome, correlationId). Every page read is itself recorded (platform_query.executed, the owner as actor); if that record cannot be written, nothing is returned (503).',
  })
  @ApiParam({ name: 'organizationId', format: 'uuid' })
  @ApiQuery({ name: 'from', required: true, description: 'UTC instant, inclusive' })
  @ApiQuery({ name: 'to', required: true, description: 'UTC instant, exclusive; at most 31 days after from' })
  @ApiQuery({ name: 'limit', required: false, description: '1–100, default 50' })
  @ApiQuery({ name: 'cursor', required: false, description: 'the previous page\'s nextCursor, with the SAME query' })
  @ApiResponse({ status: 200, type: AuditPageDto })
  @ApiResponse({ status: 400, description: 'invalid_query | invalid_scope | invalid_cursor | window_too_large | unexpected_body' })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer (a service token is refused here)' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed: not a Company owner' })
  @ApiResponse({ status: 404, description: 'No such organization, or not of your Company — indistinguishable' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  @ApiResponse({ status: 503, description: 'Auth could not be asked, or the read could not be recorded: nothing is returned' })
  async organization(@Param('organizationId') organizationId: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuditPage> {
    res.setHeader('Cache-Control', 'no-store');
    const bearer = this.humanBearer(req);
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > 0 || req.headers['transfer-encoding'] !== undefined) throw new HttpException({ message: 'A read takes no request body.', code: 'unexpected_body' }, 400);
    return this.queries.owner(bearer, organizationId, req.query);
  }

  /** The caller's own bearer; a service token (any configured digest, compared in constant time) is refused and never sent to Auth. */
  private humanBearer(req: Request): string {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._~+/=-]{1,4096})$/.exec(header) : null;
    const unauthenticated = new HttpException({ message: 'Unauthorized', code: 'unauthenticated' }, 401);
    if (!match) throw unauthenticated;
    const presented = Buffer.from(hashServiceToken(match[1]!), 'hex');
    let service = false;
    for (const e of this.serviceTokens) if (timingSafeEqual(presented, Buffer.from(e.digest, 'hex'))) service = true;
    if (service) throw unauthenticated;
    return match[1]!;
  }
}
