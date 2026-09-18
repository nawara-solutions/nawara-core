import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Opaque high-entropy bearer value (default 256 bits). Always from the OS CSPRNG. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Unkeyed SHA-256, used ONLY for values that are already high-entropy random (tokens). */
export const sha256Hex = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');

/** Uniform 6-digit code from the CSPRNG (`randomInt` rejects modulo bias). Never time/ID derived. */
export const randomSixDigitCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** Constant-time comparison of two hex digests of equal length; false (not throw) on mismatch. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

// Crockford-style alphabet (no I, L, O, U): unambiguous when a human copies the key by hand.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Owner secret key: 256 bits of CSPRNG output, rendered as 13 groups of 4 base32 characters.
 * It is a HIGH-ENTROPY RANDOM recovery/step-up credential, never a human-chosen secret — that is
 * why storing an HMAC of it (not a slow password hash) is the right construction.
 */
export function generateSecretKey(): string {
  const bytes = randomBytes(32);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join('-');
}

/** Canonical form used for hashing/comparison; returns null when it cannot be a secret key. */
export function normalizeSecretKey(input: string): string | null {
  const k = input.toUpperCase().replace(/[\s-]/g, '');
  return /^[0-9A-HJKMNP-TV-Z]{52}$/.test(k) ? k : null;
}
