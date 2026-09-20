import { describe, expect, it } from 'vitest';
import { sealSnapshot, serializeSnapshot } from '@nawara/service-kit';
import { ID, baseData, parsed, snapshot, snapshotText, type Data } from '../../test/support/snapshot.js';
import { HIERARCHY_FORMAT, contentDigest, validateHierarchySnapshot } from './hierarchy-snapshot.js';

const errorsOf = (v: unknown): string => {
  const r = validateHierarchySnapshot(v);
  return r.ok ? '' : r.errors.join(' | ');
};
/** Mutates the data, then seals it again, so ONLY the semantic problem (not the checksum) is what the validator sees. */
const sealed = (f: (d: Data) => void) => {
  const d = baseData();
  f(d);
  return JSON.parse(snapshotText(d));
};

describe('hierarchy snapshot: determinism and integrity', () => {
  it('produces identical bytes and digests every time, whatever the input order', () => {
    const a = snapshotText();
    const d = baseData();
    d.platform.reverse();
    d.organization.reverse();
    expect(snapshotText(d)).toBe(a);
    expect(serializeSnapshot(snapshot())).toBe(a);
  });
  it('accepts an intact snapshot and derives the content digest from the table digests', () => {
    const r = validateHierarchySnapshot(parsed());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.content).toBe(contentDigest(r.value.snapshot.digests.tables));
  });
  it('the content digest ignores the source and the freeze flag (the same hierarchy, however it was exported)', () => {
    const a = validateHierarchySnapshot(parsed(baseData(), false));
    const b = validateHierarchySnapshot(parsed(baseData(), true));
    expect(a.ok && b.ok && a.value.content === b.value.content).toBe(true);
    expect(a.ok && b.ok && a.value.snapshot.digests.whole !== b.value.snapshot.digests.whole).toBe(true);
  });
  it('rejects a corrupted checksum, a tampered row and a wrong format', () => {
    const c = parsed();
    c.digests.whole = '0'.repeat(64);
    expect(errorsOf(c)).toMatch(/whole-artifact digest/);
    const t = parsed();
    t.tables.company[0].name = 'Tampered';
    expect(errorsOf(t)).toMatch(/digest does not match/);
    const f = parsed();
    f.format = 'something.else';
    expect(errorsOf(f)).toMatch(/unexpected format/);
  });
});

describe('hierarchy snapshot: what must be refused before it reaches a database', () => {
  it('a missing Company, Platform or Organization table (sealed properly, so only the table set is wrong)', () => {
    for (const t of ['company', 'platform', 'organization'] as const) {
      const d = baseData() as unknown as Record<string, unknown>;
      delete d[t];
      const s = JSON.parse(serializeSnapshot(sealSnapshot({ ...HIERARCHY_FORMAT, source: { service: 'auth-service' }, frozen: false, tables: d as never })));
      expect(errorsOf(s), t).toMatch(/exactly the tables/);
    }
  });
  it('an unexpected table', () => {
    const s = parsed();
    s.tables.user = [];
    s.digests.tables.user = 'x';
    s.counts.user = 0;
    expect(errorsOf(s)).not.toBe('');
  });
  it('a Platform whose Company is not in the snapshot, and an Organization whose Platform is not (broken relationships)', () => {
    expect(errorsOf(sealed((d) => (d.company = [])))).toMatch(/company .* is not in the snapshot/);
    expect(errorsOf(sealed((d) => (d.platform = [d.platform[0]!])))).toMatch(/platform .* is not in the snapshot/);
  });
  it('an Organization that hangs off a Company id (no Organization to Company shortcut)', () => {
    expect(errorsOf(sealed((d) => (d.organization[0]!.platformId = ID.co)))).toMatch(/platform .* is not in the snapshot/);
  });
  it('a duplicate id inside a table', () => {
    expect(errorsOf(sealed((d) => d.platform.push({ ...d.platform[0]! })))).toMatch(/already used in platform/);
  });
  it('an id used in two tables (I1: an id is never reused)', () => {
    expect(errorsOf(sealed((d) => (d.organization[0]!.id = ID.p1)))).toMatch(/never reused, I1/);
  });
  it('unexpected or missing columns', () => {
    expect(errorsOf(sealed((d) => ((d.company[0] as Record<string, unknown>).extra = 'x')))).toMatch(/unexpected or missing columns/);
    expect(errorsOf(sealed((d) => delete d.company[0]!.updatedAt))).toMatch(/unexpected or missing columns/);
  });
  it('values that are not valid: null or blank name, bad uuid, bad timestamp, bad or duplicated key, non-text values', () => {
    expect(errorsOf(sealed((d) => (d.company[0]!.name = null)))).toMatch(/name must not be null/);
    expect(errorsOf(sealed((d) => (d.company[0]!.name = '   ')))).toMatch(/blank/);
    expect(errorsOf(sealed((d) => (d.company[0]!.id = 'not-a-uuid')))).toMatch(/canonical uuid/);
    expect(errorsOf(sealed((d) => (d.company[0]!.createdAt = '2024-01-01')))).toMatch(/microsecond timestamp/);
    expect(errorsOf(sealed((d) => (d.platform[0]!.key = 'Bad Key')))).toMatch(/invalid format/);
    expect(errorsOf(sealed((d) => (d.platform[1]!.key = 'alpha')))).toMatch(/duplicated/);
    expect(errorsOf(sealed((d) => (d.company[0]!.name = 5)))).toMatch(/must be text/);
  });
});
