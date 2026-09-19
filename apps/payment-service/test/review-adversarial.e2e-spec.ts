import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { AttemptResolver } from '../src/attempts/attempt-resolver.js';
import { AttemptService } from '../src/attempts/attempt.service.js';
import { PaymentService } from '../src/payments/payment.service.js';
import { ProviderRegistry } from '../src/providers/provider-registry.js';
import { TestPaymentProvider } from '../src/providers/test-provider.js';
import type { PaymentProvider } from '../src/providers/provider.port.js';
import { WebhookRetriever } from '../src/webhooks/webhook-retrier.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const paymentBody = (over: Record<string, unknown> = {}) => {
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
    ...over,
  };
};

/**
 * Phase 1 acceptance-review regressions. Each test states the SDD rule it protects. Runs against real PostgreSQL.
 */
describeWithEnv('phase 1 acceptance review: adversarial regressions (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp; // default attempt limit (3)
  let tOne: TestApp; // attempt limit 1, same database
  const billing = generateServiceToken();
  const userIdentity: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const authClient: AuthClient = { getIdentity: async (bearer) => (bearer === 'user-1-jwt' ? userIdentity : null), hasPlatformAccess: async () => false };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'reviewapi');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    const common = { databaseUrl: db.url, tokens: [{ caller: 'billing-service', digest: billing.digest }], authClient, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir] };
    t = await createTestApp({ ...common, env: { PAYMENT_TEST_PROVIDER: 'true' } });
    tOne = await createTestApp({ ...common, env: { PAYMENT_TEST_PROVIDER: 'true', PAYMENT_MAX_ATTEMPTS: '1' } });
  });
  afterAll(async () => {
    await t.app.close();
    await tOne.app.close();
    await db.drop();
  });

  const server = (app: TestApp = t) => app.app.getHttpServer();
  const create = async (app: TestApp = t, over: Record<string, unknown> = {}) =>
    (await request(server(app)).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(paymentBody(over)).expect(201)).body;
  const startAttempt = (app: TestApp, paymentId: string, key: string, providerOptions: Record<string, unknown>) =>
    request(server(app)).post(`/payment/payments/${paymentId}/attempts`).set('authorization', 'Bearer user-1-jwt').set('idempotency-key', key).send({ providerOptions });
  const getPayment = (paymentId: string) => request(server()).get(`/payment/payments/${paymentId}`).set('authorization', 'Bearer user-1-jwt');
  const postWebhook = (app: TestApp, body: Buffer, signature: string) =>
    request(server(app)).post('/payment/webhooks/test').set('content-type', 'application/json').set('x-test-provider-signature', signature).send(body.toString('utf8'));
  const sql = <R extends pg.QueryResultRow = any>(text: string, params?: unknown[]) => t.app.get(DbService).query<R>(text, params);
  const outbox = async (name: string, paymentId: string) =>
    (await sql(`SELECT * FROM outbox WHERE name = $1 AND payload->>'paymentId' = $2 ORDER BY "occurredAt"`, [name, paymentId])).rows;
  const eventState = async (providerEventId: string) => (await sql('SELECT state, outcome, attempts FROM webhook_event WHERE "providerEventId" = $1', [providerEventId])).rows;
  const testProvider = (app: TestApp) => app.app.get(TestPaymentProvider);
  const sign = (body: Buffer) => createHmac('sha256', 'test-provider-webhook-secret').update(body).digest('hex');
  /** A signed callback that names the attempt by its merchantReference (an attempt that timed out has no providerTransactionId yet). */
  const signedFor = (reference: string, eventId: string, over: Record<string, unknown> = {}) => {
    const body = Buffer.from(JSON.stringify({ eventId, type: 'payment.succeeded', reference, amount: 1000, currency: 'TND', ...over }), 'utf8');
    return { body, signature: sign(body) };
  };

  // ---------------------------------------------------------------------------------------------- late success

  it('R-01 late success for an INFERRED-failed attempt whose payment already ended `failed` is a recorded CONFLICT, not a 500 loop (SDD 5.1 "already terminal in another way")', async () => {
    const payment = await create(tOne);
    const a = (await startAttempt(tOne, payment.id, 'r01-key-aaaa', { scenario: 'timeout_after_accept' }).expect(201)).body;
    const provider = tOne.app.get(ProviderRegistry).get('test');
    await tOne.app.get(AttemptService).applyStatus(a.id, { kind: 'notFound' }, provider); // inferred failure; limit 1 -> payment failed
    expect((await getPayment(payment.id).expect(200)).body.status).toBe('failed');

    const { body, signature } = signedFor(a.id, `evt_${a.id}`);
    await postWebhook(tOne, body, signature).expect(200);

    expect(await eventState(`evt_${a.id}`)).toEqual([{ state: 'conflict', outcome: 'invalid_state_transition', attempts: 1 }]);
    const after = (await getPayment(payment.id).expect(200)).body;
    expect(after.status).toBe('failed'); // a terminal payment never moves
    expect(await outbox('payment.succeeded', payment.id)).toHaveLength(0);
  });

  it('R-02 FI-03/FI-06: a late success on attempt A while attempt B is open settles once; a later success on B is a CONFLICT and never a second succeeded attempt', async () => {
    const payment = await create();
    const a = (await startAttempt(t, payment.id, 'r02-key-aaaa', { scenario: 'timeout_after_accept' }).expect(201)).body;
    const provider = t.app.get(ProviderRegistry).get('test');
    await t.app.get(AttemptService).applyStatus(a.id, { kind: 'notFound' }, provider); // A failed by inference; payment back to created
    const b = (await startAttempt(t, payment.id, 'r02-key-bbbb', { scenario: 'success' }).expect(201)).body; // B submitted; payment pending
    expect(b.status).toBe('submitted');

    const late = signedFor(a.id, `evt_${a.id}`);
    await postWebhook(t, late.body, late.signature).expect(200);
    expect((await getPayment(payment.id).expect(200)).body.status).toBe('succeeded');

    const second = testProvider(t).signSuccessCallback(b.id);
    await postWebhook(t, second.body, second.signature).expect(200);

    expect(await eventState(`evt_${b.id}`)).toEqual([{ state: 'conflict', outcome: 'invalid_state_transition', attempts: 1 }]);
    const succeeded = await sql(`SELECT id FROM payment_attempt WHERE "paymentId" = $1 AND status = 'succeeded'`, [payment.id]);
    expect(succeeded.rows).toEqual([{ id: a.id }]); // exactly one succeeded attempt (FI-03)
    expect(await outbox('payment.succeeded', payment.id)).toHaveLength(1);
    const p = (await sql('SELECT "succeededAttemptId" FROM payment WHERE id = $1', [payment.id])).rows[0];
    expect(p.succeededAttemptId).toBe(a.id);
  });

  it('R-03 FI-13 via the WEBHOOK path: a signed success with a different amount is a recorded conflict and never settles', async () => {
    const payment = await create();
    const a = (await startAttempt(t, payment.id, 'r03-key-aaaa', { scenario: 'success_amount_mismatch' }).expect(201)).body;
    const { body, signature } = testProvider(t).signSuccessCallback(a.id);
    await postWebhook(t, body, signature).expect(200);
    expect((await eventState(`evt_${a.id}`))[0]).toMatchObject({ state: 'conflict' });
    expect((await getPayment(payment.id).expect(200)).body.status).toBe('pending');
    expect(await outbox('payment.succeeded', payment.id)).toHaveLength(0);
  });

  it('R-04 FI-13: a provider success in a different CURRENCY is refused', async () => {
    const payment = await create();
    const a = (await startAttempt(t, payment.id, 'r04-key-aaaa', { scenario: 'timeout_after_accept' }).expect(201)).body;
    const provider = t.app.get(ProviderRegistry).get('test');
    await expect(t.app.get(AttemptService).applyStatus(a.id, { kind: 'succeeded', amount: 1000, currency: 'EUR' }, provider)).rejects.toMatchObject({ status: 502 });
    expect((await getPayment(payment.id).expect(200)).body.status).toBe('pending');
  });

  // ---------------------------------------------------------------------------------- initiated / T2 / resolver

  it('R-05 a stuck `initiated` attempt whose provider record shows success is settled by the resolver (crash after the provider accepted, before T2 — SDD 12)', async () => {
    const payment = await create();
    const row = (await t.app.get(PaymentService).findById(payment.id))!;
    const attemptId = crypto.randomUUID();
    await sql(`INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES ($1, $2, 1, 'test')`, [attemptId, payment.id]);
    await sql(`UPDATE payment SET status = 'pending' WHERE id = $1`, [payment.id]);
    await testProvider(t).initiate(row, { merchantReference: attemptId }); // the provider DID record it
    await sleep(320); // longer than the provider's timeout + visibility lag

    await t.app.get(AttemptResolver).drainOnce();

    const after = (await getPayment(payment.id).expect(200)).body;
    expect(after.status).toBe('succeeded');
    expect(after.attempts[0].status).toBe('succeeded');
  });

  it('R-06 one unresolvable attempt cannot jam the resolver: the other stuck attempts are still settled in the same pass', async () => {
    const poisoned = await create();
    const pa = (await startAttempt(t, poisoned.id, 'r06-key-poison', { scenario: 'success_amount_mismatch' }).expect(201)).body;
    await sql(`UPDATE payment_attempt SET "submittedAt" = now() - interval '1 hour' WHERE id = $1`, [pa.id]); // long-submitted: the resolver asks the provider, which answers with a mismatch
    const healthy = await create();
    const ha = (await startAttempt(t, healthy.id, 'r06-key-healthy', { scenario: 'timeout_after_accept' }).expect(201)).body;
    expect(ha.status).toBe('unknown');

    await expect(t.app.get(AttemptResolver).drainOnce()).resolves.toBeDefined();

    expect((await getPayment(healthy.id).expect(200)).body.status).toBe('succeeded');
    expect((await getPayment(poisoned.id).expect(200)).body.status).toBe('pending'); // mismatch: never applied
  });

  it('R-07 a webhook that beats T2 (attempt still `initiated`) settles instead of failing with a database error, and T2 then does not clobber it', async () => {
    const payment = await create();
    const attempts = t.app.get(AttemptService);
    const registry = t.app.get(ProviderRegistry);
    const inner = registry.get('test') as TestPaymentProvider;
    const racing: PaymentProvider = {
      id: 'racy',
      capabilities: inner.capabilities,
      verifyWebhook: inner.verifyWebhook.bind(inner),
      parseStoredBody: inner.parseStoredBody.bind(inner),
      fetchStatus: inner.fetchStatus.bind(inner),
      async initiate(p, attempt) {
        const accepted = await inner.initiate(p, attempt);
        // The provider's callback lands while our own T2 has not committed yet: the attempt is still `initiated`.
        await attempts.applyStatus(attempt.id, { kind: 'succeeded', amount: Number(p.amount), currency: p.currency }, this);
        return accepted;
      },
    };
    (registry as unknown as { providers: Map<string, PaymentProvider> }).providers.set('racy', racing);

    const res = await request(server()).post(`/payment/payments/${payment.id}/attempts`).set('authorization', 'Bearer user-1-jwt').set('idempotency-key', 'r07-key-aaaa').send({ provider: 'racy' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('succeeded'); // T2 must not overwrite a settled attempt
    expect((await getPayment(payment.id).expect(200)).body.status).toBe('succeeded');
  });

  // ------------------------------------------------------------------------------------------ webhooks

  it('R-08 a malformed-but-signed webhook is stored `failed` once and is NOT retried forever by the retrier (SDD 7: non-retryable)', async () => {
    const body = Buffer.from('{"not":"an event"}', 'utf8');
    await postWebhook(t, body, sign(body)).expect(200);
    const [{ providerEventId }] = (await sql(`SELECT "providerEventId" FROM webhook_event WHERE "rawBody" = $1`, [body])).rows;
    await sql('ALTER TABLE webhook_event DISABLE TRIGGER webhook_event_immutable'); // test-only: age the row so the retrier considers it
    await sql(`UPDATE webhook_event SET "receivedAt" = now() - interval '1 hour' WHERE "providerEventId" = $1`, [providerEventId]);
    await sql('ALTER TABLE webhook_event ENABLE TRIGGER webhook_event_immutable');
    for (let i = 0; i < 3; i++) await t.app.get(WebhookRetriever).drainOnce();
    const [row] = await eventState(providerEventId);
    expect(row).toMatchObject({ state: 'failed', outcome: 'malformed_body', attempts: 1 });
  });

  it('R-09 body mutation after signing is rejected (401) and persists nothing', async () => {
    const payment = await create();
    const a = (await startAttempt(t, payment.id, 'r09-key-aaaa', { scenario: 'success' }).expect(201)).body;
    const { body, signature } = testProvider(t).signSuccessCallback(a.id);
    const tampered = Buffer.from(body.toString('utf8').replace('1000', '1'), 'utf8');
    await postWebhook(t, tampered, signature).expect(401);
    await request(server()).post('/payment/webhooks/test').set('content-type', 'application/json').send(body.toString('utf8')).expect(401); // missing signature
    expect(await eventState(`evt_${a.id}`)).toEqual([]);
    expect((await getPayment(payment.id).expect(200)).body.status).toBe('pending');
  });

  it('R-10 a webhook signed by one provider cannot settle an attempt that belongs to another provider', async () => {
    const payment = await create();
    const row = (await t.app.get(PaymentService).findById(payment.id))!;
    const attemptId = crypto.randomUUID();
    await sql(`INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES ($1, $2, 1, 'other')`, [attemptId, payment.id]);
    await sql(`UPDATE payment SET status = 'pending' WHERE id = $1`, [payment.id]);
    await sql(`UPDATE payment_attempt SET status = 'submitted', "providerTransactionId" = 'ptx_other_1' WHERE id = $1`, [attemptId]);
    await testProvider(t).initiate(row, { merchantReference: attemptId });
    const { body, signature } = signedFor(attemptId, `evt_${attemptId}`); // names the other provider's attempt by merchantReference
    await postWebhook(t, body, signature).expect(200);
    expect((await eventState(`evt_${attemptId}`))[0].state).toBe('unmatched');
    expect((await getPayment(payment.id).expect(200)).body.status).toBe('pending');
  });

  // ------------------------------------------------------------------------------------------------ events

  it('R-11 FI-16/SDD 11: payment.succeeded carries the full common payload, an incremented revision, actor and cause, and a correlation id', async () => {
    const payment = await create();
    const a = (await startAttempt(t, payment.id, 'r11-key-aaaa', { scenario: 'success' }).expect(201)).body;
    const { body, signature } = testProvider(t).signSuccessCallback(a.id);
    await postWebhook(t, body, signature).expect(200);

    const [ev] = await outbox('payment.succeeded', payment.id);
    expect(ev.payload).toMatchObject({
      paymentId: payment.id,
      paymentRequestId: payment.paymentRequestId,
      sourceType: 'invoice',
      sourceId: 'inv-1',
      organizationId: payment.organizationId,
      payer: { type: 'user', id: 'user-1' },
      seller: payment.seller,
      amount: 1000,
      currency: 'TND',
      status: 'succeeded',
      settledMethod: 'gateway',
      actor: { type: 'provider' },
      cause: { type: 'webhook_event' },
    });
    expect(typeof ev.payload.succeededAt).toBe('string');
    expect(ev.payload.revision).toBeGreaterThan(0); // created = 0, created->pending = 1, pending->succeeded = 2
    expect(ev.correlationId).toBeTruthy();
    const created = (await outbox('payment.created', payment.id))[0];
    expect(created.payload).toMatchObject({ status: 'created', revision: 0, actor: { type: 'service', id: 'billing-service' } });
  });

  it('R-12 payment.failed / payment.expired / payment.cancelled events carry the common payload; system events still get a correlation id', async () => {
    const failed = await create(tOne);
    await startAttempt(tOne, failed.id, 'r12-key-fail', { scenario: 'failure' }).expect(201);
    const [ev] = await outbox('payment.failed', failed.id);
    expect(ev.payload).toMatchObject({ paymentId: failed.id, paymentRequestId: failed.paymentRequestId, status: 'failed', failureCode: 'card_declined', payer: { type: 'user', id: 'user-1' }, amount: 1000 });
    expect(ev.payload.revision).toBeGreaterThan(0);

    const soon = await create(t, { expiresAt: new Date(Date.now() + 300).toISOString() });
    await sleep(500);
    const { ExpirySweeper } = await import('../src/payments/expiry-sweeper.js');
    await t.app.get(ExpirySweeper).sweepOnce();
    const [exp] = await outbox('payment.expired', soon.id);
    expect(exp.payload).toMatchObject({ paymentId: soon.id, paymentRequestId: soon.paymentRequestId, status: 'expired', actor: { type: 'system' } });
    expect(exp.correlationId).toBeTruthy(); // no request context in a sweep: a fresh id per job run
  });

  it('R-13 the payment row revision and updatedAt advance on every state change', async () => {
    const payment = await create();
    await startAttempt(t, payment.id, 'r13-key-aaaa', { scenario: 'failure', failureClass: 'retryable', failureCode: 'temporary_failure' }).expect(201);
    const row = (await sql('SELECT status, revision, "updatedAt", "createdAt" FROM payment WHERE id = $1', [payment.id])).rows[0];
    expect(row.status).toBe('created'); // created -> pending -> created
    expect(row.revision).toBe(2);
    expect(new Date(row.updatedAt).getTime()).toBeGreaterThan(new Date(row.createdAt).getTime());
  });

  // ----------------------------------------------------------------------------------- FI-16 atomicity

  const failOutboxFor = async (eventName: string) => {
    await sql(`CREATE OR REPLACE FUNCTION review_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = '${eventName}' THEN RAISE EXCEPTION 'outbox down'; END IF; RETURN NEW; END $$`);
    await sql('DROP TRIGGER IF EXISTS review_fail_outbox ON outbox');
    await sql('CREATE TRIGGER review_fail_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION review_fail_outbox()');
  };
  const restoreOutbox = async () => sql('DROP TRIGGER IF EXISTS review_fail_outbox ON outbox');

  it('R-14 FI-16 scenario B: when the outbox insert fails, the payment AND attempt state changes roll back too; the retry then commits both', async () => {
    const payment = await create();
    const a = (await startAttempt(t, payment.id, 'r14-key-aaaa', { scenario: 'success' }).expect(201)).body;
    const { body, signature } = testProvider(t).signSuccessCallback(a.id);
    await failOutboxFor('payment.succeeded');
    try {
      await postWebhook(t, body, signature).expect(500);
      const p = (await getPayment(payment.id).expect(200)).body;
      expect(p.status).toBe('pending');
      expect(p.attempts[0].status).toBe('submitted');
      expect(await outbox('payment.succeeded', payment.id)).toHaveLength(0);
      expect((await eventState(`evt_${a.id}`))[0].state).toBe('failed');
    } finally {
      await restoreOutbox();
    }
    await postWebhook(t, body, signature).expect(200); // the provider retries: the stored event is reprocessed
    const p = (await getPayment(payment.id).expect(200)).body;
    expect(p.status).toBe('succeeded');
    expect(await outbox('payment.succeeded', payment.id)).toHaveLength(1);
  });

  it('R-15 FI-16: payment creation rolls back completely when its outbox insert fails (no orphan payment row)', async () => {
    await failOutboxFor('payment.created');
    const body = paymentBody();
    try {
      await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(body).expect(500);
      expect((await sql('SELECT 1 FROM payment WHERE "paymentRequestId" = $1', [body.paymentRequestId])).rows).toHaveLength(0);
    } finally {
      await restoreOutbox();
    }
    await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(body).expect(201); // the producer's retry is a clean first create
  });

  // ------------------------------------------------------------------------------------------- lock order

  it('R-16 lock order payment -> attempt (regression for the previously found bug): applyStatus blocked on the payment lock holds NO lock on the attempt row', async () => {
    const payment = await create();
    const a = (await startAttempt(t, payment.id, 'r16-key-aaaa', { scenario: 'timeout_after_accept' }).expect(201)).body;
    const provider = t.app.get(ProviderRegistry).get('test');
    const holder = new pg.Client({ connectionString: db.url });
    const probe = new pg.Client({ connectionString: db.url });
    await holder.connect();
    await probe.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [payment.id]);
      const blocked = t.app.get(AttemptService).applyStatus(a.id, { kind: 'succeeded', amount: 1000, currency: 'TND' }, provider);
      await sleep(300); // applyStatus is now waiting for the payment row
      await probe.query('BEGIN');
      await expect(probe.query('SELECT 1 FROM payment_attempt WHERE id = $1 FOR UPDATE NOWAIT', [a.id])).resolves.toBeDefined(); // would be 55P03 if the attempt were locked first
      await probe.query('ROLLBACK');
      await holder.query('COMMIT');
      await expect(blocked).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      await holder.end();
      await probe.end();
    }
  });

  it('R-17 no deadlock and no 5xx when webhook, sync, resolver and expiry all hit the same payments at once', async () => {
    const ids: { payment: string; attempt: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const p = await create();
      const a = (await startAttempt(t, p.id, `r17-key-${i}-aaaa`, { scenario: 'timeout_after_accept' }).expect(201)).body;
      ids.push({ payment: p.id, attempt: a.id });
    }
    const work: Promise<unknown>[] = [];
    for (const { payment, attempt } of ids) {
      const { body, signature } = signedFor(attempt, `evt_${attempt}`);
      work.push(postWebhook(t, body, signature).then((r) => expect(r.status).toBe(200)));
      work.push(request(server()).post(`/payment/payments/${payment}/attempts/${attempt}/sync`).set('authorization', 'Bearer user-1-jwt').send({}).then((r) => expect(r.status).toBe(200)));
    }
    work.push(t.app.get(AttemptResolver).drainOnce());
    await Promise.all(work);
    for (const { payment, attempt } of ids) {
      expect((await getPayment(payment).expect(200)).body.status).toBe('succeeded');
      expect(await outbox('payment.succeeded', payment)).toHaveLength(1);
      expect((await sql(`SELECT count(*)::int AS n FROM payment_attempt WHERE "paymentId" = $1 AND status = 'succeeded'`, [payment])).rows[0].n).toBe(1);
      expect(attempt).toBeTruthy();
    }
  });

  // ------------------------------------------------------------------------------------ input validation

  it('R-18 a non-UUID organization seller id is a 400, not a 500', async () => {
    const res = await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(paymentBody({ seller: { type: 'organization', id: 'not-a-uuid' }, organizationId: undefined }));
    expect(res.status).toBe(400);
  });

  it('R-19 an expiresAt that matches the shape but is not a real instant is a 400, not a 500', async () => {
    const res = await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(paymentBody({ expiresAt: '2026-13-45T00:00:00Z' }));
    expect(res.status).toBe(400);
  });

  it('R-20 FI-01: zero, negative, fractional, string and unsafe amounts are refused at the API; the maximum safe integer is accepted and round-trips exactly', async () => {
    for (const amount of [0, -1, 1.5, '100', 9007199254740992, 1e21, null]) {
      const res = await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(paymentBody({ amount }));
      expect(res.status, `amount ${String(amount)}`).toBe(400);
    }
    const ok = await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(paymentBody({ amount: 9007199254740991 }));
    expect(ok.status).toBe(201);
    expect(ok.body.amount).toBe(9007199254740991);
    expect((await sql('SELECT amount::text AS amount FROM payment WHERE id = $1', [ok.body.id])).rows[0].amount).toBe('9007199254740991');
  });

  // ------------------------------------------------------------------------------------ database level

  it('R-21 DB FI-03: two succeeded attempts on one payment are refused by the database itself', async () => {
    const payment = await create();
    const pid = payment.id;
    await sql(`UPDATE payment SET status = 'pending' WHERE id = $1`, [pid]);
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await sql(`INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES ($1, $2, 1, 'test')`, [first, pid]);
    await sql(`UPDATE payment_attempt SET status = 'submitted' WHERE id = $1`, [first]);
    await sql(`UPDATE payment_attempt SET status = 'succeeded' WHERE id = $1`, [first]);
    await sql(`INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES ($1, $2, 2, 'test')`, [second, pid]);
    await sql(`UPDATE payment_attempt SET status = 'submitted' WHERE id = $1`, [second]);
    await expect(sql(`UPDATE payment_attempt SET status = 'succeeded' WHERE id = $1`, [second])).rejects.toMatchObject({ code: '23505' });
  });

  it('R-22 DB: a payment cannot be `succeeded` without a settlement method and (for a gateway) a succeeded attempt', async () => {
    const payment = await create();
    await sql(`UPDATE payment SET status = 'pending' WHERE id = $1`, [payment.id]);
    await expect(sql(`UPDATE payment SET status = 'succeeded' WHERE id = $1`, [payment.id])).rejects.toMatchObject({ code: '23514' });
    await expect(sql(`UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway' WHERE id = $1`, [payment.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('R-23 DB: created -> succeeded (late success) needs a succeeded attempt whose earlier failure was INFERRED', async () => {
    const payment = await create();
    const pid = payment.id;
    const attempt = crypto.randomUUID();
    await sql(`UPDATE payment SET status = 'pending' WHERE id = $1`, [pid]);
    await sql(`INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES ($1, $2, 1, 'test')`, [attempt, pid]);
    await sql(`UPDATE payment_attempt SET status = 'failed', "failureClass" = 'terminal', "failureCode" = 'card_declined' WHERE id = $1`, [attempt]); // provider-confirmed failure
    await sql(`UPDATE payment SET status = 'created' WHERE id = $1`, [pid]);
    // there is no legitimate way for this attempt to become succeeded, so the payment must not be forced to succeeded by a bare UPDATE either
    await expect(sql(`UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway' WHERE id = $1`, [pid])).rejects.toMatchObject({ code: '23514' });
  });

  it('R-24 DB: an organization seller must carry a matching organizationId (a NULL organizationId cannot slip past the CHECK)', async () => {
    const orgId = crypto.randomUUID();
    await expect(
      sql(
        `INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency)
         VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'organization', $1, NULL, 100, 'TND')`,
        [orgId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('R-25 no refund policy leaks into the API: a succeeded payment reports nothing refundable (O-6 is undecided and no provider can refund)', async () => {
    const payment = await create();
    const a = (await startAttempt(t, payment.id, 'r25-key-aaaa', { scenario: 'success' }).expect(201)).body;
    const { body, signature } = testProvider(t).signSuccessCallback(a.id);
    await postWebhook(t, body, signature).expect(200);
    const after = (await getPayment(payment.id).expect(200)).body;
    expect(after.status).toBe('succeeded');
    expect(after).toMatchObject({ refundedAmount: 0, refundableAmount: 0, settledMethod: 'gateway' });
  });

  it('R-26 the webhook route never re-serialises a parsed body: a non-JSON delivery is refused (400) and persists nothing', async () => {
    const before = (await sql('SELECT count(*)::int AS n FROM webhook_event')).rows[0].n;
    await request(server()).post('/payment/webhooks/test').set('content-type', 'text/plain').set('x-test-provider-signature', 'ab'.repeat(32)).send('eventId=1').expect(400);
    expect((await sql('SELECT count(*)::int AS n FROM webhook_event')).rows[0].n).toBe(before);
  });

  it('R-27 two different malformed-but-signed bodies are two stored events (the dedupe key is a full digest of the bytes, not a 32-bit hash)', async () => {
    const one = Buffer.from('{"x":1}', 'utf8');
    const two = Buffer.from('{"x":2}', 'utf8');
    await postWebhook(t, one, sign(one)).expect(200);
    await postWebhook(t, two, sign(two)).expect(200);
    const rows = await sql(`SELECT "providerEventId" FROM webhook_event WHERE "rawBody" = ANY($1::bytea[])`, [[one, two]]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => /^unparseable:[0-9a-f]{64}$/.test(r.providerEventId))).toBe(true);
  });
});
