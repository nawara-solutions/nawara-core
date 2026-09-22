import { Injectable } from '@nestjs/common';
import type { EffectiveEntitlement } from '../domain/entitlement.js';
import { deriveEntitlement } from '../domain/entitlement.js';
import { SubscriptionRepository } from './subscription.repository.js';

/**
 * Stage 12.5: the tiny composition `organizationId -> effective commercial access`. `now` is always supplied by the
 * caller (the one authoritative request-time clock value, taken once at the HTTP boundary) — never read internally
 * — so this stays as deterministic and testable as `deriveEntitlement` itself. No Subscription for the Organization
 * is a normal commercial outcome (`SubscriptionRepository.findByOrganization` already returns `null` rather than
 * throwing), not an error: `deriveEntitlement(null, now)` already answers `{ valid: false, expiresAt: null }` for it.
 */
@Injectable()
export class EffectiveAccessService {
  constructor(private readonly subscriptions: SubscriptionRepository) {}

  async getEffectiveAccess(organizationId: string, now: Date): Promise<EffectiveEntitlement> {
    const subscription = await this.subscriptions.findForOrganization(organizationId);
    return deriveEntitlement(subscription, now);
  }
}
