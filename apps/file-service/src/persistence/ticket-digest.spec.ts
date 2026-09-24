import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertTicketDigest, ticketDigest } from './ticket-digest.js';

describe('ticket digests (F35: SHA-256 of the token, the only stored form)', () => {
  const token = randomBytes(32).toString('base64url');

  it('is the lowercase hex SHA-256 of the token exactly as presented', () => {
    expect(token).toHaveLength(43);
    expect(ticketDigest(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(ticketDigest(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['empty', ''],
    ['too short', token.slice(0, 42)],
    ['too long', `${token}A`],
    ['padded', `${token.slice(0, 42)}=`],
    ['standard base64 characters', `${token.slice(0, 41)}+/`],
    ['a UUID', '8a8b1c52-7f39-4d8e-9d6b-1f0f2b8f3c11'],
    ['a path traversal', '../../../../../../../../../../../etc/passwd'],
  ])('is undefined for %s (no database read for what cannot be a token)', (_label, value) => {
    expect(ticketDigest(value)).toBeUndefined();
  });

  it('the repository boundary accepts a digest and refuses a raw token or anything else', () => {
    expect(() => assertTicketDigest(ticketDigest(token)!)).not.toThrow();
    for (const bad of [token, ticketDigest(token)!.toUpperCase(), 'abc', '']) {
      expect(() => assertTicketDigest(bad)).toThrow(/digest only/);
    }
  });
});
