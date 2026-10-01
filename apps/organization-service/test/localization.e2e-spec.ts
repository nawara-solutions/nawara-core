import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { organizationMigrationsDir } from '../src/app.module.js';
import { bearer, createTestApp, newKey, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

/**
 * ADR-0054 (Core V1 refactor R6.2): Organization's own error messages in en / fr / ar. Status, `code`, `error` and the ids never change
 * with the language; English without Accept-Language is the pre-R6.2 text; code-less errors stay code-less; the ownership phase (a machine
 * value) and a body property NAME are carried verbatim; the arbitrary rejected query key keeps its pre-R6.2 English (D10 deferred);
 * success bodies never change; nothing a client sent as a VALUE leaks.
 */
const SENTINELS = ['DO_NOT_LEAK', 'FAKE_ORG_SECRET', 'db.internal.example', '/srv/private/org-secret', 'SECRET_BODY_VALUE'];
// [Accept-Language, expected Content-Language]
const NEGOTIATION: [string | undefined, 'en' | 'fr' | 'ar'][] = [
  [undefined, 'en'], ['en', 'en'], ['fr', 'fr'], ['ar', 'ar'], ['fr-FR', 'fr'], ['ar-TN', 'ar'], ['de-DE', 'en'], [';;q=x', 'en'],
];

describeWithEnv('Organization error localization over real HTTP (R6.2)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let auth: Record<string, string>;
  const lang = <T extends { set(k: string, v: string): T }>(r: T, l: string | undefined): T => (l === undefined ? r : r.set('accept-language', l));
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL!, 'orgl10n');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url });
    auth = bearer(t.callers['billing-service']!);
  });
  afterAll(async () => {
    await t?.app.close();
    await db.drop();
  });

  it.each(NEGOTIATION)('pagination grammar (%s): code, status, error and ids identical; message and Content-Language follow the language', async (l, used) => {
    const r = await lang(t.http().get('/organization/companies?limit=0').set(auth).set('x-correlation-id', 'corr-r62-0001'), l);
    expect(r.status).toBe(400);
    const max = /(\d+)$/.exec(r.body.message)![1];
    const message = { en: `limit must be an integer from 1 to ${max}`, fr: `limit doit être un entier de 1 à ${max}`, ar: `يجب أن يكون limit عددًا صحيحًا من 1 إلى ${max}` }[used];
    expect(r.body).toEqual({ statusCode: 400, message, error: 'Bad Request', code: 'invalid_query', requestId: r.headers['x-request-id'] });
    expect(r.headers['content-language']).toBe(used);
    expect(r.headers.vary).toMatch(/Accept-Language/);
    expect(r.headers['x-correlation-id']).toBe('corr-r62-0001');
  });

  it('an unknown BODY field: the surrounding text is localized, the property NAME is carried verbatim, its VALUE never appears', async () => {
    for (const [l, prefix] of [['en', 'unknown field: '], ['fr', 'champ inconnu : '], ['ar', 'حقل غير معروف: ']]) {
      const r = await t.http().post('/organization/companies').set(auth).set('Idempotency-Key', newKey()).set('accept-language', l)
        .send({ name: 'Acme', nickname: 'SECRET_BODY_VALUE' });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ statusCode: 400, message: `${prefix}nickname`, error: 'Bad Request', code: 'invalid_company_request', requestId: r.headers['x-request-id'] });
      expect(r.text).not.toContain('SECRET_BODY_VALUE');
    }
  });

  it('an unknown QUERY key keeps its pre-R6.2 English in every language (ADR-0054 D10 deferred: not newly localized)', async () => {
    for (const l of ['en', 'fr', 'ar']) {
      const r = await t.http().get('/organization/companies?foo=1').set(auth).set('accept-language', l).expect(400);
      expect(r.body).toEqual({ statusCode: 400, message: 'unknown query parameter: foo', error: 'Bad Request', code: 'invalid_query', requestId: r.headers['x-request-id'] });
      expect(r.headers['content-language']).toBe('en');
    }
  });

  it('safe server-defined names and bounds are carried verbatim; a submitted VALUE is never echoed', async () => {
    const r = await t.http().get('/organization/organizations?platformId=db.internal.example').set(auth).set('accept-language', 'ar').expect(400);
    expect(r.body).toMatchObject({ code: 'invalid_query', message: 'يجب أن يكون platformId معرّفًا من نوع uuid' });
    const long = await t.http().post('/organization/companies').set(auth).set('Idempotency-Key', newKey()).set('accept-language', 'fr').send({ name: 'x'.repeat(201) }).expect(400);
    expect(long.body).toMatchObject({ code: 'invalid_company_request', message: 'name doit contenir de 1 à 200 caractères' });
    for (const res of [r, long]) for (const s of SENTINELS) expect(res.text).not.toContain(s);
  });

  it('an explicit code is preserved in every language (idempotency)', async () => {
    for (const [l, text] of [
      ['en', 'A valid Idempotency-Key header (8 to 128 characters of A-Z a-z 0-9 . _ : -) is required.'],
      ['fr', 'Un en-tête Idempotency-Key valide (8 à 128 caractères parmi A-Z a-z 0-9 . _ : -) est requis.'],
      ['ar', 'يلزم ترويسة Idempotency-Key صالحة (من 8 إلى 128 حرفًا من A-Z a-z 0-9 . _ : -).'],
    ]) {
      const r = await t.http().post('/organization/companies').set(auth).set('accept-language', l).send({ name: 'Acme' }).expect(400);
      expect(r.body).toEqual({ statusCode: 400, message: text, error: 'Bad Request', code: 'idempotency_key_required', requestId: r.headers['x-request-id'] });
    }
  });

  it('a code-less 401 (the kit guard) stays code-less; a bearer is never echoed', async () => {
    for (const [l, text] of [['en', 'Unauthorized'], ['fr', 'Authentification requise'], ['ar', 'المصادقة مطلوبة']]) {
      const r = await t.http().get('/organization/companies').set('authorization', 'Bearer FAKE_ORG_SECRET').set('accept-language', l).expect(401);
      expect(r.body).toEqual({ statusCode: 401, message: text, error: 'Unauthorized', requestId: r.headers['x-request-id'] });
      expect(r.text + JSON.stringify(r.headers)).not.toContain('FAKE_ORG_SECRET');
    }
  });

  it('success bodies never change with the language and carry no language header', async () => {
    await t.http().post('/organization/companies').set(auth).set('Idempotency-Key', newKey()).send({ name: 'Localized Co' }).expect(201);
    const en = await t.http().get('/organization/companies').set(auth).expect(200);
    const fr = await t.http().get('/organization/companies').set(auth).set('accept-language', 'fr').expect(200);
    const ar = await t.http().get('/organization/companies').set(auth).set('accept-language', 'ar').expect(200);
    expect(fr.body).toEqual(en.body);
    expect(ar.body).toEqual(en.body);
    expect(fr.headers['content-language']).toBeUndefined();
  });
});

