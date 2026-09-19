import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ReadinessRegistry } from './readiness.registry.js';

/**
 * `/health` answers "is the process alive?" and never touches a dependency, so a database outage cannot make an
 * orchestrator restart a healthy process. `/ready` answers "can this instance safely receive traffic?" and runs the
 * registered dependency checks. Both are cheap, unauthenticated and leak no versions, hosts or error text.
 * Traefik routes only `/<service-prefix>`, so these root paths are not publicly reachable.
 */
@Controller()
export class HealthController {
  constructor(@Inject(ReadinessRegistry) private readonly registry: ReadinessRegistry) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const r = await this.registry.run();
    if (!r.ok) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'unavailable', failed: r.failed };
    }
    return { status: 'ready' };
  }
}
