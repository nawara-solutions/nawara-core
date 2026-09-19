import { describe, expect, it } from 'vitest';
import { canonicalJson, requestHash } from './canonical.js';

describe('canonical form and request hash (idempotency by hash)', () => {
  it('is independent of key order at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe(canonicalJson({ a: { c: [{ x: 2, y: 1 }], d: 2 }, b: 1 }));
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
  });

  it('is sensitive to array order, values and types', () => {
    expect(requestHash({ a: [1, 2] })).not.toBe(requestHash({ a: [2, 1] }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: '1' }));
  });

  it('renders bigint as a decimal string and Date as an ISO instant, and undefined as null (never dropped)', () => {
    expect(canonicalJson({ a: 10n, d: new Date('2026-01-02T03:04:05.000Z'), u: undefined })).toBe('{"a":"10","d":"2026-01-02T03:04:05.000Z","u":null}');
  });

  it('is a 64-character lower-case hex sha256 (the database CHECK shape)', () => {
    expect(requestHash({ any: 'thing' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
