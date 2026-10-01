import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

/**
 * ADR-0054 (Core V1 refactor R6.6): Billing's own error messages in en / fr / ar. Status, `code`, `error` and the ids never change with
 * the language; English without Accept-Language is the pre-R6.6 text; a status in a sentence is a machine value, never translated; a
 * property NAME may appear, its value never does; the snapshot-validation messages, which carry a client's JSON keys, stay English (D10,
 * deferred); code-less errors stay code-less; success bodies are unchanged and carry no language header.
 */
const SENTINELS = ['SECRET_BILLING_VALUE', 'FAKE_BILLING_SECRET', 'billing-db.internal.example'];
const NEGOTIATION: [string | undefined, 'en' | 'fr' | 'ar'][] = [
  [undefined, 'en'], ['en', 'en'], ['fr', 'fr'], ['ar', 'ar'], ['fr-FR', 'fr'], ['ar-TN', 'ar'], ['de-DE', 'en'], [';;q=x', 'en'], ['fr;q=0, ar', 'ar'],
];
const noLeak = (r: request.Response) => {
  for (const s of SENTINELS) expect(r.text + JSON.stringify(r.headers)).not.toContain(s);
};

describeWithEnv('Billing error localization over real HTTP (R6.6)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const producer = generateServiceToken();
  const authClient: AuthClient = { getIdentity: async () => null, hasPlatformAccess: async () => false };
  const http = () => t.app.getHttpServer();
  const post = (path: string, body: unknown, l?: string) => {
    const r = request(http()).post(path).set('authorization', `Bearer ${producer.token}`);
    return (l ? r.set('accept-language', l) : r).send(body as object);
  };
  const get = (path: string, l?: string) => {
    const r = request(http()).get(path).set('authorization', `Bearer ${producer.token}`);
    return l ? r.set('accept-language', l) : r;
  };
  let seq = 0;
  const seedPrice = async () => {
    seq += 1;
    const sellerId = crypto.randomUUID();
    const product = await post('/billing/products', { seller: { type: 'organization', id: sellerId }, code: `l10n-${seq}`, name: `Product ${seq}` }).expect(201);
    const price = await post('/billing/prices', { productId: product.body.id, clientReference: `l10n-${seq}`, currency: 'TND', unitAmount: 1500, interval: 'one_time', effectiveFrom: new Date().toISOString() }).expect(201);
    return { sellerId, priceId: price.body.id as string };
  };
  const invoiceBody = (p: { sellerId: string; priceId: string }, over: Record<string, unknown> = {}) => ({
    invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: p.sellerId }, payer: { type: 'user', id: '1a1a1a1a-0000-4000-8000-000000000001' },
    sourceType: 'contract', sourceId: `src-${++seq}`, issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: p.priceId, quantity: 2 }], ...over,
  });

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingl10n');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens: [{ caller: 'test-producer', digest: producer.digest }], authClient });
  });
  afterAll(async () => {
    await t?.app.close();
    await db?.drop();
  });

  it.each(NEGOTIATION)('not_found (%s): code, status, error and ids identical; message and Content-Language follow', async (l, used) => {
    const res = await get(`/billing/invoices/${crypto.randomUUID()}`, l).set('x-correlation-id', 'corr-r66-0001');
    const message = { en: 'Not found.', fr: 'Introuvable.', ar: 'غير موجود.' }[used];
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ statusCode: 404, message, error: 'Not Found', code: 'not_found', requestId: res.headers['x-request-id'] });
    expect(res.headers['content-language']).toBe(used);
    expect(res.headers.vary).toMatch(/Accept-Language/);
    expect(res.headers['x-correlation-id']).toBe('corr-r66-0001');
  });

  it('the invoice status in a refusal is a machine value, identical in every language', async () => {
    const inv = await post('/billing/invoices', invoiceBody(await seedPrice())).expect(201);
    await post(`/billing/invoices/${inv.body.id as string}/issue`, {}).expect(200);
    const texts = { en: 'An invoice that is open cannot be discarded.', fr: "Une facture à l'état open ne peut pas être abandonnée.", ar: 'لا يمكن تجاهل فاتورة في الحالة open.' };
    for (const l of ['en', 'fr', 'ar'] as const) {
      const r = await post(`/billing/invoices/${inv.body.id as string}/discard`, {}, l).expect(409);
      expect(r.body).toEqual({ statusCode: 409, message: texts[l], error: 'Conflict', code: 'invalid_state_transition', requestId: r.headers['x-request-id'] });
    }
  });

  it('manual validation: field paths and server limits stay verbatim; a property NAME may appear, never its value', async () => {
    const p = await seedPrice();
    const qty = await post('/billing/invoices', invoiceBody(p, { lines: [{ priceId: p.priceId, quantity: 0 }] }), 'fr').expect(400);
    expect(qty.body).toMatchObject({ code: 'invalid_invoice_request' });
    expect(qty.body.message).toMatch(/^lines\[0\]\.quantity doit être un entier compris entre 1 et \d+$/);
    const unknown = await post('/billing/products', { seller: { type: 'organization', id: crypto.randomUUID() }, code: 'l10n-x', name: 'X', extraField: 'SECRET_BILLING_VALUE' }, 'ar').expect(400);
    expect(unknown.body).toEqual({ statusCode: 400, message: 'حقل غير معروف: extraField', error: 'Bad Request', code: 'invalid_product_request', requestId: unknown.headers['x-request-id'] });
    noLeak(unknown);
    const en = await post('/billing/products', { seller: { type: 'organization', id: crypto.randomUUID() }, code: 'l10n-y', name: 'Y', extraField: 1 }).expect(400);
    expect(en.body.message).toBe('unknown field: extraField');
  });

  it('D10 (deferred): a snapshot-validation message carries a client JSON key, so it stays exactly English in every language', async () => {
    const p = await seedPrice();
    for (const l of ['en', 'fr', 'ar']) {
      const r = await post('/billing/invoices', invoiceBody(p, { issuerSnapshot: { schemaVersion: 1, clientKey: 'x'.repeat(5000) } }), l).expect(400);
      expect(r.body.code).toBe('invalid_invoice_request');
      expect(r.body.message).toMatch(/^issuerSnapshot\.clientKey is longer than \d+ characters$/);
      expect(r.headers['content-language']).toBe('en'); // the language actually rendered
    }
  });

  it('pagination errors stay code-less; their message follows the language', async () => {
    const texts = { en: 'limit must be an integer from 1 to 100', fr: 'limit doit être un entier compris entre 1 et 100', ar: 'يجب أن تكون قيمة limit عددًا صحيحًا من 1 إلى 100' };
    for (const l of ['en', 'fr', 'ar'] as const) {
      const r = await get('/billing/invoices?limit=0', l).expect(400);
      expect(r.body).toEqual({ statusCode: 400, message: texts[l], error: 'Bad Request', requestId: r.headers['x-request-id'] });
      expect(r.headers['content-language']).toBe(l);
    }
    const cursor = await get('/billing/invoices?cursor=SECRET_BILLING_VALUE!', 'fr').expect(400);
    expect(cursor.body).toEqual({ statusCode: 400, message: "cursor n'est pas valide", error: 'Bad Request', requestId: cursor.headers['x-request-id'] });
    noLeak(cursor);
  });

  it('a code-less 401 (the kit guard) stays code-less; a bearer is never echoed', async () => {
    for (const [l, text] of [['en', 'Unauthorized'], ['fr', 'Authentification requise'], ['ar', 'المصادقة مطلوبة']]) {
      const r = await request(http()).get('/billing/invoices').set({ authorization: 'Bearer FAKE_BILLING_SECRET', 'accept-language': l! });
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ statusCode: 401, message: text, error: 'Unauthorized', requestId: r.headers['x-request-id'] });
      noLeak(r);
    }
  });

  it('success bodies are identical in every language and carry no language header', async () => {
    const inv = await post('/billing/invoices', invoiceBody(await seedPrice())).expect(201);
    const [en, fr, ar] = [await get(`/billing/invoices/${inv.body.id as string}`).expect(200), await get(`/billing/invoices/${inv.body.id as string}`, 'fr').expect(200), await get(`/billing/invoices/${inv.body.id as string}`, 'ar').expect(200)];
    expect(fr.body).toEqual(en.body);
    expect(ar.body).toEqual(en.body);
    expect(fr.headers['content-language']).toBeUndefined();
  });
});
