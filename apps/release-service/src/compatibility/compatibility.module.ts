import { Module } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { CompatibilityCounters } from './compatibility-counters.js';
import { CompatibilityController } from './compatibility.controller.js';
import { CompatibilityLimiterJanitor, CompatibilityReporter } from './compatibility-ops.js';
import { CompatibilityService } from './compatibility.service.js';

/** Stage 20.5: the public compatibility read, its rate limit (kit limiter + janitor) and its bounded operational snapshot. */
@Module({
  imports: [PersistenceModule, RateLimitModule],
  controllers: [CompatibilityController],
  providers: [CompatibilityService, { provide: CompatibilityCounters, useValue: new CompatibilityCounters() }, CompatibilityReporter, CompatibilityLimiterJanitor],
  exports: [CompatibilityCounters],
})
export class CompatibilityModule {}
