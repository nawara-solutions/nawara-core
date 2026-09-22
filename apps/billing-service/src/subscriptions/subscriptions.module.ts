import { Module } from '@nestjs/common';
import { EffectiveAccessService } from './effective-access.service.js';
import { EntitlementController } from './entitlement.controller.js';
import { SubscriptionRepository } from './subscription.repository.js';

/**
 * The Subscription logical module (Stage 12.2) plus Stage 12.5's read-only effective-access contract
 * (`EntitlementController`/`EffectiveAccessService`). There is still no general Subscription API (section 30) — only
 * the frozen `{ valid, expiresAt }` entitlement read.
 */
@Module({
  controllers: [EntitlementController],
  providers: [SubscriptionRepository, EffectiveAccessService],
  exports: [SubscriptionRepository],
})
export class SubscriptionsModule {}
