import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  DbService, HttpOrganizationReferenceClient, MemoizedOrganizationReference, generateServiceToken, kitMigrationsDir, runMigrations,
  type AuthClient, type AuthIdentity,
} from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

const P1 = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const P2 = 'aaaaaaaa-0000-4000-8000-0000000000f2';
const COMPANY = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const id = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** How the stand-in Organization Service answers, per organization id. */
const ORG = {
  inScope: id(1), otherPlatform: id(2), unknown: id(3), notAuthoritative: id(4), serverError: id(5), slow: id(6), redirect: id(7),
  oversized: id(8), malformed: id(9), memoThenDown: id(10), replayThenDown: id(11),
} as const;

/**
 * Stage 21.C.2 (ADR-0052 decisions 2 and 3; ADR-0042 D3, AD-2, decision 5, A.3 and Amendment 3): Payment's service-caller admission and
 * the Organization scope of its creates, on real PostgreSQL, with the REAL hardened reference client against a stand-in Organization
 * Service. Every refusal is proved to write nothing: no payment, no outbox event, no audit intent.
 */
describeWithEnv('payment caller admission and Organization scope (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let dbs: DbService;
  let t: TestApp;
  let org: Server;
  let down = new Set<string>();
  const referenceCalls: string[] = [];
  const billing = generateServiceToken();
  const reader = generateServiceToken(); // a registered service holding only payment.read
  const authToPayment = generateServiceToken(); // the retired Auth → Payment credential: NOT registered (ADR-0042 Amendment 3)
  const payer: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const userBearer = 'a-user-bearer';
  const authClient: AuthClient = { getIdentity: async (b) => (b === userBearer ? payer : null), hasPlatformAccess: async () => false };

  beforeAll(async () => {
    org = createServer((req, res) => {
      const orgId = (req.url ?? '').split('/').pop() ?? '';
      referenceCalls.push(orgId);
      const ok = (platformId: string) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ organizationId: orgId, platformId, companyId: COMPANY }));
      };
      if (down.has(orgId) || orgId === ORG.notAuthoritative) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'not_authoritative' }));
        return;
      }
      switch (orgId) {
        case ORG.otherPlatform: return ok(P2);
        case ORG.unknown: res.writeHead(404); res.end(); return;
        case ORG.serverError: res.writeHead(500); res.end(); return;
        case ORG.slow: return; // never answers
        case ORG.redirect: res.writeHead(307, { location: '/organization/reference/organizations/elsewhere' }); res.end(); return;
        case ORG.oversized: res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ organizationId: orgId, platformId: P1, companyId: COMPANY, pad: 'x'.repeat(10_000) })); return;
        case ORG.malformed: res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"organizationId":'); return;
        default: return ok(P1);
      }
    });
    await new Promise<void>((r) => org.listen(0, '127.0.0.1', r));
    const reference = new MemoizedOrganizationReference(new HttpOrganizationReferenceClient({
      baseUrl: `http://127.0.0.1:${(org.address() as AddressInfo).port}`, serviceToken: 'payment-own-reference-credential', timeoutMs: 300, onNotice: () => undefined,
    }));

    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentadmission');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [{ caller: 'billing-service', digest: billing.digest }, { caller: 'reader-service', digest: reader.digest }],
      authClient,
      reference,
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      env: {
        PAYMENT_TEST_PROVIDER: 'true',
        PAYMENT_SERVICE_POLICY: JSON.stringify({
          callers: {
            'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel'], allowedPlatforms: [P1] },
            'reader-service': { operations: ['payment.read'], allowedPlatforms: [P1] },
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
    referenceCalls.length = 0;
  });

  const http = () => request(t.app.getHttpServer());
  const body = (organizationId: string | null, over: Record<string, unknown> = {}) => ({
    paymentRequestId: crypto.randomUUID(),
    sourceType: 'invoice',
    sourceId: 'inv-1',
    payer: { type: 'user', id: 'user-1' },
    seller: organizationId ? { type: 'organization', id: organizationId } : { type: 'company', id: 'seller-co' },
    ...(organizationId ? { organizationId } : {}),
    amount: 1000,
    currency: 'TND',
    ...over,
  });
  const create = (token: string, b: Record<string, unknown>, headers: Record<string, string> = {}) =>
    http().post('/payment/payments').set({ authorization: `Bearer ${token}`, ...headers }).send(b);
  const counts = async () => {
    const { rows } = await dbs.query<{ p: string; o: string }>(`SELECT (SELECT count(*) FROM payment)::text AS p, (SELECT count(*) FROM outbox)::text AS o`);
    return rows[0];
  };
  const refusedWithNoWrite = async (res: Promise<request.Response>, status: number, code: string) => {
    const before = await counts();
    const r = await res;
    expect([r.status, r.body.code]).toEqual([status, code]);
    expect(await counts()).toEqual(before);
    return r;
  };

  // ---- caller admission ----------------------------------------------------------------------------------------------------------

  it('billing-service creates, reads and cancels its own payment (its three approved operations)', async () => {
    const c = await create(billing.token, body(ORG.inScope)).expect(201);
    await http().get(`/payment/payments/${c.body.id}`).set('authorization', `Bearer ${billing.token}`).expect(200);
    await http().post(`/payment/payments/${c.body.id}/cancel`).set({ authorization: `Bearer ${billing.token}`, 'idempotency-key': `cancel-${c.body.id}` }).expect(200);
  });

  it('billing-service may not start or sync an attempt (no service holds an attempt operation, AD-2)', async () => {
    const c = await create(billing.token, body(ORG.inScope)).expect(201);
    await refusedWithNoWrite(http().post(`/payment/payments/${c.body.id}/attempts`).set({ authorization: `Bearer ${billing.token}`, 'idempotency-key': 'attempt-key-1' }).send({ provider: 'test' }), 403, 'operation_not_permitted');
    await refusedWithNoWrite(http().post(`/payment/payments/${c.body.id}/attempts/${crypto.randomUUID()}/sync`).set('authorization', `Bearer ${billing.token}`), 403, 'operation_not_permitted');
  });

  it('a registered service without the operation: 403 operation_not_permitted on create and cancel, and nothing is written', async () => {
    const c = await create(billing.token, body(ORG.inScope)).expect(201);
    await refusedWithNoWrite(create(reader.token, body(ORG.inScope)), 403, 'operation_not_permitted');
    await refusedWithNoWrite(http().post(`/payment/payments/${c.body.id}/cancel`).set({ authorization: `Bearer ${reader.token}`, 'idempotency-key': 'reader-cancel-1' }), 403, 'operation_not_permitted');
  });

  it('the retired auth-service credential is not registered: 401 everywhere (ADR-0042 Amendment 3)', async () => {
    const c = await create(billing.token, body(ORG.inScope)).expect(201);
    await refusedWithNoWrite(create(authToPayment.token, body(ORG.inScope)), 401, undefined as unknown as string);
    expect((await http().get(`/payment/payments/${c.body.id}`).set('authorization', `Bearer ${authToPayment.token}`)).status).toBe(401);
  });

  it('an unknown or malformed token: 401, and nothing is written', async () => {
    for (const auth of ['Bearer not-a-registered-token', 'Bearer', 'Basic Zm9vOmJhcg==', '']) {
      const before = await counts();
      const r = await http().post('/payment/payments').set('authorization', auth).send(body(ORG.inScope));
      expect(r.status).toBe(401);
      expect(await counts()).toEqual(before);
    }
  });

  it('a human bearer is never a service credential on a service-only route (401), and keeps its payer rule where users are admitted', async () => {
    const c = await create(billing.token, body(ORG.inScope)).expect(201);
    expect((await create(userBearer, body(ORG.inScope))).status).toBe(401);
    expect((await http().post(`/payment/payments/${c.body.id}/cancel`).set({ authorization: `Bearer ${userBearer}`, 'idempotency-key': 'user-cancel-1' })).status).toBe(401);
    await http().get(`/payment/payments/${c.body.id}`).set('authorization', `Bearer ${userBearer}`).expect(200); // the payer, unchanged
  });

  it('forged identity headers change nothing: authority comes only from the authenticated token and the policy', async () => {
    const forged = { 'x-caller': 'billing-service', 'x-service': 'billing-service', 'x-service-caller': 'billing-service', 'x-user-id': 'user-1', 'x-organization-id': ORG.inScope, 'x-forwarded-user': 'billing-service', 'x-correlation-id': 'billing-service', 'x-request-id': 'billing-service' };
    await refusedWithNoWrite(create(reader.token, body(ORG.inScope), forged), 403, 'operation_not_permitted');
    const r = await http().post('/payment/payments').set(forged).send(body(ORG.inScope));
    expect(r.status).toBe(401);
    // A forged Organization header never widens the body's Organization either: the body's is verified.
    await refusedWithNoWrite(create(billing.token, body(ORG.otherPlatform), { 'x-organization-id': ORG.inScope, 'x-platform-id': P2 }), 403, 'organization_not_permitted');
  });

  // ---- Organization scope ----------------------------------------------------------------------------------------------------------

  it('an Organization of an allowed Platform: created', async () => {
    await create(billing.token, body(ORG.inScope)).expect(201);
  });

  it('another tenant\'s Organization and a nonexistent one get the SAME answer (403 organization_not_permitted), nothing written', async () => {
    const a = await refusedWithNoWrite(create(billing.token, body(ORG.otherPlatform)), 403, 'organization_not_permitted');
    const b = await refusedWithNoWrite(create(billing.token, body(ORG.unknown)), 403, 'organization_not_permitted');
    expect(a.body.message).toBe(b.body.message);
  });

  it('organizationId asserted apart from the seller is verified too', async () => {
    await refusedWithNoWrite(create(billing.token, body(null, { organizationId: ORG.otherPlatform })), 403, 'organization_not_permitted');
  });

  it('the authority unable to answer fails closed: 503 hierarchy_unavailable and NO mutation (409 before the cutover, 5xx, timeout, redirect, oversized, malformed)', async () => {
    for (const o of [ORG.notAuthoritative, ORG.serverError, ORG.slow, ORG.redirect, ORG.oversized, ORG.malformed]) {
      const r = await refusedWithNoWrite(create(billing.token, body(o)), 503, 'hierarchy_unavailable');
      expect(JSON.stringify(r.body)).not.toMatch(/127\.0\.0\.1|payment-own-reference-credential|not_authoritative/);
    }
  });

  it('a request that names no Organization is not subject to Platform resolution (A.3), even while the authority is down', async () => {
    await create(billing.token, body(null)).expect(201);
    expect(referenceCalls).toEqual([]);
  });

  it('a memoized Organization keeps working while the authority is down; a new one fails closed', async () => {
    await create(billing.token, body(ORG.memoThenDown)).expect(201);
    down = new Set([ORG.memoThenDown]);
    await create(billing.token, body(ORG.memoThenDown)).expect(201);
    expect(referenceCalls).toEqual([ORG.memoThenDown]);
  });

  it('a replay is answered from the stored record without asking the authority (it was verified when created)', async () => {
    const b = body(ORG.replayThenDown);
    const first = await create(billing.token, b).expect(201);
    down = new Set([ORG.replayThenDown]);
    const again = await create(billing.token, b).expect(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
  });

  it('a negative answer is not memoized: the next request asks again', async () => {
    await create(billing.token, body(ORG.unknown)).expect(403);
    await create(billing.token, body(ORG.unknown)).expect(403);
    expect(referenceCalls).toEqual([ORG.unknown, ORG.unknown]);
  });
});
