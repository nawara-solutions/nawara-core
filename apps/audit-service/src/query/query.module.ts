import { Module } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { QueryCounters } from './query-counters.js';
import { AuditQueryController } from './query.controller.js';
import { QueryReporter } from './query-reporter.js';
import { RateLimitJanitor } from './rate-limit-janitor.js';
import { AuditQueryService } from './query.service.js';

/** Stage 18.6: the organization / platform audit reads (service token + `AUDIT_SERVICE_POLICY`; the kit's Postgres rate limiter); Stage 18.8: its bounded state purge. */
@Module({
  imports: [PersistenceModule, RateLimitModule],
  controllers: [AuditQueryController],
  providers: [{ provide: QueryCounters, useValue: new QueryCounters() }, AuditQueryService, QueryReporter, RateLimitJanitor],
  exports: [AuditQueryService, QueryCounters],
})
export class QueryModule {}
