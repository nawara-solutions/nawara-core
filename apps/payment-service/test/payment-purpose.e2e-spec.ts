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
const OTHER_USER = '2f1b8d6c-4e3a-4b7c-8d9e-8f7a6b5c4d32';
type Row = Record<string, any>;

/** A request from Billing to a Company seller (the Platform's Company reference): only the purpose-related fields vary below. */
const body = (over: Row = {}) => ({
  paymentRequestId: crypto.randomUUID(),
  sourceType: 'invoice',
  sourceId: `inv-${crypto.randomUUID().slice(0, 8)}`,
  payer: { type: 'user', id: BUYER },
  seller: { type: 'company', id: 'nawara-company-reference' },
  amount: 9000,
  currency: 'TND',
  purpose: 'non_entitlement',
  ...over,
});

/**
 * Core V2 S4a (register PAY-01; DB-15, S-6, FC-10; ADR-0044 B2 and B7; the Owner's P-1 to P-8): payer, purpose, beneficiary and liveMode
 * through the REAL application on real PostgreSQL 16, then straight at the database to prove the application is not the only guard.
 */
describeWithEnv('payment purpose, payer, beneficiary and liveMode (Core V2 S4a) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const billing = generateServiceToken();
  const identities: Record<string, AuthIdentity> = { 'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] } };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const server = () => t.app.getHttpServer();
  const create = (b: Row) => request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(b);
  const read = (id: string) => request(server()).get(`/payment/payments/${id}`).set('authorization', `Bearer ${billing.token}`);
  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
  const count = async () => Number((await one('SELECT count(*) FROM payment')).count);
  const events = async (paymentId: string) => (await admin.query(`SELECT name, payload FROM outbox WHERE name LIKE 'payment.%' AND payload->>'paymentId' = $1 ORDER BY "occurredAt", name`, [paymentId])).rows as Row[];

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentpurpose');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
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
    await admin?.end();
    await db?.drop();
  });

  describe('accepted purposes and their payers (ADR-0044 B2)', () => {
    it.each([
      ['organization_subscription paid by a user', { purpose: 'organization_subscription' }],
      ['direct_purchase paid by its beneficiary', { purpose: 'direct_purchase', beneficiaryUserId: BUYER }],
      ['non_entitlement paid by a user', { purpose: 'non_entitlement' }],
      ['non_entitlement paid by a Company', { purpose: 'non_entitlement', payer: { type: 'company', id: 'acme' } }],
    ])('%s: 201, stored and represented with liveMode=false (server-derived), announced in payment.created', async (_n, over) => {
      const b = body(over);
      const r = await create(b);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ purpose: b.purpose, beneficiaryUserId: (b as Row).beneficiaryUserId ?? null, liveMode: false });
      expect((await read(r.body.id).expect(200)).body).toMatchObject({ purpose: b.purpose, liveMode: false });
      expect(await one(`SELECT purpose, "beneficiaryUserId", "liveMode" FROM payment WHERE id = $1`, [r.body.id]))
        .toEqual({ purpose: b.purpose, beneficiaryUserId: (b as Row).beneficiaryUserId ?? null, liveMode: false });
      const [created] = await events(r.body.id);
      expect(created!.payload).toMatchObject({ purpose: b.purpose, liveMode: false });
      if ((b as Row).beneficiaryUserId) expect(created!.payload.beneficiaryUserId).toBe(BUYER);
      else expect(created!.payload).not.toHaveProperty('beneficiaryUserId');
    });
  });

  describe('refusals: nothing is written', () => {
    it.each([
      ['a Company paying an Organization subscription', { payer: { type: 'company', id: 'acme' }, purpose: 'organization_subscription' }],
      ['a Company paying a direct purchase', { payer: { type: 'company', id: 'acme' }, purpose: 'direct_purchase', beneficiaryUserId: 'acme' }],
      ['a direct purchase for someone else (a forged beneficiary)', { purpose: 'direct_purchase', beneficiaryUserId: OTHER_USER }],
    ])('%s: 422 payer_purpose_mismatch', async (_n, over) => {
      const before = await count();
      const r = await create(body(over));
      expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([422, 'payer_purpose_mismatch']);
      expect(await count()).toBe(before);
    });

    it.each([
      ['assisted_settlement', { purpose: 'assisted_settlement', payer: { type: 'organization', id: crypto.randomUUID() }, beneficiaryUserId: BUYER }],
      ['recovery_settlement', { purpose: 'recovery_settlement', payer: { type: 'organization', id: crypto.randomUUID() } }],
      ['an Organization payer for another purpose', { purpose: 'non_entitlement', payer: { type: 'organization', id: crypto.randomUUID() } }],
      ['an Organization paying an Organization subscription', { payer: { type: 'organization', id: crypto.randomUUID() }, purpose: 'organization_subscription' }],
      ['an Organization paying a direct purchase', { payer: { type: 'organization', id: crypto.randomUUID() }, purpose: 'direct_purchase', beneficiaryUserId: BUYER }],
      ['a user paying an assisted settlement', { purpose: 'assisted_settlement', beneficiaryUserId: BUYER }],
    ])('Core V2 S4e (A-5): %s without payment.create.organization_payer is 403 operation_not_permitted, nothing written', async (_n, over) => {
      const before = await count();
      const r = await create(body(over));
      expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([403, 'operation_not_permitted']);
      expect(await count()).toBe(before);
    });

    it.each([
      ['an unknown purpose', { purpose: 'gift' }],
      ['no purpose on a new payment (P-2)', { purpose: undefined }],
      ['a direct purchase without its beneficiary', { purpose: 'direct_purchase' }],
      ['a beneficiary on an ordinary invoice', { purpose: 'non_entitlement', beneficiaryUserId: BUYER }],
      ['a beneficiary on an Organization subscription', { purpose: 'organization_subscription', beneficiaryUserId: BUYER }],
    ])('%s: 400 invalid_payment_request', async (_n, over) => {
      const before = await count();
      const r = await create(body(over));
      expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([400, 'invalid_payment_request']);
      expect(await count()).toBe(before);
    });

    it.each([
      ['liveMode supplied by the client (false)', { liveMode: false }],
      ['liveMode supplied by the client (true)', { liveMode: true }],
      ['a Platform supplied by the client (ADR-0042 DEC-5)', { platformId: crypto.randomUUID() }],
    ])('%s: an unknown field, 400 validation_error (the existing convention for any undeclared field)', async (_n, over) => {
      const before = await count();
      const r = await create(body(over));
      expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([400, 'validation_error']);
      expect(await count()).toBe(before);
    });
  });

  describe('replays, conflicts and concurrency (S-6)', () => {
    it('an identical repeat replays (200 Idempotent-Replayed); another purpose or beneficiary for the same request is 409, never an update', async () => {
      const b = body({ purpose: 'direct_purchase', beneficiaryUserId: BUYER });
      const first = await create(b).expect(201);
      const again = await create(b).expect(200);
      expect([again.headers['idempotent-replayed'], again.body.id]).toEqual(['true', first.body.id]);
      for (const over of [{ purpose: 'non_entitlement', beneficiaryUserId: undefined }, { purpose: 'organization_subscription', beneficiaryUserId: undefined }]) {
        expect((await create({ ...b, ...over })).body.code).toBe('payment_request_conflict');
      }
      expect(await one(`SELECT purpose, "beneficiaryUserId" FROM payment WHERE id = $1`, [first.body.id])).toEqual({ purpose: 'direct_purchase', beneficiaryUserId: BUYER });
    });

    it('8 concurrent identical creates: one 201, seven replays, one row; concurrent different purposes: one wins, the rest 409', async () => {
      const b = body({ purpose: 'organization_subscription' });
      const rs = await Promise.all(Array.from({ length: 8 }, () => create(b)));
      expect(rs.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
      expect(Number((await one(`SELECT count(*) FROM payment WHERE "paymentRequestId" = $1`, [b.paymentRequestId])).count)).toBe(1);

      const c = body({ purpose: 'organization_subscription' });
      const mixed = await Promise.all([...Array.from({ length: 4 }, () => create(c)), ...Array.from({ length: 4 }, () => create({ ...c, purpose: 'non_entitlement' }))]);
      expect(mixed.filter((r) => r.status === 201)).toHaveLength(1);
      const winner = (await one(`SELECT purpose FROM payment WHERE "paymentRequestId" = $1`, [c.paymentRequestId])).purpose;
      for (const r of mixed.filter((x) => x.status !== 201)) expect(r.status === 200 ? r.body.purpose : r.body.code).toBe(r.status === 200 ? winner : 'payment_request_conflict');
    });

    it('a payment created before S4a: a purpose-less repeat replays that historical record unchanged; it is never re-read as purpose-bearing', async () => {
      const b = body({ purpose: undefined });
      const c = await admin.connect();
      try {
        await c.query('SET session_replication_role = replica'); // simulates a pre-S4a row: the insert guard and the default did not exist
        await c.query(`INSERT INTO payment (producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency, "liveMode")
                       VALUES ('billing-service', $1, 'invoice', $2, 'user', $3, 'company', 'nawara-company-reference', 9000, 'TND', NULL)`, [b.paymentRequestId, b.sourceId, BUYER]);
      } finally {
        await c.query('SET session_replication_role = origin');
        c.release();
      }
      const replay = await create(b);
      expect([replay.status, replay.body.purpose, replay.body.liveMode]).toEqual([200, null, null]);
      expect((await create({ ...b, purpose: 'non_entitlement' })).body.code).toBe('payment_request_conflict'); // never upgraded
      expect((await create({ ...b, amount: 1 })).body.code).toBe('invalid_payment_request'); // anything else needs a purpose
      expect(await one(`SELECT purpose, "liveMode" FROM payment WHERE "paymentRequestId" = $1`, [b.paymentRequestId])).toEqual({ purpose: null, liveMode: null });
    });
  });

  describe('liveMode (FC-10 under P-6) and the database guard', () => {
    it('an attempt has its payment\'s mode; the settled event carries purpose and liveMode=false: simulation never presents as live', async () => {
      const p = (await create(body({ purpose: 'direct_purchase', beneficiaryUserId: BUYER })).expect(201)).body;
      const a = await request(server()).post(`/payment/payments/${p.id}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', `k-${crypto.randomUUID()}`)
        .send({ providerOptions: { scenario: 'success' } });
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      expect(await one(`SELECT "liveMode" FROM payment_attempt WHERE "paymentId" = $1`, [p.id])).toEqual({ liveMode: false });
      const names = (await events(p.id)).map((e) => [e.name, e.payload.liveMode, e.payload.purpose]);
      expect(names[0]).toEqual(['payment.created', false, 'direct_purchase']);
      for (const [, live, purpose] of names) expect([live, purpose]).toEqual([false, 'direct_purchase']);
    });

    it('straight at the database: DB-15, the B2 pairings, simulation-only mode and immutability hold whatever path writes', async () => {
      // Core V2 S4e: an Organization payer names itself as organizationId (0016)
      const ins = (payerType: string, payerId: string, purpose: string | null, beneficiary: string | null, live: string = 'DEFAULT') =>
        admin.query(`INSERT INTO payment (producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency, purpose, "beneficiaryUserId", "liveMode")
                     VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', $1, $2, 'company', 'n', $5, 100, 'TND', $3, $4, ${live}) RETURNING id`,
          [payerType, payerId, purpose, beneficiary, payerType === 'organization' && /^[0-9a-f-]{36}$/.test(payerId) ? payerId : null]);
      const refused = async (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: '23514' });
      await refused(ins('organization', 'o', 'non_entitlement', null));
      await refused(ins('user', 'u', 'assisted_settlement', 'u'));
      await refused(ins('user', 'u', 'direct_purchase', 'v'));
      await refused(ins('user', 'u', null, null));
      await refused(ins('user', 'u', 'non_entitlement', null, 'true'));
      const ok = (await ins('organization', crypto.randomUUID(), 'recovery_settlement', null)).rows[0].id; // DB-15 admits it; the API only behind A-5
      for (const set of [`purpose = 'non_entitlement'`, `"beneficiaryUserId" = 'x'`, `"liveMode" = NULL`, `"payerType" = 'user'`]) {
        await refused(admin.query(`UPDATE payment SET ${set} WHERE id = $1`, [ok]));
      }
    });

    it('a production configuration still refuses the test provider (the existing fail-closed boot), so no simulation runs in production', async () => {
      const { loadPaymentConfig } = await import('../src/config/payment-config.js');
      expect(() => loadPaymentConfig({ ...process.env, NODE_ENV: 'production', PAYMENT_TEST_PROVIDER: 'true' })).toThrow(/PAYMENT_TEST_PROVIDER/);
    });
  });
});
