import { Module } from '@nestjs/common';
import { SubscriptionRepository } from './subscription.repository.js';

/**
 * The Subscription logical module (Stage 12.2): domain/database foundation only. No controller yet — there is no
 * approved public Subscription API (section 30); the read-only effective-access contract is Stage 12.5's.
 */
@Module({
  providers: [SubscriptionRepository],
  exports: [SubscriptionRepository],
})
export class SubscriptionsModule {}
