import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { AttemptResolver } from '../src/attempts/attempt-resolver.js';
import { AttemptService } from '../src/attempts/attempt.service.js';
import { ExpirySweeper } from '../src/payments/expiry-sweeper.js';
import { ProviderRegistry } from '../src/providers/provider-registry.js';
import { TestPaymentProvider } from '../src/providers/test-provider.js';
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

/** The four concurrency scenarios the Phase 1 brief requires, beyond the ones already covered inline elsewhere
 * (double-start-attempt lives in attempts.e2e-spec.ts; concurrent identical payment creates live in
 * payments.e2e-spec.ts and db/tests/run.sh). */
describeWithEnv('required concurrency scenarios (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const billing = generateServiceToken();
  const userIdentity: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const authClient: AuthClient = { getIdentity: async (bearer) => (bearer === 'user-1-jwt' ? userIdentity : null), hasPlatformAccess: async () => false };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'concurrencyapi');
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
  const postWebhook = (body: Buffer, signature: string) =>
    request(server()).post('/payment/webhooks/test').set('content-type', 'application/json').set('x-test-provider-signature', signature).send(body.toString('utf8'));
  const outboxCount = async (name: string, paymentId: string) =>
    (await t.app.get(DbService).query(`SELECT 1 FROM outbox WHERE name = $1 AND payload->>'paymentId' = $2`, [name, paymentId])).rows.length;

  it('1. double start: two concurrent start-attempt requests on the same payment give one open attempt, one 409', async () => {
    const payment = (await createPayment().expect(201)).body;
    const responses = await Promise.all([
      startAttempt(payment.id, 'race-double-1', { scenario: 'timeout_before_accept' }),
      startAttempt(payment.id, 'race-double-2', { scenario: 'timeout_before_accept' }),
    ]);
    const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const after = await getPayment(payment.id).expect(200);
    expect(after.body.attempts).toHaveLength(1);
  });

  it('2. duplicate success: concurrent delivery of the SAME signed webhook settles the payment exactly once', async () => {
    const payment = (await createPayment().expect(201)).body;
    const start = (await startAttempt(payment.id, 'race-dup-success-1', { scenario: 'success' }).expect(201)).body;
    const provider = t.app.get(TestPaymentProvider);
    const { body, signature } = provider.signSuccessCallback(start.id);

    const responses = await Promise.all([postWebhook(body, signature), postWebhook(body, signature), postWebhook(body, signature)]);
    expect(responses.every((r) => r.status === 200)).toBe(true);

    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('succeeded');
    expect(await outboxCount('payment.succeeded', payment.id)).toBe(1); // exactly one financial side effect
  });

  it('3. expiry vs. success race: whichever wins the row lock, the end state is consistent (never both, never neither)', async () => {
    // Enough margin that creating the payment and starting its attempt always happen BEFORE expiry, even on a slow CI runner
    // (a 100 ms margin once made the attempt itself fail with 409 payment_expired).
    const soon = new Date(Date.now() + 2000).toISOString();
    const payment = (await createPayment(soon).expect(201)).body;
    const start = (await startAttempt(payment.id, 'race-expiry-1', { scenario: 'timeout_after_accept' }).expect(201)).body; // 'unknown', open
    // Then wait until the payment is genuinely past expiresAt by the DATABASE clock (the only clock, SDD section 12), attempt still open.
    const expiredByDb = async () =>
      (await t.app.get(DbService).query<{ due: boolean }>(`SELECT "expiresAt" <= now() AS due FROM payment WHERE id = $1`, [payment.id])).rows[0]?.due === true;
    for (let waited = 0; !(await expiredByDb()); waited += 50) {
      if (waited > 10_000) throw new Error('the payment never reached its expiresAt by the database clock');
      await new Promise((r) => setTimeout(r, 50));
    }

    const sweeper = t.app.get(ExpirySweeper);
    const attempts = t.app.get(AttemptService);
    const providers = t.app.get(ProviderRegistry);
    const provider = providers.get('test');

    await Promise.all([sweeper.sweepOnce(), attempts.applyStatus(start.id, { kind: 'succeeded', amount: 1000, currency: 'TND' }, provider)]);

    // The open-attempt guard means expiry can never win this race while the attempt is still open: the only
    // consistent outcome is succeeded, regardless of which transaction's row lock was granted first.
    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('succeeded');
    expect(await outboxCount('payment.succeeded', payment.id)).toBe(1);
    expect(await outboxCount('payment.expired', payment.id)).toBe(0);
  });

  it('4. webhook vs. resolver race: both try to settle the same stuck attempt at once, with one effect and no contradiction', async () => {
    const payment = (await createPayment().expect(201)).body;
    const start = (await startAttempt(payment.id, 'race-webhook-resolver-1', { scenario: 'timeout_after_accept' }).expect(201)).body; // 'unknown'
    const provider = t.app.get(TestPaymentProvider);
    const { body, signature } = provider.signSuccessCallback(start.id);
    const resolver = t.app.get(AttemptResolver); // polls fetchStatus directly on stuck attempts, same as sync would

    await Promise.all([postWebhook(body, signature), resolver.drainOnce()]);

    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('succeeded');
    expect(after.body.attempts[0].status).toBe('succeeded');
    expect(await outboxCount('payment.succeeded', payment.id)).toBe(1); // no double settlement from the two racing paths
  });
});
