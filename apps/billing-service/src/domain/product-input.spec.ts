import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { normaliseCreateProductInput } from './product-input.js';

const base = { seller: { type: 'company', id: 'nawara' }, code: 'premium', name: 'Premium' };
const P = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return ((e as HttpException).getResponse() as { code?: string }).code;
  }
  return undefined;
};

/** Core V2 S3a (ADR-0044 B1): a product's subscription target and Platform. */
describe('normaliseCreateProductInput: subscriptionTarget and platformId', () => {
  it('an ordinary product is `none` by default, with or without a Platform', () => {
    expect(normaliseCreateProductInput(base)).toMatchObject({ subscriptionTarget: 'none', platformId: null });
    expect(normaliseCreateProductInput({ ...base, platformId: P })).toMatchObject({ subscriptionTarget: 'none', platformId: P.toLowerCase() });
  });

  it('a subscription product (organization or personal) names its Platform (canonical lower case)', () => {
    for (const subscriptionTarget of ['organization', 'personal']) {
      expect(normaliseCreateProductInput({ ...base, subscriptionTarget, platformId: P })).toMatchObject({ subscriptionTarget, platformId: P.toLowerCase() });
      expect(code(() => normaliseCreateProductInput({ ...base, subscriptionTarget }))).toBe('invalid_product_request');
    }
  });

  it('refuses an unknown target, a non-uuid Platform, and never infers the target from entitlementKind', () => {
    for (const bad of [{ subscriptionTarget: 'company' }, { subscriptionTarget: 'ORGANIZATION', platformId: P }, { subscriptionTarget: 1 }, { platformId: 'platform-1' }]) {
      expect(code(() => normaliseCreateProductInput({ ...base, ...bad })), JSON.stringify(bad)).toBe('invalid_product_request');
    }
    expect(normaliseCreateProductInput({ ...base, entitlementKind: 'organization_license' }).subscriptionTarget).toBe('none');
    expect(normaliseCreateProductInput({ ...base, entitlementKind: 'user_subscription' }).subscriptionTarget).toBe('none');
  });
});
