import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { AttemptResolver } from '../src/attempts/attempt-resolver.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

const paymentBody = () => {
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
  };
};

describeWithEnv('attempt resolver (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const billing = generateServiceToken();
  const userIdentity: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const authClient: AuthClient = { getIdentity: async (bearer) => (bearer === 'user-1-jwt' ? userIdentity : null), hasPlatformAccess: async () => false };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'resolverapi');
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
  const createPayment = async () => (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(paymentBody())).body;
  const startAttempt = (paymentId: string, key: string, providerOptions: Record<string, unknown>) =>
    request(server()).post(`/payment/payments/${paymentId}/attempts`).set('authorization', 'Bearer user-1-jwt').set('idempotency-key', key).send({ providerOptions });
  const getPayment = (paymentId: string) => request(server()).get(`/payment/payments/${paymentId}`).set('authorization', 'Bearer user-1-jwt');

  it('settles a stuck "unknown" attempt on its own, without any client calling sync', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'resolver-key-1', { scenario: 'timeout_after_accept' }).expect(201);
    expect(start.body.status).toBe('unknown');

    const resolver = t.app.get(AttemptResolver);
    const { resolved } = await resolver.drainOnce();
    expect(resolved).toBeGreaterThanOrEqual(1);

    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('succeeded');
    expect(after.body.attempts[0].status).toBe('succeeded');
  });

  it('leaves a genuinely still-pending attempt alone (no false resolution)', async () => {
    // "success" scenario is immediately submitted (not stuck) — draining must not touch it.
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'resolver-key-2', { scenario: 'success' }).expect(201);
    expect(start.body.status).toBe('submitted');

    const resolver = t.app.get(AttemptResolver);
    await resolver.drainOnce(); // "submitted" attempts younger than the long-submitted threshold are left alone

    const after = await getPayment(payment.id).expect(200);
    expect(after.body.attempts[0].status).toBe('submitted'); // untouched — still needs a real sync/webhook
  });

  it('is safe to run twice in a row (idempotent — no double effect)', async () => {
    const payment = await createPayment();
    await startAttempt(payment.id, 'resolver-key-3', { scenario: 'timeout_before_accept' }).expect(201);

    const resolver = t.app.get(AttemptResolver);
    await resolver.drainOnce();
    const after1 = await getPayment(payment.id).expect(200);
    await resolver.drainOnce();
    const after2 = await getPayment(payment.id).expect(200);
    expect(after2.body.status).toBe(after1.body.status);
    expect(after2.body.attempts[0].status).toBe(after1.body.attempts[0].status);
  });
});
