import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel, type ConsumeMessage } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { startFakeAuthServer, type FakeAuthServer } from './support/fake-auth.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';
import { startReferenceStub, TEST_PLATFORM } from './support/admission.js';
import { createPaymentIdentity, type PaymentIdentity } from './support/payment-identity.js';

const refStub = await startReferenceStub();
let paymentIdentity: PaymentIdentity | undefined;
afterAll(() => refStub.close());

/**
 * Core V2 DO-49 (diagram workshop: "leases, SKIP LOCKED and claim renewal have no cross-process multi-instance run"; Billing has run as two processes in the
 * S0-C14 suite since #483): TWO separately spawned, BUILT payment-service processes on ONE database and ONE real RabbitMQ, simulation provider only.
 *
 * What is real: both processes, every worker they start (webhook retrier, capture reconciler, attempt resolver, expiry sweeper, outbox relay), the signed
 * provider notifications, the database and the broker. What is set up, and LABELLED in each test name: notifications left `received` (the state a crash
 * between transactions A and B leaves) and committed capture facts whose processing was lost (the S0-C12 12(4) fixture shape), both inserted by SQL so
 * that the two instances' workers find the same work at the same time.
 *
 * Each case requires exactly one effect per piece of evidence, whichever instance does the work, and every outbox row of the suite published exactly once.
 * DEVELOPMENT AND SIMULATION ONLY. No financial behavior is changed or asserted beyond the existing rules. Prerequisite: `npm run build -w @nawara/service-kit
 * -w @nawara/audit-contract -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const PORTS = [13951, 13952] as const;
const URLS = PORTS.map((p) => `http://127.0.0.1:${p}`);
const WEBHOOK_SECRET = randomBytes(32).toString('hex');
const PAYER_TOKEN = `do49-payer-${randomUUID()}`;
const PAYER_ID = randomUUID();
const AMOUNT = 4200;

describeWithEnv(
  'Core V2 DO-49: two Payment instances on one database and one broker (real processes, real RabbitMQ; simulation)',
  ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'],
  (env) => {
    let paymentDb: TestDatabase;
    let paymentAdmin: pg.Pool;
    let amqpConn: ChannelModel;
    let fakeAuth: FakeAuthServer;
    const instances: LiveService[] = [];
    const billingToPaymentToken = generateServiceToken();
    const harnessToken = generateServiceToken();
    /** Every broker delivery of a Payment message, counted per message id (a duplicate publication would count twice). */
    const deliveries = new Map<string, number>();
    const tails = () => instances.map((s, i) => `--- payment ${i + 1} ---\n${s.tail()}`).join('\n');

    beforeAll(async () => {
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymentdo49');
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      paymentAdmin = new pg.Pool({ connectionString: paymentDb.url });
      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      paymentIdentity = await createPaymentIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
      const ch = await amqpConn.createChannel();
      await ch.assertExchange('nawara.events', 'topic', { durable: true });
      const { queue } = await ch.assertQueue('', { exclusive: true, autoDelete: true });
      for (const pattern of ['payment.#', 'audit.#', 'refund.#']) await ch.bindQueue(queue, 'nawara.events', pattern);
      await ch.consume(queue, (m: ConsumeMessage | null) => {
        if (m) deliveries.set(String(m.properties.messageId), (deliveries.get(String(m.properties.messageId)) ?? 0) + 1);
      }, { noAck: true });
      fakeAuth = await startFakeAuthServer({ [PAYER_TOKEN]: { id: PAYER_ID, isActive: true } });
      for (const port of PORTS) {
        instances.push(spawnService(`payment-${port}`, PAYMENT_DIR, {
          NODE_ENV: 'test',
          PORT: String(port),
          DATABASE_URL: paymentDb.url,
          AUTH_SERVICE_URL: fakeAuth.url,
          RABBITMQ_URL: paymentIdentity!.url(env.TEST_RABBITMQ_URL),
          PAYMENT_SUPPORTED_CURRENCIES: 'TND',
          PAYMENT_SIMULATION_PROVIDER: 'true',
          PAYMENT_SIMULATION_WEBHOOK_SECRET: WEBHOOK_SECRET,
          SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest},simulation-harness:${harnessToken.digest}`,
          PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
            'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel'], allowedPlatforms: [TEST_PLATFORM] },
            'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
          } }),
          ...refStub.env,
        }));
      }
      try {
        await Promise.all(URLS.map((u) => waitForHealth(`${u}/health`, 30_000)));
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n${tails()}`);
      }
    }, 120_000);

    afterAll(async () => {
      for (const s of instances) await s.stop();
      await paymentIdentity?.remove();
      await fakeAuth?.stop();
      await amqpConn?.close().catch(() => undefined);
      await paymentAdmin?.end();
      await paymentDb?.drop();
    }, 60_000);

    async function call(base: string, token: string, path: string, body: unknown, idempotent = false): Promise<{ status: number; json: any }> {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(idempotent ? { 'idempotency-key': `idem-${randomUUID()}` } : {}) },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    }
    /** A provider notification signed with the simulation webhook secret, into one instance's real webhook pipeline. */
    async function signed(base: string, body: Record<string, unknown>): Promise<number> {
      const raw = JSON.stringify(body);
      const res = await fetch(`${base}/payment/webhooks/simulation`, {
        method: 'POST', body: raw,
        headers: { 'content-type': 'application/json', 'x-simulation-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') },
      });
      return res.status;
    }
    /** A payment Billing would create (created on instance `i`), with one submitted attempt of the payer. */
    async function paymentWithAttempt(i: number): Promise<{ paymentId: string; attemptId: string }> {
      const created = await call(URLS[i]!, billingToPaymentToken.token, '/payment/payments', {
        paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`,
        payer: { type: 'user', id: PAYER_ID }, seller: { type: 'company', id: 'nawara-company-reference' },
        amount: AMOUNT, currency: 'TND', purpose: 'non_entitlement',
      });
      expect(created.status, `${JSON.stringify(created.json)}\n${tails()}`).toBe(201);
      const attempt = await call(URLS[(i + 1) % 2]!, PAYER_TOKEN, `/payment/payments/${created.json.id}/attempts`, {}, true);
      expect(attempt.json, `${JSON.stringify(attempt.json)}\n${tails()}`).toMatchObject({ provider: 'simulation', status: 'submitted' });
      return { paymentId: created.json.id as string, attemptId: attempt.json.id as string };
    }
    /** A payment that really ended `failed` at its attempt limit (PAYMENT_MAX_ATTEMPTS, default 3), each failure through the harness on alternating instances. */
    async function failedPayment(i: number): Promise<{ paymentId: string; attemptId: string }> {
      const first = await paymentWithAttempt(i);
      let attemptId = first.attemptId;
      for (let n = 0; n < 3; n++) {
        if (n > 0) {
          const a = await call(URLS[n % 2]!, PAYER_TOKEN, `/payment/payments/${first.paymentId}/attempts`, {}, true);
          expect(a.json, JSON.stringify(a.json)).toMatchObject({ status: 'submitted' });
          attemptId = a.json.id as string;
        }
        const r = await call(URLS[n % 2]!, harnessToken.token, `/payment/simulation/payments/${first.paymentId}/attempts/${attemptId}/outcomes`,
          { commandId: `do49-${randomUUID()}`, outcome: 'failed', failureCode: 'declined' });
        expect(r.json?.delivered, JSON.stringify(r.json)).toEqual({ status: 200 });
      }
      expect((await paymentAdmin.query(`SELECT status FROM payment WHERE id = $1`, [first.paymentId])).rows[0].status, tails()).toBe('failed');
      return { paymentId: first.paymentId, attemptId };
    }
    const count = async (sql: string, params: unknown[] = []) => (await paymentAdmin.query(sql, params)).rows[0].n as number;

    it('the same signed capture delivered 8 times at once, across both instances: one fact, one success, one event, one audit intent', async () => {
      const { paymentId, attemptId } = await paymentWithAttempt(0);
      const body = { eventId: `do49_${randomUUID()}`, type: 'payment.succeeded', reference: attemptId, providerTransactionId: `sim_do49_${randomUUID()}`, amount: AMOUNT, currency: 'TND' };
      const answers = await Promise.all(Array.from({ length: 8 }, (_, n) => signed(URLS[n % 2]!, body)));
      for (const a of answers) expect(a, `${answers.join(',')}\n${tails()}`).toBeLessThan(500);
      expect((await paymentAdmin.query(`SELECT status FROM payment WHERE id = $1`, [paymentId])).rows[0].status).toBe('succeeded');
      expect(await count(`SELECT count(*)::int AS n FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [body.providerTransactionId])).toBe(1);
      expect(await count(`SELECT count(*)::int AS n FROM webhook_event WHERE "providerEventId" = $1`, [body.eventId])).toBe(1);
      expect(await count(`SELECT count(*)::int AS n FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [paymentId])).toBe(1);
      expect(await count(`SELECT count(*)::int AS n FROM outbox WHERE name = 'audit.payment.succeeded' AND payload->'resource'->>'id' = $1`, [paymentId])).toBe(1);
      expect(await count(`SELECT count(*)::int AS n FROM payment_attempt WHERE "paymentId" = $1 AND status = 'succeeded'`, [paymentId])).toBe(1);
    }, 120_000);

    it('LABELLED (stored notifications left `received`, as a crash between transactions A and B leaves them): both instances\' webhook retriers race; each is processed exactly once', async () => {
      const work = await Promise.all(Array.from({ length: 6 }, (_, n) => paymentWithAttempt(n % 2)));
      const bodies = work.map((w) => ({ eventId: `do49_${randomUUID()}`, type: 'payment.succeeded', reference: w.attemptId, providerTransactionId: `sim_do49_${randomUUID()}`, amount: AMOUNT, currency: 'TND' }));
      for (const b of bodies) {
        await paymentAdmin.query(`INSERT INTO webhook_event (provider, "providerEventId", "eventType", "rawBody", "receivedAt") VALUES ('simulation', $1, 'payment.succeeded', $2, now() - interval '30 seconds')`,
          [b.eventId, Buffer.from(JSON.stringify(b))]);
      }
      await waitFor(async () => (await count(`SELECT count(*)::int AS n FROM payment WHERE id = ANY($1) AND status = 'succeeded'`, [work.map((w) => w.paymentId)])) === work.length,
        60_000, `both retriers to process the stuck notifications\n${tails()}`);
      for (const [n, w] of work.entries()) {
        expect(await count(`SELECT count(*)::int AS n FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [bodies[n]!.providerTransactionId])).toBe(1);
        expect(await count(`SELECT count(*)::int AS n FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [w.paymentId])).toBe(1);
        expect(await count(`SELECT count(*)::int AS n FROM webhook_event WHERE "providerEventId" = $1 AND state = 'processed'`, [bodies[n]!.eventId])).toBe(1);
      }
    }, 180_000);

    it('LABELLED (committed capture facts of final failed payments inserted by SQL, standing for lost processing; S0-C12 12(4)): both instances\' capture reconcilers race; one late success and one event per fact', async () => {
      const failed: Array<{ paymentId: string; attemptId: string }> = [];
      for (let n = 0; n < 4; n++) failed.push(await failedPayment(n % 2));
      const facts: string[] = [];
      for (const f of failed) {
        facts.push((await paymentAdmin.query(`INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", amount, currency, "liveMode", source)
          VALUES ('simulation', $1, 'capture', $2, $3, $4, 'TND', false, 'status_check') RETURNING id`, [`sim_do49_lost_${randomUUID()}`, f.paymentId, f.attemptId, AMOUNT + 100])).rows[0].id as string);
      }
      await waitFor(async () => (await count(`SELECT count(*)::int AS n FROM payment_late_success WHERE "factId" = ANY($1)`, [facts])) === facts.length,
        90_000, `the capture reconcilers to recover every fact\n${tails()}`);
      await new Promise((r) => setTimeout(r, 32_000)); // another pass of each instance's reconciler: a duplicate would be here
      for (const [n, factId] of facts.entries()) {
        expect(await count(`SELECT count(*)::int AS n FROM payment_late_success WHERE "factId" = $1`, [factId])).toBe(1);
        expect(await count(`SELECT count(*)::int AS n FROM outbox WHERE name = 'payment.late_success.recorded' AND payload->>'factId' = $1`, [factId])).toBe(1);
        expect(await count(`SELECT count(*)::int AS n FROM outbox WHERE name = 'audit.payment_late_success.recorded' AND payload->'changes'->>'fact_id' = $1`, [factId])).toBe(1);
        expect((await paymentAdmin.query(`SELECT status FROM payment WHERE id = $1`, [failed[n]!.paymentId])).rows[0].status, 'the final status is never reopened').toBe('failed');
      }
    }, 300_000);

    it('every outbox row of this suite reaches the broker exactly once, whichever instance\'s relay took it', async () => {
      await waitFor(async () => (await count(`SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`)) === 0, 60_000, `both relays to drain the outbox\n${tails()}`);
      const ids = (await paymentAdmin.query(`SELECT id::text AS id, name FROM outbox`)).rows as Array<{ id: string; name: string }>;
      expect(ids.length).toBeGreaterThan(20);
      await waitFor(() => ids.every((r) => deliveries.has(r.id)), 30_000, 'every published row to be delivered to the tap');
      expect(ids.filter((r) => deliveries.get(r.id) !== 1).map((r) => `${r.name}:${deliveries.get(r.id)}`), 'a row published more than once, or never').toEqual([]);
    }, 120_000);
  },
);
