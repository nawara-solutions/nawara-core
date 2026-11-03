import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { TEST_PLATFORM, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { startFakeReceiptServer, type FakeReceiptServer } from './support/fake-receipts.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '2f1b8d6c-4e3a-4b7c-8d9e-0f1a2b3c4d5e';
const COMPANY = '5b0c2f4e-1d3a-4c6b-8e9f-0a1b2c3d4e5f';
const SECRET = randomBytes(32).toString('hex');
type Row = Record<string, any>;

/**
 * Core V2 S0-C11 item 7c, register PAY-16: the settling-capture read, through the REAL application on real PostgreSQL 16 and the simulation provider
 * (signed notifications, the application's own caller policy). Billing reads its own payments only; everything else is one collapsed answer.
 */
describeWithEnv('settling-capture read (Core V2 S0-C11 7c, PAY-16) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let auth: FakeReceiptServer;
  const billing = generateServiceToken();
  const other = generateServiceToken();
  const noRead = generateServiceToken();
  const harness = generateServiceToken();
  const identities: Record<string, AuthIdentity> = { 'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] } };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const server = () => t.app.getHttpServer();
  const key = () => `k-${randomUUID()}`;
  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;

  const createPayment = async (token = billing.token, over: Row = {}) => {
    const r = await request(server()).post('/payment/payments').set('authorization', `Bearer ${token}`).send({
      paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
      seller: { type: 'company', id: COMPANY }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER, ...over,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as Row;
  };
  const startAttempt = async (pid: string) => (await request(server()).post(`/payment/payments/${pid}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send({}).expect(201)).body;
  const outcome = (pid: string, aid: string, send: Row) => request(server()).post(`/payment/simulation/payments/${pid}/attempts/${aid}/outcomes`)
    .set('authorization', `Bearer ${harness.token}`).send({ commandId: `cmd-${randomUUID()}`, ...send }).expect(201);
  const signed = (body: Row) => {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    return request(server()).post('/payment/webhooks/simulation').set('content-type', 'application/json')
      .set('x-simulation-signature', createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw.toString('utf8'));
  };
  const captureOf = (pid: string) => one(`SELECT * FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture' ORDER BY "observedAt", id LIMIT 1`, [pid]);
  const settled = async (token = billing.token) => {
    const payment = await createPayment(token);
    const attempt = await startAttempt(payment.id);
    await outcome(payment.id, attempt.id, { outcome: 'succeeded' });
    return { payment, attempt, fact: await captureOf(payment.id) };
  };
  const read = (pid: string, token: string | null = billing.token) => {
    const r = request(server()).get(`/payment/payments/${pid}/settling-capture`);
    return token === null ? r : r.set('authorization', `Bearer ${token}`);
  };
  /** What a caller could compare to learn anything: status, code and message, without per-request identifiers. */
  const answer = (r: { status: number; body: Row }) => ({ status: r.status, code: r.body.code, message: r.body.message });
  const writes = async () => one(`SELECT (SELECT count(*) FROM outbox)::int AS outbox, (SELECT count(*) FROM provider_transaction_fact)::int AS facts,
    (SELECT count(*) FROM provider_transaction_fact_conflict)::int AS conflicts, (SELECT count(*) FROM payment_late_success)::int AS late,
    (SELECT count(*) FROM webhook_event)::int AS webhooks, (SELECT max("updatedAt") FROM payment)::text AS touched`);

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentpay16');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 8 });
    auth = await startFakeReceiptServer();
    t = await createTestApp({
      databaseUrl: db.url, authClient, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], refundWorker: false,
      tokens: [{ caller: 'billing-service', digest: billing.digest }, { caller: 'other-producer', digest: other.digest }, { caller: 'no-read-producer', digest: noRead.digest },
        { caller: 'simulation-harness', digest: harness.digest }],
      env: {
        AUTH_SERVICE_URL: auth.url, AUTH_SERVICE_TOKEN: auth.token, PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET,
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.refund.create'], allowedPlatforms: [TEST_PLATFORM] },
          'other-producer': { operations: ['payment.create', 'payment.read'], allowedPlatforms: [TEST_PLATFORM] },
          'no-read-producer': { operations: ['payment.create'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
      },
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await auth?.close();
    await admin?.end();
    await db?.drop();
  });

  describe('the settling capture, derived from committed records', () => {
    it('a succeeded payment: its succeeded attempt\'s single capture fact, as recorded; repeated reads answer the same and write nothing', async () => {
      const s = await settled();
      const before = await writes();
      const r = await read(s.payment.id).expect(200);
      expect(r.body).toEqual({ paymentId: s.payment.id, attemptId: s.attempt.id, factId: s.fact.id, amount: 9000, currency: 'TND', conflicted: false });
      expect(r.headers['cache-control']).toBe('no-store');
      const again = await Promise.all(Array.from({ length: 5 }, () => read(s.payment.id)));
      expect(again.every((a) => a.status === 200 && JSON.stringify(a.body) === JSON.stringify(r.body))).toBe(true);
      expect(await read(s.payment.id.toUpperCase()).expect(200).then((x) => x.body.factId)).toBe(s.fact.id);
      expect(await writes(), 'read-only').toEqual(before);
    });

    it('a contested settling capture is answered as recorded, with conflicted: true; the fact never changes', async () => {
      const s = await settled();
      await signed({ eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: s.attempt.id, providerTransactionId: s.fact.providerTxnId, amount: 4500, currency: 'TND' }).expect(200);
      expect((await read(s.payment.id).expect(200)).body).toMatchObject({ factId: s.fact.id, amount: 9000, conflicted: true });
      expect(await one(`SELECT amount FROM provider_transaction_fact WHERE id = $1`, [s.fact.id])).toEqual({ amount: '9000' });
    });

    it('two capture facts on the settling attempt: 409 settling_capture_ambiguous; neither is preferred', async () => {
      const s = await settled();
      await signed({ eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: s.attempt.id, providerTransactionId: `sim_dup_${randomUUID()}`, amount: 9000, currency: 'TND' }).expect(200);
      const r = await read(s.payment.id);
      expect([r.status, r.body.code]).toEqual([409, 'settling_capture_ambiguous']);
      expect(JSON.stringify(r.body)).not.toContain(s.fact.id);
    });

    it('not succeeded (open, ended, a late capture on an ended payment): 404 settling_capture_not_found', async () => {
      const open = await createPayment();
      await startAttempt(open.id);
      const ended = await createPayment();
      const a = await startAttempt(ended.id);
      await outcome(ended.id, a.id, { outcome: 'expired' });
      await request(server()).post(`/payment/payments/${ended.id}/cancel`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key()).send({}).expect(200);
      await outcome(ended.id, a.id, { outcome: 'succeeded' }); // a late capture: never a settling capture
      for (const id of [open.id, ended.id]) {
        const r = await read(id);
        expect([r.status, r.body.code], id).toEqual([404, 'settling_capture_not_found']);
      }
    });

    it('a legacy settlement with no capture fact (recorded before S4d, reproduced by a superuser bypass): 404 settling_capture_not_found; nothing is manufactured', async () => {
      const p = await createPayment();
      const a = await startAttempt(p.id);
      const cl = await admin.connect();
      try {
        await cl.query(`SET session_replication_role = replica`);
        await cl.query(`UPDATE payment_attempt SET status = 'succeeded', "completedAt" = now() WHERE id = $1`, [a.id]);
        await cl.query(`UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway', "succeededAttemptId" = $2, "closedAt" = now() WHERE id = $1`, [p.id, a.id]);
      } finally {
        await cl.query(`SET session_replication_role = origin`);
        cl.release();
      }
      const r = await read(p.id);
      expect([r.status, r.body.code]).toEqual([404, 'settling_capture_not_found']);
      expect(await one(`SELECT count(*)::int AS n FROM provider_transaction_fact WHERE "paymentId" = $1`, [p.id])).toEqual({ n: 0 });
    });
  });

  describe('authority and isolation', () => {
    it('another producer\'s payment, an unknown id, a malformed id and a caller without payment.read: one collapsed 404 not_found that discloses nothing', async () => {
      const mine = await settled();
      const theirs = await settled(other.token);
      const unknown = answer(await read(randomUUID()));
      expect(unknown).toMatchObject({ status: 404, code: 'not_found' });
      for (const r of [await read(theirs.payment.id), await read('not-a-uuid'), await read(`${randomUUID()}x`), await read(mine.payment.id, noRead.token),
        await read(mine.payment.id, other.token)]) {
        expect(answer(r)).toEqual(unknown);
        for (const secret of [theirs.fact.id, mine.fact.id, theirs.fact.providerTxnId, mine.fact.providerTxnId]) expect(JSON.stringify(r.body)).not.toContain(secret);
      }
      // its own producer reads it
      expect((await read(theirs.payment.id, other.token).expect(200)).body.factId).toBe(theirs.fact.id);
      // payment.read is required even for the caller's OWN payment: a producer without it learns nothing
      const unreadable = await settled(noRead.token);
      expect(answer(await read(unreadable.payment.id, noRead.token))).toEqual(unknown);
    });

    it('no token or an unknown token is 401; a user bearer is not a service', async () => {
      const s = await settled();
      expect((await read(s.payment.id, null)).status).toBe(401);
      expect((await read(s.payment.id, 'not-a-token')).status).toBe(401);
      expect((await read(s.payment.id, 'buyer-jwt')).status).toBe(401);
    });

    it('no route accepts a capture reference: the fact is derived, never named', async () => {
      const s = await settled();
      expect((await request(server()).get(`/payment/payments/${s.payment.id}/settling-capture/${s.fact.id}`).set('authorization', `Bearer ${billing.token}`)).status).toBe(404);
      const withQuery = await request(server()).get(`/payment/payments/${s.payment.id}/settling-capture?factId=${randomUUID()}&amount=1`).set('authorization', `Bearer ${billing.token}`);
      expect(withQuery.body.factId, 'query values are ignored').toBe(s.fact.id);
    });
  });

  describe('a contradiction landing during reads', () => {
    it('every answer is one committed state: either uncontested or contested, always the same fact and figures', async () => {
      const s = await settled();
      const contradiction = signed({ eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: s.attempt.id, providerTransactionId: s.fact.providerTxnId, amount: 4500, currency: 'TND' });
      const reads = Array.from({ length: 10 }, () => read(s.payment.id));
      const [answers] = await Promise.all([Promise.all(reads), contradiction]);
      for (const a of answers) {
        expect(a.status).toBe(200);
        expect(a.body).toMatchObject({ factId: s.fact.id, amount: 9000, currency: 'TND' });
        expect(typeof a.body.conflicted).toBe('boolean');
      }
      expect((await read(s.payment.id).expect(200)).body.conflicted).toBe(true);
    });
  });
});
