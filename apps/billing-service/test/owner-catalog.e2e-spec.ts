import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpAuthClient, generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { BILLING_OPERATIONS } from '../src/admission/caller-admission.policy.js';
import { billingMigrationsDir } from '../src/app.module.js';
import { HttpOwnerAuthority } from '../src/platforms/owner-authority.client.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { FakeAuth } from './support/fake-auth.js';

type Row = Record<string, any>;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();
const MEMBER = randomUUID();
const AUTH_TIMEOUT_MS = 800;
/** The test Platforms, known up front so the producer's policy can name them. */
const POOL = Array.from({ length: 80 }, () => randomUUID());
let next = 0;

/**
 * Core V2 S3g (register BIL-02, BIL-03; the Owner's decisions D-CAT-1 to D-CAT-10): the Owner's catalog administration through the REAL
 * application on real PostgreSQL 16, with the REAL hardened Auth client against a stub of exactly Auth's approved routes (`/auth/grants`,
 * `/auth/platform-access/:platformId`, `/auth/me`). No catalog VALUE here is a commercial decision (OD-05): codes, names, periods and
 * amounts are test fixtures only.
 */
describeWithEnv('Owner catalog administration (Core V2 S3g) — real PostgreSQL, live Auth', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const auth = new FakeAuth();
  const producer = generateServiceToken();
  const server = () => t.app.getHttpServer();
  const B = { owner: 'owner-session-1', owner2: 'owner-session-2', otherOwner: 'other-owner', operator: 'operator-1', member: 'member-1' };

  // ── fixtures
  const platform = async (o: { company?: string; configured?: boolean; currency?: string } = {}) => {
    const id = POOL[next++]!;
    auth.platforms.set(id, o.company ?? COMPANY);
    if (o.configured !== false) {
      await admin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, $3, $4)`, [id, o.company ?? COMPANY, o.currency ?? 'TND', OWNER]);
    }
    return id;
  };
  let seq = 0;
  const code = () => `plan-${++seq}-${randomUUID().slice(0, 6)}`;
  const monthly = (over: Row = {}) => ({ clientReference: `ref-${++seq}`, unitAmount: 900, intervalUnit: 'month', intervalCount: 1, effectiveFrom: '2020-01-01T00:00:00Z', ...over });

  // ── HTTP
  const as = (bearer: string | null) => (r: request.Test) => (bearer ? r.set('authorization', `Bearer ${bearer}`) : r);
  const createProduct = (p: string, body: unknown, bearer: string | null = B.owner) => as(bearer)(request(server()).post(`/billing/admin/platforms/${p}/products`)).send(body as object);
  const createPrice = (p: string, productId: string, body: unknown, bearer: string | null = B.owner) =>
    as(bearer)(request(server()).post(`/billing/admin/platforms/${p}/products/${productId}/prices`)).send(body as object);
  const archive = (p: string, productId: string, bearer: string | null = B.owner) => as(bearer)(request(server()).post(`/billing/admin/platforms/${p}/products/${productId}/archive`)).send();
  const retire = (p: string, priceId: string, bearer: string | null = B.owner) => as(bearer)(request(server()).post(`/billing/admin/platforms/${p}/prices/${priceId}/retire`)).send();
  const list = (p: string, bearer: string | null = B.owner) => as(bearer)(request(server()).get(`/billing/admin/platforms/${p}/products`));
  const svc = (method: 'get' | 'post', path: string, body?: unknown) => request(server())[method](path).set('authorization', `Bearer ${producer.token}`).send(body as object);
  const checkout = (body: unknown, idem = `co-${randomUUID()}`) =>
    request(server()).post('/billing/checkout/direct').set('authorization', `Bearer ${B.member}`).set('idempotency-key', idem).send(body as object);
  /** An Owner product with one monthly price, through the Owner routes. */
  const offering = async (p: string) => {
    const prod = await createProduct(p, { code: code(), name: 'Plan' });
    expect(prod.status, JSON.stringify(prod.body)).toBe(201);
    const price = await createPrice(p, prod.body.id, monthly());
    expect(price.status, JSON.stringify(price.body)).toBe(201);
    return { platformId: p, productId: prod.body.id as string, priceId: price.body.id as string };
  };

  // ── database
  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).count);
  const audit = async (resourceId: string) =>
    (await admin.query(`SELECT name, payload FROM outbox WHERE name LIKE 'audit.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", name`, [resourceId])).rows as Row[];
  const catalogCount = async () => count(`SELECT (SELECT count(*) FROM product) + (SELECT count(*) FROM price) AS count`);

  beforeAll(async () => {
    await auth.start();
    auth.identities.set(B.owner, { userId: OWNER, kind: 'owner', companyId: COMPANY.toUpperCase() });
    auth.identities.set(B.owner2, { userId: OWNER, kind: 'owner', companyId: COMPANY });
    auth.identities.set(B.otherOwner, { userId: OTHER_OWNER, kind: 'owner', companyId: OTHER_COMPANY });
    auth.identities.set(B.operator, { userId: randomUUID(), kind: 'operator', companyId: null });
    auth.identities.set(B.member, { userId: MEMBER, kind: 'member', companyId: null });
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings3g');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
    await admin.query(`INSERT INTO currency (code, exponent) VALUES ('EUR', 2), ('USD', 2) ON CONFLICT DO NOTHING`); // this database only
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [{ caller: 'test-producer', digest: producer.digest }],
      authClient: new HttpAuthClient({ baseUrl: auth.url, timeoutMs: AUTH_TIMEOUT_MS }),
      ownerAuthority: new HttpOwnerAuthority({ baseUrl: auth.url }),
      env: {
        AUTH_TIMEOUT_MS: String(AUTH_TIMEOUT_MS),
        BILLING_SUPPORTED_CURRENCIES: 'TND,EUR',
        BILLING_SERVICE_POLICY: JSON.stringify({ callers: { 'test-producer': { operations: [...BILLING_OPERATIONS], allowedPlatforms: POOL } } }),
      },
    });
  });
  afterEach(() => auth.reset());
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
    await auth.stop();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── products (BIL-02)

  describe('products', () => {
    it('201: a personal product of THIS Platform sold by its Company reference, Owner provenance; live Auth checks in order; the Owner is the audited actor', async () => {
      const p = await platform();
      const c = code();
      const r = await createProduct(p, { code: c, name: 'Plan A', description: 'A plan', entitlementKind: 'user_subscription' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body).toMatchObject({ seller: { type: 'company', id: COMPANY }, code: c, name: 'Plan A', description: 'A plan', entitlementKind: 'user_subscription',
        subscriptionTarget: 'personal', platformId: p, status: 'active', revision: 0 });
      expect(r.body).not.toHaveProperty('producer');
      expect(await one(`SELECT producer FROM product WHERE id = $1`, [r.body.id])).toEqual({ producer: 'billing-owner' });
      expect(auth.received.map((x) => x.path)).toEqual(['/auth/grants', `/auth/platform-access/${p}`]);
      expect(auth.received.every((x) => x.authorization === `Bearer ${B.owner}`)).toBe(true);
      expect((await audit(r.body.id)).map((x) => [x.name, x.payload])).toEqual([['audit.product.created', {
        action: 'product.created', actor: { type: 'user', id: OWNER, userKind: 'owner' }, organizationId: null, resource: { type: 'product', id: r.body.id }, outcome: 'succeeded',
      }]]);
    });

    it('the body can name no seller, Platform, target, producer or status (400 invalid_product_request); field rules are the producer route\'s; nothing is written', async () => {
      const p = await platform();
      const before = await catalogCount();
      for (const extra of [{ seller: { type: 'company', id: OTHER_COMPANY } }, { platformId: POOL[79] }, { subscriptionTarget: 'organization' }, { producer: 'test-producer' }, { status: 'archived' }, { id: randomUUID() }]) {
        const r = await createProduct(p, { code: code(), name: 'Plan', ...extra });
        expect([r.status, r.body.code], JSON.stringify(extra)).toEqual([400, 'invalid_product_request']);
      }
      for (const body of [{ code: 'Bad Code', name: 'Plan' }, { code: code(), name: ' ' }, { code: code(), name: 'x'.repeat(141) }, { code: code(), name: 'P', entitlementKind: 'gold' }, { name: 'P' }, [], 'x']) {
        expect((await createProduct(p, body)).body.code, JSON.stringify(body)).toBe('invalid_product_request');
      }
      expect(await catalogCount()).toBe(before);
    });

    it('identical repeat → 200 Idempotent-Replayed from any Owner session; other content for the (Company, code) → 409 product_conflict; nothing changes', async () => {
      const p = await platform();
      const p2 = await platform();
      const body = { code: code(), name: 'Plan', description: 'd' };
      const first = await createProduct(p, body);
      const again = await createProduct(p, body, B.owner2);
      expect([again.status, again.headers['idempotent-replayed']]).toEqual([200, 'true']);
      expect(again.body).toEqual(first.body);
      for (const other of [{ ...body, name: 'Other' }, { ...body, description: null }, { ...body, entitlementKind: 'user_subscription' }]) {
        expect([(await createProduct(p, other)).status, (await createProduct(p, other)).body.code]).toEqual([409, 'product_conflict']);
      }
      // D-CAT-10: the code is the Company's, across its Platforms: the same code on another Platform of the Company is a conflict, not a copy
      expect((await createProduct(p2, body)).body.code).toBe('product_conflict');
      expect(await count(`SELECT count(*) FROM product WHERE code = $1`, [body.code])).toBe(1);
      expect(await audit(first.body.id)).toHaveLength(1);
    });

    it('a producer\'s product under the same Company reference and code is never adopted: 409 product_conflict', async () => {
      const p = await platform();
      const c = code();
      expect((await svc('post', '/billing/products', { seller: { type: 'company', id: COMPANY }, code: c, name: 'Plan', subscriptionTarget: 'personal', platformId: p })).status).toBe(201);
      expect((await createProduct(p, { code: c, name: 'Plan' })).body.code).toBe('product_conflict');
    });

    it('several Personal products on one Platform, and differentiated products per Platform (each its own)', async () => {
      const p = await platform();
      const q = await platform();
      const a = await offering(p);
      const b = await offering(p);
      const c = await offering(q);
      expect(new Set([a.productId, b.productId, c.productId]).size).toBe(3);
      expect((await list(p)).body.products.map((x: Row) => x.id)).toEqual([a.productId, b.productId]);
      expect((await list(q)).body.products.map((x: Row) => x.id)).toEqual([c.productId]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── prices (BIL-03, D-CAT-6)

  describe('prices', () => {
    it('201: a recurring price in the Platform\'s currency (never the body\'s); the Owner is the audited actor', async () => {
      const p = await platform({ currency: 'EUR' });
      const prod = await createProduct(p, { code: code(), name: 'Plan' });
      const r = await createPrice(p, prod.body.id, monthly({ unitAmount: 1250, intervalUnit: 'year', intervalCount: 1 }));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ productId: prod.body.id, currency: 'EUR', unitAmount: 1250, interval: 'recurring', intervalUnit: 'year', intervalCount: 1, pricingModel: 'flat', retiredAt: null });
      expect((await audit(r.body.id)).map((x) => x.payload)).toEqual([{ action: 'price.created', actor: { type: 'user', id: OWNER, userKind: 'owner' }, organizationId: null,
        resource: { type: 'price', id: r.body.id }, outcome: 'succeeded', changes: { product_id: prod.body.id } }]);
    });

    it('the body can name no currency, interval, product, model or state (400 invalid_price_request); field rules are the producer route\'s', async () => {
      const p = await platform();
      const { productId } = await offering(p);
      const before = await catalogCount();
      for (const extra of [{ currency: 'TND' }, { interval: 'one_time' }, { productId }, { pricingModel: 'flat' }, { retiredAt: null }, { revision: 0 }]) {
        expect((await createPrice(p, productId, monthly(extra))).body.code, JSON.stringify(extra)).toBe('invalid_price_request');
      }
      for (const over of [{ unitAmount: 0 }, { unitAmount: 1.5 }, { unitAmount: 2 ** 53 }, { intervalUnit: 'fortnight' }, { intervalCount: 0 }, { effectiveFrom: '2020-01-01' }, { clientReference: 'bad ref' }]) {
        expect((await createPrice(p, productId, monthly(over))).body.code, JSON.stringify(over)).toBe('invalid_price_request');
      }
      expect(await catalogCount()).toBe(before);
    });

    it('several prices coexist on one product: monthly, yearly, another amount and a future-dated successor; each sells by its own id', async () => {
      const p = await platform();
      const o = await offering(p);
      const yearly = await createPrice(p, o.productId, monthly({ intervalUnit: 'year', unitAmount: 9000 }));
      const second = await createPrice(p, o.productId, monthly({ unitAmount: 990 }));
      const future = await createPrice(p, o.productId, monthly({ unitAmount: 1100, effectiveFrom: '2099-01-01T00:00:00Z' }));
      expect([yearly.status, second.status, future.status]).toEqual([201, 201, 201]);
      const listed = (await list(p)).body.products[0];
      expect(listed.prices.map((x: Row) => x.id)).toEqual([o.priceId, yearly.body.id, second.body.id, future.body.id]);
      expect((await checkout({ ...o, priceId: yearly.body.id })).status).toBe(201);
      expect((await checkout({ ...o, priceId: future.body.id }, `co-${randomUUID()}`)).body.code).toBe('price_not_available'); // not yet effective
    });

    it('identical repeat → 200 Idempotent-Replayed; other terms for the (product, clientReference) → 409 price_conflict; nothing changes', async () => {
      const p = await platform();
      const { productId } = await offering(p);
      const body = monthly();
      const first = await createPrice(p, productId, body);
      const again = await createPrice(p, productId, body, B.owner2);
      expect([again.status, again.headers['idempotent-replayed'], again.body]).toEqual([200, 'true', first.body]);
      for (const over of [{ unitAmount: 901 }, { intervalUnit: 'year' }, { intervalCount: 2 }, { effectiveFrom: '2021-01-01T00:00:00Z' }]) {
        expect((await createPrice(p, productId, { ...body, ...over })).body.code, JSON.stringify(over)).toBe('price_conflict');
      }
      expect(await count(`SELECT count(*) FROM price WHERE "productId" = $1 AND "clientReference" = $2`, [productId, body.clientReference])).toBe(1);
      expect(await audit(first.body.id)).toHaveLength(1);
    });

    it('a deployment that no longer supports the Platform\'s currency sells nothing new in it: 422 unsupported_currency', async () => {
      const p = await platform({ currency: 'USD' }); // configured earlier; this deployment supports TND and EUR
      const prod = await createProduct(p, { code: code(), name: 'Plan' });
      expect((await createPrice(p, prod.body.id, monthly())).body.code).toBe('unsupported_currency');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── retire and archive (D-CAT-7)

  describe('retire and archive', () => {
    it('retire: 200 with retiredAt set once; a repeat is 200 Idempotent-Replayed with the same instant; audited once; no new sale on it, the product\'s other prices still sell', async () => {
      const p = await platform();
      const o = await offering(p);
      const other = await createPrice(p, o.productId, monthly({ intervalUnit: 'year' }));
      const r = await retire(p, o.priceId);
      expect([r.status, r.headers['idempotent-replayed']]).toEqual([200, undefined]);
      expect(r.body.retiredAt).not.toBeNull();
      const again = await retire(p, o.priceId, B.owner2);
      expect([again.status, again.headers['idempotent-replayed'], again.body.retiredAt]).toEqual([200, 'true', r.body.retiredAt]);
      expect((await audit(o.priceId)).map((x) => x.name)).toEqual(['audit.price.created', 'audit.price.retired']);
      expect((await audit(o.priceId))[1]!.payload.actor).toEqual({ type: 'user', id: OWNER, userKind: 'owner' });
      expect((await checkout(o)).body.code).toBe('price_not_available');
      expect((await checkout({ ...o, priceId: other.body.id })).status).toBe(201);
    });

    it('archive: 200 archived, one way; a repeat is 200 Idempotent-Replayed; audited once; none of its prices sells any more', async () => {
      const p = await platform();
      const o = await offering(p);
      const r = await archive(p, o.productId);
      expect([r.status, r.body.status, r.body.revision]).toEqual([200, 'archived', 1]);
      const again = await archive(p, o.productId);
      expect([again.status, again.headers['idempotent-replayed'], again.body]).toEqual([200, 'true', r.body]);
      expect((await audit(o.productId)).map((x) => x.name)).toEqual(['audit.product.created', 'audit.product.archived']);
      expect((await checkout(o)).body.code).toBe('product_not_available');
    });

    it('an open checkout invoice and its payment request are untouched by a later retire and archive (no invoice fact is rewritten)', async () => {
      const p = await platform();
      const o = await offering(p);
      const c = await checkout(o);
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      const snapshot = async () => ({
        invoice: await one(`SELECT status, total, currency, revision, "issuerSnapshot", "billToSnapshot" FROM invoice WHERE id = $1`, [c.body.invoiceId]),
        lines: (await admin.query(`SELECT * FROM invoice_line WHERE "invoiceId" = $1`, [c.body.invoiceId])).rows,
        request: await one(`SELECT status, amount, revision FROM payment_request WHERE id = $1`, [c.body.paymentRequestId]),
        routing: (await admin.query(`SELECT * FROM invoice_entitlement WHERE "invoiceId" = $1`, [c.body.invoiceId])).rows,
      });
      const before = await snapshot();
      expect((await retire(p, o.priceId)).status).toBe(200);
      expect((await archive(p, o.productId)).status).toBe(200);
      expect(await snapshot()).toEqual(before);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── isolation and non-disclosure

  describe('Company, Platform and producer isolation (one 404)', () => {
    it('another Company\'s Owner: its Platform is the collapsed 404 on every route; nothing is written', async () => {
      const p = await platform();
      const o = await offering(p);
      const before = await catalogCount();
      const answers = [
        await createProduct(p, { code: code(), name: 'X' }, B.otherOwner), await createPrice(p, o.productId, monthly(), B.otherOwner),
        await archive(p, o.productId, B.otherOwner), await retire(p, o.priceId, B.otherOwner), await list(p, B.otherOwner),
      ];
      expect(answers.map((r) => [r.status, r.body.code])).toEqual(Array(5).fill([404, 'not_found']));
      expect(await catalogCount()).toBe(before);
      expect(await one(`SELECT status FROM product WHERE id = $1`, [o.productId])).toEqual({ status: 'active' });
    });

    it('the Owner\'s own other Platform: a product or price addressed through it is 404, never moved or changed', async () => {
      const p = await platform();
      const q = await platform();
      const o = await offering(p);
      expect((await createPrice(q, o.productId, monthly())).status).toBe(404);
      expect((await archive(q, o.productId)).status).toBe(404);
      expect((await retire(q, o.priceId)).status).toBe(404);
      expect((await list(q)).body.products).toEqual([]);
      expect(await one(`SELECT p.status, pr."retiredAt" FROM product p JOIN price pr ON pr."productId" = p.id WHERE pr.id = $1`, [o.priceId])).toEqual({ status: 'active', retiredAt: null });
    });

    it('a producer\'s product and price on the Owner\'s Platform are not the Owner\'s catalog: 404 to the Owner, absent from the list, unchanged', async () => {
      const p = await platform();
      const prod = await svc('post', '/billing/products', { seller: { type: 'company', id: COMPANY }, code: code(), name: 'Plan', subscriptionTarget: 'personal', platformId: p });
      const price = await svc('post', '/billing/prices', { productId: prod.body.id, clientReference: 'r-1', currency: 'TND', unitAmount: 900, interval: 'recurring', intervalUnit: 'month', intervalCount: 1, effectiveFrom: '2020-01-01T00:00:00Z' });
      expect([prod.status, price.status]).toEqual([201, 201]);
      expect((await createPrice(p, prod.body.id, monthly())).status).toBe(404);
      expect((await archive(p, prod.body.id)).status).toBe(404);
      expect((await retire(p, price.body.id)).status).toBe(404);
      expect((await list(p)).body.products).toEqual([]);
      expect((await checkout({ platformId: p, productId: prod.body.id, priceId: price.body.id })).body.code).toBe('product_not_available'); // D-CAT-8
    });

    it('a producer can neither read, archive nor price an Owner product, nor retire its price (the reserved provenance is no caller): 404', async () => {
      const p = await platform();
      const o = await offering(p);
      expect((await svc('get', `/billing/products/${o.productId}`)).status).toBe(404);
      expect((await svc('post', `/billing/products/${o.productId}/archive`)).status).toBe(404);
      expect((await svc('get', `/billing/prices/${o.priceId}`)).status).toBe(404);
      expect((await svc('post', `/billing/prices/${o.priceId}/retire`)).status).toBe(404);
      expect((await svc('post', '/billing/prices', { productId: o.productId, clientReference: 'svc-1', currency: 'TND', unitAmount: 1, interval: 'recurring', intervalUnit: 'month', intervalCount: 1, effectiveFrom: '2020-01-01T00:00:00Z' })).status).toBe(404);
      expect(await one(`SELECT status, (SELECT count(*) FROM price WHERE "productId" = $1)::int AS prices FROM product WHERE id = $1`, [o.productId])).toEqual({ status: 'active', prices: 1 });
    });

    it('a Platform without its S3d configuration is 409 platform_not_configured on every route; nothing is written', async () => {
      const p = await platform({ configured: false });
      const answers = [await createProduct(p, { code: code(), name: 'X' }), await createPrice(p, randomUUID(), monthly()), await archive(p, randomUUID()), await retire(p, randomUUID()), await list(p)];
      expect(answers.map((r) => [r.status, r.body.code])).toEqual(Array(5).fill([409, 'platform_not_configured']));
      expect(await count(`SELECT count(*) FROM product WHERE "platformId" = $1`, [p])).toBe(0);
    });

    it('a Platform whose Company changed in Auth after it was configured: the new Company\'s Owner gets 404, and the catalog is never re-pointed', async () => {
      const p = await platform();
      const o = await offering(p);
      auth.platforms.set(p, OTHER_COMPANY);
      expect((await createProduct(p, { code: code(), name: 'X' }, B.otherOwner)).status).toBe(404);
      expect((await archive(p, o.productId, B.otherOwner)).status).toBe(404);
      expect(t.logs.some((l) => JSON.stringify(l).includes('owner_catalog_company_mismatch'))).toBe(true);
      expect(await one(`SELECT status, "sellerId" FROM product WHERE id = $1`, [o.productId])).toEqual({ status: 'active', sellerId: COMPANY });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── authority (live, fail closed)

  describe('Owner authority', () => {
    it.each([['an operator', 'operator'], ['a member', 'member']] as const)('%s is 403 operation_not_permitted on every route, before the Platform is asked about', async (_n, who) => {
      const p = await platform();
      const o = await offering(p);
      auth.received.length = 0;
      const answers = [await createProduct(p, { code: code(), name: 'X' }, B[who]), await createPrice(p, o.productId, monthly(), B[who]),
        await archive(p, o.productId, B[who]), await retire(p, o.priceId, B[who]), await list(p, B[who])];
      expect(answers.map((r) => [r.status, r.body.code])).toEqual(Array(5).fill([403, 'operation_not_permitted']));
      expect(auth.received.every((x) => x.path === '/auth/grants')).toBe(true);
      expect(await one(`SELECT status FROM product WHERE id = $1`, [o.productId])).toEqual({ status: 'active' });
    });

    it('no bearer, a bearer Auth refuses and a SERVICE token are 401; a service token is never forwarded to Auth', async () => {
      const p = await platform();
      const before = await catalogCount();
      expect((await createProduct(p, { code: code(), name: 'X' }, null)).status).toBe(401);
      expect((await createProduct(p, { code: code(), name: 'X' }, 'revoked-session')).status).toBe(401);
      auth.received.length = 0;
      expect((await createProduct(p, { code: code(), name: 'X' }, producer.token)).status).toBe(401);
      expect((await list(p, producer.token)).status).toBe(401);
      expect(auth.received).toEqual([]);
      expect(await catalogCount()).toBe(before);
    });

    it('non-uuid ids are 400: the platformId never reaches Auth', async () => {
      expect((await createProduct('not-a-uuid', { code: code(), name: 'X' })).status).toBe(400);
      expect(auth.received.filter((x) => x.path.startsWith('/auth/platform-access'))).toEqual([]);
      const p = await platform();
      expect((await archive(p, 'not-a-uuid')).status).toBe(400);
      expect((await retire(p, 'not-a-uuid')).status).toBe(400);
      expect((await createPrice(p, 'not-a-uuid', monthly())).status).toBe(400);
    });

    it.each([
      ['grants', 'down', 'auth_unavailable'],
      ['grants', 'redirect', 'auth_unavailable'],
      ['grants', 'bad_kind', 'auth_unavailable'],
      ['grants', 'hang', 'auth_timeout'],
      ['access', 'down', 'auth_unavailable'],
      ['access', 'wrong_platform', 'auth_unavailable'],
      ['access', 'hang', 'auth_timeout'],
    ] as const)('Auth %s answers %s: 503 %s on every command, nothing written, no cached authority', async (target, mode, code503) => {
      const p = await platform();
      const o = await offering(p);
      const before = await catalogCount();
      auth.target = target;
      auth.mode = mode;
      for (const r of [await createProduct(p, { code: code(), name: 'X' }), await createPrice(p, o.productId, monthly()), await archive(p, o.productId), await retire(p, o.priceId)]) {
        expect([r.status, r.body.code]).toEqual([503, code503]);
        expect(JSON.stringify(r.body)).not.toMatch(/127\.0\.0\.1|ECONN|socket|Internal Server/);
      }
      expect(await catalogCount()).toBe(before);
      expect(await one(`SELECT p.status, pr."retiredAt" FROM product p JOIN price pr ON pr."productId" = p.id WHERE pr.id = $1`, [o.priceId])).toEqual({ status: 'active', retiredAt: null });
      expect(auth.sinkReceived).toEqual([]);
    }, 20_000);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── concurrency (D-CAT-4, D-CAT-6)

  describe('concurrency', () => {
    it('8 concurrent identical product creates: one 201, seven 200 replays, one row, one audit record', async () => {
      const p = await platform();
      const body = { code: code(), name: 'Plan' };
      const rs = await Promise.all(Array.from({ length: 8 }, () => createProduct(p, body)));
      expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
      expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
      expect(await count(`SELECT count(*) FROM product WHERE code = $1`, [body.code])).toBe(1);
      expect(await audit(rs[0]!.body.id)).toHaveLength(1);
    });

    it('8 concurrent creates of one price identity with different terms: exactly one wins, the identical ones replay, the rest are 409', async () => {
      const p = await platform();
      const { productId } = await offering(p);
      const ref = `race-${randomUUID().slice(0, 8)}`;
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => createPrice(p, productId, monthly({ clientReference: ref, unitAmount: i < 4 ? 500 : 600 }))));
      const created = rs.filter((r) => r.status === 201);
      expect(created).toHaveLength(1);
      const winner = created[0]!.body.unitAmount;
      for (const r of rs.filter((x) => x.status !== 201)) expect(r.status === 200 ? r.body.unitAmount : r.body.code).toBe(r.status === 200 ? winner : 'price_conflict');
      expect(await count(`SELECT count(*) FROM price WHERE "productId" = $1 AND "clientReference" = $2`, [productId, ref])).toBe(1);
    });

    it('8 concurrent retires of one price: one transition, one audit record, one retirement instant; archive racing price creation: no deadlock, one consistent state', async () => {
      const p = await platform();
      const o = await offering(p);
      const rs = await Promise.all(Array.from({ length: 8 }, () => retire(p, o.priceId)));
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect(rs.filter((r) => r.headers['idempotent-replayed'] !== 'true')).toHaveLength(1);
      expect(new Set(rs.map((r) => r.body.retiredAt)).size).toBe(1);
      expect((await audit(o.priceId)).filter((x) => x.name === 'audit.price.retired')).toHaveLength(1);

      const q = await offering(await platform());
      const mixed = await Promise.all([
        archive(q.platformId, q.productId), ...Array.from({ length: 4 }, () => createPrice(q.platformId, q.productId, monthly())), archive(q.platformId, q.productId),
      ]);
      expect(mixed.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(await one(`SELECT status, revision FROM product WHERE id = $1`, [q.productId])).toEqual({ status: 'archived', revision: 1 });
      expect((await audit(q.productId)).filter((x) => x.name === 'audit.product.archived')).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── producer compatibility

  describe('producer compatibility (D-CAT-8)', () => {
    it('producer routes are unchanged: a producer still creates personal, organization and ordinary products and their prices on its Platforms', async () => {
      const p = await platform();
      for (const target of ['personal', 'organization']) {
        const prod = await svc('post', '/billing/products', { seller: { type: 'company', id: 'nawara' }, code: code(), name: 'P', subscriptionTarget: target, platformId: p });
        expect(prod.status, JSON.stringify(prod.body)).toBe(201);
        const price = await svc('post', '/billing/prices', { productId: prod.body.id, clientReference: 'r', currency: 'TND', unitAmount: 900, interval: 'recurring', intervalUnit: 'month', intervalCount: 1, effectiveFrom: '2020-01-01T00:00:00Z' });
        expect(price.status).toBe(201);
        expect((await svc('post', `/billing/prices/${price.body.id}/retire`)).status).toBe(200);
        expect((await svc('post', `/billing/products/${prod.body.id}/archive`)).status).toBe(200);
      }
      expect((await svc('post', '/billing/products', { seller: { type: 'company', id: 'nawara' }, code: code(), name: 'P' })).status).toBe(201);
    });

    it('the documented boundary: ordinary producer invoices keep their scope (a producer naming the Company seller may draft on an Owner price), and a draft created before a retirement is still issued (D-CAT-7)', async () => {
      const p = await platform();
      const o = await offering(p);
      const body = { invoiceRequestId: randomUUID(), seller: { type: 'company', id: COMPANY }, payer: { type: 'user', id: MEMBER }, sourceType: 'contract', sourceId: `src-${++seq}`,
        issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: o.priceId, quantity: 1 }] };
      const draft = await svc('post', '/billing/invoices', body);
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);
      expect((await retire(p, o.priceId)).status).toBe(200);
      expect((await svc('post', '/billing/invoices', { ...body, invoiceRequestId: randomUUID() })).body.code).toBe('price_not_available'); // no NEW invoice on it
      const issued = await svc('post', `/billing/invoices/${draft.body.id}/issue`, {});
      expect([issued.status, issued.body.status], JSON.stringify(issued.body)).toEqual([200, 'open']); // the earlier draft's frozen terms
    });

    it('the Owner\'s products are listed with every price state, and the list exposes no provenance', async () => {
      const p = await platform();
      const o = await offering(p);
      await retire(p, o.priceId);
      await archive(p, o.productId);
      const r = await list(p);
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body.products).toHaveLength(1);
      expect(r.body.products[0]).toMatchObject({ id: o.productId, status: 'archived', prices: [{ id: o.priceId, retiredAt: expect.any(String) }] });
      expect(JSON.stringify(r.body)).not.toContain('billing-owner');
    });
  });
});
