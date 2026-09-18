import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacHex } from './hmac.js';
import { MAX_PASSWORD_BYTES, PasswordService } from './password.js';
import { generateSecretKey, normalizeSecretKey, randomSixDigitCode, randomToken, safeEqualHex, sha256Hex } from './random.js';
import { TotpSecretCipher } from './totp-cipher.js';

const key = () => randomBytes(32);

describe('TotpSecretCipher (AES-256-GCM)', () => {
  const c = new TotpSecretCipher(new Map([['k1', key()]]), 'k1');
  it('round-trips and never repeats a nonce', () => {
    const a = c.seal('JBSWY3DPEHPK3PXP', 'owner', 'factor');
    const b = c.seal('JBSWY3DPEHPK3PXP', 'owner', 'factor');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.ciphertext.subarray(1, 13).equals(b.ciphertext.subarray(1, 13))).toBe(false);
    expect(c.open(a.ciphertext, a.keyId, 'owner', 'factor')).toBe('JBSWY3DPEHPK3PXP');
    expect(a.ciphertext.toString('utf8')).not.toContain('JBSWY3DPEHPK3PXP');
  });
  it('rejects tampering anywhere in the blob', () => {
    const s = c.seal('secret', 'o', 'f');
    for (const i of [0, 5, 14, s.ciphertext.length - 1]) {
      const bad = Buffer.from(s.ciphertext); bad[i] ^= 1;
      expect(() => c.open(bad, 'k1', 'o', 'f')).toThrow();
    }
  });
  it('binds the ciphertext to its owner and factor (AAD): copying it to another row fails', () => {
    const s = c.seal('secret', 'owner-1', 'factor-1');
    expect(() => c.open(s.ciphertext, 'k1', 'owner-2', 'factor-1')).toThrow();
    expect(() => c.open(s.ciphertext, 'k1', 'owner-1', 'factor-2')).toThrow();
  });
  it('supports key rotation: old rows open with their recorded key id; reseal moves them to the active key', () => {
    const k1 = key(), k2 = key();
    const before = new TotpSecretCipher(new Map([['k1', k1]]), 'k1').seal('s3cret', 'o', 'f');
    const after = new TotpSecretCipher(new Map([['k1', k1], ['k2', k2]]), 'k2');
    expect(after.open(before.ciphertext, 'k1', 'o', 'f')).toBe('s3cret');
    const moved = after.reseal(before.ciphertext, 'k1', 'o', 'f');
    expect(moved.keyId).toBe('k2');
    expect(after.open(moved.ciphertext, 'k2', 'o', 'f')).toBe('s3cret');
    // once k1 is removed from the ring, unmigrated rows are unreadable (so migrate BEFORE removing)
    expect(() => new TotpSecretCipher(new Map([['k2', k2]]), 'k2').open(before.ciphertext, 'k1', 'o', 'f')).toThrow(/key ring/);
  });
  it('refuses to start without a valid active key', () => {
    expect(() => new TotpSecretCipher(new Map(), 'k1')).toThrow();
    expect(() => new TotpSecretCipher(new Map([['k1', Buffer.alloc(16)]]), 'k1')).toThrow();
  });
});

describe('hmacHex', () => {
  const p = key();
  it('is unambiguous, domain-separated and pepper-dependent', () => {
    expect(hmacHex(p, 'd', 'ab', 'c')).not.toBe(hmacHex(p, 'd', 'a', 'bc'));
    expect(hmacHex(p, 'd1', 'x')).not.toBe(hmacHex(p, 'd2', 'x'));
    expect(hmacHex(key(), 'd', 'x')).not.toBe(hmacHex(p, 'd', 'x'));
    expect(hmacHex(p, 'd', 'x')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('a bare SHA-256 of a 6-digit code is NOT what is stored (it would fall to a 10^6 search)', () => {
    expect(hmacHex(p, 'operator.code', 'op', 'login', '123456')).not.toBe(sha256Hex('123456'));
  });
});

describe('random material', () => {
  it('operator codes: 6 digits, uniform-looking, non-repeating', () => {
    const seen = new Set<string>();
    const digits: number[] = Array.from({ length: 10 }, () => 0);
    for (let i = 0; i < 3000; i++) {
      const c = randomSixDigitCode();
      expect(c).toMatch(/^\d{6}$/);
      seen.add(c);
      for (const d of c) digits[Number(d)]++;
    }
    expect(seen.size).toBeGreaterThan(2950); // not constant/sequential/time-derived
    for (const n of digits) expect(n).toBeGreaterThan(1500); // each digit ~1800 of 18000
  });
  it('secret key: 256 bits, canonical form round-trips, never repeats, rejects garbage', () => {
    const a = generateSecretKey(), b = generateSecretKey();
    expect(a).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
    expect(a).not.toBe(b);
    expect(normalizeSecretKey(a.toLowerCase())).toBe(a.replace(/-/g, ''));
    expect(normalizeSecretKey('short')).toBeNull();
    expect(normalizeSecretKey(a + 'I')).toBeNull();
  });
  it('tokens are 256-bit and unique; safeEqualHex is length-safe', () => {
    expect(randomToken()).toHaveLength(43);
    expect(randomToken()).not.toBe(randomToken());
    expect(safeEqualHex('ab', 'abcd')).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
    expect(safeEqualHex('ab', 'ab')).toBe(true);
  });
});

describe('PasswordService (bcrypt)', () => {
  const p = new PasswordService(4);
  it('hashes with a salt, verifies, and rejects wrong passwords', async () => {
    const h1 = await p.hash('correct horse battery'), h2 = await p.hash('correct horse battery');
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^\$2[aby]\$04\$/);
    expect(await p.verify(h1, 'correct horse battery')).toBe(true);
    expect(await p.verify(h1, 'wrong horse battery')).toBe(false);
  });
  it('an unknown account (no hash) is always false, after doing comparable work', async () => {
    expect(await p.verify(null, 'anything')).toBe(false);
    expect(await p.verify(undefined, 'anything')).toBe(false);
  });
  it('never silently truncates: over-long or too-short passwords are refused', async () => {
    await expect(p.hash('x'.repeat(MAX_PASSWORD_BYTES + 1))).rejects.toThrow();
    await expect(p.hash('short')).rejects.toThrow();
    expect(await p.verify(await p.hash('a'.repeat(72)), 'a'.repeat(73))).toBe(false);
  });
});
