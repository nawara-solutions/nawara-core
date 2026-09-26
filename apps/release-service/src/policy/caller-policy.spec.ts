import { describe, expect, it } from 'vitest';
import { ConfigError } from '@nawara/service-kit';
import { ReleaseCallerPolicy } from './caller-policy.js';

const doc = (callers: unknown) => JSON.stringify({ callers });

describe('RELEASE_SERVICE_POLICY (ADR-0042 decision 2, ADR-0051 §8): per caller, per product, deny by default', () => {
  it('grants exactly what is listed, for exactly the listed product; register and publish are independent', () => {
    const p = ReleaseCallerPolicy.parse(doc({
      'drive-ci': { products: { drive: ['release.register', 'release.publish'], daycare: ['release.register'] } },
      'publisher': { products: { drive: ['release.publish'] } },
    }), ['drive-ci', 'publisher']);
    expect(p.allows('drive-ci', 'drive', 'release.register')).toBe(true);
    expect(p.allows('drive-ci', 'drive', 'release.publish')).toBe(true);
    expect(p.allows('drive-ci', 'daycare', 'release.register')).toBe(true);
    expect(p.allows('drive-ci', 'daycare', 'release.publish')).toBe(false); // register-only on that product
    expect(p.allows('drive-ci', 'booking', 'release.register')).toBe(false); // another product: nothing
    expect(p.allows('publisher', 'drive', 'release.register')).toBe(false); // publish-only
    expect(p.allows('publisher', 'drive', 'release.publish')).toBe(true);
    expect(p.allows('unknown', 'drive', 'release.register')).toBe(false);
    expect(p.holds('publisher', 'release.register')).toBe(false);
    expect(p.holds('publisher', 'release.publish')).toBe(true);
    expect(p.holds('unknown', 'release.publish')).toBe(false);
  });

  it('no policy and no caller: nothing is granted; a registered caller without a policy refuses to boot', () => {
    expect(ReleaseCallerPolicy.parse(undefined, []).holds('x', 'release.register')).toBe(false);
    expect(() => ReleaseCallerPolicy.parse(undefined, ['drive-ci'])).toThrow(/required/);
    expect(() => ReleaseCallerPolicy.parse(doc({}), ['drive-ci'])).toThrow(/no RELEASE_SERVICE_POLICY entry/);
  });

  it.each([
    ['not JSON', '{', /valid JSON/],
    ['no callers', JSON.stringify({ products: {} }), /\{"callers"/],
    ['an extra top-level key', JSON.stringify({ callers: {}, admin: true }), /\{"callers"/],
    ['an unregistered caller', doc({ ghost: { products: { drive: ['release.register'] } } }), /no registered service token/],
    ['an unknown property', doc({ 'drive-ci': { products: { drive: ['release.register'] }, organizations: 'request' } }), /unknown property/],
    ['no products', doc({ 'drive-ci': {} }), /non-empty object/],
    ['empty products', doc({ 'drive-ci': { products: {} } }), /non-empty object/],
    ['products as a list', doc({ 'drive-ci': { products: ['drive'] } }), /non-empty object/],
    ['a wildcard product', doc({ 'drive-ci': { products: { '*': ['release.register'] } } }), /registry key/],
    ['a malformed product', doc({ 'drive-ci': { products: { Drive: ['release.register'] } } }), /registry key/],
    ['an empty capability list', doc({ 'drive-ci': { products: { drive: [] } } }), /non-empty list/],
    ['a wildcard capability', doc({ 'drive-ci': { products: { drive: ['release.*'] } } }), /other than/],
    ['a withdrawal capability (owner only, 20.4)', doc({ 'drive-ci': { products: { drive: ['release.withdraw'] } } }), /other than/],
    ['an administrative capability', doc({ 'drive-ci': { products: { drive: ['admin'] } } }), /other than/],
    ['a repeated capability', doc({ 'drive-ci': { products: { drive: ['release.register', 'release.register'] } } }), /twice/],
  ])('refuses to boot on %s, never echoing the document', (_name, raw, message) => {
    let err: unknown;
    try {
      ReleaseCallerPolicy.parse(raw, ['drive-ci']);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(message);
  });
});
