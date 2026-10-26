import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { TestPaymentProvider } from '../src/providers/test-provider.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '1e0a7c5b-3d2f-4a6b-9c8d-7e6f5a4b3c21';
type Row = Record<string, any>;

/** A direct purchase from the Platform's Company reference, the only Company seller Core V2 has (ADR-0068 decision 1). */
const body = (over: Row = {}) => ({
  paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: `inv-${crypto.randomUUID().slice(0, 8)}`,
  payer: { type: 'user', id: BUYER }, seller: { type: 'company', id: 'nawara-company-reference' },
  amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER, ...over,
});

/**
 * Core V2 S4b (register PAY-06; S0 DB-16, FC-11; S-7; ADR-0068 decision 3): a Company seller's payment is never settled in cash. Through the
 * REAL application on real PostgreSQL 16 (the only settlement path, a verified gateway success), then straight at the database, which is the
 * guard: no route, DTO or error code sets `cash`.
 */
describeWithEnv('no cash settlement of a Company seller (Core V2 S4b, DB-16) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const billing = generateServiceToken();
  const identities: Record<string, AuthIdentity> = { 'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] } };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const server = () => t.app.getHttpServer();
  const create = (b: Row) => request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(b);
  /** The only settlement path: an attempt, then the provider's verified (signed) success callback. */
  const settle = async (paymentId: string) => {
    const a = await request(server()).post(`/payment/payments/${paymentId}/attempts`).set('authorization', 'Bearer buyer-jwt')
      .set('idempotency-key', `k-${crypto.randomUUID()}`).send({ providerOptions: { scenario: 'success' } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const { body: cb, signature } = t.app.get(TestPaymentProvider).signSuccessCallback(a.body.id);
    await request(server()).post('/payment/webhooks/test').set('content-type', 'application/json').set('x-test-provider-signature', signature).send(cb.toString('utf8')).expect(200);
    return a;
  };
  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
  const refusedBy = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (err: { code?: string; constraint?: string }) => err);
    return e && [e.code, e.constraint];
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentnocash');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    t = await createTestApp({
      databaseUrl: db.url, tokens: [{ caller: 'billing-service', digest: billing.digest }], authClient,
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], env: { PAYMENT_TEST_PROVIDER: 'true' },
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  /** A Company payment settled the only way Core V2 settles one: a verified gateway success on its attempt. */
  const gatewaySettled = async () => {
    const p = (await create(body()).expect(201)).body;
    expect((await settle(p.id)).status).toBe(201);
    expect(await one(`SELECT status, "settledMethod", "sellerType", "liveMode", purpose FROM payment WHERE id = $1`, [p.id]))
      .toEqual({ status: 'succeeded', settledMethod: 'gateway', sellerType: 'company', liveMode: false, purpose: 'direct_purchase' });
    return p.id as string;
  };

  describe('the only settlement path stays electronic', () => {
    it('a Company seller\'s payment settles through the gateway; its payment.succeeded says gateway and keeps the S4a facts', async () => {
      const id = await gatewaySettled();
      const ev = await one(`SELECT payload FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [id]);
      expect(ev.payload).toMatchObject({ settledMethod: 'gateway', seller: { type: 'company' }, purpose: 'direct_purchase', beneficiaryUserId: BUYER, liveMode: false });
    });

    it('the API offers no way to ask for cash: a settledMethod in the create body is an unknown field (400)', async () => {
      const b = body({ settledMethod: 'cash' });
      const r = await create(b);
      expect([r.status, r.body.code]).toEqual([400, 'validation_error']);
      expect(Number((await one(`SELECT count(*) FROM payment WHERE "paymentRequestId" = $1`, [b.paymentRequestId])).count)).toBe(0);
    });

    it('an identical replay of a settled Company payment answers the same gateway-settled record, never anything else', async () => {
      const b = body();
      const first = (await create(b).expect(201)).body;
      expect((await settle(first.id)).status).toBe(201);
      const again = await create(b).expect(200);
      expect([again.body.id, again.body.status, again.body.settledMethod]).toEqual([first.id, 'succeeded', 'gateway']);
    });
  });

  describe('the database refuses every other path (DB-16)', () => {
    it('a raw UPDATE re-labelling a settled Company payment as cash is refused by DB-16 (and nothing changes)', async () => {
      const id = await gatewaySettled();
      expect(await refusedBy(admin.query(`UPDATE payment SET "settledMethod" = 'cash' WHERE id = $1`, [id]))).toEqual(['23514', 'payment_no_company_cash_settlement']);
      expect((await one(`SELECT "settledMethod" FROM payment WHERE id = $1`, [id])).settledMethod).toBe('gateway');
    });

    it('8 concurrent raw UPDATEs to cash: every one is refused, the payment stays gateway-settled', async () => {
      const id = await gatewaySettled();
      const results = await Promise.all(Array.from({ length: 8 }, () => refusedBy(admin.query(`UPDATE payment SET "settledMethod" = 'cash' WHERE id = $1`, [id]))));
      expect(results).toEqual(Array(8).fill(['23514', 'payment_no_company_cash_settlement']));
      expect((await one(`SELECT "settledMethod", revision FROM payment WHERE id = $1`, [id]))).toMatchObject({ settledMethod: 'gateway' });
    });

    it('a raw INSERT of a Company payment already settled in cash is refused by DB-16', async () => {
      expect(await refusedBy(admin.query(
        `INSERT INTO payment (producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency, purpose, status, "settledMethod")
         VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'company', 'n', 100, 'TND', 'non_entitlement', 'succeeded', 'cash')`,
      ))).toEqual(['23514', 'payment_no_company_cash_settlement']);
    });

    it('the seller cannot be moved away from Company to take cash (the S4a / FI-02 snapshot stays immutable)', async () => {
      const id = await gatewaySettled();
      expect((await refusedBy(admin.query(`UPDATE payment SET "sellerType" = 'user', "settledMethod" = 'cash' WHERE id = $1`, [id])))?.[0]).toBe('23514');
      expect(await one(`SELECT "sellerType", "settledMethod" FROM payment WHERE id = $1`, [id])).toEqual({ sellerType: 'company', settledMethod: 'gateway' });
    });

    it('other seller types are untouched by DB-16 (their cash stays deferred, ADR-0068 decision 4: no workflow enables it)', async () => {
      const org = crypto.randomUUID();
      await admin.query(
        `INSERT INTO payment (producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency, purpose, status, "settledMethod")
         VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'organization', $1::text, $2::uuid, 100, 'TND', 'non_entitlement', 'succeeded', 'cash')`, [org, org]);
      expect(Number((await one(`SELECT count(*) FROM payment WHERE "sellerType" = 'organization' AND "settledMethod" = 'cash'`)).count)).toBe(1);
    });

    it('the constraint is validated (every existing row satisfies it) and no Company payment is cash-settled', async () => {
      expect((await one(`SELECT convalidated FROM pg_constraint WHERE conname = 'payment_no_company_cash_settlement'`)).convalidated).toBe(true);
      expect(Number((await one(`SELECT count(*) FROM payment WHERE "sellerType" = 'company' AND "settledMethod" = 'cash'`)).count)).toBe(0);
    });
  });
});
