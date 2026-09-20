import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateHierarchySnapshot } from './hierarchy-snapshot.js';

/**
 * The artifact below was produced by auth-service's REAL exporter (its e2e suite writes it). This service validates it with its own
 * code, and `npm run check:repo` refuses to pass unless both copies are byte-identical, so the two implementations cannot drift apart.
 */
describe('golden fixture produced by auth-service', () => {
  const text = readFileSync(new URL('../../test/fixtures/hierarchy-snapshot.v1.json', import.meta.url), 'utf8');
  it('passes every integrity and consistency check of this service', () => {
    const r = validateHierarchySnapshot(JSON.parse(text));
    expect(r.ok, r.ok ? '' : r.errors.join(' | ')).toBe(true);
    if (r.ok) expect(r.value.snapshot.counts).toEqual({ company: 1, organization: 2, platform: 2 });
  });
  it('is in canonical form: its bytes are exactly what the canonical serializer would write', () => {
    expect(text.endsWith('\n')).toBe(true);
    const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v);
    expect(text.trimEnd()).toBe(JSON.stringify(sorted(JSON.parse(text)))); // sorted keys, no whitespace: canonical JSON
    expect(JSON.parse(text).source.service).toBe('auth-service');
  });
});
