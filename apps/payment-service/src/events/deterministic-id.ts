import { createHash } from 'node:crypto';

// Arbitrary, fixed namespace for this service's deterministically-derived event ids (RFC 4122 section 4.3).
const NAMESPACE_HEX = 'a3f1c2d45b6e4f7a8c9d0e1f2a3b4c5d';

/**
 * A version-5 (name-based, SHA-1) UUID derived from the given parts — Node has no built-in one (SDD section 11).
 * The SAME (aggregate, transition) always produces the SAME event id, so a retried state transition enqueues the
 * event at most once (the outbox's `ON CONFLICT (id) DO NOTHING`), never a duplicate.
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
