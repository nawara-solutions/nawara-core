/**
 * ADR-0054 D7: the language of a Core API error message, negotiated from `Accept-Language` only. Pure, bounded and total: it never
 * throws and never rejects a request; whatever cannot be negotiated is English.
 */
export const SUPPORTED_LOCALES = ['en', 'fr', 'ar'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** A header longer than this is treated as absent (D7). */
export const MAX_ACCEPT_LANGUAGE_LENGTH = 256;
/** At most this many language ranges are considered, in header order (D7). */
export const MAX_LANGUAGE_RANGES = 10;

const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_LOCALES);
// A BCP 47-shaped tag (primary language plus subtags) or the `*` wildcard; anything else is skipped.
const TAG = /^(?:\*|[a-z]{1,8}(?:-[a-z0-9]{1,8})*)$/i;
// RFC 9110 qvalue: 0 to 1 with at most three decimals.
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * Resolves `Accept-Language` to `en`, `fr` or `ar`:
 *   - ranges are ordered by q-value, highest first; equal q-values keep header order; `q=0` excludes a range;
 *   - per range: an exact match, then its base language (`fr-FR` → `fr`, `ar-TN` → `ar`, `en-US` → `en`); the first supported wins;
 *   - `*` stands for `en` at its own q-value (`fr;q=0, *` → `en`; `ar, *;q=0.5` → `ar`);
 *   - a malformed range (bad tag or bad q) is skipped; a missing, oversized or entirely unusable header gives `en`.
 */
export function resolveLocale(header: string | readonly string[] | undefined): Locale {
  try {
    const value = typeof header === 'string' ? header : Array.isArray(header) ? header.join(',') : undefined;
    if (value === undefined || value.length > MAX_ACCEPT_LANGUAGE_LENGTH) return DEFAULT_LOCALE;
    const ranges: { tag: string; q: number; order: number }[] = [];
    const parts = value.split(',', MAX_LANGUAGE_RANGES);
    for (const [order, part] of parts.entries()) {
      const [rawTag, ...params] = part.split(';').map((s) => s.trim());
      if (!rawTag || !TAG.test(rawTag)) continue;
      let q = 1;
      let malformed = false;
      for (const p of params) {
        const m = /^q=(.*)$/i.exec(p);
        if (!m) continue; // other parameters carry no preference
        if (!QVALUE.test(m[1]!)) malformed = true;
        else q = Number(m[1]);
      }
      if (malformed || q === 0) continue;
      ranges.push({ tag: rawTag.toLowerCase(), q, order });
    }
    ranges.sort((a, b) => b.q - a.q || a.order - b.order);
    for (const { tag } of ranges) {
      if (tag === '*') return DEFAULT_LOCALE;
      if (SUPPORTED.has(tag)) return tag as Locale;
      const base = tag.split('-')[0]!;
      if (SUPPORTED.has(base)) return base as Locale;
    }
    return DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE; // defensive: negotiation must never fail a request
  }
}
