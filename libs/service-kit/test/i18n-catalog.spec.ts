import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { KIT_MESSAGES, statusMessage } from '../src/errors/kit-messages.js';
import { localizedMessageOf } from '../src/errors/http-error.js';
import { HierarchyUnavailableError, catalogProblems, defineMessages, httpError, operationNotPermitted, renderMessage, type MessageTexts } from '../src/index.js';

/** ADR-0054 D13: typed, in-memory EN / FR / AR catalogs; the kit owns only the generic texts. */
describe('kit generic catalog', () => {
  it('is complete: every message has non-empty en, fr and ar text with identical placeholders', () => {
    expect(catalogProblems(KIT_MESSAGES)).toEqual([]);
  });

  it('keeps every English text byte-identical to the message the kit returned before localization (D6)', () => {
    // the filter's status table (the `error` field) and the kit's own pre-ADR-0054 messages
    const before: Record<string, string> = {
      status_400: 'Bad Request', status_401: 'Unauthorized', status_403: 'Forbidden', status_404: 'Not Found', status_408: 'Request Timeout',
      status_409: 'Conflict', status_411: 'Length Required', status_413: 'Payload Too Large', status_415: 'Unsupported Media Type',
      status_422: 'Unprocessable Entity', status_429: 'Too Many Requests', status_500: 'Internal Server Error', status_502: 'Bad Gateway',
      status_503: 'Service Unavailable', internal_failure: 'Internal server error', rate_limited: 'Too many requests.',
      operation_not_permitted: 'This operation is not permitted for the calling service.',
      hierarchy_unavailable: 'The organization hierarchy could not be verified; nothing was changed. Retry later.',
    };
    expect(Object.keys(KIT_MESSAGES).sort()).toEqual(Object.keys(before).sort());
    for (const [id, en] of Object.entries(before)) expect(KIT_MESSAGES[id as keyof typeof KIT_MESSAGES].en).toBe(en);
    expect(statusMessage(404)).toBe(KIT_MESSAGES.status_404);
    expect(statusMessage(418)).toBeUndefined();
  });

  it('holds real UTF-8 Arabic (no transliteration) and real French', () => {
    for (const texts of Object.values<MessageTexts>(KIT_MESSAGES)) {
      expect(texts.ar).toMatch(/[؀-ۿ]/);
      expect(texts.ar).not.toMatch(/[A-Za-z]/);
      expect(texts.fr).not.toBe(texts.en);
      expect(Buffer.from(JSON.stringify({ m: texts.ar }), 'utf8').toString('utf8')).toBe(JSON.stringify({ m: texts.ar }));
    }
  });

  it('is frozen: a catalog cannot be changed at runtime', () => {
    expect(Object.isFrozen(KIT_MESSAGES)).toBe(true);
    expect(Object.isFrozen(KIT_MESSAGES.rate_limited)).toBe(true);
  });
});

describe('renderMessage and catalogProblems', () => {
  const demo = defineMessages({ range: { en: 'Pick {min} to {max}.', fr: 'Choisissez de {min} à {max}.', ar: 'اختر من {min} إلى {max}.' } });

  it('renders the requested language with safe parameters, and reports the language used', () => {
    expect(renderMessage(demo.range, 'fr', { min: 1, max: 5 })).toEqual({ text: 'Choisissez de 1 à 5.', locale: 'fr' });
    expect(renderMessage(demo.range, 'ar', { min: 1, max: 5 })).toEqual({ text: 'اختر من 1 إلى 5.', locale: 'ar' });
    expect(renderMessage(demo.range, 'en', { min: 1, max: 5 }).text).toBe('Pick 1 to 5.');
  });

  it('falls back to English when a translation is missing, and then reports en (D13)', () => {
    const broken = { en: 'Only English.', fr: '', ar: undefined } as unknown as MessageTexts;
    expect(renderMessage(broken, 'fr')).toEqual({ text: 'Only English.', locale: 'en' });
    expect(renderMessage(broken, 'ar')).toEqual({ text: 'Only English.', locale: 'en' });
  });

  it('never interpolates anything but the named parameters it is given', () => {
    expect(renderMessage(demo.range, 'en', { min: 1 }).text).toBe('Pick 1 to {max}.');
    expect(renderMessage(demo.range, 'en', { min: 1, max: 2, other: 'password=DO_NOT_LEAK' }).text).not.toContain('DO_NOT_LEAK');
    expect(renderMessage(demo.range, 'en', Object.create({ max: 'inherited' }) as never).text).toBe('Pick {min} to {max}.');
  });

  it('reports missing, empty and unsupported languages and placeholder drift', () => {
    expect(catalogProblems({ a: { en: 'x', fr: 'y' }, b: { en: 'x', fr: ' ', ar: 'z', de: 'w' }, c: { en: '{n} x', fr: 'x', ar: '{n} z' } })).toEqual([
      'a: missing ar text',
      'b: missing fr text',
      'b: unsupported language de',
      'c: fr placeholders differ from en',
    ]);
  });
});

describe('httpError (the shared error factory)', () => {
  it('builds the existing { message, code } body with the English text, and carries the message identity privately', () => {
    const e = httpError(409, 'demo_conflict', { en: 'Already there.', fr: 'Déjà là.', ar: 'موجود بالفعل.' });
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toEqual({ message: 'Already there.', code: 'demo_conflict' });
    expect(Object.keys(e.getResponse() as object)).toEqual(['message', 'code']); // nothing extra a filter could copy into a body
    expect(localizedMessageOf(e)?.texts.fr).toBe('Déjà là.');
    expect(Object.keys(e)).not.toContain('nawara.localizedMessage');
  });

  it('keeps a plain English string exactly as before (a thrower not yet adopted)', () => {
    const e = httpError(400, 'validation_error', 'Invalid phone number.');
    expect(e.getResponse()).toEqual({ message: 'Invalid phone number.', code: 'validation_error' });
    expect(localizedMessageOf(e)).toBeUndefined();
  });

  it('renders parameters into the English body', () => {
    const e = httpError(400, 'demo_range', { en: 'Pick {min} to {max}.', fr: 'Choisissez de {min} à {max}.', ar: 'اختر من {min} إلى {max}.' }, { min: 1, max: 9 });
    expect((e.getResponse() as { message: string }).message).toBe('Pick 1 to 9.');
  });

  it('moves the kit-owned errors onto the catalog with unchanged status, code and English text', () => {
    expect(operationNotPermitted().getResponse()).toEqual({ message: 'This operation is not permitted for the calling service.', code: 'operation_not_permitted' });
    expect(localizedMessageOf(operationNotPermitted())).toBeDefined();
    const h = new HierarchyUnavailableError();
    expect(h.getStatus()).toBe(503);
    expect(h.getResponse()).toEqual({ message: 'The organization hierarchy could not be verified; nothing was changed. Retry later.', code: 'hierarchy_unavailable' });
    expect(localizedMessageOf(h)?.texts).toBe(KIT_MESSAGES.hierarchy_unavailable);
  });
});
