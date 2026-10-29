import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel } from 'amqplib';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';
import { billingPolicy, startReferenceStub, TEST_PLATFORM } from './support/admission.js';
import { createPaymentIdentity, type PaymentIdentity } from './support/payment-identity.js';

const refStub = await startReferenceStub();
let paymentIdentity: PaymentIdentity | undefined;
afterAll(() => refStub.close());

/**
 * Core V2 S6b (register BIL-24, PAY-07, PAY-08, AUTH-01 to AUTH-03; ADR-0067 decisions 1 to 7; the Owner's R6B-1 to R6B-10), certified
 * across THREE separately spawned, built processes — auth-service, billing-service and payment-service — over real HTTP and a REAL RabbitMQ,
 * on Payment's simulation provider (development and simulation only). No service imports another's code; Auth is the real Auth:
 *
 *   a verified Personal purchase (Payment → broker → Billing) → the Owner of the seller Company opens a refund case (S6a) → a factor
 *   (TOTP) step-up for the refund-authorization purpose and AUTH-01 issue a receipt bound to that case → the Owner relays it (BIL-24) →
 *   Billing records the relay, then PAY-07 → Payment verifies the payment and its capture fact, commits the intent and consumes the receipt
 *   at the REAL Auth (AUTH-02, Payment's own service token, `consumeRef` = the attempt id) → `authorized`, approver from Auth → the worker
 *   dispatches with the stable key → the simulated provider's signed refund notification → a `refund` fact and `succeeded` → Billing's
 *   reconciler mirrors it (PAY-08). Core V2 S6c: the verified refund is allocated, Payment completes the authorization once and publishes
 *   `refund.case_completed` over the real broker; Billing's verified consumer completes the case once. The purchase is never reversed (S6d).
 *
 * And the refused path: a receipt bound to other content is refused by Auth (`receipt_invalid`) → the attempt is `authorization_refused`
 * and the case can be cancelled.
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w @nawara/audit-contract -w auth-service -w billing-service -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUTH_DIR = `${ROOT}apps/auth-service`;
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const AUTH_PORT = 13611;
const BILLING_PORT = 13612;
const PAYMENT_PORT = 13613;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const COMPANY = randomUUID();
const OWNER = randomUUID();
const PAYER = randomUUID();
const PASSWORD = 's6b certification password';
const b64 = () => randomBytes(32).toString('base64');

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as Auth verifies it; the secret is base32. */
function totp(secretB32: string, t = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
/** Auth refuses a TOTP code twice: each factor use waits for the next 30-second step. */
const nextTotpStep = () => new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 500));

