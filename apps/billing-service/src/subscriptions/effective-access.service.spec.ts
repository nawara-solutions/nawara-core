import { describe, expect, it, vi } from 'vitest';
import { EffectiveAccessService } from './effective-access.service.js';
import type { SubscriptionRepository } from './subscription.repository.js';
import type { SubscriptionRow } from './subscription.types.js';

const NOW = new Date('2026-10-15T00:00:00Z');
const ORG = '00000000-0000-4000-8000-000000000001';

function subscriptionsWith(row: SubscriptionRow | null): { repo: SubscriptionRepository; findForOrganization: ReturnType<typeof vi.fn> } {
  const findForOrganization = vi.fn().mockResolvedValue(row);
  return { repo: { findForOrganization } as unknown as SubscriptionRepository, findForOrganization };
}

const activeRow: SubscriptionRow = {
  id: 'sub-1', organizationId: ORG, productId: 'prod-1', priceId: 'price-1', status: 'active',
  currentPeriodStart: new Date('2026-10-01T00:00:00Z'), currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
  graceUntil: null, cancelAtPeriodEnd: false, effectiveTerminationAt: null, revision: 1,
  createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
};

describe('EffectiveAccessService — Stage 12.5 composition (SubscriptionRepository -> deriveEntitlement, unchanged)', () => {
  it('no Subscription for the Organization -> the same {valid:false, expiresAt:null} deriveEntitlement(null, now) itself returns', async () => {
    const svc = new EffectiveAccessService(subscriptionsWith(null).repo);
    await expect(svc.getEffectiveAccess(ORG, NOW)).resolves.toEqual({ valid: false, expiresAt: null });
  });

  it('a Subscription row -> the derivation result is returned UNCHANGED (no re-interpretation in the service)', async () => {
    const svc = new EffectiveAccessService(subscriptionsWith(activeRow).repo);
    await expect(svc.getEffectiveAccess(ORG, NOW)).resolves.toEqual({ valid: true, expiresAt: activeRow.currentPeriodEnd });
  });

  it('queries by the SAME organizationId it was given, never a different scope', async () => {
    const { repo, findForOrganization } = subscriptionsWith(null);
    const svc = new EffectiveAccessService(repo);
    await svc.getEffectiveAccess(ORG, NOW);
    expect(findForOrganization).toHaveBeenCalledWith(ORG);
  });

  it('never calls new Date() itself: the exact `now` instant passed in is what reaches the derivation boundary', async () => {
    const svc = new EffectiveAccessService(subscriptionsWith(activeRow).repo);
    const justBeforeStart = new Date(activeRow.currentPeriodStart!.getTime() - 1);
    await expect(svc.getEffectiveAccess(ORG, justBeforeStart)).resolves.toEqual({ valid: false, expiresAt: null });
  });
});
