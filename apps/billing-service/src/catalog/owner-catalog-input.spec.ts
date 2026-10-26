import { describe, expect, it } from 'vitest';
import { normaliseOwnerPriceInput, normaliseOwnerProductInput } from './owner-catalog-input.js';

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { getResponse?: () => { code?: string } }).getResponse?.().code;
  }
  return 'accepted';
};
const price = (over: Record<string, unknown> = {}) => ({ clientReference: 'r-1', unitAmount: 900, intervalUnit: 'month', intervalCount: 1, effectiveFrom: '2026-01-01T00:00:00Z', ...over });

describe('Core V2 S3g Owner catalog input (D-CAT-5)', () => {
  it('a product is exactly {code, name, description?, entitlementKind?}; the defaults are the producer route\'s', () => {
    expect(normaliseOwnerProductInput({ code: 'plan-a', name: 'Plan' })).toEqual({ code: 'plan-a', name: 'Plan', description: null, entitlementKind: 'none' });
    expect(normaliseOwnerProductInput({ code: 'plan-a', name: 'Plan', description: 'd', entitlementKind: 'user_subscription' }))
      .toEqual({ code: 'plan-a', name: 'Plan', description: 'd', entitlementKind: 'user_subscription' });
  });

  it.each(['seller', 'platformId', 'subscriptionTarget', 'producer', 'status', 'revision', 'id'])('a product body naming %s is 400 invalid_product_request', (field) => {
    expect(code(() => normaliseOwnerProductInput({ code: 'plan-a', name: 'Plan', [field]: 'x' }))).toBe('invalid_product_request');
  });

  it('a product keeps every producer-route field rule (code shape, name and description bounds, entitlementKind values)', () => {
    for (const body of [{ code: 'A', name: 'P' }, { code: 'plan-a', name: '' }, { code: 'plan-a', name: 'x'.repeat(141) }, { code: 'plan-a', name: 'P', description: 'x'.repeat(281) },
      { code: 'plan-a', name: 'P', entitlementKind: 'gold' }, null, [], 'x']) {
      expect(code(() => normaliseOwnerProductInput(body)), JSON.stringify(body)).toBe('invalid_product_request');
    }
  });

  it('a price is exactly {clientReference, unitAmount, intervalUnit, intervalCount, effectiveFrom}: always recurring, currency never from the body', () => {
    const n = normaliseOwnerPriceInput(price({ intervalUnit: 'year', intervalCount: 2 }));
    expect(n).toEqual({ clientReference: 'r-1', unitAmount: 900n, intervalUnit: 'year', intervalCount: 2, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
    expect(n).not.toHaveProperty('currency');
  });

  it.each(['currency', 'interval', 'productId', 'pricingModel', 'retiredAt', 'revision'])('a price body naming %s is 400 invalid_price_request', (field) => {
    expect(code(() => normaliseOwnerPriceInput(price({ [field]: 'x' })))).toBe('invalid_price_request');
  });

  it('a price keeps every producer-route field rule (amount bounds, interval unit and count, offset timestamp, reference shape)', () => {
    for (const over of [{ unitAmount: 0 }, { unitAmount: -1 }, { unitAmount: 1.5 }, { unitAmount: '900' }, { unitAmount: 2 ** 53 }, { intervalUnit: 'hour' }, { intervalUnit: undefined },
      { intervalCount: 0 }, { intervalCount: 1.5 }, { effectiveFrom: '2026-01-01' }, { effectiveFrom: 'soon' }, { clientReference: 'with space' }, { clientReference: '' }]) {
      expect(code(() => normaliseOwnerPriceInput(price(over))), JSON.stringify(over)).toBe('invalid_price_request');
    }
    expect(code(() => normaliseOwnerPriceInput(null))).toBe('invalid_price_request');
  });
});
