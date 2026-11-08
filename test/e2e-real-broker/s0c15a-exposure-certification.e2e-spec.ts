import { createHmac, randomBytes, randomUUID } from 'node:crypto';
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
 * Core V2 S0-C15A: DETERMINISTIC CERTIFICATION of the unresolved refund and chargeback exposure (S0 §1.5 S0-C15A; BIL-33 N; finding DO-72) across SEPARATELY
 * SPAWNED, BUILT processes: real auth-service, payment-service (simulation provider), audit-service and TWO billing-service processes on ONE database, over a
 * real RabbitMQ. DEVELOPMENT AND SIMULATION ONLY. Prerequisite: build service-kit, audit-contract, auth-service, billing-service, payment-service, audit-service.
 * LABELLED TEST-ONLY FIXTURE: `signedRefund` (the simulator's `amount_mismatch` is always one minor unit away, so an exact partial amount is sent as a provider
 * notification signed by the test through Payment's real webhook pipeline). LABELLED TEST AID: R11's table lock. No financial row is written by SQL.
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
const BASE = 100;
const PRICE = 100;
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
  'Core V2 S0-C15A: exposure certification (real Auth, Payment, Audit, TWO Billing processes, RabbitMQ with Billing\'s identity; simulation)',
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
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauths0c15a');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillings0c15a');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epayments0c15a');
      auditDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eaudits0c15a');
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
        NODE_ENV: 'test', PORT: String(PORT.auth), DATABASE_URL: authDb.url, AUTH_EVENTS: 'off', ACCESS_TOKEN_TTL_SEC: '3600', RABBITMQ_URL: env.TEST_RABBITMQ_URL,
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
      for (const d of [authDb, billingDb, paymentDb, auditDb]) await d?.drop();
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


    const settle = () => pause(25_000); // every worker passes more than once on both processes
    /** LABELLED TEST-ONLY FIXTURE: see the file header. `txn` is the provider's refund id: two partials of one attempt are distinct movements of money. */
    async function signedRefund(attemptId: string, amount: number, txn = `simr_c15a_${randomUUID()}`) {
      const raw = JSON.stringify({ eventId: `c15a_${randomUUID()}`, type: 'refund.succeeded', reference: attemptId, providerTransactionId: txn, amount, currency: 'TND' });
      const wh = await fetch(`${PAYMENT_URL}/payment/webhooks/simulation`, { method: 'POST', body: raw,
        headers: { 'content-type': 'application/json', 'x-simulation-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') } });
      expect(wh.status).toBeLessThan(500);
      await waitFor(async () => (await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact WHERE "refundAttemptId" = $1 AND "providerTxnId" = $2`, [attemptId, txn])) === 1, 30_000, `the refund fact\n${tails()}`);
    }
    async function dispute(paymentId: string, amt: number) {
      const ref = `c15a-${randomUUID()}`;
      for (const event of ['opened', 'lost']) {
        const r = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${paymentId}/disputes`, { commandId: `c15a-${randomUUID()}`, disputeRef: ref, event, amount: amt, ...(event === 'lost' ? { chargebackAmount: amt } : {}) });
        expect(r.json?.delivered, JSON.stringify(r.json)).toEqual({ status: 200 });
      }
      const d = (await one(paymentAdmin, `SELECT id FROM payment_dispute WHERE "providerDisputeId" = $1`, [`simd_${ref}`]))!;
      await waitFor(async () => (await n(billingAdmin, `SELECT count(*) AS n FROM payment_dispute_loss WHERE "disputeId" = $1`, [d.id])) === 1, 45_000, `Billing to record the loss\n${tails()}`);
      return d.id as string;
    }
    const exposure = (disputeId: string) => one(billingAdmin, `SELECT c.id, c.detail, c.amount, r.kind, r."refundCaseId" FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
      WHERE c."caseType" = 'chargeback_refund_exposure' AND c."evidenceKey" = $1`, [disputeId]);
    const hasExposure = (d: string) => waitFor(async () => !!(await exposure(d)), 60_000, `the exposure case\n${tails()}`);
    const reviews = async (paymentId: string, paymentRequestId: string) => (await billingAdmin.query(`SELECT c.id, c."caseType", r.kind, r.reason FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
      WHERE (c."paymentId" = $1 OR c."paymentRequestId" = $2) AND c."caseType" IN ('partial_chargeback', 'refund_discrepancy') ORDER BY c."caseType"`, [paymentId, paymentRequestId])).rows as { id: string; caseType: string; kind: string | null; reason: string | null }[];
    const waitReviews = (paymentId: string, paymentRequestId: string, count: number) => waitFor(async () => (await reviews(paymentId, paymentRequestId)).length >= count, 60_000, `the review cases\n${tails()}`);
    const ack = (via: string, id: string, reason: string, key?: string) => call(via, 'POST', owners.a.token, `/billing/admin/reconciliation-cases/${id}/acknowledgement`, { reason }, key);
    const open = async (paymentId: string, paymentRequestId: string, disputeId: string) => (await billingAdmin.query(`SELECT c."caseType" FROM reconciliation_case c WHERE (c."paymentId" = $1 OR c."paymentRequestId" = $2 OR c."evidenceKey" = $3)
      AND NOT EXISTS (SELECT 1 FROM reconciliation_case_resolution r WHERE r."caseId" = c.id) ORDER BY 1`, [paymentId, paymentRequestId, disputeId])).rows.map((r) => r.caseType as string);
    /** Every money record of one payment: nothing here may change because of S0-C15A. */
    const money = async (p: { paymentId: string; paymentRequestId: string }, disputeId: string) => ({
      facts: (await paymentAdmin.query(`SELECT id, kind, amount FROM provider_transaction_fact WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
      attempts: (await paymentAdmin.query(`SELECT id, status, amount FROM refund_attempt WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
      allocations: (await paymentAdmin.query(`SELECT id, amount FROM refund_allocation WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
      balance: (await call(PAYMENT_URL, 'GET', owners.a.token, `/payment/admin/payments/${p.paymentId}/balance`)).json?.currencies,
      refundCases: (await billingAdmin.query(`SELECT id, status FROM refund_case WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
      purchases: (await billingAdmin.query(`SELECT s.id, r.cause FROM subscription_purchase s LEFT JOIN subscription_purchase_reversal r ON r."purchaseId" = s.id WHERE s."paymentRequestId" = $1 ORDER BY s.id`, [p.paymentRequestId])).rows,
      losses: (await billingAdmin.query(`SELECT id, kind, amount FROM financial_loss WHERE "disputeId" = $1 OR "paymentId" = $2 ORDER BY id`, [disputeId, p.paymentId])).rows,
      obligations: (await billingAdmin.query(`SELECT id, status, "baseAmount" FROM recovery_obligation WHERE "disputeId" = $1 ORDER BY id`, [disputeId])).rows,
    });
    const T = 600_000;
    const buy = async (kind: 'assisted' | 'direct') => {
      const o = kind === 'assisted' ? await organization(1) : undefined;
      return { o, p: o ? await assistedPurchase(o) : await directPurchase() };
    };

    // R1, R2: Char-4 (refund 60, chargeback 70) on both purchase kinds, in both arrival orders; R16: every money record stands; R17: Audit receives it, once
    for (const kind of ['assisted', 'direct'] as const) {
      for (const order of ['refund_then_loss', 'loss_then_refund'] as const) {
        it(`${order === 'refund_then_loss' ? 'R1' : 'R2'}, R16 Char-4 ${kind} ${order}: nothing closes the exposure, and no money record moves`, async () => {
          const { o, p } = await buy(kind);
          const r = await relayed(p.paymentId, p.amount);
          let d = '';
          if (order === 'refund_then_loss') { await signedRefund(r.attemptId, 60); d = await dispute(p.paymentId, 70); } else { d = await dispute(p.paymentId, 70); await signedRefund(r.attemptId, 60); }
          await hasExposure(d);
          await waitReviews(p.paymentId, p.paymentRequestId, 2);
          expect(await exposure(d)).toMatchObject({ detail: 'refund_money_verified', amount: '70', kind: null });
          const before = await money(p, d);
          expect(before.balance).toEqual([{ currency: 'TND', captured: 100, refundedNet: 60, chargebackNet: 70, netRetained: -30 }]); // Char-4's verified figures
          expect(before.losses).toEqual([]);
          expect(before.obligations).toEqual([]);
          for (const c of await reviews(p.paymentId, p.paymentRequestId)) {
            for (const reason of ['reviewed_no_financial_effect', 'duplicate_evidence_reviewed']) {
              const a = await ack(B1, c.id, reason);
              expect([a.status, a.json?.code], `${c.caseType} ${reason}`).toEqual([409, 'reconciliation_case_in_exposure']);
            }
            expect((await ack(B2, c.id, 'provider_statement_reviewed')).status).toBe(200);
          }
          await settle();
          expect(await open(p.paymentId, p.paymentRequestId, d), 'the Char-4 defect: an open case must remain').toEqual(['chargeback_refund_exposure']);
          expect(await money(p, d)).toEqual(before);
          expect(o ? (await restrictions(o.org)).map((x) => x.kind) : []).toEqual([]); // no restriction is created
        }, T);
      }
    }
    // R3: each review acknowledged BEFORE the second fact exists, in both orders
    for (const first of ['chargeback', 'refund'] as const) {
      it(`R3 ${first} first, its review acknowledged before the other fact: the earlier acknowledgement stands and the exposure still opens`, async () => {
        const { p } = await buy('assisted');
        const r = await relayed(p.paymentId, p.amount);
        let d = '';
        if (first === 'chargeback') { d = await dispute(p.paymentId, 70); } else { await signedRefund(r.attemptId, 60); }
        await waitReviews(p.paymentId, p.paymentRequestId, 1);
        const c0 = (await reviews(p.paymentId, p.paymentRequestId))[0]!;
        expect((await ack(B1, c0.id, 'reviewed_no_financial_effect')).status, 'legitimate: only one side exists').toBe(200);
        if (first === 'chargeback') await signedRefund(r.attemptId, 60); else d = await dispute(p.paymentId, 70);
        await hasExposure(d);
        const after = (await reviews(p.paymentId, p.paymentRequestId)).find((x) => x.id === c0.id)!;
        expect(after).toMatchObject({ kind: 'acknowledged', reason: 'reviewed_no_financial_effect' }); // never rewritten
        await waitReviews(p.paymentId, p.paymentRequestId, 2);
        const other = (await reviews(p.paymentId, p.paymentRequestId)).find((x) => x.id !== c0.id)!;
        expect((await ack(B2, other.id, 'reviewed_no_financial_effect')).json?.code).toBe('reconciliation_case_in_exposure');
      }, T);
    }
    // R4: Char-1 and Char-2 keep S0-C14's waiting behaviour; the exposure case stands beside it
    for (const kind of ['assisted', 'direct'] as const) {
      it(`R4 ${kind}: refund 40, chargeback 100: the effect still waits exactly as before`, async () => {
        const { o, p } = await buy(kind);
        const r = await relayed(p.paymentId, p.amount);
        await signedRefund(r.attemptId, 40);
        const d = await dispute(p.paymentId, 100);
        await hasExposure(d);
        await settle();
        const m = await money(p, d);
        expect(m.balance).toEqual([{ currency: 'TND', captured: 100, refundedNet: 40, chargebackNet: 100, netRetained: -40 }]);
        expect(m.obligations).toEqual([]);
        expect(m.losses).toEqual([]);
        expect(m.purchases.map((x) => x.cause)).toEqual([kind === 'direct' ? 'final_lost_chargeback' : null]);
        expect(await open(p.paymentId, p.paymentRequestId, d)).toEqual(expect.arrayContaining(['chargeback_effect_waiting', 'chargeback_refund_exposure', 'refund_discrepancy']));
        expect(o ? (await restrictions(o.org)).map((x) => x.kind) : []).toEqual([]);
      }, T);
    }
    it('R5: the effect landed, then a partial refund is reported: the waiting case is resolved, yet an exposure case stays open; the obligation is untouched', async () => {
      const { o, p } = await buy('assisted');
      const r = await relayed(p.paymentId, p.amount);
      const d = await dispute(p.paymentId, p.amount);
      await passes();
      await refundOutcome(r.attemptId, 'failed');
      await mirrored(r.attemptId, 'failed');
      await waitFor(async () => !!(await obligationOf(d)), 60_000, `the obligation\n${tails()}`);
      const ob = (await obligationOf(d))!;
      await waitFor(async () => (await caseOf('chargeback_effect_waiting', d))?.kind === 'effect_applied', 60_000, `effect_applied\n${tails()}`);
      await signedRefund(r.attemptId, 40);
      await hasExposure(d);
      await waitReviews(p.paymentId, p.paymentRequestId, 1);
      for (const c of await reviews(p.paymentId, p.paymentRequestId)) expect((await ack(B1, c.id, 'provider_statement_reviewed')).status).toBe(200);
      expect(await open(p.paymentId, p.paymentRequestId, d)).toEqual(['chargeback_refund_exposure']);
      expect(await obligationOf(d)).toMatchObject({ id: ob.id, status: 'open', baseAmount: ob.baseAmount });
      expect((await restrictions(o!.org)).map((x) => x.kind)).toEqual(['T3']);
    }, T);
    it('R9, R17: two Billing workers open one case and one audit intent; the live audit-service records it once with the new case type', async () => {
      const { p } = await buy('direct');
      const r = await relayed(p.paymentId, p.amount);
      await signedRefund(r.attemptId, 60);
      const d = await dispute(p.paymentId, 70);
      await hasExposure(d);
      await settle();
      const c = (await exposure(d))!;
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'chargeback_refund_exposure' AND "evidenceKey" = $1`, [d])).toBe(1);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM outbox WHERE name = 'audit.reconciliation_case.opened' AND payload->'resource'->>'id' = $1`, [c.id])).toBe(1);
      await waitFor(async () => (await n(auditAdmin, `SELECT count(*) AS n FROM audit_record WHERE action = 'reconciliation_case.opened' AND "resourceId" = $1`, [c.id])) === 1, 60_000, `Audit to record it\n${audit.tail()}`);
      expect((await one(auditAdmin, `SELECT changes FROM audit_record WHERE action = 'reconciliation_case.opened' AND "resourceId" = $1`, [c.id]))!.changes).toMatchObject({ case_type: 'chargeback_refund_exposure' });
    }, T);
    it('R10: the same acknowledgement on two processes at once: one resolution, one answer of already resolved', async () => {
      const { p } = await buy('assisted');
      const r = await relayed(p.paymentId, p.amount);
      await signedRefund(r.attemptId, 60);
      const d = await dispute(p.paymentId, 70);
      await hasExposure(d);
      await waitReviews(p.paymentId, p.paymentRequestId, 2);
      const c = (await reviews(p.paymentId, p.paymentRequestId))[0]!;
      const answers = await Promise.all([ack(B1, c.id, 'provider_statement_reviewed'), ack(B2, c.id, 'provider_statement_reviewed')]);
      expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case_resolution WHERE "caseId" = $1`, [c.id])).toBe(1);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM outbox WHERE name = 'audit.reconciliation_case.resolved' AND payload->'resource'->>'id' = $1`, [c.id])).toBe(1);
    }, T);
    it('R11 (LABELLED TEST AID: a table lock holds the acknowledgement after the service check): the refund evidence lands meanwhile; the DATABASE refuses, and the exposure case opens', async () => {
      const { p } = await buy('assisted');
      const r = await relayed(p.paymentId, p.amount);
      const d = await dispute(p.paymentId, 70);
      await waitReviews(p.paymentId, p.paymentRequestId, 1);
      const c = (await reviews(p.paymentId, p.paymentRequestId))[0]!;
      const lock = await billingAdmin.connect();
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE reconciliation_case_resolution IN SHARE MODE');
      const pending = ack(B1, c.id, 'reviewed_no_financial_effect');
      await waitFor(async () => (await n(billingAdmin, `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%reconciliation_case_resolution%'`)) >= 1, 15_000, 'the acknowledgement to wait on the lock');
      await signedRefund(r.attemptId, 60);
      await mirrored(r.attemptId, 'discrepancy');
      await lock.query('COMMIT');
      lock.release();
      const a = await pending;
      expect([a.status, a.json?.code], 'the guard re-reads committed facts').toEqual([409, 'reconciliation_case_in_exposure']);
      await hasExposure(d);
      expect((await reviews(p.paymentId, p.paymentRequestId)).find((x) => x.id === c.id)).toMatchObject({ kind: null });
    }, T);
    it('R12: a second partial completes the refund: the overlap case opens first, then the exposure resolves refund_completed; the overlap stays open', async () => {
      const { p } = await buy('assisted');
      const r = await relayed(p.paymentId, p.amount);
      await signedRefund(r.attemptId, 60);
      const d = await dispute(p.paymentId, 70);
      await hasExposure(d);
      expect(await exposure(d)).toMatchObject({ kind: null });
      await signedRefund(r.attemptId, 40);
      await completedCase(r.caseId);
      await waitFor(async () => (await exposure(d))?.kind === 'refund_completed', 60_000, `the exposure to resolve\n${tails()}`);
      expect(await exposure(d)).toMatchObject({ kind: 'refund_completed', refundCaseId: r.caseId });
      expect(await caseOf('chargeback_refund_overlap', d)).toMatchObject({ kind: null });
    }, T);
  },
);
