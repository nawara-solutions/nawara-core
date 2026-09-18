import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateInvitationCode, generateJoinCode, hashInvitationCode, hashInviteeContact, hashJoinCode, normalizeInvitationCode, normalizeJoinCode } from './join-code.js';

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

  describe('admin invitations (a different credential)', () => {
    it('generates 12 unambiguous characters shown as three groups of four, and never repeats', () => {
      const c = generateInvitationCode();
      expect(c.normalized).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
      expect(c.display).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(new Set(Array.from({ length: 3000 }, () => generateInvitationCode().normalized)).size).toBe(3000);
    });

    it('normalizes case, spaces, hyphens and look-alikes; rejects anything that cannot be one', () => {
      const { display, normalized } = generateInvitationCode();
      expect(normalizeInvitationCode(display)).toBe(normalized);
      expect(normalizeInvitationCode(display.toLowerCase().replace(/-/g, ' '))).toBe(normalized);
      expect(normalizeInvitationCode('ABCD-0O1I-LXYZ')).toBe('ABCD0011' + '1XYZ');
      for (const bad of ['', 'short', 'ABCD-EFGH-IJK!', 'ABCD-EFGH', 'X'.repeat(70)]) expect(normalizeInvitationCode(bad)).toBeNull();
    });

    it('is domain separated from join codes and from the contact binding', () => {
      const pepper = randomBytes(32);
      const v = generateInvitationCode().normalized;
      expect(hashInvitationCode(pepper, v)).toMatch(/^[0-9a-f]{64}$/);
      expect(hashInvitationCode(pepper, v)).not.toBe(hashJoinCode(pepper, v)); // same input, different credential
      expect(hashInvitationCode(pepper, v)).not.toBe(hashInviteeContact(pepper, v));
      expect(hashInviteeContact(pepper, 'a@b.test')).toBe(hashInviteeContact(pepper, 'a@b.test'));
      expect(hashInviteeContact(pepper, 'a@b.test')).not.toBe(hashInviteeContact(pepper, 'c@b.test'));
      expect(hashInviteeContact(pepper, 'a@b.test')).not.toContain('a@b.test');
    });
  });
});
