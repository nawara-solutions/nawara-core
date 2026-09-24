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
 * - Rotation (Stage 16.9): a new request is always hashed with the CURRENT key; a retry is compared with the stored hash under the
 *   current key and every configured PREVIOUS key (`NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS`, at most 2), so a key rotation never turns
 *   an honest retry into `422`. No key id is stored (the schema holds the 64-hex digest only); a retry whose hash was made with a key
 *   no longer configured is indistinguishable from a changed request: `422 idempotency_key_reused`, never a second intent.
 */
export function requestHash(key: Buffer, body: unknown): string {
  return createHmac('sha256', key).update(`nawara.notification.api.v1|${canonicalJson(body)}`, 'utf8').digest('hex');
}

/** Does the stored hash match this body under the current key or any previous key? Constant time per candidate. */
export function matchesRequestHash(stored: string, keys: readonly Buffer[], body: unknown): boolean {
  let match = false;
  for (const key of keys) match = sameRequestHash(stored, requestHash(key, body)) || match; // every key is tried: no early exit
  return match;
}

/** Constant-time comparison of two request hashes (64 hex characters each). */
export function sameRequestHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}
