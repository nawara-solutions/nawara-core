import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DbService, HttpOrganizationReferenceClient, MemoizedOrganizationReference, generateServiceToken, kitMigrationsDir, runMigrations,
  type AuthClient, type AuthIdentity,
} from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import { BILLING_OPERATIONS } from '../src/admission/caller-admission.policy.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const P1 = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const P2 = 'aaaaaaaa-0000-4000-8000-0000000000f2';
const COMPANY = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const oid = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = { inScope: oid(1), otherPlatform: oid(2), unknown: oid(3), notAuthoritative: oid(4), slow: oid(5), inScope2: oid(6) } as const;
const U = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Every service-token surface of Billing, as [method, path, operation]. Ids are well-formed and need not exist. */
const SURFACE: [string, string, string][] = [
  ['post', '/billing/products', 'product.create'],
  ['get', `/billing/products/${U(1)}`, 'product.read'],
  ['post', `/billing/products/${U(1)}/archive`, 'product.archive'],
  ['post', '/billing/prices', 'price.create'],
  ['get', `/billing/prices/${U(1)}`, 'price.read'],
  ['post', `/billing/prices/${U(1)}/retire`, 'price.retire'],
  ['post', '/billing/invoices', 'invoice.create'],
  ['get', `/billing/invoices/${U(1)}`, 'invoice.read'],
  ['get', '/billing/invoices', 'invoice.list'],
  ['post', `/billing/invoices/${U(1)}/issue`, 'invoice.issue'],
  ['post', `/billing/invoices/${U(1)}/discard`, 'invoice.discard'],
  ['post', `/billing/invoices/${U(1)}/payment-requests`, 'payment_request.create'],
  ['get', `/billing/payment-requests/${U(1)}`, 'payment_request.read'],
  ['post', `/billing/payment-requests/${U(1)}/cancel`, 'payment_request.cancel'],
  ['get', `/billing/organizations/${ORG.inScope}/entitlement`, 'entitlement.read'],
];

const payer: AuthIdentity = { id: '1a1a1a1a-0000-4000-8000-000000000001', adminTier: null, isActive: true, memberships: [] };
const USER_BEARER = 'a-user-bearer';
const authClient: AuthClient = { getIdentity: async (b) => (b === USER_BEARER ? payer : null), hasPlatformAccess: async () => false };

/**
 * Stage 21.C.2 (ADR-0052 decisions 2 and 3; ADR-0042 D3, A.3 and decision 5; Q5): Billing's caller admission on real PostgreSQL. First the
 * APPROVED Core V1 configuration (no service caller admitted), then the enforcement mechanics with a test-only policy, and the
 * Organization scope of its creates and of the entitlement read, through the REAL hardened reference client.
 */
