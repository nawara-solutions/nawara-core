import { Module, type DynamicModule } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import type { BillingConfig } from '../config/billing-config.js';
import { InvoicesModule } from '../invoices/invoices.module.js';
import { AssistanceAuthority } from './assistance-authority.js';
import { AssistanceCommandIdempotency } from './assistance-idempotency.js';
import { AssistanceSettlementService } from './assistance-settlement.service.js';
import { AssistanceUserGuard } from './assistance-user.guard.js';
import { AssistanceController, CashReturnObligationController } from './assistance.controller.js';
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
  static register(config: BillingConfig): DynamicModule {
    if (config.isProduction) return { module: AssistanceModule };
    return {
      module: AssistanceModule,
      imports: [RateLimitModule, InvoicesModule],
      controllers: [AssistanceController, CashReturnObligationController],
      providers: [AssistanceService, AssistanceSettlementService, AssistanceAuthority, AssistanceCommandIdempotency, AssistanceUserGuard, CashReturnSweep, CashReturnSweepService],
    };
  }
}
