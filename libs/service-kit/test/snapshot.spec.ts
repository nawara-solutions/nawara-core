import { describe, expect, it } from 'vitest';
import { canonicalJson, sealSnapshot, serializeSnapshot, sha256Hex, SnapshotError, verifySnapshot } from '../src/snapshot/snapshot.js';

const FORMAT = { format: 'test.snapshot', version: 1 };
const input = () => ({
  ...FORMAT,
  source: { service: 'src', migrations: ['a', 'b'] },
  frozen: false,
  tables: {
    b: [{ id: '2', v: 'x' }, { id: '1', v: null }],
    a: [{ id: 'z', n: 3 }],
  },
});

describe('canonicalJson', () => {
  it('sorts keys and is stable', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
  it('rejects values with no canonical form', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(SnapshotError);
    expect(() => canonicalJson(NaN)).toThrow(SnapshotError);
    expect(() => canonicalJson(() => 1)).toThrow(SnapshotError);
    expect(() => canonicalJson(10n)).toThrow(SnapshotError);
  });

  // Golden vectors: the exact bytes the hierarchy snapshot digests are built from. A change here breaks every persisted digest.
  it.each<[string, unknown, string]>([
    ['empty object', {}, '{}'],
    ['empty array', [], '[]'],
    ['nested, keys sorted at every depth', { z: 1, a: { y: 2, b: 3 } }, '{"a":{"b":3,"y":2},"z":1}'],
    ['array order kept, objects inside sorted', [3, { b: 1, a: 2 }, [2, 1]], '[3,{"a":2,"b":1},[2,1]]'],
    ['null, booleans, empty string', { n: null, t: true, f: false, s: '' }, '{"f":false,"n":null,"s":"","t":true}'],
    ['numbers', { i: 42, f: 3.25, neg: -17, zero: 0, negzero: -0, big: 1e21, small: 1e-7 }, '{"big":1e+21,"f":3.25,"i":42,"neg":-17,"negzero":0,"small":1e-7,"zero":0}'],
    ['keys sorted by UTF-16 code unit, integer-like keys included', { b: 1, B: 2, _: 3, '10': 4, '9': 5, '1': 6 }, '{"1":6,"10":4,"9":5,"B":2,"_":3,"b":1}'],
    ['unicode kept as is', { 'é': 'ñ', '日本': '語', e: '😀' }, '{"e":"😀","é":"ñ","日本":"語"}'],
    ['JSON string escaping', { q: '"', bs: '\\', nl: '\n', ctl: '\u0001', 'k"': 1 }, '{"bs":"\\\\","ctl":"\\u0001","k\\"":1,"nl":"\\n","q":"\\""}'],
  ])('golden vector: %s', (_name, value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it('golden digest: sha256 of the canonical bytes', () => {
    expect(sha256Hex(canonicalJson({ z: 1, a: { y: 2, b: 3 } }))).toBe('10d6b907e50339871355376854e16e87112120f63b9ce9bca2913907cd2a124d');
  });

  it('gives one output for every insertion order of a nested object', () => {
    const entries: [string, unknown][] = [['c', 1], ['a', { y: [1, 2], x: null }], ['b', 's'], ['d', [{ q: 1, p: 2 }]]];
    const perms = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
    const outputs = new Set(perms(entries).map((p) => canonicalJson(Object.fromEntries(p))));
    expect([...outputs]).toEqual(['{"a":{"x":null,"y":[1,2]},"b":"s","c":1,"d":[{"p":2,"q":1}]}']);
  });

  it('does not mutate its input', () => {
    const value = { b: [3, 1, { z: 1, y: 2 }], a: 1 };
    canonicalJson(value);
    expect(Object.keys(value)).toEqual(['b', 'a']);
    expect(value.b).toEqual([3, 1, { z: 1, y: 2 }]);
    expect(Object.keys(value.b[2] as object)).toEqual(['z', 'y']);
  });
});

describe('sealSnapshot', () => {
  it('is deterministic: table order, row order and key order do not change the bytes', () => {
    const a = serializeSnapshot(sealSnapshot(input()));
    const shuffled = input();
    shuffled.tables = { a: [{ n: 3, id: 'z' }], b: [{ v: 'x', id: '2' }, { v: null, id: '1' }].reverse().reverse() };
    shuffled.tables.b.reverse();
    expect(serializeSnapshot(sealSnapshot(shuffled))).toBe(a);
    expect(sha256Hex(a)).toBe(sha256Hex(serializeSnapshot(sealSnapshot(input()))));
  });
  it('orders rows by id and counts them', () => {
    const s = sealSnapshot(input());
    expect(s.tables.b!.map((r) => r.id)).toEqual(['1', '2']);
    expect(s.counts).toEqual({ a: 1, b: 2 });
  });
  it('the frozen flag and the source are part of the whole-artifact digest', () => {
    const base = sealSnapshot(input()).digests.whole;
    expect(sealSnapshot({ ...input(), frozen: true }).digests.whole).not.toBe(base);
    expect(sealSnapshot({ ...input(), source: { service: 'other' } }).digests.whole).not.toBe(base);
  });
});

describe('verifySnapshot', () => {
  const sealed = () => JSON.parse(serializeSnapshot(sealSnapshot(input())));
  it('accepts an intact artifact', () => {
    expect(verifySnapshot(sealed(), FORMAT).ok).toBe(true);
  });
  it('rejects a corrupted row', () => {
    const s = sealed();
    s.tables.b[0].v = 'tampered';
    const r = verifySnapshot(s, FORMAT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/digest does not match/);
  });
  it('rejects a changed digest, count, flag or source', () => {
    for (const mutate of [
      (s: any) => (s.digests.whole = '0'.repeat(64)),
      (s: any) => (s.digests.tables.a = '0'.repeat(64)),
      (s: any) => (s.counts.a = 9),
      (s: any) => (s.frozen = true),
      (s: any) => (s.source.service = 'evil'),
    ]) {
      const s = sealed();
      mutate(s);
      expect(verifySnapshot(s, FORMAT).ok).toBe(false);
    }
  });
  it('rejects a missing or extra table, and rows out of canonical order', () => {
    let s = sealed();
    delete s.tables.a;
    expect(verifySnapshot(s, FORMAT).ok).toBe(false);
    s = sealed();
    s.tables.c = [];
    expect(verifySnapshot(s, FORMAT).ok).toBe(false);
    s = sealed();
    s.tables.b.reverse();
    const r = verifySnapshot(s, FORMAT);
    expect(r.ok).toBe(false);
  });
  it('rejects another format or version, and non-objects', () => {
    expect(verifySnapshot(sealed(), { format: 'other', version: 1 }).ok).toBe(false);
    expect(verifySnapshot(sealed(), { format: FORMAT.format, version: 2 }).ok).toBe(false);
    for (const bad of [null, 'x', [], 1]) expect(verifySnapshot(bad, FORMAT).ok).toBe(false);
  });
});
