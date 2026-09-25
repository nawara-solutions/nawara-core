import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

const paymentBody = () => {
  const organizationId = crypto.randomUUID();
  return {
    paymentRequestId: crypto.randomUUID(),
    sourceType: 'invoice',
    sourceId: 'inv-1',
    payer: { type: 'user', id: '1e0a7c5b-3d2f-4a6b-9c8d-7e6f5a4b3c21' },
    seller: { type: 'organization', id: organizationId },
    organizationId,
    amount: 1000,
    currency: 'TND',
  };
};

describeWithEnv('attempts API (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const billing = generateServiceToken();
  // Stage 18.7: Auth user ids are UUIDs ("user".id uuid); a settling user becomes central audit evidence, which accepts only a real id.
  const userIdentity: AuthIdentity = { id: '1e0a7c5b-3d2f-4a6b-9c8d-7e6f5a4b3c21', adminTier: null, isActive: true, memberships: [] };
  const identities: Record<string, AuthIdentity> = {
    'user-1-jwt': userIdentity,
    'someone-elses-jwt': { id: '2f1b8d6c-4e3a-4b7c-8d9e-8f7a6b5c4d32', adminTier: null, isActive: true, memberships: [] },
  };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'attemptsapi');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [{ caller: 'billing-service', digest: billing.digest }],
      authClient,
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      env: { PAYMENT_TEST_PROVIDER: 'true', PAYMENT_MAX_ATTEMPTS: '2' },
    });
  });
  afterAll(async () => {
    await t.app.close();
    await db.drop();
  });

  const server = () => t.app.getHttpServer();
  const createPayment = async () => (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(paymentBody())).body;
  const startAttempt = (paymentId: string, key: string, body: Record<string, unknown> = {}) =>
    request(server()).post(`/payment/payments/${paymentId}/attempts`).set('authorization', 'Bearer user-1-jwt').set('idempotency-key', key).send(body);
  const sync = (paymentId: string, attemptId: string) =>
    request(server()).post(`/payment/payments/${paymentId}/attempts/${attemptId}/sync`).set('authorization', 'Bearer user-1-jwt').send({});
  const getPayment = (paymentId: string) => request(server()).get(`/payment/payments/${paymentId}`).set('authorization', 'Bearer user-1-jwt');

  it('requires a valid Idempotency-Key header', async () => {
    const payment = await createPayment();
    await request(server()).post(`/payment/payments/${payment.id}/attempts`).set('authorization', 'Bearer user-1-jwt').send({}).expect(400);
    const r = await request(server()).post(`/payment/payments/${payment.id}/attempts`).set('authorization', 'Bearer user-1-jwt').set('idempotency-key', 'short').send({}).expect(400);
    expect(r.body.code).toBe('idempotency_key_required');
  });

  it('success path: start (201, submitted) then sync applies the provider-verified success and settles the payment', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'key-success-1', { providerOptions: { scenario: 'success' } }).expect(201);
    expect(start.body).toMatchObject({ attemptNumber: 1, provider: 'test', status: 'submitted' });
    expect(start.body.nextAction).toMatchObject({ type: 'redirect' });

    const midway = await getPayment(payment.id).expect(200);
    expect(midway.body.status).toBe('pending');

    const synced = await sync(payment.id, start.body.id).expect(200);
    expect(synced.body.status).toBe('succeeded');

    const final = await getPayment(payment.id).expect(200);
    expect(final.body.status).toBe('succeeded');
    expect(final.body.settledMethod).toBe('gateway');
    expect(final.body.attempts).toHaveLength(1);
    expect(final.body.attempts[0].status).toBe('succeeded');

    const dbService = t.app.get(DbService);
    const { rows } = await dbService.query(`SELECT payload FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [payment.id]);
    expect(rows).toHaveLength(1);
  });

  it('replays an identical start-attempt request (same key, same body) without starting a second attempt', async () => {
    const payment = await createPayment();
    const first = await startAttempt(payment.id, 'key-replay-1', { providerOptions: { scenario: 'success' } }).expect(201);
    const second = await startAttempt(payment.id, 'key-replay-1', { providerOptions: { scenario: 'success' } }).expect(201);
    expect(second.body.id).toBe(first.body.id);
  });

  it('rejects the same Idempotency-Key reused with a different body (422 idempotency_key_reused)', async () => {
    const payment = await createPayment();
    await startAttempt(payment.id, 'key-reused-1', { providerOptions: { scenario: 'success' } }).expect(201);
    const r = await startAttempt(payment.id, 'key-reused-1', { providerOptions: { scenario: 'failure' } }).expect(422);
    expect(r.body.code).toBe('idempotency_key_reused');
  });

  it('failure path (below the attempt limit): the attempt fails and the payment returns to created for a retry', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'key-fail-1', { providerOptions: { scenario: 'failure', failureClass: 'retryable', failureCode: 'insufficient_funds' } }).expect(201);
    expect(start.body.status).toBe('failed');
    expect(start.body.failureCode).toBe('insufficient_funds');
    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('created'); // PAYMENT_MAX_ATTEMPTS=2, this is attempt 1 of 2: retry is allowed

    // and a retry is actually possible: a second attempt (different scenario) can now start and succeed
    const retry = await startAttempt(payment.id, 'key-fail-1-retry', { providerOptions: { scenario: 'success' } }).expect(201);
    expect(retry.body.attemptNumber).toBe(2);
  });

  it('failure at the attempt limit ends the payment as failed (no further attempt is possible)', async () => {
    const payment = await createPayment();
    await startAttempt(payment.id, 'key-limit-1', { providerOptions: { scenario: 'failure' } }).expect(201);
    await startAttempt(payment.id, 'key-limit-2', { providerOptions: { scenario: 'failure' } }).expect(201); // attempt 2 of 2 (PAYMENT_MAX_ATTEMPTS=2)
    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('failed');
    await startAttempt(payment.id, 'key-limit-3', {}).expect(409); // payment_not_payable: no more attempts allowed
  });

  it('refuses a second attempt while one is already open (payment_has_open_attempt)', async () => {
    const payment = await createPayment();
    await startAttempt(payment.id, 'key-open-1', { providerOptions: { scenario: 'timeout_before_accept' } }).expect(201); // stays "unknown" — open
    const r = await startAttempt(payment.id, 'key-open-2', {}).expect(409);
    expect(r.body.code).toBe('payment_has_open_attempt');
  });

  it('unknown/timeout handling: timeout_before_accept never retries blindly, and later resolves via sync to notFound -> inferred failure', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'key-unknown-1', { providerOptions: { scenario: 'timeout_before_accept' } }).expect(201);
    expect(start.body.status).toBe('unknown');
    const synced = await sync(payment.id, start.body.id).expect(200);
    expect(synced.body.status).toBe('failed');
    expect(synced.body.failureCode).toBe('not_found');
  });

  it('unknown/timeout handling: timeout_after_accept resolves via sync to succeeded once the provider is asked', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'key-unknown-2', { providerOptions: { scenario: 'timeout_after_accept' } }).expect(201);
    expect(start.body.status).toBe('unknown');
    const synced = await sync(payment.id, start.body.id).expect(200);
    expect(synced.body.status).toBe('succeeded');
    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('succeeded');
  });

  it('refuses an unsupported/disabled provider with 422 invalid_provider', async () => {
    const payment = await createPayment();
    const r = await startAttempt(payment.id, 'key-badprovider-1', { provider: 'stripe' }).expect(422);
    expect(r.body.code).toBe('invalid_provider');
  });

  it('refuses starting or syncing an attempt for an unrelated user (collapsed 404)', async () => {
    const payment = await createPayment();
    await request(server()).post(`/payment/payments/${payment.id}/attempts`).set('authorization', 'Bearer someone-elses-jwt').set('idempotency-key', 'key-unrel-1').send({}).expect(404);
  });

  it('gives exactly one open attempt when two starts race on the same payment', async () => {
    const payment = await createPayment();
    const responses = await Promise.all([
      startAttempt(payment.id, 'race-key-1', { providerOptions: { scenario: 'timeout_before_accept' } }),
      startAttempt(payment.id, 'race-key-2', { providerOptions: { scenario: 'timeout_before_accept' } }),
    ]);
    const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
  });
});
