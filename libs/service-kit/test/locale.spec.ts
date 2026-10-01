import { describe, expect, it } from 'vitest';
import { MAX_ACCEPT_LANGUAGE_LENGTH, resolveLocale } from '../src/index.js';

/** ADR-0054 D7: Accept-Language negotiation for Core API error messages (en / fr / ar, English by default, never throws). */
describe('resolveLocale (ADR-0054 D7)', () => {
  it.each([
    [undefined, 'en'],
    ['', 'en'],
    ['en', 'en'],
    ['en-US', 'en'],
    ['fr', 'fr'],
    ['fr-FR', 'fr'],
    ['ar', 'ar'],
    ['ar-TN', 'ar'],
    ['FR-fr', 'fr'], // tags compare case-insensitively
    ['de', 'en'], // unsupported
    ['de-DE, es', 'en'],
  ] as const)('%j -> %s', (header, expected) => {
    expect(resolveLocale(header)).toBe(expected);
  });

  it('takes the first supported range in header order when q-values are equal', () => {
    expect(resolveLocale('de, ar, fr')).toBe('ar');
    expect(resolveLocale('fr-CA, en')).toBe('fr');
  });

  it('orders by q-value, highest first, and keeps header order on ties', () => {
    expect(resolveLocale('fr;q=0.5, ar;q=0.9, en;q=0.1')).toBe('ar');
    expect(resolveLocale('en;q=0.4, fr;q=0.8')).toBe('fr');
    expect(resolveLocale('ar;q=0.7, fr;q=0.7')).toBe('ar');
    expect(resolveLocale('de;q=1, fr;q=0.2')).toBe('fr'); // an unsupported preferred language falls through to the next supported one
  });

  it('excludes q=0 ranges', () => {
    expect(resolveLocale('fr;q=0, ar')).toBe('ar');
    expect(resolveLocale('fr;q=0')).toBe('en');
    expect(resolveLocale('ar;q=0.000, fr;q=0.001')).toBe('fr');
  });

  it('treats * as en at its own q-value', () => {
    expect(resolveLocale('*')).toBe('en');
    expect(resolveLocale('fr;q=0, *')).toBe('en');
    expect(resolveLocale('ar, *;q=0.5')).toBe('ar');
    expect(resolveLocale('*;q=0.9, fr')).toBe('fr');
    expect(resolveLocale('*;q=0.9, fr;q=0.5')).toBe('en');
  });

  it('skips malformed ranges (bad tag or bad q-value) and falls back to en when nothing usable remains', () => {
    expect(resolveLocale('fr;q=abc, ar')).toBe('ar');
    expect(resolveLocale('fr;q=1.5')).toBe('en');
    expect(resolveLocale('fr;q=-1')).toBe('en');
    expect(resolveLocale('f@r, ar')).toBe('ar');
    expect(resolveLocale(';;;,,,')).toBe('en');
    expect(resolveLocale('fr;level=1')).toBe('fr'); // a non-q parameter carries no preference
    expect(resolveLocale('fr-; ar')).toBe('en');
    expect(resolveLocale('x'.repeat(9))).toBe('en'); // a primary subtag longer than 8 letters
  });

  it('treats a header longer than 256 characters as absent', () => {
    const at = 'fr, de;q=0.5'.padEnd(MAX_ACCEPT_LANGUAGE_LENGTH, ' ');
    expect(at.length).toBe(MAX_ACCEPT_LANGUAGE_LENGTH);
    expect(resolveLocale(at)).toBe('fr');
    expect(resolveLocale(`${at} `)).toBe('en');
    expect(resolveLocale(`fr${' '.repeat(10_000)}`)).toBe('en');
  });

  it('considers at most 10 ranges', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `x${i}`).join(', ');
    expect(resolveLocale(`${nine}, ar`)).toBe('ar'); // the 10th range counts
    expect(resolveLocale(`${nine}, de, ar`)).toBe('en'); // the 11th is never read
  });

  it('accepts a repeated header (Node joins it into an array) and never throws on any input', () => {
    expect(resolveLocale(['de', 'fr'])).toBe('fr');
    const weird: unknown[] = [null, 42, {}, [1, 2], '\u0000￿', 'ar-\u{1F600}', 'é', 'q=1', ';q=1'];
    for (const w of weird) expect(() => resolveLocale(w as string)).not.toThrow();
    for (const w of weird) expect(['en', 'fr', 'ar']).toContain(resolveLocale(w as string));
  });
});
