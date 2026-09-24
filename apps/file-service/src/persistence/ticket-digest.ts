import { createHash } from 'node:crypto';

/**
 * The SHA-256 digest of an access-ticket token, lowercase hex: the ONLY form in which a ticket is ever stored or looked up (F35).
 * Branded, so a repository cannot be handed the raw token by mistake: the only way to get one is `ticketDigest`.
 */
export type TicketDigest = string & { readonly __ticketDigest: unique symbol };

/** A ticket token: 32 random bytes in unpadded base64url (43 characters). Generation is Stage 17.5 / 17.6; this is only its shape. */
export const TICKET_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_SHAPE = /^[0-9a-f]{64}$/;

/**
 * Digests a presented token. The hash covers the token string exactly as presented, after checking its shape, so there is one
 * representation per ticket (no decoding ambiguity). A random 256-bit token needs no key (unlike a phone number or an address, D21).
 * Returns `undefined` for anything that is not a token: the redemption answers `ticket_invalid` without a database read.
 */
export function ticketDigest(token: string): TicketDigest | undefined {
  if (!TICKET_TOKEN_SHAPE.test(token)) return undefined;
  return createHash('sha256').update(token, 'utf8').digest('hex') as TicketDigest;
}

/** Runtime guard for the repository boundary (the brand is compile-time only). */
export function assertTicketDigest(value: string): asserts value is TicketDigest {
  if (!DIGEST_SHAPE.test(value)) throw new Error('a ticket is stored and looked up by its SHA-256 digest only');
}
