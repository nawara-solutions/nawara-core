import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const PAYER = '1e0a7c5b-3d2f-4a6b-9c8d-7e6f5a4b3c21';

/**
 * ADR-0054 (Core V1 refactor R6.5): Payment's own error messages in en / fr / ar. Status, `code`, `error` and the ids never change with
 * the language; English without Accept-Language is the pre-R6.5 text; the payment status is a machine value, never translated; the two
 * messages that echo a client-sent value (currency, provider) stay English (D10, deferred); provider webhooks are excluded (D12);
 * code-less errors stay code-less; success bodies are unchanged and carry no language header.
 */
const SENTINELS = ['FAKE_PAYMENT_SECRET', 'SECRET_SOURCE_VALUE', 'payment-db.internal.example'];
const NEGOTIATION: [string | undefined, 'en' | 'fr' | 'ar'][] = [
  [undefined, 'en'], ['en', 'en'], ['fr', 'fr'], ['ar', 'ar'], ['fr-FR', 'fr'], ['ar-TN', 'ar'], ['de-DE', 'en'], [';;q=x', 'en'], ['fr;q=0, ar', 'ar'],
];
const noLeak = (r: request.Response) => {
  for (const s of SENTINELS) expect(r.text + JSON.stringify(r.headers)).not.toContain(s);
};

