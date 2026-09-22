import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DbService } from '../db/db.service.js';

/**
 * Public readiness probe, under the `/auth` prefix so it is reachable through the path-routed
 * gateway (the root `GET /` liveness route is not). Leaks nothing: no versions, hosts or errors.
 * Writes its response directly (`@Res({ passthrough: true })`) rather than throwing: this is the one
 * route production deploy tooling, Docker Compose and CI already poll, so its exact `{status:...}` body
 * (with no `statusCode`/`message`/`error`/`requestId`) must stay byte-identical through Stage 13.2's new
 * global exception filter, which would otherwise wrap it in the kit's error shape.
 */
@ApiTags('health')
@Controller('auth')
export class HealthController {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** public */
  @Get('health')
  @ApiOperation({ summary: 'Readiness: the service is up and can reach its database.' })
  @ApiResponse({ status: 200, description: 'Service and database are reachable.' })
  @ApiResponse({ status: 503, description: 'Database unreachable.' })
  async health(@Res({ passthrough: true }) res: Response) {
    try {
      await this.db.query('SELECT 1');
    } catch {
      res.status(503);
      return { status: 'unavailable' };
    }
    return { status: 'ok' };
  }
}
