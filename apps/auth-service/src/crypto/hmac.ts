import { createHmac } from 'node:crypto';

/**
 * HMAC-SHA-256 with a server-side pepper, over an UNAMBIGUOUS encoding of the inputs
 * (domain label, then each part length-prefixed) so ("ab","c") can never collide with ("a","bc").
 * Used for: operator working codes (a bare SHA-256 of a 6-digit code falls to a 10^6 offline
 * search), the owner secret key, and identifiers stored in rate-limit keys (no raw PII at rest).
 * The pepper lives outside the database, so a leaked table alone is not enough to test guesses.
 */
export function hmacHex(pepper: Buffer, domain: string, ...parts: string[]): string {
  const h = createHmac('sha256', pepper);
  h.update(`${domain}\0`);
  for (const p of parts) {
    h.update(`${Buffer.byteLength(p)}:`);
    h.update(p);
  }
  return h.digest('hex');
}
