import { Controller, Get, HttpException, Module, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JsonLogger, requestContextMiddleware } from '@nawara/service-kit';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthExceptionFilter, authError } from '../src/errors.js';
import { createTestApp, type TestCtx } from './helpers/app.js';

/**
 * ADR-0054 (Core V1 refactor R5): Auth's error messages in en / fr / ar. `code`, `reason`, `statusCode`, `error` and the ids never change
 * with the language; English without Accept-Language is byte-for-byte the pre-R5 text; health, WebAuthn protocol values and success
 * bodies are untouched; nothing a client sent or a failure carried leaks.
 */
const uniq = () => Math.random().toString(36).slice(2);
const WED_1630 = new Date('2026-03-04T16:30:00Z');
const SENTINELS = ['password=DO_NOT_LEAK', 'Bearer FAKE_SECRET', 'db.internal.example', '/srv/private/auth-secret', 'TOTP_SECRET_DO_NOT_LEAK', 'RECOVERY_CODE_DO_NOT_LEAK'];
// [Accept-Language, expected Content-Language]
const NEGOTIATION: [string | undefined, 'en' | 'fr' | 'ar'][] = [
  [undefined, 'en'], ['en', 'en'], ['fr', 'fr'], ['ar', 'ar'], ['fr-FR', 'fr'], ['ar-TN', 'ar'], ['de-DE', 'en'], [';;q=x', 'en'],
];

