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
 * Core V2 S-INT (readiness record `docs/architecture/core-v2-s-int-readiness.md` §7.3): G3, G4 and part of G6, across THREE separately spawned,
 * BUILT processes — the REAL auth-service (every actor's bearer is verified live through `/auth/me`; Organization memberships are Auth's own),
 * billing-service and payment-service — over real HTTP and a REAL RabbitMQ, on Payment's simulation provider. Every money movement enters
 * only through Payment's signed provider notifications; the one fixture is the Organization reference read (Organization Service is not
 * authoritative before F7), which places every Organization in the test Platform.
 *
 *   G3: an assisted purchase (the Organization pays the frozen base) → the provider's final loss with a full chargeback over the broker →
 *       the beneficiary KEEPS the entitlement (ADR-0044 B10) → the Organization's base-only recovery obligation and T3 → the Organization's
 *       administrator settles it at Payment: attempt 1 fails, attempt 2 recovers the base (T3 clears once) → the provider then reports attempt
 *       1's success: Payment's verified late success over the broker is entirely surplus owed to the Organization (B8), never revenue, never
 *       an entitlement effect, never re-opening T3.
 *   G4: an assisted settlement whose attempt 1 fails and attempt 2 settles it → the provider reports attempt 1's success: Payment's verified
 *       late success is recorded once (S0 §3.4 L-1) as a `late_success` reconciliation case (L-2), with no second purchase (L-5); that
 *       record is never L-4-applicable (finding F-SINT-1 of the S-INT certification record).
 *   G4 (L-4): from ONE labelled fixture — the deadline obligation placed while the channel is in flight, as Billing's own L-4 suite does,
 *       because no real event sequence reaches that state (F-SINT-1) — everything else is real: Payment's verified success over the broker
 *       is an L-1 late settlement, the beneficiary attests, the Owner's TOTP step-up and receipt come from the real Auth, Billing consumes
 *       it there, and the application supersedes the obligation and records the one purchase.
 *   G6 (part): with Auth down, a new assistance request, the recovery obligation read and the Organization's attempt at Payment all fail
 *       closed (503) and write nothing.
 *
 * DEVELOPMENT AND SIMULATION ONLY. Prerequisite: `npm run build -w @nawara/service-kit -w @nawara/audit-contract -w auth-service
 * -w billing-service -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUTH_DIR = `${ROOT}apps/auth-service`;
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const AUTH_PORT = 13721;
const BILLING_PORT = 13722;
const PAYMENT_PORT = 13723;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const COMPANY = 'aaaaaaaa-0000-4000-8000-00000000c0de'; // the reference stub's Company
const ORG_A = randomUUID(); // G3
const ORG_B = randomUUID(); // G4 (T3 of G3 never restricts it)
const ORG_C = randomUUID(); // G4 L-4 (its deadline obligation, T2, restricts only it)
const OWNER = randomUUID(); // the Owner of the seller Company (L-4), with a real TOTP factor at the real Auth
const OWNER_EMAIL = `owner-${randomUUID().slice(0, 8)}@s-int.e2e.test`;
const PASSWORD = 's-int assisted certification password';
const WEBHOOK_SECRET = randomBytes(32).toString('hex');
const BASE = 4200;
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

type Actor = { id: string; email: string; organizationId: string; admin: boolean; token: string };

describeWithEnv(
  'Core V2 S-INT G3/G4/G6: assisted loss → recovery and surplus; assisted late success; Auth outage (real Auth, Billing, Payment, RabbitMQ; simulation)',
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
    let productId = '';
    let priceId = '';
    const producerToken = generateServiceToken();
    const billingToPaymentToken = generateServiceToken();
    const harnessToken = generateServiceToken();
    const billingToAuthToken = generateServiceToken(); // Billing's own credential for Auth's receipt consumption (AUTH-02, AUTH-03)
    const paymentToAuthToken = generateServiceToken(); // Payment's own credential: refunds, and so disputes, exist only with it (S6b, S6e-D)
    const fileToken = generateServiceToken(); // set with it (development only); the attested L-4 path never calls File
    let ownerToken = '';
    let totpSecret = '';
    const actor = (organizationId: string, admin: boolean): Actor => ({ id: randomUUID(), email: `${randomUUID().slice(0, 8)}@s-int.e2e.test`, organizationId, admin, token: '' });
    const adminA = actor(ORG_A, true);
    const beneficiaryA = actor(ORG_A, false);
    const adminB = actor(ORG_B, true);
    const beneficiaryB = actor(ORG_B, false);
    const adminC = actor(ORG_C, true);
    const beneficiaryC = actor(ORG_C, false);

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
    async function call(base: string, method: 'GET' | 'POST', token: string | null, path: string, body?: unknown, key: string | null = `idem-${randomUUID()}`): Promise<{ status: number; json: any }> {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(method === 'POST' && key ? { 'idempotency-key': key } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    }
    /** A provider notification signed with the simulation webhook secret, into Payment's real webhook pipeline. */
    async function signed(body: Record<string, unknown>): Promise<number> {
      const raw = JSON.stringify(body);
      const res = await fetch(`${PAYMENT_URL}/payment/webhooks/simulation`, {
        method: 'POST', body: raw,
        headers: { 'content-type': 'application/json', 'x-simulation-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') },
      });
      return res.status;
    }
    const tails = () => `--- auth ---\n${auth?.tail()}\n--- payment ---\n${payment?.tail()}\n--- billing ---\n${billing?.tail()}`;
    const deadLettered = async () => {
      const ch = await amqpConn.createChannel();
      const n = (await ch.checkQueue(BILLING_DEAD_QUEUE)).messageCount;
      await ch.close();
      return n;
    };
    const count = async (pool: pg.Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0].n as number;
    const restrictions = async (organizationId: string) =>
      (await billingAdmin.query(`SELECT kind FROM billing_assistance_restrictions($1, now()) ORDER BY kind`, [organizationId])).rows.map((r) => r.kind as string);
    const b6 = async (userId: string) =>
      (await call(BILLING_URL, 'GET', producerToken.token, `/billing/users/${userId}/platforms/${TEST_PLATFORM}/products/${productId}/entitlement`)).json;
    const bil12 = async (a: Actor) => (await call(BILLING_URL, 'GET', a.token, `/billing/me/platforms/${TEST_PLATFORM}/personal-subscriptions`)).json;

    beforeAll(async () => {
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauthsintg3');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingsintg3');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymentsintg3');
      await runMigrations(authDb.url, [`${AUTH_DIR}/db/migrations/`], { fileTransaction: 'strip', strictHistory: true, adoptLegacyChecksums: true });
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      authAdmin = new pg.Pool({ connectionString: authDb.url });
      billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      paymentAdmin = new pg.Pool({ connectionString: paymentDb.url });

      // Auth: the Company, its Platform, two Organizations and their members (an administrator and a beneficiary each), with ACTIVE
      // memberships: the facts `/auth/me` answers live, per request, to Billing and Payment
      const hash = await bcrypt.hash(PASSWORD, 4);
      await authAdmin.query(`INSERT INTO company(id, name) VALUES ($1, 'S-INT')`, [COMPANY]);
      await authAdmin.query(`INSERT INTO platform(id, "companyId", name) VALUES ($1, $2, 'S-INT platform')`, [TEST_PLATFORM, COMPANY]);
      for (const org of [ORG_A, ORG_B, ORG_C]) await authAdmin.query(`INSERT INTO organization(id, "platformId", name) VALUES ($1, $2, 'S-INT organization')`, [org, TEST_PLATFORM]);
      const oc = await authAdmin.connect();
      try {
        await oc.query('BEGIN');
        await oc.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'owner', $2, $3, 'admin')`, [OWNER, OWNER_EMAIL, hash]);
        await oc.query(`INSERT INTO owner("userId", "companyId") VALUES ($1, $2)`, [OWNER, COMPANY]);
        await oc.query('COMMIT');
      } finally {
        oc.release();
      }
      for (const a of [adminA, beneficiaryA, adminB, beneficiaryB, adminC, beneficiaryC]) {
        const c = await authAdmin.connect();
        try {
          await c.query('BEGIN');
          await c.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'member', $2, $3, 'member')`, [a.id, a.email, hash]);
          await c.query(`INSERT INTO organization_membership ("userId", "organizationId", status, audience, "approvedAt", "isOrganizationAdmin") VALUES ($1, $2, 'active', 'member', now(), $3)`,
            [a.id, a.organizationId, a.admin]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      }
      // Billing: the Platform's commercial configuration (S3d) and one Owner-catalog personal product with a monthly price (S3g)
      await billingAdmin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [TEST_PLATFORM, COMPANY, randomUUID()]);
      productId = (await billingAdmin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
        VALUES ('billing-owner', 'company', $1, 's-int-plan', 'Personal plan', 'active', 'personal', $2) RETURNING id`, [COMPANY, TEST_PLATFORM])).rows[0].id;
      priceId = (await billingAdmin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom")
        VALUES ($1, 'monthly', 'TND', $2, 'recurring', 'month', 1, '2020-01-01') RETURNING id`, [productId, BASE])).rows[0].id;

      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      paymentIdentity = await createPaymentIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
      await purgeQueue(BILLING_QUEUE);
      await purgeQueue(BILLING_DEAD_QUEUE);

      auth = spawnService('auth', AUTH_DIR, {
        NODE_ENV: 'test', PORT: String(AUTH_PORT), DATABASE_URL: authDb.url, AUTH_EVENTS: 'off', RABBITMQ_URL: env.TEST_RABBITMQ_URL,
        JWT_SECRET: b64(), OPERATOR_CODE_PEPPER: b64(), SECRET_KEY_PEPPER: b64(), THROTTLE_KEY_PEPPER: b64(), JOIN_CODE_PEPPER: b64(),
        TOTP_ENCRYPTION_KEYS: `k1:${b64()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', WEBAUTHN_RP_ID: 'auth.e2e.test', WEBAUTHN_ORIGINS: 'https://auth.e2e.test',
        BCRYPT_COST: '4', REQUIRE_CONTACT_VERIFICATION: 'false',
        // the receipt routes: Auth's dedicated pepper, Billing's inbound token and the deny-by-default policy admitting billing-service only
        AUTHORIZATION_RECEIPT_PEPPER: b64(),
        SERVICE_TOKENS: `billing-service:${billingToAuthToken.digest},payment-service:${paymentToAuthToken.digest}`,
        AUTH_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['authorization_receipt.consume', 'authorization_receipt.lookup'] },
          'payment-service': { operations: ['authorization_receipt.consume', 'authorization_receipt.lookup'] },
        } }),
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
        AUTH_SERVICE_URL: AUTH_URL, // the Organization actor paying at Payment is verified live by the real Auth (S4e)
        // Payment's own Auth credential: with the refund relay grant below, Payment's refunds — and so its dispute ingestion (S6e-D:
        // "exactly where refunds are") — exist, as in s6b-refund-processing; development and simulation only
        AUTH_SERVICE_TOKEN: paymentToAuthToken.token,
        RABBITMQ_URL: paymentIdentity!.url(env.TEST_RABBITMQ_URL),
        PAYMENT_SUPPORTED_CURRENCIES: 'TND',
        PAYMENT_SIMULATION_PROVIDER: 'true',
        PAYMENT_SIMULATION_WEBHOOK_SECRET: WEBHOOK_SECRET,
        SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest},simulation-harness:${harnessToken.digest}`,
        // an ISOLATED TEST policy: billing-service holds the narrow Organization-payer grants (assisted and recovery settlement) only here
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.create.assisted_settlement', 'payment.create.recovery_settlement', 'payment.refund.create'],
            allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
        ...refStub.env,
      });
      billing = spawnService('billing', BILLING_DIR, {
        NODE_ENV: 'test',
        PORT: String(BILLING_PORT),
        DATABASE_URL: billingDb.url,
        AUTH_SERVICE_URL: AUTH_URL, // every assistance, recovery and member actor is verified live by the real Auth
        RABBITMQ_URL: env.TEST_RABBITMQ_URL,
        BILLING_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `test-producer:${producerToken.digest}`, ...billingPolicy('test-producer'), ...refStub.env,
        PAYMENT_SERVICE_URL: PAYMENT_URL,
        PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
        BILLING_DISPATCH_INTERVAL_MS: '300',
        BILLING_RECONCILE_INTERVAL_MS: '3600000',
        BILLING_ASSISTANCE_SWEEP_INTERVAL_MS: '1000',
        // Billing's receipt credentials (development and simulation only; refused in production): the L-4 application consumes the Owner's
        // receipt at the real Auth. File is configured with them, as the configuration requires; the attested path never calls it.
        AUTH_SERVICE_TOKEN: billingToAuthToken.token, FILE_SERVICE_URL: 'http://127.0.0.1:1', FILE_SERVICE_TOKEN: fileToken.token,
      });
      try {
        await Promise.all([waitForHealth(`${PAYMENT_URL}/health`, 20_000), waitForHealth(`${BILLING_URL}/health`, 20_000)]);
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n${tails()}`);
      }
      // the Owner's real session (the bootstrap enrollment path: a TOTP factor at the real Auth)
      const start = await call(AUTH_URL, 'POST', null, '/auth/login', { email: OWNER_EMAIL, password: PASSWORD }, null);
      expect(start.json?.status, JSON.stringify(start.json)).toBe('enrollment_required');
      const begin = await call(AUTH_URL, 'POST', null, '/auth/admin/enroll/totp', { enrollmentToken: start.json.enrollmentToken }, null);
      totpSecret = begin.json.secret;
      const confirm = await call(AUTH_URL, 'POST', null, '/auth/admin/enroll/totp/confirm', { enrollmentToken: start.json.enrollmentToken, factorId: begin.json.factorId, code: totp(totpSecret) }, null);
      expect(confirm.status, JSON.stringify(confirm.json)).toBe(200);
      ownerToken = confirm.json.accessToken;
      for (const a of [adminA, beneficiaryA, adminB, beneficiaryB, adminC, beneficiaryC]) {
        const login = await call(AUTH_URL, 'POST', null, '/auth/login', { email: a.email, password: PASSWORD }, null);
        expect(login.status, JSON.stringify(login.json)).toBe(200);
        a.token = login.json.accessToken;
      }
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

    /** A consented request whose cash the Organization collected; then its electronic settlement, dispatched to Payment (S5b). */
    async function settlementAtPayment(beneficiary: Actor, admin: Actor) {
      const created = await call(BILLING_URL, 'POST', beneficiary.token, '/billing/assistance-requests', { organizationId: beneficiary.organizationId, productId, priceId, consent: true });
      expect(created.status, `${JSON.stringify(created.json)}\n${tails()}`).toBe(201);
      await new Promise((r) => setTimeout(r, 20)); // the collection is after the consent
      const cash = await call(BILLING_URL, 'POST', admin.token, `/billing/assistance-requests/${created.json.id}/cash-collection`, { cashCollectedAt: new Date().toISOString() });
      expect(cash.status, JSON.stringify(cash.json)).toBe(200);
      const settled = await call(BILLING_URL, 'POST', admin.token, `/billing/assistance-requests/${created.json.id}/settlement`);
      expect(settled.status, JSON.stringify(settled.json)).toBe(201);
      const paymentId = await requestedAt(settled.json.paymentRequestId as string);
      return { requestId: created.json.id as string, invoiceId: settled.json.invoiceId as string, paymentRequestId: settled.json.paymentRequestId as string, paymentId };
    }
    /** The payment Billing's real dispatcher created at Payment for this payment request. */
    async function requestedAt(paymentRequestId: string): Promise<string> {
      await waitFor(async () => (await billingAdmin.query(`SELECT "paymentId" FROM payment_request WHERE id = $1 AND status = 'requested'`, [paymentRequestId])).rows[0]?.paymentId != null,
        20_000, `the dispatcher to create the Organization-payer payment at Payment\n${tails()}`);
      return (await billingAdmin.query(`SELECT "paymentId" FROM payment_request WHERE id = $1`, [paymentRequestId])).rows[0].paymentId as string;
    }
    /** The Organization actor's attempt at Payment (S4e), verified live by the real Auth. */
    async function attemptOf(paymentId: string, admin: Actor) {
      const a = await call(PAYMENT_URL, 'POST', admin.token, `/payment/payments/${paymentId}/attempts`, {});
      expect(a.json, `${JSON.stringify(a.json)}\n${tails()}`).toMatchObject({ provider: 'simulation', status: 'submitted' });
      return a.json as { id: string };
    }
    async function outcome(paymentId: string, attemptId: string, o: Record<string, unknown>) {
      const r = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${paymentId}/attempts/${attemptId}/outcomes`, { commandId: `sint-${randomUUID()}`, ...o });
      expect(r.json?.delivered, JSON.stringify(r.json)).toEqual({ status: 200 });
    }
    /** The provider later reports a FAILED attempt's success (signed): Payment's verified late success and its event over the broker. */
    async function lateSuccessOf(paymentId: string, attemptId: string, amount: number) {
      expect(await signed({ eventId: `sint_${randomUUID()}`, type: 'payment.succeeded', reference: attemptId, providerTransactionId: `sim_late_${randomUUID()}`, amount, currency: 'TND' }))
        .toBeLessThan(500);
      const late = (await paymentAdmin.query(`SELECT id, "factId" FROM payment_late_success WHERE "paymentId" = $1 AND "attemptId" = $2`, [paymentId, attemptId])).rows[0];
      expect(late, `Payment records the late success\n${tails()}`).toBeDefined();
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM payment_late_success WHERE "lateSuccessId" = $1`, [late.id])).rowCount === 1,
        30_000, `Billing's verified consumer to record the late success over the broker\n${tails()}`);
      expect((await billingAdmin.query(`SELECT source FROM payment_late_success WHERE "lateSuccessId" = $1`, [late.id])).rows[0].source).toBe('event');
      return late as { id: string; factId: string };
    }

    it('G3: an assisted purchase lost at final chargeback keeps the entitlement; the Organization recovers the base through Payment; a later success of the first attempt is surplus only', async () => {
      // 1. the assisted purchase: the Organization pays the frozen base at Payment; the verified success gives the beneficiary the purchase
      const s = await settlementAtPayment(beneficiaryA, adminA);
      expect((await paymentAdmin.query(`SELECT "payerType", "payerId", purpose, "beneficiaryUserId" FROM payment WHERE id = $1`, [s.paymentId])).rows[0])
        .toEqual({ payerType: 'organization', payerId: ORG_A, purpose: 'assisted_settlement', beneficiaryUserId: beneficiaryA.id });
      const a = await attemptOf(s.paymentId, adminA);
      await outcome(s.paymentId, a.id, { outcome: 'succeeded' });
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [s.requestId])).rowCount! > 0,
        30_000, `Billing to record the beneficiary's purchase from the verified event\n${tails()}`);
      const purchase = (await billingAdmin.query(`SELECT id FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [s.requestId])).rows[0].id as string;
      const entitled = await b6(beneficiaryA.id);
      expect(entitled.valid).toBe(true);
      expect((await bil12(beneficiaryA)).items).toEqual([{ productId, valid: true, expiresAt: entitled.expiresAt }]); // G1 parity, assisted purchase

      // 2. the provider opens a dispute, then reports the final loss with its full chargeback: over the broker to Billing
      const ref = `sint-${randomUUID()}`;
      const sim = (send: Record<string, unknown>) => call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${s.paymentId}/disputes`, { commandId: `sint-${randomUUID()}`, disputeRef: ref, ...send });
      expect((await sim({ event: 'opened' })).json?.delivered).toEqual({ status: 200 });
      expect((await sim({ event: 'lost' })).json?.delivered).toEqual({ status: 200 });
      const dispute = (await paymentAdmin.query(`SELECT id FROM payment_dispute WHERE "providerDisputeId" = $1`, [`simd_${ref}`])).rows[0];
      const observations = (await paymentAdmin.query(`SELECT kind, disposition, reason FROM payment_dispute_observation WHERE "providerDisputeId" = $1 ORDER BY "observedAt"`, [`simd_${ref}`])).rows;
      expect(dispute, `Payment recorded no dispute; its observations: ${JSON.stringify(observations)}\n${tails()}`).toBeDefined();
      const disputeId = dispute.id as string;
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM dispute_loss_effect WHERE "disputeId" = $1`, [disputeId])).rowCount === 1,
        30_000, `Billing's dispute loss worker to apply the verified loss\n${tails()}`);
      // B10: the assisted purchase is preserved: no reversal; the beneficiary keeps the entitlement (B6 and BIL-12 agree)
      expect((await billingAdmin.query(`SELECT outcome, reason FROM dispute_loss_effect WHERE "disputeId" = $1`, [disputeId])).rows[0])
        .toEqual({ outcome: 'none', reason: 'assisted_purchase_preserved' });
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [purchase])).toBe(0);
      expect(await b6(beneficiaryA.id)).toEqual(entitled);
      expect((await bil12(beneficiaryA)).items).toEqual([{ productId, valid: true, expiresAt: entitled.expiresAt }]);

      // 3. S6f: the Organization's base-only recovery obligation and T3, opened by Billing's recovery worker
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM recovery_obligation WHERE "disputeId" = $1`, [disputeId])).rowCount === 1,
        30_000, `Billing's recovery worker to open the obligation\n${tails()}`);
      const obligationId = (await billingAdmin.query(`SELECT id FROM recovery_obligation WHERE "disputeId" = $1`, [disputeId])).rows[0].id as string;
      expect(await restrictions(ORG_A)).toEqual(['T3']);
      expect(await restrictions(ORG_B)).toEqual([]); // another Organization of the Platform is not restricted
      const read = await call(BILLING_URL, 'GET', adminA.token, `/billing/recovery-obligations/${obligationId}`);
      expect(read.status, JSON.stringify(read.json)).toBe(200);
      expect(read.json).toMatchObject({ baseAmount: BASE, recovered: 0, outstanding: BASE, status: 'open' }); // the base only, never a fee
      expect((await call(BILLING_URL, 'GET', beneficiaryA.token, `/billing/recovery-obligations/${obligationId}`)).status).not.toBe(200); // never the beneficiary
      // T3 blocks the Organization's NEW assistance requests only
      const blocked = await call(BILLING_URL, 'POST', beneficiaryA.token, '/billing/assistance-requests', { organizationId: ORG_A, productId, priceId, consent: true });
      expect([blocked.status, blocked.json?.code]).toEqual([409, 'assistance_restricted']);

      // 4. the administrator settles it at Payment: attempt 1 fails (the channel stays usable), attempt 2 recovers the base
      const c = await call(BILLING_URL, 'POST', adminA.token, `/billing/recovery-obligations/${obligationId}/settlement`);
      expect(c.status, `${JSON.stringify(c.json)}\n${tails()}`).toBe(201);
      const recoveryPayment = await requestedAt(c.json.paymentRequestId as string);
      expect((await paymentAdmin.query(`SELECT "payerType", "payerId", purpose, amount::int AS amount FROM payment WHERE id = $1`, [recoveryPayment])).rows[0])
        .toEqual({ payerType: 'organization', payerId: ORG_A, purpose: 'recovery_settlement', amount: BASE });
      const r1 = await attemptOf(recoveryPayment, adminA);
      await outcome(recoveryPayment, r1.id, { outcome: 'failed', failureCode: 'declined' });
      const r2 = await attemptOf(recoveryPayment, adminA);
      await outcome(recoveryPayment, r2.id, { outcome: 'succeeded' });
      await waitFor(async () => (await billingAdmin.query(`SELECT status FROM recovery_obligation WHERE id = $1`, [obligationId])).rows[0].status === 'recovered',
        30_000, `Billing to record the recovery from the verified event\n${tails()}`);
      const recovered = (await call(BILLING_URL, 'GET', adminA.token, `/billing/recovery-obligations/${obligationId}`)).json;
      expect(recovered).toMatchObject({ baseAmount: BASE, recovered: BASE, outstanding: 0, status: 'recovered', surpluses: [] });
      expect(await restrictions(ORG_A)).toEqual([]); // T3 cleared, once
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [s.requestId])).toBe(1); // no entitlement effect

      // 5. the provider reports attempt 1's success after all: Payment's verified late success over the broker is ENTIRELY surplus owed to
      //    the Organization (B8): never revenue, never offset against the base, never re-opening T3, never an entitlement effect
      await lateSuccessOf(recoveryPayment, r1.id, BASE);
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM recovery_surplus WHERE "obligationId" = $1`, [obligationId])).rowCount === 1,
        30_000, `Billing to classify the late success as surplus\n${tails()}`);
      const after = (await call(BILLING_URL, 'GET', adminA.token, `/billing/recovery-obligations/${obligationId}`)).json;
      expect(after).toMatchObject({ baseAmount: BASE, recovered: BASE, outstanding: 0, status: 'recovered' });
      expect(after.surpluses).toEqual([expect.objectContaining({ amount: BASE, status: 'owed_to_organization' })]);
      expect(after.payments.map((p: { principalAmount: number; surplusAmount: number }) => [p.principalAmount, p.surplusAmount]).sort()).toEqual([[0, BASE], [BASE, 0]]);
      expect(await restrictions(ORG_A)).toEqual([]);
      expect(await b6(beneficiaryA.id)).toEqual(entitled);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM recovery_payment WHERE "obligationId" = $1`, [obligationId])).toBe(2);
      expect(await deadLettered()).toBe(0);
    }, 300_000);

    it('G4: a later success of an assisted channel\'s failed attempt is recorded once as a late_success reconciliation case; never a second purchase (L-1, L-2, L-5)', async () => {
      const s = await settlementAtPayment(beneficiaryB, adminB);
      const a1 = await attemptOf(s.paymentId, adminB);
      await outcome(s.paymentId, a1.id, { outcome: 'failed', failureCode: 'declined' });
      const a2 = await attemptOf(s.paymentId, adminB);
      await outcome(s.paymentId, a2.id, { outcome: 'succeeded' });
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [s.requestId])).rowCount! > 0,
        30_000, `Billing to record the beneficiary's purchase\n${tails()}`);
      const before = await b6(beneficiaryB.id);
      expect(before.valid).toBe(true);

      const late = await lateSuccessOf(s.paymentId, a1.id, BASE);
      // L-1: recorded once, from the verified event; L-2: a reconciliation case (the request's own routing purpose), no purchase, no entitlement
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM reconciliation_case WHERE "caseType" = 'late_success' AND "evidenceKey" = $1`, [late.id])).rowCount === 1,
        30_000, `Billing to open the late_success reconciliation case\n${tails()}`);
      expect((await billingAdmin.query(`SELECT detail, amount::int AS amount FROM reconciliation_case WHERE "caseType" = 'late_success' AND "evidenceKey" = $1`, [late.id])).rows[0])
        .toEqual({ detail: 'assisted_settlement', amount: BASE });
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [s.requestId])).toBe(1); // L-5
      expect(await b6(beneficiaryB.id)).toEqual(before);
      // F-SINT-1 (recorded, not worked around): the verified late success of a definitively closed assisted channel creates no
      // `assistance_late_settlement`, so the S0 §3.4 L-4 application has no record to apply here
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM assistance_late_settlement WHERE "assistanceRequestId" = $1`, [s.requestId])).toBe(0);
      // a redelivered genuine late success changes nothing
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM payment_late_success WHERE "paymentId" = $1`, [s.paymentId])).toBe(1);
      expect(await deadLettered()).toBe(0);
    }, 180_000);

    it('G4 (L-4): from a labelled deadline-obligation FIXTURE, Payment\'s verified success is an L-1 late settlement; the beneficiary attests and the Owner\'s factor-bound receipt (real Auth) applies it as the one purchase', async () => {
      const s = await settlementAtPayment(beneficiaryC, adminC);
      const a = await attemptOf(s.paymentId, adminC); // the channel's attempt is still in flight
      // FIXTURE (F-SINT-1; the same two statements as Billing's own L-4 suite, `apps/billing-service/test/late-settlements.e2e-spec.ts`): the
      // deadline passed and the deadline obligation exists while the channel is still in flight. No real event sequence reaches this state
      // (the sweep opens no obligation while a channel is open or uncertain), so it is placed as a superuser with the triggers bypassed.
      const asFixture = async (sql: string, params: unknown[]) => {
        const cl = await billingAdmin.connect();
        try {
          await cl.query('SET session_replication_role = replica');
          await cl.query(sql, params);
        } finally {
          await cl.query('SET session_replication_role = origin');
          cl.release();
        }
      };
      await asFixture(`UPDATE assistance_request SET "consentAt" = date_trunc('milliseconds', now() - interval '100 hours'),
        "cashCollectedAt" = date_trunc('milliseconds', now() - interval '73 hours'), "reportedAt" = date_trunc('milliseconds', now() - interval '73 hours'),
        "settleBy" = date_trunc('milliseconds', now() - interval '1 hour') WHERE id = $1`, [s.requestId]);
      await asFixture(`INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt")
        SELECT id, "organizationId", "beneficiaryUserId", "totalAmount", currency, "cashCollectedAt" FROM assistance_request WHERE id = $1`, [s.requestId]);
      const obligationId = (await billingAdmin.query(`SELECT id FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [s.requestId])).rows[0].id as string;

      // from here on, real events and real authority only: the provider's signed success → Payment's verified fact → payment.succeeded over
      // the broker → Billing records the L-1 late settlement (the request has an obligation): no purchase, no entitlement (L-2)
      await outcome(s.paymentId, a.id, { outcome: 'succeeded' });
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM assistance_late_settlement WHERE "assistanceRequestId" = $1`, [s.requestId])).rowCount === 1,
        30_000, `Billing to record the late settlement from the verified event\n${tails()}`);
      const late = (await billingAdmin.query(`SELECT id, reason FROM assistance_late_settlement WHERE "assistanceRequestId" = $1`, [s.requestId])).rows[0] as { id: string; reason: string };
      expect(late.reason).toBe('cash_return_obligation_exists');
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [s.requestId])).toBe(0);
      expect(await b6(beneficiaryC.id)).toEqual({ valid: false, expiresAt: null });

      // the beneficiary attests (the Organization's administrator cannot); live through the real Auth
      expect((await call(BILLING_URL, 'POST', adminC.token, `/billing/assistance-late-settlements/${late.id}/attestation`, { statement: 'cash_not_returned' })).status).toBe(403);
      const att = await call(BILLING_URL, 'POST', beneficiaryC.token, `/billing/assistance-late-settlements/${late.id}/attestation`, { statement: 'cash_not_returned' });
      expect(att.status, JSON.stringify(att.json)).toBe(201);

      // the Owner's factor step-up for exactly this purpose, and Auth's receipt bound to exactly this application (AUTH-01)
      const binding = { operation: 'late_settlement_apply', audience: 'billing-service', companyId: COMPANY, lateSettlementId: late.id, assistanceRequestId: s.requestId,
        beneficiaryUserId: beneficiaryC.id, reasonCode: 'cash_not_returned_attested' };
      await nextTotpStep();
      const su = await call(AUTH_URL, 'POST', ownerToken, '/auth/admin/step-up', { purpose: 'billing.late_settlement.apply', method: 'totp', code: totp(totpSecret) }, null);
      expect(su.status, JSON.stringify(su.json)).toBe(200);
      const receipt = await call(AUTH_URL, 'POST', ownerToken, '/auth/admin/authorization-receipts', { stepUpToken: su.json.stepUpToken, binding });
      expect(receipt.status, JSON.stringify(receipt.json)).toBe(201);
      // a member is never the Owner: refused before any receipt is spent
      expect((await call(BILLING_URL, 'POST', adminC.token, `/billing/admin/late-settlements/${late.id}/application`, { reasonCode: 'cash_not_returned_attested', receiptSecret: receipt.json.secret })).status).toBe(403);

      // L-4: one transaction supersedes the obligation, records the ONE purchase and settles the request; the receipt is consumed by Billing
      const applied = await call(BILLING_URL, 'POST', ownerToken, `/billing/admin/late-settlements/${late.id}/application`, { reasonCode: 'cash_not_returned_attested', receiptSecret: receipt.json.secret });
      expect(applied.status, `${JSON.stringify(applied.json)}\n${tails()}`).toBe(201);
      expect(applied.json).toMatchObject({ id: late.id, status: 'applied', application: { reasonCode: 'cash_not_returned_attested', appliedBy: { userId: OWNER }, supersededObligationId: obligationId } });
      expect((await authAdmin.query(`SELECT status, "consumedBy" FROM authorization_receipt WHERE id = $1`, [receipt.json.receiptId])).rows[0]).toEqual({ status: 'consumed', consumedBy: 'billing-service' });
      expect((await billingAdmin.query(`SELECT status FROM cash_return_obligation WHERE id = $1`, [obligationId])).rows[0].status).toBe('superseded_by_settlement');
      expect((await billingAdmin.query(`SELECT status FROM assistance_request WHERE id = $1`, [s.requestId])).rows[0].status).toBe('settled');
      const bought = (await billingAdmin.query(`SELECT purpose, "beneficiaryUserId", "productId" FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [s.requestId])).rows;
      expect(bought).toEqual([{ purpose: 'assisted_settlement', beneficiaryUserId: beneficiaryC.id, productId }]);
      const entitled = await b6(beneficiaryC.id);
      expect(entitled.valid).toBe(true);
      expect((await bil12(beneficiaryC)).items).toEqual([{ productId, valid: true, expiresAt: entitled.expiresAt }]);
      // the same receipt again, a second application: nothing more (L-5: never two purchases)
      const again = await call(BILLING_URL, 'POST', ownerToken, `/billing/admin/late-settlements/${late.id}/application`, { reasonCode: 'cash_not_returned_attested', receiptSecret: receipt.json.secret });
      expect(again.status, JSON.stringify(again.json)).not.toBe(201);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [s.requestId])).toBe(1);
      expect(await deadLettered()).toBe(0);
    }, 240_000);

    it('G5: a forged payment.late_success.recorded (no broker-verified Payment identity) is refused and dead-lettered; no surplus, no case, nothing recorded', async () => {
      const template = (await paymentAdmin.query(`SELECT payload FROM outbox WHERE name = 'payment.late_success.recorded' ORDER BY "occurredAt" LIMIT 1`)).rows[0].payload as Record<string, unknown>;
      const obligation = (await billingAdmin.query(`SELECT id FROM recovery_obligation LIMIT 1`)).rows[0].id as string;
      const surpluses = await count(billingAdmin, `SELECT count(*)::int AS n FROM recovery_surplus`);
      const lates = await count(billingAdmin, `SELECT count(*)::int AS n FROM payment_late_success`);
      const deadBefore = await deadLettered();
      const id = randomUUID();
      const body = { ...template, lateSuccessId: randomUUID(), factId: randomUUID() }; // a genuine body of the family, a new late success
      const pub = await amqpConn.createConfirmChannel();
      pub.publish('nawara.events', 'payment.late_success.recorded', Buffer.from(JSON.stringify(body)), { messageId: id, type: 'payment.late_success.recorded', persistent: true,
        contentType: 'application/json', headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
      await pub.waitForConfirms();
      await pub.close();
      await waitFor(async () => (await deadLettered()) === deadBefore + 1, 20_000, `the forgery to be refused and dead-lettered\n${tails()}`);
      const dead = await amqpConn.createChannel();
      let reason: unknown;
      for (let m = await dead.get(BILLING_DEAD_QUEUE, { noAck: false }); m; m = await dead.get(BILLING_DEAD_QUEUE, { noAck: false })) {
        if (m.properties.messageId === id) reason = (m.properties.headers ?? {})['x-nawara-failure-reason'];
      }
      await dead.close();
      expect(reason).toBe('untrusted_unverified_original');
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM payment_late_success`)).toBe(lates);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM recovery_surplus`)).toBe(surpluses);
      expect((await billingAdmin.query(`SELECT status FROM recovery_obligation WHERE id = $1`, [obligation])).rows[0].status).toBe('recovered');
    }, 60_000);

    it('G6: with Auth down, a new assistance request, the recovery obligation read and the Organization\'s attempt at Payment fail closed (503) and write nothing (run last: it stops Auth)', async () => {
      const requests = await count(billingAdmin, `SELECT count(*)::int AS n FROM assistance_request`);
      const attempts = await count(paymentAdmin, `SELECT count(*)::int AS n FROM payment_attempt`);
      const obligationId = (await billingAdmin.query(`SELECT id FROM recovery_obligation LIMIT 1`)).rows[0]?.id as string | undefined;
      const anyPayment = (await paymentAdmin.query(`SELECT id FROM payment WHERE status = 'created' LIMIT 1`)).rows[0]?.id as string | undefined;
      await auth.stop();
      const created = await call(BILLING_URL, 'POST', beneficiaryB.token, '/billing/assistance-requests', { organizationId: ORG_B, productId, priceId, consent: true });
      expect(created.status, JSON.stringify(created.json)).toBe(503);
      if (obligationId) expect((await call(BILLING_URL, 'GET', adminA.token, `/billing/recovery-obligations/${obligationId}`)).status).toBe(503);
      const paymentTarget = anyPayment ?? randomUUID();
      expect((await call(PAYMENT_URL, 'POST', adminB.token, `/payment/payments/${paymentTarget}/attempts`, {})).status).toBe(503);
      expect((await call(BILLING_URL, 'GET', beneficiaryA.token, `/billing/me/platforms/${TEST_PLATFORM}/personal-subscriptions`)).status).toBe(503);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM assistance_request`)).toBe(requests);
      expect(await count(paymentAdmin, `SELECT count(*)::int AS n FROM payment_attempt`)).toBe(attempts);
    }, 60_000);
  },
);
