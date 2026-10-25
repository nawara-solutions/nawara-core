import { Module, type DynamicModule } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import type { AuditConfig } from '../config/audit-config.js';
import { HttpOwnerAuthority, OWNER_AUTHORITY, type OwnerAuthority } from '../owner/owner-authority.client.js';
import { OwnerAuditQueryController } from '../owner/owner-query.controller.js';
import { ScopedAuditQueryController } from '../owner/scoped-query.controller.js';
import { LegalHoldController } from '../legal-hold/legal-hold.controller.js';
import { LegalHoldService } from '../legal-hold/legal-hold.service.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { QueryCounters } from './query-counters.js';
import { AuditQueryController } from './query.controller.js';
import { QueryReporter } from './query-reporter.js';
import { RateLimitJanitor } from './rate-limit-janitor.js';
import { AuditQueryService } from './query.service.js';

/**
 * Stage 18.6: the organization / platform audit reads (service token + `AUDIT_SERVICE_POLICY`; the kit's Postgres rate limiter); Stage 18.8:
 * its bounded state purge. Stage 19.3 (Audit-X): the Company owner's organization read and its Auth port, mounted ONLY when
 * `AUTH_SERVICE_URL` is configured; without it there is no owner route and audit-service calls no other service at all.
 */
@Module({})
export class QueryModule {
  static register(config: AuditConfig, ownerAuthority?: OwnerAuthority): DynamicModule {
    const access = config.ownerAccess;
    const owner = access
      ? [{ provide: OWNER_AUTHORITY, useValue: ownerAuthority ?? new HttpOwnerAuthority({ baseUrl: access.authServiceUrl, timeoutMs: access.authTimeoutMs }) }]
      : [];
    return {
      module: QueryModule,
      imports: [PersistenceModule, RateLimitModule],
      // Core V2 S2-Audit.3: the scoped reads only when the cursor key ring is configured too (and then Auth is required by the config)
      controllers: [AuditQueryController, ...(access ? [OwnerAuditQueryController] : []), ...(access && config.scopedAccess ? [ScopedAuditQueryController] : []),
        // Core V2 S2-Audit.4: the Owner's legal holds, with the owner read (Auth is required: authority and the step-up are Auth's)
        ...(access ? [LegalHoldController] : [])],
      providers: [{ provide: QueryCounters, useValue: new QueryCounters() }, AuditQueryService, QueryReporter, RateLimitJanitor, LegalHoldService, ...owner],
      exports: [AuditQueryService, QueryCounters],
    };
  }
}
