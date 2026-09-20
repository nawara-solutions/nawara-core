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
