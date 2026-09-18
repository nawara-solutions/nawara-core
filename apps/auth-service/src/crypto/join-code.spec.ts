import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateJoinCode, hashJoinCode, normalizeJoinCode } from './join-code.js';

describe('join codes', () => {
  it('generates 10 unambiguous characters, displayed in two groups, with an optional cosmetic prefix', () => {
    const c = generateJoinCode('drive');
    expect(c.normalized).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(c.display).toBe(`DRIVE-${c.normalized.slice(0, 5)}-${c.normalized.slice(5)}`);
    expect(generateJoinCode().display).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  it('never repeats over a large sample (CSPRNG, 50 bits)', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => generateJoinCode().normalized));
    expect(seen.size).toBe(5000);
  });

  it('normalizes case, spaces, hyphens, look-alikes and any prefix to the same credential', () => {
    const { display, normalized } = generateJoinCode('DRIVE');
    expect(normalizeJoinCode(display)).toBe(normalized);
    expect(normalizeJoinCode(display.toLowerCase())).toBe(normalized);
    expect(normalizeJoinCode(` ${display.replace(/-/g, ' ')} `)).toBe(normalized);
    expect(normalizeJoinCode(`OTHER-${normalized}`)).toBe(normalized); // the prefix is cosmetic
  });

  it('folds Crockford look-alikes (O->0, I/L->1)', () => {
    expect(normalizeJoinCode('ABCDE-0O1IL')).toBe('ABCDE00111');
  });

  it.each(['', 'short', 'ABCDE-FGH', 'ABCDE-FGH!J', 'ABCDE-FGHUX'.repeat(20)])('rejects input that cannot be a code: %j', (bad) => {
    expect(normalizeJoinCode(bad)).toBeNull();
  });

  it('hashes with the pepper: same code + pepper is stable, another pepper or code differs, and it is domain separated', () => {
    const p1 = randomBytes(32), p2 = randomBytes(32);
    const { normalized } = generateJoinCode();
    expect(hashJoinCode(p1, normalized)).toBe(hashJoinCode(p1, normalized));
    expect(hashJoinCode(p1, normalized)).not.toBe(hashJoinCode(p2, normalized));
    expect(hashJoinCode(p1, normalized)).not.toBe(hashJoinCode(p1, generateJoinCode().normalized));
    expect(hashJoinCode(p1, normalized)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashJoinCode(p1, normalized)).not.toContain(normalized);
  });
});
