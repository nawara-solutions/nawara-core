import {
  Controller, ForbiddenException, Get, HttpException, Module, NotFoundException, Res, ServiceUnavailableException, UnauthorizedException, type Type,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HierarchyUnavailableError, JsonLogger, KitExceptionFilter, attachLocalizedMessageList, defineMessages, httpError, operationNotPermitted, requestContextMiddleware,
  type LocalizedListItem,
} from '../src/index.js';
import { createTestApp, type TestApp } from './support/app.js';

/**
 * ADR-0054 (Core V1 refactor R3): the shared filter localizes only safe message identities, after classification; `code`, `statusCode`,
 * `error` and the ids never change with the language; English stays byte-for-byte; F13 holds in every language.
 */
const DEMO = defineMessages({
  company_missing: { en: 'Company not found.', fr: 'Société introuvable.', ar: 'الشركة غير موجودة.' },
  range: { en: 'Pick {min} to {max}.', fr: 'Choisissez de {min} à {max}.', ar: 'اختر من {min} إلى {max}.' },
});
// Fake values only: what a database / network / filesystem error could carry.
const SENTINELS = ['password=DO_NOT_LEAK', 'db.internal.example', '/srv/private/core-secret', 'Bearer FAKE_SECRET', 'duplicate key value'];
const RAW = `duplicate key value violates "x" at db.internal.example:5432 password=DO_NOT_LEAK /srv/private/core-secret Bearer FAKE_SECRET`;

@Controller('l10n')
class L10nController {
  @Get('catalog') catalog() {
    throw httpError(404, 'company_not_found', DEMO.company_missing);
  }
  @Get('range') range() {
    throw httpError(400, 'demo_range', DEMO.range, { min: 1, max: 5 });
  }
  @Get('bare-401') bare401() {
    throw new UnauthorizedException();
  }
  @Get('coded-401') coded401() {
    throw new HttpException({ message: 'Unauthorized', code: 'session_expired' }, 401);
  }
  @Get('bare-403') bare403() {
    throw new ForbiddenException();
  }
  @Get('bare-404') bare404() {
    throw new NotFoundException();
  }
  @Get('bare-503') bare503() {
    throw new ServiceUnavailableException();
  }
  @Get('custom-404') custom404() {
    throw new NotFoundException('Company 42 does not exist');
  }
  @Get('plain-code') plainCode() {
    throw new HttpException({ message: 'already exists', code: 'already_exists' }, 409);
  }
  @Get('operation') operation() {
    throw operationNotPermitted();
  }
  @Get('hierarchy') hierarchy() {
    throw new HierarchyUnavailableError();
  }
  @Get('boom') boom() {
    throw Object.assign(new Error(RAW), { code: 'ECONNREFUSED' });
  }
  @Get('boom-string') boomString() {
    throw RAW; // not even an Error
  }
  @Get('vary') vary(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Vary', 'accept-language');
    throw new NotFoundException();
  }
  @Get('list') list() {
    // A service's own `string[]` problems, through the PUBLIC entry point: one element per item, the second kept as English (no identity).
    const items: (LocalizedListItem | undefined)[] = [{ prefix: 'lines[0].', message: { texts: DEMO.range, params: { min: 1, max: 5 } } }, undefined];
    throw attachLocalizedMessageList(new HttpException({ message: ['lines[0].Pick 1 to 5.', 'extra: is not a field'], code: 'validation_error' }, 400), items);
  }
  @Get('ok') ok() {
    return { ok: true };
  }
  @Get('legacy/404') legacy404() {
    throw new NotFoundException();
  }
  @Get('legacy/boom') legacyBoom() {
    throw new Error(RAW);
  }
}
@Module({ controllers: [L10nController as Type<unknown>] })
class L10nModule {}

const LOCALES = ['en', 'fr', 'ar'] as const;
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ extraImports: [L10nModule], env: { CORS_ORIGINS: 'https://admin.example.test' } });
});
afterAll(() => t.app.close());
const get = (path: string, lang?: string) => {
  const r = request(t.app.getHttpServer()).get(path).set('x-correlation-id', 'corr-l10n-0001');
  return lang === undefined ? r : r.set('accept-language', lang);
};

