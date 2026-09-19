import { fileURLToPath } from 'node:url';
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
    // expiresAt is immutable once set (FI-02), so to get "still valid when the attempt starts, expired by the time
    // the sweeper runs" without waiting on a real clock elsewhere in the suite, this uses a short future expiry.
    const soon = new Date(Date.now() + 150).toISOString();
    const payment = (await createPayment(soon).expect(201)).body;
    await startAttempt(payment.id, 'expiry-key-1', { scenario: 'timeout_before_accept' }).expect(201);
    await new Promise((r) => setTimeout(r, 200));

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
});
