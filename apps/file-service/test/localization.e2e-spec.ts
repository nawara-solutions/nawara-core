import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { Sql } from './support/fixtures.js';
import { ADVERSARIAL, SAMPLES } from './support/media.js';
import { UPLOAD_POLICY } from './support/upload.js';

/**
 * ADR-0054 (Core V1 refactor R6.4): File's own error messages in en / fr / ar. Status, `code`, `error` and the ids never change with
 * the language; English without Accept-Language is the pre-R6.4 text; a refusal is stored as its machine `failureCode` only and its
 * message is rendered at the response; nothing a client sent (a file name, a media type, a header value, a ticket) is ever echoed;
 * code-less errors stay code-less; success bodies are unchanged and carry no language header.
 */
const SENTINELS = ['SECRET_FILENAME_DO_NOT_LEAK', 'SECRET_MEDIA_TYPE', 'SECRET_DIGEST_VALUE', 'SECRET_TICKET_VALUE', 'FAKE_FILE_SECRET', '/srv/private/file-secret'];
const NEGOTIATION: [string | undefined, 'en' | 'fr' | 'ar'][] = [
  [undefined, 'en'], ['en', 'en'], ['fr', 'fr'], ['ar', 'ar'], ['fr-FR', 'fr'], ['ar-TN', 'ar'], ['de-DE', 'en'], [';;q=x', 'en'], ['fr;q=0, ar', 'ar'],
];
const noLeak = (r: request.Response) => {
  for (const s of SENTINELS) expect(r.text + JSON.stringify(r.headers)).not.toContain(s);
};

