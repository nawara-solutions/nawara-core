import { LOCALE_SHAPE } from '../config/notification-config.js';

/**
 * Locale resolution (SDD §6.4), per delivery, at intake. The first match among the locales a template publishes for the channel wins:
 *   1. the requested locale exactly (`fr-TN`);
 *   2. its base language (`fr`);
 *   3. the platform default (`NOTIFICATION_DEFAULT_LOCALE`), which the publish check and the intake startup check guarantee exists.
 * A missing or malformed request resolves to the default. Nothing is inferred from a phone number, a country or an organization.
 * Returns undefined only when even the default is not published (a deployment defect; the intake refuses to start in that state).
 */
export function resolveLocale(requested: string | null | undefined, published: ReadonlySet<string>, defaultLocale: string): string | undefined {
  if (requested && LOCALE_SHAPE.test(requested) && requested.length <= 35) {
    if (published.has(requested)) return requested;
    const base = requested.split('-')[0];
    if (published.has(base)) return base;
  }
  return published.has(defaultLocale) ? defaultLocale : undefined;
}