describe('language invariants (D1, D2, D5, D9)', () => {
  it.each([
    ['/l10n/catalog', 404, 'company_not_found', ['Company not found.', 'Société introuvable.', 'الشركة غير موجودة.']],
    ['/l10n/range', 400, 'demo_range', ['Pick 1 to 5.', 'Choisissez de 1 à 5.', 'اختر من 1 إلى 5.']],
    ['/l10n/operation', 403, 'operation_not_permitted', ['This operation is not permitted for the calling service.', "Cette opération n'est pas autorisée pour le service appelant.", 'هذه العملية غير مسموح بها للخدمة المستدعية.']],
    ['/l10n/hierarchy', 503, 'hierarchy_unavailable', ['The organization hierarchy could not be verified; nothing was changed. Retry later.', "La hiérarchie de l'organisation n'a pas pu être vérifiée ; rien n'a été modifié. Réessayez plus tard.", 'تعذّر التحقق من الهيكل التنظيمي؛ لم يتم تغيير أي شيء. أعد المحاولة لاحقًا.']],
    ['/l10n/boom', 500, undefined, ['Internal server error', 'Erreur interne du serveur', 'خطأ داخلي في الخادم']],
  ] as const)('%s: only the message and Content-Language change across en / fr / ar', async (path, status, code, texts) => {
    const responses = await Promise.all(LOCALES.map((l) => get(path, l).expect(status)));
    for (const [i, r] of responses.entries()) {
      expect(r.body).toEqual({ statusCode: status, message: texts[i], error: r.body.error, ...(code ? { code } : {}), requestId: r.headers['x-request-id'] });
      expect(r.headers['content-language']).toBe(LOCALES[i]);
      expect(r.headers['x-correlation-id']).toBe('corr-l10n-0001');
      expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.headers['content-type']).toMatch(/application\/json; charset=utf-8/);
    }
    expect(new Set(responses.map((r) => r.body.error)).size).toBe(1); // `error` stays the English status phrase
    expect(new Set(responses.map((r) => JSON.stringify({ ...r.body, message: 0, requestId: 0 }))).size).toBe(1);
  });

  it('keeps English byte-for-byte with no Accept-Language, with an unsupported language and with a malformed header (D6)', async () => {
    for (const lang of [undefined, 'de-DE', ';;q=x', '*']) {
      const r = await get('/l10n/catalog', lang).expect(404);
      expect(r.body.message).toBe('Company not found.');
      expect(r.headers['content-language']).toBe('en');
    }
  });

  it('negotiates regional tags and q-values end to end', async () => {
    expect((await get('/l10n/catalog', 'fr-FR')).body.message).toBe('Société introuvable.');
    expect((await get('/l10n/catalog', 'ar-TN')).body.message).toBe('الشركة غير موجودة.');
    expect((await get('/l10n/catalog', 'en-US, fr;q=0.9')).headers['content-language']).toBe('en');
    expect((await get('/l10n/catalog', 'fr;q=0.2, ar;q=0.8')).headers['content-language']).toBe('ar');
  });

  it('returns real UTF-8 Arabic', async () => {
    const r = await get('/l10n/catalog', 'ar');
    expect(Buffer.from(r.text, 'utf8').toString('utf8')).toContain('الشركة غير موجودة.');
  });
});

describe('generic texts; public codes exactly as thrown (R3 compatibility guard)', () => {
  it.each([
    ['/l10n/bare-401', 401, 'Unauthorized', 'Authentification requise', 'المصادقة مطلوبة'],
    ['/l10n/bare-403', 403, 'Forbidden', 'Accès refusé', 'الوصول مرفوض'],
    ['/l10n/bare-404', 404, 'Not Found', 'Introuvable', 'غير موجود'],
  ] as const)('%s: a code-less error stays code-less in en / fr / ar; only its safe status text is localized', async (path, status, en, fr, ar) => {
    for (const [lang, text] of [[undefined, en], ['en', en], ['fr', fr], ['ar', ar]] as const) {
      const r = await get(path, lang).expect(status);
      expect(r.body).toEqual({ statusCode: status, message: text, error: en, requestId: r.headers['x-request-id'] });
      expect(r.body).not.toHaveProperty('code');
    }
  });

  it('an explicitly coded error keeps exactly its code in en / fr / ar (the message identity never replaces it)', async () => {
    for (const [lang, text] of [['en', 'Unauthorized'], ['fr', 'Authentification requise'], ['ar', 'المصادقة مطلوبة']] as const) {
      const r = await get('/l10n/coded-401', lang).expect(401);
      expect(r.body).toEqual({ statusCode: 401, message: text, error: 'Unauthorized', code: 'session_expired', requestId: r.headers['x-request-id'] });
    }
  });

  it('a default 503 is localized and stays code-less', async () => {
    const r = await get('/l10n/bare-503', 'fr').expect(503);
    expect(r.body).toEqual({ statusCode: 503, message: 'Service indisponible', error: 'Service Unavailable', requestId: r.headers['x-request-id'] });
  });

  it('a Core-written message without a catalog entry passes through unchanged, in English, with its code', async () => {
    const custom = await get('/l10n/custom-404', 'fr').expect(404);
    expect(custom.body).toEqual({ statusCode: 404, message: 'Company 42 does not exist', error: 'Not Found', requestId: custom.headers['x-request-id'] });
    expect(custom.headers['content-language']).toBe('en');
    const coded = await get('/l10n/plain-code', 'ar').expect(409);
    expect(coded.body).toEqual({ statusCode: 409, message: 'already exists', error: 'Conflict', code: 'already_exists', requestId: coded.headers['x-request-id'] });
    expect(coded.headers['content-language']).toBe('en');
  });

  it('middleware client errors (body parser) get a localized generic text and no new code', async () => {
    // Malformed JSON is NOT on this path: Nest maps a body-parser SyntaxError to `BadRequestException(<JSON.parse message>)`, a
    // pass-through 400 that R3 leaves exactly as today (English, no code). Its message can quote the client's own input: a
    // pre-existing ADR-0054 D10 gap reported for an owner decision, deliberately not pinned here.
    const malformed = await request(t.app.getHttpServer()).post('/probe/echo').set('accept-language', 'fr').set('content-type', 'application/json').send('{"name": "SECRET-FRAGMENT", ');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(malformed.body.code).toBeUndefined();
    expect(malformed.headers['content-language']).toBe('en');
    const tooLarge = await request(t.app.getHttpServer()).post('/probe/echo').set('accept-language', 'ar').send({ name: 'x'.repeat(5000) });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).toMatchObject({ statusCode: 413, message: 'حجم المحتوى كبير جدًا', error: 'Payload Too Large' });
    expect(tooLarge.body.code).toBeUndefined();
  });

  it('validation keeps its string[] shape; R4 localizes each element and adds validation_error (see validation-localization.spec.ts)', async () => {
    const r = await request(t.app.getHttpServer()).post('/probe/echo').set('accept-language', 'fr').send({ name: 5, extra: 1 }).expect(400);
    expect(r.body).toEqual({
      statusCode: 400, message: ['la propriété extra ne doit pas être présente', 'name doit être une chaîne de caractères'], error: 'Bad Request',
      code: 'validation_error', requestId: r.headers['x-request-id'],
    });
    expect(r.headers['content-language']).toBe('fr');
  });
});

