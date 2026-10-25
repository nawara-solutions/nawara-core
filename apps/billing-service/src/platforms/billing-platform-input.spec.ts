import { describe, expect, it } from 'vitest';
import { normaliseBillingPlatformInput } from './billing-platform-input.js';

/** Core V2 S3d (register BIL-01): the body is exactly `{currency}`; the Company and the attribution are never request values. */
describe('normaliseBillingPlatformInput', () => {
  it('accepts exactly a three-letter upper-case currency', () => {
    expect(normaliseBillingPlatformInput({ currency: 'TND' })).toEqual({ currency: 'TND' });
  });

  it.each([
    ['a Company', { currency: 'TND', companyId: '00000000-0000-4000-8000-000000000001' }],
    ['an author', { currency: 'TND', createdBy: '00000000-0000-4000-8000-000000000001' }],
    ['a timestamp', { currency: 'TND', createdAt: '2020-01-01T00:00:00Z' }],
    ['a lower-case code', { currency: 'tnd' }],
    ['a missing currency', {}],
    ['an array', []],
    ['null', null],
  ])('refuses %s (400 invalid_billing_platform_request)', (_n, body) => {
    expect(() => normaliseBillingPlatformInput(body)).toThrow(expect.objectContaining({ status: 400 }));
    try {
      normaliseBillingPlatformInput(body);
    } catch (e) {
      expect((e as { getResponse(): { code: string } }).getResponse().code).toBe('invalid_billing_platform_request');
    }
  });
});
