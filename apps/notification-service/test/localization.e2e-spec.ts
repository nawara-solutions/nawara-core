import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { ALL_TEMPLATES, createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * ADR-0054 (Core V1 refactor R6.7): Notification's own API error messages in en / fr / ar. Status, `code`, `error`, the ids and the
 * `message: string[]` shape and order never change with the language; English without Accept-Language is the pre-R6.7 text; `EMAIL` /
 * `SMS` and property names stay verbatim; a key of the caller's free-form `data` stays English (D10); nothing submitted is echoed; and
 * the request's Accept-Language never changes the notification CONTENT (its rendering locale comes from the body only).
 */
const A = generateServiceToken();
const OTP = '305917';
const EMAIL = 'l10n-leak-probe@example.test';
const PHONE = '+21620000003';
const SENTINELS = [OTP, EMAIL, PHONE, 'SECRET_DATA_VALUE', 'FAKE_NOTIFICATION_SECRET'];
const POLICY = JSON.stringify({ callers: { 'core-caller-a': { templates: ALL_TEMPLATES, channels: ['EMAIL', 'SMS'], organizations: 'request' } } });
const NEGOTIATION: [string | undefined, 'en' | 'fr' | 'ar'][] = [
  [undefined, 'en'], ['en', 'en'], ['fr', 'fr'], ['ar', 'ar'], ['fr-FR', 'fr'], ['ar-TN', 'ar'], ['de-DE', 'en'], [';;q=x', 'en'], ['fr;q=0, ar', 'ar'], ['ar;q=0.4, fr;q=0.9', 'fr'],
];
const future = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const codeBody = (over: Record<string, unknown> = {}) => ({
  template: 'identity.contact_verification_code',
  recipient: { type: 'user', id: 'u-l10n' },
  channels: [{ channel: 'SMS', destination: PHONE }, { channel: 'EMAIL', destination: EMAIL }],
  data: { code: OTP, expiresAt: future(600) },
  expiresAt: future(600),
  ...over,
});
const noLeak = (r: request.Response) => {
  for (const s of SENTINELS) expect(r.text + JSON.stringify(r.headers)).not.toContain(s);
};

describeWithEnv('Notification API error localization over real HTTP (R6.7)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const post = (body: unknown, lang?: string, idem: string | null = `l10n-${randomUUID()}`) => {
    let r = request(t.app.getHttpServer()).post('/notification/notifications').set('authorization', `Bearer ${A.token}`);
    if (idem !== null) r = r.set('idempotency-key', idem); // null: no header
    if (lang !== undefined) r = r.set('accept-language', lang);
    return r.send(body as object);
  };
  const get = (path: string, lang?: string) => {
    const r = request(t.app.getHttpServer()).get(path).set('authorization', `Bearer ${A.token}`);
    return lang === undefined ? r : r.set('accept-language', lang);
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifl10n');
    await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens: [{ caller: 'core-caller-a', digest: A.digest }], policy: POLICY });
  });
  afterAll(async () => {
    await t?.app.close();
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${new URL(db.url).pathname.slice(1)}" WITH ALLOW_CONNECTIONS true`).catch(() => undefined);
    await db?.drop();
  });

  it.each(NEGOTIATION)('a single message (%s): code, status, error and ids identical; message and Content-Language follow', async (l, used) => {
    const r = await get(`/notification/notifications/${randomUUID()}`, l).set('x-correlation-id', 'corr-r67-0001');
    const message = { en: 'Notification not found.', fr: 'Notification introuvable.', ar: 'الإشعار غير موجود.' }[used];
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ statusCode: 404, message, error: 'Not Found', code: 'notification_not_found', requestId: r.headers['x-request-id'] });
    expect(r.headers['content-language']).toBe(used);
    expect(r.headers.vary).toMatch(/Accept-Language/);
    expect(r.headers['x-correlation-id']).toBe('corr-r67-0001');
  });

  it('a validation list: every element localized in place, same count and order, the property NAME verbatim, no value echoed', async () => {
    const body = { ...codeBody(), template: 'NOT A KEY', locale: 'SECRET_DATA_VALUE', unknownField: 'SECRET_DATA_VALUE' };
    const en = await post(body).expect(400);
    expect(en.body).toEqual({
      statusCode: 400, error: 'Bad Request', code: 'validation_error', requestId: en.headers['x-request-id'],
      message: ['unknownField: is not a field of this request', 'template: must be a template key', 'locale: must be a BCP 47 locale'],
    });
    expect(en.headers['content-language']).toBe('en');
    const fr = await post(body, 'fr').expect(400);
    expect(fr.body.message).toEqual(["unknownField : n'est pas un champ de cette requête", 'template : doit être une clé de modèle', 'locale : doit être une locale BCP 47']);
    expect(fr.body.code).toBe('validation_error');
    expect(fr.headers['content-language']).toBe('fr');
    const ar = await post(body, 'ar').expect(400);
    expect(ar.body.message).toEqual(['unknownField: ليس حقلًا في هذا الطلب', 'template: يجب أن يكون مفتاح قالب', 'locale: يجب أن تكون لغة بصيغة BCP 47']);
    expect(ar.headers['content-language']).toBe('ar');
    for (const r of [en, fr, ar]) noLeak(r);
  });

  it('server constants and the channel enum stay verbatim inside a translated list element', async () => {
    const r = await post({ ...codeBody(), channels: [{ channel: 'FAX', destination: PHONE }] }, 'fr').expect(400);
    expect(r.body.message).toEqual(['channels[0] : doit être {"channel": EMAIL | SMS, "destination": une chaîne de 1 à 320 caractères}']);
    noLeak(r);
  });

  it('D10: a template-defined variable is localized, a key of the caller\'s free-form data stays English; mixed list → "fr, en"', async () => {
    const body = codeBody({ data: { code: '30-59', expiresAt: future(600), clientKey: 'SECRET_DATA_VALUE' } });
    const en = await post(body).expect(422);
    expect(en.body).toEqual({ statusCode: 422, error: 'Unprocessable Entity', code: 'invalid_template_data', requestId: en.headers['x-request-id'], message: ['code: is invalid', 'clientKey: is invalid'] });
    expect(en.headers['content-language']).toBe('en');
    const fr = await post(body, 'fr').expect(422);
    expect(fr.body.message).toEqual(['code : est invalide', 'clientKey: is invalid']);
    expect(fr.headers['content-language']).toBe('fr, en');
    const ar = await post(body, 'ar').expect(422);
    expect(ar.body.message).toEqual(['code: غير صالح', 'clientKey: is invalid']);
    expect(ar.headers['content-language']).toBe('ar, en');
    for (const r of [en, fr, ar]) noLeak(r);
    const onlyClient = await post(codeBody({ data: { code: OTP, expiresAt: future(600), other: 1 } }), 'fr').expect(422);
    expect(onlyClient.body.message).toEqual(['other: is invalid']); // the free-form key alone: English, and said to be English
    expect(onlyClient.headers['content-language']).toBe('en');
  });

  it('invalid_destination: one complete sentence per shape, EMAIL / SMS verbatim, the destination never echoed', async () => {
    const one = await post(codeBody({ channels: [{ channel: 'SMS', destination: '0020000' }] }), 'fr').expect(422);
    expect(one.body).toMatchObject({ code: 'invalid_destination', message: "La destination SMS n'est pas valide (SMS : E.164, par exemple +21620000000 ; EMAIL : une adresse)." });
    const two = await post(codeBody({ channels: [{ channel: 'SMS', destination: 'nope' }, { channel: 'EMAIL', destination: 'nope' }] }), 'ar').expect(422);
    expect(two.body).toMatchObject({ code: 'invalid_destination', message: 'وجهتا SMS وEMAIL غير صالحتين (SMS: بصيغة E.164 مثل +21620000000؛ EMAIL: عنوان بريد).' });
    expect(two.body.message).not.toMatch(/ and /);
    const en = await post(codeBody({ channels: [{ channel: 'SMS', destination: 'nope' }, { channel: 'EMAIL', destination: 'nope' }] })).expect(422);
    expect(en.body.message).toBe('The SMS and EMAIL destination is not valid (SMS: E.164 such as +21620000000; EMAIL: an address).');
  });

  it('server values in a sentence: the schedule limit and the cancel counts', async () => {
    const far = await post(codeBody({ scheduledAt: future(400 * 86400), expiresAt: undefined }), 'fr').expect(422);
    expect(far.body).toMatchObject({ code: 'schedule_out_of_range' });
    expect(far.body.message).toMatch(/^scheduledAt doit être dans le futur et au plus \d+ s à l'avance\.$/);
    const created = await post(codeBody()).expect(202);
    await sql(db.url, `UPDATE notification_delivery SET status = 'SENDING', "leaseUntil" = now() + interval '1 minute', "nextAttemptAt" = NULL WHERE "notificationId" = $1 AND channel = 'SMS'`, [created.body.id]);
    const c = await request(t.app.getHttpServer()).post(`/notification/notifications/${created.body.id as string}/cancel`).set({ authorization: `Bearer ${A.token}`, 'accept-language': 'ar' }).expect(409);
    expect(c.body).toEqual({ statusCode: 409, error: 'Conflict', code: 'delivery_in_progress', requestId: c.headers['x-request-id'], message: 'أُلغيت 1 من عمليات التسليم المعلّقة؛ ولا يمكن استرجاع 1 قيد الإرسال بالفعل.' });
  });

  it('the Idempotency-Key format element (a one-element list) and the required header', async () => {
    const short = await post(codeBody(), 'fr', 'short').expect(400);
    expect(short.body.message).toEqual(['Idempotency-Key : doit comporter de 8 à 128 caractères parmi les lettres, les chiffres et . _ : -']);
    const none = await post(codeBody(), 'ar', null).expect(400);
    expect(none.body).toMatchObject({ code: 'idempotency_key_required', message: 'ترويسة Idempotency-Key مطلوبة.' });
  });

  it('a code-less 401 (the kit guard) stays code-less; a bearer is never echoed', async () => {
    for (const [l, text] of [['en', 'Unauthorized'], ['fr', 'Authentification requise'], ['ar', 'المصادقة مطلوبة']]) {
      const r = await request(t.app.getHttpServer()).get(`/notification/notifications/${randomUUID()}`).set({ authorization: 'Bearer FAKE_NOTIFICATION_SECRET', 'accept-language': l! });
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ statusCode: 401, message: text, error: 'Unauthorized', requestId: r.headers['x-request-id'] });
      noLeak(r);
    }
  });

  it('content boundary: Accept-Language never changes the notification\'s rendering locale; success bodies are unchanged', async () => {
    const plain = await post(codeBody()).expect(202);
    const arabic = await post(codeBody(), 'ar').expect(202);
    expect(arabic.headers['content-language']).toBeUndefined();
    expect(Object.keys(arabic.body).sort()).toEqual(Object.keys(plain.body).sort());
    expect(arabic.body.deliveries.map((d: { channel: string; status: string }) => [d.channel, d.status])).toEqual(plain.body.deliveries.map((d: { channel: string; status: string }) => [d.channel, d.status]));
    const viewPlain = (await get(`/notification/notifications/${plain.body.id as string}`).expect(200)).body;
    const viewArabic = (await get(`/notification/notifications/${arabic.body.id as string}`, 'ar').expect(200)).body;
    expect(viewArabic.deliveries.map((d: { locale: string }) => d.locale)).toEqual(viewPlain.deliveries.map((d: { locale: string }) => d.locale));
    const rows = await sql<{ requestedLocale: string | null }>(db.url, `SELECT "requestedLocale" FROM notification WHERE id = $1`, [arabic.body.id]);
    expect(rows[0]!.requestedLocale).toBeNull(); // the header is not a content locale
    const fr = await get(`/notification/notifications/${plain.body.id as string}`, 'fr').expect(200);
    expect(fr.body).toEqual(viewPlain);
    expect(fr.headers['content-language']).toBeUndefined();
  });
});