describeWithEnv('Organization not-authoritative errors (R6.2): the ownership phase is a machine value, identical in every language', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL!, 'orgl10nphase');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, ownership: 'inactive' });
  });
  afterAll(async () => {
    await t?.app.close();
    await db.drop();
  });

  it('a hierarchy write is refused with not_authoritative; only the surrounding text is localized', async () => {
    const send = (l: string) => t.http().post('/organization/companies').set(bearer(t.callers['billing-service']!)).set('Idempotency-Key', newKey()).set('accept-language', l).send({ name: 'Acme' });
    const en = await send('en');
    expect(en.status).toBe(409);
    const phase = /\(phase ([A-Z_]+)\)/.exec(en.body.message)![1]!;
    expect(en.body).toEqual({ statusCode: 409, message: `organization-service is not authoritative yet (phase ${phase}): hierarchy writes are refused.`, error: 'Conflict', code: 'not_authoritative', requestId: en.headers['x-request-id'] });
    const fr = await send('fr');
    const ar = await send('ar');
    expect(fr.body.message).toBe(`organization-service ne fait pas encore autorité (phase ${phase}) : les écritures de la hiérarchie sont refusées.`);
    expect(ar.body.message).toBe(`لا تُعدّ organization-service مرجعية بعد (المرحلة ${phase}): تُرفض عمليات الكتابة على الهيكل التنظيمي.`);
    for (const r of [fr, ar]) expect(r.body).toMatchObject({ statusCode: 409, code: 'not_authoritative', error: 'Conflict' });
  });
});
