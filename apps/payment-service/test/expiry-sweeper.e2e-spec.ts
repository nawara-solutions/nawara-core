import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { ExpirySweeper } from '../src/payments/expiry-sweeper.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

const paymentBody = (expiresAt?: string) => {
  const organizationId = crypto.randomUUID();
  return {
    paymentRequestId: crypto.randomUUID(),
    sourceType: 'invoice',
    sourceId: 'inv-1',
    payer: { type: 'user', id: 'user-1' },
    seller: { type: 'organization', id: organizationId },
    organizationId,
    amount: 1000,
    currency: 'TND',
    ...(expiresAt ? { expiresAt } : {}),
  };
};

describeWithEnv('expiry sweeper (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const billing = generateServiceToken();
  const userIdentity: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const authClient: AuthClient = { getIdentity: async (bearer) => (bearer === 'user-1-jwt' ? userIdentity : null), hasPlatformAccess: async () => false };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'expiryapi');
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
    await t.app.close();
    await db.drop();
  });

  const server = () => t.app.getHttpServer();
  const createPayment = (expiresAt?: string) => request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(paymentBody(expiresAt));
  /** Test-only (V2 A15.3): moves a payment's immutable expiresAt into the past, in one transaction that re-enables the trigger. */
  const expirePaymentNow = async (paymentId: string) => {
    const owner = new pg.Client({ connectionString: db.url });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE payment DISABLE TRIGGER payment_snapshot_immutable');
      const { rowCount } = await owner.query(`UPDATE payment SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`, [paymentId]);
      await owner.query('ALTER TABLE payment ENABLE TRIGGER payment_snapshot_immutable');
      await owner.query('COMMIT');
      expect(rowCount).toBe(1);
    } catch (e) {
      await owner.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await owner.end();
    }
  };
  const startAttempt = (paymentId: string, key: string, providerOptions: Record<string, unknown>) =>
    request(server()).post(`/payment/payments/${paymentId}/attempts`).set('authorization', 'Bearer user-1-jwt').set('idempotency-key', key).send({ providerOptions });
  const getPayment = (paymentId: string) => request(server()).get(`/payment/payments/${paymentId}`).set('authorization', 'Bearer user-1-jwt');

  it('expires a created payment past its expiresAt, and emits payment.expired exactly once', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const payment = (await createPayment(past).expect(201)).body;

    const sweeper = t.app.get(ExpirySweeper);
    const { expired } = await sweeper.sweepOnce();
    expect(expired).toBeGreaterThanOrEqual(1);

    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('expired');
    const rows = (await t.app.get(DbService).query(`SELECT 1 FROM outbox WHERE name = 'payment.expired' AND payload->>'paymentId' = $1`, [payment.id])).rows;
    expect(rows).toHaveLength(1);
  });

  it('never touches a payment with no expiresAt', async () => {
    const payment = (await createPayment().expect(201)).body;
    const sweeper = t.app.get(ExpirySweeper);
    await sweeper.sweepOnce();
    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('created');
  });

  it('refuses to expire a payment with money in flight (an open attempt) until the attempt is resolved', async () => {
    // "Still valid when the attempt starts, expired by the time the sweeper runs", with no clock race (V2 A15.3): the payment is created
    // with a far expiry, so the attempt always starts on a valid payment, and only then is its expiry moved into the past. expiresAt is
    // immutable (FI-02), so this test-only step disables the immutability trigger for that one statement, inside one transaction (the
    // trigger is never off outside it), as the schema owner of this scratch database; the service's own role cannot do it.
    const payment = (await createPayment(new Date(Date.now() + 3_600_000).toISOString()).expect(201)).body;
    await startAttempt(payment.id, 'expiry-key-1', { scenario: 'timeout_before_accept' }).expect(201);
    await expirePaymentNow(payment.id);

    const sweeper = t.app.get(ExpirySweeper);
    await sweeper.sweepOnce();
    const stillOpen = await getPayment(payment.id).expect(200);
    expect(stillOpen.body.status).toBe('pending'); // NOT expired: an attempt is still open
  });

  it('is idempotent: sweeping an already-expired payment again does not re-emit the event', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const payment = (await createPayment(past).expect(201)).body;
    const sweeper = t.app.get(ExpirySweeper);
    await sweeper.sweepOnce();
    await sweeper.sweepOnce();
    const rows = (await t.app.get(DbService).query(`SELECT 1 FROM outbox WHERE name = 'payment.expired' AND payload->>'paymentId' = $1`, [payment.id])).rows;
    expect(rows).toHaveLength(1);
  });

  it('a payment locked by another transaction does not stall the unrelated expired payments; it is expired by a later pass (Stage 15.8, 20 iterations)', async () => {
    const sweeper = t.app.get(ExpirySweeper);
    const expiredEvents = async (id: string) =>
      (await t.app.get(DbService).query(`SELECT 1 FROM outbox WHERE name = 'payment.expired' AND payload->>'paymentId' = $1`, [id])).rows.length;
    for (let i = 0; i < 20; i++) {
      const past = new Date(Date.now() - 60_000).toISOString();
      const ids: string[] = [];
      for (let k = 0; k < 5; k++) ids.push((await createPayment(past).expect(201)).body.id);
      const locked = ids[i % ids.length]!; // the held row sits at a different place among its peers each iteration
      const holder = new pg.Client({ connectionString: db.url });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [locked]);
      try {
        const started = Date.now();
        const pass = sweeper.sweepOnce();
        const finished = await Promise.race([pass.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
        expect(finished).toBe(true); // before Stage 15.8: blocked on the held row until its holder ended
        expect(Date.now() - started).toBeLessThan(3000);
        for (const id of ids) expect((await getPayment(id).expect(200)).body.status).toBe(id === locked ? 'created' : 'expired');
        expect(await expiredEvents(locked)).toBe(0); // nothing decided about the row it could not lock
      } finally {
        await holder.query('COMMIT');
        await holder.end();
      }
      await sweeper.sweepOnce(); // the holder is gone: the next pass expires it, once
      expect((await getPayment(locked).expect(200)).body.status).toBe('expired');
      for (const id of ids) expect(await expiredEvents(id)).toBe(1);
    }
  }, 120_000);
});
