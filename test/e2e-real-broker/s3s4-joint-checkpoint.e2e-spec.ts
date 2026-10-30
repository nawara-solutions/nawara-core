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
import { startReferenceStub, TEST_PLATFORM } from './support/admission.js';
import { createPaymentIdentity, tapPaymentEvents, type PaymentIdentity } from './support/payment-identity.js';

const refStub = await startReferenceStub();
let paymentIdentity: PaymentIdentity | undefined;
let tap: Awaited<ReturnType<typeof tapPaymentEvents>> | undefined;
afterAll(() => refStub.close());

/**
 * Core V2 S3/S4 JOINT CHECKPOINT (execution roadmap §4.4; S3 and S4 stage records §2): ONE continuous direct purchase across three separately
 * spawned, BUILT processes — the real auth-service, billing-service and payment-service — over real HTTP and a REAL RabbitMQ, on Payment's
 * simulation provider:
 *
 *   the Owner configures the Platform and its catalog (BIL-01, BIL-02, BIL-03; live Auth)
 *   → a member's checkout (BIL-10; live /auth/me) → invoice and payment request → Billing's dispatcher creates the payment at Payment
 *   → the payer's attempt (the server selects the simulation provider) → the harness's instruction → the provider's SIGNED notification
 *   → Payment's verified provider fact → `payment.succeeded` published under Payment's own broker identity (S1a `user_id`)
 *   → Billing's verified-only consumer (S1e) → exactly one Personal purchase → the personal entitlement read (BIL-11, a service contract).
 *
 * No internal HTTP request is mocked and no payment fact is fabricated: money enters only through Payment's webhook pipeline. The only
 * stand-in is the Organization reference read (Organization Service is not authoritative before F7), which no step of this flow consults.
 * Negative cases stay inside this flow: duplicate provider notifications, a real broker redelivery, a forged event, and fail-closed
 * authorization of checkout, the attempt and the entitlement read. Simulation only: nothing here is a production configuration.
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w @nawara/audit-contract -w auth-service -w billing-service -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUTH_DIR = `${ROOT}apps/auth-service`;
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const AUTH_PORT = 13641;
const BILLING_PORT = 13642;
const PAYMENT_PORT = 13643;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const COMPANY = randomUUID();
const OWNER = randomUUID();
const BUYER = randomUUID();
const OTHER = randomUUID();
const PASSWORD = 's3s4 joint checkpoint password';
const WEBHOOK_SECRET = randomBytes(32).toString('hex');
const UNIT_AMOUNT = 4500;
const b64 = () => randomBytes(32).toString('base64');

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as Auth verifies it; the secret is base32 (the Owner's first-login enrollment). */
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