describe('Auth error localization over real HTTP (R5)', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0);
    w = await t.world();
  });
  afterAll(() => t.close());
  const lang = <T extends { set(k: string, v: string): T }>(r: T, l: string | undefined): T => (l === undefined ? r : r.set('accept-language', l));

  it.each(NEGOTIATION)('Auth domain validation (%s): code, status, error and ids identical; message and Content-Language follow the language', async (l, used) => {
    const r = await lang(t.http.post('/auth/login').set('x-correlation-id', 'corr-r5-0001'), l).send({ password: 'x' });
    const message = { en: 'Provide exactly one of email or phone.', fr: 'Indiquez soit une adresse e-mail, soit un numéro de téléphone, mais pas les deux.', ar: 'أدخل إما البريد الإلكتروني أو رقم الهاتف، وليس كليهما.' }[used];
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ statusCode: 400, message, error: 'Bad Request', code: 'validation_error', requestId: r.headers['x-request-id'] });
    expect(r.headers['content-language']).toBe(used);
    expect(r.headers.vary).toMatch(/Accept-Language/);
    expect(r.headers['x-correlation-id']).toBe('corr-r5-0001');
  });

  it('invalid credentials: the deliberately generic message stays generic in every language; no submitted secret is echoed', async () => {
    const member = await t.member(w.orgSchool1, `m${uniq()}@a.test`);
    const texts = { en: 'Invalid credentials.', fr: 'Identifiants invalides.', ar: 'بيانات الاعتماد غير صالحة.' };
    for (const l of ['en', 'fr', 'ar'] as const) {
      const r = await t.http.post('/auth/login').set('accept-language', l).set('authorization', 'Bearer FAKE_SECRET')
        .send({ email: member.email, password: 'password=DO_NOT_LEAK RECOVERY_CODE_DO_NOT_LEAK' });
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ statusCode: 401, message: texts[l], error: 'Unauthorized', code: 'invalid_credentials', requestId: r.headers['x-request-id'] });
      for (const s of SENTINELS) expect(r.text + JSON.stringify(r.headers)).not.toContain(s);
    }
  });

  it('a bare generic 401 keeps its code; its status phrase is the kit\'s generic text', async () => {
    const en = await t.http.get('/auth/admin/factors').expect(401);
    expect(en.body).toMatchObject({ message: 'Unauthorized', code: 'unauthenticated' });
    const fr = await t.http.get('/auth/admin/factors').set('accept-language', 'fr').expect(401);
    expect(fr.body).toEqual({ statusCode: 401, message: 'Authentification requise', error: 'Unauthorized', code: 'unauthenticated', requestId: fr.headers['x-request-id'] });
  });

  it('an invalid bearer gets Auth\'s own invalid_token message in the language asked, never an echo of the token', async () => {
    for (const [l, text] of [['en', 'Invalid or expired token.'], ['fr', 'Jeton invalide ou expiré.'], ['ar', 'الرمز غير صالح أو منتهي الصلاحية.']]) {
      const r = await t.http.get('/auth/admin/factors').set('accept-language', l).set('authorization', 'Bearer FAKE_SECRET').expect(401);
      expect(r.body).toEqual({ statusCode: 401, message: text, error: 'Unauthorized', code: 'invalid_token', requestId: r.headers['x-request-id'] });
      expect(r.text + JSON.stringify(r.headers)).not.toContain('FAKE_SECRET');
    }
  });

  it('class-validator failures (D11): the same string[], same order, validation_error; English as before', async () => {
    const body = { email: 'not-an-email', password: 5, extra: 'db.internal.example' };
    const en = await t.http.post('/auth/login').send(body).expect(400);
    const fr = await t.http.post('/auth/login').set('accept-language', 'fr').send(body).expect(400);
    const ar = await t.http.post('/auth/login').set('accept-language', 'ar').send(body).expect(400);
    for (const r of [en, fr, ar]) {
      expect(Array.isArray(r.body.message)).toBe(true);
      expect(r.body).toMatchObject({ statusCode: 400, error: 'Bad Request', code: 'validation_error' });
      expect(r.text).not.toContain('db.internal.example');
    }
    expect(fr.body.message).toHaveLength(en.body.message.length);
    expect(ar.body.message).toHaveLength(en.body.message.length);
    for (const [e, f] of [
      ['property extra should not exist', 'la propriété extra ne doit pas être présente'],
      ['email must be an email', 'email doit être une adresse e-mail'],
      ['password must be a string', 'password doit être une chaîne de caractères'],
    ]) {
      const i = en.body.message.indexOf(e);
      expect(i, e).toBeGreaterThanOrEqual(0);
      expect(fr.body.message[i]).toBe(f);
    }
  });

  it('the session-ceiling 401 keeps `reason` and `code` untranslated, in place; only the message changes', async () => {
    // the operator spec's shift-ceiling flow, once per language, step by step
    t.clock.set(WED_1630);
    const ops: { l: string; tk: { refreshToken: string } }[] = [];
    for (const l of ['en', 'fr', 'ar']) {
      const op = await t.operator(w.companyA, `ceil${l}${uniq()}@a.test`);
      await t.db.query(`INSERT INTO operator_schedule("userId","dayOfWeek","startTime","endTime") VALUES ($1,3,'08:00','17:00')`, [op.id]);
      ops.push({ l, tk: await t.operatorLogin(op.email) });
    }
    t.clock.advance(10 * 60 * 1000);
    const refreshed: { l: string; r1: { refreshToken: string } }[] = [];
    for (const o of ops) refreshed.push({ l: o.l, r1: (await t.http.post('/auth/refresh').send({ refreshToken: o.tk.refreshToken }).expect(200)).body });
    t.clock.advance(21 * 60 * 1000);
    const texts: Record<string, string> = {
      en: 'Your session has ended. Please request a new login code to continue.',
      fr: 'Votre session est terminée. Veuillez demander un nouveau code de connexion pour continuer.',
      ar: 'انتهت جلستك. يرجى طلب رمز تسجيل دخول جديد للمتابعة.',
    };
    for (const { l, r1 } of refreshed) {
      const r = await t.http.post('/auth/refresh').set('accept-language', l).send({ refreshToken: r1.refreshToken });
      expect(r.status).toBe(401);
      expect(Object.keys(r.body)).toEqual(['statusCode', 'message', 'error', 'code', 'reason', 'requestId']); // pre-R5 key order
      expect(r.body).toEqual({ statusCode: 401, message: texts[l], error: 'Unauthorized', code: 'session_ceiling_reached', reason: 'session_ceiling_reached', requestId: r.headers['x-request-id'] });
      expect(r.headers['content-language']).toBe(l);
    }
  });

  it('/auth/health is byte-identical and carries no language header, whatever the request asks', async () => {
    for (const l of [undefined, 'fr', 'ar']) {
      const r = await lang(t.http.get('/auth/health'), l).expect(200);
      expect(r.text).toBe('{"status":"ok"}');
      expect(r.headers['content-language']).toBeUndefined();
    }
  });

  it('WebAuthn protocol values and success bodies are untouched by the language', async () => {
    const o = await t.owner(await t.newCompany(), `pk${uniq()}@a.test`);
    const login = await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
    const en = await t.http.post('/auth/admin/enroll/webauthn/options').send({ enrollmentToken: login.body.enrollmentToken }).expect(200);
    const fr = await t.http.post('/auth/admin/enroll/webauthn/options').set('accept-language', 'fr').send({ enrollmentToken: login.body.enrollmentToken }).expect(200);
    expect(fr.body.options.rp).toEqual(en.body.options.rp);
    expect(Object.keys(fr.body.options).sort()).toEqual(Object.keys(en.body.options).sort());
    expect(fr.headers['content-language']).toBeUndefined();
  });

  it('body parser: malformed JSON keeps its pre-R5 pass-through (code-less, English); a too-large body gets the generic localized text, no code', async () => {
    const bad = await t.http.post('/auth/login').set('accept-language', 'fr').set('content-type', 'application/json').send('{"email": ');
    expect(bad.status).toBe(400);
    expect(bad.body).not.toHaveProperty('code');
    expect(bad.headers['content-language']).toBe('en');
    const big = await t.http.post('/auth/login').set('accept-language', 'fr').send({ password: 'x'.repeat(200 * 1024) });
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ statusCode: 413, message: 'Contenu trop volumineux', error: 'Payload Too Large', requestId: big.headers['x-request-id'] });
  });
});