describeWithEnv('File error localization over real HTTP (R6.4)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let limited: TestApp;
  let s: Sql;
  const drive = generateServiceToken();
  const billing = generateServiceToken();
  const reader = generateServiceToken();
  const tokens = [{ caller: 'core-drive', digest: drive.digest }, { caller: 'core-billing', digest: billing.digest }, { caller: 'core-reader', digest: reader.digest }];
  const policy = JSON.stringify(UPLOAD_POLICY);
  const auth = (tok: { token: string }) => ({ authorization: `Bearer ${tok.token}` });
  const server = () => t.app.getHttpServer();
  const lang = (r: request.Test, l?: string) => (l === undefined ? r : r.set('accept-language', l));

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'filel10n');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy, env: { FILE_TICKET_FAILURE_LIMIT: '1000' } });
    limited = await createTestApp({ databaseUrl: db.url, tokens, policy, env: { FILE_TICKET_FAILURE_LIMIT: '1' } });
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await limited?.app.close();
    await db?.drop();
  });

  it.each(NEGOTIATION)('file_not_found (%s): code, status, error and ids identical; message and Content-Language follow', async (l, used) => {
    const res = await lang(request(server()).get(`/file/files/${randomUUID()}`).set({ ...auth(drive), 'x-correlation-id': 'corr-r64-0001' }), l);
    const message = { en: 'No such file.', fr: 'Fichier inexistant.', ar: 'الملف غير موجود.' }[used];
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ statusCode: 404, message, error: 'Not Found', code: 'file_not_found', requestId: res.headers['x-request-id'] });
    expect(res.headers['content-language']).toBe(used);
    expect(res.headers.vary).toMatch(/Accept-Language/);
    expect(res.headers['x-correlation-id']).toBe('corr-r64-0001');
  });

  it('an ingest refusal: the stored failureCode stays the machine value; the message is rendered per request; no file name or type echoed', async () => {
    const texts = { en: 'The file type is not accepted.', fr: "Le type de fichier n'est pas accepté.", ar: 'نوع الملف غير مقبول.' };
    for (const l of ['en', 'fr', 'ar'] as const) {
      const r = await request(server()).post('/file/files').set({
        ...auth(drive), 'accept-language': l, 'content-type': 'application/octet-stream', 'idempotency-key': `l10n-${randomUUID()}`,
        'x-file-name': 'SECRET_FILENAME_DO_NOT_LEAK.exe',
      }).send(ADVERSARIAL.windowsExe());
      expect(r.status).toBe(415);
      expect(r.body).toEqual({ statusCode: 415, message: texts[l], error: 'Unsupported Media Type', code: 'unsupported_media_type', requestId: r.headers['x-request-id'] });
      noLeak(r);
    }
    const rows = await s.query(`SELECT DISTINCT "failureCode" FROM file WHERE status = 'REJECTED'`);
    expect(rows).toEqual([{ failureCode: 'unsupported_media_type' }]); // never a sentence, never a language
  });

  it('header validation errors keep validation_error and never echo the header value; protocol names stay verbatim', async () => {
    const r = await request(server()).post('/file/files').set({
      ...auth(drive), 'accept-language': 'ar', 'content-type': 'SECRET_MEDIA_TYPE', 'idempotency-key': `l10n-${randomUUID()}`, 'content-digest': 'sha-256=:SECRET_DIGEST_VALUE:',
    }).send(SAMPLES.pdf(10));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'validation_error', message: 'قيمة sha-256 في الترويسة Content-Digest غير صالحة.' });
    noLeak(r);
  });

  it('ticket_invalid: the code is unchanged, the message follows the language, the ticket is never echoed', async () => {
    const texts = { en: 'The link is not valid.', fr: "Le lien n'est pas valide.", ar: 'الرابط غير صالح.' };
    for (const l of ['en', 'fr', 'ar'] as const) {
      const r = await request(server()).get('/file/t/SECRET_TICKET_VALUE').set('accept-language', l);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ statusCode: 404, message: texts[l], error: 'Not Found', code: 'ticket_invalid', requestId: r.headers['x-request-id'] });
      noLeak(r);
    }
  });

  it('a blocked ticket client gets 429 rate_limited, localized, with the same shape', async () => {
    await request(limited.app.getHttpServer()).get('/file/t/SECRET_TICKET_VALUE');
    const r = await request(limited.app.getHttpServer()).get('/file/t/SECRET_TICKET_VALUE').set('accept-language', 'fr');
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ statusCode: 429, message: 'Trop de requêtes.', error: 'Too Many Requests', code: 'rate_limited', requestId: r.headers['x-request-id'] });
    expect(r.headers['content-language']).toBe('fr');
    noLeak(r);
  });

  it('caller-policy refusals keep their codes; the message follows the language', async () => {
    const r = await request(server()).post('/file/uploads/tickets').set({ ...auth(reader), 'accept-language': 'fr' }).send({ maxBytes: 10, mediaTypes: ['application/pdf'] });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'operation_not_allowed', message: 'Opération non autorisée pour cet appelant.' });
  });

  it('a code-less 401 (the kit guard) stays code-less; a bearer is never echoed', async () => {
    for (const [l, text] of [['en', 'Unauthorized'], ['fr', 'Authentification requise'], ['ar', 'المصادقة مطلوبة']]) {
      const r = await request(server()).get(`/file/files/${randomUUID()}`).set({ authorization: 'Bearer FAKE_FILE_SECRET', 'accept-language': l! });
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ statusCode: 401, message: text, error: 'Unauthorized', requestId: r.headers['x-request-id'] });
      noLeak(r);
    }
  });

  it('class-validator failures (R4): the same string[], validation_error, localized elements; values never echoed', async () => {
    const body = { maxBytes: 'SECRET_MEDIA_TYPE', mediaTypes: ['application/pdf'], extra: '/srv/private/file-secret' };
    const en = await request(server()).post('/file/uploads/tickets').set(auth(drive)).send(body).expect(400);
    const fr = await request(server()).post('/file/uploads/tickets').set({ ...auth(drive), 'accept-language': 'fr' }).send(body).expect(400);
    for (const r of [en, fr]) {
      expect(Array.isArray(r.body.message)).toBe(true);
      expect(r.body.code).toBe('validation_error');
      noLeak(r);
    }
    expect(fr.body.message).toHaveLength(en.body.message.length);
    expect(fr.body.message[en.body.message.indexOf('property extra should not exist')]).toBe('la propriété extra ne doit pas être présente');
  });

  it('success bodies are identical in every language and carry no language header', async () => {
    const up = await request(server()).post('/file/files').set({ ...auth(drive), 'content-type': 'application/pdf', 'idempotency-key': `l10n-${randomUUID()}`, 'x-file-name': 'a.pdf' }).send(SAMPLES.pdf(10));
    expect(up.status).toBe(201);
    const get = (l?: string) => lang(request(server()).get(`/file/files/${up.body.id as string}`).set(auth(drive)), l).expect(200);
    const [en, fr, ar] = [await get(), await get('fr'), await get('ar')];
    expect(fr.body).toEqual(en.body);
    expect(ar.body).toEqual(en.body);
    expect(fr.headers['content-language']).toBeUndefined();
  });
});
