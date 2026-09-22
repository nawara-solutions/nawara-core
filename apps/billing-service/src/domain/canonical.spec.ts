import { canonicalJson as kitCanonicalJson } from '@nawara/service-kit';
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

  // Golden vectors: invoice."requestHash" is persisted and compared on every replay, so these bytes must never change.
  it.each<[string, unknown, string]>([
    ['nested, keys sorted at every depth', { z: 1, a: { y: 2, b: 3 } }, '{"a":{"b":3,"y":2},"z":1}'],
    ['array order kept, objects inside sorted', [3, { b: 1, a: 2 }, [2, 1]], '[3,{"a":2,"b":1},[2,1]]'],
    ['null, booleans, empty string', { n: null, t: true, f: false, s: '' }, '{"f":false,"n":null,"s":"","t":true}'],
    ['unicode and escaping', { 'é': 'ñ', q: '"', nl: '\n' }, '{"nl":"\\n","q":"\\"","é":"ñ"}'],
    // JSON.stringify emits integer-like keys first, in numeric order: NOT the plain sorted order service-kit's canonicalJson uses.
    ['integer-like keys in engine order', { x: 1, '10': 2, '9': 3 }, '{"9":3,"10":2,"x":1}'],
    ['non-finite numbers and functions as JSON.stringify renders them', { n: NaN, i: Infinity, f: () => 1 }, '{"i":null,"n":null}'],
  ])('golden vector: %s', (_name, value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it('golden digests of a normalised invoice request (without and with dueAt)', () => {
    const request = (dueAt: Date | null) => ({
      producer: 'svc-a',
      invoiceRequestId: 'req-1',
      seller: { type: 'company', id: '00000000-0000-4000-8000-000000000001' },
      payer: { type: 'user', id: '00000000-0000-4000-8000-000000000002' },
      organizationId: null,
      sourceType: 'order',
      sourceId: 'o-1',
      description: null,
      dueAt,
      issuerSnapshot: { name: 'Seller' },
      billToSnapshot: { name: 'Buyer' },
      lines: [{ priceId: '00000000-0000-4000-8000-000000000003', quantity: 2, description: null, sourceType: null, sourceId: null }],
    });
    expect(requestHash(request(null))).toBe('80dac930af36cfdcbc5967455303e47753e816c8c44c937867a8eb16ceda21bc');
    expect(requestHash(request(new Date('2026-03-01T00:00:00.000Z')))).toBe('e813d491d4d0720c7b9aaa475830c0560c5aa6245e5fec94da4dc68bb004bdbf');
    expect(requestHash(request(new Date('2027-12-31T00:00:00.000Z')))).toBe('a7f2decfa57afebe4212b6fe2441370689f5d9349f250fda72b671cd970c4cfd');
  });

  it('does not mutate its input', () => {
    const value = { b: [3, 1, { z: 1, y: 2 }], a: 1 };
    canonicalJson(value);
    expect(Object.keys(value)).toEqual(['b', 'a']);
    expect(Object.keys(value.b[2] as object)).toEqual(['z', 'y']);
  });

  // Stage 13.4: this is deliberately NOT @nawara/service-kit's canonicalJson (a different contract, built for snapshots). Swapping
  // them would change persisted request hashes, and service-kit renders every Date as {} so a changed dueAt would replay as identical.
  it('is not interchangeable with the service-kit snapshot canonicalJson', () => {
    const d = { dueAt: new Date('2026-03-01T00:00:00.000Z') };
    expect(canonicalJson(d)).toBe('{"dueAt":"2026-03-01T00:00:00.000Z"}');
    expect(kitCanonicalJson(d)).toBe('{"dueAt":{}}');
    expect(canonicalJson({ x: 1, '10': 2, '9': 3 })).not.toBe(kitCanonicalJson({ x: 1, '10': 2, '9': 3 }));
  });
});
