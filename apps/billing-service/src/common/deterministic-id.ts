import { createHash } from 'node:crypto';

// Arbitrary, fixed namespace for THIS service's deterministically derived event ids (RFC 4122 section 4.3). It differs from
// every other service's, so two services can never derive the same id from the same words.
const NAMESPACE_HEX = 'a2678f5f98dd6f86b3af56552dc5297e';

/**
 * A version-5 (name-based, SHA-1) UUID derived from the given parts; Node has no built-in one (SDD section 23). The SAME
 * (aggregate, event name) always gives the SAME id, so a retried transition can enqueue its event at most once (the kit outbox
 * ignores a repeated id). Used from Stage 3 on; it lives here, locally, until an owner decision moves it into the kit (SDD R-9).
 */
export function deterministicEventId(...parts: string[]): string {
  const namespace = Buffer.from(NAMESPACE_HEX, 'hex');
  const name = Buffer.from(parts.join(':'), 'utf8');
  const hash = createHash('sha1').update(Buffer.concat([namespace, name])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