describe('a service list message through the public API (attachLocalizedMessageList)', () => {
  it('renders each identified element in place, keeps an unidentified one English, and reports the languages used', async () => {
    const en = await get('/l10n/list').expect(400);
    expect(en.body).toEqual({ statusCode: 400, message: ['lines[0].Pick 1 to 5.', 'extra: is not a field'], error: 'Bad Request', code: 'validation_error', requestId: en.headers['x-request-id'] });
    expect(en.headers['content-language']).toBe('en');
    const fr = await get('/l10n/list', 'fr').expect(400);
    expect(fr.body.message).toEqual(['lines[0].Choisissez de 1 à 5.', 'extra: is not a field']);
    expect(fr.body.code).toBe('validation_error');
    expect(fr.headers['content-language']).toBe('fr, en');
  });
});

describe('language response headers (D8)', () => {
  it('error responses carry Content-Language and append Accept-Language to the CORS Vary', async () => {
    const r = await get('/l10n/catalog', 'fr').set('origin', 'https://admin.example.test').expect(404);
    expect(r.headers['access-control-allow-origin']).toBe('https://admin.example.test');
    expect(r.headers['content-language']).toBe('fr');
    expect(r.headers.vary).toBe('Origin, Accept-Language');
  });

  it('never duplicates Accept-Language in Vary', async () => {
    const r = await get('/l10n/vary', 'ar').expect(404);
    expect(r.headers.vary?.toLowerCase().split(',').filter((v: string) => v.trim() === 'accept-language')).toHaveLength(1);
  });

  it('success responses are unchanged: no Content-Language and no Vary on Accept-Language', async () => {
    const r = await get('/l10n/ok', 'fr').expect(200);
    expect(r.headers['content-language']).toBeUndefined();
    expect(r.headers.vary ?? '').not.toMatch(/accept-language/i);
  });
});

describe('Stage 22 F13 in every language (D10)', () => {
  it.each(LOCALES)('%s: an unexpected error is an opaque, localized, code-less 500; no raw text reaches the body, headers or log', async (lang) => {
    for (const path of ['/l10n/boom', '/l10n/boom-string']) {
      t.logs.length = 0;
      const r = await get(path, lang).expect(500);
      expect(r.body).not.toHaveProperty('code'); // code-less before R3, code-less now
      expect(Object.keys(r.body).sort()).toEqual(['error', 'message', 'requestId', 'statusCode']);
      const exposed = r.text + JSON.stringify(r.headers);
      const logged = JSON.stringify(t.logs);
      for (const s of [RAW, ...SENTINELS]) {
        expect(exposed).not.toContain(s);
        expect(logged).not.toContain(s);
      }
      expect(t.logs.find((l) => l.msg === 'unhandled error')).toBeDefined();
    }
  });
});

