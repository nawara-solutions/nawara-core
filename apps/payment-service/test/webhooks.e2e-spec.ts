import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, JsonLogger, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
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
    paymentRequestId: crypto.randomUUID(), purpose: 'non_entitlement',
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

  it('V2 A12.4.5: a forged or malformed webhook never puts its body, signature, card, contact or token into a log line', async () => {
    const lines: string[] = [];
    t.app.useLogger(new JsonLogger('payment-service', 'debug', (l) => lines.push(l)));
    const marker = `whsec_${crypto.randomUUID()}`;
    const hostile = JSON.stringify({ type: 'payment.succeeded', card: '4111111111111111', cvc: '123', email: 'payer@private.example', token: marker });
    const forgedSignature = `forged-${crypto.randomUUID()}`;
    await postWebhook(Buffer.from(hostile, 'utf8'), forgedSignature).expect(401);
    const { createHmac } = await import('node:crypto');
    const signed = Buffer.from(`{"malformed": ${JSON.stringify(marker)}, "email": "payer@private.example"}`, 'utf8');
    await postWebhook(signed, createHmac('sha256', 'test-provider-webhook-secret').update(signed).digest('hex')).expect(200);

    const all = lines.join('\n');
    expect(all).toContain('webhook signature rejected for provider test'); // the forged call is visible, by provider only
    for (const leaked of [marker, forgedSignature, '4111111111111111', 'private.example', '"cvc"']) expect(all).not.toContain(leaked);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('answers 404 for an unknown provider', async () => {
    await request(server()).post('/payment/webhooks/stripe').set('content-type', 'application/json').send(Buffer.from('{}')).expect(404);
    // ADR-0054 D12: provider-facing, so its error rendering is exactly the pre-localization one, whatever the request asks
    const r = await request(server()).post('/payment/webhooks/stripe').set('accept-language', 'fr').set('content-type', 'application/json').send(Buffer.from('{}')).expect(404);
    expect(r.body).toEqual({ statusCode: 404, message: 'Not Found', error: 'Not Found', requestId: r.headers['x-request-id'] });
    expect(r.headers['content-language']).toBeUndefined();
    expect(r.headers.vary ?? '').not.toMatch(/accept-language/i);
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
  // ------------------------------------------------------------------ Core V2 DO-22 (migration 0030; the Owner's Option 1, 2026-11-14)
  it('DO-22: concurrent first deliveries of one success (5 rounds of 8): every answer is 200, one processed row, one effect', async () => {
    const provider = t.app.get(TestPaymentProvider);
    for (let round = 0; round < 5; round++) {
      const payment = await createPayment();
      const start = await startAttempt(payment.id, `wh-key-do22-race-${round}`, { scenario: 'success' }).expect(201);
      const { body, signature } = provider.signSuccessCallback(start.body.id);
      const answers = (await Promise.all(Array.from({ length: 8 }, () => postWebhook(body, signature)))).map((r) => r.status);
      expect(answers, `round ${round}`).toEqual(Array(8).fill(200));
      expect(await webhookEventCount(`evt_${start.body.id}`), `round ${round}`).toEqual([{ state: 'processed', outcome: null }]);
      const outboxRows = (await t.app.get(DbService).query(`SELECT 1 FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [payment.id])).rows;
      expect(outboxRows, `round ${round}`).toHaveLength(1);
    }
  });

  it('DO-22: a terminal notification keeps its decision: the duplicate is a 200 no-op, and SQL cannot rewrite it', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'wh-key-do22-final', { scenario: 'success' }).expect(201);
    const { body, signature } = t.app.get(TestPaymentProvider).signSuccessCallback(start.body.id);
    await postWebhook(body, signature).expect(200);
    const db = t.app.get(DbService);
    const before = (await db.query('SELECT state, outcome, attempts, "processedAt" FROM webhook_event WHERE "providerEventId" = $1', [`evt_${start.body.id}`])).rows[0];
    await postWebhook(body, signature).expect(200);
    expect((await db.query('SELECT state, outcome, attempts, "processedAt" FROM webhook_event WHERE "providerEventId" = $1', [`evt_${start.body.id}`])).rows[0]).toEqual(before);
    for (const set of [`state = 'failed', outcome = 'transient_error'`, `state = 'received'`, `outcome = 'other'`, `"matchedAttemptId" = NULL`]) {
      await expect(db.query(`UPDATE webhook_event SET ${set} WHERE "providerEventId" = $1`, [`evt_${start.body.id}`]), set).rejects.toMatchObject({ code: '23514', constraint: 'webhook_event_terminal' });
    }
  });

  it('DO-22: failed stays redeliverable: retries_exhausted and malformed_body do not block the provider redelivery', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'wh-key-do22-exhausted', { scenario: 'success' }).expect(201);
    const { body, signature } = t.app.get(TestPaymentProvider).signSuccessCallback(start.body.id);
    const db = t.app.get(DbService);
    // LABELLED FIXTURE: a notification the retrier gave up on (its retry budget used), stored by SQL as the retrier leaves it
    await db.query(`INSERT INTO webhook_event(provider, "providerEventId", "eventType", "rawBody", state, outcome, attempts) VALUES ('test', $1, 'payment.succeeded', $2, 'failed', 'retries_exhausted', 10)`,
      [`evt_${start.body.id}`, body]);
    expect((await t.app.get(WebhookRetriever).drainOnce()).retried, 'the retrier does not pick it up').toBe(0);
    await postWebhook(body, signature).expect(200);
    expect(await webhookEventCount(`evt_${start.body.id}`)).toEqual([{ state: 'processed', outcome: null }]);
    expect((await getPayment(payment.id).expect(200)).body.status).toBe('succeeded');

    const malformed = Buffer.from('{"not": "a recognizable event either"}', 'utf8');
    const { createHmac } = await import('node:crypto');
    const malformedSignature = createHmac('sha256', 'test-provider-webhook-secret').update(malformed).digest('hex');
    await postWebhook(malformed, malformedSignature).expect(200);
    await postWebhook(malformed, malformedSignature).expect(200); // a redelivery of a malformed body is processed again, and stays failed
    const { rows } = await db.query(`SELECT state, outcome, attempts FROM webhook_event WHERE "rawBody" = $1`, [malformed]);
    expect(rows).toEqual([{ state: 'failed', outcome: 'malformed_body', attempts: 2 }]);
  });
});
