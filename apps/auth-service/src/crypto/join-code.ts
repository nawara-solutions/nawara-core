import { randomInt } from 'node:crypto';
import { hmacHex } from './hmac.js';

/**
 * Organization join codes are ONBOARDING CREDENTIALS, not identifiers: the organization id is never
 * the code and never derivable from it.
 *
 *   code     : 10 characters from the CSPRNG (50 bits), shown as XXXXX-XXXXX with an optional cosmetic
 *              prefix ("DRIVE-XXXXX-XXXXX"). The prefix is not part of the credential.
 *   storage  : HMAC-SHA-256(JOIN_CODE_PEPPER, normalized code). The plaintext is returned once, at
 *              creation, and never stored or logged.
 *   guessing : 50 bits plus per-IP and global rate limits (ThrottleService) make enumeration
 *              infeasible; every failure looks identical to the caller.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
const CODE_LEN = 10;

export interface GeneratedJoinCode {
  /** What the organization hands to the user, e.g. "DRIVE-7K4P9-Q2M8X". Shown once. */
  display: string;
  /** Canonical 10-character form that is hashed. */
  normalized: string;
}

export function generateJoinCode(prefix?: string): GeneratedJoinCode {
  let normalized = '';
  for (let i = 0; i < CODE_LEN; i++) normalized += ALPHABET[randomInt(0, ALPHABET.length)];
  const body = `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
  const p = (prefix ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return { display: p ? `${p}-${body}` : body, normalized };
}

/**
 * Canonical form of user input, or null when it cannot be a join code. Case, spaces and hyphens are
 * ignored, the usual Crockford look-alikes are folded (O->0, I/L->1), and only the trailing 10
 * characters count, so a cosmetic prefix (or a mistyped one) never changes the credential.
 */
export function normalizeJoinCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-Z]+$/.test(cleaned) || cleaned.length < CODE_LEN) return null;
  const tail = cleaned.slice(-CODE_LEN);
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(tail) ? tail : null;
}

export const hashJoinCode = (pepper: Buffer, normalized: string): string => hmacHex(pepper, 'join_code', normalized);

// ---------------------------------------------------------------------------------------------
// Admin invitations (ADR-0029): a DIFFERENT credential from a join code. Longer (12 characters, 60 bits),
// single use, and hashed under its own HMAC domain label, so a join code can never match an invitation
// row (or the other way round) even if the two values were somehow equal.
// ---------------------------------------------------------------------------------------------
const INVITATION_LEN = 12;

export function generateInvitationCode(): GeneratedJoinCode {
  let normalized = '';
  for (let i = 0; i < INVITATION_LEN; i++) normalized += ALPHABET[randomInt(0, ALPHABET.length)];
  return { display: `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8)}`, normalized };
}

/** Canonical 12-character form of user input, or null. Case, spaces, hyphens and look-alikes are folded. */
export function normalizeInvitationCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-Z]+$/.test(cleaned) || cleaned.length < INVITATION_LEN) return null;
  const tail = cleaned.slice(-INVITATION_LEN);
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(tail) ? tail : null;
}

export const hashInvitationCode = (pepper: Buffer, normalized: string): string => hmacHex(pepper, 'admin_invitation', normalized);

/** Optional binding of an invitation to the intended person: an HMAC, so no e-mail/phone is stored. */
export const hashInviteeContact = (pepper: Buffer, normalizedContact: string): string => hmacHex(pepper, 'invitee_contact', normalizedContact);
