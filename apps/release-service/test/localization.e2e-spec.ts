import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { releaseMigrationsDir } from '../src/app.module.js';
import { ReleaseStore } from '../src/persistence/release-store.js';
import { createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * ADR-0054 (Core V1 refactor R6.3): Release's own error messages in en / fr / ar. Status, `code`, `error` and the ids never change with
 * the language; English without Accept-Language is the pre-R6.3 text; every sentence is whole in one language (no translated frame
 * around an English fragment); the release status stays a machine value; code-less errors stay code-less; the public compatibility
 * decision and every success body are unchanged; nothing a client sent as a value leaks.
 */
const SENTINELS = ['DO_NOT_LEAK', 'FAKE_RELEASE_SECRET', 'release-db.internal.example', '/srv/private/release-secret', 'SECRET_VERSION_VALUE'];
const NEGOTIATION: [string | undefined, 'en' | 'fr' | 'ar'][] = [
  [undefined, 'en'], ['en', 'en'], ['fr', 'fr'], ['ar', 'ar'], ['fr-FR', 'fr'], ['ar-TN', 'ar'], ['de-DE', 'en'], [';;q=x', 'en'],
];

describeWithEnv('Release error localization over real HTTP (R6.3)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  const ci = generateServiceToken();
  const regOnly = generateServiceToken();
  const server = () => t.app.getHttpServer();
  const register = (component: string, body: object, token = ci.token, product = 'prod') =>
    request(server()).post(`/release/products/${product}/components/${component}/releases`).set('authorization', `Bearer ${token}`).send(body);
  const publish = (component: string, version: string, token = ci.token) =>
    request(server()).post(`/release/products/prod/components/${component}/releases/${version}/publish`).set('authorization', `Bearer ${token}`);
  const compat = (component: string, query: Record<string, string>) => request(server()).get(`/release/products/prod/components/${component}/compatibility`).query(query);

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL!, 'rell10n');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, releaseMigrationsDir]);
    t = await createTestApp({
      databaseUrl: d.appUrl,
      env: {
        SERVICE_TOKENS: `prod-ci:${ci.digest},prod-register:${regOnly.digest}`,
        RELEASE_SERVICE_POLICY: JSON.stringify({ callers: { 'prod-ci': { products: { prod: ['release.register', 'release.publish'] } }, 'prod-register': { products: { prod: ['release.register'] } } } }),
        RELEASE_COMPATIBILITY_RATE_PER_CLIENT: '100000',
      },
    });
    expect((await register('app-ok', { kind: 'web', version: '1.0.0' })).status).toBe(201);
    expect((await publish('app-ok', '1.0.0')).status).toBe(200);
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
  });

  it.each(NEGOTIATION)('public compatibility endpoint (%s): code, status, error and ids identical; message and Content-Language follow', async (l, used) => {
    let r = compat('app-missing', { version: '1.0.0' }).set('x-correlation-id', 'corr-r63-0001');
    if (l !== undefined) r = r.set('accept-language', l);
    const res = await r;
    const message = { en: 'No such client component.', fr: 'Composant client inexistant.', ar: 'مكوّن العميل غير موجود.' }[used];
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ statusCode: 404, message, error: 'Not Found', code: 'unknown_component', requestId: res.headers['x-request-id'] });
    expect(res.headers['content-language']).toBe(used);
    expect(res.headers.vary).toMatch(/Accept-Language/);
    expect(res.headers['x-correlation-id']).toBe('corr-r63-0001');
  });

  it('the compatibility decision (success) is identical in every language and carries no language header', async () => {
    const en = await compat('app-ok', { version: '1.0.0' }).expect(200);
    const fr = await compat('app-ok', { version: '1.0.0' }).set('accept-language', 'fr').expect(200);
    const ar = await compat('app-ok', { version: '1.0.0' }).set('accept-language', 'ar').expect(200);
    expect(fr.body).toEqual(en.body);
    expect(ar.body).toEqual(en.body);
    expect(en.body.update).toBe('none'); // machine value
    expect(fr.headers['content-language']).toBeUndefined();
  });

  it('compatibility input errors are localized and never echo the submitted value', async () => {
    const bad = await compat('app-ok', { version: 'SECRET_VERSION_VALUE' }).set('accept-language', 'fr').expect(400);
    expect(bad.body).toMatchObject({ code: 'invalid_version', message: "La version n'est pas une version canonique." });
    const extra = await compat('app-ok', { version: '1.0.0', DO_NOT_LEAK: '/srv/private/release-secret' }).set('accept-language', 'ar').expect(400);
    expect(extra.body).toMatchObject({ code: 'validation_error', message: 'لا يُقبل إلا معامل الاستعلام version.' });
    for (const r of [bad, extra]) for (const s of SENTINELS) expect(r.text + JSON.stringify(r.headers)).not.toContain(s);
  });

  it('each "… is invalid." case is a whole sentence in one language, never a translated frame around an English fragment', async () => {
    const texts = { en: 'The component key is invalid.', fr: 'La clé du composant est invalide.', ar: 'مفتاح المكوّن غير صالح.' };
    for (const l of ['en', 'fr', 'ar'] as const) {
      const r = await register('Bad_Key', { kind: 'web', version: '1.0.0' }).set('accept-language', l).expect(400);
      expect(r.body).toEqual({ statusCode: 400, message: texts[l], error: 'Bad Request', code: 'validation_error', requestId: r.headers['x-request-id'] });
      if (l !== 'en') expect(r.body.message).not.toMatch(/component key|is invalid|The /);
    }
    const v = await publish('app-ok', 'v1x').set('accept-language', 'ar').expect(400);
    expect(v.body).toMatchObject({ code: 'validation_error', message: 'الإصدار غير صالح.' });
  });

  it('the release status in a transition refusal is a machine value, identical in every language', async () => {
    expect((await register('app-wd', { kind: 'web', version: '1.0.0' })).status).toBe(201);
    expect((await publish('app-wd', '1.0.0')).status).toBe(200);
    const store = t.app.get(ReleaseStore);
    const comp = (await sql<{ id: string }>(d.adminUrl, `SELECT id FROM component WHERE key = 'app-wd'`))[0]!.id;
    await store.withdrawRelease((await store.findRelease(comp, '1.0.0'))!.id);
    const texts = { en: 'A withdrawn release cannot be published.', fr: "Une version à l'état withdrawn ne peut pas être publiée.", ar: 'لا يمكن نشر إصدار في الحالة withdrawn.' };
    for (const l of ['en', 'fr', 'ar'] as const) {
      const r = await publish('app-wd', '1.0.0').set('accept-language', l).expect(409);
      expect(r.body).toEqual({ statusCode: 409, message: texts[l], error: 'Conflict', code: 'invalid_transition', requestId: r.headers['x-request-id'] });
    }
  });

  it('caller-policy refusals keep their codes; the message follows the language', async () => {
    const op = await publish('app-ok', '1.0.0', regOnly.token).set('accept-language', 'fr').expect(403);
    expect(op.body).toMatchObject({ code: 'operation_not_allowed', message: 'Opération non autorisée pour cet appelant.' });
    const prod = await register('app-x', { kind: 'web', version: '1.0.0' }, ci.token, 'other').set('accept-language', 'ar').expect(403);
    expect(prod.body).toMatchObject({ code: 'product_not_allowed', message: 'لا يملك هذا المستدعي أي صلاحية على هذا المنتج.' });
  });

  it('a code-less 401 (the kit guard) stays code-less; a bearer is never echoed', async () => {
    for (const [l, text] of [['en', 'Unauthorized'], ['fr', 'Authentification requise'], ['ar', 'المصادقة مطلوبة']]) {
      const r = await register('app-ok', { kind: 'web', version: '1.0.0' }, 'FAKE_RELEASE_SECRET').set('accept-language', l).expect(401);
      expect(r.body).toEqual({ statusCode: 401, message: text, error: 'Unauthorized', requestId: r.headers['x-request-id'] });
      expect(r.text + JSON.stringify(r.headers)).not.toContain('FAKE_RELEASE_SECRET');
    }
  });

  it('class-validator failures (R4): the same string[], validation_error, localized elements; the submitted value is never echoed', async () => {
    const en = await register('app-ok', { kind: 'nope', version: '1.0.0', extra: 'SECRET_VERSION_VALUE' }).expect(400);
    const fr = await register('app-ok', { kind: 'nope', version: '1.0.0', extra: 'SECRET_VERSION_VALUE' }).set('accept-language', 'fr').expect(400);
    for (const r of [en, fr]) {
      expect(Array.isArray(r.body.message)).toBe(true);
      expect(r.body.code).toBe('validation_error');
      expect(r.text).not.toContain('SECRET_VERSION_VALUE');
    }
    expect(fr.body.message).toHaveLength(en.body.message.length);
    const i = en.body.message.indexOf('property extra should not exist');
    expect(fr.body.message[i]).toBe('la propriété extra ne doit pas être présente');
  });
});
