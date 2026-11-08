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
 * Core V2 S0-C15B: DETERMINISTIC CERTIFICATION that contested refund evidence (DO-57) and chargebacks stated only in a dispute conflict (DO-56) stay Owner-visible
 * as durable, non-acknowledgeable Billing cases (S0 §1.5 S0-C15B; BIL-33 O; B-D1 to B-D11), on the S0-C15A harness below. DEVELOPMENT AND SIMULATION ONLY.
 * LABELLED TEST AIDS: the payment row lock (Q57-6's order), the relay row lock (T17's pause between a case and its evidence), the proxy's older-Payment and
 * Payment-unavailable modes. LABELLED TEST-ONLY FIXTURE: refund notifications signed by the test through Payment's real webhook pipeline. No row is written by SQL.
 *
 * (The harness, from S0-C15A:)
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
  'Core V2 S0-C15B: contested evidence certification (real Auth, Payment, Audit, TWO Billing processes, RabbitMQ with Billing\'s identity; simulation)',
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
    const olderPayment = { presence: false };
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
          // Core V2 S0-C15B T18: a Payment older than the redacted presence kind answers it as an unknown kind (400)
          if (olderPayment.presence && (req.url ?? '').startsWith('/payment/reconciliation/items') && (req.url ?? '').includes('kind=dispute_conflict_presence')) {
            return void (res.writeHead(400, { 'content-type': 'application/json' }), res.end('{"code":"invalid_reconciliation_request"}'));
          }
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
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauths0c15bc');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillings0c15bc');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epayments0c15bc');
      auditDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eaudits0c15bc');
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
    async function directPurchase(seller = COMPANY) { // S0-C15B T19: the seller Company may be the other Owner's
      const pid = (await billingAdmin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
        VALUES ('test-producer', 'company', $1, $2, 'Personal plan', 'active', 'personal', $3) RETURNING id`, [seller, `d-${randomUUID().slice(0, 8)}`, TEST_PLATFORM])).rows[0].id;
      const prc = (await billingAdmin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, $2, 'TND', $3, 'recurring', 'month', 1) RETURNING id`,
        [pid, `d-${randomUUID().slice(0, 8)}`, PRICE])).rows[0].id;
      const inv = await call(B1, 'POST', producerToken.token, '/billing/invoices', { invoiceRequestId: randomUUID(), seller: { type: 'company', id: seller }, payer: { type: 'user', id: payerId },
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
    // ═══════════════════════════════════════════════════════════════ S0-C15B certification helpers
    // LABELLED TEST-ONLY FIXTURES: `rawRefund` (a refund notification signed by the test through Payment's real webhook pipeline, as S0-C15A's
    // `signedRefund`); LABELLED TEST AID: `paymentLock` (a row lock on Payment's payment row held by the test, the order barrier of Q57-2/3).
    // No financial row is written by SQL.
    async function rawRefund(attemptId: string, amount: number, txn: string) {
      const raw = JSON.stringify({ eventId: `c15b_${randomUUID()}`, type: 'refund.succeeded', reference: attemptId, providerTransactionId: txn, amount, currency: 'TND' });
      const r = await fetch(`${PAYMENT_URL}/payment/webhooks/simulation`, { method: 'POST', body: raw,
        headers: { 'content-type': 'application/json', 'x-simulation-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') } });
      return r.status;
    }
    async function sim(paymentId: string, ref: string, event: 'opened' | 'won' | 'lost', o: { amount?: number; chargebackAmount?: number; chargebackRef?: string } = {}) {
      const r = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${paymentId}/disputes`, { commandId: `c15b-${randomUUID()}`, disputeRef: ref, event, ...o });
      expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);
      return r.json?.delivered as { status: number } | undefined;
    }
    const disputeOf = async (ref: string) => (await one(paymentAdmin, `SELECT id, status, amount, "chargebackFactId" FROM payment_dispute WHERE "providerDisputeId" = $1`, [`simd_${ref}`])) ?? null;
    const conflictsOf = async (paymentId: string) => (await paymentAdmin.query(`SELECT id, kind, reason, amount, "chargebackTxnId", "chargebackAmount" FROM payment_dispute_observation
      WHERE "paymentId" = $1 AND disposition = 'conflict' ORDER BY "observedAt"`, [paymentId])).rows;
    const waitConflict = (paymentId: string, count: number) => waitFor(async () => (await conflictsOf(paymentId)).length >= count, 30_000, `the dispute conflict\n${tails()}`);
    async function ownerItems(paymentId: string) {
      const out: Record<string, unknown[]> = {};
      for (const kind of ['fact_conflict', 'allocation_blocked', 'dispute_conflict', 'chargeback', 'refund_discrepancy', 'over_return']) {
        const r = await call(PAYMENT_URL, 'GET', owners.a.token, `/payment/admin/reconciliation-items?kind=${kind}&limit=200`);
        const mine = ((r.json?.items ?? []) as { paymentId: string; amount: number | null; detail: Record<string, unknown> }[]).filter((i) => i.paymentId === paymentId);
        if (mine.length) out[kind] = mine.map((i) => ({ amount: i.amount, detail: i.detail }));
      }
      return out;
    }
    /** Billing's producer read of the dispute exposure (the same route Billing's refund admission consults). */
    const exposureState = async (paymentId: string) => (await call(PAYMENT_URL, 'GET', billingToPaymentToken.token, `/payment/payments/${paymentId}/dispute-exposure`)).json;
    async function billingCases(p: { paymentId: string; paymentRequestId: string }) {
      return (await billingAdmin.query(`SELECT c."caseType", c.detail, c.amount, r.kind, r.reason FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
        WHERE c."paymentId" = $1 OR c."paymentRequestId" = $2 OR c."evidenceKey" IN (SELECT "disputeId" FROM payment_dispute_loss WHERE "paymentId" = $1) ORDER BY c."caseType", c."openedAt"`,
        [p.paymentId, p.paymentRequestId])).rows;
    }
    async function snapshot(p: { paymentId: string; paymentRequestId: string }) {
      const bal = (await call(PAYMENT_URL, 'GET', owners.a.token, `/payment/admin/payments/${p.paymentId}/balance`)).json;
      return {
        payment: {
          facts: (await paymentAdmin.query(`SELECT kind, amount, "providerTxnId" AS txn, EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id) AS contested
            FROM provider_transaction_fact f WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
          factConflicts: (await paymentAdmin.query(`SELECT amount, source FROM provider_transaction_fact_conflict WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
          refundAttempts: (await paymentAdmin.query(`SELECT status, amount FROM refund_attempt WHERE "paymentId" = $1 ORDER BY "requestedAt"`, [p.paymentId])).rows,
          allocations: (await paymentAdmin.query(`SELECT amount, intended, excess FROM refund_allocation WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
          blocks: (await paymentAdmin.query(`SELECT b.reason FROM refund_fact_allocation_block b JOIN provider_transaction_fact f ON f.id = b."factId" WHERE f."paymentId" = $1`, [p.paymentId])).rows,
          authorizations: (await paymentAdmin.query(`SELECT "approvedAmount", "allocatedIntended", "completedAt" IS NOT NULL AS completed FROM refund_authorization WHERE "paymentId" = $1`, [p.paymentId])).rows,
          disputes: (await paymentAdmin.query(`SELECT status, amount, "chargebackFactId" IS NOT NULL AS "hasChargebackFact" FROM payment_dispute WHERE "paymentId" = $1 ORDER BY "recordedAt"`, [p.paymentId])).rows,
          disputeConflicts: await conflictsOf(p.paymentId),
          balance: bal?.currencies, unresolved: bal?.unresolved, pendingRefunds: bal?.pendingRefunds,
          exposure: await exposureState(p.paymentId),
          ownerItems: await ownerItems(p.paymentId),
        },
        billing: {
          cases: await billingCases(p),
          openCases: (await billingCases(p)).filter((c) => c.kind === null).map((c) => c.caseType),
          refundCases: (await billingAdmin.query(`SELECT status FROM refund_case WHERE "paymentId" = $1 ORDER BY "openedAt"`, [p.paymentId])).rows.map((r) => r.status),
          relays: (await billingAdmin.query(`SELECT "attemptStatus" FROM refund_authorization_relay WHERE "paymentId" = $1`, [p.paymentId])).rows.map((r) => r.attemptStatus),
          disputeLosses: (await billingAdmin.query(`SELECT "chargebackAmount", "chargebackFactId" IS NOT NULL AS "hasFact" FROM payment_dispute_loss WHERE "paymentId" = $1`, [p.paymentId])).rows,
          losses: (await billingAdmin.query(`SELECT kind, amount FROM financial_loss WHERE "paymentId" = $1 OR "disputeId" IN (SELECT "disputeId" FROM payment_dispute_loss WHERE "paymentId" = $1)`, [p.paymentId])).rows,
          obligations: (await billingAdmin.query(`SELECT status, "baseAmount" FROM recovery_obligation WHERE "disputeId" IN (SELECT "disputeId" FROM payment_dispute_loss WHERE "paymentId" = $1)`, [p.paymentId])).rows,
          purchases: (await billingAdmin.query(`SELECT r.cause FROM subscription_purchase s LEFT JOIN subscription_purchase_reversal r ON r."purchaseId" = s.id WHERE s."paymentRequestId" = $1`, [p.paymentRequestId])).rows,
        },
      };
    }
    /** The Char-4 step: the Owner tries to close every open Billing case as "no financial effect", then (if refused) as "provider statement reviewed". */
    async function ownerClosesEverything(p: { paymentId: string; paymentRequestId: string }) {
      const tried: unknown[] = [];
      const cases = (await billingAdmin.query(`SELECT c.id, c."caseType" FROM reconciliation_case c WHERE (c."paymentId" = $1 OR c."paymentRequestId" = $2
        OR c."evidenceKey" IN (SELECT "disputeId" FROM payment_dispute_loss WHERE "paymentId" = $1)) AND NOT EXISTS (SELECT 1 FROM reconciliation_case_resolution r WHERE r."caseId" = c.id)`,
        [p.paymentId, p.paymentRequestId])).rows as { id: string; caseType: string }[];
      for (const c of cases) {
        const a = await ack(B1, c.id, 'reviewed_no_financial_effect');
        const entry: Record<string, unknown> = { caseType: c.caseType, reviewed_no_financial_effect: [a.status, a.json?.code ?? null] };
        if (a.status !== 200) {
          const b = await ack(B2, c.id, 'provider_statement_reviewed');
          entry.provider_statement_reviewed = [b.status, b.json?.code ?? null];
        }
        tried.push(entry);
      }
      return tried;
    }
    const newRefundCase = async (paymentId: string) => {
      const r = await call(B1, 'POST', owners.a.token, '/billing/admin/refund-cases', { paymentId, reason: 'customer_request' });
      return [r.status, r.json?.code ?? null];
    };
    const auditOf = async (action: string, paymentId: string) => n(auditAdmin, `SELECT count(*) AS n FROM audit_record WHERE action = $1 AND changes->>'payment_id' = $2`, [action, paymentId]);

    const contestCase = (factId: string) => one(billingAdmin, `SELECT c.id, c.detail, c.amount, c.currency, c."paymentId", c."captureFactId", r.kind FROM reconciliation_case c
      LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id WHERE c."caseType" = 'refund_fact_contested' AND c."evidenceKey" = $1`, [factId]);
    const conflictCase = (observationId: string) => one(billingAdmin, `SELECT c.id, c.detail, c.amount, c.currency, c."captureFactId", c."paymentId", r.kind FROM reconciliation_case c
      LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id WHERE c."caseType" = 'dispute_conflict_observed' AND c."evidenceKey" = $1`, [observationId]);
    const evidenceOf = (caseId: string) => one(billingAdmin, `SELECT "paymentId", "refundFactId", "refundAttemptId", "captureFactId" FROM reconciliation_contest_evidence WHERE "caseId" = $1`, [caseId]);
    const providerRef = async (attemptId: string) => (await one(paymentAdmin, `SELECT "providerRefundId" FROM refund_attempt WHERE id = $1`, [attemptId]))!.providerRefundId as string;
    const refundFactOf = async (txn: string) => (await one(paymentAdmin, `SELECT id FROM provider_transaction_fact WHERE "providerTxnId" = $1 AND kind = 'refund'`, [txn]))!.id as string;
    const waitCase = (get: () => Promise<unknown>, what: string) => waitFor(async () => !!(await get()), 90_000, `${what}\n${tails()}`);
    /** The money of one payment, on both sides: S0-C15B may change none of it. */
    const financial = async (p: { paymentId: string; paymentRequestId: string }, org?: string) => {
      const s = await snapshot(p);
      return { facts: s.payment.facts, attempts: s.payment.refundAttempts, allocations: s.payment.allocations, blocks: s.payment.blocks, authorizations: s.payment.authorizations,
        disputes: s.payment.disputes, balance: s.payment.balance, refundCases: s.billing.refundCases, relays: s.billing.relays, disputeLosses: s.billing.disputeLosses, losses: s.billing.losses,
        obligations: s.billing.obligations, purchases: s.billing.purchases, restrictions: org ? (await restrictions(org)).map((x) => x.kind) : [] };
    };
    const signedRaw = async (raw: string) => (await fetch(`${PAYMENT_URL}/payment/webhooks/simulation`, { method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'x-simulation-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') } })).status;
    const conflictAudit = (factId: string) => auditAdmin.query(`SELECT changes FROM audit_record WHERE action = 'provider_fact_conflict.recorded' AND "resourceId" = $1`, [factId]).then((r) => r.rows);
    const openedIntents = (caseId: string) => n(billingAdmin, `SELECT count(*) AS n FROM outbox WHERE name = 'audit.reconciliation_case.opened' AND payload->'resource'->>'id' = $1`, [caseId]);
    const recordedOnce = (caseId: string, type: string) => waitFor(async () => (await n(auditAdmin, `SELECT count(*) AS n FROM audit_record WHERE action = 'reconciliation_case.opened' AND "resourceId" = $1
      AND changes->>'case_type' = $2`, [caseId, type])) === 1, 60_000, `Audit to record ${type}\n${audit.tail()}`);

    // ─────────────────────────────── DO-57 corrected
    for (const kind of ['assisted', 'direct'] as const) {
      it(`T1, T9, T13, T15 (${kind}): refund 100 succeeded and completed, then contradicted (150): one refund_fact_contested case with the VERIFIED 100; one audit of the contradiction; no money moves`, async () => {
        const { o, p } = await buy(kind);
        const r = await relayed(p.paymentId, p.amount);
        const txn = await providerRef(r.attemptId);
        expect(await rawRefund(r.attemptId, 100, txn)).toBe(200);
        await completedCase(r.caseId);
        await settle();
        const raw = JSON.stringify({ eventId: `c15b_${randomUUID()}`, type: 'refund.succeeded', reference: r.attemptId, providerTransactionId: txn, amount: 150, currency: 'TND' });
        expect(await signedRaw(raw)).toBe(200);
        expect(await signedRaw(raw)).toBe(200); // the same notification again: nothing more anywhere
        const factId = await refundFactOf(txn);
        await waitFor(async () => (await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact_conflict WHERE "factId" = $1`, [factId])) === 1, 30_000, 'the conflict');
        const before = await financial(p, o?.org); // Payment's own contradiction recorded (the fact now contested): from here S0-C15B may change nothing
        await waitCase(() => contestCase(factId), 'the refund contest case');
        await settle();
        const c = (await contestCase(factId))!;
        expect(c).toMatchObject({ detail: 'contested_after_allocation', amount: '100', currency: 'TND', paymentId: p.paymentId, kind: null });
        expect(await evidenceOf(c.id)).toMatchObject({ paymentId: p.paymentId, refundFactId: factId, refundAttemptId: r.attemptId });
        expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_fact_contested' AND "evidenceKey" = $1`, [factId])).toBe(1);
        expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "paymentId" = $1 AND amount = 150`, [p.paymentId])).toBe(0); // the contested amount never enters Billing
        expect(await openedIntents(c.id)).toBe(1);
        await recordedOnce(c.id, 'refund_fact_contested');
        await waitFor(async () => (await conflictAudit(factId)).length === 1, 60_000, `Audit to record the contradiction\n${audit.tail()}`);
        const [a] = await conflictAudit(factId);
        expect(a.changes).toMatchObject({ refund_attempt_id: r.attemptId, payment_id: p.paymentId, observed_amount: 150, source: 'webhook' });
        expect(Object.keys(a.changes).sort()).toEqual(['attempt_id', 'conflict_id', 'observed_amount', 'payment_id', 'refund_attempt_id', 'source']);
        expect(await financial(p, o?.org)).toEqual(before);
        for (const reason of ['reviewed_no_financial_effect', 'provider_statement_reviewed', 'duplicate_evidence_reviewed']) {
          expect((await ack(B1, c.id, reason)).json?.code).toBe('reconciliation_case_not_acknowledgeable');
        }
      }, T);

      it(`T2, T15 (${kind}): refund 100 and a contradicting 150 both before allocation: contested_unallocated; the refund case and purchase stay exactly as before`, async () => {
        const { o, p } = await buy(kind);
        const r = await relayed(p.paymentId, 100);
        const txn = await providerRef(r.attemptId);
        const c0 = await paymentAdmin.connect();
        await c0.query('BEGIN');
        await c0.query('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [p.paymentId]); // TEST AID: the order barrier
        const first = rawRefund(r.attemptId, 100, txn);
        await waitFor(async () => (await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [txn])) === 1, 30_000, 'the fact');
        const second = rawRefund(r.attemptId, 150, txn);
        await waitFor(async () => (await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact_conflict WHERE "refundAttemptId" = $1`, [r.attemptId])) === 1, 30_000, 'the conflict');
        await c0.query('ROLLBACK');
        c0.release();
        expect([await first, await second]).toEqual([200, 200]);
        const factId = await refundFactOf(txn);
        await waitFor(async () => (await n(paymentAdmin, `SELECT count(*) AS n FROM refund_fact_allocation_block WHERE "factId" = $1`, [factId])) === 1, 30_000, 'the block');
        await mirrored(r.attemptId, 'succeeded'); // Billing's existing relay mirror of Payment's attempt (not S0-C15B)
        const before = await financial(p, o?.org);
        await waitCase(() => contestCase(factId), 'the refund contest case');
        await settle();
        expect(await contestCase(factId)).toMatchObject({ detail: 'contested_unallocated', amount: '100', kind: null });
        expect(await financial(p, o?.org)).toEqual(before);
        expect(before.refundCases).toEqual(['open']);
        expect(before.blocks).toEqual([{ reason: 'contested' }]);
      }, T);
    }

    // ─────────────────────────────── DO-56 corrected (Char-4 shape: refund 60 of a relayed 100, a chargeback of 70 stated only in a conflict)
    for (const kind of ['assisted', 'direct'] as const) {
      for (const order of ['refund_then_conflict', 'conflict_then_refund'] as const) {
        it(`T4, T5, T9, T15 (${kind}, ${order}): terminal contradiction with chargeback 70: a redacted case opens and stays open; no financial effect is refused; the Owner can no longer close everything`, async () => {
          const { o, p } = await buy(kind);
          const r = await relayed(p.paymentId, p.amount);
          const ref = `c15b-${randomUUID()}`;
          const contradiction = async () => {
            await sim(p.paymentId, ref, 'opened', { amount: 70 });
            await sim(p.paymentId, ref, 'won', { amount: 70 });
            await sim(p.paymentId, ref, 'lost', { amount: 70, chargebackAmount: 70 });
            await waitConflict(p.paymentId, 1);
          };
          if (order === 'refund_then_conflict') { await signedRefund(r.attemptId, 60); await contradiction(); } else { await contradiction(); await signedRefund(r.attemptId, 60); }
          const [obs] = await conflictsOf(p.paymentId);
          await waitReviews(p.paymentId, p.paymentRequestId, 1);
          await waitCase(() => conflictCase(obs.id), 'the dispute conflict case');
          await settle();
          const before = await financial(p, o?.org);
          const c = (await conflictCase(obs.id))!;
          expect(c).toMatchObject({ paymentId: p.paymentId, amount: null, currency: null, captureFactId: null, detail: null, kind: null });
          expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'dispute_conflict_observed' AND "evidenceKey" = $1`, [obs.id])).toBe(1);
          expect(await openedIntents(c.id)).toBe(1);
          await recordedOnce(c.id, 'dispute_conflict_observed');
          const closes = await ownerClosesEverything(p) as { caseType: string; reviewed_no_financial_effect: unknown[]; provider_statement_reviewed?: unknown[] }[];
          const disc = closes.find((x) => x.caseType === 'refund_discrepancy')!;
          expect(disc.reviewed_no_financial_effect).toEqual([409, 'reconciliation_case_contested']);
          expect(disc.provider_statement_reviewed).toEqual([200, null]);
          expect(closes.find((x) => x.caseType === 'dispute_conflict_observed')).toMatchObject({ reviewed_no_financial_effect: [409, 'reconciliation_case_not_acknowledgeable'],
            provider_statement_reviewed: [409, 'reconciliation_case_not_acknowledgeable'] });
          await settle();
          expect((await snapshot(p)).billing.openCases, 'the DO-56 defect is corrected: an open case remains').toEqual(['dispute_conflict_observed']);
          expect(await financial(p, o?.org)).toEqual(before);
          expect(before.balance).toEqual([{ currency: 'TND', captured: 100, refundedNet: 60, chargebackNet: 0, netRetained: 40 }]); // the contested chargeback is in no figure
        }, T);
      }
    }
    // every other tested conflict reason
    it('T4: exposure_mismatch, chargeback_mismatch and chargeback_unverifiable each open one redacted case; no financial effect is then refused on the payment', async () => {
      const cases: Record<string, string> = {};
      const a = await buy('direct');
      const ra = `c15b-${randomUUID()}`;
      await sim(a.p.paymentId, ra, 'opened', { amount: 100 });
      await sim(a.p.paymentId, ra, 'lost', { amount: 70, chargebackAmount: 70 });
      const b = await buy('direct');
      const rb = `c15b-${randomUUID()}`;
      await sim(b.p.paymentId, rb, 'opened', { amount: 100 });
      await sim(b.p.paymentId, rb, 'lost', { amount: 100, chargebackAmount: 70, chargebackRef: `${rb}-a` });
      await waitFor(async () => (await n(billingAdmin, `SELECT count(*) AS n FROM payment_dispute_loss WHERE "paymentId" = $1`, [b.p.paymentId])) === 1, 45_000, 'the loss');
      await sim(b.p.paymentId, rb, 'lost', { amount: 100, chargebackAmount: 30, chargebackRef: `${rb}-b` });
      const c = await buy('direct');
      const rc1 = `c15b-${randomUUID()}`;
      const rc2 = `c15b-${randomUUID()}`;
      await sim(c.p.paymentId, rc1, 'opened', { amount: 70 });
      await sim(c.p.paymentId, rc1, 'lost', { amount: 70, chargebackAmount: 70, chargebackRef: `${rc1}-cb` });
      await sim(c.p.paymentId, rc2, 'opened', { amount: 30 });
      await sim(c.p.paymentId, rc2, 'lost', { amount: 30, chargebackAmount: 30, chargebackRef: `${rc1}-cb` });
      for (const [label, x] of [['exposure_mismatch', a], ['chargeback_mismatch', b], ['chargeback_unverifiable', c]] as const) {
        await waitConflict(x.p.paymentId, 1);
        const [obs] = await conflictsOf(x.p.paymentId);
        expect(obs.reason).toBe(label);
        await waitCase(() => conflictCase(obs.id), `the ${label} case`);
        cases[label] = obs.id;
      }
      await settle();
      for (const x of [b, c]) {
        const partial = (await billingAdmin.query(`SELECT id FROM reconciliation_case WHERE "caseType" = 'partial_chargeback' AND "paymentId" = $1`, [x.p.paymentId])).rows[0];
        if (partial) expect((await ack(B1, partial.id, 'reviewed_no_financial_effect')).json?.code).toBe('reconciliation_case_contested');
      }
      for (const id of Object.values(cases)) expect(await conflictCase(id)).toMatchObject({ amount: null, detail: null, kind: null });
    }, T);

    it('T19 (same Company, another payment): a notification naming another payment\'s dispute opens a case only for the observing payment; nothing of the other payment reaches it', async () => {
      const a = await buy('direct');
      const b = await buy('direct');
      const ref = `c15b-${randomUUID()}`;
      await sim(b.p.paymentId, ref, 'opened', { amount: 50 });
      const bDispute = (await disputeOf(ref))!;
      await sim(a.p.paymentId, ref, 'opened', { amount: 50 }); // the provider names B's dispute against A's attempt
      await waitConflict(a.p.paymentId, 1);
      const [obs] = await conflictsOf(a.p.paymentId);
      expect(obs.reason).toBe('payment_mismatch');
      await waitCase(() => conflictCase(obs.id), 'the payment_mismatch case');
      await settle();
      expect(await conflictCase(obs.id)).toMatchObject({ paymentId: a.p.paymentId, amount: null, detail: null });
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "evidenceKey" = $1 OR ("caseType" = 'dispute_conflict_observed' AND "paymentId" = $2)`,
        [bDispute.id, b.p.paymentId])).toBe(0);
      expect(JSON.stringify((await billingAdmin.query(`SELECT * FROM reconciliation_case WHERE "paymentId" = $1`, [a.p.paymentId])).rows)).not.toContain(bDispute.id);
    }, T);

    it('T17 (LABELLED TEST AID: a lock on the relay row pauses a worker between the case and its evidence): no case is visible meanwhile; two processes open one case, one evidence row, one audit intent', async () => {
      const { p } = await buy('direct');
      const r = await relayed(p.paymentId, p.amount);
      const txn = await providerRef(r.attemptId);
      expect(await rawRefund(r.attemptId, 100, txn)).toBe(200);
      await completedCase(r.caseId);
      await settle();
      const hold = await billingAdmin.connect();
      await hold.query('BEGIN');
      await hold.query('SELECT 1 FROM refund_authorization_relay WHERE id = $1 FOR UPDATE', [r.attemptId]);
      expect(await rawRefund(r.attemptId, 150, txn)).toBe(200);
      const factId = await refundFactOf(txn);
      await waitFor(async () => (await n(billingAdmin, `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE '%reconciliation_%'`)) >= 1,
        60_000, `a worker to wait between its case and its evidence\n${tails()}`);
      await pause(12_000); // both processes pass meanwhile
      expect(await contestCase(factId), 'an uncommitted case is invisible: no orphan can be read').toBeUndefined();
      await hold.query('ROLLBACK');
      hold.release();
      await waitCase(() => contestCase(factId), 'the case after the pause');
      await settle();
      const c = (await contestCase(factId))!;
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_fact_contested' AND "evidenceKey" = $1`, [factId])).toBe(1);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_contest_evidence WHERE "refundFactId" = $1`, [factId])).toBe(1);
      expect(await openedIntents(c.id)).toBe(1);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case c WHERE c."caseType" = 'refund_fact_contested' AND NOT EXISTS (SELECT 1 FROM reconciliation_contest_evidence e WHERE e."caseId" = c.id)`)).toBe(0);
    }, T);

    it('T12 (B-D6): while Payment\'s refunds read is unavailable the contest opens nothing; it opens on a later pass (retry never discards it)', async () => {
      const { p } = await buy('direct');
      const r = await relayed(p.paymentId, p.amount);
      const txn = await providerRef(r.attemptId);
      expect(await rawRefund(r.attemptId, 100, txn)).toBe(200);
      await completedCase(r.caseId);
      proxyMode.set(p.paymentId, 'pay08_503');
      try {
        expect(await rawRefund(r.attemptId, 150, txn)).toBe(200);
        await settle();
        expect(await contestCase(await refundFactOf(txn))).toBeUndefined();
        proxyMode.set(p.paymentId, 'pay08_malformed');
        await settle();
        expect(await contestCase(await refundFactOf(txn))).toBeUndefined();
      } finally {
        proxyMode.delete(p.paymentId);
      }
      await waitCase(async () => contestCase(await refundFactOf(txn)), 'the contest case once Payment answers');
      expect(billing1.tail() + billing2.tail()).toContain('payment_evidence_inconsistent');
    }, T);

    it('T18 (B-D11): against a Payment that does not know the presence kind, the other kinds are still read; the conflict case opens once it does', async () => {
      const { p } = await buy('direct');
      const r = await relayed(p.paymentId, p.amount);
      olderPayment.presence = true;
      let obsId = '';
      try {
        const ref = `c15b-${randomUUID()}`;
        await sim(p.paymentId, ref, 'opened', { amount: 70 });
        await sim(p.paymentId, ref, 'won', { amount: 70 });
        await sim(p.paymentId, ref, 'lost', { amount: 70, chargebackAmount: 70 });
        await waitConflict(p.paymentId, 1);
        obsId = (await conflictsOf(p.paymentId))[0].id;
        await signedRefund(r.attemptId, 60);
        await waitReviews(p.paymentId, p.paymentRequestId, 1); // refund_discrepancy: another kind, still read
        await settle();
        expect(await conflictCase(obsId)).toBeUndefined();
      } finally {
        olderPayment.presence = false;
      }
      await waitCase(() => conflictCase(obsId), 'the conflict case after the upgrade');
    }, T);

    it('T11: Char-4 plus a dispute conflict on the same payment: the exposure answers first; both cases stay open', async () => {
      const { p } = await buy('assisted');
      const r = await relayed(p.paymentId, p.amount);
      await signedRefund(r.attemptId, 60);
      const d = await dispute(p.paymentId, 70);
      const ref = `c15b-${randomUUID()}`;
      await sim(p.paymentId, ref, 'opened', { amount: 20 });
      await sim(p.paymentId, ref, 'won', { amount: 20 });
      await sim(p.paymentId, ref, 'lost', { amount: 20, chargebackAmount: 20 });
      await waitConflict(p.paymentId, 1);
      const [obs] = await conflictsOf(p.paymentId);
      await hasExposure(d);
      await waitCase(() => conflictCase(obs.id), 'the dispute conflict case');
      await waitReviews(p.paymentId, p.paymentRequestId, 2);
      for (const c of await reviews(p.paymentId, p.paymentRequestId)) {
        expect((await ack(B1, c.id, 'reviewed_no_financial_effect')).json?.code, c.caseType).toBe('reconciliation_case_in_exposure');
      }
      await settle();
      expect(await exposure(d)).toMatchObject({ kind: null });
      expect(await conflictCase(obs.id)).toMatchObject({ kind: null });
    }, T);
    it('T4 capture_unverified: a contested capture, then a loss with a chargeback of 70 for it: one redacted case; the chargeback stays unverified; no money moves', async () => {
      const { p } = await buy('direct');
      const cap = (await one(paymentAdmin, `SELECT id, "providerTxnId" AS txn, "attemptId" FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture'`, [p.paymentId]))!;
      expect(await signedRaw(JSON.stringify({ eventId: `c15b_${randomUUID()}`, type: 'payment.succeeded', reference: cap.attemptId, providerTransactionId: cap.txn, amount: 101, currency: 'TND' }))).toBe(200);
      await waitFor(async () => (await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact_conflict WHERE "factId" = $1`, [cap.id])) === 1, 30_000, 'the capture contradiction');
      const ref = `c15b-${randomUUID()}`;
      await sim(p.paymentId, ref, 'opened', { amount: 70 });
      await sim(p.paymentId, ref, 'lost', { amount: 70, chargebackAmount: 70 });
      await waitConflict(p.paymentId, 2); // both notifications: the dispute is never recorded against an unverified capture
      const conflicts = await conflictsOf(p.paymentId);
      expect(conflicts.map((c) => `${c.kind}:${c.reason}`)).toEqual(['opened:capture_unverified', 'lost:capture_unverified']);
      const obs = conflicts.find((c) => c.kind === 'lost')!;
      expect(Number(obs.chargebackAmount)).toBe(70); // the chargeback is stated only in the conflict
      await settle();
      const before = await financial(p);
      await waitCase(() => conflictCase(obs.id), 'the capture_unverified case');
      await waitCase(() => conflictCase(conflicts[0]!.id), 'the opened notification\'s case');
      await settle();
      expect(await conflictCase(obs.id)).toMatchObject({ paymentId: p.paymentId, amount: null, captureFactId: null, detail: null, kind: null });
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM payment_dispute_loss WHERE "paymentId" = $1`, [p.paymentId])).toBe(0); // never a verified loss
      expect(await financial(p)).toEqual(before);
      expect((await snapshot(p)).billing.openCases).toContain('dispute_conflict_observed');
    }, T);

    it('T19 (cross-Company, full process): Company A\'s notification naming Company B\'s dispute: only A\'s Owner sees a case; it names nothing of B; B\'s Owner sees nothing of A at Billing or Payment', async () => {
      const a = await buy('direct');
      const b = { p: await directPurchase(owners.x.company) };
      const ref = `c15b-${randomUUID()}`;
      await sim(b.p.paymentId, ref, 'opened', { amount: 50 });
      const bDispute = (await disputeOf(ref))!;
      await sim(a.p.paymentId, ref, 'opened', { amount: 50 });
      await waitConflict(a.p.paymentId, 1);
      const [obs] = await conflictsOf(a.p.paymentId);
      expect(obs.reason).toBe('payment_mismatch');
      await waitCase(() => conflictCase(obs.id), 'the payment_mismatch case');
      await settle();
      const row = (await one(billingAdmin, `SELECT * FROM reconciliation_case WHERE "caseType" = 'dispute_conflict_observed' AND "evidenceKey" = $1`, [obs.id]))!;
      expect(row).toMatchObject({ companyId: COMPANY, paymentId: a.p.paymentId, amount: null, detail: null });
      for (const other of [b.p.paymentId, bDispute.id, owners.x.company]) expect(JSON.stringify(row)).not.toContain(other);
      const listA = (await call(B1, 'GET', owners.a.token, '/billing/admin/reconciliation-cases?status=open&type=dispute_conflict_observed')).json?.items as { evidenceId: string }[];
      expect(listA.some((c) => c.evidenceId === obs.id)).toBe(true);
      const listB = await call(B2, 'GET', owners.x.token, '/billing/admin/reconciliation-cases?status=open&type=dispute_conflict_observed');
      expect(listB.status).toBe(200);
      expect((listB.json.items as { evidenceId: string; paymentId: string }[]).some((c) => c.evidenceId === obs.id || c.paymentId === a.p.paymentId)).toBe(false);
      const payB = await call(PAYMENT_URL, 'GET', owners.x.token, '/payment/admin/reconciliation-items?kind=dispute_conflict&limit=200');
      expect((payB.json?.items as { id: string }[]).some((i) => i.id === obs.id)).toBe(false);
      expect((await call(PAYMENT_URL, 'GET', owners.x.token, '/payment/admin/reconciliation-items?kind=dispute_conflict_presence&limit=200')).json?.code).toBe('invalid_reconciliation_request');
      const payA = await call(PAYMENT_URL, 'GET', owners.a.token, '/payment/admin/reconciliation-items?kind=dispute_conflict&limit=200');
      const itemA = (payA.json.items as { id: string; detail: Record<string, unknown> }[]).find((i) => i.id === obs.id)!;
      expect(itemA.detail.disputeId).toBeNull(); // another payment's dispute is never named
      expect(JSON.stringify(itemA)).not.toContain(b.p.paymentId);
      expect((await call(PAYMENT_URL, 'GET', owners.x.token, `/payment/admin/payments/${a.p.paymentId}/balance`)).status).toBe(404);
    }, T);
  },
);