describeWithEnv(
  'Core V2 S3/S4 joint checkpoint: checkout → attempt → verified fact → payment.* over a real broker → verified consumption → one purchase → entitlement read',
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
    let buyerToken = '';
    let otherToken = '';
    let offering: { productId: string; priceId: string } | undefined;
    const billingToPaymentToken = generateServiceToken();
    const harnessToken = generateServiceToken();
    const entitlementReader = generateServiceToken(); // holds `entitlement.read` only
    const unrelatedCaller = generateServiceToken(); // admitted to Billing, without `entitlement.read`

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
    const tails = () => `--- auth ---\n${auth?.tail()}\n--- payment ---\n${payment?.tail()}\n--- billing ---\n${billing?.tail()}`;
    const deadLettered = async () => {
      const ch = await amqpConn.createChannel();
      const n = (await ch.checkQueue(BILLING_DEAD_QUEUE)).messageCount;
      await ch.close();
      return n;
    };
    const entitlement = (token: string | null, userId: string, productId: string) =>
      call(BILLING_URL, 'GET', token, `/billing/users/${userId}/platforms/${TEST_PLATFORM}/products/${productId}/entitlement`);
    const checkoutInvoices = async () => Number((await billingAdmin.query(`SELECT count(*) FROM invoice WHERE producer = 'billing-checkout'`)).rows[0].count);
    const purchases = async (invoiceId: string) =>
      (await billingAdmin.query(`SELECT id, purpose, "beneficiaryUserId", "productId", "priceId", "originalEnd" FROM subscription_purchase WHERE "invoiceId" = $1`, [invoiceId])).rows;
    /** The checkout's payment request, once Billing's real dispatcher has created the payment at Payment. */
    const requestedPayment = async (paymentRequestId: string): Promise<string> => {
      let paymentId = '';
      await waitFor(async () => {
        const r = await call(BILLING_URL, 'GET', buyerToken, `/billing/payment-requests/${paymentRequestId}`);
        paymentId = r.json?.paymentId ?? '';
        return r.json?.status === 'requested' && !!paymentId;
      }, 20_000, `Billing's dispatcher to create the payment at Payment\n${tails()}`);
      return paymentId;
    };

    beforeAll(async () => {
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauths3s4');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillings3s4');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epayments3s4');
      await runMigrations(authDb.url, [`${AUTH_DIR}/db/migrations/`], { fileTransaction: 'strip', strictHistory: true, adoptLegacyChecksums: true });
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      authAdmin = new pg.Pool({ connectionString: authDb.url });
      billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      paymentAdmin = new pg.Pool({ connectionString: paymentDb.url });

      // The hierarchy and the identities: no Auth route creates a Company or Platform before F7 (ADR-0062), so they are seeded in Auth's
      // own database, as every cross-process suite does. Everything after this is the services' own routes.
      const hash = await bcrypt.hash(PASSWORD, 4);
      await authAdmin.query(`INSERT INTO company(id, name) VALUES ($1, 'S3S4JOINT')`, [COMPANY]);
      await authAdmin.query(`INSERT INTO platform(id, "companyId", name) VALUES ($1, $2, 'S3S4JOINT platform')`, [TEST_PLATFORM, COMPANY]);
      const c = await authAdmin.connect();
      try {
        await c.query('BEGIN');
        await c.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'owner', 'owner-s3s4@e2e.test', $2, 'admin')`, [OWNER, hash]);
        await c.query(`INSERT INTO owner("userId", "companyId") VALUES ($1, $2)`, [OWNER, COMPANY]);
        await c.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'member', 'buyer-s3s4@e2e.test', $2, 'member')`, [BUYER, hash]);
        await c.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'member', 'other-s3s4@e2e.test', $2, 'member')`, [OTHER, hash]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }

      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      paymentIdentity = await createPaymentIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
      await purgeQueue(BILLING_QUEUE);
      await purgeQueue(BILLING_DEAD_QUEUE);
      tap = await tapPaymentEvents(amqpConn);

      auth = spawnService('auth', AUTH_DIR, {
        NODE_ENV: 'test', PORT: String(AUTH_PORT), DATABASE_URL: authDb.url, AUTH_EVENTS: 'off', RABBITMQ_URL: env.TEST_RABBITMQ_URL,
        JWT_SECRET: b64(), OPERATOR_CODE_PEPPER: b64(), SECRET_KEY_PEPPER: b64(), THROTTLE_KEY_PEPPER: b64(), JOIN_CODE_PEPPER: b64(),
        TOTP_ENCRYPTION_KEYS: `k1:${b64()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', WEBAUTHN_RP_ID: 'auth.e2e.test', WEBAUTHN_ORIGINS: 'https://auth.e2e.test',
        BCRYPT_COST: '4', REQUIRE_CONTACT_VERIFICATION: 'false',
      });
      try {
        await waitForHealth(`${AUTH_URL}/health`, 30_000);
      } catch (e) {
        throw new Error(`${String(e)}\n${auth.tail()}`);
      }
      payment = spawnService('payment', PAYMENT_DIR, {
        NODE_ENV: 'test', PORT: String(PAYMENT_PORT), DATABASE_URL: paymentDb.url, AUTH_SERVICE_URL: AUTH_URL,
        RABBITMQ_URL: paymentIdentity!.url(env.TEST_RABBITMQ_URL),
        PAYMENT_SUPPORTED_CURRENCIES: 'TND', PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: WEBHOOK_SECRET,
        SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest},simulation-harness:${harnessToken.digest}`,
        // an ISOLATED TEST policy: billing-service creates and reads its payments; the harness only instructs the simulation provider
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
        ...refStub.env,
      });
      billing = spawnService('billing', BILLING_DIR, {
        NODE_ENV: 'test', PORT: String(BILLING_PORT), DATABASE_URL: billingDb.url,
        AUTH_SERVICE_URL: AUTH_URL, RABBITMQ_URL: env.TEST_RABBITMQ_URL, BILLING_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `entitlement-reader:${entitlementReader.digest},unrelated-caller:${unrelatedCaller.digest}`,
        // an ISOLATED TEST policy: one reader of the entitlement contract (BIL-11), and a caller admitted to something else
        BILLING_SERVICE_POLICY: JSON.stringify({ callers: {
          'entitlement-reader': { operations: ['entitlement.read'], allowedPlatforms: [TEST_PLATFORM] },
          'unrelated-caller': { operations: ['invoice.read'], allowedPlatforms: [TEST_PLATFORM] },
        } }),
        ...refStub.env,
        PAYMENT_SERVICE_URL: PAYMENT_URL, PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
        // the purchase must come from the verified event, never from the reconciler's read fallback
        BILLING_DISPATCH_INTERVAL_MS: '300', BILLING_RECONCILE_INTERVAL_MS: '3600000',
      });
      try {
        await Promise.all([waitForHealth(`${PAYMENT_URL}/health`, 20_000), waitForHealth(`${BILLING_URL}/health`, 20_000)]);
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n${tails()}`);
      }

      // the Owner's real session (a first login enrolls the factor) and the members' sessions
      const start = await call(AUTH_URL, 'POST', null, '/auth/login', { email: 'owner-s3s4@e2e.test', password: PASSWORD }, null);
      expect(start.json?.status, JSON.stringify(start.json)).toBe('enrollment_required');
      const begin = await call(AUTH_URL, 'POST', null, '/auth/admin/enroll/totp', { enrollmentToken: start.json.enrollmentToken }, null);
      const confirm = await call(AUTH_URL, 'POST', null, '/auth/admin/enroll/totp/confirm',
        { enrollmentToken: start.json.enrollmentToken, factorId: begin.json.factorId, code: totp(begin.json.secret) }, null);
      expect(confirm.status, JSON.stringify(confirm.json)).toBe(200);
      ownerToken = confirm.json.accessToken;
      for (const [email, set] of [['buyer-s3s4@e2e.test', (t: string) => { buyerToken = t; }], ['other-s3s4@e2e.test', (t: string) => { otherToken = t; }]] as const) {
        const r = await call(AUTH_URL, 'POST', null, '/auth/login', { email, password: PASSWORD }, null);
        expect(r.status, JSON.stringify(r.json)).toBe(200);
        set(r.json.accessToken);
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

    it('the Owner configures the Platform and a Personal product through Billing\'s Owner routes (live Auth); nothing is seeded in Billing', async () => {
      const platform = await call(BILLING_URL, 'POST', ownerToken, `/billing/admin/platforms/${TEST_PLATFORM}`, { currency: 'TND' });
      expect(platform.status, `${JSON.stringify(platform.json)}\n${tails()}`).toBe(201);
      expect(platform.json).toMatchObject({ platformId: TEST_PLATFORM, companyId: COMPANY, currency: 'TND' });
      // a member is never an Owner of a Platform: refused before anything is written
      expect((await call(BILLING_URL, 'POST', buyerToken, `/billing/admin/platforms/${TEST_PLATFORM}/products`, { code: 'never', name: 'Never' })).status).toBe(403);
      const product = await call(BILLING_URL, 'POST', ownerToken, `/billing/admin/platforms/${TEST_PLATFORM}/products`, { code: `joint-${randomUUID().slice(0, 8)}`, name: 'Joint checkpoint plan' });
      expect(product.status, JSON.stringify(product.json)).toBe(201);
      const price = await call(BILLING_URL, 'POST', ownerToken, `/billing/admin/platforms/${TEST_PLATFORM}/products/${product.json.id}/prices`,
        { clientReference: `joint-${randomUUID().slice(0, 8)}`, unitAmount: UNIT_AMOUNT, intervalUnit: 'month', intervalCount: 1, effectiveFrom: '2020-01-01T00:00:00Z' });
      expect(price.status, JSON.stringify(price.json)).toBe(201);
      offering = { productId: product.json.id, priceId: price.json.id };
    });

    it('checkout fails closed: no bearer, a service token or an Owner is refused, and nothing is created', async () => {
      const body = { platformId: TEST_PLATFORM, productId: offering!.productId, priceId: offering!.priceId };
      const before = await checkoutInvoices();
      expect((await call(BILLING_URL, 'POST', null, '/billing/checkout/direct', body)).status).toBe(401);
      expect((await call(BILLING_URL, 'POST', entitlementReader.token, '/billing/checkout/direct', body)).status).toBe(401); // a service is never a buyer
      const owner = await call(BILLING_URL, 'POST', ownerToken, '/billing/checkout/direct', body);
      expect([owner.status, owner.json?.code]).toEqual([403, 'member_not_eligible']);
      expect(await checkoutInvoices()).toBe(before);
    });

    it('ONE continuous direct purchase: checkout → attempt → signed provider success → verified fact → payment.succeeded over the real broker → one purchase → entitlement read', async () => {
      const { productId, priceId } = offering!;
      // nothing is owned before the purchase; the read is a service contract (BIL-11)
      expect((await entitlement(entitlementReader.token, BUYER, productId)).json).toEqual({ valid: false, expiresAt: null });

      // 1. checkout, by the member's own bearer (verified live by Auth); a replay of the same key returns the same request
      const key = `checkout-${randomUUID()}`;
      const body = { platformId: TEST_PLATFORM, productId, priceId };
      const co = await call(BILLING_URL, 'POST', buyerToken, '/billing/checkout/direct', body, key);
      expect(co.status, `${JSON.stringify(co.json)}\n${tails()}`).toBe(201);
      const { invoiceId, paymentRequestId } = co.json as { invoiceId: string; paymentRequestId: string };
      const invoicesAfterCheckout = await checkoutInvoices();
      const replay = await call(BILLING_URL, 'POST', buyerToken, '/billing/checkout/direct', body, key);
      expect(replay.json).toMatchObject({ invoiceId, paymentRequestId });
      expect(await checkoutInvoices()).toBe(invoicesAfterCheckout);

      // 2. the payment request reaches Payment through Billing's real dispatcher; Payment records the routing purpose and simulation mode
      const paymentId = await requestedPayment(paymentRequestId);
      expect((await paymentAdmin.query(`SELECT purpose, "beneficiaryUserId", "liveMode", amount::int AS amount, currency FROM payment WHERE id = $1`, [paymentId])).rows[0])
        .toEqual({ purpose: 'direct_purchase', beneficiaryUserId: BUYER, liveMode: false, amount: UNIT_AMOUNT, currency: 'TND' });

      // 3. the payer's attempt; another member cannot start one on this payment (collapsed answer, nothing created)
      const foreign = await call(PAYMENT_URL, 'POST', otherToken, `/payment/payments/${paymentId}/attempts`, {});
      expect(foreign.status, JSON.stringify(foreign.json)).toBe(404);
      const attempt = await call(PAYMENT_URL, 'POST', buyerToken, `/payment/payments/${paymentId}/attempts`, {});
      expect(attempt.json, `${JSON.stringify(attempt.json)}\n${tails()}`).toMatchObject({ provider: 'simulation', status: 'submitted' });
      expect((await paymentAdmin.query(`SELECT count(*)::int AS n FROM payment_attempt WHERE "paymentId" = $1`, [paymentId])).rows[0].n).toBe(1);
      expect(await purchases(invoiceId)).toEqual([]); // a submitted attempt grants nothing

      // 4. the provider's success: the harness instructs the simulation provider, whose SIGNED notification enters Payment's webhook pipeline
      const commandId = `joint-${randomUUID()}`;
      const resolved = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${paymentId}/attempts/${attempt.json.id}/outcomes`,
        { commandId, outcome: 'succeeded' });
      expect(resolved.json?.delivered, `${JSON.stringify(resolved.json)}\n${tails()}`).toEqual({ status: 200 });

      // 5. Billing's verified consumer settles it once, over the real broker
      await waitFor(async () => (await purchases(invoiceId)).length > 0, 30_000, `Billing to record the purchase from the verified event\n${tails()}`);
      const facts = await paymentAdmin.query(`SELECT id FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture'`, [paymentId]);
      expect(facts.rows, 'one verified capture fact').toHaveLength(1);
      const outbox = await paymentAdmin.query(`SELECT id FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [paymentId]);
      expect(outbox.rows).toHaveLength(1);
      const receipt = (await billingAdmin.query(`SELECT "eventId" FROM payment_event_receipt WHERE "paymentRequestId" = $1 AND "eventName" = 'payment.succeeded'`, [paymentRequestId])).rows;
      expect(receipt, 'settled by the event, not by the reconciler').toHaveLength(1);
      const eventId: string = receipt[0].eventId;
      expect(eventId).toBe(outbox.rows[0].id);
      const provenance = await billingAdmin.query(`SELECT verified, "producerUserId", source, name FROM event_provenance WHERE "eventId" = $1 AND consumer = $2`, [eventId, BILLING_QUEUE]);
      expect(provenance.rows).toEqual([{ verified: true, producerUserId: 'payment-service', source: 'payment-service', name: 'payment.succeeded' }]);
      expect((await billingAdmin.query(`SELECT source FROM payment_event_origin WHERE "eventId" = $1`, [eventId])).rows).toEqual([{ source: 'payment-service' }]);

      // 6. exactly one purchase, for the buyer, of this product and price; the invoice and request are paid
      const bought = await purchases(invoiceId);
      expect(bought).toHaveLength(1);
      expect(bought[0]).toMatchObject({ purpose: 'direct_purchase', beneficiaryUserId: BUYER, productId, priceId });
      expect((await billingAdmin.query(`SELECT status FROM invoice WHERE id = $1`, [invoiceId])).rows[0].status).toBe('paid');
      expect((await call(BILLING_URL, 'GET', buyerToken, `/billing/payment-requests/${paymentRequestId}`)).json.status).toBe('paid');

      // 7. the Personal Subscription of the buyer on this Platform and product
      const subs = await billingAdmin.query(`SELECT "userId", "platformId", "productId" FROM personal_subscription WHERE "userId" = $1 AND "productId" = $2`, [BUYER, productId]);
      expect(subs.rows).toEqual([{ userId: BUYER, platformId: TEST_PLATFORM, productId }]);

      // 8. the entitlement through the supported service contract: valid until the purchase's end; never another member's
      const read = await entitlement(entitlementReader.token, BUYER, productId);
      expect(read.status).toBe(200);
      expect(read.json).toEqual({ valid: true, expiresAt: new Date(bought[0].originalEnd).toISOString() });
      expect(new Date(read.json.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect((await entitlement(entitlementReader.token, OTHER, productId)).json).toEqual({ valid: false, expiresAt: null });

      // duplicates change nothing: the provider's notification again (same command), and a real broker redelivery of Payment's exact message
      const dlqBefore = await deadLettered();
      expect((await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/commands/${commandId}/deliver`)).json?.delivered).toEqual({ status: 200 });
      await paymentIdentity!.redeliver(await tap!.take(eventId));
      await new Promise((r) => setTimeout(r, 2500));
      expect((await paymentAdmin.query(`SELECT count(*)::int AS n FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture'`, [paymentId])).rows[0].n).toBe(1);
      expect((await paymentAdmin.query(`SELECT count(*)::int AS n FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [paymentId])).rows[0].n).toBe(1);
      expect((await billingAdmin.query(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [paymentRequestId])).rows[0].n).toBe(1);
      expect(await purchases(invoiceId)).toHaveLength(1);
      expect((await entitlement(entitlementReader.token, BUYER, productId)).json).toEqual(read.json);
      expect(await deadLettered()).toBe(dlqBefore);
    }, 120_000);

    it('a forged payment.succeeded (no broker-verified Payment identity) for an unpaid checkout creates nothing; it is dead-lettered', async () => {
      const { productId, priceId } = offering!;
      // a second, unfinished checkout of the OTHER member, with its real payment at Payment
      const co = await call(BILLING_URL, 'POST', otherToken, '/billing/checkout/direct', { platformId: TEST_PLATFORM, productId, priceId });
      expect(co.status, JSON.stringify(co.json)).toBe(201);
      const paymentId = await (async () => {
        let id = '';
        await waitFor(async () => {
          const r = await call(BILLING_URL, 'GET', otherToken, `/billing/payment-requests/${co.json.paymentRequestId}`);
          id = r.json?.paymentId ?? '';
          return r.json?.status === 'requested' && !!id;
        }, 20_000, `the dispatcher\n${tails()}`);
        return id;
      })();
      // the genuine shape of Payment's event (taken from Payment's own published message), re-addressed to the unpaid checkout and published
      // by a broker identity that is NOT payment-service (the test connection's administrator: no user_id)
      const genuine = (await paymentAdmin.query(`SELECT id FROM outbox WHERE name = 'payment.succeeded' ORDER BY "occurredAt" DESC LIMIT 1`)).rows[0].id as string;
      const template = await tap!.take(genuine);
      const genuinePayload = JSON.parse(template.content.toString('utf8')) as Record<string, unknown>; // the body is the payload; the id travels in properties
      const forgedId = randomUUID();
      const forged = Buffer.from(JSON.stringify({ ...genuinePayload, paymentId, paymentRequestId: co.json.paymentRequestId, sourceId: co.json.invoiceId,
        beneficiaryUserId: OTHER, payer: { type: 'user', id: OTHER } }));
      const dlqBefore = await deadLettered();
      const ch = await amqpConn.createConfirmChannel();
      ch.publish('nawara.events', 'payment.succeeded', forged, { messageId: forgedId, type: template.type, headers: { ...template.headers, eventId: forgedId }, timestamp: template.timestamp, contentType: template.contentType });
      await ch.waitForConfirms();
      await ch.close();
      await waitFor(async () => (await deadLettered()) > dlqBefore, 20_000, `the forgery to be refused and dead-lettered\n${tails()}`);
      // refused for its IDENTITY (no broker-verified Payment user_id), not for its shape: the trust decision and the stored observation say so
      const dead = await amqpConn.createChannel();
      let reason: unknown;
      for (let m = await dead.get(BILLING_DEAD_QUEUE, { noAck: false }); m; m = await dead.get(BILLING_DEAD_QUEUE, { noAck: false })) {
        if (m.properties.messageId === forgedId) reason = (m.properties.headers ?? {})['x-nawara-failure-reason'];
      }
      await dead.close(); // unacknowledged: every dead letter stays in its queue
      expect(reason).toBe('untrusted_unverified_original');
      expect((await billingAdmin.query(`SELECT verified, "producerUserId" FROM event_provenance WHERE "eventId" = $1 AND consumer = $2`, [forgedId, BILLING_QUEUE])).rows)
        .toEqual([{ verified: false, producerUserId: null }]);
      expect(await purchases(co.json.invoiceId)).toEqual([]);
      expect((await billingAdmin.query(`SELECT status FROM invoice WHERE id = $1`, [co.json.invoiceId])).rows[0].status).toBe('open');
      expect((await billingAdmin.query(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [co.json.paymentRequestId])).rows[0].n).toBe(0);
      expect((await entitlement(entitlementReader.token, OTHER, productId)).json).toEqual({ valid: false, expiresAt: null });
    }, 60_000);

    it('the entitlement read fails closed: no token, a user bearer and a service without entitlement.read are refused', async () => {
      const { productId } = offering!;
      expect((await entitlement(null, BUYER, productId)).status).toBe(401);
      expect((await entitlement(buyerToken, BUYER, productId)).status).toBe(401); // a person never reads through the service contract
      expect((await entitlement(unrelatedCaller.token, BUYER, productId)).status).toBe(403);
    });

    it('Auth unavailable: checkout is 503 and writes nothing (run last: it stops Auth)', async () => {
      const { productId, priceId } = offering!;
      const before = await checkoutInvoices();
      await auth.stop();
      const r = await call(BILLING_URL, 'POST', buyerToken, '/billing/checkout/direct', { platformId: TEST_PLATFORM, productId, priceId });
      expect(r.status, JSON.stringify(r.json)).toBe(503);
      expect(await checkoutInvoices()).toBe(before);
    });
  },
);
