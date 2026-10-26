import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '1e0a7c5b-3d2f-4a6b-9c8d-7e6f5a4b3c21';
type Row = Record<string, any>;

const body = (over: Row = {}) => ({
  paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: `inv-${crypto.randomUUID().slice(0, 8)}`,
  payer: { type: 'user', id: BUYER }, seller: { type: 'company', id: 'nawara-company-reference' },
  amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER, ...over,
});

/**
 * Core V2 S4g (register PAY-15; S0 §3.7, [OD] D7): class-M money-command idempotency through the REAL application on real PostgreSQL 16:
 * a 90-day window set and kept by the database, replays answering the stored outcome, and the permanent business keys behind it.
 */
describeWithEnv('class-M money-command idempotency (Core V2 S4g) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const billing = generateServiceToken();
  const identities: Record<string, AuthIdentity> = { 'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] } };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const server = () => t.app.getHttpServer();
  const create = async (over: Row = {}) => (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(body(over)).expect(201)).body;
  const start = (id: string, key: string, scenario = 'success') =>
    request(server()).post(`/payment/payments/${id}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key).send({ providerOptions: { scenario } });
  const cancel = (id: string, key: string) =>
    request(server()).post(`/payment/payments/${id}/cancel`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key).send({});
  const record = async (key: string) => (await admin.query(
    `SELECT operation, ("expiresAt" - "createdAt") = interval '90 days' AS ninety, "createdAt" > now() - interval '1 minute' AS fresh FROM idempotency_key WHERE key = $1`, [key])).rows;
  const attempts = async (pid: string) => Number((await admin.query(`SELECT count(*) FROM payment_attempt WHERE "paymentId" = $1`, [pid])).rows[0].count);

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentidem');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
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

  describe('attempt start (PAY-03)', () => {
    it('the record is class M: a 90-day window from the database\'s own clock; an identical replay answers the SAME attempt', async () => {
      const p = await create();
      const key = `s4g-${crypto.randomUUID()}`;
      const first = await start(p.id, key).expect(201);
      expect(await record(key)).toEqual([{ operation: 'start_attempt', ninety: true, fresh: true }]);
      const again = await start(p.id, key).expect(201);
      expect(again.body.id).toBe(first.body.id);
      expect(await attempts(p.id)).toBe(1);
    });

    it('the same key with another request is 422 idempotency_key_reused, and nothing is started', async () => {
      const p = await create();
      const key = `s4g-${crypto.randomUUID()}`;
      await start(p.id, key, 'success').expect(201);
      const other = await start(p.id, key, 'timeout_before_accept');
      expect([other.status, other.body.code]).toEqual([422, 'idempotency_key_reused']);
      expect(await attempts(p.id)).toBe(1);
    });

    it('8 concurrent starts under ONE key: one attempt, every answer is that attempt', async () => {
      const p = await create();
      const key = `s4g-${crypto.randomUUID()}`;
      const rs = await Promise.all(Array.from({ length: 8 }, () => start(p.id, key)));
      const ok = rs.filter((r) => r.status === 201);
      expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
      for (const r of rs.filter((x) => x.status !== 201)) expect(['payment_has_open_attempt', 'payment_uncertain']).toContain(r.body.code);
      expect(await attempts(p.id)).toBe(1);
      expect(Number((await admin.query('SELECT count(*) FROM idempotency_key WHERE key = $1', [key])).rows[0].count)).toBe(1);
    });

    it('a missing or malformed key is 400 idempotency_key_required', async () => {
      const p = await create();
      for (const key of ['', 'short', 'has space key']) expect((await start(p.id, key)).body.code, key || 'empty').toBe('idempotency_key_required');
      expect(await attempts(p.id)).toBe(0);
    });

    it('permanent uniqueness behind the window: even with a NEW key, a payment never gets a second collection while one may settle it', async () => {
      const p = await create();
      await start(p.id, `s4g-${crypto.randomUUID()}`, 'timeout_before_accept').expect(201);
      const second = await start(p.id, `s4g-${crypto.randomUUID()}`);
      expect(second.status).toBe(409);
      expect(await attempts(p.id)).toBe(1);
    });
  });

  describe('cancel and creation', () => {
    it('cancel keys are class M too; a replay answers the stored outcome; the record cannot be rewritten or deleted', async () => {
      const p = await create();
      const key = `s4g-${crypto.randomUUID()}`;
      await cancel(p.id, key).expect(200);
      expect(await record(key)).toEqual([{ operation: 'cancel_payment', ninety: true, fresh: true }]);
      expect((await cancel(p.id, key).expect(200)).body.status).toBe('cancelled');
      await expect(admin.query(`UPDATE idempotency_key SET "expiresAt" = now() WHERE key = $1`, [key])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`DELETE FROM idempotency_key WHERE key = $1`, [key])).rejects.toMatchObject({ code: '23514' });
    });

    it('payment creation (PAY-01) stays keyed by its permanent natural key: a replay is the same payment, with no header and no record', async () => {
      const b = body();
      const first = (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(b).expect(201)).body;
      const again = await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(b).expect(200);
      expect(again.body.id).toBe(first.id);
      expect(Number((await admin.query(`SELECT count(*) FROM idempotency_key WHERE "resourceId" = $1`, [first.id])).rows[0].count)).toBe(0);
    });
  });
});