describe('D12: an excluded path keeps the pre-localization rendering exactly', () => {
  let x: TestApp;
  beforeAll(async () => {
    x = await createTestApp({ extraImports: [L10nModule], configure: { errorLocalizationExcludedPaths: ['/l10n/legacy/'] } });
  });
  afterAll(() => x.app.close());

  it('no code, no localization and no language header under the excluded prefix', async () => {
    const nf = await request(x.app.getHttpServer()).get('/l10n/legacy/404').set('accept-language', 'fr').expect(404);
    expect(nf.body).toEqual({ statusCode: 404, message: 'Not Found', error: 'Not Found', requestId: nf.headers['x-request-id'] });
    expect(nf.headers['content-language']).toBeUndefined();
    expect(nf.headers.vary ?? '').not.toMatch(/accept-language/i);
    const boom = await request(x.app.getHttpServer()).get('/l10n/legacy/boom?x=1').set('accept-language', 'ar').expect(500);
    expect(boom.body).toEqual({ statusCode: 500, message: 'Internal server error', error: 'Internal Server Error', requestId: boom.headers['x-request-id'] });
    for (const s of [RAW, ...SENTINELS]) expect(boom.text).not.toContain(s);
  });

  it('paths outside the prefix are still localized', async () => {
    const r = await request(x.app.getHttpServer()).get('/l10n/bare-404').set('accept-language', 'fr').expect(404);
    expect(r.body).toEqual({ statusCode: 404, message: 'Introuvable', error: 'Not Found', requestId: r.headers['x-request-id'] });
  });
});

describe('the filter without options (how Auth constructs it until R5) is unchanged', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [L10nModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.use(requestContextMiddleware);
    app.useGlobalFilters(new KitExceptionFilter(new JsonLogger('legacy', 'error', () => undefined)));
    await app.listen(0, '127.0.0.1');
  });
  afterAll(() => app.close());

  it('English, no language headers, codes exactly as thrown, whatever the request asks', async () => {
    const s = app.getHttpServer();
    const nf = await request(s).get('/l10n/bare-401').set('accept-language', 'fr').expect(401);
    expect(nf.body).toEqual({ statusCode: 401, message: 'Unauthorized', error: 'Unauthorized', requestId: nf.headers['x-request-id'] });
    const cat = await request(s).get('/l10n/catalog').set('accept-language', 'ar').expect(404);
    expect(cat.body).toEqual({ statusCode: 404, message: 'Company not found.', error: 'Not Found', code: 'company_not_found', requestId: cat.headers['x-request-id'] });
    const boom = await request(s).get('/l10n/boom').set('accept-language', 'fr').expect(500);
    expect(boom.body).toEqual({ statusCode: 500, message: 'Internal server error', error: 'Internal Server Error', requestId: boom.headers['x-request-id'] });
    for (const r of [nf, cat, boom]) expect(r.headers['content-language']).toBeUndefined();
  });
});

describe('extraResponseFields: a subclass keeps its extra wire fields (ADR-0054 D11, R5)', () => {
  class ReasonFilter extends KitExceptionFilter {
    protected override extraResponseFields(raw: unknown): Record<string, unknown> {
      return typeof raw === 'object' && raw !== null && 'reason' in raw ? { reason: (raw as { reason: unknown }).reason } : {};
    }
  }
  @Controller('extra')
  class ExtraController {
    @Get('reason') reason() {
      const e = httpError(401, 'session_ceiling_reached', DEMO.company_missing);
      (e.getResponse() as Record<string, unknown>).reason = 'session_ceiling_reached';
      throw e;
    }
  }
  let app: NestExpressApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ExtraController as Type<unknown>] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.use(requestContextMiddleware);
    app.useGlobalFilters(new ReasonFilter(new JsonLogger('extra', 'error', () => undefined), { localize: true }));
    await app.listen(0, '127.0.0.1');
  });
  afterAll(() => app.close());

  it('copies the extra field verbatim, after code and before requestId, while message is localized', async () => {
    const r = await request(app.getHttpServer()).get('/extra/reason').set('accept-language', 'fr').expect(401);
    expect(Object.keys(r.body)).toEqual(['statusCode', 'message', 'error', 'code', 'reason', 'requestId']);
    expect(r.body).toMatchObject({ message: 'Société introuvable.', code: 'session_ceiling_reached', reason: 'session_ceiling_reached' });
  });

  it('the kit filter itself adds no extra field', async () => {
    const r = await request(t.app.getHttpServer()).get('/l10n/catalog').set('accept-language', 'fr').expect(404);
    expect(Object.keys(r.body).sort()).toEqual(['code', 'error', 'message', 'requestId', 'statusCode']);
  });
});