describeWithEnv(
  'Core V2 S6b: Owner receipt (real Auth) -> Billing relay -> Payment consumption, dispatch and verified refund evidence (simulation)',
  ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'],
  (env) => {
    let authDb: TestDatabase;
    let billingDb: TestDatabase;
    let paymentDb: TestDatabase;
    let auth: LiveService;
    let billing: LiveService;
    let payment: LiveService;
    let amqpConn: ChannelModel;
    let authAdmin: pg.Pool;
    let billingAdmin: pg.Pool;
    let paymentAdmin: pg.Pool;
    let ownerToken = '';
    let totpSecret = '';
    let payerToken = '';
    const producerToken = generateServiceToken();
    const billingToPaymentToken = generateServiceToken();
    const paymentToAuthToken = generateServiceToken();
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
    async function call(base: string, method: 'GET' | 'POST', token: string, path: string, body?: unknown, key: string | null = `idem-${randomUUID()}`): Promise<{ status: number; json: any }> {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(method === 'POST' && key ? { 'idempotency-key': key } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    }
    const tails = () => `--- auth ---\n${auth?.tail()}\n--- payment ---\n${payment?.tail()}\n--- billing ---\n${billing?.tail()}`;

    beforeAll(async () => {
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauths6b');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillings6b');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epayments6b');
      await runMigrations(authDb.url, [`${AUTH_DIR}/db/migrations/`], { fileTransaction: 'strip', strictHistory: true, adoptLegacyChecksums: true });
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      authAdmin = new pg.Pool({ connectionString: authDb.url });
      billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      paymentAdmin = new pg.Pool({ connectionString: paymentDb.url });

      // Auth: the Company, its Platform, its Owner and an ordinary member who buys
      const hash = await bcrypt.hash(PASSWORD, 4);
      await authAdmin.query(`INSERT INTO company(id, name) VALUES ($1, 'S6B')`, [COMPANY]);
      await authAdmin.query(`INSERT INTO platform(id, "companyId", name) VALUES ($1, $2, 'S6B platform')`, [TEST_PLATFORM, COMPANY]);
      const c = await authAdmin.connect();
      try {
        await c.query('BEGIN');
        await c.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'owner', 'owner-s6b@e2e.test', $2, 'admin')`, [OWNER, hash]);
        await c.query(`INSERT INTO owner("userId", "companyId") VALUES ($1, $2)`, [OWNER, COMPANY]);
        await c.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'member', 'payer-s6b@e2e.test', $2, 'member')`, [PAYER, hash]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      // Billing: the Platform's commercial configuration (S3d)
      await billingAdmin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [TEST_PLATFORM, COMPANY, randomUUID()]);

      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      paymentIdentity = await createPaymentIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
      await purgeQueue(BILLING_QUEUE);
      await purgeQueue(BILLING_DEAD_QUEUE);

      auth = spawnService('auth', AUTH_DIR, {
        NODE_ENV: 'test', PORT: String(AUTH_PORT), DATABASE_URL: authDb.url, AUTH_EVENTS: 'off', RABBITMQ_URL: env.TEST_RABBITMQ_URL,
        JWT_SECRET: b64(), OPERATOR_CODE_PEPPER: b64(), SECRET_KEY_PEPPER: b64(), THROTTLE_KEY_PEPPER: b64(), JOIN_CODE_PEPPER: b64(),
        TOTP_ENCRYPTION_KEYS: `k1:${b64()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', WEBAUTHN_RP_ID: 'auth.e2e.test', WEBAUTHN_ORIGINS: 'https://auth.e2e.test',
        BCRYPT_COST: '4', REQUIRE_CONTACT_VERIFICATION: 'false',
        // the receipt routes: Auth's dedicated pepper, Payment's inbound token and the deny-by-default policy admitting payment-service only
        AUTHORIZATION_RECEIPT_PEPPER: b64(),
        SERVICE_TOKENS: `payment-service:${paymentToAuthToken.digest}`,
        AUTH_SERVICE_POLICY: JSON.stringify({ callers: { 'payment-service': { operations: ['authorization_receipt.consume', 'authorization_receipt.lookup'] } } }),
      });
      try {
        await waitForHealth(`${AUTH_URL}/health`, 30_000);
      } catch (e) {
        throw new Error(`${String(e)}\n${auth.tail()}`);
      }
      payment = spawnService('payment', PAYMENT_DIR, {
        NODE_ENV: 'test',
        PORT: String(PAYMENT_PORT),
        DATABASE_URL: paymentDb.url,
        AUTH_SERVICE_URL: AUTH_URL,
        AUTH_SERVICE_TOKEN: paymentToAuthToken.token, // Payment's own credential for AUTH-02 / AUTH-03 (S6b)
        RABBITMQ_URL: paymentIdentity!.url(env.TEST_RABBITMQ_URL),
        PAYMENT_SUPPORTED_CURRENCIES: 'TND',
        PAYMENT_SIMULATION_PROVIDER: 'true',
        PAYMENT_SIMULATION_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
        SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest},simulation-harness:${harnessToken.digest}`,
        // an ISOLATED TEST policy (R6B-1): only billing-service holds the refund relay
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.refund.create'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
        ...refStub.env,
      });
      billing = spawnService('billing', BILLING_DIR, {
        NODE_ENV: 'test',
        PORT: String(BILLING_PORT),
        DATABASE_URL: billingDb.url,
        AUTH_SERVICE_URL: AUTH_URL, // the Owner is verified live by the real Auth (/auth/grants, /auth/platform-access)
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
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n${tails()}`);
      }

      // a real Owner session (the bootstrap enrollment path), and the payer's session
      const start = await call(AUTH_URL, 'POST', '', '/auth/login', { email: 'owner-s6b@e2e.test', password: PASSWORD }, null);
      expect(start.json?.status, JSON.stringify(start.json)).toBe('enrollment_required');
      const begin = await call(AUTH_URL, 'POST', '', '/auth/admin/enroll/totp', { enrollmentToken: start.json.enrollmentToken }, null);
      totpSecret = begin.json.secret;
      const confirm = await call(AUTH_URL, 'POST', '', '/auth/admin/enroll/totp/confirm', { enrollmentToken: start.json.enrollmentToken, factorId: begin.json.factorId, code: totp(totpSecret) }, null);
      expect(confirm.status, JSON.stringify(confirm.json)).toBe(200);
      ownerToken = confirm.json.accessToken;
      const payerLogin = await call(AUTH_URL, 'POST', '', '/auth/login', { email: 'payer-s6b@e2e.test', password: PASSWORD }, null);
      expect(payerLogin.status, JSON.stringify(payerLogin.json)).toBe(200);
      payerToken = payerLogin.json.accessToken;
    }, 120_000);

    afterAll(async () => {
      await billing?.stop();
      await payment?.stop();
      await auth?.stop();
      await paymentIdentity?.remove();
      if (amqpConn) {
        await purgeQueue(BILLING_QUEUE);
        await purgeQueue(BILLING_DEAD_QUEUE);
        await amqpConn.close().catch(() => undefined);
      }
      await authAdmin?.end();
      await billingAdmin?.end();
      await paymentAdmin?.end();
      await authDb?.drop();
      await billingDb?.drop();
      await paymentDb?.drop();
    }, 45_000);

    /** A verified Personal purchase sold by the Company: Billing invoice → Payment (simulation) capture → broker → Billing purchase. */
    async function purchase() {
      const productId = (await billingAdmin.query(
        `INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
         VALUES ('test-producer', 'company', $1, $2, 'Personal plan', 'active', 'personal', $3) RETURNING id`, [COMPANY, `s6b-${randomUUID().slice(0, 8)}`, TEST_PLATFORM])).rows[0].id;
      const priceId = (await billingAdmin.query(
        `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, $2, 'TND', 7300, 'recurring', 'month', 1) RETURNING id`,
        [productId, `s6b-${randomUUID().slice(0, 8)}`])).rows[0].id;
      const invoice = await call(BILLING_URL, 'POST', producerToken.token, '/billing/invoices', {
        invoiceRequestId: randomUUID(), seller: { type: 'company', id: COMPANY }, payer: { type: 'user', id: PAYER },
        sourceType: 'contract', sourceId: `src-${randomUUID()}`, issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId, quantity: 1 }],
      });
      expect(invoice.status, JSON.stringify(invoice.json)).toBe(201);
      expect((await call(BILLING_URL, 'POST', producerToken.token, `/billing/invoices/${invoice.json.id}/issue`)).status).toBe(200);
      const created = await call(BILLING_URL, 'POST', producerToken.token, `/billing/invoices/${invoice.json.id}/payment-requests`);
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      let paymentId = '';
      await waitFor(async () => {
        paymentId = (await billingAdmin.query(`SELECT "paymentId" FROM payment_request WHERE id = $1 AND status = 'requested'`, [created.json.id])).rows[0]?.paymentId ?? '';
        return !!paymentId;
      }, 15_000, 'the dispatcher to create the payment at Payment');
      const attempt = await call(PAYMENT_URL, 'POST', payerToken, `/payment/payments/${paymentId}/attempts`, {});
      expect(attempt.json, JSON.stringify(attempt.json)).toMatchObject({ provider: 'simulation', status: 'submitted' });
      const r = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${paymentId}/attempts/${attempt.json.id}/outcomes`, { commandId: `s6b-${randomUUID()}`, outcome: 'succeeded' });
      expect(r.json?.delivered, JSON.stringify(r.json)).toEqual({ status: 200 });
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM subscription_purchase WHERE "invoiceId" = $1`, [invoice.json.id])).rowCount! > 0,
        30_000, 'Billing to record the purchase from the verified event over the broker');
      return { paymentId, invoiceId: invoice.json.id as string };
    }
    async function openCase(paymentId: string) {
      const r = await call(BILLING_URL, 'POST', ownerToken, '/billing/admin/refund-cases', { paymentId, reason: 'customer_request' });
      expect(r.status, `${JSON.stringify(r.json)}\n${tails()}`).toBe(201);
      return r.json as { id: string; amount: number; currency: string };
    }
    /** AUTH-01 after a fresh factor step-up: one receipt for exactly this binding. */
    async function receipt(binding: Record<string, unknown>) {
      await nextTotpStep();
      const su = await call(AUTH_URL, 'POST', ownerToken, '/auth/admin/step-up', { purpose: 'refund.authorize', method: 'totp', code: totp(totpSecret) }, null);
      expect(su.status, JSON.stringify(su.json)).toBe(200);
      const r = await call(AUTH_URL, 'POST', ownerToken, '/auth/admin/authorization-receipts', { stepUpToken: su.json.stepUpToken, binding });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return r.json as { receiptId: string; secret: string };
    }
    const bindingOf = (c: { id: string; amount: number; currency: string }, paymentId: string, over: Record<string, unknown> = {}) => ({
      operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: c.id, paymentId, amount: c.amount, currency: c.currency, reason: 'customer_request',
      legalOverride: false, ...over,
    });
    const receiptRow = async (id: string) => (await authAdmin.query(`SELECT status, "consumeRef"::text AS "consumeRef", "consumedBy" FROM authorization_receipt WHERE id = $1`, [id])).rows[0];
    const attemptRow = async (id: string) => (await paymentAdmin.query(`SELECT * FROM refund_attempt WHERE id = $1`, [id])).rows[0];

    it('REAL AUTH: the Owner\'s receipt authorizes exactly one refund attempt, which the simulated provider refunds; nothing is completed or reversed', async () => {
      const { paymentId, invoiceId } = await purchase();
      const c = await openCase(paymentId);
      const r = await receipt(bindingOf(c, paymentId));

      const relayed = await call(BILLING_URL, 'POST', ownerToken, `/billing/admin/refund-cases/${c.id}/authorizations`, { receiptSecret: r.secret });
      expect(relayed.status, `${JSON.stringify(relayed.json)}\n${tails()}`).toBe(201);
      const attemptId = relayed.json.attempts[0].refundAttemptId as string;
      expect(relayed.json.attempts).toEqual([expect.objectContaining({ refundAttemptId: attemptId, status: 'authorized' })]);
      // Auth: consumed once, by payment-service, under the attempt id; Payment: authorized, the approver from Auth
      expect(await receiptRow(r.receiptId)).toEqual({ status: 'consumed', consumeRef: attemptId, consumedBy: 'payment-service' });
      expect(await attemptRow(attemptId)).toMatchObject({ status: 'authorized', receiptId: r.receiptId, approvedByUserId: OWNER, companyId: COMPANY, paymentId });
      // the secret is in no database
      for (const [pool, sql] of [[billingAdmin, `SELECT string_agg(row_to_json(r)::text, ' ') AS a FROM refund_authorization_relay r`], [paymentAdmin, `SELECT string_agg(row_to_json(r)::text, ' ') AS a FROM refund_attempt r`],
        [billingAdmin, `SELECT string_agg(payload::text, ' ') AS a FROM outbox`], [paymentAdmin, `SELECT string_agg(payload::text, ' ') AS a FROM outbox`]] as const) {
        expect(((await pool.query(sql)).rows[0].a ?? '') as string).not.toContain(r.secret);
      }
      // the consumed receipt cannot authorize anything else, and the case cannot be cancelled now
      expect((await call(BILLING_URL, 'POST', ownerToken, `/billing/admin/refund-cases/${c.id}/cancel`, undefined)).json.code).toBe('refund_processing_started');

      // the worker dispatches with the stable key; the provider's signed notification is the verified refund
      await waitFor(async () => (await attemptRow(attemptId)).status === 'submitted', 20_000, 'the refund worker to dispatch');
      const out = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/refunds/${attemptId}/outcomes`, { commandId: `s6b-${randomUUID()}`, outcome: 'succeeded' });
      expect(out.json?.delivered, JSON.stringify(out.json)).toEqual({ status: 200 });
      expect((await attemptRow(attemptId)).status).toBe('succeeded');
      expect((await paymentAdmin.query(`SELECT kind, amount::int, "refundAttemptId" FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'refund'`, [paymentId])).rows)
        .toEqual([{ kind: 'refund', amount: c.amount, refundAttemptId: attemptId }]);
      // Core V2 S6c: the verified refund is allocated and completes the authorization, once, at Payment; refund.case_completed crosses the REAL
      // broker as payment-service (its generated grant) and Billing's verified consumer completes the case, once
      const z = (await paymentAdmin.query(`SELECT id, "allocatedIntended"::int AS allocated, "completedAt" FROM refund_authorization WHERE "refundAttemptId" = $1`, [attemptId])).rows[0];
      expect(z).toMatchObject({ allocated: c.amount, completedAt: expect.any(Date) });
      await waitFor(async () => (await billingAdmin.query(`SELECT status FROM refund_case WHERE id = $1`, [c.id])).rows[0]?.status === 'completed',
        30_000, `Billing to complete the case from Payment's verified event over the broker\n${tails()}`);
      // the event itself crossed the broker and was verified (Billing recorded its broker-verified origin), whichever path completed first
      // (Billing's relay reconciler polls Payment too): exactly one completion, bound to Payment's authorization
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM payment_event_origin WHERE "eventName" = 'refund.case_completed' AND source = 'payment-service'`)).rowCount === 1,
        30_000, 'the verified refund.case_completed delivery');
      const completion = (await billingAdmin.query(`SELECT source, "refundAuthorizationId", "refundAttemptId" FROM refund_case_completion WHERE "refundCaseId" = $1`, [c.id])).rows;
      expect(completion).toEqual([expect.objectContaining({ refundAuthorizationId: z.id, refundAttemptId: attemptId })]);
      const read = await call(BILLING_URL, 'GET', ownerToken, `/billing/admin/refund-cases/${c.id}`);
      expect(read.json).toMatchObject({ status: 'completed', completedAt: new Date(z.completedAt).toISOString(), completion: { refundAuthorizationId: z.id } });
      // S6d stays out: no reversal, the payment untouched, no other refund.* event, exactly one completion event
      expect((await billingAdmin.query(`SELECT count(*)::int AS n FROM subscription_purchase_reversal v JOIN subscription_purchase s ON s.id = v."purchaseId" WHERE s."invoiceId" = $1`, [invoiceId])).rows[0].n).toBe(0);
      expect((await paymentAdmin.query(`SELECT status FROM payment WHERE id = $1`, [paymentId])).rows[0].status).toBe('succeeded');
      expect((await paymentAdmin.query(`SELECT name FROM outbox WHERE name LIKE 'refund.%'`)).rows.map((x) => x.name)).toEqual(['refund.case_completed']);
      expect((await paymentAdmin.query(`SELECT name FROM outbox WHERE (name LIKE 'audit.refund_attempt.%' AND payload->'resource'->>'id' = $1) OR (name = 'audit.refund_authorization.completed' AND payload->'resource'->>'id' = $2) ORDER BY "occurredAt", name`, [attemptId, z.id])).rows.map((x) => x.name))
        .toEqual(['audit.refund_attempt.authorized', 'audit.refund_attempt.succeeded', 'audit.refund_authorization.completed']);
      // a completed case refuses every new attempt, at Payment (FC-3) and at Billing
      expect((await call(PAYMENT_URL, 'POST', billingToPaymentToken.token, `/payment/payments/${paymentId}/refunds`, {
        refundAttemptId: randomUUID(), refundCaseId: c.id, amount: c.amount, currency: c.currency, reason: 'customer_request', legalOverride: false,
        receiptSecret: randomBytes(32).toString('base64url') })).json.code).toBe('refund_case_completed');
      expect((await call(BILLING_URL, 'POST', ownerToken, `/billing/admin/refund-cases/${c.id}/authorizations`, { receiptSecret: randomBytes(32).toString('base64url') })).json.code)
        .toBe('refund_case_completed');
      // nothing dead-lettered: the completion event was applied or acknowledged as a duplicate
      expect((await billingAdmin.query(`SELECT count(*)::int AS n FROM refund_case_completion WHERE "refundCaseId" = $1`, [c.id])).rows[0].n).toBe(1);
      const ch = await amqpConn.createChannel();
      expect((await ch.checkQueue(BILLING_DEAD_QUEUE)).messageCount).toBe(0);
      await ch.close();
    }, 180_000);

    it('REAL AUTH: a receipt bound to other content is refused by Auth; the attempt ends unconsumed and the case may be cancelled', async () => {
      const { paymentId } = await purchase();
      const c = await openCase(paymentId);
      const r = await receipt(bindingOf(c, paymentId, { reason: 'duplicate_charge' })); // the Owner approved another reason than the case's
      const relayed = await call(BILLING_URL, 'POST', ownerToken, `/billing/admin/refund-cases/${c.id}/authorizations`, { receiptSecret: r.secret });
      expect(relayed.json?.code, `${JSON.stringify(relayed.json)}\n${tails()}`).toBe('refund_authorization_invalid');
      const [relay] = (await billingAdmin.query(`SELECT id, "attemptStatus" FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [c.id])).rows;
      expect(relay.attemptStatus).toBe('authorization_refused');
      expect(await attemptRow(relay.id)).toMatchObject({ status: 'authorization_refused', authorizationRefusal: 'receipt_invalid', receiptId: null });
      expect(await receiptRow(r.receiptId)).toEqual({ status: 'issued', consumeRef: null, consumedBy: null }); // never consumed
      const cancelled = await call(BILLING_URL, 'POST', ownerToken, `/billing/admin/refund-cases/${c.id}/cancel`, undefined);
      expect(cancelled.status, JSON.stringify(cancelled.json)).toBe(200);
    }, 180_000);
  },
);
