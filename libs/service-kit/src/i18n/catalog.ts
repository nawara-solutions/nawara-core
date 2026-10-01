import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from './locale.js';

/**
 * ADR-0054 D13: one human message in every supported language. The type makes a missing language a compile error; `catalogProblems`
 * is the matching test-time check (also for a catalog built outside the type system). The `en` text of an existing message is its
 * current English wording, byte for byte (D6).
 */
export type MessageTexts = Readonly<Record<Locale, string>>;

/**
 * Values a message may interpolate as `{name}`. ONLY safe values the service computed itself (a configured bound, an enum value, a
 * count): never an exception message, SQL or database text, a host, a path, a token or any other infrastructure detail (D10).
 */
export type MessageParams = Readonly<Record<string, string | number>>;

/** A message identity plus its parameters, as the shared error factory carries it to the filter. Not part of any response. */
export interface LocalizedMessage {
  readonly texts: MessageTexts;
  readonly params?: MessageParams;
}

/** Declares a catalog: an internal message id (never a public field) to its texts. The object is frozen. */
export function defineMessages<const K extends string>(messages: Record<K, MessageTexts>): Readonly<Record<K, MessageTexts>> {
  for (const texts of Object.values<MessageTexts>(messages)) Object.freeze(texts);
  return Object.freeze(messages);
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * The message in `locale`, or in English when that text is missing (a defect `catalogProblems` exists to catch): `locale` in the
 * result is always the language of the returned text (D13), which is what `Content-Language` reports.
 */
export function renderMessage(texts: MessageTexts, locale: Locale, params?: MessageParams): { text: string; locale: Locale } {
  const used: Locale = typeof texts[locale] === 'string' && texts[locale] !== '' ? locale : DEFAULT_LOCALE;
  const template = texts[used];
  const text = params ? template.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole)) : template;
  return { text, locale: used };
}

/**
 * Every problem of a catalog, for a unit test: a supported language missing or empty, an unsupported language present, or placeholders
 * that differ between languages (a parameter rendered in one language and not another). Empty means complete.
 */
export function catalogProblems(messages: Readonly<Record<string, Partial<Record<string, unknown>>>>): string[] {
  const problems: string[] = [];
  for (const [id, texts] of Object.entries(messages)) {
    for (const locale of SUPPORTED_LOCALES) {
      const t = texts[locale];
      if (typeof t !== 'string' || t.trim() === '') problems.push(`${id}: missing ${locale} text`);
    }
    for (const locale of Object.keys(texts)) {
      if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) problems.push(`${id}: unsupported language ${locale}`);
    }
    const placeholders = (t: unknown) => (typeof t === 'string' ? [...t.matchAll(PLACEHOLDER)].map((m) => m[1]!).sort().join(',') : '');
    const expected = placeholders(texts[DEFAULT_LOCALE]);
    for (const locale of SUPPORTED_LOCALES) {
      if (typeof texts[locale] === 'string' && placeholders(texts[locale]) !== expected) problems.push(`${id}: ${locale} placeholders differ from en`);
    }
  }
  return problems;
}
