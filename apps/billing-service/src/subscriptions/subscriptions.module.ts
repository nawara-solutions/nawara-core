import { Module } from '@nestjs/common';
import { EffectiveAccessService } from './effective-access.service.js';
import { EntitlementController } from './entitlement.controller.js';
import { PersonalEntitlementController } from './personal-entitlement.controller.js';
import { PersonalSubscriptionRepository } from './personal-subscription.repository.js';
import { SubscriptionRepository } from './subscription.repository.js';

/**
 * The Subscription logical module (Stage 12.2) plus Stage 12.5's read-only effective-access contract
 * (`EntitlementController`/`EffectiveAccessService`). There is still no general Subscription API (section 30) — only
 * the frozen `{ valid, expiresAt }` entitlement read. Core V2 S3c adds the Personal Subscription ledger and its B6 entitlement read.
 */
@Module({
  controllers: [EntitlementController, PersonalEntitlementController],
  providers: [SubscriptionRepository, EffectiveAccessService, PersonalSubscriptionRepository],
  exports: [SubscriptionRepository, PersonalSubscriptionRepository],
})
export class SubscriptionsModule {}
