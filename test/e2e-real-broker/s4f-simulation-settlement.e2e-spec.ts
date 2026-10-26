import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { startFakeAuthServer, type FakeAuthServer } from './support/fake-auth.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';
import { billingPolicy, startReferenceStub, TEST_PLATFORM } from './support/admission.js';
import { createPaymentIdentity, tapPaymentEvents, type PaymentIdentity } from './support/payment-identity.js';

const refStub = await startReferenceStub();
let paymentIdentity: PaymentIdentity | undefined;
let tap: Awaited<ReturnType<typeof tapPaymentEvents>> | undefined;
afterAll(() => refStub.close());

/**
 * Core V2 S4f (register PAY-14; S0 §1.1, FC-10; the Owner's F-S1 to F-S7): the simulation provider certifies the Billing loop for a
 * Personal purchase, end to end, over a REAL RabbitMQ broker and real HTTP between two separately spawned, built processes:
 *
 *   Billing dispatcher -> Payment -> payer attempt (simulation provider, server-selected) -> harness outcome -> signed notification
 *   -> Payment facts and settlement -> Payment outbox -> real RabbitMQ -> Billing consumer -> one subscription_purchase
 *
 * Billing settles only after the provider's VERIFIED success (a held instruction changes nothing), and repeated notifications, harness
 * replays and a real broker redelivery never produce a second Personal purchase. Payment runs with the simulation provider only (the test
 * provider disabled, F-S7); its harness caller holds `payment.simulation.resolve` alone (F-S2).
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w billing-service -w payment-service` (both `dist/` present).
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const BILLING_PORT = 13401;
const PAYMENT_PORT = 13402;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const PAYER_TOKEN = 'e2e-s4f-payer-jwt';
const PAYER_ID = 'e2e0e2e0-0000-4000-8000-0000000054f1';

describeWithEnv(
  'Core V2 S4f: simulation provider -> Payment -> real RabbitMQ -> Billing Personal purchase',
  ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'],
  (env) => {
    let billingDb: TestDatabase;
    let paymentDb: TestDatabase;
    let billing: LiveService;
    let payment: LiveService;
    let amqpConn: ChannelModel;
    let fakeAuth: FakeAuthServer;
    let billingAdmin: pg.Pool;
    let paymentAdmin: pg.Pool;
    const producerToken = generateServiceToken();
    const billingToPaymentToken = generateServiceToken();
    const harnessToken = generateServiceToken();

    async function purgeQueue(name: string): Promise<void> {
      const ch = await amqpConn.createChannel();
      ch.on('error', () => undefined);
      try {
        await ch.purgeQueue(name);
      } catch {
        // does not exist yet
      } finally {
        await ch.close().catch(() => undefined);
      }
    }
    async function deadLetterDepth(): Promise<number> {
      const ch = await amqpConn.createChannel();
      ch.on('error', () => undefined);
      try {
        return (await ch.checkQueue(BILLING_DEAD_QUEUE)).messageCount;
      } catch {
        return 0;
      } finally {
        await ch.close().catch(() => undefined);
      }
    }

    beforeAll(async () => {
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillings4f');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epayments4f');
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      paymentAdmin = new pg.Pool({ connectionString: paymentDb.url });
      // Core V2 S3d (BIL-01): the Platform's billing configuration, as the Owner route would after Auth's live checks (a fixture Company)
      await billingAdmin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, gen_random_uuid(), 'TND', gen_random_uuid())`, [TEST_PLATFORM]);

      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      paymentIdentity = await createPaymentIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
      tap = await tapPaymentEvents(amqpConn);
      await purgeQueue(BILLING_QUEUE);
      await purgeQueue(BILLING_DEAD_QUEUE);
      fakeAuth = await startFakeAuthServer({ [PAYER_TOKEN]: { id: PAYER_ID, isActive: true } });

      payment = spawnService('payment', PAYMENT_DIR, {
        NODE_ENV: 'test',
        PORT: String(PAYMENT_PORT),
        DATABASE_URL: paymentDb.url,
        AUTH_SERVICE_URL: fakeAuth.url,
        RABBITMQ_URL: paymentIdentity!.url(env.TEST_RABBITMQ_URL),
        PAYMENT_SUPPORTED_CURRENCIES: 'TND',
        PAYMENT_SIMULATION_PROVIDER: 'true',
        PAYMENT_SIMULATION_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
        SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest},simulation-harness:${harnessToken.digest}`,
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
        ...refStub.env,
      });
      billing = spawnService('billing', BILLING_DIR, {
        NODE_ENV: 'test',
        PORT: String(BILLING_PORT),
        DATABASE_URL: billingDb.url,
        AUTH_SERVICE_URL: 'http://127.0.0.1:9',
        RABBITMQ_URL: env.TEST_RABBITMQ_URL,
        BILLING_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `test-producer:${producerToken.digest}`, ...billingPolicy('test-producer'), ...refStub.env,
        PAYMENT_SERVICE_URL: PAYMENT_URL,
        PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
        BILLING_DISPATCH_INTERVAL_MS: '300',
        BILLING_RECONCILE_INTERVAL_MS: '3600000',
      });
      try {
        await Promise.all([waitForHealth(`${PAYMENT_URL}/health`, 20_000), waitForHealth(`${BILLING_URL}/health`, 20_000)]);
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- payment ---\n${payment.tail()}\n--- billing ---\n${billing.tail()}`);
      }
    }, 90_000);

    afterAll(async () => {
      await billing?.stop();
      await payment?.stop();
      await tap?.close();
      await paymentIdentity?.remove();
      await fakeAuth?.stop();
      if (amqpConn) {
        await purgeQueue(BILLING_QUEUE);
        await purgeQueue(BILLING_DEAD_QUEUE);
        await amqpConn.close().catch(() => undefined);
      }
      await billingAdmin?.end();
      await paymentAdmin?.end();
      await billingDb?.drop();
      await paymentDb?.drop();
    }, 45_000);

    async function call(base: string, token: string, method: 'GET' | 'POST', path: string, body?: unknown, idempotent = false): Promise<{ status: number; json: any }> {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(idempotent ? { 'idempotency-key': `idem-${randomUUID()}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    }
    const asProducer = (method: 'GET' | 'POST', path: string, body?: unknown) => call(BILLING_URL, producerToken.token, method, path, body);
    const asPayer = (path: string, body: unknown = {}) => call(PAYMENT_URL, PAYER_TOKEN, 'POST', path, body, true);
    const asHarness = (path: string, body: unknown = {}) => call(PAYMENT_URL, harnessToken.token, 'POST', path, body);
    const purchases = async (invoiceId: string) => (await billingAdmin.query(`SELECT purpose, "beneficiaryUserId" FROM subscription_purchase WHERE "invoiceId" = $1`, [invoiceId])).rows;

    it('a Personal purchase settles once, only after the provider\'s verified success, whatever is redelivered', async () => {
      // a Personal subscription product of the test Platform, sold by a company seller (as Billing's own suites set it up)
      const productId = (await billingAdmin.query(
        `INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
         VALUES ('test-producer', 'company', 'nawara-test-seller', $1, 'Personal plan', 'active', 'personal', $2) RETURNING id`, [`s4f-${randomUUID().slice(0, 8)}`, TEST_PLATFORM])).rows[0].id;
      const priceId = (await billingAdmin.query(
        `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, $2, 'TND', 900, 'recurring', 'month', 1) RETURNING id`,
        [productId, `s4f-${randomUUID().slice(0, 8)}`])).rows[0].id;
      const invoice = await asProducer('POST', '/billing/invoices', {
        invoiceRequestId: randomUUID(), seller: { type: 'company', id: 'nawara-test-seller' }, payer: { type: 'user', id: PAYER_ID },
        sourceType: 'contract', sourceId: `src-${randomUUID()}`, issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 },
        lines: [{ priceId, quantity: 1 }],
      });
      expect(invoice.status, JSON.stringify(invoice.json)).toBe(201);
      expect((await asProducer('POST', `/billing/invoices/${invoice.json.id}/issue`)).status).toBe(200);
      const created = await asProducer('POST', `/billing/invoices/${invoice.json.id}/payment-requests`);
      expect(created.status).toBe(201);
      const requestId: string = created.json.id;
      let paymentId = '';
      await waitFor(async () => {
        const r = await asProducer('GET', `/billing/payment-requests/${requestId}`);
        paymentId = r.json.paymentId;
        return r.json.status === 'requested' && !!paymentId;
      }, 15_000, 'the real dispatcher to attach a Payment');
      const p = await paymentAdmin.query(`SELECT purpose, "beneficiaryUserId", "liveMode" FROM payment WHERE id = $1`, [paymentId]);
      expect(p.rows[0]).toEqual({ purpose: 'direct_purchase', beneficiaryUserId: PAYER_ID, liveMode: false });

      // the payer cannot choose an outcome; the server selects the simulation provider
      expect((await asPayer(`/payment/payments/${paymentId}/attempts`, { providerOptions: { scenario: 'success' } })).json.code).toBe('provider_options_not_accepted');
      const attempt = await asPayer(`/payment/payments/${paymentId}/attempts`);
      expect(attempt.json).toMatchObject({ provider: 'simulation', status: 'submitted' });

      // a held instruction is not a settlement fact: nothing reaches Billing
      const held = await asHarness(`/payment/simulation/payments/${paymentId}/attempts/${attempt.json.id}/outcomes`, { commandId: `s4f-${randomUUID()}`, outcome: 'succeeded', delivery: 'held' });
      expect(held.status).toBe(201);
      await new Promise((r) => setTimeout(r, 1500));
      expect((await asProducer('GET', `/billing/payment-requests/${requestId}`)).json.status).toBe('requested');
      expect(await purchases(invoice.json.id)).toEqual([]);

      // the provider's signed notification, verified by Payment, settles it once; delivered twice at once, and once more
      const [d1, d2] = await Promise.all([asHarness(`/payment/simulation/commands/${held.json.commandId}/deliver`), asHarness(`/payment/simulation/commands/${held.json.commandId}/deliver`)]);
      expect([d1.json.delivered.status, d2.json.delivered.status]).toEqual([200, 200]);
      await waitFor(async () => (await asProducer('GET', `/billing/payment-requests/${requestId}`)).json.status === 'paid', 30_000, 'the request to be paid over the real broker');
      expect((await asHarness(`/payment/simulation/commands/${held.json.commandId}/deliver`)).json.delivered.status).toBe(200);
      expect(await purchases(invoice.json.id)).toEqual([{ purpose: 'direct_purchase', beneficiaryUserId: PAYER_ID }]);
      const succeeded = await paymentAdmin.query(`SELECT id FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [paymentId]);
      expect(succeeded.rows).toHaveLength(1);

      // a real broker redelivery of Payment's exact message: still one receipt and one Personal purchase, nothing dead-lettered
      const dlqBefore = await deadLetterDepth();
      const receipt = await billingAdmin.query<{ eventId: string }>(`SELECT "eventId" FROM payment_event_receipt WHERE "paymentRequestId" = $1 AND "eventName" = 'payment.succeeded'`, [requestId]);
      await paymentIdentity!.redeliver(await tap!.take(receipt.rows[0]!.eventId));
      await new Promise((r) => setTimeout(r, 2000));
      expect((await billingAdmin.query(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [requestId])).rows[0].n).toBe(1);
      expect(await purchases(invoice.json.id)).toHaveLength(1);
      expect(await deadLetterDepth()).toBe(dlqBefore);
    }, 90_000);
  },
);
