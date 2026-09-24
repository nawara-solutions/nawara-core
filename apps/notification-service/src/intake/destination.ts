/**
 * Destination rules at intake (SDD §7.1, D20). Notification is a DEFENSIVE validator, never the owner of a contact or of its country
 * context: a destination is accepted exactly as the producer sent it, or refused. Nothing is normalized, prefixed or guessed.
 */

/**
 * SMS: canonical E.164 only. A `+`, a non-zero country-code digit, then 7 to 14 more digits (8 to 15 in all, ITU-T E.164). No
 * spaces, dashes, parentheses, leading zero, `00` prefix or local number. No default country: `20000003` is invalid, never `+216…`.
 */
export const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * Email: a bounded, deliberately conservative ASCII check (not the full RFC 5321/5322 grammar):
 * - at most 254 characters, exactly one `@`;
 * - local part: 1 to 64 characters of letters, digits and ``.!#$%&'*+/=?^_`{|}~-``, no leading, trailing or doubled dot;
 * - domain: at least two dot-separated labels of letters, digits and inner hyphens (1 to 63 each); an internationalized domain
 *   arrives in its `xn--` form;
 * - no whitespace or control character anywhere.
 * The address is stored exactly as given: no case folding, no trimming (Auth owns its normalization).
 */
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function isValidEmail(v: string): boolean {
  if (v.length > 254) return false;
  const at = v.indexOf('@');
  if (at < 1 || at !== v.lastIndexOf('@')) return false;
  const local = v.slice(0, at);
  const labels = v.slice(at + 1).split('.');
  return local.length <= 64 && LOCAL.test(local) && labels.length >= 2 && labels.every((l) => LABEL.test(l));
}

export type DeliveryChannel = 'EMAIL' | 'SMS';

export function isValidDestination(channel: DeliveryChannel, destination: string): boolean {
  return channel === 'SMS' ? E164.test(destination) : isValidEmail(destination);
}
