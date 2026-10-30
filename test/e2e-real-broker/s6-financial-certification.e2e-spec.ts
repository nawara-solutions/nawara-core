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
 * Core V2 S6 FINANCIAL CERTIFICATION (2026-10-30; the Owner's R6H-1 to R6H-12 and R6H-5), across THREE separately spawned, built processes —
 * auth-service (the REAL Auth: Owner session, factor step-up, receipts), billing-service and payment-service — over real HTTP and a REAL
 * RabbitMQ, on Payment's simulation provider. No service imports another's code; every financial movement enters through Payment's SIGNED
 * provider notification (the webhook pipeline), never a database fixture:
 *
 *   1. R6H-5 end to end: a verified purchase, then a DISTINCT duplicate capture the provider reports for the same attempt → Billing's
 *      reconciliation worker reads Payment's evidence (PAY-12, `payment.reconciliation.read`, real HTTP) and opens an `unmatched_capture`
 *      case → the Owner opens a capture-specific refund case (Billing reads Payment's capture evidence) → a receipt WITHOUT the capture is
 *      refused by the real Auth → a receipt bound to the capture authorizes exactly that refund → dispatch → the signed refund → allocation
 *      and completion → `refund.case_completed` over the broker → Billing completes the case with NO commercial effect (the purchase stands)
 *      → the worker resolves the reconciliation case by that completed refund. Payment's signed balance reflects both captures and the refund.
 *   2. EVT-10 over the broker: a success of an EARLIER attempt after the payment succeeded through another one → Payment records a late
 *      success and emits `payment.late_success.recorded` → Billing's verified consumer records it once (event origin verified) and opens a
 *      `late_success` case; the payment request stays as it was and no second purchase exists.
 *   3. PAY-12 authorization: only billing-service (its own token) reads Payment's reconciliation evidence.
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w @nawara/audit-contract -w auth-service -w billing-service -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUTH_DIR = `${ROOT}apps/auth-service`;
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const AUTH_PORT = 13631;
const BILLING_PORT = 13632;
const PAYMENT_PORT = 13633;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const COMPANY = randomUUID();
const OWNER = randomUUID();
const PAYER = randomUUID();
const PASSWORD = 's6 certification password';
const WEBHOOK_SECRET = randomBytes(32).toString('hex');
const PRICE = 6400;
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
  'Core V2 S6 financial certification: capture-specific refund, reconciliation and late success across real Auth, Billing and Payment (simulation)',
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
    /** A provider notification SIGNED as the simulation provider signs it: what the provider reports, through Payment's webhook pipeline. */
    async function signed(body: Record<string, unknown>): Promise<number> {
      const raw = JSON.stringify(body);
      const res = await fetch(`${PAYMENT_URL}/payment/webhooks/simulation`, {
        method: 'POST', body: raw,
        headers: { 'content-type': 'application/json', 'x-simulation-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') },
      });
      return res.status;
    }
    const tails = () => `--- auth ---\n${auth?.tail()}\n--- payment ---\n${payment?.tail()}\n--- billing ---\n${billing?.tail()}`;

    beforeAll(async () => {
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauths6cert');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillings6cert');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epayments6cert');
      await runMigrations(authDb.url, [`${AUTH_DIR}/db/migrations/`], { fileTransaction: 'strip', strictHistory: true, adoptLegacyChecksums: true });
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      authAdmin = new pg.Pool({ connectionString: authDb.url });
      billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      paymentAdmin = new pg.Pool({ connectionString: paymentDb.url });

      const hash = await bcrypt.hash(PASSWORD, 4);
      await authAdmin.query(`INSERT INTO company(id, name) VALUES ($1, 'S6CERT')`, [COMPANY]);
      await authAdmin.query(`INSERT INTO platform(id, "companyId", name) VALUES ($1, $2, 'S6CERT platform')`, [TEST_PLATFORM, COMPANY]);
      const c = await authAdmin.connect();
      try {
        await c.query('BEGIN');
        await c.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'owner', 'owner-s6cert@e2e.test', $2, 'admin')`, [OWNER, hash]);
        await c.query(`INSERT INTO owner("userId", "companyId") VALUES ($1, $2)`, [OWNER, COMPANY]);
        await c.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'member', 'payer-s6cert@e2e.test', $2, 'member')`, [PAYER, hash]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
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
        NODE_ENV: 'test', PORT: String(PAYMENT_PORT), DATABASE_URL: paymentDb.url,
        AUTH_SERVICE_URL: AUTH_URL, AUTH_SERVICE_TOKEN: paymentToAuthToken.token,
        RABBITMQ_URL: paymentIdentity!.url(env.TEST_RABBITMQ_URL),
        PAYMENT_SUPPORTED_CURRENCIES: 'TND', PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: WEBHOOK_SECRET,
        SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest},simulation-harness:${harnessToken.digest}`,
        // an ISOLATED TEST policy: billing-service holds the refund relay and, for S6h, the reconciliation read (R6H-6)
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.refund.create', 'payment.reconciliation.read'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
        ...refStub.env,
      });
      billing = spawnService('billing', BILLING_DIR, {
        NODE_ENV: 'test', PORT: String(BILLING_PORT), DATABASE_URL: billingDb.url,
        AUTH_SERVICE_URL: AUTH_URL, RABBITMQ_URL: env.TEST_RABBITMQ_URL, BILLING_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `test-producer:${producerToken.digest}`, ...billingPolicy('test-producer'), ...refStub.env,
        PAYMENT_SERVICE_URL: PAYMENT_URL, PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
        BILLING_DISPATCH_INTERVAL_MS: '300', BILLING_RECONCILE_INTERVAL_MS: '3600000',
      });
      try {
        await Promise.all([waitForHealth(`${PAYMENT_URL}/health`, 20_000), waitForHealth(`${BILLING_URL}/health`, 20_000)]);
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n${tails()}`);
      }

      const start = await call(AUTH_URL, 'POST', '', '/auth/login', { email: 'owner-s6cert@e2e.test', password: PASSWORD }, null);
      expect(start.json?.status, JSON.stringify(start.json)).toBe('enrollment_required');
      const begin = await call(AUTH_URL, 'POST', '', '/auth/admin/enroll/totp', { enrollmentToken: start.json.enrollmentToken }, null);
      totpSecret = begin.json.secret;
      const confirm = await call(AUTH_URL, 'POST', '', '/auth/admin/enroll/totp/confirm', { enrollmentToken: start.json.enrollmentToken, factorId: begin.json.factorId, code: totp(totpSecret) }, null);
      expect(confirm.status, JSON.stringify(confirm.json)).toBe(200);
      ownerToken = confirm.json.accessToken;
      const payerLogin = await call(AUTH_URL, 'POST', '', '/auth/login', { email: 'payer-s6cert@e2e.test', password: PASSWORD }, null);
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

    /** A Personal invoice of the Company: issued, its payment request dispatched to Payment (the real dispatcher). */
    async function requested() {
      const productId = (await billingAdmin.query(
        `INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
         VALUES ('test-producer', 'company', $1, $2, 'Personal plan', 'active', 'personal', $3) RETURNING id`, [COMPANY, `s6c-${randomUUID().slice(0, 8)}`, TEST_PLATFORM])).rows[0].id;
      const priceId = (await billingAdmin.query(
        `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, $2, 'TND', $3, 'recurring', 'month', 1) RETURNING id`,
        [productId, `s6c-${randomUUID().slice(0, 8)}`, PRICE])).rows[0].id;
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
      return { paymentId, invoiceId: invoice.json.id as string, paymentRequestId: created.json.id as string };
    }
    const attemptOf = async (paymentId: string) => {
      const a = await call(PAYMENT_URL, 'POST', payerToken, `/payment/payments/${paymentId}/attempts`, {});
      expect(a.json, JSON.stringify(a.json)).toMatchObject({ provider: 'simulation', status: 'submitted' });
      return a.json as { id: string };
    };
    const outcome = async (paymentId: string, attemptId: string, o: Record<string, unknown>) => {
      const r = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${paymentId}/attempts/${attemptId}/outcomes`, { commandId: `s6c-${randomUUID()}`, ...o });
      expect(r.json?.delivered, JSON.stringify(r.json)).toEqual({ status: 200 });
    };
    const purchased = (invoiceId: string) => waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM subscription_purchase WHERE "invoiceId" = $1`, [invoiceId])).rowCount! > 0,
      30_000, `Billing to record the purchase from the verified event over the broker\n${tails()}`);
    async function receipt(binding: Record<string, unknown>) {
      await nextTotpStep();
      const su = await call(AUTH_URL, 'POST', ownerToken, '/auth/admin/step-up', { purpose: 'refund.authorize', method: 'totp', code: totp(totpSecret) }, null);
      expect(su.status, JSON.stringify(su.json)).toBe(200);
      const r = await call(AUTH_URL, 'POST', ownerToken, '/auth/admin/authorization-receipts', { stepUpToken: su.json.stepUpToken, binding });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return r.json as { receiptId: string; secret: string };
    }
    const deadLettered = async () => {
      const ch = await amqpConn.createChannel();
      const n = (await ch.checkQueue(BILLING_DEAD_QUEUE)).messageCount;
      await ch.close();
      return n;
    };

    it('R6H-5 + S6h across processes: a duplicate capture is reconciled, refunded as exactly that capture under its own real-Auth receipt, the purchase standing', async () => {
      const { paymentId, invoiceId } = await requested();
      const a = await attemptOf(paymentId);
      await outcome(paymentId, a.id, { outcome: 'succeeded' });
      await purchased(invoiceId);
      // the provider reports a SECOND, distinct capture of the same attempt (another provider transaction): signed, through the webhook pipeline
      const dupTxn = `sim_dup_${randomUUID()}`;
      expect(await signed({ eventId: `cert_${randomUUID()}`, type: 'payment.succeeded', reference: a.id, providerTransactionId: dupTxn, amount: PRICE, currency: 'TND' })).toBe(200);
      const dup = (await paymentAdmin.query(`SELECT id FROM provider_transaction_fact WHERE "providerTxnId" = $1 AND kind = 'capture'`, [dupTxn])).rows[0];
      expect(dup, 'the duplicate capture is a verified fact').toBeDefined();
      // Billing's reconciliation worker reads Payment's evidence (real HTTP, its own token, payment.reconciliation.read) and opens the case
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM reconciliation_case WHERE "caseType" = 'unmatched_capture' AND "evidenceKey" = $1`, [dup.id])).rowCount === 1,
        60_000, `Billing's reconciliation worker to open the case from Payment's evidence\n${tails()}`);
      // the Owner opens a capture-specific case: amount from Payment's verified capture, never the request
      const opened = await call(BILLING_URL, 'POST', ownerToken, '/billing/admin/refund-cases', { paymentId, captureFactId: dup.id, reason: 'duplicate_charge' });
      expect(opened.status, `${JSON.stringify(opened.json)}\n${tails()}`).toBe(201);
      expect(opened.json).toMatchObject({ eligibility: 'capture_specific', amount: PRICE, capture: { captureFactId: dup.id, basis: 'duplicate_capture' } });
      const caseId = opened.json.id as string;
      const binding = { operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId, amount: PRICE, currency: 'TND',
        reason: 'duplicate_charge', legalOverride: false };
      // an ORDINARY receipt (no capture) never authorizes a capture-specific refund: the real Auth refuses it, nothing is consumed
      const ordinary = await receipt(binding);
      const refused = await call(BILLING_URL, 'POST', ownerToken, `/billing/admin/refund-cases/${caseId}/authorizations`, { receiptSecret: ordinary.secret });
      expect(refused.json?.code, `${JSON.stringify(refused.json)}\n${tails()}`).toBe('refund_authorization_invalid');
      expect((await authAdmin.query(`SELECT status FROM authorization_receipt WHERE id = $1`, [ordinary.receiptId])).rows[0].status).toBe('issued');
      // the receipt bound to exactly this capture: consumed once by Payment at the real Auth
      const r = await receipt({ ...binding, captureFactId: dup.id });
      const relayed = await call(BILLING_URL, 'POST', ownerToken, `/billing/admin/refund-cases/${caseId}/authorizations`, { receiptSecret: r.secret });
      expect(relayed.status, `${JSON.stringify(relayed.json)}\n${tails()}`).toBe(201);
      const attemptId = relayed.json.attempts.find((x: { status: string }) => x.status === 'authorized').refundAttemptId as string;
      const att = (await paymentAdmin.query(`SELECT "captureSpecific", "captureFactId", status FROM refund_attempt WHERE id = $1`, [attemptId])).rows[0];
      expect(att).toMatchObject({ captureSpecific: true, captureFactId: dup.id });
      expect(['authorized', 'dispatching', 'submitted']).toContain(att.status); // the worker may already be dispatching it
      expect((await authAdmin.query(`SELECT status, "consumeRef"::text AS "consumeRef" FROM authorization_receipt WHERE id = $1`, [r.receiptId])).rows[0])
        .toEqual({ status: 'consumed', consumeRef: attemptId });
      // dispatch, the provider's signed refund, allocation and completion; refund.case_completed crosses the broker
      await waitFor(async () => (await paymentAdmin.query(`SELECT status FROM refund_attempt WHERE id = $1`, [attemptId])).rows[0].status === 'submitted', 20_000, 'the refund worker to dispatch');
      const out = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/refunds/${attemptId}/outcomes`, { commandId: `s6c-${randomUUID()}`, outcome: 'succeeded' });
      expect(out.json?.delivered, JSON.stringify(out.json)).toEqual({ status: 200 });
      await waitFor(async () => (await billingAdmin.query(`SELECT status FROM refund_case WHERE id = $1`, [caseId])).rows[0]?.status === 'completed',
        30_000, `Billing to complete the case from Payment's verified completion\n${tails()}`);
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM refund_case_effect WHERE "refundCaseId" = $1`, [caseId])).rowCount === 1, 30_000, 'the effect worker');
      expect((await billingAdmin.query(`SELECT outcome, reason FROM refund_case_effect WHERE "refundCaseId" = $1`, [caseId])).rows[0]).toEqual({ outcome: 'none', reason: 'capture_refunded' });
      // the sale keeps its own capture and purchase: nothing reversed
      expect((await billingAdmin.query(`SELECT count(*)::int AS n FROM subscription_purchase_reversal v JOIN subscription_purchase s ON s.id = v."purchaseId" WHERE s."invoiceId" = $1`, [invoiceId])).rows[0].n).toBe(0);
      // the reconciliation case resolves by that completed refund (evidence-checked), never otherwise
      await waitFor(async () => (await billingAdmin.query(`SELECT r.kind FROM reconciliation_case c JOIN reconciliation_case_resolution r ON r."caseId" = c.id
          WHERE c."caseType" = 'unmatched_capture' AND c."evidenceKey" = $1`, [dup.id])).rows[0]?.kind === 'refund_completed', 60_000, `the worker to resolve the case\n${tails()}`);
      // Payment's signed balance (the Owner's own bearer, verified live by the real Auth): two captures, one refund
      const bal = await call(PAYMENT_URL, 'GET', ownerToken, `/payment/admin/payments/${paymentId}/balance`);
      expect(bal.json?.currencies, JSON.stringify(bal.json)).toEqual([{ currency: 'TND', captured: 2 * PRICE, refundedNet: PRICE, chargebackNet: 0, netRetained: PRICE }]);
      // the remaining capture backs the sale: it is never refunded on its own
      const settling = (await paymentAdmin.query(`SELECT id FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture' AND id <> $2`, [paymentId, dup.id])).rows[0];
      const again = await call(BILLING_URL, 'POST', ownerToken, '/billing/admin/refund-cases', { paymentId, captureFactId: settling.id, reason: 'duplicate_charge' });
      expect(again.status, JSON.stringify(again.json)).not.toBe(201);
      expect(await deadLettered()).toBe(0);
    }, 300_000);

    it('EVT-10 over the broker: a success of an earlier attempt after the payment succeeded is a late success, recorded once by Billing\'s verified consumer, never a purchase', async () => {
      const { paymentId, invoiceId, paymentRequestId } = await requested();
      const a1 = await attemptOf(paymentId);
      await outcome(paymentId, a1.id, { outcome: 'failed', failureCode: 'declined' });
      const a2 = await attemptOf(paymentId);
      await outcome(paymentId, a2.id, { outcome: 'succeeded' });
      await purchased(invoiceId);
      // the provider later reports a1's success (signed): Payment records a late success and emits payment.late_success.recorded
      const txn = `sim_late_${randomUUID()}`;
      await signed({ eventId: `cert_${randomUUID()}`, type: 'payment.succeeded', reference: a1.id, providerTransactionId: txn, amount: PRICE, currency: 'TND' });
      const late = (await paymentAdmin.query(`SELECT id, "factId" FROM payment_late_success WHERE "paymentId" = $1`, [paymentId])).rows[0];
      expect(late, `Payment records the late success\n${tails()}`).toBeDefined();
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM payment_late_success WHERE "lateSuccessId" = $1`, [late.id])).rowCount === 1,
        30_000, `Billing's verified consumer to record the late success over the broker\n${tails()}`);
      expect((await billingAdmin.query(`SELECT source, "factId" FROM payment_late_success WHERE "lateSuccessId" = $1`, [late.id])).rows[0]).toEqual({ source: 'event', factId: late.factId });
      expect((await billingAdmin.query(`SELECT count(*)::int AS n FROM payment_event_origin WHERE "eventName" = 'payment.late_success.recorded' AND source = 'payment-service'`)).rows[0].n).toBeGreaterThanOrEqual(1);
      const c = (await billingAdmin.query(`SELECT "captureFactId", amount::int FROM reconciliation_case WHERE "caseType" = 'late_success' AND "evidenceKey" = $1`, [late.id])).rows[0];
      expect(c).toEqual({ captureFactId: late.factId, amount: PRICE });
      // never a payment.succeeded: the request is as it was, one purchase, one applied success receipt
      expect((await billingAdmin.query(`SELECT status FROM payment_request WHERE id = $1`, [paymentRequestId])).rows[0].status).toBe('paid');
      expect((await billingAdmin.query(`SELECT count(*)::int AS n FROM subscription_purchase WHERE "invoiceId" = $1`, [invoiceId])).rows[0].n).toBe(1);
      expect((await billingAdmin.query(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "paymentRequestId" = $1 AND "eventName" = 'payment.succeeded' AND outcome = 'applied'`, [paymentRequestId])).rows[0].n).toBe(1);
      // the Owner sees the case through Billing's route (real Auth); a late success is never acknowledged away
      const listed = await call(BILLING_URL, 'GET', ownerToken, '/billing/admin/reconciliation-cases?type=late_success');
      expect(listed.json?.items?.some((x: { evidenceId: string }) => x.evidenceId === late.id), JSON.stringify(listed.json)).toBe(true);
      expect(await deadLettered()).toBe(0);
    }, 180_000);

    it('PAY-12 authorization: Payment\'s reconciliation evidence answers billing-service only; another caller is refused', async () => {
      expect((await call(PAYMENT_URL, 'GET', billingToPaymentToken.token, '/payment/reconciliation/items?kind=late_success')).status).toBe(200);
      expect((await call(PAYMENT_URL, 'GET', harnessToken.token, '/payment/reconciliation/items?kind=late_success')).status).toBe(403);
      expect((await call(PAYMENT_URL, 'GET', ownerToken, '/payment/reconciliation/items?kind=late_success')).status).toBe(401);
      expect((await call(PAYMENT_URL, 'GET', billingToPaymentToken.token, '/payment/reconciliation/items?kind=unmatched_fact')).json?.code).toBe('invalid_reconciliation_request');
    }, 60_000);
  },
);
