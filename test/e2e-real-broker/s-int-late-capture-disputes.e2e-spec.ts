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
 * Core V2 S-INT, F-SINT-2: the S0-C9 late-capture dispute chain (S0 §1.5 S0-C9 items 1 to 7; register PAY-09 G, EVT-03 M, PAY-14 H, BIL-32 H,
 * BIL-33 H; ADR-0044 B10; S0 FC-1, FC-4, FC-5; the Owner's CB-1 to CB-6), across THREE separately spawned, BUILT processes — the REAL
 * auth-service, billing-service and payment-service — over real HTTP and a REAL RabbitMQ, on Payment's simulation provider. Every money
 * movement and every dispute enters only through Payment's signed provider notifications (the authorized harness or a signed body); Billing
 * learns of them only from Payment's broker-verified events or Payment's own reads. SEEDED BY SQL as test setup, not behaviour under test: Auth's
 * Company, Platform, Organizations, users and memberships, and Billing's Platform configuration and catalog. The Organization reference read is a
 * stand-in. The retry bound is reached by a labelled counter shift, and the real retrier is observed for seconds, not its ~85-minute real backoff.
 *
 *   A + E  dispute BEFORE L-4: a verified late capture is disputed before the Owner applies L-4 → Payment binds it to that capture and
 *          exposes it → Billing refuses L-4 (`payment_dispute_open`) without spending the Owner's receipt or selling anything → the provider
 *          decides `won` → the exposure clears, no loss exists anywhere, and the same unspent receipt then applies L-4 once.
 *   B      chargeback AFTER L-4: a loss of ANOTHER late capture of the same payment never touches the L-4 purchase; then the final loss of
 *          the L-4 capture → the purchase and the entitlement stay (B10, FC-4), one base-only recovery obligation, T3; duplicate and
 *          replayed provider notifications change nothing.
 *   C      an UNSOLD late capture charged back in full → its case resolves `chargeback_returned` (CB-4): no refund, no purchase; L-4 and a
 *          refund of that capture are then refused. A PARTIAL chargeback leaves the case open with a review case.
 *   D      out of order (CB-5): a loss before the late capture is reported is held (exposure unresolved, nothing at Billing), then the REAL
 *          retrier attributes it once the late success is recorded. A dispute whose capture never becomes verifiable keeps Billing's L-4
 *          fail-closed (503, receipt unspent) and, at the retry bound, becomes the deterministic `capture_unverified` conflict.
 *   F      security and isolation: forged dispute events over the broker are dead-lettered; amount and currency mismatches are conflicts;
 *          Payment's final state never changes.
 *
 * DEVELOPMENT AND SIMULATION ONLY. No verdict: evidence for the S-INT record. Prerequisite: `npm run build -w @nawara/service-kit
 * -w @nawara/audit-contract -w auth-service -w billing-service -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUTH_DIR = `${ROOT}apps/auth-service`;
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const AUTH_PORT = 13741;
const BILLING_PORT = 13742;
const PAYMENT_PORT = 13743;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const COMPANY = 'aaaaaaaa-0000-4000-8000-00000000c0de'; // the reference stub's Company
const ORG_A = randomUUID(); // A + E: dispute before L-4, then won
const ORG_B = randomUUID(); // B: chargeback after L-4 (its T3 never restricts another Organization)
const ORG_C = randomUUID(); // C: unsold late captures, full and partial chargebacks
const ORG_D = randomUUID(); // D: out-of-order disputes, eventual attribution and the never-verifiable capture
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
  'Core V2 S-INT F-SINT-2 (S0-C9): late-capture disputes from signed provider notifications to Billing (real Auth, Billing, Payment, RabbitMQ; simulation)',
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
    const beneficiaryC2 = actor(ORG_C, false); // the partial chargeback's request (one open request per beneficiary and product)
    const adminD = actor(ORG_D, true);
    const beneficiaryD = actor(ORG_D, false);
    const beneficiaryD2 = actor(ORG_D, false);
    const everyone = () => [adminA, beneficiaryA, adminB, beneficiaryB, adminC, beneficiaryC, beneficiaryC2, adminD, beneficiaryD, beneficiaryD2];

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
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauthsintcb');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingsintcb');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymentsintcb');
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
      for (const org of [ORG_A, ORG_B, ORG_C, ORG_D]) await authAdmin.query(`INSERT INTO organization(id, "platformId", name) VALUES ($1, $2, 'S-INT organization')`, [org, TEST_PLATFORM]);
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
    /** The provider delivers the same signed notification again. */
    const redeliver = async (commandId: string) =>
      expect((await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/dispute-commands/${commandId}/deliver`, {})).status).toBe(200);
    const paymentDispute = async (ref: string) => (await paymentAdmin.query(`SELECT * FROM payment_dispute WHERE "providerDisputeId" = $1`, [`simd_${ref}`])).rows[0] as Record<string, any> | undefined;
    const observations = async (ref: string) =>
      (await paymentAdmin.query(`SELECT kind, disposition, reason FROM payment_dispute_observation WHERE "providerDisputeId" = $1 ORDER BY "observedAt", id`, [`simd_${ref}`])).rows;
    const notifications = async (ref: string) =>
      (await paymentAdmin.query(`SELECT id, state, outcome, attempts FROM webhook_event WHERE "eventType" LIKE 'payment.dispute.%'
         AND convert_from("rawBody", 'UTF8')::jsonb->'data'->>'disputeId' = $1 ORDER BY "receivedAt", id`, [`simd_${ref}`])).rows;
    /** Payment's authoritative exposure read (R6E-4), as Billing calls it: its own service token, real HTTP. */
    async function exposure(paymentId: string) {
      const r = await call(PAYMENT_URL, 'GET', billingToPaymentToken.token, `/payment/payments/${paymentId}/dispute-exposure`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json as Record<string, any>;
    }
    const disputeEvents = async (disputeId: string) =>
      (await paymentAdmin.query(`SELECT name, payload FROM outbox WHERE name LIKE 'payment.dispute.%' AND payload->>'disputeId' = $1 ORDER BY name`, [disputeId])).rows;
    /** Billing's verified loss of one Payment dispute (EVT-03 over the broker) and its effect (B10 / S0-C9 item 2). */
    async function lossAtBilling(disputeId: string) {
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM dispute_loss_effect WHERE "disputeId" = $1`, [disputeId])).rowCount === 1,
        45_000, `Billing to record and apply the verified loss of dispute ${disputeId}\n${tails()}`);
      const loss = (await billingAdmin.query(`SELECT source, "captureBasis", "captureFactId", "chargebackAmount"::int AS "chargebackAmount" FROM payment_dispute_loss WHERE "disputeId" = $1`,
        [disputeId])).rows[0];
      const effect = (await billingAdmin.query(`SELECT outcome, reason, "purchaseId" FROM dispute_loss_effect WHERE "disputeId" = $1`, [disputeId])).rows[0];
      return { loss, effect };
    }
    /**
     * The loss is bound to exactly this capture, whichever verified path recorded it first: Payment's event, or Payment's authenticated losses read
     * that Billing's loss worker also polls (EVT-03, R6E-6; a race both ways). Either way the event itself crossed the broker and Billing verified it.
     */
    async function expectVerifiedLoss(disputeId: string, loss: Record<string, unknown>, captureFactId: string) {
      const { source, ...binding } = loss;
      expect(['event', 'reconciliation']).toContain(source);
      expect(binding).toEqual({ captureBasis: 'late_capture', captureFactId, chargebackAmount: BASE });
      const eventId = (await paymentAdmin.query(`SELECT id FROM outbox WHERE name = 'payment.dispute.lost' AND payload->>'disputeId' = $1`, [disputeId])).rows[0].id as string;
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM event_provenance WHERE "eventId" = $1 AND consumer = $2 AND verified`, [eventId, BILLING_QUEUE])).rowCount === 1,
        30_000, `Billing to verify Payment's payment.dispute.lost over the broker\n${tails()}`);
    }
    /** Payment's final state of one payment: never reopened by a dispute (S0-C9 item 1, F-4). */
    const finality = async (paymentId: string) => (await paymentAdmin.query(
      `SELECT p.status, p."succeededAttemptId", (SELECT json_agg(a.status ORDER BY a."attemptNumber") FROM payment_attempt a WHERE a."paymentId" = p.id) AS attempts,
              (SELECT count(*)::int FROM outbox o WHERE o.name = 'payment.succeeded' AND o.payload->>'paymentId' = p.id::text) AS succeeded
         FROM payment p WHERE p.id = $1`, [paymentId])).rows[0];
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

    it('A + E: a dispute of the verified late capture BEFORE L-4 refuses the application (payment_dispute_open) and spends nothing; once the provider decides `won` the exposure clears, no loss exists and the same receipt applies L-4 once', async () => {
      const { s, late, ls } = await attestedLateSettlement(beneficiaryA, adminA);
      const before = await finality(s.paymentId);
      expect(before).toMatchObject({ status: 'failed', succeededAttemptId: null, succeeded: 0 });
      // the provider opens a dispute of exactly that capture (CB-1): Payment binds it to the late capture and exposes it
      const ref = `sint-a-${randomUUID()}`;
      await dispute(s.paymentId, s.attempts[0]!, ref, { event: 'opened', reason: 'fraudulent' });
      const d = await paymentDispute(ref);
      expect(d, `Payment recorded no dispute: ${JSON.stringify(await observations(ref))}\n${tails()}`).toBeDefined();
      expect(d).toMatchObject({ attemptId: s.attempts[0], captureFactId: late.factId, captureBasis: 'late_capture', status: 'open', amount: String(BASE), chargebackFactId: null });
      expect(await exposure(s.paymentId)).toMatchObject({ state: 'exposed', openDisputes: 1, disputeExposure: BASE, chargedBack: 0, conflicts: 0 });
      expect((await disputeEvents(d!.id)).map((e) => [e.name, e.payload.captureFactId, e.payload.captureBasis])).toEqual([['payment.dispute.opened', late.factId, 'late_capture']]);
      // CB-3: the Owner's application reads that exposure before consuming the receipt: refused, nothing spent, nothing sold
      const receipt = await ownerReceipt(ls.id, s.requestId, beneficiaryA);
      const refused = await applyL4(ls.id, receipt.secret);
      expect([refused.status, refused.json?.code, refused.json?.reason], `${JSON.stringify(refused.json)}\n${tails()}`).toEqual([409, 'late_settlement_refused', 'payment_dispute_open']);
      expect(await receiptStatus(receipt.receiptId)).toBe('issued');
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM late_settlement_application WHERE "lateSettlementId" = $1`, [ls.id])).toBe(0);
      expect(await purchasesOf(s.requestId)).toBe(0);
      expect((await billingAdmin.query(`SELECT status FROM invoice WHERE id = $1`, [s.invoiceId])).rows[0].status).toBe('open');
      expect(await b6(beneficiaryA.id)).toEqual({ valid: false, expiresAt: null });

      // E: the provider decides the dispute for the merchant: the exposure clears; no chargeback fact, no lost event, no loss at Billing
      await dispute(s.paymentId, s.attempts[0]!, ref, { event: 'won' });
      expect(await paymentDispute(ref)).toMatchObject({ status: 'won', chargebackFactId: null });
      expect(await exposure(s.paymentId)).toMatchObject({ state: 'clear', openDisputes: 0, disputeExposure: 0, chargedBack: 0, conflicts: 0, lostWithoutChargeback: 0 });
      await settle();
      expect((await disputeEvents(d!.id)).map((e) => e.name)).toEqual(['payment.dispute.opened']);
      expect(await count(paymentAdmin, `SELECT count(*)::int AS n FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'chargeback'`, [s.paymentId])).toBe(0);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM payment_dispute_loss WHERE "paymentId" = $1`, [s.paymentId])).toBe(0);
      // the same, still unspent receipt now applies L-4 exactly once (S0-C8): one purchase evidenced by the late success, entitled
      const applied = await applyL4(ls.id, receipt.secret);
      expect(applied.status, `${JSON.stringify(applied.json)}\n${tails()}`).toBe(201);
      expect(await receiptStatus(receipt.receiptId)).toBe('consumed');
      expect((await billingAdmin.query(`SELECT "lateSuccessId" FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [s.requestId])).rows).toEqual([{ lateSuccessId: late.id }]);
      expect((await billingAdmin.query(`SELECT status FROM invoice WHERE id = $1`, [s.invoiceId])).rows[0].status).toBe('paid');
      expect((await b6(beneficiaryA.id)).valid).toBe(true);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM recovery_obligation WHERE "organizationId" = $1`, [ORG_A])).toBe(0);
      expect(await restrictions(ORG_A)).toEqual([]);
      expect(await finality(s.paymentId)).toEqual(before); // Payment's final state never moved
      expect(await deadLettered()).toBe(0);
    }, 300_000);

    it('B: after L-4, a loss of ANOTHER late capture of the payment never touches the purchase; the final loss of the L-4 capture keeps the purchase and the entitlement (B10), opens ONE base-only recovery obligation and T3; duplicates and replays change nothing', async () => {
      const { s, late, ls } = await attestedLateSettlement(beneficiaryB, adminB);
      const receipt = await ownerReceipt(ls.id, s.requestId, beneficiaryB);
      const applied = await applyL4(ls.id, receipt.secret);
      expect(applied.status, `${JSON.stringify(applied.json)}\n${tails()}`).toBe(201);
      const purchase = (await billingAdmin.query(`SELECT id FROM subscription_purchase WHERE "lateSuccessId" = $1`, [late.id])).rows[0].id as string;
      const entitled = await b6(beneficiaryB.id);
      expect(entitled.valid).toBe(true);
      const before = await finality(s.paymentId);

      // isolation: the provider also captured attempt 2 late, and charges THAT capture back in full: never the L-4 purchase's loss
      const other = await lateSuccessOf(s.paymentId, s.attempts[1]!, BASE);
      expect(other.factId).not.toBe(late.factId);
      const refO = `sint-bo-${randomUUID()}`;
      await dispute(s.paymentId, s.attempts[1]!, refO, { event: 'lost' });
      const dO = (await paymentDispute(refO))!;
      expect(dO).toMatchObject({ captureFactId: other.factId, captureBasis: 'late_capture', status: 'lost' });
      const o = await lossAtBilling(dO.id);
      await expectVerifiedLoss(dO.id, o.loss, other.factId);
      expect(o.effect).toEqual({ outcome: 'none', reason: 'late_capture_unsold', purchaseId: null });
      await settle();
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM recovery_obligation WHERE "disputeId" = $1`, [dO.id])).toBe(0);
      expect(await restrictions(ORG_B)).toEqual([]);
      expect(await b6(beneficiaryB.id)).toEqual(entitled);

      // the L-4 capture's dispute and final loss, with the provider's full chargeback
      const ref = `sint-b-${randomUUID()}`;
      await dispute(s.paymentId, s.attempts[0]!, ref, { event: 'opened' });
      const lost = await dispute(s.paymentId, s.attempts[0]!, ref, { event: 'lost' });
      const d = (await paymentDispute(ref))!;
      expect(d).toMatchObject({ captureFactId: late.factId, captureBasis: 'late_capture', status: 'lost' });
      expect(d.chargebackFactId).not.toBeNull();
      const l = await lossAtBilling(d.id);
      await expectVerifiedLoss(d.id, l.loss, late.factId);
      // B10 / FC-4: the assisted purchase is preserved and the beneficiary keeps the entitlement (B6 and BIL-12 agree)
      expect(l.effect).toEqual({ outcome: 'none', reason: 'assisted_purchase_preserved', purchaseId: purchase });
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [purchase])).toBe(0);
      expect(await b6(beneficiaryB.id)).toEqual(entitled);
      expect((await bil12(beneficiaryB)).items).toEqual([{ productId, valid: true, expiresAt: entitled.expiresAt }]);
      // S6f: one base-only recovery obligation for the Organization, and T3 (only for it)
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM recovery_obligation WHERE "disputeId" = $1`, [d.id])).rowCount === 1,
        45_000, `Billing's recovery worker to open the obligation\n${tails()}`);
      const obligation = (await billingAdmin.query(`SELECT id, "purchaseId", "organizationId", "baseAmount"::int AS "baseAmount", status FROM recovery_obligation WHERE "disputeId" = $1`, [d.id])).rows[0];
      expect(obligation).toMatchObject({ purchaseId: purchase, organizationId: ORG_B, baseAmount: BASE, status: 'open' });
      const read = await call(BILLING_URL, 'GET', adminB.token, `/billing/recovery-obligations/${obligation.id}`);
      expect(read.json, JSON.stringify(read.json)).toMatchObject({ baseAmount: BASE, recovered: 0, outstanding: BASE, status: 'open' });
      expect(await restrictions(ORG_B)).toEqual(['T3']);
      expect(await restrictions(ORG_A)).toEqual([]);

      // duplicates: the provider redelivers the identical notification, and restates the loss in a new one
      await redeliver(lost.commandId);
      await dispute(s.paymentId, s.attempts[0]!, ref, { event: 'lost' });
      await settle();
      expect(await observations(ref)).toEqual([
        { kind: 'opened', disposition: 'applied', reason: null }, { kind: 'lost', disposition: 'applied', reason: null }, { kind: 'lost', disposition: 'duplicate', reason: null },
      ]);
      expect((await disputeEvents(d.id)).map((e) => e.name)).toEqual(['payment.dispute.lost', 'payment.dispute.opened']);
      expect(await count(paymentAdmin, `SELECT count(*)::int AS n FROM provider_transaction_fact WHERE "disputeId" = $1`, [d.id])).toBe(1);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM payment_dispute_loss WHERE "paymentId" = $1`, [s.paymentId])).toBe(2); // one per dispute
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM recovery_obligation WHERE "organizationId" = $1`, [ORG_B])).toBe(1);
      expect(await purchasesOf(s.requestId)).toBe(1);
      expect(await finality(s.paymentId)).toEqual(before);
      expect(await deadLettered()).toBe(0);
    }, 300_000);

    it('C: an UNSOLD late capture charged back in full resolves its case as chargeback_returned (no refund, no purchase); L-4 and a refund of it are then refused; a PARTIAL chargeback leaves the case open for review', async () => {
      const { s, late, ls } = await attestedLateSettlement(beneficiaryC, adminC);
      const caseId = (await billingAdmin.query(`SELECT id FROM reconciliation_case WHERE "paymentId" = $1 AND "caseType" = 'late_assisted_settlement'`, [s.paymentId])).rows[0].id as string;
      const before = await finality(s.paymentId);
      const ref = `sint-c-${randomUUID()}`;
      await dispute(s.paymentId, s.attempts[0]!, ref, { event: 'opened' });
      await dispute(s.paymentId, s.attempts[0]!, ref, { event: 'lost' });
      const d = (await paymentDispute(ref))!;
      expect(d).toMatchObject({ captureFactId: late.factId, captureBasis: 'late_capture', status: 'lost' });
      const l = await lossAtBilling(d.id);
      expect(l.loss).toMatchObject({ captureBasis: 'late_capture', captureFactId: late.factId, chargebackAmount: BASE });
      expect(l.effect).toEqual({ outcome: 'none', reason: 'late_capture_unsold', purchaseId: null });
      // CB-4: Billing's reconciliation worker resolves the case by the loss itself
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM reconciliation_case_resolution WHERE "caseId" = $1`, [caseId])).rowCount === 1,
        45_000, `Billing's reconciliation worker to resolve the unsold capture's case\n${tails()}`);
      expect((await billingAdmin.query(`SELECT kind, "disputeId", "refundCaseId", "resolvedByUserId" FROM reconciliation_case_resolution WHERE "caseId" = $1`, [caseId])).rows[0])
        .toEqual({ kind: 'chargeback_returned', disputeId: d.id, refundCaseId: null, resolvedByUserId: null });
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM refund_case WHERE "paymentId" = $1`, [s.paymentId])).toBe(0);
      expect(await count(paymentAdmin, `SELECT count(*)::int AS n FROM refund_attempt WHERE "paymentId" = $1`, [s.paymentId])).toBe(0);
      expect(await purchasesOf(s.requestId)).toBe(0);
      expect((await billingAdmin.query(`SELECT status FROM invoice WHERE id = $1`, [s.invoiceId])).rows[0].status).toBe('open');
      // one captured movement, one return: L-4 (chargeback_recorded) and a refund of that capture are refused, nothing spent
      const receipt = await ownerReceipt(ls.id, s.requestId, beneficiaryC);
      const refused = await applyL4(ls.id, receipt.secret);
      expect([refused.status, refused.json?.reason], `${JSON.stringify(refused.json)}\n${tails()}`).toEqual([409, 'chargeback_recorded']);
      expect(await receiptStatus(receipt.receiptId)).toBe('issued');
      const refund = await call(BILLING_URL, 'POST', ownerToken, '/billing/admin/refund-cases', { paymentId: s.paymentId, reason: 'late_settlement_unapplied' });
      expect(refund.status, JSON.stringify(refund.json)).toBe(409);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM refund_case WHERE "paymentId" = $1`, [s.paymentId])).toBe(0);
      expect(await purchasesOf(s.requestId)).toBe(0);
      expect(await finality(s.paymentId)).toEqual(before);

      // a PARTIAL chargeback of another unsold late capture: the case stays open, a review case is opened, nothing is refunded or sold
      const p = await attestedLateSettlement(beneficiaryC2, adminC);
      const partialCase = (await billingAdmin.query(`SELECT id FROM reconciliation_case WHERE "paymentId" = $1 AND "caseType" = 'late_assisted_settlement'`, [p.s.paymentId])).rows[0].id as string;
      const refP = `sint-cp-${randomUUID()}`;
      await dispute(p.s.paymentId, p.s.attempts[0]!, refP, { event: 'lost', chargebackAmount: BASE / 2 });
      const dP = (await paymentDispute(refP))!;
      const lp = await lossAtBilling(dP.id);
      expect(lp.loss).toMatchObject({ captureBasis: 'late_capture', captureFactId: p.late.factId, chargebackAmount: BASE / 2 });
      // S0-C9 item 5: Billing's own evidence (the loss below the late capture) opens the review case, keyed by the dispute
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM reconciliation_case WHERE "evidenceKey" = $1 AND "caseType" = 'partial_chargeback'`, [dP.id])).rowCount === 1,
        45_000, `Billing's reconciliation worker to open the partial chargeback review case\n${tails()}`);
      await new Promise((r) => setTimeout(r, 12_000)); // at least one more reconciliation pass after the loss
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM reconciliation_case_resolution WHERE "caseId" = $1`, [partialCase])).toBe(0);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM refund_case WHERE "paymentId" = $1`, [p.s.paymentId])).toBe(0);
      expect(await purchasesOf(p.s.requestId)).toBe(0);
      expect(await deadLettered()).toBe(0);
    }, 360_000);

    it('D: a loss delivered BEFORE the late capture is held (exposure unresolved, nothing at Billing) and the REAL retrier attributes it exactly once after the late success', async () => {
      const s = await failedAtPayment(beneficiaryD, adminD);
      const ref = `sint-d-${randomUUID()}`;
      await dispute(s.paymentId, s.attempts[0]!, ref, { event: 'lost' });
      expect((await notifications(ref))[0]).toMatchObject({ state: 'unmatched', outcome: 'dispute_held:capture_pending' });
      expect(await paymentDispute(ref)).toBeUndefined();
      expect(await observations(ref)).toEqual([]); // held is not a conflict
      expect(await exposure(s.paymentId)).toMatchObject({ state: 'unresolved', openDisputes: 0, conflicts: 0, lostWithoutChargeback: 0 });
      await settle();
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM payment_dispute_loss WHERE "paymentId" = $1`, [s.paymentId])).toBe(0);
      // the provider now reports the late capture; nobody redelivers the dispute: Payment's own retrier, within its bound, attributes it
      const late = await lateSuccessOf(s.paymentId, s.attempts[0]!, BASE);
      await waitFor(async () => (await paymentDispute(ref)) !== undefined, 150_000, `Payment's webhook retrier to attribute the held loss\n${tails()}`);
      const d = (await paymentDispute(ref))!;
      expect(d).toMatchObject({ captureFactId: late.factId, captureBasis: 'late_capture', status: 'lost' });
      expect(d.chargebackFactId).not.toBeNull();
      // the dispute commits in ingestion's own transaction; the retrier marks its notification `processed` right after, in its claim: wait for it
      await waitFor(async () => (await notifications(ref))[0]?.state !== 'unmatched', 30_000, `Payment's retrier to record the notification's outcome\n${tails()}`);
      const [n] = await notifications(ref);
      expect(n.state).toBe('processed');
      expect(n.attempts).toBeGreaterThanOrEqual(2); // received and held, then retried
      expect(await observations(ref)).toEqual([{ kind: 'lost', disposition: 'applied', reason: null }]);
      expect((await disputeEvents(d.id)).map((e) => e.name)).toEqual(['payment.dispute.lost', 'payment.dispute.opened']);
      const l = await lossAtBilling(d.id);
      expect(l.loss).toMatchObject({ captureBasis: 'late_capture', captureFactId: late.factId, chargebackAmount: BASE });
      expect(l.effect).toEqual({ outcome: 'none', reason: 'late_capture_unsold', purchaseId: null });
      expect(await exposure(s.paymentId)).toMatchObject({ state: 'exposed', chargedBack: BASE });
      expect((await finality(s.paymentId)).status).toBe('failed');
      expect(await deadLettered()).toBe(0);
    }, 300_000);

    it('D + F: a dispute naming a capture that never becomes verifiable keeps L-4 fail-closed (503, receipt unspent); at the retry bound it is the deterministic capture_unverified conflict; mismatched statements of the late capture are conflicts; never attributed to another capture', async () => {
      const { s, late, ls } = await attestedLateSettlement(beneficiaryD2, adminD);
      const before = await finality(s.paymentId);
      // attempt 2's capture is never reported: its dispute cannot be attributed (and is never moved to attempt 1's late capture)
      const ref = `sint-dx-${randomUUID()}`;
      const c = await dispute(s.paymentId, s.attempts[1]!, ref, { event: 'opened' });
      const [held] = await notifications(ref);
      expect(held).toMatchObject({ state: 'unmatched', outcome: 'dispute_held:capture_pending' });
      expect(await exposure(s.paymentId)).toMatchObject({ state: 'unresolved', openDisputes: 0, conflicts: 0 });
      // CB-3 fail-closed: Billing cannot verify the exposure: 503, the receipt is not spent, nothing is sold
      const receipt = await ownerReceipt(ls.id, s.requestId, beneficiaryD2);
      const unavailable = await applyL4(ls.id, receipt.secret);
      expect([unavailable.status, unavailable.json?.code], `${JSON.stringify(unavailable.json)}\n${tails()}`).toEqual([503, 'late_settlement_dispute_unavailable']);
      expect(await receiptStatus(receipt.receiptId)).toBe('issued');
      expect(await purchasesOf(s.requestId)).toBe(0);

      // LABELLED RETRY-BUDGET SHIFT (bookkeeping only, like G4's labelled clock shift): the notification is left exactly its LAST permitted
      // processing (Payment's WEBHOOK_RETRY_MAX_ATTEMPTS = 10, so 9 used) instead of waiting the ~85 minutes of real backoff; its signed
      // body, provider and receipt time are unchanged. The provider then redelivers the same signed notification.
      await paymentAdmin.query(`UPDATE webhook_event SET attempts = 9 WHERE id = $1`, [held.id]);
      await redeliver(c.commandId);
      expect((await notifications(ref))[0]).toMatchObject({ state: 'conflict', outcome: 'dispute_capture_unverified', attempts: 10 });
      expect(await observations(ref)).toEqual([{ kind: 'opened', disposition: 'conflict', reason: 'capture_unverified' }]);
      expect(await paymentDispute(ref)).toBeUndefined();
      await redeliver(c.commandId); // terminal: a further redelivery changes nothing
      expect(await observations(ref)).toHaveLength(1);
      expect(await exposure(s.paymentId)).toMatchObject({ state: 'unresolved', conflicts: 1 });
      expect((await applyL4(ls.id, receipt.secret)).status).toBe(503);
      expect(await receiptStatus(receipt.receiptId)).toBe('issued');

      // F: statements of the VERIFIED late capture that do not match it are conflicts, never disputes (amount above it, another currency)
      for (const [amount, currency] of [[BASE + 1, 'TND'], [BASE, 'EUR']] as const) {
        const pid = `simd_sint-dm-${randomUUID()}`;
        expect(await signed({ eventId: `sint_${randomUUID()}`, type: 'payment.dispute.opened', reference: s.attempts[0], amount, currency, data: { disputeId: pid } })).toBe(200);
        expect((await paymentAdmin.query(`SELECT disposition, reason FROM payment_dispute_observation WHERE "providerDisputeId" = $1`, [pid])).rows)
          .toEqual([{ disposition: 'conflict', reason: 'exposure_mismatch' }]);
      }
      await settle();
      expect(await count(paymentAdmin, `SELECT count(*)::int AS n FROM payment_dispute WHERE "paymentId" = $1`, [s.paymentId])).toBe(0);
      expect(await count(paymentAdmin, `SELECT count(*)::int AS n FROM outbox WHERE name LIKE 'payment.dispute.%' AND payload->>'paymentId' = $1`, [s.paymentId])).toBe(0);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM payment_dispute_loss WHERE "paymentId" = $1`, [s.paymentId])).toBe(0);
      expect(await count(paymentAdmin, `SELECT count(*)::int AS n FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture'`, [s.paymentId])).toBe(1); // late's only
      expect(late.factId).toBeDefined();
      expect(await finality(s.paymentId)).toEqual(before);
      expect(await deadLettered()).toBe(0);
    }, 300_000);

    it('G5 (S0-C9): a forged payment.dispute.lost naming a late capture (no broker-verified Payment identity) is refused and dead-lettered; no loss, no effect, no obligation', async () => {
      const template = (await paymentAdmin.query(`SELECT payload FROM outbox WHERE name = 'payment.dispute.lost' AND payload->>'captureBasis' = 'late_capture' ORDER BY "occurredAt" LIMIT 1`)).rows[0]
        .payload as Record<string, unknown>;
      const losses = await count(billingAdmin, `SELECT count(*)::int AS n FROM payment_dispute_loss`);
      const effects = await count(billingAdmin, `SELECT count(*)::int AS n FROM dispute_loss_effect`);
      const obligations = await count(billingAdmin, `SELECT count(*)::int AS n FROM recovery_obligation`);
      const deadBefore = await deadLettered();
      const id = randomUUID();
      // a genuine body of the family, a new dispute and chargeback naming a real late capture
      const body = { ...template, disputeId: randomUUID(), chargeback: { factId: randomUUID(), amount: BASE, currency: 'TND' } };
      const pub = await amqpConn.createConfirmChannel();
      pub.publish('nawara.events', 'payment.dispute.lost', Buffer.from(JSON.stringify(body)), { messageId: id, type: 'payment.dispute.lost', persistent: true,
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
      await settle();
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM payment_dispute_loss`)).toBe(losses);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM dispute_loss_effect`)).toBe(effects);
      expect(await count(billingAdmin, `SELECT count(*)::int AS n FROM recovery_obligation`)).toBe(obligations);
    }, 60_000);
  },
);
