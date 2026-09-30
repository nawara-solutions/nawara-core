import type { Request } from 'express';
import { rateLimitClientAddress, rateLimitIdentity } from '@nawara/service-kit';

/**
 * Stage 20.6, Stage 22 F3: the address the public rate limit is keyed by. It is chosen so that NO CLIENT CAN PICK ITS OWN BUCKET. It is
 * the kit's Core-wide rule (`rateLimitClientAddress`), which release-service's own Stage 20.6 implementation became:
 *
 * - `TRUST_PROXY_HOPS=0` (the default): the TCP peer address. Forwarding headers are ignored entirely.
 * - `TRUST_PROXY_HOPS=n`: the `X-Forwarded-For` entry n positions from the RIGHT (the one our own outermost trusted proxy appended). A
 *   client-written entry further left never counts; an unusable one falls back to the peer. With one hop this is the rightmost entry,
 *   exactly the Stage 20.6 behaviour.
 *
 * Normalization so a client cannot multiply its budget: an IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) counts as the IPv4 address, and
 * an IPv6 address counts by its /64 prefix (one host normally holds a whole /64).
 */
export function clientAddress(req: Pick<Request, 'headers' | 'socket'>, trustProxyHops: number): string {
  return rateLimitClientAddress(req, trustProxyHops);
}

/** IPv4-mapped IPv6 → IPv4; IPv6 → its /64 prefix; IPv4 unchanged; anything else unchanged (it is only ever hashed). */
export const normalize = rateLimitIdentity;
