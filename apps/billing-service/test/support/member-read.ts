import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import { expect } from 'vitest';
import { DbService } from '@nawara/service-kit';
import { decodeCursor } from '../../src/common/pagination.js';
import { representEntitlement } from '../../src/subscriptions/entitlement.representation.js';
import { MemberPersonalSubscriptionsService, type MemberPersonalSubscriptionItem } from '../../src/subscriptions/member-personal-subscriptions.service.js';
import { PersonalSubscriptionRepository } from '../../src/subscriptions/personal-subscription.repository.js';

/**
 * Core V2 BIL-12 (D-B3): the member's own read must equal B6, item by item, at ONE instant. These helpers read every page of the BIL-12
 * read and compare each item with B6's own answer (`PersonalSubscriptionRepository.entitlement`, the code behind
 * `GET /billing/users/:userId/platforms/:platformId/products/:productId/entitlement`) for the same user, Platform, product and instant.
 * The set of listed products is checked against the recorded `personal_subscription` rows independently of the read.
 */
export async function memberReadAt(app: INestApplicationContext, userId: string, platformId: string, at: Date): Promise<MemberPersonalSubscriptionItem[]> {
  const reads = app.get(MemberPersonalSubscriptionsService);
  const items: MemberPersonalSubscriptionItem[] = [];
  let cursor: string | null = null;
  do {
    const page = await reads.page(userId, platformId, 100, cursor ? decodeCursor(cursor) : null, at);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/** B6's answer for every product the user has a recorded Personal Subscription for on the Platform, at `at`, by product id. */
export async function b6At(app: INestApplicationContext, userId: string, platformId: string, at: Date): Promise<MemberPersonalSubscriptionItem[]> {
  const { rows } = await app.get(DbService).query<{ productId: string }>(
    `SELECT "productId" FROM personal_subscription WHERE "userId" = $1 AND "platformId" = $2`, [userId, platformId]);
  const personal = app.get(PersonalSubscriptionRepository);
  const out: MemberPersonalSubscriptionItem[] = [];
  for (const { productId } of rows) out.push({ productId, ...representEntitlement(await personal.entitlement(userId, platformId, productId, at)) });
  return byProduct(out);
}

const byProduct = (items: MemberPersonalSubscriptionItem[]) => [...items].sort((a, b) => a.productId.localeCompare(b.productId));

/** Asserts exact parity at `at` (default: now) and returns the member read's items, in the read's own order. */
export async function expectMemberReadMatchesB6(app: INestApplicationContext, userId: string, platformId: string, at = new Date()): Promise<MemberPersonalSubscriptionItem[]> {
  const items = await memberReadAt(app, userId, platformId, at);
  expect(byProduct(items)).toEqual(await b6At(app, userId, platformId, at));
  return items;
}

/**
 * The HTTP route, as the member's own bearer: its answer must be B6's at the instant it was computed. That instant is bracketed by B6
 * read just before and just after the request; when the two agree (no boundary fell inside the bracket) the route must give exactly
 * that, so a match is never a matter of timing.
 */
export async function expectHttpMemberReadMatchesB6(app: INestApplication, bearer: string, userId: string, platformId: string): Promise<MemberPersonalSubscriptionItem[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await b6At(app, userId, platformId, new Date());
    const res = await request(app.getHttpServer()).get(`/billing/me/platforms/${platformId}/personal-subscriptions?limit=100`).set('authorization', `Bearer ${bearer}`);
    const after = await b6At(app, userId, platformId, new Date());
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    if (JSON.stringify(before) !== JSON.stringify(after)) continue; // a validity boundary fell inside the bracket: read again
    expect(byProduct(res.body.items)).toEqual(before);
    return res.body.items;
  }
  throw new Error('B6 changed during every bracket: no stable instant to compare');
}
