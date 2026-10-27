import { Module, type DynamicModule } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import type { BillingConfig } from '../config/billing-config.js';
import { AssistanceAuthority } from './assistance-authority.js';
import { AssistanceCommandIdempotency } from './assistance-idempotency.js';
import { AssistanceUserGuard } from './assistance-user.guard.js';
import { AssistanceController } from './assistance.controller.js';
import { AssistanceService } from './assistance.service.js';

/**
 * Core V2 S5a Organization assistance (register BIL-13 to BIL-15; the Owner's D-8 and D-12). PRODUCTION REFUSAL, first line: in production
 * (`NODE_ENV=production`, the gate that already refuses checkout, the in-memory bus and the test payment provider) the module mounts NOTHING,
 * so no assistance route exists. There is no flag to enable it: production needs S5d's restriction framework, the lifecycle gates (V-4,
 * V-5, OD-R6a) and a separate Owner authorization first.
 */
@Module({})
export class AssistanceModule {
  static register(config: BillingConfig): DynamicModule {
    if (config.isProduction) return { module: AssistanceModule };
    return {
      module: AssistanceModule,
      imports: [RateLimitModule],
      controllers: [AssistanceController],
      providers: [AssistanceService, AssistanceAuthority, AssistanceCommandIdempotency, AssistanceUserGuard],
    };
  }
}
