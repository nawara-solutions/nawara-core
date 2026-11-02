import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';
import { billingPolicy, TEST_PLATFORM } from './support/admission.js';
import { startFakeAuthServer, type FakeAuthServer } from './support/fake-auth.js';
import { createPaymentIdentity, type PaymentIdentity } from './support/payment-identity.js';

let paymentIdentity: PaymentIdentity | undefined;

/**
 * Core V2 S-INT G8 (readiness record `docs/architecture/core-v2-s-int-readiness.md` §7.3; S0-C7 item 1, DN-1.4): the pre-lifecycle invariant
 * ACROSS PROCESSES. Every other cross-process suite gives Billing and Payment a stand-in for Organization Service's reference read; here the
 * BUILT organization-service, authoritative on its own database and holding the hierarchy, answers it over real HTTP to the BUILT Billing and
 * Payment, which run a whole assisted settlement on it (simulation provider, a REAL RabbitMQ):
 *
 *   - the reference read carries exactly the three anchors (organizationId, platformId, companyId): no lifecycle field exists to consume;
 *   - each caller sees only its own Platform scope; an unknown Organization is the collapsed 404;
 *   - Billing creates the assistance request and Payment the Organization-payer payment from that reference alone; the request's restrictions
 *     never include `inactive` (no Core V2 path can produce an inactive scope); the beneficiary's purchase follows the verified success.
 *
 * Auth's own reference cache from Organization Service (`ensure`) is certified across processes by `test/e2e-auth-organization`
 * (stage21c2), and each service's absence of lifecycle state by T-A1 to T-A4. Here `/auth/me` is the established stand-in
 * (`support/fake-auth.ts`): no human authority is under test, and this suite proves nothing about Auth; `s-int-pre-lifecycle-real-auth` runs the same
 * invariant with the real Auth. SEEDED BY SQL: the hierarchy, its test activation in this disposable database (not F7), and Billing's catalog.
 * DEVELOPMENT AND SIMULATION ONLY.
 * Prerequisite: `npm run build -w @nawara/service-kit -w @nawara/audit-contract -w organization-service -w billing-service -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ORG_DIR = `${ROOT}apps/organization-service`;
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const ORG_PORT = 13731;
const BILLING_PORT = 13732;
const PAYMENT_PORT = 13733;
const ORG_URL = `http://127.0.0.1:${ORG_PORT}`;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const COMPANY = randomUUID();
const PLATFORM = randomUUID();
const OTHER_PLATFORM = randomUUID();
const ORGANIZATION = randomUUID();
const FOREIGN_ORGANIZATION = randomUUID(); // of another Platform, outside both callers' scope
const ADMIN_TOKEN = `sint-g8-admin-${randomUUID()}`;
const ADMIN_ID = randomUUID();
const BENEFICIARY_TOKEN = `sint-g8-beneficiary-${randomUUID()}`;
const BENEFICIARY = randomUUID();

describeWithEnv(
  'Core V2 S-INT G8: the authoritative organization-service\'s reference read drives Billing and Payment; three anchors, no lifecycle (real RabbitMQ; simulation)',
  ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'],
  (env) => {
    let orgDb: TestDatabase;
    let billingDb: TestDatabase;
    let paymentDb: TestDatabase;
    let org: LiveService;
    let billing: LiveService;
    let payment: LiveService;
    let fakeAuth: FakeAuthServer;
    let amqpConn: ChannelModel;
    let orgAdmin: pg.Pool;
    let billingAdmin: pg.Pool;
    let paymentAdmin: pg.Pool;
    let productId = '';
    let priceId = '';
    const billingRef = generateServiceToken();
    const paymentRef = generateServiceToken();
    const producerToken = generateServiceToken();
    const billingToPaymentToken = generateServiceToken();
    const harnessToken = generateServiceToken();
    const membership = (admin: boolean) => [{ id: randomUUID(), organization: { id: ORGANIZATION }, platform: { id: PLATFORM }, status: 'active' as const, isOrganizationAdmin: admin }];

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
    async function call(base: string, method: 'GET' | 'POST', token: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(method === 'POST' ? { 'idempotency-key': `idem-${randomUUID()}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    }
    const tails = () => `--- organization ---\n${org?.tail()}\n--- payment ---\n${payment?.tail()}\n--- billing ---\n${billing?.tail()}`;
    const reference = (token: string, id: string) => call(ORG_URL, 'GET', token, `/organization/reference/organizations/${id}`);

    beforeAll(async () => {
      orgDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eorgsintg8');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingsintg8');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymentsintg8');
      await runMigrations(orgDb.url, [kitMigrationsDir, `${ORG_DIR}/db/migrations/`]);
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      orgAdmin = new pg.Pool({ connectionString: orgDb.url });
      billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      paymentAdmin = new pg.Pool({ connectionString: paymentDb.url });

      // organization-service: its hierarchy, then AUTHORITATIVE (the test activation the service's own suites use,
      // apps/organization-service/test/support/app.ts `activateOwnership`): reference reads open only then
      await orgAdmin.query(`INSERT INTO company(id, name) VALUES ($1, 'G8 Company')`, [COMPANY]);
      for (const p of [PLATFORM, OTHER_PLATFORM]) await orgAdmin.query(`INSERT INTO platform(id, "companyId", name) VALUES ($1, $2, 'G8 Platform')`, [p, COMPANY]);
      await orgAdmin.query(`INSERT INTO organization(id, "platformId", name) VALUES ($1, $2, 'G8 Organization'), ($3, $4, 'G8 Foreign')`, [ORGANIZATION, PLATFORM, FOREIGN_ORGANIZATION, OTHER_PLATFORM]);
      await orgAdmin.query(`UPDATE ownership_state SET environment_class = COALESCE(environment_class, 'fresh')`);
      if ((await orgAdmin.query(`SELECT phase FROM ownership_state`)).rows[0].phase === 'PREPARED') await orgAdmin.query(`UPDATE ownership_state SET phase = 'VERIFIED', verified_digest = 'test'`);
      await orgAdmin.query(`UPDATE ownership_state SET phase = 'ACTIVATABLE', approved_by = 'test', approved_reference = 'test', approved_at = now()`);
      await orgAdmin.query(`UPDATE ownership_state SET phase = 'ACTIVE', activated_by = 'test', activated_at = now()`);

      // Billing: the Platform's commercial configuration and one Owner-catalog personal product (fixtures, as in S5b)
      await billingAdmin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [PLATFORM, COMPANY, randomUUID()]);
      productId = (await billingAdmin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
        VALUES ('billing-owner', 'company', $1, 'g8-plan', 'Personal plan', 'active', 'personal', $2) RETURNING id`, [COMPANY, PLATFORM])).rows[0].id;
      priceId = (await billingAdmin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom")
        VALUES ($1, 'monthly', 'TND', 3900, 'recurring', 'month', 1, '2020-01-01') RETURNING id`, [productId])).rows[0].id;

      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      paymentIdentity = await createPaymentIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
      await purgeQueue(BILLING_QUEUE);
      await purgeQueue(BILLING_DEAD_QUEUE);
      fakeAuth = await startFakeAuthServer({
        [ADMIN_TOKEN]: { id: ADMIN_ID, isActive: true, memberships: membership(true) },
        [BENEFICIARY_TOKEN]: { id: BENEFICIARY, isActive: true, memberships: membership(false) },
      });

      org = spawnService('organization', ORG_DIR, {
        NODE_ENV: 'test', PORT: String(ORG_PORT), DATABASE_URL: orgDb.url, AUTH_SERVICE_URL: 'http://127.0.0.1:1',
        SERVICE_TOKENS: `billing-service:${billingRef.digest},payment-service:${paymentRef.digest}`,
        SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { capabilities: ['hierarchy.reference.read'], allowedPlatforms: [PLATFORM] },
          'payment-service': { capabilities: ['hierarchy.reference.read'], allowedPlatforms: [PLATFORM] },
        } }),
      });
      try {
        await waitForHealth(`${ORG_URL}/health`, 30_000);
      } catch (e) {
        throw new Error(`${String(e)}\n${org.tail()}`);
      }
      const realReference = (token: string) => ({ ORGANIZATION_SERVICE_URL: ORG_URL, ORGANIZATION_REFERENCE_TOKEN: token });
      payment = spawnService('payment', PAYMENT_DIR, {
        NODE_ENV: 'test', PORT: String(PAYMENT_PORT), DATABASE_URL: paymentDb.url, AUTH_SERVICE_URL: fakeAuth.url,
        RABBITMQ_URL: paymentIdentity!.url(env.TEST_RABBITMQ_URL), PAYMENT_SUPPORTED_CURRENCIES: 'TND',
        PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
        SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest},simulation-harness:${harnessToken.digest}`,
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.create.assisted_settlement'], allowedPlatforms: [PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
        ...realReference(paymentRef.token), // the REAL reference read, Payment's own credential
      });
      billing = spawnService('billing', BILLING_DIR, {
        NODE_ENV: 'test', PORT: String(BILLING_PORT), DATABASE_URL: billingDb.url, AUTH_SERVICE_URL: fakeAuth.url,
        RABBITMQ_URL: env.TEST_RABBITMQ_URL, BILLING_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `test-producer:${producerToken.digest}`,
        BILLING_SERVICE_POLICY: billingPolicy('test-producer').BILLING_SERVICE_POLICY.replaceAll(TEST_PLATFORM, PLATFORM), // the shared test policy, on this suite's Platform
        PAYMENT_SERVICE_URL: PAYMENT_URL, PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
        BILLING_DISPATCH_INTERVAL_MS: '300', BILLING_RECONCILE_INTERVAL_MS: '3600000', BILLING_ASSISTANCE_SWEEP_INTERVAL_MS: '1000',
        ...realReference(billingRef.token), // the REAL reference read, Billing's own credential
      });
      try {
        await Promise.all([waitForHealth(`${PAYMENT_URL}/health`, 20_000), waitForHealth(`${BILLING_URL}/health`, 20_000)]);
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n${tails()}`);
      }
    }, 120_000);

    afterAll(async () => {
      await billing?.stop();
      await payment?.stop();
      await org?.stop();
      await paymentIdentity?.remove();
      await fakeAuth?.stop();
      if (amqpConn) {
        await purgeQueue(BILLING_QUEUE);
        await purgeQueue(BILLING_DEAD_QUEUE);
        await amqpConn.close().catch(() => undefined);
      }
      await orgAdmin?.end();
      await billingAdmin?.end();
      await paymentAdmin?.end();
      await orgDb?.drop();
      await billingDb?.drop();
      await paymentDb?.drop();
    }, 45_000);

    it('the reference read carries exactly the three anchors, within each caller\'s Platform scope; nothing else exists to consume', async () => {
      for (const token of [billingRef.token, paymentRef.token]) {
        const r = await reference(token, ORGANIZATION);
        expect(r.status, `${JSON.stringify(r.json)}\n${tails()}`).toBe(200);
        expect(r.json).toEqual({ organizationId: ORGANIZATION, platformId: PLATFORM, companyId: COMPANY }); // exactly: no lifecycle or other field
        expect((await reference(token, FOREIGN_ORGANIZATION)).status).toBe(404); // another Platform: the collapsed answer
        expect((await reference(token, randomUUID())).status).toBe(404);
      }
      expect((await reference(producerToken.token, ORGANIZATION)).status).toBe(401); // a caller organization-service does not know
    });

    it('an assisted settlement runs on the real reference alone: Billing\'s request, Payment\'s Organization-payer payment, the beneficiary\'s purchase; never an inactive restriction', async () => {
      // an Organization organization-service does not place in the Platform is refused by Billing, before anything is written
      const before = (await billingAdmin.query(`SELECT count(*)::int AS n FROM assistance_request`)).rows[0].n as number;
      const foreign = await call(BILLING_URL, 'POST', BENEFICIARY_TOKEN, '/billing/assistance-requests', { organizationId: FOREIGN_ORGANIZATION, productId, priceId, consent: true });
      expect(foreign.status, JSON.stringify(foreign.json)).toBeGreaterThanOrEqual(400);
      expect((await billingAdmin.query(`SELECT count(*)::int AS n FROM assistance_request`)).rows[0].n).toBe(before);

      const created = await call(BILLING_URL, 'POST', BENEFICIARY_TOKEN, '/billing/assistance-requests', { organizationId: ORGANIZATION, productId, priceId, consent: true });
      expect(created.status, `${JSON.stringify(created.json)}\n${tails()}`).toBe(201);
      expect((await billingAdmin.query(`SELECT "organizationId", "platformId" FROM assistance_request WHERE id = $1`, [created.json.id])).rows[0])
        .toEqual({ organizationId: ORGANIZATION, platformId: PLATFORM }); // the Platform is the reference's, never the request's
      // S0-C7: with no lifecycle source anywhere, the request's Organization is never restricted as inactive
      expect((await billingAdmin.query(`SELECT kind FROM billing_assistance_restrictions($1, now())`, [ORGANIZATION])).rows.map((r) => r.kind)).not.toContain('inactive');

      await new Promise((r) => setTimeout(r, 20));
      expect((await call(BILLING_URL, 'POST', ADMIN_TOKEN, `/billing/assistance-requests/${created.json.id}/cash-collection`, { cashCollectedAt: new Date().toISOString() })).status).toBe(200);
      const settled = await call(BILLING_URL, 'POST', ADMIN_TOKEN, `/billing/assistance-requests/${created.json.id}/settlement`);
      expect(settled.status, JSON.stringify(settled.json)).toBe(201);
      await waitFor(async () => (await billingAdmin.query(`SELECT "paymentId" FROM payment_request WHERE id = $1 AND status = 'requested'`, [settled.json.paymentRequestId])).rows[0]?.paymentId != null,
        20_000, `Billing's dispatcher to create the payment, which Payment verifies through the real reference\n${tails()}`);
      const paymentId = (await billingAdmin.query(`SELECT "paymentId" FROM payment_request WHERE id = $1`, [settled.json.paymentRequestId])).rows[0].paymentId as string;
      expect((await paymentAdmin.query(`SELECT "payerType", "payerId", "organizationId", purpose FROM payment WHERE id = $1`, [paymentId])).rows[0])
        .toEqual({ payerType: 'organization', payerId: ORGANIZATION, organizationId: ORGANIZATION, purpose: 'assisted_settlement' });

      const attempt = await call(PAYMENT_URL, 'POST', ADMIN_TOKEN, `/payment/payments/${paymentId}/attempts`, {});
      expect(attempt.json, `${JSON.stringify(attempt.json)}\n${tails()}`).toMatchObject({ provider: 'simulation', status: 'submitted' });
      const r = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${paymentId}/attempts/${attempt.json.id}/outcomes`, { commandId: `g8-${randomUUID()}`, outcome: 'succeeded' });
      expect(r.json?.delivered, JSON.stringify(r.json)).toEqual({ status: 200 });
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [created.json.id])).rowCount! > 0,
        30_000, `Billing to record the beneficiary's purchase from the verified event\n${tails()}`);
      const ent = await call(BILLING_URL, 'GET', producerToken.token, `/billing/users/${BENEFICIARY}/platforms/${PLATFORM}/products/${productId}/entitlement`);
      expect(ent.json).toMatchObject({ valid: true });
      expect((await billingAdmin.query(`SELECT kind FROM billing_assistance_restrictions($1, now())`, [ORGANIZATION])).rows.map((x) => x.kind)).not.toContain('inactive');
    }, 120_000);
  },
);
