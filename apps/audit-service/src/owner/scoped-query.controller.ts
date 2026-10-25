import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, HttpException, Inject, Param, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { SERVICE_TOKENS, hashServiceToken, type ServiceTokenEntry, httpError } from '@nawara/service-kit';
import { ScopedAuditPageDto } from '../query/query.dto.js';
import { AuditQueryService, type AuditPage } from '../query/query.service.js';
import { AUDIT_MESSAGES } from '../messages.js';

/** The response of the scoped reads (register AUD-03 / AUD-04: `{records, nextCursor}`). */
export interface ScopedAuditPage {
  records: AuditPage['items'];
  nextCursor: string | null;
}

const COMMON_QUERY = [
  ApiQuery({ name: 'from', required: true, description: 'UTC instant, inclusive' }),
  ApiQuery({ name: 'to', required: true, description: 'UTC instant, exclusive; at most 31 days after from' }),
  ApiQuery({ name: 'action', required: false, description: 'a cataloged action' }),
  ApiQuery({ name: 'correlationId', required: false, description: 'navigation only: it narrows, never widens the scope' }),
  ApiQuery({ name: 'limit', required: false, description: '1–100, default 50' }),
  ApiQuery({ name: 'cursor', required: false, description: 'the previous page\'s nextCursor: signed, expiring, valid only for the same caller and query' }),
];
const applyAll = (decorators: MethodDecorator[]): MethodDecorator => (target, key, descriptor) => {
  for (const d of decorators) d(target, key, descriptor);
};

/**
 * Core V2 S2-Audit.3 (ADR-0069 decisions 4 and 5; register AUD-03, AUD-04): the scoped human reads of TRUSTED evidence, with the caller's
 * OWN Auth bearer. Identity and scope come only from Auth's live grants (an owner's Company, an operator's active assignments); a path value
 * only selects among them; no header, body, claim, payload or correlation id is identity or scope. A service token is refused here. Only
 * records with a trusted scope row (written for broker-verified deliveries) are returned; everything else is invisible. Every page is
 * recorded (`platform_query.executed`), or nothing is returned (503).
 */
@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
export class ScopedAuditQueryController {
  constructor(
    @Inject(AuditQueryService) private readonly queries: AuditQueryService,
    @Inject(SERVICE_TOKENS) private readonly serviceTokens: ServiceTokenEntry[],
  ) {}

  @Get('owner/company/records')
  @ApiOperation({ summary: 'AUD-03: the trusted audit timeline of the caller\'s Company (Company owner, own bearer)', description: 'Only records with a trusted Company scope row for the owner\'s Company (Auth\'s live answer). Newest first, at most 31 days, 100 per page.' })
  @applyAll(COMMON_QUERY)
  @ApiResponse({ status: 200, type: ScopedAuditPageDto })
  @ApiResponse({ status: 400, description: 'invalid_query | invalid_cursor | window_too_large | unexpected_body' })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer (a service token is refused here)' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed: not a Company owner' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  @ApiResponse({ status: 503, description: 'Auth could not be asked, or the read could not be recorded: nothing is returned' })
  async company(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ScopedAuditPage> {
    const bearer = this.prepare(req, res);
    return wire(await this.queries.companyTimeline(bearer, req.query));
  }

  @Get('operator/platforms/:platformId/records')
  @ApiOperation({ summary: 'AUD-04: the trusted audit records of ONE Platform the caller is currently assigned to (operator, own bearer)', description: 'Only records with a trusted Platform scope row for that Platform. Assignment is Auth\'s live answer on every page. Newest first, at most 31 days, 100 per page.' })
  @ApiParam({ name: 'platformId', format: 'uuid' })
  @applyAll(COMMON_QUERY)
  @ApiResponse({ status: 200, type: ScopedAuditPageDto })
  @ApiResponse({ status: 400, description: 'invalid_query | invalid_scope | invalid_cursor | window_too_large | unexpected_body' })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer (a service token is refused here)' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed: not an operator' })
  @ApiResponse({ status: 404, description: 'Not assigned to that Platform (never assigned, revoked or unknown): indistinguishable' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  @ApiResponse({ status: 503, description: 'Auth could not be asked, or the read could not be recorded: nothing is returned' })
  async platform(@Param('platformId') platformId: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ScopedAuditPage> {
    const bearer = this.prepare(req, res);
    return wire(await this.queries.operatorPlatform(bearer, platformId, req.query));
  }

  private prepare(req: Request, res: Response): string {
    res.setHeader('Cache-Control', 'no-store');
    const bearer = this.humanBearer(req);
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > 0 || req.headers['transfer-encoding'] !== undefined) throw httpError(400, 'unexpected_body', AUDIT_MESSAGES.unexpectedBody);
    return bearer;
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

const wire = (p: AuditPage): ScopedAuditPage => ({ records: p.items, nextCursor: p.nextCursor });
