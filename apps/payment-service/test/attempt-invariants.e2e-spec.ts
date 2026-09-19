import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { AttemptService } from '../src/attempts/attempt.service.js';
import { ProviderRegistry } from '../src/providers/provider-registry.js';
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

describeWithEnv('financial invariants FI-12/FI-13 (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const billing = generateServiceToken();
  const userIdentity: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const authClient: AuthClient = { getIdentity: async (bearer) => (bearer === 'user-1-jwt' ? userIdentity : null), hasPlatformAccess: async () => false };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'invariantsapi');
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

  it('FI-13: a provider success reporting a different amount than the snapshot is refused, not applied', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'fi13-key-1', { scenario: 'success_amount_mismatch' }).expect(201);
    expect(start.body.status).toBe('submitted');

    const attempts = t.app.get(AttemptService);
    const providers = t.app.get(ProviderRegistry);
    const provider = providers.get('test');
    const status = await provider.fetchStatus(start.body.id);
    await expect(attempts.applyStatus(start.body.id, status, provider)).rejects.toMatchObject({ status: 502, response: { code: 'provider_error' } });

    // Neither the attempt nor the payment silently moved to succeeded.
    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('pending');
    expect(after.body.attempts[0].status).toBe('submitted');
  });

  it('late success is ACCEPTED after an inferred failure (a guess), and settles the payment', async () => {
    const payment = await createPayment();
    // timeout_before_accept -> attempt goes to 'unknown'; syncing then infers failure from a notFound answer.
    const start = await startAttempt(payment.id, 'fi12-key-1', { scenario: 'timeout_before_accept' }).expect(201);
    await request(server()).post(`/payment/payments/${payment.id}/attempts/${start.body.id}/sync`).set('authorization', 'Bearer user-1-jwt').send({}).expect(200);
    const afterInferredFailure = await getPayment(payment.id).expect(200);
    expect(afterInferredFailure.body.attempts[0].status).toBe('failed'); // failureInferred = true internally

    // The provider now reports success for the SAME reference — this is legitimately possible: the inferred
    // failure was only a guess, and a later fact from the provider wins (SDD section 5.1).
    const attempts = t.app.get(AttemptService);
    const providers = t.app.get(ProviderRegistry);
    const provider = providers.get('test');
    const updated = await attempts.applyStatus(start.body.id, { kind: 'succeeded', amount: 1000, currency: 'TND' }, provider);
    expect(updated.status).toBe('succeeded');

    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('succeeded');
  });

  it('late success is REJECTED after a provider-CONFIRMED failure (a real conflict, not a guess)', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'fi12-key-2', { scenario: 'failure', failureClass: 'terminal', failureCode: 'card_declined' }).expect(201);
    expect(start.body.status).toBe('failed'); // provider itself confirmed the failure synchronously — never inferred

    const attempts = t.app.get(AttemptService);
    const providers = t.app.get(ProviderRegistry);
    const provider = providers.get('test');
    await expect(attempts.applyStatus(start.body.id, { kind: 'succeeded', amount: 1000, currency: 'TND' }, provider)).rejects.toMatchObject({
      status: 409,
      response: { code: 'invalid_state_transition' },
    });

    const after = await getPayment(payment.id).expect(200);
    expect(after.body.attempts[0].status).toBe('failed'); // unchanged: the conflict was refused, not silently applied
  });
});
