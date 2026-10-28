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
 * Core V2 S5b (register BIL-16, BIL-17, PAY-03 G; the Owner's E-1 to E-13), certified across two separately spawned, built processes, real
 * HTTP and a REAL RabbitMQ broker, on Payment's simulation provider (development and simulation only):
 *
 *   assistance request → consent → cash collection → the Organization's electronic settlement (Billing invoice and payment request) →
 *   the dispatcher creates the Organization-payer payment at Payment under `payment.create.assisted_settlement` → the Organization actor
 *   starts the attempt at Payment (S4e) → simulation capture → verified `payment.succeeded` over the broker → Billing's real consumer →
 *   the beneficiary's purchase → entitlement;
 *
 * and the unsuccessful path: a final failure → the deadline → Billing's sweep opens the cash-return obligation → the Organization reports
 * the return, with no purchase. Payment never calls Billing; the grant is held only by this isolated test policy. Core V2 S5c adds, on the same
 * processes: an open dispute blocks the beneficiary's confirmation, the Organization answers it, and a confirmation resolves the request,
 * with the audit evidence published over the real relay.
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w @nawara/audit-contract -w billing-service -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const BILLING_PORT = 13511;
const PAYMENT_PORT = 13512;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const ORGANIZATION = '0a0a0a0a-0000-4000-8000-0000000055b1';
// Core V2 S5d: T1/T2 restrict an Organization's NEW requests, so every scenario that leaves an obligation behind uses its own Organization
const ORGANIZATION_B = '0a0a0a0a-0000-4000-8000-0000000055c1';
const ORGANIZATION_C = '0a0a0a0a-0000-4000-8000-0000000055c2';
const ORGANIZATION_D = '0a0a0a0a-0000-4000-8000-0000000055c3';
const COMPANY = 'aaaaaaaa-0000-4000-8000-00000000c0de';
const ADMIN_TOKEN = 'e2e-s5b-org-admin-jwt';
const ADMIN_ID = 'e2e0e2e0-0000-4000-8000-0000000055b2';
const BENEFICIARY_TOKEN = 'e2e-s5b-beneficiary-jwt';
const BENEFICIARY = 'e2e0e2e0-0000-4000-8000-0000000055b3';
const BENEFICIARY2_TOKEN = 'e2e-s5b-beneficiary-2-jwt';
const BENEFICIARY2 = 'e2e0e2e0-0000-4000-8000-0000000055b4';
const BENEFICIARY3_TOKEN = 'e2e-s5c-beneficiary-3-jwt'; // Core V2 S5c
const BENEFICIARY3 = 'e2e0e2e0-0000-4000-8000-0000000055b5';

describeWithEnv(
  'Core V2 S5b: assisted settlement -> Payment (simulation) -> real RabbitMQ -> Billing purchase; failure -> cash-return obligation',
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
    let productId: string;
    let priceId: string;
    const producerToken = generateServiceToken();
    const billingToPaymentToken = generateServiceToken();
    const harnessToken = generateServiceToken();
    const member = (organizationAdmin: boolean) => [ORGANIZATION, ORGANIZATION_B, ORGANIZATION_C, ORGANIZATION_D]
      .map((organization) => ({ id: randomUUID(), organization: { id: organization }, platform: { id: TEST_PLATFORM }, status: 'active' as const, isOrganizationAdmin: organizationAdmin }));

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
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillings5b');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epayments5b');
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      paymentAdmin = new pg.Pool({ connectionString: paymentDb.url });
      // the Platform's commercial configuration (S3d) and one Owner-catalog personal product (S3g), as fixtures
      await billingAdmin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [TEST_PLATFORM, COMPANY, randomUUID()]);
      productId = (await billingAdmin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId") VALUES ('billing-owner', 'company', $1, 's5b-plan', 'Personal plan', 'active', 'personal', $2) RETURNING id`,
        [COMPANY, TEST_PLATFORM])).rows[0].id;
      priceId = (await billingAdmin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom") VALUES ($1, 'monthly', 'TND', 4200, 'recurring', 'month', 1, '2020-01-01') RETURNING id`,
        [productId])).rows[0].id;

      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      paymentIdentity = await createPaymentIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
      await purgeQueue(BILLING_QUEUE);
      await purgeQueue(BILLING_DEAD_QUEUE);
      fakeAuth = await startFakeAuthServer({
        [ADMIN_TOKEN]: { id: ADMIN_ID, isActive: true, memberships: member(true) },
        [BENEFICIARY_TOKEN]: { id: BENEFICIARY, isActive: true, memberships: member(false) },
        [BENEFICIARY2_TOKEN]: { id: BENEFICIARY2, isActive: true, memberships: member(false) },
        [BENEFICIARY3_TOKEN]: { id: BENEFICIARY3, isActive: true, memberships: member(false) },
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
        PAYMENT_MAX_ATTEMPTS: '1', // one failed attempt is the payment's final failure
        SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest},simulation-harness:${harnessToken.digest}`,
        // an ISOLATED TEST policy (E-2): only billing-service holds the narrow assisted-settlement grant; never the broad one
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.create.assisted_settlement'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
        ...refStub.env,
      });
      billing = spawnService('billing', BILLING_DIR, {
        NODE_ENV: 'test',
        PORT: String(BILLING_PORT),
        DATABASE_URL: billingDb.url,
        AUTH_SERVICE_URL: fakeAuth.url, // assistance actors are verified live, per request
        RABBITMQ_URL: env.TEST_RABBITMQ_URL,
        BILLING_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `test-producer:${producerToken.digest}`, ...billingPolicy('test-producer'), ...refStub.env,
        PAYMENT_SERVICE_URL: PAYMENT_URL,
        PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
        BILLING_DISPATCH_INTERVAL_MS: '300',
        BILLING_RECONCILE_INTERVAL_MS: '3600000',
        BILLING_ASSISTANCE_SWEEP_INTERVAL_MS: '1000',
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

    async function call(base: string, method: 'GET' | 'POST', token: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(method === 'POST' ? { 'idempotency-key': `idem-${randomUUID()}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    }
    const billingCall = (method: 'GET' | 'POST', token: string, path: string, body?: unknown) => call(BILLING_URL, method, token, path, body);
    const paymentCall = (token: string, path: string, body: unknown) => call(PAYMENT_URL, 'POST', token, path, body);

    /** A consented request whose cash the Organization collected; then its electronic settlement, dispatched to Payment. */
    async function settlementAtPayment(beneficiaryToken: string, organizationId = ORGANIZATION) {
      const created = await billingCall('POST', beneficiaryToken, '/billing/assistance-requests', { organizationId, productId, priceId, consent: true });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      await new Promise((r) => setTimeout(r, 20)); // the collection is after the consent
      const cash = await billingCall('POST', ADMIN_TOKEN, `/billing/assistance-requests/${created.json.id}/cash-collection`, { cashCollectedAt: new Date().toISOString() });
      expect(cash.status, JSON.stringify(cash.json)).toBe(200);
      const settled = await billingCall('POST', ADMIN_TOKEN, `/billing/assistance-requests/${created.json.id}/settlement`);
      expect(settled.status, JSON.stringify(settled.json)).toBe(201);
      expect(settled.json.paymentId).toBeNull();
      await waitFor(async () => (await billingAdmin.query(`SELECT "paymentId" FROM payment_request WHERE id = $1 AND status = 'requested'`, [settled.json.paymentRequestId])).rows[0]?.paymentId != null,
        15_000, 'the dispatcher to create the Organization-payer payment at Payment');
      const paymentId = (await billingAdmin.query(`SELECT "paymentId" FROM payment_request WHERE id = $1`, [settled.json.paymentRequestId])).rows[0].paymentId as string;
      return { requestId: created.json.id as string, ...settled.json, paymentId };
    }
    async function capture(paymentId: string, outcome: 'succeeded' | 'failed') {
      const attempt = await paymentCall(ADMIN_TOKEN, `/payment/payments/${paymentId}/attempts`, {}); // the Organization actor pays (S4e)
      expect(attempt.json, JSON.stringify(attempt.json)).toMatchObject({ provider: 'simulation', status: 'submitted' });
      const r = await paymentCall(harnessToken.token, `/payment/simulation/payments/${paymentId}/attempts/${attempt.json.id}/outcomes`, { commandId: `s5b-${randomUUID()}`, outcome, ...(outcome === 'failed' ? { failureCode: 'card_declined' } : {}) });
      expect(r.json?.delivered, JSON.stringify(r.json)).toEqual({ status: 200 });
    }

    it('SIMULATION: the Organization pays the frozen base at Payment; the verified success over the broker gives the beneficiary the purchase and entitlement', async () => {
      const s = await settlementAtPayment(BENEFICIARY_TOKEN);
      const p = (await paymentAdmin.query(`SELECT "payerType", "payerId", "organizationId", purpose, "beneficiaryUserId", amount, producer FROM payment WHERE id = $1`, [s.paymentId])).rows[0];
      expect(p).toMatchObject({ payerType: 'organization', payerId: ORGANIZATION, organizationId: ORGANIZATION, purpose: 'assisted_settlement', beneficiaryUserId: BENEFICIARY, producer: 'billing-service' });
      expect(Number(p.amount)).toBe(4200);
      // a beneficiary cannot pay for the Organization at Payment
      expect((await paymentCall(BENEFICIARY_TOKEN, `/payment/payments/${s.paymentId}/attempts`, {})).status).toBe(404);

      await capture(s.paymentId, 'succeeded');
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [s.requestId])).rowCount! > 0,
        20_000, 'Billing to record the beneficiary\'s purchase from the verified event');
      expect((await billingAdmin.query(`SELECT purpose, "beneficiaryUserId", "productId" FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [s.requestId])).rows)
        .toEqual([{ purpose: 'assisted_settlement', beneficiaryUserId: BENEFICIARY, productId }]);
      const view = await billingCall('GET', BENEFICIARY_TOKEN, `/billing/assistance-requests/${s.requestId}`);
      expect(view.json).toMatchObject({ status: 'settled', overdue: false, cashReturnObligation: null, settlementChannels: [{ status: 'settled', paymentId: s.paymentId, paymentRequestStatus: 'paid' }] });
      const ent = await billingCall('GET', producerToken.token, `/billing/users/${BENEFICIARY}/platforms/${TEST_PLATFORM}/products/${productId}/entitlement`);
      expect(ent.json).toMatchObject({ valid: true });
      const admin = await billingCall('GET', producerToken.token, `/billing/users/${ADMIN_ID}/platforms/${TEST_PLATFORM}/products/${productId}/entitlement`);
      expect(admin.json).toEqual({ valid: false, expiresAt: null });
    }, 90_000);

    /** A final failure at Payment, then the deadline (a test-only move of the collection into the past, as a superuser): the sweep's obligation. */
    async function obligationAfterFailure(beneficiaryToken: string, organizationId: string) {
      const s = await settlementAtPayment(beneficiaryToken, organizationId);
      await capture(s.paymentId, 'failed');
      await waitFor(async () => (await billingAdmin.query(`SELECT status FROM assistance_settlement_channel WHERE "invoiceId" = $1`, [s.invoiceId])).rows[0]?.status === 'closed',
        20_000, 'the channel to close on Payment\'s final failure');
      const cl = await billingAdmin.connect();
      try {
        await cl.query(`SET session_replication_role = replica`);
        await cl.query(`UPDATE assistance_request SET "consentAt" = now() - interval '100 hours', "cashCollectedAt" = now() - interval '73 hours', "reportedAt" = now() - interval '73 hours', "settleBy" = now() - interval '1 hour' WHERE id = $1`, [s.requestId]);
      } finally {
        await cl.query(`SET session_replication_role = origin`);
        cl.release();
      }
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [s.requestId])).rowCount! > 0,
        20_000, 'Billing\'s sweep to open the cash-return obligation');
      const obligationId = (await billingAdmin.query(`SELECT id FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [s.requestId])).rows[0].id as string;
      return { ...s, obligationId };
    }

    it('S5c: an open dispute blocks the confirmation; the beneficiary confirms the reported return; the audit evidence leaves over the real relay; never a purchase', async () => {
      const s = await obligationAfterFailure(BENEFICIARY3_TOKEN, ORGANIZATION_C);
      const rr = await billingCall('POST', ADMIN_TOKEN, `/billing/cash-return-obligations/${s.obligationId}/return`, { returnedAt: new Date(Date.now() - 60_000).toISOString() });
      expect(rr.json, JSON.stringify(rr.json)).toMatchObject({ status: 'return_reported' });
      const d = await billingCall('POST', BENEFICIARY3_TOKEN, `/billing/assistance-requests/${s.requestId}/disputes`, { reasonCode: 'collection_time_incorrect' });
      expect(d.status, JSON.stringify(d.json)).toBe(201);
      const blocked = await billingCall('POST', BENEFICIARY3_TOKEN, `/billing/cash-return-obligations/${s.obligationId}/confirm`);
      expect([blocked.status, blocked.json.code]).toEqual([409, 'assistance_dispute_open']);
      const answer = await billingCall('POST', ADMIN_TOKEN, `/billing/assistance-disputes/${d.json.id}/responses`, { position: 'contests' });
      expect(answer.json, JSON.stringify(answer.json)).toMatchObject({ status: 'open', response: { position: 'contests' } });
      expect((await billingCall('POST', ADMIN_TOKEN, `/billing/cash-return-obligations/${s.obligationId}/confirm`)).status).toBe(403); // never the Organization

      // another beneficiary's request, with no dispute: the confirmation resolves it
      const s2 = await obligationAfterFailure(BENEFICIARY2_TOKEN, ORGANIZATION_D);
      await billingCall('POST', ADMIN_TOKEN, `/billing/cash-return-obligations/${s2.obligationId}/return`, { returnedAt: new Date(Date.now() - 60_000).toISOString() });
      const ok = await billingCall('POST', BENEFICIARY2_TOKEN, `/billing/cash-return-obligations/${s2.obligationId}/confirm`);
      expect(ok.json, JSON.stringify(ok.json)).toMatchObject({ status: 'confirmed_returned', confirmedAt: expect.any(String) });
      expect((await billingCall('GET', BENEFICIARY2_TOKEN, `/billing/assistance-requests/${s2.requestId}`)).json).toMatchObject({ status: 'returned', overdue: false });
      expect((await billingAdmin.query(`SELECT count(*)::int AS n FROM subscription_purchase WHERE "assistanceRequestId" = ANY($1::uuid[])`, [[s.requestId, s2.requestId]])).rows[0].n).toBe(0);
      for (const [name, resource] of [['audit.assistance_dispute.opened', d.json.id], ['audit.assistance_dispute.responded', d.json.id], ['audit.cash_return_obligation.confirmed', s2.obligationId]]) {
        await waitFor(async () => (await billingAdmin.query(`SELECT "publishedAt" FROM outbox WHERE name = $1 AND payload->'resource'->>'id' = $2`, [name, resource])).rows[0]?.publishedAt != null,
          20_000, `the relay to publish ${name} to the broker`);
      }
    }, 120_000);

    it('UNSUCCESSFUL: a final failure, then the deadline: the sweep opens the cash-return obligation and the Organization reports the return; never a purchase', async () => {
      const s = await settlementAtPayment(BENEFICIARY2_TOKEN, ORGANIZATION_B);
      await capture(s.paymentId, 'failed');
      await waitFor(async () => (await billingAdmin.query(`SELECT status FROM assistance_settlement_channel WHERE "invoiceId" = $1`, [s.invoiceId])).rows[0]?.status === 'closed',
        20_000, 'the channel to close on Payment\'s final failure');
      // the deadline passes (a test-only move of the collection into the past; the triggers that keep it immutable are bypassed as a superuser)
      const cl = await billingAdmin.connect();
      try {
        await cl.query(`SET session_replication_role = replica`);
        await cl.query(`UPDATE assistance_request SET "consentAt" = now() - interval '100 hours', "cashCollectedAt" = now() - interval '73 hours', "reportedAt" = now() - interval '73 hours', "settleBy" = now() - interval '1 hour' WHERE id = $1`, [s.requestId]);
      } finally {
        await cl.query(`SET session_replication_role = origin`);
        cl.release();
      }
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [s.requestId])).rowCount! > 0,
        20_000, 'Billing\'s sweep to open the cash-return obligation');
      const view = await billingCall('GET', ADMIN_TOKEN, `/billing/assistance-requests/${s.requestId}`);
      expect(view.json).toMatchObject({ status: 'cash_collected', overdue: true, cashReturnObligation: { status: 'open', amount: 4200, currency: 'TND' } });
      const retry = await billingCall('POST', ADMIN_TOKEN, `/billing/assistance-requests/${s.requestId}/settlement`);
      expect([retry.status, retry.json.code]).toEqual([409, 'assistance_request_not_settleable']);

      const rr = await billingCall('POST', ADMIN_TOKEN, `/billing/cash-return-obligations/${view.json.cashReturnObligation.id}/return`, { returnedAt: new Date(Date.now() - 60_000).toISOString() });
      expect(rr.json, JSON.stringify(rr.json)).toMatchObject({ status: 'return_reported', amount: 4200 });
      expect((await billingAdmin.query(`SELECT count(*)::int AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [s.requestId])).rows[0].n).toBe(0);
      const ent = await billingCall('GET', producerToken.token, `/billing/users/${BENEFICIARY2}/platforms/${TEST_PLATFORM}/products/${productId}/entitlement`);
      expect(ent.json).toEqual({ valid: false, expiresAt: null });
    }, 90_000);
  },
);
