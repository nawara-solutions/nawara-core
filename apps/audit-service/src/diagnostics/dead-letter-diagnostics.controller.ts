import { Controller, Get, Inject, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CallerService, ServiceTokenGuard, httpError } from '@nawara/service-kit';
import { AUDIT_MESSAGES } from '../messages.js';
import { DeadLetterDiagnosticsService, type CoverageView, type DiagnosticPage, type TransitionView } from './dead-letter-diagnostics.service.js';

const WINDOW = [
  ApiQuery({ name: 'from', required: true, description: 'UTC instant, inclusive (recordedAt >= from)' }),
  ApiQuery({ name: 'to', required: true, description: 'UTC instant, exclusive; at most 24 hours after from' }),
  ApiQuery({ name: 'limit', required: false, description: '1–100, default 50' }),
  ApiQuery({ name: 'cursor', required: false, description: 'the previous page\'s nextCursor, with the SAME query' }),
];
const ERRORS = [
  ApiResponse({ status: 400, description: 'invalid_query | invalid_cursor | window_too_large | unexpected_body' }),
  ApiResponse({ status: 401, description: 'Missing or invalid service token' }),
  ApiResponse({ status: 403, description: 'operation_not_allowed (read_dead_letter_diagnostics)' }),
  ApiResponse({ status: 429, description: 'rate_limited' }),
];
const apply = (...d: Array<MethodDecorator>): MethodDecorator => (t, k, desc) => { for (const x of d) x(t, k, desc); };

/**
 * Core V2 DO-43a (the Owner's D43-4): DEVELOPMENT AND SIMULATION DIAGNOSTICS ONLY, mounted only with `AUDIT_DEAD_LETTER_OBSERVATION=enabled`
 * (production refuses it). Service token only: there is no human route. Header-only; never cached; a GET with a body is refused. These rows
 * are best-effort observations: an empty result never proves that no dead letter exists.
 */
@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit/diagnostics/dead-letter')
@UseGuards(ServiceTokenGuard)
export class DeadLetterDiagnosticsController {
  constructor(@Inject(DeadLetterDiagnosticsService) private readonly diagnostics: DeadLetterDiagnosticsService) {}

  @Get('transitions')
  @ApiOperation({ summary: 'Dead-letter transfer transitions (read_dead_letter_diagnostics; development only)', description: 'attempted / transfer_confirmed / transfer_unconfirmed per physical transfer attempt, oldest first. Header-only. Best effort: missing rows are expected after an outage, a crash or a saturated buffer; read them with the coverage facts.' })
  @apply(...WINDOW)
  @ApiQuery({ name: 'consumer', required: false, description: 'the consumer queue' })
  @ApiQuery({ name: 'eventId', required: false, description: 'the delivery\'s message id' })
  @ApiQuery({ name: 'attemptId', required: false, description: 'UUID of one transfer attempt' })
  @ApiResponse({ status: 200, description: '{ items, nextCursor, notice }' })
  @apply(...ERRORS)
  transitions(@CallerService() caller: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<DiagnosticPage<TransitionView>> {
    prepare(req, res);
    return this.diagnostics.transitions(caller, req.query);
  }

  @Get('coverage')
  @ApiOperation({ summary: 'Dead-letter observation coverage facts (read_dead_letter_diagnostics; development only)', description: 'started / heartbeat / stopped per process instance, with cumulative counters, oldest first.' })
  @apply(...WINDOW)
  @ApiQuery({ name: 'instanceId', required: false, description: 'UUID of one process instance' })
  @ApiResponse({ status: 200, description: '{ items, nextCursor, notice }' })
  @apply(...ERRORS)
  coverage(@CallerService() caller: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<DiagnosticPage<CoverageView>> {
    prepare(req, res);
    return this.diagnostics.coverage(caller, req.query);
  }
}

function prepare(req: Request, res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > 0 || req.headers['transfer-encoding'] !== undefined) throw httpError(400, 'unexpected_body', AUDIT_MESSAGES.unexpectedBody);
}
