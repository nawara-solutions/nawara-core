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
import { createPaymentIdentity, type PaymentIdentity } from './support/payment-identity.js';

const refStub = await startReferenceStub();
let paymentIdentity: PaymentIdentity | undefined;
afterAll(() => refStub.close());

/**
 * Core V2 S4e (register PAY-03; the Owner's A-1 to A-7): an Organization-payer payment settled by its Organization actor, over a REAL RabbitMQ
 * broker and real HTTP between two separately spawned, built processes, creates nothing in Billing. Billing has no assisted or recovery
 * workflow yet (S5b / S6f; B-026 unchanged): Payment's verified `payment.succeeded` reaches Billing's real consumer, which applies nothing,
 * so no invoice, request, Personal purchase or entitlement changes. The creation grant `payment.create.organization_payer` is held here ONLY
 * by this isolated test policy (A-5); Payment runs the simulation provider.
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w billing-service -w payment-service` (both `dist/` present).
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const BILLING_PORT = 13501;
const PAYMENT_PORT = 13502;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const ORGANIZATION = '0a0a0a0a-0000-4000-8000-0000000054e1';
const ADMIN_TOKEN = 'e2e-s4e-org-admin-jwt';
const ADMIN_ID = 'e2e0e2e0-0000-4000-8000-0000000054e2';
const BENEFICIARY = 'e2e0e2e0-0000-4000-8000-0000000054e3';

describeWithEnv(
  'Core V2 S4e: Organization-payer settlement -> real RabbitMQ -> Billing applies nothing',
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

    beforeAll(async () => {
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillings4e');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epayments4e');
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      paymentAdmin = new pg.Pool({ connectionString: paymentDb.url });

      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      paymentIdentity = await createPaymentIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
      await purgeQueue(BILLING_QUEUE);
      await purgeQueue(BILLING_DEAD_QUEUE);
      fakeAuth = await startFakeAuthServer({
        [ADMIN_TOKEN]: { id: ADMIN_ID, isActive: true, memberships: [{ id: randomUUID(), organization: { id: ORGANIZATION }, platform: { id: TEST_PLATFORM }, status: 'active', isOrganizationAdmin: true }] },
      });

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
        // an ISOLATED TEST policy: the only place the default-denied creation grant is held (A-5)
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.create.organization_payer'], allowedPlatforms: [TEST_PLATFORM] },
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

    async function call(token: string, path: string, body: unknown, idempotent = false): Promise<{ status: number; json: any }> {
      const res = await fetch(`${PAYMENT_URL}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(idempotent ? { 'idempotency-key': `idem-${randomUUID()}` } : {}) },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    }
    const billingCounts = async () => (await billingAdmin.query(
      `SELECT (SELECT count(*) FROM invoice)::int AS invoices, (SELECT count(*) FROM payment_request)::int AS requests,
              (SELECT count(*) FROM subscription_purchase)::int AS purchases, (SELECT count(*) FROM personal_subscription)::int AS personal,
              (SELECT count(*) FROM subscription)::int AS subscriptions,
              (SELECT count(*) FROM payment_event_receipt WHERE outcome = 'applied')::int AS applied`)).rows[0];

    it('the Organization actor settles it on verified evidence; the real broker delivers it; Billing creates no purchase or entitlement', async () => {
      const before = await billingCounts();
      const paymentRequestId = randomUUID(); // names no Billing request: Billing has no Organization-payer workflow (S5b / S6f)
      const created = await call(billingToPaymentToken.token, '/payment/payments', {
        paymentRequestId, sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`,
        payer: { type: 'organization', id: ORGANIZATION }, seller: { type: 'company', id: 'nawara-company-reference' },
        amount: 4200, currency: 'TND', purpose: 'assisted_settlement', beneficiaryUserId: BENEFICIARY,
      });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      const attempt = await call(ADMIN_TOKEN, `/payment/payments/${created.json.id}/attempts`, {}, true);
      expect(attempt.json).toMatchObject({ provider: 'simulation', status: 'submitted' });
      const settled = await call(harnessToken.token, `/payment/simulation/payments/${created.json.id}/attempts/${attempt.json.id}/outcomes`, { commandId: `s4e-${randomUUID()}`, outcome: 'succeeded' });
      expect(settled.json.delivered).toEqual({ status: 200 });
      expect((await paymentAdmin.query('SELECT status FROM payment WHERE id = $1', [created.json.id])).rows[0].status).toBe('succeeded');

      // the relay publishes payment.succeeded to the real broker; Billing's consumer receives it and applies nothing
      await waitFor(async () => (await paymentAdmin.query(`SELECT "publishedAt" FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [created.json.id])).rows[0]?.publishedAt != null,
        15_000, 'the payment.succeeded event to be published');
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [paymentRequestId])).rowCount! > 0,
        15_000, 'Billing\'s real consumer to receive and decide the event');
      const receipts = (await billingAdmin.query(`SELECT "eventName", outcome, "detailCode" FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [paymentRequestId])).rows;
      expect(receipts).toEqual([{ eventName: 'payment.succeeded', outcome: 'ignored', detailCode: 'unknown_payment_request' }]);
      expect(await billingCounts()).toEqual(before);
    }, 60_000);
  },
);
