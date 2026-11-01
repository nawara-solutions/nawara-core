import { Module, type DynamicModule } from '@nestjs/common';
import { MemberVerifier } from '../auth/verified-member.js';
import type { BillingConfig } from '../config/billing-config.js';
import { MemberPersonalSubscriptionsController, PersonalSubscriptionsMemberGuard } from './member-personal-subscriptions.controller.js';
import { MemberPersonalSubscriptionsService } from './member-personal-subscriptions.service.js';
import { SubscriptionsModule } from './subscriptions.module.js';

/**
 * Core V2 BIL-12, the member's own personal subscriptions (D-B6). PRODUCTION REFUSAL, as BIL-10: in production (`NODE_ENV=production`)
 * the module mounts NOTHING, so the route does not exist, until Billing's production activation is separately authorized (DG-4); there is
 * no flag to enable it. B6 (`SubscriptionsModule`) is unaffected and stays mounted as before.
 */
@Module({})
export class MemberPersonalSubscriptionsModule {
  static register(config: BillingConfig): DynamicModule {
    if (config.isProduction) return { module: MemberPersonalSubscriptionsModule };
    return {
      module: MemberPersonalSubscriptionsModule,
      imports: [SubscriptionsModule],
      controllers: [MemberPersonalSubscriptionsController],
      providers: [MemberPersonalSubscriptionsService, PersonalSubscriptionsMemberGuard, MemberVerifier],
    };
  }
}
