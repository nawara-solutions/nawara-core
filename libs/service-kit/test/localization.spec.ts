import {
  Controller, ForbiddenException, Get, HttpException, Module, NotFoundException, Res, ServiceUnavailableException, UnauthorizedException, type Type,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HierarchyUnavailableError, JsonLogger, KitExceptionFilter, defineMessages, httpError, operationNotPermitted, requestContextMiddleware,
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
    ['/l10n/boom', 500, 'internal_error', ['Internal server error', 'Erreur interne du serveur', 'خطأ داخلي في الخادم']],
  ] as const)('%s: only the message and Content-Language change across en / fr / ar', async (path, status, code, texts) => {
    const responses = await Promise.all(LOCALES.map((l) => get(path, l).expect(status)));
    for (const [i, r] of responses.entries()) {
      expect(r.body).toEqual({ statusCode: status, message: texts[i], error: r.body.error, code, requestId: r.headers['x-request-id'] });
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

describe('generic texts and codes (D4, D13)', () => {
  it.each([
    ['/l10n/bare-401', 401, 'unauthenticated', 'Unauthorized', 'Authentification requise'],
    ['/l10n/bare-403', 403, 'forbidden', 'Forbidden', 'Accès refusé'],
    ['/l10n/bare-404', 404, 'not_found', 'Not Found', 'Introuvable'],
  ] as const)('%s: a default Nest exception gets its existing generic code and a localized status text', async (path, status, code, en, fr) => {
    expect((await get(path).expect(status)).body).toMatchObject({ statusCode: status, message: en, code });
    expect((await get(path, 'fr').expect(status)).body).toMatchObject({ statusCode: status, message: fr, code, error: en });
  });

  it('a default 503 is localized but gets no code: its generic code is not decided by ADR-0054', async () => {
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

  it('validation keeps its current shape and English messages (R4 localizes them)', async () => {
    const r = await request(t.app.getHttpServer()).post('/probe/echo').set('accept-language', 'fr').send({ name: 5, extra: 1 }).expect(400);
    expect(Array.isArray(r.body.message)).toBe(true);
    expect(r.body.message).toEqual(expect.arrayContaining(['property extra should not exist', 'name must be a string']));
    expect(r.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(r.body.code).toBeUndefined();
    expect(r.headers['content-language']).toBe('en');
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
  it.each(LOCALES)('%s: an unexpected error is an opaque, localized 500; no raw text reaches the body, headers or log', async (lang) => {
    for (const path of ['/l10n/boom', '/l10n/boom-string']) {
      t.logs.length = 0;
      const r = await get(path, lang).expect(500);
      expect(r.body.code).toBe('internal_error');
      expect(Object.keys(r.body).sort()).toEqual(['code', 'error', 'message', 'requestId', 'statusCode']);
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
    expect(r.body).toMatchObject({ message: 'Introuvable', code: 'not_found' });
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

  it('English, no generic codes, no internal_error, no language headers, whatever the request asks', async () => {
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