describeWithEnv('Payment error localization over real HTTP (R6.5)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const billing = generateServiceToken();
  const identities: Record<string, AuthIdentity> = { 'user-1-jwt': { id: PAYER, adminTier: null, isActive: true, memberships: [] } };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const server = () => t.app.getHttpServer();
  const body = (over: Record<string, unknown> = {}) => {
    const organizationId = crypto.randomUUID();
    return { paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: 'inv-1', payer: { type: 'user', id: PAYER }, seller: { type: 'organization', id: organizationId }, organizationId, amount: 1000, currency: 'TND', ...over };
  };
  const create = (b: Record<string, unknown>, l?: string) => {
    const r = request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`);
    return (l ? r.set('accept-language', l) : r).send(b);
  };
  const cancel = (id: string, l?: string) => {
    const r = request(server()).post(`/payment/payments/${id}/cancel`).set({ authorization: `Bearer ${billing.token}`, 'idempotency-key': `l10n-${crypto.randomUUID()}` });
    return l ? r.set('accept-language', l) : r;
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentl10n');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [{ caller: 'billing-service', digest: billing.digest }],
      authClient,
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      env: { PAYMENT_TEST_PROVIDER: 'true' },
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await db?.drop();
  });

  it.each(NEGOTIATION)('not_found (%s): code, status, error and ids identical; message and Content-Language follow', async (l, used) => {
    let r = request(server()).get(`/payment/payments/${crypto.randomUUID()}`).set({ authorization: `Bearer ${billing.token}`, 'x-correlation-id': 'corr-r65-0001' });
    if (l !== undefined) r = r.set('accept-language', l);
    const res = await r;
    const message = { en: 'Not found.', fr: 'Introuvable.', ar: 'غير موجود.' }[used];
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ statusCode: 404, message, error: 'Not Found', code: 'not_found', requestId: res.headers['x-request-id'] });
    expect(res.headers['content-language']).toBe(used);
    expect(res.headers.vary).toMatch(/Accept-Language/);
    expect(res.headers['x-correlation-id']).toBe('corr-r65-0001');
  });

  it('the payment status in a refusal is a machine value, identical in every language', async () => {
    const p = (await create(body()).expect(201)).body as { id: string };
    await cancel(p.id).expect(200);
    const texts = { en: 'Cannot cancel a payment in status cancelled.', fr: "Impossible d'annuler un paiement à l'état cancelled.", ar: 'لا يمكن إلغاء عملية دفع في الحالة cancelled.' };
    for (const l of ['en', 'fr', 'ar'] as const) {
      const r = await cancel(p.id, l).expect(409);
      expect(r.body).toEqual({ statusCode: 409, message: texts[l], error: 'Conflict', code: 'invalid_state_transition', requestId: r.headers['x-request-id'] });
    }
  });

  it('D10 (deferred): the messages that echo a client-sent value stay exactly English in every language', async () => {
    for (const l of ['en', 'fr', 'ar']) {
      const cur = await create(body({ currency: 'XYZ' }), l).expect(422);
      expect(cur.body).toEqual({ statusCode: 422, message: 'Currency XYZ is not supported.', error: 'Unprocessable Entity', code: 'unsupported_currency', requestId: cur.headers['x-request-id'] });
      expect(cur.headers['content-language']).toBe('en'); // the language actually rendered
      const p = (await create(body()).expect(201)).body as { id: string };
      const prov = await request(server()).post(`/payment/payments/${p.id}/attempts`)
        .set({ authorization: 'Bearer user-1-jwt', 'idempotency-key': `l10n-${crypto.randomUUID()}`, 'accept-language': l }).send({ provider: 'nope' });
      expect(prov.status).toBe(422);
      expect(prov.body).toMatchObject({ code: 'invalid_provider', message: 'Provider nope is not enabled.' });
      expect(prov.headers['content-language']).toBe('en');
    }
  });

  it('business checks keep their codes; field names stay verbatim; nothing submitted is echoed', async () => {
    const same = await create(body({ payer: { type: 'organization', id: 'SECRET_SOURCE_VALUE' }, seller: { type: 'organization', id: 'SECRET_SOURCE_VALUE' } }), 'fr').expect(400);
    expect(same.body).toMatchObject({ code: 'invalid_payment_request', message: 'payer et seller doivent être différents.' });
    noLeak(same);
    const p = (await create(body()).expect(201)).body as { id: string };
    const key = await request(server()).post(`/payment/payments/${p.id}/attempts`).set({ authorization: 'Bearer user-1-jwt', 'accept-language': 'ar' }).send({});
    expect(key.status).toBe(400);
    expect(key.body).toMatchObject({ code: 'idempotency_key_required', message: 'يلزم وجود ترويسة Idempotency-Key صالحة.' });
  });

  it('the shared caller-policy refusal (kit, ADR-0052) keeps operation_not_permitted; its kit message follows the language', async () => {
    const p = (await create(body()).expect(201)).body as { id: string };
    const r = await request(server()).post(`/payment/payments/${p.id}/attempts`)
      .set({ authorization: `Bearer ${billing.token}`, 'idempotency-key': `l10n-${crypto.randomUUID()}`, 'accept-language': 'fr' }).send({ provider: 'test' }).expect(403);
    expect(r.body).toMatchObject({ code: 'operation_not_permitted', message: "Cette opération n'est pas autorisée pour le service appelant." });
    expect(r.headers['content-language']).toBe('fr');
  });

  it('a provider-reported mismatch is a generic provider_error: localized, never the provider\'s values', async () => {
    const p = (await create(body()).expect(201)).body as { id: string };
    const start = await request(server()).post(`/payment/payments/${p.id}/attempts`)
      .set({ authorization: 'Bearer user-1-jwt', 'idempotency-key': `l10n-${crypto.randomUUID()}` }).send({ providerOptions: { scenario: 'success_amount_mismatch' } }).expect(201);
    const r = await request(server()).post(`/payment/payments/${p.id}/attempts/${start.body.id as string}/sync`).set({ authorization: 'Bearer user-1-jwt', 'accept-language': 'fr' }).send({});
    expect(r.status).toBe(502);
    expect(r.body).toEqual({
      statusCode: 502, message: "Le montant ou la devise indiqués par le prestataire ne correspondent pas à l'instantané du paiement.", error: 'Bad Gateway', code: 'provider_error', requestId: r.headers['x-request-id'],
    });
  });

  it('a code-less 401 (the kit guard) stays code-less; a bearer is never echoed', async () => {
    for (const [l, text] of [['en', 'Unauthorized'], ['fr', 'Authentification requise'], ['ar', 'المصادقة مطلوبة']]) {
      const r = await request(server()).get(`/payment/payments/${crypto.randomUUID()}`).set({ authorization: 'Bearer FAKE_PAYMENT_SECRET', 'accept-language': l! });
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ statusCode: 401, message: text, error: 'Unauthorized', requestId: r.headers['x-request-id'] });
      noLeak(r);
    }
  });

  it('provider webhooks are excluded (D12): the same body in every language and no Content-Language', async () => {
    const en = await request(server()).post('/payment/webhooks/nope').send({});
    const fr = await request(server()).post('/payment/webhooks/nope').set('accept-language', 'fr').send({});
    expect(fr.status).toBe(en.status);
    expect({ ...fr.body, requestId: undefined }).toEqual({ ...en.body, requestId: undefined });
    expect(fr.body.message).toBe('Not Found');
    expect(fr.headers['content-language']).toBeUndefined();
  });

  it('class-validator failures (R4): the same string[], validation_error, localized elements; values never echoed', async () => {
    const b = body({ currency: 'tnd', extra: 'SECRET_SOURCE_VALUE' });
    const en = await create(b).expect(400);
    const fr = await create(b, 'fr').expect(400);
    for (const r of [en, fr]) {
      expect(Array.isArray(r.body.message)).toBe(true);
      expect(r.body.code).toBe('validation_error');
      noLeak(r);
    }
    expect(fr.body.message).toHaveLength(en.body.message.length);
    expect(fr.body.message[en.body.message.indexOf('property extra should not exist')]).toBe('la propriété extra ne doit pas être présente');
  });

  it('success bodies are identical in every language and carry no language header', async () => {
    const p = (await create(body()).expect(201)).body as { id: string };
    const get = (l?: string) => {
      const r = request(server()).get(`/payment/payments/${p.id}`).set('authorization', `Bearer ${billing.token}`);
      return (l ? r.set('accept-language', l) : r).expect(200);
    };
    const [en, fr, ar] = [await get(), await get('fr'), await get('ar')];
    expect(fr.body).toEqual(en.body);
    expect(ar.body).toEqual(en.body);
    expect(fr.headers['content-language']).toBeUndefined();
  });
});