@Controller('r5')
class R5Probe {
  @Get('boom') boom() {
    throw new Error('connect ECONNREFUSED db.internal.example:5432 password=DO_NOT_LEAK /srv/private/auth-secret TOTP_SECRET_DO_NOT_LEAK');
  }
  @Get('enrolled') enrolled() {
    throw authError(403, 'factor_already_enrolled', 'Forbidden');
  }
  @Get('plain') plain() {
    throw authError(400, 'validation_error', 'A message not adopted yet.');
  }
  @Get('codeless') codeless() {
    throw new HttpException('Unauthorized', 401);
  }
}
@Module({ controllers: [R5Probe as Type<unknown>] })
class R5ProbeModule {}

describe('AuthExceptionFilter (R5): opaque failures, preserved codes, English fallback', () => {
  const logs: string[] = [];
  let server: Parameters<typeof request>[0];
  let close: () => Promise<void>;
  beforeAll(async () => {
    const app = (await Test.createTestingModule({ imports: [R5ProbeModule] }).compile()).createNestApplication({ logger: false });
    app.use(requestContextMiddleware);
    app.useGlobalFilters(new AuthExceptionFilter(new JsonLogger('auth-service', 'info', (l) => logs.push(l))));
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer();
    close = () => app.close();
  });
  afterAll(() => close());

  it.each(['en', 'fr', 'ar'])('%s: an unexpected failure is an opaque, localized, code-less 500; no sentinel in body, headers or log', async (l) => {
    logs.length = 0;
    const r = await request(server).get('/r5/boom').set('accept-language', l).expect(500);
    expect(r.body).not.toHaveProperty('code');
    expect(r.body.message).toBe({ en: 'Internal server error', fr: 'Erreur interne du serveur', ar: 'خطأ داخلي في الخادم' }[l]);
    for (const s of SENTINELS) expect(r.text + JSON.stringify(r.headers) + logs.join('\n')).not.toContain(s);
  });

  it('an explicit Auth code is preserved exactly in every language', async () => {
    for (const [l, text] of [['en', 'Forbidden'], ['fr', 'Accès refusé'], ['ar', 'الوصول مرفوض']]) {
      const r = await request(server).get('/r5/enrolled').set('accept-language', l).expect(403);
      expect(r.body).toEqual({ statusCode: 403, message: text, error: 'Forbidden', code: 'factor_already_enrolled', requestId: r.headers['x-request-id'] });
    }
  });

  it('a code-less error stays code-less; a message without a catalog entry stays English and says so', async () => {
    const codeless = await request(server).get('/r5/codeless').set('accept-language', 'fr').expect(401);
    expect(codeless.body).not.toHaveProperty('code');
    const plain = await request(server).get('/r5/plain').set('accept-language', 'ar').expect(400);
    expect(plain.body).toMatchObject({ message: 'A message not adopted yet.', code: 'validation_error' });
    expect(plain.headers['content-language']).toBe('en');
  });
});
