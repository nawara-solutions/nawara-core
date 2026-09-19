import { describe, expect, it } from 'vitest';
import { SnapshotError, buildPresentationSnapshot, validatePartySnapshot } from './snapshots.js';

describe('party snapshots: a bounded container, content undecided (B-007, BI-20)', () => {
  it('accepts an object with a positive integer schemaVersion and string leaves', () => {
    const s = { schemaVersion: 1, name: 'ACME', address: { city: 'Tunis' } };
    expect(validatePartySnapshot(s, 'issuerSnapshot')).toEqual(s);
  });

  it.each([
    ['not an object', 'x'], ['an array', []], ['null', null],
    ['no schemaVersion', { name: 'x' }], ['schemaVersion 0', { schemaVersion: 0 }], ['a fractional schemaVersion', { schemaVersion: 1.5 }],
    ['a numeric leaf (could pass for money)', { schemaVersion: 1, total: 10 }], ['a boolean leaf', { schemaVersion: 1, x: true }], ['a null leaf', { schemaVersion: 1, x: null }],
    ['an array leaf', { schemaVersion: 1, x: ['a'] }], ['too deep', { schemaVersion: 1, a: { b: { c: { d: 'x' } } } }], ['a NUL character', { schemaVersion: 1, x: 'a\u0000b' }],
    ['a string over 512', { schemaVersion: 1, x: 'a'.repeat(513) }], ['a prototype key', JSON.parse('{"schemaVersion":1,"a":{"__proto__":"x"}}')],
    ['a constructor key', { schemaVersion: 1, constructor: 'x' }],
  ])('refuses %s', (_n, v) => {
    expect(() => validatePartySnapshot(v, 'f')).toThrow(SnapshotError);
  });

  it('refuses a snapshot over 8 KB', () => {
    const big: Record<string, unknown> = { schemaVersion: 1 };
    for (let i = 0; i < 40; i++) big[`k${i}`] = 'a'.repeat(400);
    expect(() => validatePartySnapshot(big, 'f')).toThrow(SnapshotError);
  });
});

describe('presentation snapshot v1: template + locale only', () => {
  it('builds exactly three keys', () => {
    expect(buildPresentationSnapshot({ template: 'system:1', locale: 'fr-TN' })).toEqual({ schemaVersion: 1, template: 'system:1', locale: 'fr-TN' });
  });

  it.each([['<script>', 'fr'], ['', 'fr'], ['Upper', 'fr'], ['a'.repeat(65), 'fr'], ['system:1', ''], ['system:1', 'f'], ['system:1', 'fr_TN'], ['system:1', '<b>']])('refuses template %j / locale %j', (template, locale) => {
    expect(() => buildPresentationSnapshot({ template, locale })).toThrow(SnapshotError);
  });

  it('ignores extra input so nothing can be smuggled into the snapshot', () => {
    const s = buildPresentationSnapshot({ template: 'system:1', locale: 'fr', total: 1, html: '<b>' } as never);
    expect(Object.keys(s).sort()).toEqual(['locale', 'schemaVersion', 'template']);
  });
});
