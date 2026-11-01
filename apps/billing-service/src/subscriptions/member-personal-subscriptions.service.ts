import { Injectable } from '@nestjs/common';
import { toPage } from '../common/pagination.js';
import { representEntitlement, type EntitlementRepresentation } from './entitlement.representation.js';
import { PersonalSubscriptionRepository } from './personal-subscription.repository.js';

export interface MemberPersonalSubscriptionItem extends EntitlementRepresentation {
  productId: string;
}

export interface MemberPersonalSubscriptionsPage {
  items: MemberPersonalSubscriptionItem[];
  nextCursor: string | null;
}

/**
 * Core V2 BIL-12 (register BIL-12, the Owner's D-B1 to D-B7, 2026-11-01): the member's own recorded Personal Subscriptions on one Platform.
 * Each item's `valid` and `expiresAt` are B6's, from the SAME calculation (`PersonalSubscriptionRepository.entitlementOf`), every item at
 * the ONE instant `now`. Informational only: product backends decide access through B6, never through this read. Nothing beyond
 * `productId`, `valid` and `expiresAt` leaves: no purchase, period, amount, price, reversal cause or hold. Reads only.
 */
@Injectable()
export class MemberPersonalSubscriptionsService {
  constructor(private readonly personal: PersonalSubscriptionRepository) {}

  async page(userId: string, platformId: string, limit: number, cursor: { createdAt: Date; id: string } | null, now: Date): Promise<MemberPersonalSubscriptionsPage> {
    const page = toPage(await this.personal.listForUser(userId, platformId, limit, cursor), limit);
    const items: MemberPersonalSubscriptionItem[] = [];
    for (const s of page.items) items.push({ productId: s.productId, ...representEntitlement(await this.personal.entitlementOf(s.id, now)) });
    return { items, nextCursor: page.nextCursor };
  }
}
