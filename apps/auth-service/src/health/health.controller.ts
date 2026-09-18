import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DbService } from '../db/db.service.js';

/**
 * Public readiness probe, under the `/auth` prefix so it is reachable through the path-routed
 * gateway (the root `GET /` liveness route is not). Leaks nothing: no versions, hosts or errors.
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
  async health() {
    try {
      await this.db.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
    return { status: 'ok' };
  }
}
