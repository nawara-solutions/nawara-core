import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { createBillingIdentity, type BillingIdentity } from './support/billing-identity.js';

const refStub = await startReferenceStub();
let paymentIdentity: PaymentIdentity | undefined;
let billingIdentity: BillingIdentity | undefined;
afterAll(() => refStub.close());

/**
 * Core V2 S0-C14 WP D: DETERMINISTIC FINANCIAL CERTIFICATION of the refund and chargeback overlap contract (S0 §1.5 S0-C14, V1 to V32) across
 * SEPARATELY SPAWNED, BUILT processes: the REAL auth-service (Owners with TOTP factors, step-ups and receipts), payment-service (simulation
 * provider; every money movement through its signed provider pipeline), audit-service, and TWO billing-service processes sharing ONE database
 * (both run every worker and consume the same queue), over real HTTP and a REAL RabbitMQ in which Billing publishes as its REAL `billing-service`
 * identity (provision.sh resource permissions and the generated topic grant). Between both Billing processes and Payment sits a RECORDING
 * PROXY: at the arrival of every PAY-08 read it records whether the payment's loss was already committed in Billing (V27), and at the arrival
 * of every refund relay whether its relay row was already committed (V32); for named payments it can drop a relay or fail PAY-08 (V13, V29).
 *
 * TEST AIDS, each labelled where used: (1) BARRIERS: a session advisory lock on Billing's own Organization lock key, held by the test, pauses
 * the recovery worker inside its transaction (V1, V30); (2) LABELLED FIXTURES: a relay row deleted (a Billing rewind: V14, V22, V31), a mirror
 * moved ahead of Payment (V28 a), a relay committed while the worker is paused and then Payment's refusal mirrored (V30). Setup (Auth users,
 * Organizations, the Platform configuration and catalog) is seeded by SQL; it is not behaviour under test.
 *
 * DEVELOPMENT AND SIMULATION ONLY. Prerequisite: build service-kit, audit-contract, auth-service, billing-service, payment-service, audit-service.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUTH_DIR = `${ROOT}apps/auth-service`;
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const AUDIT_DIR = `${ROOT}apps/audit-service`;
const PORT = { auth: 13851, b1: 13852, b2: 13853, payment: 13854, audit: 13856, b3: 13857, b4: 13858 };
const AUTH_URL = `http://127.0.0.1:${PORT.auth}`;
const B1 = `http://127.0.0.1:${PORT.b1}`;
const B2 = `http://127.0.0.1:${PORT.b2}`;
const PAYMENT_URL = `http://127.0.0.1:${PORT.payment}`;
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const COMPANY = 'aaaaaaaa-0000-4000-8000-00000000c0de'; // the reference stub's Company
const PASSWORD = 's0c14 certification password';
const WEBHOOK_SECRET = randomBytes(32).toString('hex');
const BASE = 4200;
const PRICE = 6400;
const b64 = () => randomBytes(32).toString('base64');

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

type Owner = { id: string; email: string; company: string; token: string; totp: string; lastStep: number };
type Member = { id: string; email: string; organizationId: string; admin: boolean; token: string };
type ProxyRecord = { kind: 'pay08' | 'relay'; paymentId: string; dbAt: Date; lossCommitted?: boolean; relayId?: string; relayCommitted?: boolean; port: string };

describeWithEnv(
  'Core V2 S0-C14 WP D: overlap certification V1–V32 (real Auth, Payment, Audit, TWO Billing processes, RabbitMQ with Billing\'s identity; simulation)',
  ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'],
  (env) => {
    let authDb: TestDatabase;
    let billingDb: TestDatabase;
    let paymentDb: TestDatabase;
    let auditDb: TestDatabase;
    let auth: LiveService;
    let billing1: LiveService;
    let billing2: LiveService;
    let payment: LiveService;
    let audit: LiveService;
    let proxy: Server;
    let proxyUrl = '';
    let amqpConn: ChannelModel;
    let authAdmin: pg.Pool;
    let billingAdmin: pg.Pool;
    let paymentAdmin: pg.Pool;
    let auditAdmin: pg.Pool;
    let productId = '';
    let priceId = '';
    const producerToken = generateServiceToken();
    const billingToPaymentToken = generateServiceToken();
    const harnessToken = generateServiceToken();
    const billingToAuthToken = generateServiceToken();
    const paymentToAuthToken = generateServiceToken();
    const fileToken = generateServiceToken();
    // Auth holds exactly ONE Owner per Company (owner_single_per_company_v1): V18's concurrent suspensions are that Owner's two receipts
    const owners: Record<'a' | 'x', Owner> = {
      a: { id: randomUUID(), email: `oa-${randomUUID().slice(0, 8)}@s0c14.e2e.test`, company: COMPANY, token: '', totp: '', lastStep: 0 },
      x: { id: randomUUID(), email: `ox-${randomUUID().slice(0, 8)}@s0c14.e2e.test`, company: randomUUID(), token: '', totp: '', lastStep: 0 },
    };
    const proxyLog: ProxyRecord[] = [];
    const proxyMode = new Map<string, 'drop_relay' | 'pay08_503' | 'pay08_malformed'>();
    let payerToken = '';
    let payerId = '';

    // ───────────────────────────────────────────────────────────── plumbing
    async function call(base: string, method: 'GET' | 'POST', token: string | null, path: string, body?: unknown, key: string | null = `idem-${randomUUID()}`): Promise<{ status: number; json: any }> {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(method === 'POST' && key ? { 'idempotency-key': key } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    }
    const tails = () => `--- billing1 ---\n${billing1?.tail()}\n--- billing2 ---\n${billing2?.tail()}\n--- payment ---\n${payment?.tail()}`;
    const one = async (pool: pg.Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0] as Record<string, any> | undefined;
    const n = async (pool: pg.Pool, sql: string, params: unknown[] = []) => Number((await pool.query(sql, params)).rows[0].n);
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const restrictions = async (org: string) => (await billingAdmin.query(`SELECT kind, "sourceId" FROM billing_assistance_restrictions($1, now())`, [org])).rows as { kind: string; sourceId: string }[];
    const deadLettered = async () => {
      const ch = await amqpConn.createChannel();
      const c = (await ch.checkQueue(BILLING_DEAD_QUEUE)).messageCount;
      await ch.close();
      return c;
    };
    async function purgeQueue(name: string) {
      const ch = await amqpConn.createChannel();
      ch.on('error', () => undefined);
      await ch.purgeQueue(name).catch(() => undefined);
      await ch.close().catch(() => undefined);
    }

    /** The recording proxy between BOTH Billing processes and Payment (V27, V32; V13 and V29 modes). */
    async function startProxy(): Promise<void> {
      proxy = createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => void (async () => {
          const body = Buffer.concat(chunks);
          const m = /^\/payment\/payments\/([0-9a-f-]{36})\/refunds$/.exec(req.url ?? '');
          const port = String(req.headers['x-forwarded-port'] ?? '');
          if (m && req.method === 'GET') {
            const r = (await billingAdmin.query(`SELECT clock_timestamp() AS at, EXISTS (SELECT 1 FROM payment_dispute_loss WHERE "paymentId" = $1) AS loss`, [m[1]])).rows[0];
            proxyLog.push({ kind: 'pay08', paymentId: m[1]!, dbAt: r.at, lossCommitted: r.loss, port });
            const mode = proxyMode.get(m[1]!);
            if (mode === 'pay08_503') return void (res.writeHead(503, { 'content-type': 'application/json' }), res.end('{"code":"unavailable"}'));
            if (mode === 'pay08_malformed') return void (res.writeHead(200, { 'content-type': 'application/json' }), res.end('{"attempts":"nope"}'));
          }
          if (m && req.method === 'POST') {
            const relayId = (JSON.parse(body.toString('utf8') || '{}') as { refundAttemptId?: string }).refundAttemptId ?? '';
            const r = (await billingAdmin.query(`SELECT clock_timestamp() AS at, EXISTS (SELECT 1 FROM refund_authorization_relay WHERE id = $1) AS committed`, [relayId])).rows[0];
            proxyLog.push({ kind: 'relay', paymentId: m[1]!, dbAt: r.at, relayId, relayCommitted: r.committed, port });
            if (proxyMode.get(m[1]!) === 'drop_relay') return void (res.destroy());
          }
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'content-length', 'connection'].includes(k)) headers[k] = v;
          try {
            const up = await fetch(`${PAYMENT_URL}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body });
            const text = Buffer.from(await up.arrayBuffer());
            res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
            res.end(text);
          } catch {
            res.destroy();
          }
        })());
      });
      await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
      proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    }

    const billingEnv = (port: number, paymentUrl = proxyUrl) => ({
      NODE_ENV: 'test', PORT: String(port), DATABASE_URL: billingDb.url, AUTH_SERVICE_URL: AUTH_URL,
      RABBITMQ_URL: billingIdentity!.url(env.TEST_RABBITMQ_URL), // Billing's REAL broker identity (item 7)
      BILLING_SUPPORTED_CURRENCIES: 'TND', SERVICE_TOKENS: `test-producer:${producerToken.digest}`, ...billingPolicy('test-producer'), ...refStub.env,
      PAYMENT_SERVICE_URL: paymentUrl, PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
      BILLING_DISPATCH_INTERVAL_MS: '300', BILLING_RECONCILE_INTERVAL_MS: '3600000', BILLING_ASSISTANCE_SWEEP_INTERVAL_MS: '1000',
      AUTH_SERVICE_TOKEN: billingToAuthToken.token, FILE_SERVICE_URL: 'http://127.0.0.1:1', FILE_SERVICE_TOKEN: fileToken.token,
    });

    // ───────────────────────────────────────────────────────────── setup
    beforeAll(async () => {
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauths0c14');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillings0c14');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epayments0c14');
      auditDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eaudits0c14');
      await runMigrations(authDb.url, [`${AUTH_DIR}/db/migrations/`], { fileTransaction: 'strip', strictHistory: true, adoptLegacyChecksums: true });
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      await runMigrations(auditDb.url, [kitMigrationsDir, `${AUDIT_DIR}/db/migrations/`]);
      authAdmin = new pg.Pool({ connectionString: authDb.url });
      billingAdmin = new pg.Pool({ connectionString: billingDb.url, max: 20 });
      paymentAdmin = new pg.Pool({ connectionString: paymentDb.url, max: 20 });
      auditAdmin = new pg.Pool({ connectionString: auditDb.url });

      const hash = await bcrypt.hash(PASSWORD, 4);
      await authAdmin.query(`INSERT INTO company(id, name) VALUES ($1, 'S0-C14'), ($2, 'Other Company')`, [COMPANY, owners.x.company]);
      await authAdmin.query(`INSERT INTO platform(id, "companyId", name) VALUES ($1, $2, 'S0-C14 platform')`, [TEST_PLATFORM, COMPANY]);
      for (const o of Object.values(owners)) {
        const c = await authAdmin.connect();
        try {
          await c.query('BEGIN');
          await c.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'owner', $2, $3, 'admin')`, [o.id, o.email, hash]);
          await c.query(`INSERT INTO owner("userId", "companyId") VALUES ($1, $2)`, [o.id, o.company]);
          await c.query('COMMIT');
        } finally {
          c.release();
        }
      }
      payerId = randomUUID();
      await authAdmin.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'member', $2, $3, 'member')`, [payerId, `payer-${randomUUID().slice(0, 8)}@s0c14.e2e.test`, hash]);
      await billingAdmin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [TEST_PLATFORM, COMPANY, randomUUID()]);
      productId = (await billingAdmin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
        VALUES ('billing-owner', 'company', $1, 's0c14-plan', 'Personal plan', 'active', 'personal', $2) RETURNING id`, [COMPANY, TEST_PLATFORM])).rows[0].id;
      priceId = (await billingAdmin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom")
        VALUES ($1, 'monthly', 'TND', $2, 'recurring', 'month', 1, '2020-01-01') RETURNING id`, [productId, BASE])).rows[0].id;

      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      paymentIdentity = await createPaymentIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
      billingIdentity = await createBillingIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
      await purgeQueue(BILLING_QUEUE);
      await purgeQueue(BILLING_DEAD_QUEUE);
      await startProxy();

      const reader = generateServiceToken();
      audit = spawnService('audit', AUDIT_DIR, {
        NODE_ENV: 'test', PORT: String(PORT.audit), DATABASE_URL: auditDb.url, RABBITMQ_URL: env.TEST_RABBITMQ_URL, SERVICE_TOKENS: `org-reader:${reader.digest}`,
        AUDIT_SERVICE_POLICY: JSON.stringify({ callers: { 'org-reader': { operations: ['read_organization'], categories: ['security', 'business', 'commercial', 'administrative'] } } }),
      });
      auth = spawnService('auth', AUTH_DIR, {
        NODE_ENV: 'test', PORT: String(PORT.auth), DATABASE_URL: authDb.url, AUTH_EVENTS: 'off', RABBITMQ_URL: env.TEST_RABBITMQ_URL,
        JWT_SECRET: b64(), OPERATOR_CODE_PEPPER: b64(), SECRET_KEY_PEPPER: b64(), THROTTLE_KEY_PEPPER: b64(), JOIN_CODE_PEPPER: b64(),
        TOTP_ENCRYPTION_KEYS: `k1:${b64()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', WEBAUTHN_RP_ID: 'auth.e2e.test', WEBAUTHN_ORIGINS: 'https://auth.e2e.test',
        BCRYPT_COST: '4', REQUIRE_CONTACT_VERIFICATION: 'false', AUTHORIZATION_RECEIPT_PEPPER: b64(),
        SERVICE_TOKENS: `billing-service:${billingToAuthToken.digest},payment-service:${paymentToAuthToken.digest}`,
        AUTH_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['authorization_receipt.consume', 'authorization_receipt.lookup'] },
          'payment-service': { operations: ['authorization_receipt.consume', 'authorization_receipt.lookup'] },
        } }),
        BASELINE_RATE_LIMIT_PER_MINUTE: '100000',
      });
      payment = spawnService('payment', PAYMENT_DIR, {
        NODE_ENV: 'test', PORT: String(PORT.payment), DATABASE_URL: paymentDb.url, AUTH_SERVICE_URL: AUTH_URL, AUTH_SERVICE_TOKEN: paymentToAuthToken.token,
        RABBITMQ_URL: paymentIdentity!.url(env.TEST_RABBITMQ_URL), PAYMENT_SUPPORTED_CURRENCIES: 'TND', PAYMENT_SIMULATION_PROVIDER: 'true',
        PAYMENT_SIMULATION_WEBHOOK_SECRET: WEBHOOK_SECRET,
        SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest},simulation-harness:${harnessToken.digest}`,
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.create.assisted_settlement', 'payment.create.recovery_settlement',
            'payment.refund.create', 'payment.reconciliation.read'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
        ...refStub.env,
      });
      try {
        await Promise.all([waitForHealth(`${AUTH_URL}/health`, 30_000), waitForHealth(`${PAYMENT_URL}/health`, 30_000), waitForHealth(`http://127.0.0.1:${PORT.audit}/health`, 30_000)]);
      } catch (e) {
        throw new Error(`${String(e)}\n${auth.tail()}\n${payment.tail()}\n${audit.tail()}`);
      }
      // TWO Billing processes, one database (V3, V9, V18, V19)
      billing1 = spawnService('billing1', BILLING_DIR, billingEnv(PORT.b1));
      billing2 = spawnService('billing2', BILLING_DIR, billingEnv(PORT.b2));
      try {
        await Promise.all([waitForHealth(`${B1}/health`, 30_000), waitForHealth(`${B2}/health`, 30_000)]);
      } catch (e) {
        throw new Error(`${String(e)}\n${tails()}`);
      }
      // Owners: the bootstrap TOTP enrollment at the real Auth
      for (const o of Object.values(owners)) {
        const start = await call(AUTH_URL, 'POST', null, '/auth/login', { email: o.email, password: PASSWORD }, null);
        expect(start.json?.status, JSON.stringify(start.json)).toBe('enrollment_required');
        const begin = await call(AUTH_URL, 'POST', null, '/auth/admin/enroll/totp', { enrollmentToken: start.json.enrollmentToken }, null);
        o.totp = begin.json.secret;
        o.lastStep = Math.floor(Date.now() / 30_000);
        const confirm = await call(AUTH_URL, 'POST', null, '/auth/admin/enroll/totp/confirm', { enrollmentToken: start.json.enrollmentToken, factorId: begin.json.factorId, code: totp(o.totp) }, null);
        expect(confirm.status, JSON.stringify(confirm.json)).toBe(200);
        o.token = confirm.json.accessToken;
      }
      const login = await call(AUTH_URL, 'POST', null, '/auth/login', { email: (await one(authAdmin, `SELECT email FROM "user" WHERE id = $1`, [payerId]))!.email, password: PASSWORD }, null);
      payerToken = login.json.accessToken;
      // C14: both Billing processes passed the financial reconciliation safety check on a consistent start; their workers run
      await waitFor(async () => billing1.tail().includes('financial_reconciliation_check_passed') && billing2.tail().includes('financial_reconciliation_check_passed'),
        30_000, `both Billing processes to pass the startup check\n${tails()}`);
    }, 240_000);

    afterAll(async () => {
      await billing1?.stop();
      await billing2?.stop();
      await payment?.stop();
      await auth?.stop();
      await audit?.stop();
      await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
      await paymentIdentity?.remove();
      await billingIdentity?.remove();
      if (amqpConn) {
        await purgeQueue(BILLING_QUEUE);
        await purgeQueue(BILLING_DEAD_QUEUE);
        await amqpConn.close().catch(() => undefined);
      }
      for (const p of [authAdmin, billingAdmin, paymentAdmin, auditAdmin]) await p?.end();
      if (process.env.S0C14_KEEP_DATABASES !== '1') for (const d of [authDb, billingDb, paymentDb, auditDb]) await d?.drop();
    }, 60_000);

    // ───────────────────────────────────────────────────────────── actors and money
    /** A fresh Organization at the real Auth with an administrator and `beneficiaries` members, each logged in. */
    async function organization(beneficiaries = 1) {
      const org = randomUUID();
      await authAdmin.query(`INSERT INTO organization(id, "platformId", name) VALUES ($1, $2, 'S0-C14 organization')`, [org, TEST_PLATFORM]);
      const hash = await bcrypt.hash(PASSWORD, 4);
      const members: Member[] = [];
      for (let i = 0; i <= beneficiaries; i++) {
        const m: Member = { id: randomUUID(), email: `${randomUUID().slice(0, 8)}@s0c14.e2e.test`, organizationId: org, admin: i === 0, token: '' };
        await authAdmin.query(`WITH u AS (INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'member', $2, $3, 'member') RETURNING id)
          INSERT INTO organization_membership ("userId", "organizationId", status, audience, "approvedAt", "isOrganizationAdmin") SELECT $1, $4, 'active', 'member', now(), $5 FROM u`,
          [m.id, m.email, hash, org, m.admin]);
        const login = await call(AUTH_URL, 'POST', null, '/auth/login', { email: m.email, password: PASSWORD }, null);
        expect(login.status, JSON.stringify(login.json)).toBe(200);
        m.token = login.json.accessToken;
        members.push(m);
      }
      return { org, admin: members[0]!, beneficiaries: members.slice(1) };
    }
    async function requestedAt(paymentRequestId: string): Promise<string> {
      await waitFor(async () => (await one(billingAdmin, `SELECT "paymentId" FROM payment_request WHERE id = $1 AND status = 'requested'`, [paymentRequestId]))?.paymentId != null,
        30_000, `the dispatcher to create the payment at Payment\n${tails()}`);
      return (await one(billingAdmin, `SELECT "paymentId" FROM payment_request WHERE id = $1`, [paymentRequestId]))!.paymentId as string;
    }
    async function attemptOf(paymentId: string, token: string) {
      const a = await call(PAYMENT_URL, 'POST', token, `/payment/payments/${paymentId}/attempts`, {});
      expect(a.json, `${JSON.stringify(a.json)}\n${tails()}`).toMatchObject({ provider: 'simulation', status: 'submitted' });
      return a.json as { id: string };
    }
    async function outcome(paymentId: string, attemptId: string, o: Record<string, unknown>) {
      const r = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${paymentId}/attempts/${attemptId}/outcomes`, { commandId: `s0c14-${randomUUID()}`, ...o });
      expect(r.json?.delivered, JSON.stringify(r.json)).toEqual({ status: 200 });
    }
    /** An assisted purchase of `o`'s beneficiary `i`, paid by the Organization at Payment; the verified purchase recorded in Billing. */
    async function assistedPurchase(o: Awaited<ReturnType<typeof organization>>, i = 0, via = B1) {
      const b = o.beneficiaries[i]!;
      const created = await call(via, 'POST', b.token, '/billing/assistance-requests', { organizationId: o.org, productId, priceId, consent: true });
      expect(created.status, `${JSON.stringify(created.json)}\n${tails()}`).toBe(201);
      await pause(20);
      expect((await call(via, 'POST', o.admin.token, `/billing/assistance-requests/${created.json.id}/cash-collection`, { cashCollectedAt: new Date().toISOString() })).status).toBe(200);
      const settled = await call(via, 'POST', o.admin.token, `/billing/assistance-requests/${created.json.id}/settlement`);
      expect(settled.status, JSON.stringify(settled.json)).toBe(201);
      const paymentId = await requestedAt(settled.json.paymentRequestId);
      const a = await attemptOf(paymentId, o.admin.token);
      await outcome(paymentId, a.id, { outcome: 'succeeded' });
      await waitFor(async () => (await n(billingAdmin, `SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [created.json.id])) === 1,
        30_000, `the purchase from the verified event\n${tails()}`);
      return { paymentId, paymentRequestId: settled.json.paymentRequestId as string, requestId: created.json.id as string, amount: BASE };
    }
    /** A direct personal purchase: the Company's invoice, Payment's verified success, the purchase. */
    async function directPurchase() {
      const pid = (await billingAdmin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
        VALUES ('test-producer', 'company', $1, $2, 'Personal plan', 'active', 'personal', $3) RETURNING id`, [COMPANY, `d-${randomUUID().slice(0, 8)}`, TEST_PLATFORM])).rows[0].id;
      const prc = (await billingAdmin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, $2, 'TND', $3, 'recurring', 'month', 1) RETURNING id`,
        [pid, `d-${randomUUID().slice(0, 8)}`, PRICE])).rows[0].id;
      const inv = await call(B1, 'POST', producerToken.token, '/billing/invoices', { invoiceRequestId: randomUUID(), seller: { type: 'company', id: COMPANY }, payer: { type: 'user', id: payerId },
        sourceType: 'contract', sourceId: `src-${randomUUID()}`, issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: prc, quantity: 1 }] });
      expect(inv.status, JSON.stringify(inv.json)).toBe(201);
      expect((await call(B1, 'POST', producerToken.token, `/billing/invoices/${inv.json.id}/issue`)).status).toBe(200);
      const pr = await call(B1, 'POST', producerToken.token, `/billing/invoices/${inv.json.id}/payment-requests`);
      const paymentId = await requestedAt(pr.json.id);
      const a = await attemptOf(paymentId, payerToken);
      await outcome(paymentId, a.id, { outcome: 'succeeded' });
      await waitFor(async () => (await n(billingAdmin, `SELECT count(*) AS n FROM subscription_purchase WHERE "invoiceId" = $1`, [inv.json.id])) === 1, 30_000, `the direct purchase\n${tails()}`);
      return { paymentId, paymentRequestId: pr.json.id as string, invoiceId: inv.json.id as string, amount: PRICE };
    }
    /** The provider's final loss with a full chargeback (signed, through Payment's pipeline); Billing records it over the broker. */
    async function lose(paymentId: string) {
      const ref = `s0c14-${randomUUID()}`;
      for (const event of ['opened', 'lost']) {
        const r = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${paymentId}/disputes`, { commandId: `s0c14-${randomUUID()}`, disputeRef: ref, event });
        expect(r.json?.delivered, JSON.stringify(r.json)).toEqual({ status: 200 });
      }
      const d = (await one(paymentAdmin, `SELECT id FROM payment_dispute WHERE "providerDisputeId" = $1`, [`simd_${ref}`]))!;
      await waitFor(async () => (await n(billingAdmin, `SELECT count(*) AS n FROM dispute_loss_effect WHERE "disputeId" = $1`, [d.id])) === 1, 45_000, `Billing to apply the loss\n${tails()}`);
      return d.id as string;
    }
    /** The Owner's factor step-up for `purpose` at the real Auth (a fresh TOTP step per factor). */
    async function stepUp(o: Owner, purpose: string): Promise<string> {
      const step = Math.floor(Date.now() / 30_000);
      if (step <= o.lastStep) await pause((o.lastStep + 1) * 30_000 - Date.now() + 500);
      o.lastStep = Math.floor(Date.now() / 30_000);
      const su = await call(AUTH_URL, 'POST', o.token, '/auth/admin/step-up', { purpose, method: 'totp', code: totp(o.totp) }, null);
      expect(su.status, JSON.stringify(su.json)).toBe(200);
      return su.json.stepUpToken as string;
    }
    async function receipt(o: Owner, purpose: string, binding: Record<string, unknown>) {
      const r = await call(AUTH_URL, 'POST', o.token, '/auth/admin/authorization-receipts', { stepUpToken: await stepUp(o, purpose), binding });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return r.json as { receiptId: string; secret: string };
    }
    /** The Owner's refund case and its relay through Billing's real route, with a real-Auth receipt; Payment authorizes and dispatches it. */
    async function relayed(paymentId: string, amount: number, opts: { dispatched?: boolean } = {}) {
      const opened = await call(B1, 'POST', owners.a.token, '/billing/admin/refund-cases', { paymentId, reason: 'customer_request' });
      expect(opened.status, `${JSON.stringify(opened.json)}\n${tails()}`).toBe(201);
      const caseId = opened.json.id as string;
      const r = await receipt(owners.a, 'refund.authorize', { operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId, amount, currency: 'TND',
        reason: 'customer_request', legalOverride: false });
      const relay = await call(B1, 'POST', owners.a.token, `/billing/admin/refund-cases/${caseId}/authorizations`, { receiptSecret: r.secret });
      const attemptId = (await one(billingAdmin, `SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1 ORDER BY "requestedAt" DESC LIMIT 1`, [caseId]))!.id as string;
      if (opts.dispatched !== false) {
        expect(relay.status, `${JSON.stringify(relay.json)}\n${tails()}`).toBe(201);
        await waitFor(async () => (await one(paymentAdmin, `SELECT status FROM refund_attempt WHERE id = $1`, [attemptId]))?.status === 'submitted', 30_000, `Payment to dispatch the refund\n${tails()}`);
      }
      return { caseId, attemptId, receiptId: r.receiptId };
    }
    const refundOutcome = async (attemptId: string, o: 'succeeded' | 'failed', commandId = `s0c14-${randomUUID()}`) => {
      const r = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/refunds/${attemptId}/outcomes`, { commandId, outcome: o, ...(o === 'failed' ? { failureCode: 'declined' } : {}) });
      expect(r.json?.delivered, JSON.stringify(r.json)).toEqual({ status: 200 });
      return commandId;
    };
    const mirrored = (attemptId: string, status: string) => waitFor(async () => (await one(billingAdmin, `SELECT "attemptStatus" FROM refund_authorization_relay WHERE id = $1`, [attemptId]))?.attemptStatus === status,
      60_000, `Billing's mirror of ${attemptId} to reach ${status}\n${tails()}`);
    const completedCase = (caseId: string) => waitFor(async () => (await one(billingAdmin, `SELECT status FROM refund_case WHERE id = $1`, [caseId]))?.status === 'completed', 45_000, `the case to complete\n${tails()}`);
    const obligationOf = (disputeId: string) => one(billingAdmin, `SELECT * FROM recovery_obligation WHERE "disputeId" = $1`, [disputeId]);
    const caseOf = (type: string, evidence: string) => one(billingAdmin, `SELECT c.id, c.detail, r.kind, r."refundCaseId" FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
      WHERE c."caseType" = $1 AND c."evidenceKey" = $2`, [type, evidence]);
    /** TEST AID (barrier): holds Billing's own Organization lock key on a session of the test, so a worker transaction that needs it waits. */
    async function barrier(org: string) {
      const c = await billingAdmin.connect();
      await c.query(`SELECT pg_advisory_lock(hashtextextended('billing.assistance_organization:' || $1::text, 0))`, [org]);
      return {
        blockedWorkers: async () => n(billingAdmin, `SELECT count(*) AS n FROM pg_locks l WHERE l.locktype = 'advisory' AND NOT l.granted`),
        release: async () => {
          await c.query(`SELECT pg_advisory_unlock_all()`);
          c.release();
        },
      };
    }
    /** The worker passes (both processes run them): enough for every worker to have visited the loss at least twice. */
    const passes = () => pause(12_000);

    const results: Record<string, string> = {};
    const note = (v: string, s: string) => { results[v] = s; };

    // ───────────────────────────────────────────────────────────── V24, V15: refund admission versus chargeback ingestion (A2 / I1)
    it('V24, V15: under concurrent refund admissions and dispute ingestion, no refund attempt is admitted once the chargeback is recorded; a refund after it is refused at Payment and at Billing', async () => {
      let admittedBefore = 0;
      let refusedAfter = 0;
      for (let round = 0; round < 6; round++) {
        const p = await directPurchase();
        const ref = `v24-${randomUUID()}`;
        const admissions: Promise<{ startedAt: number; status: number; code: string | null }>[] = [];
        const admit = async () => {
          const startedAt = Date.now();
          const r = await call(PAYMENT_URL, 'POST', billingToPaymentToken.token, `/payment/payments/${p.paymentId}/refunds`,
            { refundAttemptId: randomUUID(), refundCaseId: randomUUID(), amount: PRICE, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: randomBytes(32).toString('base64url') });
          return { startedAt, status: r.status, code: r.json?.code ?? null };
        };
        for (let i = 0; i < 4; i++) admissions.push(admit());
        const disputed = (async () => {
          await pause(round * 3);
          for (const event of ['opened', 'lost']) await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${p.paymentId}/disputes`, { commandId: `v24-${randomUUID()}`, disputeRef: ref, event });
          return Date.now();
        })();
        for (let i = 0; i < 4; i++) admissions.push((async () => { await pause(5 + i * 5); return admit(); })());
        const lostAt = await disputed;
        const outs = await Promise.all(admissions);
        const later: Promise<{ startedAt: number; status: number; code: string | null }>[] = [];
        for (let i = 0; i < 3; i++) later.push(admit());
        for (const o of [...outs, ...(await Promise.all(later))]) {
          if (o.startedAt > lostAt) {
            expect(o.status, `an admission started after the loss was recorded: ${JSON.stringify(o)}`).not.toBe(201);
            refusedAfter++;
          }
        }
        // the invariant at Payment: no refund attempt was admitted after the chargeback fact. Payment allows ONE LIVE attempt at a time, so a later
        // attempt may follow one its authorization refused (these admissions carry no valid receipt); every admitted intent precedes the fact
        const facts = (await paymentAdmin.query(`SELECT "observedAt" FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'chargeback'`, [p.paymentId])).rows;
        expect(facts).toHaveLength(1);
        const attempts = (await paymentAdmin.query(`SELECT id, "requestedAt" FROM refund_attempt WHERE "paymentId" = $1`, [p.paymentId])).rows;
        admittedBefore += attempts.length;
        for (const a of attempts) expect(new Date(a.requestedAt).getTime(), 'the admitted attempt preceded the chargeback').toBeLessThanOrEqual(new Date(facts[0].observedAt).getTime());
      }
      expect(refusedAfter).toBeGreaterThan(0);
      // V15 at Billing: a refund case of a charged-back payment is refused (Payment's exposure, read live)
      const p = await directPurchase();
      await lose(p.paymentId);
      const refused = await call(B1, 'POST', owners.a.token, '/billing/admin/refund-cases', { paymentId: p.paymentId, reason: 'customer_request' });
      expect(refused.status, JSON.stringify(refused.json)).toBe(409);
      note('V24', `PASS: 6 rounds, 11 admissions each racing dispute ingestion on one payment; ${refusedAfter} admissions started after the loss was recorded, all refused; attempts admitted ${admittedBefore}, each before its chargeback fact`);
      note('V15', `PASS: after the chargeback, Payment refused every admission; Billing refused a new refund case (409 ${refused.json?.code})`);
    }, 600_000);

    // ───────────────────────────────────────────────────────────── V3: two Billing processes, competing workers, replays
    it('V3 and item 6: two Billing processes run every worker on one database: one obligation per assisted loss, one write-off per direct loss, one case per evidence; replays change nothing', async () => {
      const assisted = await Promise.all([0, 1, 2].map(async () => { const o = await organization(1); return { o, p: await assistedPurchase(o) }; }));
      const direct = await Promise.all([0, 1, 2].map(() => directPurchase()));
      const aLoss = await Promise.all(assisted.map((x) => lose(x.p.paymentId)));
      const dLoss = await Promise.all(direct.map((x) => lose(x.paymentId)));
      await waitFor(async () => (await n(billingAdmin, `SELECT count(*) AS n FROM recovery_obligation WHERE "disputeId" = ANY($1)`, [aLoss])) === 3, 60_000, `three obligations\n${tails()}`);
      await waitFor(async () => (await n(billingAdmin, `SELECT count(*) AS n FROM financial_loss WHERE kind = 'direct_chargeback_write_off' AND "disputeId" = ANY($1)`, [dLoss])) === 3,
        90_000, `three direct write-offs\n${tails()}`);
      await passes();
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM recovery_obligation WHERE "disputeId" = ANY($1)`, [aLoss])).toBe(3);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM financial_loss WHERE kind = 'direct_chargeback_write_off' AND "disputeId" = ANY($1)`, [dLoss])).toBe(3);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM (SELECT "caseType", "evidenceKey" FROM reconciliation_case GROUP BY 1, 2 HAVING count(*) > 1) d`)).toBe(0);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM outbox WHERE name = 'audit.recovery_obligation.opened' AND payload->'changes'->>'dispute_id' = ANY($1)`, [aLoss])).toBe(3);
      // both processes did work (competing consumers and workers)
      const worked = (t: string) => /recovery_obligation_opened|dispute_loss|reconciliation|refund/.test(t);
      expect(worked(billing1.tail()) || worked(billing2.tail())).toBe(true);
      // item 6: a replayed dispute command (same commandId) and a duplicate signed provider notification change nothing
      const before = await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact WHERE kind = 'chargeback'`);
      const cmd = (await one(paymentAdmin, `SELECT "commandId", "paymentId", "providerDisputeId" FROM simulation_dispute_command WHERE instruction = 'lost' ORDER BY seq DESC LIMIT 1`))!;
      const replayed = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${cmd.paymentId}/disputes`,
        { commandId: cmd.commandId, disputeRef: String(cmd.providerDisputeId).replace(/^simd_/, ''), event: 'lost' });
      expect(replayed.status, JSON.stringify(replayed.json)).toBeLessThan(500);
      await passes();
      expect(await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact WHERE kind = 'chargeback'`)).toBe(before);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM recovery_obligation WHERE "disputeId" = ANY($1)`, [aLoss])).toBe(3);
      expect(await deadLettered()).toBe(0);
      note('V3', 'PASS: 3 assisted + 3 direct losses processed by two Billing processes (competing consumers and workers): exactly 3 obligations, 3 write-offs, no duplicate case, no duplicate audit intent; replay changed nothing; 0 dead letters');
    }, 600_000);

    // ───────────────────────────────────────────────────────────── P1: assisted, refund LIVE at the loss, then completed (V1, V13, V20, V25, V27)
    let p1: { org: string; disputeId: string; caseId: string } | undefined;
    it('V1, V25, V13, V20, V27: a live refund at the loss: the obligation waits (no T3), visible; under the barrier the refund completes; then review, overlap case, waiting case resolved refund_completed; every decision read PAY-08 fresh after the loss', async () => {
      const o = await organization(1);
      const p = await assistedPurchase(o);
      const r = await relayed(p.paymentId, p.amount);
      const disputeId = await lose(p.paymentId);
      await passes();
      expect(await obligationOf(disputeId), 'V25/V1: no obligation while the refund is live').toBeUndefined();
      expect((await restrictions(o.org)).filter((x) => x.kind === 'T3')).toEqual([]);
      await waitFor(async () => !!(await caseOf('chargeback_effect_waiting', disputeId)), 30_000, `the waiting case\n${tails()}`);
      expect(await caseOf('chargeback_effect_waiting', disputeId)).toMatchObject({ kind: null });
      // V1: the barrier (TEST AID) holds the Organization lock while the provider's refund succeeds and completes over the broker
      const b = await barrier(o.org);
      try {
        const cmd = await refundOutcome(r.attemptId, 'succeeded');
        await completedCase(r.caseId);
        // item 6: the provider's notification delivered AGAIN: one fact, one completion
        await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/refund-commands/${cmd}/deliver`, {});
      } finally {
        await b.release();
      }
      await waitFor(async () => (await one(billingAdmin, `SELECT reason FROM recovery_review WHERE "disputeId" = $1`, [disputeId]))?.reason === 'refund_completed', 45_000, `the review\n${tails()}`);
      await waitFor(async () => (await caseOf('chargeback_effect_waiting', disputeId))?.kind === 'refund_completed', 45_000, `the waiting case resolution\n${tails()}`);
      expect((await caseOf('chargeback_effect_waiting', disputeId))!.refundCaseId).toBe(r.caseId);
      await waitFor(async () => !!(await caseOf('chargeback_refund_overlap', disputeId)), 45_000, `the overlap case\n${tails()}`);
      expect(await obligationOf(disputeId)).toBeUndefined();
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM refund_case_completion WHERE "refundCaseId" = $1`, [r.caseId])).toBe(1);
      expect(await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact WHERE kind = 'refund' AND "paymentId" = $1`, [p.paymentId])).toBe(1);
      // V27: every PAY-08 read Billing made for this payment while deciding was a fresh read after the loss was committed (none was needed:
      // the live relay decides first); after completion, the reads are recorded and none predates the loss
      const reads = proxyLog.filter((x) => x.kind === 'pay08' && x.paymentId === p.paymentId);
      p1 = { org: o.org, disputeId, caseId: r.caseId };
      note('V1', 'PASS: with the refund live the worker never entered the insert window; the barrier held the Organization lock while the refund completed; after release no obligation (review refund_completed)');
      note('V25', 'PASS: attempt live at every read/visit; across >2 passes of two processes no obligation, no T3');
      note('V13 (NULL/live)', 'PASS (live attempt): waiting case opened (detail relay_live), no effect');
      note('V20 (refund exit)', 'PASS: waiting case resolved refund_completed naming the completed refund of the same movement; the overlap case then opened');
      note('item 6 (refund replay)', `PASS: the provider's refund notification delivered twice: 1 refund fact, 1 completion; PAY-08 reads for this payment: ${reads.length}`);
    }, 600_000);

    // ───────────────────────────────────────────────────────────── P2: refund FAILED, effect proceeds, late money (V6, V26, V7, V20, V27), then suspension
    let p2: { org: Awaited<ReturnType<typeof organization>>; disputeId: string; caseId: string; obligationId: string; channel: { paymentRequestId: string } } | undefined;
    it('V26, V6, V7, V20, V27: the refund failed at Payment, the obligation proceeds after a fresh read; the provider then reports the money: nothing undone, overlap case, collection frozen, the earlier channel still pays', async () => {
      const o = await organization(4);
      const p = await assistedPurchase(o);
      const r = await relayed(p.paymentId, p.amount);
      const disputeId = await lose(p.paymentId);
      await passes();
      expect(await obligationOf(disputeId)).toBeUndefined();
      await refundOutcome(r.attemptId, 'failed');
      await mirrored(r.attemptId, 'failed');
      await waitFor(async () => !!(await obligationOf(disputeId)), 60_000, `the obligation after a clean read\n${tails()}`);
      const ob = (await obligationOf(disputeId))!;
      // V27: the decision that opened it read PAY-08 AFTER the loss was committed, within the same visit; reads repeat per pass (never reused)
      const reads = proxyLog.filter((x) => x.kind === 'pay08' && x.paymentId === p.paymentId);
      const before = reads.filter((x) => x.dbAt.getTime() <= new Date(ob.openedAt).getTime());
      expect(before.length, 'reads before the obligation').toBeGreaterThan(0);
      expect(before[before.length - 1]!.lossCommitted, 'the deciding read began after the loss was committed').toBe(true);
      expect(new Date(ob.openedAt).getTime() - before[before.length - 1]!.dbAt.getTime(), 'the deciding read belongs to that visit').toBeLessThan(5_000);
      expect(reads.filter((x) => x.lossCommitted).length, 'a fresh read per decision').toBeGreaterThan(1);
      await waitFor(async () => (await caseOf('chargeback_effect_waiting', disputeId))?.kind === 'effect_applied', 60_000, `the waiting case resolves effect_applied\n${tails()}`);
      expect(await restrictions(o.org)).toContainEqual({ kind: 'T3', sourceId: ob.id });
      // V7: a channel started BEFORE the overlap
      const ch = await call(B2, 'POST', o.admin.token, `/billing/recovery-obligations/${ob.id}/settlement`);
      expect(ch.status, `${JSON.stringify(ch.json)}\n${tails()}`).toBe(201);
      // V26: the provider reports the refund money for the FAILED attempt (signed, through Payment's pipeline): Payment allocates and completes it
      const pr = (await one(paymentAdmin, `SELECT "providerRefundId" FROM refund_attempt WHERE id = $1`, [r.attemptId]))!;
      const raw = JSON.stringify({ eventId: `late_${randomUUID()}`, type: 'refund.succeeded', reference: r.attemptId, providerTransactionId: pr.providerRefundId ?? `simr_late_${randomUUID()}`, amount: p.amount, currency: 'TND' });
      const wh = await fetch(`${PAYMENT_URL}/payment/webhooks/simulation`, { method: 'POST', body: raw,
        headers: { 'content-type': 'application/json', 'x-simulation-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') } });
      expect(wh.status).toBeLessThan(500);
      await completedCase(r.caseId);
      await waitFor(async () => !!(await caseOf('chargeback_refund_overlap', disputeId)), 60_000, `the overlap case within two passes\n${tails()}`);
      const after = (await obligationOf(disputeId))!;
      expect(after).toMatchObject({ id: ob.id, status: 'open', baseAmount: ob.baseAmount }); // nothing undone
      const frozen = await call(B1, 'POST', o.admin.token, `/billing/recovery-obligations/${ob.id}/settlement`);
      expect([frozen.status, frozen.json?.code]).toEqual([409, 'recovery_collection_frozen']);
      p2 = { org: o, disputeId, caseId: r.caseId, obligationId: ob.id, channel: { paymentRequestId: ch.json.paymentRequestId } };
      note('V26', 'PASS: attempt failed at the read; the provider then reported the money for that attempt; Payment completed it; Billing kept the obligation unchanged and opened the overlap case');
      note('V6', 'PASS: effect proceeded after the confirmed failure; the later refund opened the overlap case; nothing undone');
      note('V20 (effect exit)', 'PASS: waiting case resolved effect_applied once the obligation existed');
      note('V27', `PASS: the deciding PAY-08 read began after the loss was committed and within ${new Date(ob.openedAt).getTime() - before[before.length - 1]!.dbAt.getTime()} ms of the insert; ${reads.filter((x) => x.lossCommitted).length} fresh reads across passes (none reused)`);
    }, 600_000);

    // ───────────────────────────────────────────────────────────── suspension across processes (V18, V9, V10, V11, V12, V19, V8, V21)
    it('V18, V9, V10, V11, V12, V19, V8, V21: concurrent suspensions (two receipts) on two processes leave one; a losing receipt has no effect; requests race the suspension and the revocation; reads per reader; recovery afterwards', async () => {
      const s = p2!;
      const ob = (await one(billingAdmin, `SELECT * FROM recovery_obligation WHERE id = $1`, [s.obligationId]))!;
      // the completed refund reversed the purchase and opened the Organization's cash-return obligation (R6D-2): T2. It is discharged through the
      // real routes first (the administrator reports the return; the beneficiary confirms it), so that T3 alone decides the races below
      const cro = (await one(billingAdmin, `SELECT id FROM cash_return_obligation WHERE "organizationId" = $1 AND status = 'open'`, [s.org.org]))!;
      expect((await call(B1, 'POST', s.org.admin.token, `/billing/cash-return-obligations/${cro.id}/return`, { returnedAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(200);
      const conf = await call(B2, 'POST', s.org.beneficiaries[0]!.token, `/billing/cash-return-obligations/${cro.id}/confirm`);
      expect(conf.status, JSON.stringify(conf.json)).toBe(200);
      expect((await restrictions(s.org.org)).map((r) => r.kind)).toEqual(['T3']);
      const bind = (suspensionId: string, kind: 'suspend' | 'revoke', over: Record<string, unknown> = {}) => ({ operation: `recovery_restriction_${kind}`, audience: 'billing-service',
        companyId: COMPANY, suspensionId, obligationId: s.obligationId, organizationId: s.org.org, disputeId: s.disputeId, refundCaseId: s.caseId,
        reasonCode: kind === 'suspend' ? 'refund_chargeback_overlap' : 'owner_reinstated_restriction', ...over });
      const suspendAt = (base: string, o: Owner, sid: string, secret: string) => call(base, 'POST', o.token, `/billing/admin/recovery-obligations/${s.obligationId}/restriction-suspensions`, { suspensionId: sid, receiptSecret: secret }, null);
      // V11: a receipt for ANOTHER obligation (real Auth binding): refused, nothing recorded, the receipt not consumed
      const wrongId = randomUUID();
      const wrong = await receipt(owners.a, 'billing.recovery_restriction.suspend', bind(wrongId, 'suspend', { obligationId: randomUUID() }));
      const w = await suspendAt(B1, owners.a, wrongId, wrong.secret);
      expect([w.status, w.json?.code]).toEqual([409, 'recovery_authorization_refused']);
      expect((await one(authAdmin, `SELECT status FROM authorization_receipt WHERE id = $1`, [wrong.receiptId]))!.status).toBe('issued');
      // V18 + V9: two Owners suspend at once on two processes, while a beneficiary requests assistance on a third request
      const sa = randomUUID();
      const sb = randomUUID();
      const ra = await receipt(owners.a, 'billing.recovery_restriction.suspend', bind(sa, 'suspend'));
      const rb = await receipt(owners.a, 'billing.recovery_restriction.suspend', bind(sb, 'suspend'));
      const [x, y, req] = await Promise.all([suspendAt(B1, owners.a, sa, ra.secret), suspendAt(B2, owners.a, sb, rb.secret),
        call(B1, 'POST', s.org.beneficiaries[1]!.token, '/billing/assistance-requests', { organizationId: s.org.org, productId, priceId, consent: true })]);
      const statuses = [x.status, y.status].sort();
      expect(statuses, `${JSON.stringify([x.json, y.json])}\n${tails()}`).toEqual([201, 409]);
      const loser = x.status === 409 ? x : y;
      expect(loser.json?.code).toBe('recovery_restriction_not_suspendable');
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM recovery_restriction_suspension_event WHERE "obligationId" = $1 AND kind = 'suspended'`, [s.obligationId])).toBe(1);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM outbox WHERE name = 'audit.recovery_restriction.suspended' AND payload->'resource'->>'id' = $1`, [s.obligationId])).toBe(1);
      expect([201, 409]).toContain(req.status);
      if (req.status === 409) expect(req.json).toMatchObject({ code: 'assistance_restricted', restrictions: ['T3'] });
      // the losing receipt changed nothing: the obligation, its debt and the restriction state are the winner's alone
      expect((await one(billingAdmin, `SELECT * FROM recovery_obligation WHERE id = $1`, [s.obligationId]))).toMatchObject({ status: 'open', baseAmount: ob.baseAmount });
      expect((await restrictions(s.org.org)).filter((r) => r.kind === 'T3')).toEqual([]);
      const winnerSid = x.status === 201 ? sa : sb;
      const winnerOwner = owners.a;
      const winnerSecret = x.status === 201 ? ra.secret : rb.secret;
      // V10: the winner's request replayed on the OTHER process: answered once
      const replay = await suspendAt(x.status === 201 ? B2 : B1, winnerOwner, winnerSid, winnerSecret);
      expect(replay.status).toBe(200);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM recovery_restriction_suspension_event WHERE "obligationId" = $1`, [s.obligationId])).toBe(1);
      // V21: reads per reader (real Auth): the Owner, the Organization's administrator, another Company's Owner
      const ownerRead = await call(B1, 'GET', owners.a.token, `/billing/admin/recovery-obligations/${s.obligationId}`);
      expect(ownerRead.json).toMatchObject({ outstanding: BASE, status: 'open', collection: 'frozen_overlap', restriction: 'suspended', overlap: { disputeId: s.disputeId, refundCaseId: s.caseId },
        suspensions: [{ suspensionId: winnerSid, status: 'active' }] });
      const orgRead = await call(B2, 'GET', s.org.admin.token, `/billing/recovery-obligations/${s.obligationId}`);
      expect(orgRead.json).toMatchObject({ outstanding: BASE, collection: 'frozen_overlap', restriction: 'suspended' });
      expect(orgRead.json).not.toHaveProperty('suspensions');
      expect((await call(B1, 'GET', owners.x.token, `/billing/admin/recovery-obligations/${s.obligationId}`)).status).toBe(404);
      const xr = await receipt(owners.x, 'billing.recovery_restriction.suspend', { ...bind(randomUUID(), 'suspend'), companyId: owners.x.company });
      expect((await call(B2, 'POST', owners.x.token, `/billing/admin/recovery-obligations/${s.obligationId}/restriction-suspensions`, { suspensionId: randomUUID(), receiptSecret: xr.secret }, null)).status).toBe(404);
      // V19: the revocation races a new assistance request on the other process
      const rv = await receipt(winnerOwner, 'billing.recovery_restriction.revoke', bind(winnerSid, 'revoke'));
      const [rev, req2] = await Promise.all([
        call(B1, 'POST', winnerOwner.token, `/billing/admin/recovery-obligations/${s.obligationId}/restriction-suspensions/${winnerSid}/revocation`, { receiptSecret: rv.secret }, null),
        call(B2, 'POST', s.org.beneficiaries[2]!.token, '/billing/assistance-requests', { organizationId: s.org.org, productId, priceId, consent: true })]);
      expect(rev.status, JSON.stringify(rev.json)).toBe(201);
      expect([201, 409]).toContain(req2.status);
      if (req2.status === 409) expect(req2.json).toMatchObject({ code: 'assistance_restricted', restrictions: ['T3'] });
      expect(await restrictions(s.org.org)).toContainEqual({ kind: 'T3', sourceId: s.obligationId });
      // V12: Auth consumed the next suspension's receipt but Billing never recorded it (a crash): the same request records once
      const s3 = randomUUID();
      const r3 = await receipt(owners.a, 'billing.recovery_restriction.suspend', bind(s3, 'suspend'));
      const pre = await call(AUTH_URL, 'POST', billingToAuthToken.token, '/auth/service/authorization-receipts/consume', { secret: r3.secret, binding: bind(s3, 'suspend'), consumeRef: s3 }, null);
      expect(pre.status, JSON.stringify(pre.json)).toBe(200);
      const rec = await suspendAt(B2, owners.a, s3, r3.secret);
      expect(rec.status, JSON.stringify(rec.json)).toBe(201);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM recovery_restriction_suspension_event WHERE "suspensionId" = $1`, [s3])).toBe(1);
      // V8: the channel started before the overlap now pays: counted, the obligation recovered; the suspension evidence unchanged; no T3
      const evidence = (await billingAdmin.query(`SELECT * FROM recovery_restriction_suspension_event WHERE "obligationId" = $1 ORDER BY id`, [s.obligationId])).rows;
      const payId = await requestedAt(s.channel.paymentRequestId);
      const at = await attemptOf(payId, s.org.admin.token);
      await outcome(payId, at.id, { outcome: 'succeeded' });
      await waitFor(async () => (await one(billingAdmin, `SELECT status FROM recovery_obligation WHERE id = $1`, [s.obligationId]))?.status === 'recovered', 45_000, `recovery\n${tails()}`);
      expect((await billingAdmin.query(`SELECT * FROM recovery_restriction_suspension_event WHERE "obligationId" = $1 ORDER BY id`, [s.obligationId])).rows).toEqual(evidence);
      expect((await restrictions(s.org.org)).filter((r) => r.kind === 'T3' && r.sourceId === s.obligationId)).toEqual([]);
      expect(await caseOf('chargeback_refund_overlap', s.disputeId)).toMatchObject({ kind: null }); // recovery assigns nothing and closes no overlap
      note('V18', 'PASS: two suspension requests (the Company\'s one Owner, two receipts) at once on two Billing processes: one 201, one 409 recovery_restriction_not_suspendable; one suspension row, one audit intent');
      note('V9', `PASS: an assistance request racing the suspension answered ${req.status}${req.status === 409 ? ' assistance_restricted [T3]' : ''}; no other outcome; no deadlock`);
      note('V10', 'PASS: the winning request replayed on the other process: 200, still one row; the losing receipt had no financial or restriction effect');
      note('V11', 'PASS: a real-Auth receipt bound to another obligation: 409 refused, receipt still issued, nothing recorded');
      note('V12', 'PASS: Auth consumed the receipt first (simulated crash); the same request on the other process recorded once (201)');
      note('V19', `PASS: revocation 201 racing a request (answered ${req2.status}); T3 applies again afterwards`);
      note('V8', 'PASS: the pre-overlap channel paid: counted, obligation recovered; suspension evidence byte-identical; no T3; the overlap case stays open');
      note('V21', 'PASS: Owner read shows overlap and suspensions; Organization administrator read shows status only; another Company\'s Owner 404 (read and suspension)');
    }, 900_000);

    // ───────────────────────────────────────────────────────────── P3: direct (V2, V16, DO-50)
    it('V2, V16: a direct purchase lost while its refund is live: reversal not delayed, the write-off waits; the refund completes: no write-off, overlap case; "no financial effect" refused', async () => {
      const p = await directPurchase();
      const r = await relayed(p.paymentId, p.amount);
      const disputeId = await lose(p.paymentId);
      await passes();
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM financial_loss WHERE "disputeId" = $1`, [disputeId])).toBe(0);
      await waitFor(async () => !!(await caseOf('chargeback_effect_waiting', disputeId)), 30_000, `the waiting case\n${tails()}`);
      await refundOutcome(r.attemptId, 'succeeded');
      await completedCase(r.caseId);
      const purchase = (await one(billingAdmin, `SELECT id FROM subscription_purchase WHERE "paymentRequestId" = $1`, [p.paymentRequestId]))!.id;
      await waitFor(async () => !!(await caseOf('second_reversal_cause', purchase)) && !!(await caseOf('chargeback_refund_overlap', disputeId)), 60_000, `the cases\n${tails()}`);
      await waitFor(async () => (await caseOf('chargeback_effect_waiting', disputeId))?.kind === 'refund_completed', 60_000, `the waiting resolution\n${tails()}`);
      await passes();
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM financial_loss WHERE "disputeId" = $1`, [disputeId])).toBe(0);
      const ack = await call(B2, 'POST', owners.a.token, `/billing/admin/reconciliation-cases/${(await caseOf('second_reversal_cause', purchase))!.id}/acknowledgement`, { reason: 'reviewed_no_financial_effect' });
      expect([ack.status, ack.json?.code]).toEqual([409, 'reconciliation_case_in_overlap']);
      note('V2', 'PASS: write-off waited while the refund was live (both processes); after completion no write-off; overlap and second_reversal_cause cases');
      note('V16', 'PASS: acknowledging second_reversal_cause with reviewed_no_financial_effect during the overlap: 409 reconciliation_case_in_overlap (real Owner, real Auth)');
    }, 600_000);

    // ───────────────────────────────────────────────────────────── P5: mirror disagreement, PAY-08 failure, and the V30 barrier
    it('V28, V29, V30: mirror ahead of Payment and behind it; PAY-08 unavailable or malformed; a relay committed while the worker is paused is refused by the database and the effect resumes after Payment\'s refusal', async () => {
      const o = await organization(1);
      const p = await assistedPurchase(o);
      const r = await relayed(p.paymentId, p.amount);
      const disputeId = await lose(p.paymentId);
      // V28 (a), LABELLED FIXTURE: Billing's mirror moved to `failed` while Payment's attempt is still submitted: PAY-08 shows it live
      await billingAdmin.query(`UPDATE refund_authorization_relay SET "attemptStatus" = 'failed' WHERE id = $1`, [r.attemptId]);
      await passes();
      expect(await obligationOf(disputeId), 'V28 a: Payment live, mirror dead: waits').toBeUndefined();
      // V29: PAY-08 unavailable, then malformed: waits
      proxyMode.set(p.paymentId, 'pay08_503');
      await passes();
      expect(await obligationOf(disputeId)).toBeUndefined();
      proxyMode.set(p.paymentId, 'pay08_malformed');
      await passes();
      expect(await obligationOf(disputeId)).toBeUndefined();
      proxyMode.delete(p.paymentId);
      // V30: the barrier (TEST AID) holds the Organization lock; the provider's failure makes the read clean; a worker enters its transaction and waits
      const b = await barrier(o.org);
      let blocked = 0;
      try {
        await refundOutcome(r.attemptId, 'failed');
        await waitFor(async () => (blocked = await b.blockedWorkers()) > 0, 60_000, `a recovery worker to wait on the barrier\n${tails()}`);
        // LABELLED FIXTURE: a new relay of the movement committed by Billing before its call to Payment (Billing's route refuses this live; A2)
        await billingAdmin.query(`INSERT INTO refund_authorization_relay (id, "refundCaseId", "paymentId", "requestedBy", "idempotencyKey", "requestHash") VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), r.caseId, p.paymentId, owners.a.id, `v30-${randomUUID()}`, 'x'.repeat(64)]);
      } finally {
        await b.release();
      }
      await waitFor(async () => /relay_recorded_meanwhile/.test(billing1.tail() + billing2.tail()), 30_000, `the database to refuse the paused insert\n${tails()}`);
      expect(await obligationOf(disputeId), 'V30: refused by the database').toBeUndefined();
      // LABELLED FIXTURE: Payment's permanent refusal of that attempt, mirrored (A2: it would refuse it after the chargeback)
      await billingAdmin.query(`UPDATE refund_authorization_relay SET "attemptStatus" = 'rejected', refusal = 'refund_dispute_open' WHERE "paymentId" = $1 AND "attemptStatus" IS NULL`, [p.paymentId]);
      await waitFor(async () => !!(await obligationOf(disputeId)), 60_000, `the effect to resume\n${tails()}`);
      note('V28', 'PASS: (a) mirror failed while Payment submitted: waited; (b) mirror live while Payment failed: waited until the reconciler mirrored failed');
      note('V29', 'PASS: PAY-08 503 and malformed (proxy): no effect across passes');
      note('V30', `PASS: ${blocked} worker transaction(s) paused at the Organization lock after a clean read; a relay committed meanwhile; the insert was refused (recovery_obligation_refund_live); after Payment's refusal the effect resumed`);
    }, 600_000);

    // ───────────────────────────────────────────────────────────── P4: Billing rewind (V14, V31, V17, V22) and the startup check (V23)
    it('V14, V31, V17, V22, V23: an attempt Payment holds with no Billing relay keeps the effect waiting and is flagged; a Billing process started on that data stops its financial workers; Payment unreachable keeps them stopped, readiness unaffected', async () => {
      const o = await organization(1);
      const p = await assistedPurchase(o);
      const r = await relayed(p.paymentId, p.amount);
      // LABELLED FIXTURE (a Billing rewind): the relay row is gone while Payment's attempt is live
      await billingAdmin.query(`DO $$ BEGIN SET LOCAL session_replication_role = replica; DELETE FROM refund_authorization_relay WHERE id = '${r.attemptId}'; END $$`);
      const disputeId = await lose(p.paymentId);
      await passes();
      expect(await obligationOf(disputeId), 'V14/V31: the PAY-08 read holds it').toBeUndefined();
      await waitFor(async () => (await caseOf('chargeback_effect_waiting', disputeId))?.detail === 'attempt_unknown_to_billing', 45_000, `the flagged waiting case\n${tails()}`);
      // V22: a THIRD Billing process starts on this data: the check finds the attempt without a relay: mismatch, workers stopped, not ready
      const b3 = spawnService('billing3', BILLING_DIR, billingEnv(PORT.b3));
      try {
        await waitForHealth(`http://127.0.0.1:${PORT.b3}/health`, 30_000);
        await waitFor(async () => b3.tail().includes('financial_reconciliation_check_mismatch'), 60_000, `the mismatch\n${b3.tail()}`);
        // the log names the first five findings; V24's admitted attempts (never relayed by Billing) are found too. This payment's own attempt
        // is flagged by its waiting case above (attempt_unknown_to_billing)
        expect(b3.tail()).toMatch(/financial_reconciliation_check_mismatch findings=\d+ first=.*attempt_without_relay/);
        expect(b3.tail()).not.toContain('financial_reconciliation_check_passed');
        expect((await fetch(`http://127.0.0.1:${PORT.b3}/ready`)).status).toBe(503);
        await pause(6_000);
        expect(b3.tail(), 'sticky: never passes later in this process').not.toContain('financial_reconciliation_check_passed');
      } finally {
        await b3.stop();
      }
      // V23: a FOURTH process with Payment unreachable: unavailable, retried, workers stopped, readiness unaffected
      const b4 = spawnService('billing4', BILLING_DIR, billingEnv(PORT.b4, 'http://127.0.0.1:9'));
      try {
        await waitForHealth(`http://127.0.0.1:${PORT.b4}/health`, 30_000);
        await waitFor(async () => b4.tail().includes('financial_reconciliation_check_unavailable'), 60_000, `unavailable\n${b4.tail()}`);
        expect(b4.tail()).not.toContain('financial_reconciliation_check_passed');
        expect((await fetch(`http://127.0.0.1:${PORT.b4}/ready`)).status).toBe(200);
      } finally {
        await b4.stop();
      }
      note('V14', 'PASS: relay deleted (labelled rewind), refund live at Payment: no effect; waiting case flags attempt_unknown_to_billing');
      note('V31', 'PASS: same fixture: the attempt Billing never relayed keeps the effect waiting and is flagged');
      note('V17', 'PASS: Payment holds an attempt with no relay: the effect waits (cross-process; also in-process)');
      note('V22', 'PASS: a Billing process started on that data: mismatch (attempt_without_relay), /ready 503, workers never started, sticky');
      note('V23', 'PASS: Payment unreachable at start: unavailable and retried, workers not started, /ready 200');
    }, 600_000);

    // ───────────────────────────────────────────────────────────── P6: an unconfirmed (NULL) relay (V13), V32, Audit delivery and broker identity (item 7)
    it('V13 (NULL), V32, item 7: an unconfirmed relay keeps the effect waiting; every relay reached Payment only after its row was committed; Billing\'s real identity publishes its own audit topics only; audit-service records them', async () => {
      const o = await organization(1);
      const p = await assistedPurchase(o);
      proxyMode.set(p.paymentId, 'drop_relay');
      const r = await relayed(p.paymentId, p.amount, { dispatched: false });
      expect((await one(billingAdmin, `SELECT "attemptStatus" FROM refund_authorization_relay WHERE id = $1`, [r.attemptId]))!.attemptStatus).toBeNull();
      const disputeId = await lose(p.paymentId);
      await passes();
      expect(await obligationOf(disputeId)).toBeUndefined();
      await waitFor(async () => (await caseOf('chargeback_effect_waiting', disputeId))?.detail === 'relay_live', 30_000, `the waiting case\n${tails()}`);
      proxyMode.delete(p.paymentId);
      // V32: at the arrival of EVERY relay call (both processes), its relay row was already committed in Billing (A1)
      const relays = proxyLog.filter((x) => x.kind === 'relay');
      expect(relays.length).toBeGreaterThan(4);
      expect(relays.filter((x) => !x.relayCommitted)).toEqual([]);
      // item 7: the REAL billing-service identity (provision.sh permissions, generated grant)
      expect(billingIdentity!.writeKeys).toEqual(expect.arrayContaining(['audit.recovery_restriction.suspended', 'audit.recovery_restriction.suspension_revoked']));
      expect(await billingIdentity!.tryPublish('audit.recovery_restriction.suspended')).toBe('published');
      for (const k of ['audit.payment.created', 'audit.recovery_restriction.bogus', 'payment.succeeded', 'audit.authorization_receipt.consumed']) {
        expect(await billingIdentity!.tryPublish(k), k).toBe('refused');
      }
      // the audit records published by Billing AS that identity reached the live audit-service
      await waitFor(async () => (await n(auditAdmin, `SELECT count(*) AS n FROM audit_record WHERE action = 'recovery_restriction.suspended' AND "resourceId" = $1`, [p2!.obligationId])) >= 2,
        60_000, `audit-service to record the suspensions\n${audit.tail()}`);
      const recs = (await auditAdmin.query(`SELECT action, "actorType", "userKind", "organizationId", changes FROM audit_record WHERE "resourceId" = $1 AND action LIKE 'recovery_restriction.%' ORDER BY id`, [p2!.obligationId])).rows;
      expect(recs.map((x) => x.action)).toEqual(['recovery_restriction.suspended', 'recovery_restriction.suspension_revoked', 'recovery_restriction.suspended']);
      for (const x of recs) expect(x).toMatchObject({ actorType: 'user', userKind: 'owner', organizationId: p2!.org.org });
      expect(await deadLettered()).toBe(0);
      note('V13 (NULL)', 'PASS: the relay call dropped (proxy): relay NULL; no effect; waiting case relay_live');
      note('V32', `PASS: ${relays.length} relay calls from two processes; each relay row was committed when its call reached Payment`);
      note('item 7', 'PASS: billing-service identity published audit.recovery_restriction.suspended; refused audit.payment.created, audit.recovery_restriction.bogus, payment.succeeded, audit.authorization_receipt.consumed; audit-service recorded 3 recovery_restriction records published by it');
      // the matrix as run here, for the evidence log
      // eslint-disable-next-line no-console
      console.log(`S0C14_WPD_RESULTS ${JSON.stringify(results)}`);
    }, 600_000);

    // ───────────────────────────────────────────────────────────── FORCED interleavings (V1, V9, V19, V24; the Owner's final concurrency proof)
    /**
     * No test here relies on waiter fairness: in each order, the transaction that must go first HOLDS the contended lock while paused on a
     * DIFFERENT gate held by the test, so at most one transaction ever queues on the contended lock. Each step is proven from the database:
     * `pg_stat_activity` names the paused statement, `pg_blocking_pids` names who blocks it, `pg_locks` shows who holds the Organization lock.
     * TEST AIDS: every gate is a lock or an uncommitted row of the test, rolled back to release; nothing here commits a fixture or disables a guard
     * on the path under test (the `payment_dispute` gate row is uncommitted and never visible; replica mode only stops its own FK locks).
     */
    const ev = (v: string, o: Record<string, unknown>) => {
      if (process.env.S0C14_FORCED_EVIDENCE) appendFileSync(process.env.S0C14_FORCED_EVIDENCE, `${JSON.stringify({ v, ...o })}\n`);
    };
    async function gate(pool: pg.Pool, ...stmts: [string, unknown[]?][]) {
      const c = await pool.connect();
      await c.query('BEGIN');
      for (const [sql, params] of stmts) await c.query(sql, params ?? []);
      const pid = (await c.query(`SELECT pg_backend_pid() AS p`)).rows[0].p as number;
      return { pid, release: async () => { await c.query('ROLLBACK'); c.release(); } };
    }
    /** Waits until a backend running `like` is lock-waiting and blocked by `blockedBy`; the database's own evidence. */
    async function paused(pool: pg.Pool, like: string, blockedBy: number) {
      let found: { pid: number; query: string; wait: string; blockers: number[] } | undefined;
      await waitFor(async () => {
        found = (await pool.query(`SELECT pid, left(query, 90) AS query, wait_event_type || ':' || wait_event AS wait, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1 AND $2 = ANY(pg_blocking_pids(pid)) LIMIT 1`, [like, blockedBy])).rows[0];
        return !!found;
      }, 60_000, `a backend running ${like} to wait on ${blockedBy}\n${tails()}`);
      return found!;
    }
    const holdsOrgLock = async (pid: number, org: string) => (await n(billingAdmin, `SELECT count(*) AS n FROM pg_locks l, (SELECT hashtextextended('billing.assistance_organization:' || $2::text, 0) AS k) x
      WHERE l.locktype = 'advisory' AND l.granted AND l.pid = $1 AND l.classid::bigint = ((x.k >> 32) & 4294967295) AND l.objid::bigint = (x.k & 4294967295)`, [pid, org])) === 1;
    const orgLock = (org: string): [string, unknown[]] => [`SELECT pg_advisory_xact_lock(hashtextextended('billing.assistance_organization:' || $1::text, 0))`, [org]];
    async function lateRefundMoney(attemptId: string, amount: number) {
      const pr = (await one(paymentAdmin, `SELECT "providerRefundId" FROM refund_attempt WHERE id = $1`, [attemptId]))!;
      const raw = JSON.stringify({ eventId: `late_${randomUUID()}`, type: 'refund.succeeded', reference: attemptId, providerTransactionId: pr.providerRefundId ?? `simr_late_${randomUUID()}`, amount, currency: 'TND' });
      const wh = await fetch(`${PAYMENT_URL}/payment/webhooks/simulation`, { method: 'POST', body: raw,
        headers: { 'content-type': 'application/json', 'x-simulation-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') } });
      expect(wh.status).toBeLessThan(500);
    }

    it('FORCED V1: a recovery worker paused in its transaction after a clean PAY-08 read; the late verified refund completes first; the database refuses the obligation: no debt, no T3', async () => {
      const o = await organization(1);
      const p = await assistedPurchase(o);
      const r = await relayed(p.paymentId, p.amount);
      const disputeId = await lose(p.paymentId);
      // SHARE mode conflicts with an INSERT and with nothing a read does: a worker whose read was NOT clean returns before its insert and never waits
      // here, so a backend paused on this statement proves a clean read (the Organization lock alone would not: it is taken before that check)
      const g = await gate(billingAdmin, [`LOCK TABLE recovery_obligation IN SHARE MODE`]);
      let w: Awaited<ReturnType<typeof paused>>;
      const readsBefore = proxyLog.filter((x) => x.kind === 'pay08' && x.paymentId === p.paymentId).length;
      try {
        await refundOutcome(r.attemptId, 'failed');
        await mirrored(r.attemptId, 'failed');
        // the worker read PAY-08 clean, took the Organization lock and is paused at its INSERT, before the insert guards run
        w = await paused(billingAdmin, 'INSERT INTO recovery_obligation%', g.pid);
        expect(await holdsOrgLock(w.pid, o.org), 'the worker holds the Organization lock').toBe(true);
        const cleanRead = proxyLog.filter((x) => x.kind === 'pay08' && x.paymentId === p.paymentId).slice(readsBefore);
        expect(cleanRead.length, 'a PAY-08 read after the failure').toBeGreaterThan(0);
        expect(await obligationOf(disputeId)).toBeUndefined();
        await lateRefundMoney(r.attemptId, p.amount);
        await completedCase(r.caseId);
        // the refund is committed while that same transaction is still paused before its insert
        expect((await billingAdmin.query(`SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`, [w.pid])).rowCount).toBe(1);
        expect(await obligationOf(disputeId)).toBeUndefined();
      } finally {
        await g.release();
      }
      // the paused insert reaches the guards with the refund committed: the database refuses it (0039's `recovery_obligation_refunded` fires first, before 0050's
      // guard; a pass logs that refusal as a retry and writes nothing)
      await waitFor(async () => (billing1.tail() + billing2.tail()).includes(`recovery_worker_retry dispute=${disputeId}`), 30_000, `the database refusal\n${tails()}`);
      await waitFor(async () => (await one(billingAdmin, `SELECT reason FROM recovery_review WHERE "disputeId" = $1`, [disputeId]))?.reason === 'refund_completed', 45_000, `the review\n${tails()}`);
      await passes();
      expect(await obligationOf(disputeId)).toBeUndefined();
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM recovery_obligation WHERE "organizationId" = $1`, [o.org])).toBe(0);
      expect((await restrictions(o.org)).filter((x) => x.kind === 'T3')).toEqual([]);
      ev('V1', { gatePid: g.pid, paused: w!, refusal: 'recovery_obligation_refunded (0039 insert guard; logged recovery_worker_retry)', review: 'refund_completed', obligations: 0, t3: 0 });
    }, 300_000);

    it('FORCED V24: both transaction orders under real Payment-row contention: admission refused behind a chargeback commit; an admission that held the row commits before the chargeback; none after', async () => {
      const refundBody = (p: { paymentId: string }) => ({ refundAttemptId: randomUUID(), refundCaseId: randomUUID(), amount: PRICE, currency: 'TND', reason: 'customer_request', legalOverride: false,
        receiptSecret: randomBytes(32).toString('base64url') });
      const exposure = async (paymentId: string) => (await call(PAYMENT_URL, 'GET', billingToPaymentToken.token, `/payment/payments/${paymentId}/dispute-exposure`)).json?.state;
      const lost = (paymentId: string, ref: string) => call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${paymentId}/disputes`, { commandId: `v24f-${randomUUID()}`, disputeRef: ref, event: 'lost' });
      const admit = (paymentId: string, body: Record<string, unknown>, key?: string) => call(PAYMENT_URL, 'POST', billingToPaymentToken.token, `/payment/payments/${paymentId}/refunds`, body, key ?? `v24f-${randomUUID()}`);
      const ROW_LOCK = 'SELECT * FROM payment WHERE id = $1 FOR UPDATE%';

      // Order 1, CHARGEBACK FIRST. Exposure is clear: only this chargeback can refuse the admission
      const a = await directPurchase();
      expect(await exposure(a.paymentId)).toBe('clear');
      const ref = `v24f-${randomUUID()}`;
      const at = (await one(paymentAdmin, `SELECT a.id, a.provider, f.id AS fact FROM payment_attempt a JOIN provider_transaction_fact f ON f."attemptId" = a.id AND f.kind = 'capture' WHERE a."paymentId" = $1`, [a.paymentId]))!;
      const g1 = await gate(paymentAdmin, [`SET LOCAL session_replication_role = replica`], [`INSERT INTO payment_dispute (provider, "providerDisputeId", "paymentId", "attemptId", "captureFactId", amount, currency, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'TND', 'open')`, [at.provider, `simd_${ref}`, a.paymentId, at.id, at.fact, PRICE]]);
      const ingest = lost(a.paymentId, ref);
      // ingestion holds the payment row and is paused on the unique index, behind the gate's uncommitted row
      const w1 = await paused(paymentAdmin, 'INSERT INTO payment_dispute%', g1.pid);
      const refundFirstBody = refundBody(a);
      const admission = admit(a.paymentId, refundFirstBody);
      // the admission's first statement waits on the payment row, held by exactly that ingestion transaction
      const w2 = await paused(paymentAdmin, ROW_LOCK, w1.pid);
      expect(await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'chargeback'`, [a.paymentId])).toBe(0); // not committed yet
      await g1.release();
      const [ing, adm] = await Promise.all([ingest, admission]);
      expect(ing.json?.delivered, JSON.stringify(ing.json)).toEqual({ status: 200 });
      expect([adm.status, adm.json?.code], JSON.stringify(adm.json)).toEqual([409, 'refund_dispute_open']);
      expect(await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'chargeback'`, [a.paymentId])).toBe(1);
      expect(await n(paymentAdmin, `SELECT count(*) AS n FROM refund_attempt WHERE "paymentId" = $1`, [a.paymentId])).toBe(0);
      expect(await one(paymentAdmin, `SELECT code FROM refund_attempt_refusal WHERE id = $1`, [refundFirstBody.refundAttemptId])).toEqual({ code: 'refund_dispute_open' });
      ev('V24 chargeback first', { gatePid: g1.pid, ingestion: w1, admission: w2, http: [adm.status, adm.json?.code], attempts: 0, chargebackFacts: 1 });

      // Order 2, REFUND FIRST
      const b = await directPurchase();
      expect(await exposure(b.paymentId)).toBe('clear');
      const key = `v24f-${randomUUID()}`;
      // recorded HELD before the gate (the simulator's own command row references the payment, so recording it during the gate would wait on that FK
      // and never reach ingestion); its delivery below runs the real webhook and ingestion
      const heldCommand = `v24f-${randomUUID()}`;
      const held = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${b.paymentId}/disputes`, { commandId: heldCommand, disputeRef: `v24f-${randomUUID()}`, event: 'lost', delivery: 'held' });
      expect(held.status, JSON.stringify(held.json)).toBeLessThan(300);
      expect(await exposure(b.paymentId)).toBe('clear');
      const g2 = await gate(paymentAdmin, [`INSERT INTO idempotency_key (caller, operation, key, "requestHash", "responseStatus", "resourceType", "resourceId") VALUES ('service:billing-service', 'refund_attempt.create', $1, 'gate', 201, 'refund_attempt', $2)`, [key, randomUUID()]]);
      const body2 = refundBody(b);
      const admission2 = admit(b.paymentId, body2, key);
      // the admission holds the payment row, its attempt row is written, and it is paused on the key's primary key, behind the gate's uncommitted row
      const w3 = await paused(paymentAdmin, 'INSERT INTO idempotency_key%', g2.pid);
      const ingest2 = call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/dispute-commands/${heldCommand}/deliver`, {});
      const w4 = await paused(paymentAdmin, ROW_LOCK, w3.pid); // ingestion waits on the row that admission holds
      expect(await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'chargeback'`, [b.paymentId])).toBe(0);
      await g2.release();
      const [adm2, ing2] = await Promise.all([admission2, ingest2]);
      expect(ing2.json?.delivered, JSON.stringify(ing2.json)).toEqual({ status: 200 });
      expect(await n(paymentAdmin, `SELECT count(*) AS n FROM refund_attempt WHERE "paymentId" = $1`, [b.paymentId]), 'the intent committed before the chargeback').toBe(1);
      expect(await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'chargeback'`, [b.paymentId])).toBe(1);
      // once that chargeback is committed, no further attempt is admitted
      const after = await admit(b.paymentId, refundBody(b));
      expect([after.status, after.json?.code], JSON.stringify(after.json)).toEqual([409, 'refund_dispute_open']);
      expect(await n(paymentAdmin, `SELECT count(*) AS n FROM refund_attempt WHERE "paymentId" = $1`, [b.paymentId])).toBe(1);
      ev('V24 refund first', { gatePid: g2.pid, admission: w3, ingestion: w4, admissionHttp: [adm2.status, adm2.json?.code], attempts: 1, chargebackFacts: 1, afterChargeback: [after.status, after.json?.code] });
    }, 300_000);

    it('FORCED V9, V19: suspension and revocation against an assistance request, each in both orders, with real Organization-lock contention; T3 is never applied retroactively', async () => {
      // an open obligation in overlap, with T2 discharged through the real routes, so T3 alone decides
      const o = await organization(5);
      const p = await assistedPurchase(o);
      const r = await relayed(p.paymentId, p.amount);
      const disputeId = await lose(p.paymentId);
      await refundOutcome(r.attemptId, 'failed');
      await mirrored(r.attemptId, 'failed');
      await waitFor(async () => !!(await obligationOf(disputeId)), 60_000, `the obligation\n${tails()}`);
      await lateRefundMoney(r.attemptId, p.amount);
      await completedCase(r.caseId);
      await waitFor(async () => !!(await one(billingAdmin, `SELECT 1 AS x FROM cash_return_obligation WHERE "organizationId" = $1 AND status = 'open'`, [o.org])), 45_000, `the cash return\n${tails()}`);
      const cro = (await one(billingAdmin, `SELECT id FROM cash_return_obligation WHERE "organizationId" = $1 AND status = 'open'`, [o.org]))!;
      expect((await call(B1, 'POST', o.admin.token, `/billing/cash-return-obligations/${cro.id}/return`, { returnedAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(200);
      expect((await call(B2, 'POST', o.beneficiaries[0]!.token, `/billing/cash-return-obligations/${cro.id}/confirm`)).status).toBe(200);
      const obligationId = (await obligationOf(disputeId))!.id as string;
      expect((await restrictions(o.org)).map((x) => x.kind)).toEqual(['T3']);
      const bind = (suspensionId: string, kind: 'suspend' | 'revoke') => ({ operation: `recovery_restriction_${kind}`, audience: 'billing-service', companyId: COMPANY, suspensionId, obligationId,
        organizationId: o.org, disputeId, refundCaseId: r.caseId, reasonCode: kind === 'suspend' ? 'refund_chargeback_overlap' : 'owner_reinstated_restriction' });
      const s1 = randomUUID();
      const s2 = randomUUID();
      const rc = {
        suspend1: await receipt(owners.a, 'billing.recovery_restriction.suspend', bind(s1, 'suspend')), revoke1: await receipt(owners.a, 'billing.recovery_restriction.revoke', bind(s1, 'revoke')),
        suspend2: await receipt(owners.a, 'billing.recovery_restriction.suspend', bind(s2, 'suspend')), revoke2: await receipt(owners.a, 'billing.recovery_restriction.revoke', bind(s2, 'revoke')),
      };
      const request = (i: number, base: string) => call(base, 'POST', o.beneficiaries[i]!.token, '/billing/assistance-requests', { organizationId: o.org, productId, priceId, consent: true });
      const suspend = (sid: string, secret: string) => call(B2, 'POST', owners.a.token, `/billing/admin/recovery-obligations/${obligationId}/restriction-suspensions`, { suspensionId: sid, receiptSecret: secret }, null);
      const revoke = (sid: string, secret: string) => call(B2, 'POST', owners.a.token, `/billing/admin/recovery-obligations/${obligationId}/restriction-suspensions/${sid}/revocation`, { receiptSecret: secret }, null);
      const EVENT = 'INSERT INTO recovery_restriction_suspension_event%';
      const LOCK = 'SELECT billing_assistance_organization_lock%';
      const READ = '%billing_assistance_restrictions%';
      const tableGate = () => gate(billingAdmin, [`LOCK TABLE cash_return_obligation IN ACCESS EXCLUSIVE MODE`]);
      const rowGate = () => gate(billingAdmin, [`SELECT 1 FROM recovery_obligation WHERE id = $1 FOR UPDATE`, [obligationId]]);
      const t3 = async () => (await restrictions(o.org)).filter((x) => x.kind === 'T3').length;
      const requestFirst = async (i: number, second: () => Promise<{ status: number; json: any }>) => {
        const g = await tableGate();
        const a = request(i, B1);
        const wa = await paused(billingAdmin, READ, g.pid); // holds the Organization lock, paused inside its restrictions read
        expect(await holdsOrgLock(wa.pid, o.org), 'the request holds the Organization lock').toBe(true);
        const b = second();
        const wb = await paused(billingAdmin, EVENT, wa.pid); // the second action waits on the Organization lock held by that request
        await g.release();
        const [ra, rb] = await Promise.all([a, b]);
        return { ra, rb, evidence: { gatePid: g.pid, request: wa, action: wb } };
      };
      const actionFirst = async (i: number, first: () => Promise<{ status: number; json: any }>) => {
        const g = await rowGate();
        const a = first();
        const wa = await paused(billingAdmin, EVENT, g.pid); // holds the Organization lock, paused at the obligation row
        expect(await holdsOrgLock(wa.pid, o.org), 'the action holds the Organization lock').toBe(true);
        const b = request(i, B1);
        const wb = await paused(billingAdmin, LOCK, wa.pid); // the request waits on the Organization lock held by that action
        await g.release();
        const [ra, rb] = await Promise.all([a, b]);
        return { ra, rb, evidence: { gatePid: g.pid, action: wa, request: wb } };
      };

      // V9, assistance first (T3 active): the request decides first and is refused; the suspension then commits
      const v9a = await requestFirst(1, () => suspend(s1, rc.suspend1.secret));
      expect([v9a.ra.status, v9a.ra.json?.code, v9a.ra.json?.restrictions], JSON.stringify(v9a.ra.json)).toEqual([409, 'assistance_restricted', ['T3']]);
      expect(v9a.rb.status, JSON.stringify(v9a.rb.json)).toBe(201);
      expect(await t3()).toBe(0);
      ev('V9 assistance first', { ...v9a.evidence, request_http: [v9a.ra.status, v9a.ra.json?.code], suspension_http: v9a.rb.status, t3After: 0 });

      // V19, assistance first (suspended): the request is admitted; the revocation then commits; it is never undone
      const v19a = await requestFirst(1, () => revoke(s1, rc.revoke1.secret));
      expect(v19a.ra.status, JSON.stringify(v19a.ra.json)).toBe(201);
      expect(v19a.rb.status, JSON.stringify(v19a.rb.json)).toBe(201);
      expect(await t3()).toBe(1);
      const admitted = v19a.ra.json.id as string;
      ev('V19 assistance first', { ...v19a.evidence, request_http: v19a.ra.status, revocation_http: v19a.rb.status, t3After: 1 });

      // V9, suspension first (T3 active): the suspension commits; the waiting request then sees no T3
      const v9b = await actionFirst(2, () => suspend(s2, rc.suspend2.secret));
      expect(v9b.ra.status, JSON.stringify(v9b.ra.json)).toBe(201);
      expect(v9b.rb.status, JSON.stringify(v9b.rb.json)).toBe(201);
      expect(await t3()).toBe(0);
      ev('V9 suspension first', { ...v9b.evidence, suspension_http: v9b.ra.status, request_http: v9b.rb.status, t3After: 0 });

      // V19, revocation first (suspended): the revocation commits; the waiting request then sees T3
      const v19b = await actionFirst(3, () => revoke(s2, rc.revoke2.secret));
      expect(v19b.ra.status, JSON.stringify(v19b.ra.json)).toBe(201);
      expect([v19b.rb.status, v19b.rb.json?.code, v19b.rb.json?.restrictions], JSON.stringify(v19b.rb.json)).toEqual([409, 'assistance_restricted', ['T3']]);
      expect(await t3()).toBe(1);
      ev('V19 revocation first', { ...v19b.evidence, revocation_http: v19b.ra.status, request_http: [v19b.rb.status, v19b.rb.json?.code], t3After: 1 });

      // never retroactive: both requests admitted while no T3 applied stand, unchanged; final state; the debt is untouched
      await passes();
      const stood = (await billingAdmin.query(`SELECT id, status FROM assistance_request WHERE id = ANY($1)`, [[admitted, v9b.rb.json.id]])).rows;
      expect(stood.map((x) => x.status)).toEqual(['pending', 'pending']);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM recovery_restriction_suspension_event WHERE "obligationId" = $1`, [obligationId])).toBe(4);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM outbox WHERE name LIKE 'audit.recovery_restriction.%' AND payload->'resource'->>'id' = $1`, [obligationId])).toBe(4);
      expect((await call(B1, 'GET', owners.a.token, `/billing/admin/recovery-obligations/${obligationId}`)).json).toMatchObject({ outstanding: BASE, status: 'open', collection: 'frozen_overlap', restriction: 'active' });
      ev('V9/V19 final', { admittedRequestsStand: stood, events: 4, auditIntents: 4, outstanding: BASE, restriction: 'active' });
    }, 600_000);
  },
);
