import { Module, type DynamicModule } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import type { BillingConfig } from '../config/billing-config.js';
import { InvoicesModule } from '../invoices/invoices.module.js';
import { AssistanceAuthority } from './assistance-authority.js';
import { AssistanceCommandIdempotency } from './assistance-idempotency.js';
import { AssistanceSettlementService } from './assistance-settlement.service.js';
import { AssistanceUserGuard } from './assistance-user.guard.js';
import { HttpOwnerAuthority, OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import { AssistanceOwnerGuard } from './assistance-owner.guard.js';
import { AssistanceResolutionService } from './assistance-resolution.service.js';
import { AssistanceAdminController, AssistanceController, AssistanceDisputeController, CashReturnObligationController, OrganizationRestrictionsController } from './assistance.controller.js';
import { AssistanceRestrictionService } from './assistance-restriction.service.js';
import { RestrictionReaderGuard } from './restriction-reader.guard.js';
import { AssistanceService } from './assistance.service.js';
import { CashReturnSweep, CashReturnSweepService } from './cash-return-sweep.js';

/**
 * Core V2 S5a and S5b Organization assistance (register BIL-13 to BIL-17; the Owner's D-8, D-12 and E-1 to E-13). PRODUCTION REFUSAL,
 * first line: in production (`NODE_ENV=production`, the gate that already refuses checkout, the in-memory bus and the test payment
 * provider) the module mounts NOTHING, so no assistance route exists and the cash-return sweep never runs. There is no flag to enable it:
 * production needs S5d's restriction framework, the lifecycle gates (V-4, V-5, OD-R6a), B-001 / B-007 and a separate Owner authorization.
 */
@Module({})
export class AssistanceModule {
  static register(config: BillingConfig, ownerAuthority?: OwnerAuthority): DynamicModule {
    if (config.isProduction) return { module: AssistanceModule };
    return {
      module: AssistanceModule,
      imports: [RateLimitModule, InvoicesModule],
      controllers: [AssistanceController, CashReturnObligationController, AssistanceDisputeController, AssistanceAdminController, OrganizationRestrictionsController],
      providers: [
        AssistanceService, AssistanceSettlementService, AssistanceAuthority, AssistanceCommandIdempotency, AssistanceUserGuard, CashReturnSweep, CashReturnSweepService,
        // Core V2 S5c (BIL-18 to BIL-22): the resolution commands; the Owner path uses Auth's live Owner, Platform and step-up checks
        AssistanceResolutionService, AssistanceOwnerGuard,
        // Core V2 S5d (BIL-26): the restriction read
        AssistanceRestrictionService, RestrictionReaderGuard,
        { provide: OWNER_AUTHORITY, useValue: ownerAuthority ?? new HttpOwnerAuthority({ baseUrl: config.authServiceUrl }) },
      ],
    };
  }
}