describeWithEnv('billing caller admission (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  it('the surface table covers every Billing operation exactly once', () => {
    expect(SURFACE.map(([, , op]) => op).sort()).toEqual([...BILLING_OPERATIONS].sort());
  });

  describe('the approved Core V1 configuration: no service caller is admitted', () => {
    let db: TestDatabase;
    let t: TestApp;
    const anyService = generateServiceToken(); // what a would-be caller (a future product) would present

    beforeAll(async () => {
      db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingadmitnone');
      await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
      t = await createTestApp({ databaseUrl: db.url, authClient }); // no SERVICE_TOKENS, no BILLING_SERVICE_POLICY: the V1 values
    });
    afterAll(async () => {
      await t.app.close();
      await db.drop();
    });

    it('the configuration is an explicit, empty admission', () => {
      expect(t.config.serviceTokens).toEqual([]);
      expect(t.config.servicePolicy.size).toBe(0);
    });

    it.each(SURFACE)('%s %s (%s): any service credential is refused (401)', async (method, path) => {
      const r = await (request(t.app.getHttpServer()) as unknown as Record<string, (p: string) => request.Test>)[method]!(path).set('authorization', `Bearer ${anyService.token}`).send({});
      expect(r.status).toBe(401);
    });

    it('human routes keep their semantics: the payer still lists their own invoices', async () => {
      await request(t.app.getHttpServer()).get('/billing/invoices').set('authorization', `Bearer ${USER_BEARER}`).expect(200);
    });
  });

  describe('enforcement mechanics (a TEST-ONLY policy) and Organization scope', () => {
    let db: TestDatabase;
    let dbs: DbService;
    let t: TestApp;
    let org: Server;
    let down = new Set<string>();
    const lookups: string[] = [];
    const full = generateServiceToken(); // test-full-caller: every operation within P1
    const narrow = generateServiceToken(); // test-narrow-caller: entitlement.read only, within P1

    beforeAll(async () => {
      org = createServer((req, res) => {
        const orgId = (req.url ?? '').split('/').pop() ?? '';
        lookups.push(orgId);
        if (down.has(orgId) || orgId === ORG.notAuthoritative) {
          res.writeHead(409);
          res.end();
          return;
        }
        if (orgId === ORG.unknown) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (orgId === ORG.slow) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ organizationId: orgId, platformId: orgId === ORG.otherPlatform ? P2 : P1, companyId: COMPANY }));
      });
      await new Promise<void>((r) => org.listen(0, '127.0.0.1', r));
      db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingadmission');
      await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
      t = await createTestApp({
        databaseUrl: db.url,
        authClient,
        tokens: [{ caller: 'test-full-caller', digest: full.digest }, { caller: 'test-narrow-caller', digest: narrow.digest }],
        organizationReference: new MemoizedOrganizationReference(new HttpOrganizationReferenceClient({
          baseUrl: `http://127.0.0.1:${(org.address() as AddressInfo).port}`, serviceToken: 'billing-own-reference-credential', timeoutMs: 300, onNotice: () => undefined,
        })),
        env: {
          BILLING_SERVICE_POLICY: JSON.stringify({
            callers: {
              'test-full-caller': { operations: [...BILLING_OPERATIONS], allowedPlatforms: [P1] },
              'test-narrow-caller': { operations: ['entitlement.read'], allowedPlatforms: [P1] },
            },
          }),
        },
      });
      dbs = t.app.get(DbService);
    });
    afterAll(async () => {
      await t.app.close();
      await db.drop();
      await new Promise<void>((r) => org.close(() => r()));
    });
    beforeEach(() => {
      down = new Set();
      lookups.length = 0;
    });

    const http = () => request(t.app.getHttpServer());
    const as = (token: string) => ({
      post: (path: string, body: unknown) => http().post(path).set('authorization', `Bearer ${token}`).send(body as object),
      get: (path: string) => http().get(path).set('authorization', `Bearer ${token}`),
    });
    let seq = 0;
    const productBody = (sellerId: string) => ({ seller: { type: 'organization', id: sellerId }, code: `prod-${++seq}`, name: `Product ${seq}` });
    const counts = async () => (await dbs.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM product)::text AS product, (SELECT count(*) FROM price)::text AS price, (SELECT count(*) FROM invoice)::text AS invoice, (SELECT count(*) FROM outbox)::text AS outbox`,
    )).rows[0];
    const refusedWithNoWrite = async (res: Promise<request.Response>, status: number, code: string) => {
      const before = await counts();
      const r = await res;
      expect([r.status, r.body.code]).toEqual([status, code]);
      expect(await counts()).toEqual(before);
      return r;
    };
    const priceFor = async (sellerId: string) => {
      const product = await as(full.token).post('/billing/products', productBody(sellerId)).expect(201);
      const price = await as(full.token).post('/billing/prices', { productId: product.body.id, clientReference: `ref-${++seq}`, currency: 'TND', unitAmount: 1500, interval: 'one_time', effectiveFrom: new Date(Date.now() - 60_000).toISOString() }).expect(201);
      return price.body.id as string;
    };
    const invoiceBody = (sellerId: string, priceId: string, invoiceRequestId = crypto.randomUUID()) => ({
      invoiceRequestId, seller: { type: 'organization', id: sellerId }, payer: { type: 'user', id: payer.id }, sourceType: 'contract', sourceId: `src-${++seq}`,
      issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId, quantity: 1 }],
    });

    it.each(SURFACE.filter(([, , op]) => op !== 'entitlement.read'))('%s %s: a registered caller without %s gets 403 operation_not_permitted, nothing written', async (method, path) => {
      const before = await counts();
      const r = await (http() as unknown as Record<string, (p: string) => request.Test>)[method]!(path).set('authorization', `Bearer ${narrow.token}`).send({});
      expect([r.status, r.body.code]).toEqual([403, 'operation_not_permitted']);
      expect(await counts()).toEqual(before);
    });

    it('the narrow caller holds exactly entitlement.read, within its Platform', async () => {
      const r = await as(narrow.token).get(`/billing/organizations/${ORG.inScope}/entitlement`).expect(200);
      expect(r.body).toEqual({ valid: false, expiresAt: null });
    });

    it('forged identity headers never widen a caller', async () => {
      await refusedWithNoWrite(http().post('/billing/products').set({ authorization: `Bearer ${narrow.token}`, 'x-caller': 'test-full-caller', 'x-service': 'test-full-caller', 'x-correlation-id': 'test-full-caller' }).send(productBody(ORG.inScope)), 403, 'operation_not_permitted');
    });

    it('a product for an in-scope Organization is created; another tenant\'s and an unknown one get the same 403, nothing written', async () => {
      await as(full.token).post('/billing/products', productBody(ORG.inScope)).expect(201);
      const a = await refusedWithNoWrite(as(full.token).post('/billing/products', productBody(ORG.otherPlatform)), 403, 'organization_not_permitted');
      const b = await refusedWithNoWrite(as(full.token).post('/billing/products', productBody(ORG.unknown)), 403, 'organization_not_permitted');
      expect(a.body.message).toBe(b.body.message);
    });

    it('an invoice for an in-scope Organization is created; the authority unable to answer fails closed (503), nothing written', async () => {
      const priceId = await priceFor(ORG.inScope2);
      await as(full.token).post('/billing/invoices', invoiceBody(ORG.inScope2, priceId)).expect(201);
      for (const o of [ORG.notAuthoritative, ORG.slow]) {
        await refusedWithNoWrite(as(full.token).post('/billing/invoices', invoiceBody(o, priceId)), 503, 'hierarchy_unavailable');
      }
      await refusedWithNoWrite(as(full.token).post('/billing/invoices', invoiceBody(ORG.otherPlatform, priceId)), 403, 'organization_not_permitted');
    });

    it('an invoice replay is answered from the stored record while the authority is down', async () => {
      const seller = oid(7);
      const priceId = await priceFor(seller);
      const body = invoiceBody(seller, priceId);
      const first = await as(full.token).post('/billing/invoices', body).expect(201);
      down = new Set([seller]);
      // memoized: a replay would pass anyway; a fresh process would still answer it from the stored record (no lookup at all)
      lookups.length = 0;
      const again = await as(full.token).post('/billing/invoices', body).expect(200);
      expect(again.body.id).toBe(first.body.id);
      expect(lookups).toEqual([]);
    });

    it('the entitlement read resolves the Organization\'s Platform: another tenant\'s or an unknown one is 403; the authority down is 503 (never "entitled")', async () => {
      await as(narrow.token).get(`/billing/organizations/${ORG.otherPlatform}/entitlement`).expect(403);
      await as(narrow.token).get(`/billing/organizations/${ORG.unknown}/entitlement`).expect(403);
      const r = await as(narrow.token).get(`/billing/organizations/${ORG.notAuthoritative}/entitlement`);
      expect([r.status, r.body.code, r.body.valid]).toEqual([503, 'hierarchy_unavailable', undefined]);
    });

    it('reads of the caller\'s own records never ask Organization Service', async () => {
      const product = await as(full.token).post('/billing/products', productBody(oid(8))).expect(201);
      lookups.length = 0;
      down = new Set([oid(8)]);
      await as(full.token).get(`/billing/products/${product.body.id}`).expect(200);
      await as(full.token).get('/billing/invoices').expect(200);
      expect(lookups).toEqual([]);
    });
  });
});
