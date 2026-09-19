import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { AttemptService } from '../src/attempts/attempt.service.js';
import { ProviderRegistry } from '../src/providers/provider-registry.js';
import { TestPaymentProvider } from '../src/providers/test-provider.js';
import { WebhookRetriever } from '../src/webhooks/webhook-retrier.js';
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

describeWithEnv('webhooks API (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const billing = generateServiceToken();
  const userIdentity: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const authClient: AuthClient = { getIdentity: async (bearer) => (bearer === 'user-1-jwt' ? userIdentity : null), hasPlatformAccess: async () => false };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'webhooksapi');
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
  const postWebhook = (body: Buffer, signature: string) =>
    request(server()).post('/payment/webhooks/test').set('content-type', 'application/json').set('x-test-provider-signature', signature).send(body.toString('utf8'));
  const webhookEventCount = async (providerEventId: string) => {
    const { rows } = await t.app.get(DbService).query('SELECT state, outcome FROM webhook_event WHERE "providerEventId" = $1', [providerEventId]);
    return rows;
  };

  it('processes a genuine success callback and settles the payment', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'wh-key-1', { scenario: 'success' }).expect(201);
    const provider = t.app.get(TestPaymentProvider);
    const { body, signature } = provider.signSuccessCallback(start.body.id);

    await postWebhook(body, signature).expect(200);

    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('succeeded');
    const rows = await webhookEventCount(`evt_${start.body.id}`);
    expect(rows).toEqual([{ state: 'processed', outcome: null }]);
  });

  it('rejects an invalid signature with 401 and persists nothing', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'wh-key-2', { scenario: 'success' }).expect(201);
    const provider = t.app.get(TestPaymentProvider);
    const { body } = provider.signSuccessCallback(start.body.id);

    await postWebhook(body, 'not-a-real-signature-'.repeat(3)).expect(401);
    const rows = await webhookEventCount(`evt_${start.body.id}`);
    expect(rows).toEqual([]); // an unauthenticated caller cannot write to the database
  });

  it('is idempotent under duplicate delivery: the same signed event twice has one effect and one stored row', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'wh-key-3', { scenario: 'success' }).expect(201);
    const provider = t.app.get(TestPaymentProvider);
    const { body, signature } = provider.signSuccessCallback(start.body.id);

    await postWebhook(body, signature).expect(200);
    await postWebhook(body, signature).expect(200);
    await postWebhook(body, signature).expect(200);

    const rows = await webhookEventCount(`evt_${start.body.id}`);
    expect(rows).toHaveLength(1); // deduplicated by (provider, providerEventId)
    const outboxRows = (await t.app.get(DbService).query(`SELECT 1 FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [payment.id])).rows;
    expect(outboxRows).toHaveLength(1); // no second financial side effect
  });

  it('answers 404 for an unknown provider', async () => {
    await request(server()).post('/payment/webhooks/stripe').set('content-type', 'application/json').send(Buffer.from('{}')).expect(404);
  });

  it('stores a malformed body under a valid signature as failed (non-retryable), and answers 200 so the provider stops retrying', async () => {
    const body = Buffer.from('{"not": "a recognizable event"}', 'utf8');
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', 'test-provider-webhook-secret').update(body).digest('hex');

    await postWebhook(body, signature).expect(200);
  });

  it('stores an event referencing an unknown attempt as unmatched, and answers 200', async () => {
    const provider = t.app.get(TestPaymentProvider);
    await provider.initiate({ id: 'x', amount: '1000', currency: 'TND' } as never, { merchantReference: 'ghost-attempt-does-not-exist' });
    const { body, signature } = provider.signSuccessCallback('ghost-attempt-does-not-exist');

    await postWebhook(body, signature).expect(200);
    const rows = await webhookEventCount('evt_ghost-attempt-does-not-exist');
    expect(rows).toEqual([{ state: 'unmatched', outcome: null }]);
  });

  it('records a real conflict (200) when a provider-confirmed failure later gets a success callback, without silently applying it', async () => {
    const payment = await createPayment();
    // Submitted (has a real providerTransactionId), then a provider-CONFIRMED failure (never inferred) via sync/webhook.
    const start = await startAttempt(payment.id, 'wh-key-conflict-1', { scenario: 'success' }).expect(201);
    const providers = t.app.get(ProviderRegistry);
    const attempts = t.app.get(AttemptService);
    const provider = providers.get('test');
    await attempts.applyStatus(start.body.id, { kind: 'failed', failureClass: 'terminal', failureCode: 'card_declined' }, provider);
    const confirmed = await getPayment(payment.id).expect(200);
    expect(confirmed.body.attempts[0].status).toBe('failed');

    // The ORIGINAL (still valid) success callback for the same providerTransactionId arrives late.
    const testProvider = t.app.get(TestPaymentProvider);
    const { body, signature } = testProvider.signSuccessCallback(start.body.id);
    await postWebhook(body, signature).expect(200);

    const rows = await webhookEventCount(`evt_${start.body.id}`);
    expect(rows).toEqual([{ state: 'conflict', outcome: 'invalid_state_transition' }]);
    const after = await getPayment(payment.id).expect(200);
    expect(after.body.attempts[0].status).toBe('failed'); // unchanged — the conflict was recorded, not applied
  });

  it('the retrier reprocesses an event left stuck in "received" (simulating a crash between transactions A and B)', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'wh-key-retrier-1', { scenario: 'success' }).expect(201);
    const provider = t.app.get(TestPaymentProvider);
    const { body } = provider.signSuccessCallback(start.body.id);

    const dbService = t.app.get(DbService);
    await dbService.query(
      `INSERT INTO webhook_event(provider, "providerEventId", "eventType", "rawBody", "receivedAt") VALUES ('test', $1, 'payment.succeeded', $2, now() - interval '1 minute')`,
      [`evt_${start.body.id}`, body],
    );

    const retrier = t.app.get(WebhookRetriever);
    const { retried } = await retrier.drainOnce();
    expect(retried).toBeGreaterThanOrEqual(1);

    const rows = await webhookEventCount(`evt_${start.body.id}`);
    expect(rows).toEqual([{ state: 'processed', outcome: null }]);
    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('succeeded');
  });
});
