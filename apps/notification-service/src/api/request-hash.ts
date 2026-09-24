import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@nawara/service-kit';

/**
 * The API request hash (SDD §7.2; Stage 16.6 decision, replacing the unkeyed SHA-256 of the Payment pattern for this service):
 *
 *   requestHash = hex( HMAC-SHA-256( NOTIFICATION_REQUEST_HASH_KEY, "nawara.notification.api.v1|" + canonicalJson(body) ) )
 *
 * - The WHOLE semantic request participates, secret variables included, so the same Idempotency-Key with a changed one-time code is
 *   `422 idempotency_key_reused`.
 * - `canonicalJson` (the kit's) sorts object keys and ignores whitespace, so a property reordering is the same request.
 * - Keyed, because a Notification body can hold a low-entropy code (10^6 candidates) and every other field of the body is stored in
 *   clear beside the hash: an unkeyed digest would let anyone reading the database recover a live code in about a second. Payment
 *   bodies hold no such secret, which is why Payment keeps its unkeyed hash.
 * - The canonical plaintext exists only inside this call: it is never stored or logged. Only the 64-hex digest is stored.
 * - Rotation: one key. Changing it makes a retry of a request accepted under the previous key look different (`422
 *   idempotency_key_reused`) until that key's retry window has passed. Versioned keys are a Stage 16.9 carryover.
 */
export function requestHash(key: Buffer, body: unknown): string {
  return createHmac('sha256', key).update(`nawara.notification.api.v1|${canonicalJson(body)}`, 'utf8').digest('hex');
}

/** Constant-time comparison of two request hashes (64 hex characters each). */
export function sameRequestHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}
