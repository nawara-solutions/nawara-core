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
import { createPaymentIdentity, tapPaymentEvents, type PaymentIdentity } from './support/payment-identity.js';

const refStub = await startReferenceStub();
let paymentIdentity: PaymentIdentity | undefined;
afterAll(() => refStub.close());

/**
 * Core V2 S-INT evidence completeness (readiness record `docs/architecture/core-v2-s-int-readiness.md` §7.3; the Owner's Option A, 2026-11-02):
 * the G3, G4, G5 and G6 criteria that earlier had per-service evidence only, across separately spawned, BUILT processes (the REAL auth-service,
 * billing-service and payment-service) over real HTTP and a REAL RabbitMQ, on Payment's simulation provider.
 *
 * What is real: every money movement and dispute enters through a signed provider notification; every actor's bearer is verified live by
 * Auth; every Owner authorization is a real TOTP step-up and a real receipt; Billing learns of movements through Payment's broker-verified
 * events or Payment's own read.
 *
 * What is set up or shortened, so it is never read as more than it is:
 *   - SEEDED BY SQL: Auth's Company, Platform, Organizations, users and memberships, and Billing's Platform configuration and catalog (test
 *     setup, not behaviour under test). Organization Service is a stand-in reference read here (see `s-int-pre-lifecycle-real-auth` for the real one).
 *   - LABELLED CLOCK SHIFTS: 73 hours on one assistance request (no real 72-hour wait ran), and a payment's `expiresAt` moved into the past
 *     (the real sweeper then ends it; no real expiry window elapsed).
 *   - LABELLED DELIVERY CONTROL: Billing stopped, messages purged (a real loss) or re-sent out of order, the genuine bytes under the real
 *     `payment-service` broker identity.
 *   - `ACCESS_TOKEN_TTL_SEC` is raised to its maximum so bearers outlive this long suite and the Auth restart.
 *
 * DEVELOPMENT AND SIMULATION ONLY. No verdict. Prerequisite: `npm run build -w @nawara/service-kit -w @nawara/audit-contract -w auth-service
 * -w billing-service -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUTH_DIR = `${ROOT}apps/auth-service`;
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const AUTH_PORT = 13751;
const BILLING_PORT = 13752;
const PAYMENT_PORT = 13753;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const COMPANY = 'aaaaaaaa-0000-4000-8000-00000000c0de'; // the reference stub's Company
const ORG_S = randomUUID(); // G3: surplus resolution (its T3 restricts only it)
const ORG_X = randomUUID(); // G4: expiry, L-3, out of order, read recovery
const ORG_R = randomUUID(); // G4: the refusals (a deadline obligation restricts only it)
const ORG_O = randomUUID(); // G6: the outage and its recovery
const ORG_F = randomUUID(); // G4 (8): the refund of an L-4 purchase opens a real obligation, and its T2 restricts only this Organization
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
  'Core V2 S-INT evidence completeness: G3 surplus, G4 late settlement paths, G5 per family, G6 recovery (real Auth, Billing, Payment, RabbitMQ; simulation)',
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
    let tap: Awaited<ReturnType<typeof tapPaymentEvents>>;
    let authEnv: NodeJS.ProcessEnv = {};
    let billingEnv: NodeJS.ProcessEnv = {};
    const actor = (organizationId: string, admin: boolean): Actor => ({ id: randomUUID(), email: `${randomUUID().slice(0, 8)}@s-int.e2e.test`, organizationId, admin, token: '' });
    const adminS = actor(ORG_S, true);
    const benS = actor(ORG_S, false);
    const adminX = actor(ORG_X, true);
    const benExpiry = actor(ORG_X, false);
    const benL3 = actor(ORG_X, false);
    const adminF = actor(ORG_F, true);
    const benL4 = actor(ORG_F, false);
    const benRead = actor(ORG_X, false);
    const benSecond = actor(ORG_X, false);
    const benLost = actor(ORG_X, false);
    const benOrder = actor(ORG_X, false);
    const adminR = actor(ORG_R, true);
    const benContra = actor(ORG_R, false);
    const benCash = actor(ORG_R, false);
    const benPurchase = actor(ORG_R, false);
    const adminO = actor(ORG_O, true);
    const benO = actor(ORG_O, false);
    const benO2 = actor(ORG_O, false);
    const everyone = () => [adminS, benS, adminX, benExpiry, benL3, adminF, benL4, benRead, benSecond, benLost, benOrder, adminR, benContra, benCash, benPurchase, adminO, benO, benO2];

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

    beforeAll(async () => {
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauthsintgap');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingsintgap');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymentsintgap');
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
      for (const org of [ORG_S, ORG_X, ORG_R, ORG_O, ORG_F]) await authAdmin.query(`INSERT INTO organization(id, "platformId", name) VALUES ($1, $2, 'S-INT organization')`, [org, TEST_PLATFORM]);
      const oc = await authAdmin.connect();
      try {
        await oc.query('BEGIN');
        await oc.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'owner', $2, $3, 'admin')`, [OWNER, OWNER_EMAIL, hash]);
        await oc.query(`INSERT INTO owner("userId", "companyId") VALUES ($1, $2)`, [OWNER, COMPANY]);
        await oc.query('COMMIT');
      } finally {
        oc.release();
      }
      for (const a of everyone()) {
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
      tap = await tapPaymentEvents(amqpConn, ['payment.#', 'refund.#']); // the EXACT messages Payment publishes, for delivery control and G5
      paymentIdentity = await createPaymentIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
      await purgeQueue(BILLING_QUEUE);
      await purgeQueue(BILLING_DEAD_QUEUE);

      authEnv = {
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
        ACCESS_TOKEN_TTL_SEC: '3600', // the maximum: bearers outlive this suite and the Auth restart of G6 (set up, not under test)
      };
      auth = spawnService('auth', AUTH_DIR, authEnv);
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
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.create.assisted_settlement', 'payment.create.recovery_settlement', 'payment.refund.create',
            'payment.reconciliation.read'], // Billing's reconciliation worker reads Payment's evidence: the read recovery G4 proves
            allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
        ...refStub.env,
      });
      billingEnv = {
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
      };
      billing = spawnService('billing', BILLING_DIR, billingEnv);
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
      for (const a of everyone()) {
        const login = await call(AUTH_URL, 'POST', null, '/auth/login', { email: a.email, password: PASSWORD }, null);
        expect(login.status, JSON.stringify(login.json)).toBe(200);
        a.token = login.json.accessToken;
      }
    }, 120_000);

    afterAll(async () => {
      await billing?.stop();
      await payment?.stop();
      await auth?.stop();
      await tap?.close();
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
      // with the read grant either verified path may record it first (the event or Payment's read); the tests below pin each path where it matters
      return late as { id: string; factId: string };
    }
    /**
     * S0-C8: an assisted settlement whose payment REALLY ends unsuccessfully: the Organization's attempts all fail at the provider, so Payment's
     * payment reaches `failed` at its attempt limit (S4c, PAYMENT_MAX_ATTEMPTS, default 3); `payment.failed` over the broker ends Billing's
     * request, and its channel is definitively closed.
     */
    async function failedAtPayment(beneficiary: Actor, admin: Actor) {
      const s = await settlementAtPayment(beneficiary, admin);
      const attempts: string[] = [];
      for (let i = 0; i < 3; i++) {
        const a = await attemptOf(s.paymentId, admin);
        await outcome(s.paymentId, a.id, { outcome: 'failed', failureCode: 'declined' });
        attempts.push(a.id);
      }
      expect((await paymentAdmin.query(`SELECT status FROM payment WHERE id = $1`, [s.paymentId])).rows[0].status, tails()).toBe('failed');
      await waitFor(async () => (await billingAdmin.query(`SELECT status FROM payment_request WHERE id = $1`, [s.paymentRequestId])).rows[0].status === 'failed',
        30_000, `Billing to apply Payment's payment.failed over the broker\n${tails()}`);
      expect((await billingAdmin.query(`SELECT status FROM assistance_settlement_channel WHERE "invoiceId" = $1`, [s.invoiceId])).rows[0].status).toBe('closed');
      return { ...s, attempts };
    }
    /** Billing's late assisted settlement of one late success (S0-C8 item 1 b), from the verified event. */
    async function lateSettlementOf(lateSuccessId: string) {
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM assistance_late_settlement WHERE "lateSuccessId" = $1`, [lateSuccessId])).rowCount === 1,
        30_000, `Billing to classify the late success as a late assisted settlement\n${tails()}`);
      return (await billingAdmin.query(`SELECT * FROM assistance_late_settlement WHERE "lateSuccessId" = $1`, [lateSuccessId])).rows[0] as Record<string, any>;
    }
    const attestOf = (lateId: string, a: Actor) => call(BILLING_URL, 'POST', a.token, `/billing/assistance-late-settlements/${lateId}/attestation`, { statement: 'cash_not_returned' });
    /** The Owner's factor step-up for `billing.late_settlement.apply` and Auth's receipt bound to exactly this application (real Auth). */
    async function ownerReceipt(lateId: string, requestId: string, beneficiary: Actor): Promise<{ secret: string; receiptId: string }> {
      const binding = { operation: 'late_settlement_apply', audience: 'billing-service', companyId: COMPANY, lateSettlementId: lateId, assistanceRequestId: requestId,
        beneficiaryUserId: beneficiary.id, reasonCode: 'cash_not_returned_attested' };
      await nextTotpStep();
      const su = await call(AUTH_URL, 'POST', ownerToken, '/auth/admin/step-up', { purpose: 'billing.late_settlement.apply', method: 'totp', code: totp(totpSecret) }, null);
      expect(su.status, JSON.stringify(su.json)).toBe(200);
      const r = await call(AUTH_URL, 'POST', ownerToken, '/auth/admin/authorization-receipts', { stepUpToken: su.json.stepUpToken, binding });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return { secret: r.json.secret as string, receiptId: r.json.receiptId as string };
    }
    const applyL4 = (lateId: string, secret: string, token: string | null = ownerToken) =>
      call(BILLING_URL, 'POST', token, `/billing/admin/late-settlements/${lateId}/application`, { reasonCode: 'cash_not_returned_attested', receiptSecret: secret });
    const settle = () => new Promise((r) => setTimeout(r, 3_000)); // lets any (wrongly) produced effect arrive before an absence is asserted

    /** The simulated provider's dispute of one attempt's capture (PAY-14 H): its signed notification, through Payment's webhook pipeline. */
    async function dispute(paymentId: string, attemptId: string, disputeRef: string, send: Record<string, unknown>) {
      const r = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${paymentId}/disputes`, { commandId: `sint-${randomUUID()}`, disputeRef, attemptId, ...send });
      expect(r.status, `${JSON.stringify(r.json)}\n${tails()}`).toBe(201);
      expect(r.json.delivered).toEqual({ status: 200 });
      return r.json as { commandId: string };
    }
    const paymentDispute = async (ref: string) => (await paymentAdmin.query(`SELECT * FROM payment_dispute WHERE "providerDisputeId" = $1`, [`simd_${ref}`])).rows[0] as Record<string, any> | undefined;
    /** S0-C8: a really failed assisted payment, a verified late capture of `attempt`, Billing's late assisted settlement, attested. */
    async function attestedLateSettlement(beneficiary: Actor, admin: Actor, attempt = 0) {
      const s = await failedAtPayment(beneficiary, admin);
      const late = await lateSuccessOf(s.paymentId, s.attempts[attempt]!, BASE);
      const ls = await lateSettlementOf(late.id);
      const att = await attestOf(ls.id, beneficiary);
      expect(att.status, JSON.stringify(att.json)).toBe(201);
      return { s, late, ls };
    }
    const receiptStatus = async (receiptId: string) => (await authAdmin.query(`SELECT status FROM authorization_receipt WHERE id = $1`, [receiptId])).rows[0].status as string;
    const purchasesOf = (requestId: string) => count(billingAdmin, `SELECT count(*)::int AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [requestId]);

    const refusal = (r: { status: number; json: any }) => [r.status, r.json?.code, r.json?.reason];
    const paymentStatus = async (paymentId: string) => (await paymentAdmin.query(`SELECT status FROM payment WHERE id = $1`, [paymentId])).rows[0].status as string;
    const invoiceStatus = async (invoiceId: string) => (await billingAdmin.query(`SELECT status FROM invoice WHERE id = $1`, [invoiceId])).rows[0].status as string;
    const caseOf = async (paymentId: string, caseType: string) => (await billingAdmin.query(
      `SELECT c.id, x.kind AS resolution FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution x ON x."caseId" = c.id WHERE c."paymentId" = $1 AND c."caseType" = $2`, [paymentId, caseType])).rows;
    const lateSettlementsOf = (requestId: string) => count(billingAdmin, `SELECT count(*)::int AS n FROM assistance_late_settlement WHERE "assistanceRequestId" = $1`, [requestId]);
    const reconciliationPass = () => new Promise((r) => setTimeout(r, 12_000)); // Billing's reconciliation worker runs every 10 seconds
    /** A case of `reason` at Billing, then AUTH-01's receipt bound to exactly that captured movement, relayed to Payment; the provider's signed refund completes it. */
    async function refundOfCapture(paymentId: string, captureFactId: string, reason: string, expected: Record<string, unknown>) {
      const opened = await call(BILLING_URL, 'POST', ownerToken, '/billing/admin/refund-cases', { paymentId, reason });
      expect(opened.status, `${JSON.stringify(opened.json)}\n${tails()}`).toBe(201);
      expect(opened.json).toMatchObject({ amount: BASE, capture: { captureFactId, basis: 'late_capture' }, ...expected });
      const caseId = opened.json.id as string;
      await nextTotpStep();
      const su = await call(AUTH_URL, 'POST', ownerToken, '/auth/admin/step-up', { purpose: 'refund.authorize', method: 'totp', code: totp(totpSecret) }, null);
      expect(su.status, JSON.stringify(su.json)).toBe(200);
      const r = await call(AUTH_URL, 'POST', ownerToken, '/auth/admin/authorization-receipts', { stepUpToken: su.json.stepUpToken, binding: { operation: 'refund', audience: 'payment-service',
        companyId: COMPANY, refundCaseId: caseId, paymentId, amount: BASE, currency: 'TND', reason, legalOverride: false, captureFactId } });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      const relayed = await call(BILLING_URL, 'POST', ownerToken, `/billing/admin/refund-cases/${caseId}/authorizations`, { receiptSecret: r.json.secret });
      expect(relayed.status, `${JSON.stringify(relayed.json)}\n${tails()}`).toBe(201);
      const attemptId = relayed.json.attempts[0].refundAttemptId as string;
      await waitFor(async () => (await paymentAdmin.query(`SELECT status FROM refund_attempt WHERE id = $1`, [attemptId])).rows[0].status === 'submitted', 30_000, `the refund worker to dispatch\n${tails()}`);
      const out = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/refunds/${attemptId}/outcomes`, { commandId: `sint-${randomUUID()}`, outcome: 'succeeded' });
      expect(out.json?.delivered, JSON.stringify(out.json)).toEqual({ status: 200 });
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM refund_case_effect WHERE "refundCaseId" = $1`, [caseId])).rowCount === 1,
        45_000, `Billing to complete the case and apply its effect\n${tails()}`);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM refund_case_completion WHERE "refundCaseId" = $1`, [caseId])).toBe(1);
      expect(await receiptStatus(r.json.receiptId)).toBe('consumed');
      return { caseId, attemptId };
    }
    /** LABELLED CLOCK SHIFT, as G4's: the channel is closed; the request's four times move back 73 hours together; the real sweep then opens the deadline obligation. */
    async function pastDeadline(requestId: string): Promise<string> {
      const cl = await billingAdmin.connect();
      try {
        await cl.query('SET session_replication_role = replica');
        await cl.query(`UPDATE assistance_request SET "consentAt" = "consentAt" - interval '73 hours', "cashCollectedAt" = "cashCollectedAt" - interval '73 hours',
          "reportedAt" = "reportedAt" - interval '73 hours', "settleBy" = "settleBy" - interval '73 hours' WHERE id = $1`, [requestId]);
      } finally {
        await cl.query('SET session_replication_role = origin');
        cl.release();
      }
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM cash_return_obligation WHERE "assistanceRequestId" = $1 AND origin = 'deadline' AND status = 'open'`, [requestId])).rowCount === 1,
        30_000, `the real sweep to open the deadline obligation\n${tails()}`);
      return (await billingAdmin.query(`SELECT id FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [requestId])).rows[0].id as string;
    }
    /** Payment's genuine event for delivery control: the id and the EXACT message the relay published, as the broker routed it. */
    const genuine = async (name: string, where: string, value: string) => {
      const e = (await paymentAdmin.query(`SELECT id FROM outbox WHERE name = $1 AND payload->>'${where}' = $2`, [name, value])).rows[0];
      expect(e, `${name} ${value} in Payment's outbox`).toBeDefined();
      const m = await tap.take(e.id as string);
      return { id: m.messageId, name, headers: m.headers, body: m.content };
    };
    /** Publishes through an AMQP connection: `asPayment` is the real `payment-service` identity (the broker stamps and checks `user_id`), else guest. */
    async function publish(m: { id: string; name: string; headers: object; body: Buffer }, o: { asPayment?: boolean; defaultExchange?: boolean } = {}) {
      const conn = o.asPayment ? await amqp.connect(paymentIdentity!.url(env.TEST_RABBITMQ_URL)) : amqpConn;
      const ch = await conn.createConfirmChannel();
      const props = { messageId: m.id, type: m.name, persistent: true, contentType: 'application/json', headers: m.headers as Record<string, unknown>, ...(o.asPayment ? { userId: 'payment-service' } : {}) };
      if (o.defaultExchange) ch.sendToQueue(BILLING_QUEUE, m.body, props);
      else ch.publish('nawara.events', m.name, m.body, props);
      await ch.waitForConfirms();
      await ch.close();
      if (o.asPayment) await conn.close();
    }
    const stopBilling = () => billing.stop();
    async function startBilling() {
      billing = spawnService('billing', BILLING_DIR, billingEnv);
      await waitForHealth(`${BILLING_URL}/health`, 30_000);
    }
    const drainWorkQueue = async () => {
      const ch = await amqpConn.createChannel();
      const taken: string[] = [];
      for (let m = await ch.get(BILLING_QUEUE, { noAck: false }); m; m = await ch.get(BILLING_QUEUE, { noAck: false })) {
        taken.push(String(m.properties.messageId));
        ch.ack(m);
      }
      await ch.close();
      return taken;
    };
    const deadReason = async (id: string) => {
      const dead = await amqpConn.createChannel();
      let reason: unknown;
      for (let m = await dead.get(BILLING_DEAD_QUEUE, { noAck: false }); m; m = await dead.get(BILLING_DEAD_QUEUE, { noAck: false })) {
        if (m.properties.messageId === id) reason = (m.properties.headers ?? {})['x-nawara-failure-reason'];
      }
      await dead.close(); // unacknowledged: the dead letters stay in their queue
      return reason;
    };

    it('G3: an entirely-surplus payment is refunded through the Owner, Auth and Payment; its completion resolves the surplus once (B8), the recovery and the entitlement untouched', async () => {
      const s = await settlementAtPayment(benS, adminS);
      const a = await attemptOf(s.paymentId, adminS);
      await outcome(s.paymentId, a.id, { outcome: 'succeeded' });
      await waitFor(async () => (await purchasesOf(s.requestId)) === 1, 30_000, `the assisted purchase\n${tails()}`);
      const entitled = await b6(benS.id);
      const lossRef = `sint-s-${randomUUID()}`;
      await dispute(s.paymentId, a.id, lossRef, { event: 'lost' });
      const lost = (await paymentDispute(lossRef))!;
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM recovery_obligation WHERE "disputeId" = $1`, [lost.id])).rowCount === 1, 45_000, `the recovery obligation\n${tails()}`);
      const obligationId = (await billingAdmin.query(`SELECT id FROM recovery_obligation WHERE "disputeId" = $1`, [lost.id])).rows[0].id as string;
      // recovery channel A really ends failed (its attempt limit); channel B recovers the base
      const cA = await call(BILLING_URL, 'POST', adminS.token, `/billing/recovery-obligations/${obligationId}/settlement`);
      expect(cA.status, JSON.stringify(cA.json)).toBe(201);
      const paymentA = await requestedAt(cA.json.paymentRequestId as string);
      const attemptsA: string[] = [];
      for (let i = 0; i < 3; i++) {
        const x = await attemptOf(paymentA, adminS);
        await outcome(paymentA, x.id, { outcome: 'failed', failureCode: 'declined' });
        attemptsA.push(x.id);
      }
      await waitFor(async () => (await billingAdmin.query(`SELECT status FROM payment_request WHERE id = $1`, [cA.json.paymentRequestId])).rows[0].status === 'failed', 30_000, `channel A's failure\n${tails()}`);
      const cB = await call(BILLING_URL, 'POST', adminS.token, `/billing/recovery-obligations/${obligationId}/settlement`);
      expect(cB.status, JSON.stringify(cB.json)).toBe(201);
      const paymentB = await requestedAt(cB.json.paymentRequestId as string);
      const b = await attemptOf(paymentB, adminS);
      await outcome(paymentB, b.id, { outcome: 'succeeded' });
      await waitFor(async () => (await billingAdmin.query(`SELECT status FROM recovery_obligation WHERE id = $1`, [obligationId])).rows[0].status === 'recovered', 30_000, `the recovery\n${tails()}`);
      expect(await restrictions(ORG_S)).toEqual([]);
      // the provider then reports channel A's capture: entirely surplus, owed to the Organization
      const late = await lateSuccessOf(paymentA, attemptsA[0]!, BASE);
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM recovery_surplus WHERE "obligationId" = $1`, [obligationId])).rowCount === 1, 30_000, `the surplus\n${tails()}`);
      const owed = (await call(BILLING_URL, 'GET', adminS.token, `/billing/recovery-obligations/${obligationId}`)).json;
      expect(owed.surpluses).toEqual([expect.objectContaining({ amount: BASE, status: 'owed_to_organization' })]);
      // Path A, the refund machinery: another reason is refused; `recovery_surplus` under a real receipt, refunded by the provider's signed notification
      const wrong = await call(BILLING_URL, 'POST', ownerToken, '/billing/admin/refund-cases', { paymentId: paymentA, reason: 'customer_request' });
      expect(wrong.json?.code, JSON.stringify(wrong.json)).toBe('refund_not_eligible');
      const { caseId } = await refundOfCapture(paymentA, late.factId, 'recovery_surplus', { eligibility: 'recovery_surplus' });
      expect((await billingAdmin.query(`SELECT outcome, reason FROM refund_case_effect WHERE "refundCaseId" = $1`, [caseId])).rows[0]).toEqual({ outcome: 'none', reason: 'recovery_surplus_refunded' });
      const after = (await call(BILLING_URL, 'GET', adminS.token, `/billing/recovery-obligations/${obligationId}`)).json;
      expect(after).toMatchObject({ baseAmount: BASE, recovered: BASE, outstanding: 0, status: 'recovered' });
      expect(after.surpluses).toEqual([expect.objectContaining({ amount: BASE, status: 'resolved', refundCaseId: caseId })]);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM recovery_surplus_refund WHERE "refundCaseId" = $1`, [caseId])).toBe(1);
      expect(await restrictions(ORG_S)).toEqual([]);
      expect(await b6(benS.id)).toEqual(entitled);
      expect(await paymentStatus(paymentA)).toBe('failed');
      expect(await deadLettered()).toBe(0);
    }, 300_000);

    it('G4 (1): a capture after the payment really EXPIRED (a labelled expiresAt shift, then the real sweeper): one late success, one late settlement and its case; nothing sold; everything stays final', async () => {
      const s = await settlementAtPayment(benExpiry, adminX);
      const a = await attemptOf(s.paymentId, adminX);
      await outcome(s.paymentId, a.id, { outcome: 'expired' }); // the provider's own expiry of the attempt: nothing is uncertain any more
      // LABELLED CLOCK SHIFT: the payment's immutable expiresAt moves into the past (no real expiry window elapsed); Payment's REAL sweeper ends it
      const cl = await paymentAdmin.connect();
      try {
        await cl.query('SET session_replication_role = replica');
        await cl.query(`UPDATE payment SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`, [s.paymentId]);
      } finally {
        await cl.query('SET session_replication_role = origin');
        cl.release();
      }
      await waitFor(async () => (await paymentStatus(s.paymentId)) === 'expired', 30_000, `Payment's expiry sweeper\n${tails()}`);
      await waitFor(async () => (await billingAdmin.query(`SELECT status FROM payment_request WHERE id = $1`, [s.paymentRequestId])).rows[0].status === 'expired', 30_000, `Billing to apply payment.expired\n${tails()}`);
      expect((await billingAdmin.query(`SELECT status FROM assistance_settlement_channel WHERE "invoiceId" = $1`, [s.invoiceId])).rows[0].status).toBe('closed');
      const late = await lateSuccessOf(s.paymentId, a.id, BASE);
      const atPayment = (await paymentAdmin.query(`SELECT "paymentStatus", "recordedAt" FROM payment_late_success WHERE id = $1`, [late.id])).rows[0];
      expect(atPayment.paymentStatus).toBe('expired');
      const ls = await lateSettlementOf(late.id);
      expect([ls.reason, ls.invoiceId, new Date(ls.settledAt).toISOString()]).toEqual(['channel_closed', s.invoiceId, new Date(atPayment.recordedAt).toISOString()]);
      expect(await caseOf(s.paymentId, 'late_assisted_settlement')).toEqual([{ id: expect.any(String), resolution: null }]);
      expect(await purchasesOf(s.requestId)).toBe(0);
      expect(await paymentStatus(s.paymentId)).toBe('expired');
      expect(await count(paymentAdmin, `SELECT count(*)::int AS n FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [s.paymentId])).toBe(0);
      expect(await invoiceStatus(s.invoiceId)).toBe('open');
      expect(await deadLettered()).toBe(0);
    }, 180_000);

    it('G4 (4): L-3: the capture-specific refund completes across processes with outcome none and resolves the case; L-4 is refused refund_exists throughout, its receipt never spent; nothing sold', async () => {
      const { s, late, ls } = await attestedLateSettlement(benL3, adminX);
      const receipt = await ownerReceipt(ls.id, s.requestId, benL3);
      const { caseId } = await refundOfCapture(s.paymentId, late.factId, 'late_settlement_unapplied', { eligibility: 'late_assisted_settlement' });
      expect((await billingAdmin.query(`SELECT outcome, reason FROM refund_case_effect WHERE "refundCaseId" = $1`, [caseId])).rows[0]).toEqual({ outcome: 'none', reason: 'late_assisted_settlement' });
      await waitFor(async () => (await caseOf(s.paymentId, 'late_assisted_settlement'))[0]?.resolution === 'refund_completed', 45_000, `the case to resolve\n${tails()}`);
      expect(refusal(await applyL4(ls.id, receipt.secret))).toEqual([409, 'late_settlement_refused', 'refund_exists']);
      expect(await receiptStatus(receipt.receiptId)).toBe('issued');
      expect(await purchasesOf(s.requestId)).toBe(0);
      expect(await invoiceStatus(s.invoiceId)).toBe('open');
      expect(await paymentStatus(s.paymentId)).toBe('failed');
      expect(await count(paymentAdmin, `SELECT count(*)::int AS n FROM outbox WHERE name = 'refund.case_completed' AND payload->>'refundCaseId' = $1`, [caseId])).toBe(1);
      expect(await deadLettered()).toBe(0);
    }, 240_000);

    it('G4 (5): evidence_contradictory, cash_return_reported, cash_return_confirmed and purchase_exists each refuse a REAL late settlement, before any receipt is spent', async () => {
      // the beneficiary states the cash WAS returned
      const c = await failedAtPayment(benContra, adminR);
      const lsC = await lateSettlementOf((await lateSuccessOf(c.paymentId, c.attempts[0]!, BASE)).id);
      const stated = await call(BILLING_URL, 'POST', benContra.token, `/billing/assistance-late-settlements/${lsC.id}/attestation`, { statement: 'cash_returned' });
      expect(stated.status, JSON.stringify(stated.json)).toBe(201);
      const rC = await ownerReceipt(lsC.id, c.requestId, benContra);
      expect(refusal(await applyL4(lsC.id, rC.secret))).toEqual([409, 'late_settlement_refused', 'evidence_contradictory']);
      expect(await receiptStatus(rC.receiptId)).toBe('issued');

      // the deadline passed (labelled), the Organization reports the return, the beneficiary confirms it (L-6)
      const { s: m, ls: lsM } = await attestedLateSettlement(benCash, adminR);
      const obligationId = await pastDeadline(m.requestId);
      const rM = await ownerReceipt(lsM.id, m.requestId, benCash);
      const reported = await call(BILLING_URL, 'POST', adminR.token, `/billing/cash-return-obligations/${obligationId}/return`, { returnedAt: new Date(Date.now() - 60_000).toISOString() });
      expect(reported.status, JSON.stringify(reported.json)).toBe(200);
      expect(refusal(await applyL4(lsM.id, rM.secret))).toEqual([409, 'late_settlement_refused', 'cash_return_reported']);
      const confirmed = await call(BILLING_URL, 'POST', benCash.token, `/billing/cash-return-obligations/${obligationId}/confirm`);
      expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
      expect(refusal(await applyL4(lsM.id, rM.secret))).toEqual([409, 'late_settlement_refused', 'cash_return_confirmed']);
      expect(await receiptStatus(rM.receiptId)).toBe('issued');
      expect(await purchasesOf(m.requestId)).toBe(0);

      // a second channel of the same request sold it; then the provider reports the FIRST channel's capture
      const p = await failedAtPayment(benPurchase, adminR);
      const second = await call(BILLING_URL, 'POST', adminR.token, `/billing/assistance-requests/${p.requestId}/settlement`);
      expect(second.status, `${JSON.stringify(second.json)}\n${tails()}`).toBe(201);
      const paymentTwo = await requestedAt(second.json.paymentRequestId as string);
      const t = await attemptOf(paymentTwo, adminR);
      await outcome(paymentTwo, t.id, { outcome: 'succeeded' });
      await waitFor(async () => (await purchasesOf(p.requestId)) === 1, 30_000, `the second channel's purchase\n${tails()}`);
      const lsP = await lateSettlementOf((await lateSuccessOf(p.paymentId, p.attempts[0]!, BASE)).id);
      const rP = await ownerReceipt(lsP.id, p.requestId, benPurchase);
      expect(refusal(await applyL4(lsP.id, rP.secret))).toEqual([409, 'late_settlement_refused', 'purchase_exists']);
      expect(await receiptStatus(rP.receiptId)).toBe('issued');
      expect(await purchasesOf(p.requestId)).toBe(1);
      expect(await deadLettered()).toBe(0);
    }, 360_000);

    it('G4 (5, 8): after an applied L-4 a further application is already_applied; the refund of that purchase names its capture, reverses it once and opens the refund_completion obligation', async () => {
      const { s, late, ls } = await attestedLateSettlement(benL4, adminF);
      const receipt = await ownerReceipt(ls.id, s.requestId, benL4);
      const applied = await applyL4(ls.id, receipt.secret);
      expect(applied.status, `${JSON.stringify(applied.json)}\n${tails()}`).toBe(201);
      expect(refusal(await applyL4(ls.id, receipt.secret))).toEqual([409, 'late_settlement_refused', 'already_applied']);
      expect((await b6(benL4.id)).valid).toBe(true);
      const purchase = (await billingAdmin.query(`SELECT id FROM subscription_purchase WHERE "lateSuccessId" = $1`, [late.id])).rows[0].id as string;
      const { caseId } = await refundOfCapture(s.paymentId, late.factId, 'customer_request', { eligibility: 'personal_purchase' });
      expect((await billingAdmin.query(`SELECT outcome FROM refund_case_effect WHERE "refundCaseId" = $1`, [caseId])).rows[0].outcome).toBe('reversed_purchase_and_obligation_opened');
      expect((await billingAdmin.query(`SELECT cause FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [purchase])).rows).toEqual([{ cause: 'refund_completion' }]);
      expect((await billingAdmin.query(`SELECT origin, status FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [s.requestId])).rows).toEqual([{ origin: 'refund_completion', status: 'open' }]);
      expect(await b6(benL4.id)).toEqual({ valid: false, expiresAt: null });
      expect(await restrictions(ORG_F)).toEqual(expect.arrayContaining(['T2'])); // the Organization's refund-origin obligation, and only it
      expect(await restrictions(ORG_X)).toEqual([]);
      expect(await paymentStatus(s.paymentId)).toBe('failed');
      expect(await deadLettered()).toBe(0);
    }, 240_000);

    it('G4 (6): the same late success by the verified event AND Payment\'s read is recorded and classified once', async () => {
      const s = await failedAtPayment(benRead, adminX);
      const late = await lateSuccessOf(s.paymentId, s.attempts[0]!, BASE);
      const event = await genuine('payment.late_success.recorded', 'lateSuccessId', late.id);
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM event_provenance WHERE "eventId" = $1 AND consumer = $2 AND verified`, [event.id, BILLING_QUEUE])).rowCount === 1,
        30_000, `the verified event delivery\n${tails()}`);
      await reconciliationPass(); // Payment's read of the same late success (PAY-12) has now run after the event too
      await lateSettlementOf(late.id);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM payment_late_success WHERE "paymentId" = $1`, [s.paymentId])).toBe(1);
      expect(await lateSettlementsOf(s.requestId)).toBe(1);
      expect((await caseOf(s.paymentId, 'late_assisted_settlement'))).toHaveLength(1);
      expect(await deadLettered()).toBe(0);
    }, 180_000);

    it('G4 (6): a REALLY lost late-success event (LABELLED: Billing stopped, its copy taken from the queue) is recovered from Payment\'s read at Payment\'s instant; the event arriving afterwards changes nothing', async () => {
      const s = await failedAtPayment(benLost, adminX);
      await stopBilling();
      try {
        expect(await signed({ eventId: `sint_${randomUUID()}`, type: 'payment.succeeded', reference: s.attempts[0], providerTransactionId: `sim_late_${randomUUID()}`, amount: BASE, currency: 'TND' })).toBeLessThan(500);
        const row = (await paymentAdmin.query(`SELECT id, "recordedAt" FROM payment_late_success WHERE "paymentId" = $1`, [s.paymentId])).rows[0];
        const event = await genuine('payment.late_success.recorded', 'lateSuccessId', row.id); // captured: the relay published it
        await waitFor(async () => (await drainWorkQueue()).includes(event.id), 15_000, 'the event in the work queue, to lose it');
        await startBilling();
        await waitFor(async () => (await billingAdmin.query(`SELECT source FROM payment_late_success WHERE "lateSuccessId" = $1`, [row.id])).rows[0]?.source === 'reconciliation',
          45_000, `Billing's reconciliation worker to recover the late success from Payment's read\n${tails()}`);
        const recorded = (await billingAdmin.query(`SELECT "recordedAt" FROM payment_late_success WHERE "lateSuccessId" = $1`, [row.id])).rows[0];
        expect(new Date(recorded.recordedAt).toISOString()).toBe(new Date(row.recordedAt).toISOString());
        await lateSettlementOf(row.id);
        await publish(event, { asPayment: true }); // the event, late: the genuine bytes, Payment's identity
        await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM event_provenance WHERE "eventId" = $1 AND consumer = $2 AND verified`, [event.id, BILLING_QUEUE])).rowCount === 1,
          30_000, `the late event to be decided\n${tails()}`);
        await settle();
        expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM payment_late_success WHERE "paymentId" = $1`, [s.paymentId])).toBe(1);
        expect(await lateSettlementsOf(s.requestId)).toBe(1);
        expect(await caseOf(s.paymentId, 'late_assisted_settlement')).toHaveLength(1);
        expect(await deadLettered()).toBe(0);
      } finally {
        if (!(await fetch(`${BILLING_URL}/health`).then((r) => r.ok).catch(() => false))) await startBilling();
      }
    }, 240_000);

    it('G4 (6): out of order (LABELLED: Billing stopped, the genuine messages re-sent in reverse under Payment\'s identity): the late success is recorded and deferred, never classified before Billing holds the final outcome; then classified once', async () => {
      const s = await settlementAtPayment(benOrder, adminX);
      const attempts: string[] = [];
      for (let i = 0; i < 2; i++) {
        const a = await attemptOf(s.paymentId, adminX);
        await outcome(s.paymentId, a.id, { outcome: 'failed', failureCode: 'declined' });
        attempts.push(a.id);
      }
      await stopBilling();
      try {
        const last = await attemptOf(s.paymentId, adminX);
        await outcome(s.paymentId, last.id, { outcome: 'failed', failureCode: 'declined' });
        expect(await paymentStatus(s.paymentId)).toBe('failed');
        expect(await signed({ eventId: `sint_${randomUUID()}`, type: 'payment.succeeded', reference: attempts[0], providerTransactionId: `sim_late_${randomUUID()}`, amount: BASE, currency: 'TND' })).toBeLessThan(500);
        const lateId = (await paymentAdmin.query(`SELECT id FROM payment_late_success WHERE "paymentId" = $1`, [s.paymentId])).rows[0].id as string;
        const failed = await genuine('payment.failed', 'paymentId', s.paymentId);
        const lateEvent = await genuine('payment.late_success.recorded', 'lateSuccessId', lateId);
        const taken: string[] = [];
        await waitFor(async () => { taken.push(...await drainWorkQueue()); return taken.includes(failed.id) && taken.includes(lateEvent.id); }, 15_000, 'both events in the work queue');
        await startBilling();
        await publish(lateEvent, { asPayment: true });
        await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM payment_late_success WHERE "lateSuccessId" = $1`, [lateId])).rowCount === 1, 30_000, `the late success to be recorded\n${tails()}`);
        await reconciliationPass();
        // deferred (LS-5): recorded, but neither a late settlement nor a case while Billing's request is not final; finality is never inferred
        expect((await billingAdmin.query(`SELECT status FROM payment_request WHERE id = $1`, [s.paymentRequestId])).rows[0].status).toBe('requested');
        expect(await lateSettlementsOf(s.requestId)).toBe(0);
        expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM reconciliation_case WHERE "paymentId" = $1`, [s.paymentId])).toBe(0);
        await publish(failed, { asPayment: true });
        await waitFor(async () => (await billingAdmin.query(`SELECT status FROM payment_request WHERE id = $1`, [s.paymentRequestId])).rows[0].status === 'failed', 30_000, `the final outcome\n${tails()}`);
        const ls = await lateSettlementOf(lateId);
        expect(ls.reason).toBe('channel_closed');
        expect(await caseOf(s.paymentId, 'late_assisted_settlement')).toHaveLength(1);
        expect(await purchasesOf(s.requestId)).toBe(0);
        expect(await deadLettered()).toBe(0);
      } finally {
        if (!(await fetch(`${BILLING_URL}/health`).then((r) => r.ok).catch(() => false))) await startBilling();
      }
    }, 240_000);

    it('G4 (6): a second capture of the invoice is refund-only: a late_success case and a capture-specific refund path, never a second late settlement or purchase', async () => {
      const { s, ls } = await attestedLateSettlement(benSecond, adminX);
      const before = await lateSettlementsOf(s.requestId);
      expect(before).toBe(1);
      const second = await lateSuccessOf(s.paymentId, s.attempts[1]!, BASE);
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM reconciliation_case WHERE "caseType" = 'late_success' AND "evidenceKey" = $1`, [second.id])).rowCount === 1,
        30_000, `Billing to classify the second capture\n${tails()}`);
      expect((await billingAdmin.query(`SELECT "captureFactId", amount::int AS amount, detail FROM reconciliation_case WHERE "caseType" = 'late_success' AND "evidenceKey" = $1`, [second.id])).rows)
        .toEqual([{ captureFactId: second.factId, amount: BASE, detail: 'assisted_settlement' }]);
      expect(await lateSettlementsOf(s.requestId)).toBe(1);
      expect((await billingAdmin.query(`SELECT "lateSuccessId" FROM assistance_late_settlement WHERE id = $1`, [ls.id])).rows[0].lateSuccessId).not.toBe(second.id);
      expect(await purchasesOf(s.requestId)).toBe(0);
      // its way back is a refund of exactly that capture
      const opened = await call(BILLING_URL, 'POST', ownerToken, '/billing/admin/refund-cases', { paymentId: s.paymentId, captureFactId: second.factId, reason: 'duplicate_charge' });
      expect(opened.status, `${JSON.stringify(opened.json)}\n${tails()}`).toBe(201);
      expect(opened.json).toMatchObject({ eligibility: 'capture_specific', amount: BASE, capture: { captureFactId: second.factId, basis: 'late_capture' } });
      expect(await paymentStatus(s.paymentId)).toBe('failed');
      expect(await deadLettered()).toBe(0);
    }, 180_000);

    it('G5 per family: payment.succeeded, payment.failed, refund.case_completed, payment.dispute.lost, payment.late_success.recorded: default-exchange injection without a stored row, tampered bodies and a verified contradiction are refused before any state change; a verified duplicate applies nothing', async () => {
      const fingerprint = async () => JSON.stringify((await billingAdmin.query(`SELECT
        (SELECT count(*) FROM payment_event_receipt) AS receipts, (SELECT count(*) FROM payment_late_success) AS lates, (SELECT count(*) FROM payment_dispute_loss) AS losses,
        (SELECT count(*) FROM dispute_loss_effect) AS effects, (SELECT count(*) FROM refund_case_completion) AS completions, (SELECT count(*) FROM refund_case_effect) AS "refundEffects",
        (SELECT count(*) FROM subscription_purchase) AS purchases, (SELECT count(*) FROM subscription_purchase_reversal) AS reversals, (SELECT count(*) FROM recovery_obligation) AS obligations,
        (SELECT count(*) FROM invoice WHERE status = 'paid') AS paid, (SELECT count(*) FROM payment_request WHERE status = 'failed') AS failed`)).rows[0]);
      const families = ['payment.succeeded', 'payment.failed', 'refund.case_completed', 'payment.dispute.lost', 'payment.late_success.recorded'];
      for (const name of families) {
        const row = (await paymentAdmin.query(`SELECT id FROM outbox WHERE name = $1 AND "publishedAt" IS NOT NULL ORDER BY "occurredAt"`, [name])).rows;
        const stored = (await billingAdmin.query(`SELECT "eventId" FROM event_provenance WHERE consumer = $1 AND verified AND "eventId" = ANY($2::text[])`, [BILLING_QUEUE, row.map((r) => r.id)])).rows.map((r) => r.eventId);
        const candidate = row.find((r) => stored.includes(r.id));
        expect(candidate, `a verified original of ${name}, stored by Billing`).toBeDefined();
        const original = await tap.take(candidate.id as string); // the exact message Payment published
        const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(original.content.toString('utf8')), amount: 1 }));
        const before = await fingerprint();
        const refused = async (id: string, m: { body: Buffer; asPayment?: boolean; defaultExchange?: boolean }, reason: string) => {
          const dead = await deadLettered();
          await publish({ id, name, headers: { ...original.headers, eventId: id }, body: m.body }, { asPayment: m.asPayment, defaultExchange: m.defaultExchange });
          await waitFor(async () => (await deadLettered()) === dead + 1, 20_000, `${name} ${reason} to be refused\n${tails()}`);
          expect(await deadReason(id), `${name}: ${reason}`).toBe(reason);
          expect(await fingerprint(), `${name}: ${reason} changed state`).toBe(before);
        };
        // a forged user_id: the BROKER refuses it (406) on the guest connection, before any consumer sees it
        const forger = await amqpConn.createConfirmChannel();
        const brokerError = new Promise<Error>((r) => forger.once('error', r));
        forger.publish('nawara.events', name, original.content, { messageId: randomUUID(), type: name, persistent: true, contentType: 'application/json', headers: original.headers, userId: 'payment-service' });
        expect(String((await brokerError).message), `${name}: forged user_id`).toMatch(/406|PRECONDITION_FAILED/);
        expect(await fingerprint(), `${name}: a forged user_id changed state`).toBe(before);
        // the default exchange, no stored row: a replay without provenance
        await refused(randomUUID(), { body: original.content, defaultExchange: true }, 'untrusted_replay_no_provenance');
        // the genuine id with a tampered body, through the default exchange: a replay that mismatches its stored original
        await refused(original.messageId, { body: tampered, defaultExchange: true }, 'untrusted_replay_mismatch');
        // the genuine id with a tampered body under Payment's REAL identity: a verified contradiction
        await refused(original.messageId, { body: tampered, asPayment: true }, 'untrusted_verified_conflict');
        // the identical bytes under Payment's identity: a verified duplicate, no second effect, no dead letter
        const dead = await deadLettered();
        await publish({ id: original.messageId, name, headers: original.headers, body: original.content }, { asPayment: true });
        await settle();
        expect(await deadLettered(), `${name}: a verified duplicate is never dead-lettered`).toBe(dead);
        expect(await fingerprint(), `${name}: a verified duplicate changed state`).toBe(before);
      }
    }, 300_000);

    it('G6: with Auth down every human-authority path fails closed and writes nothing; once Auth returns (a real restart) the SAME actors and the SAME unspent Owner receipt complete the operations', async () => {
      const { s, ls } = await attestedLateSettlement(benO, adminO);
      const receipt = await ownerReceipt(ls.id, s.requestId, benO);
      const fresh = { organizationId: ORG_O, productId, priceId, consent: true };
      const requestsBefore = await count(billingAdmin, `SELECT count(*)::int AS n FROM assistance_request`);
      const casesBefore = await count(billingAdmin, `SELECT count(*)::int AS n FROM refund_case`);
      await auth.stop();
      expect((await call(BILLING_URL, 'POST', benO2.token, '/billing/assistance-requests', fresh)).status).toBe(503);
      expect((await call(BILLING_URL, 'GET', benO.token, `/billing/me/platforms/${TEST_PLATFORM}/personal-subscriptions`)).status).toBe(503);
      expect((await applyL4(ls.id, receipt.secret)).status).toBe(503);
      expect((await call(BILLING_URL, 'POST', ownerToken, '/billing/admin/refund-cases', { paymentId: s.paymentId, reason: 'late_settlement_unapplied' })).status).toBe(503);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM assistance_request`)).toBe(requestsBefore);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM refund_case`)).toBe(casesBefore);
      expect(await purchasesOf(s.requestId)).toBe(0);

      auth = spawnService('auth', AUTH_DIR, authEnv); // the same database and secrets: Auth is back, nothing else restarted
      await waitForHealth(`${AUTH_URL}/health`, 30_000);
      expect(await receiptStatus(receipt.receiptId)).toBe('issued');
      const applied = await applyL4(ls.id, receipt.secret);
      expect(applied.status, `${JSON.stringify(applied.json)}\n${tails()}`).toBe(201);
      expect(await receiptStatus(receipt.receiptId)).toBe('consumed');
      expect(await purchasesOf(s.requestId)).toBe(1);
      const entitled = await b6(benO.id);
      expect(entitled.valid).toBe(true);
      const own = await call(BILLING_URL, 'GET', benO.token, `/billing/me/platforms/${TEST_PLATFORM}/personal-subscriptions`);
      expect(own.json?.items).toEqual([{ productId, valid: true, expiresAt: entitled.expiresAt }]);
      const created = await call(BILLING_URL, 'POST', benO2.token, '/billing/assistance-requests', fresh);
      expect(created.status, `${JSON.stringify(created.json)}\n${tails()}`).toBe(201);
      const refundCase = await call(BILLING_URL, 'POST', ownerToken, '/billing/admin/refund-cases', { paymentId: s.paymentId, reason: 'customer_request' });
      expect(refundCase.status, `${JSON.stringify(refundCase.json)}\n${tails()}`).toBe(201);
    }, 180_000);
  },
);
