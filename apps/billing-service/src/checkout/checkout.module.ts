import { Module, type DynamicModule } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import type { BillingConfig } from '../config/billing-config.js';
import { InvoicesModule } from '../invoices/invoices.module.js';
import { CheckoutMemberGuard } from './checkout-member.guard.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';

/**
 * Core V2 S3f direct checkout (BIL-10). PRODUCTION REFUSAL, first line: in production (`NODE_ENV=production`, the same gate that already
 * refuses the in-memory bus and the test payment provider) the module mounts NOTHING, so the route does not exist. B-001 and B-007 must be
 * resolved, and production activation separately authorized, before this changes; there is no flag to enable it.
 */
@Module({})
export class CheckoutModule {
  static register(config: BillingConfig): DynamicModule {
    if (config.isProduction) return { module: CheckoutModule };
    return {
      module: CheckoutModule,
      imports: [InvoicesModule, RateLimitModule],
      controllers: [CheckoutController],
      providers: [CheckoutService, CheckoutMemberGuard],
    };
  }
}
