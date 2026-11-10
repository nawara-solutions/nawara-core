import { appendFileSync, copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * Core V2 DO-74, OBSERVER SIDE (BIL-33 Q): DETERMINISTIC CERTIFICATION that a refund attempt's own provider observation which contradicts a refund fact NOT of
 * its payment (an unmatched fact, or another payment's, possibly another Company's) stays Owner-visible as one figure-free, never-acknowledgeable Billing case
 * per observing attempt, and that the observing attempt's discrepancy can no longer be closed as a duplicate or as having no financial effect, across
 * separately spawned processes. DEVELOPMENT AND SIMULATION ONLY. Nothing here associates, allocates, completes, reverses or writes off anything.
 * LABELLED TEST-ONLY FIXTURE: refund notifications signed by the test through Payment's real webhook pipeline (`signedRaw`), one of them naming an unknown
 * reference. LABELLED TEST AIDS: `ageWebhook` (moves that notification's `receivedAt` past Payment's 5-minute unmatched grace window, a superuser update of
 * `webhook_event` as Payment's own suites do), the proxy's DO-74 modes (an older Payment without `observationConflicts`, a malformed one), and the relay
 * row lock (a pause between a case and its evidence). No financial row is written by SQL. R3 is certified AS IT IS (an open, unresolved risk), never changed.
 *
 * (The harness, from DO-73:)
 * Core V2 DO-73 (BIL-33 P; U-1 to U-7): DETERMINISTIC CERTIFICATION that verified refund facts Payment cannot allocate (currency_mismatch, no_authorization)
 * stay Owner-visible as non-acknowledgeable Billing cases, across separately spawned processes. DEVELOPMENT AND SIMULATION ONLY.
 *
 * (The harness, from S0-C15B:)
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
/** Core V2 DO-74 D13: a main build without DO-74 (migrations to 0053) for the mixed-version proof; DO74_OLD_BILLING_DIR names it. Unset (CI), D13 runs its
 * repository-migrations mode instead (no old binary): see D13. */
const OLD_BILLING_DIR = process.env.DO74_OLD_BILLING_DIR ?? '';
const PORT = { auth: 13871, b1: 13872, b2: 13873, payment: 13874, audit: 13876, b3: 13877, b4: 13878 };
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
  'Core V2 DO-74 (observer side): refund observation conflict certification (real Auth, Payment, Audit, TWO Billing processes, RabbitMQ with Billing\'s identity; simulation)',
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
    const hidden = { blocked: false }; // Core V2 DO-73 TEST AID: Payment answers 503 for the allocation_blocked kind (Billing cannot read it)
    const proxyMode = new Map<string, 'drop_relay' | 'pay08_503' | 'pay08_malformed' | 'pay08_obs_absent' | 'pay08_obs_malformed'>(); // DO-74: an older Payment; a malformed field
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
          if (hidden.blocked && (req.url ?? '').startsWith('/payment/reconciliation/items') && (req.url ?? '').includes('kind=allocation_blocked')) {
            return void (res.writeHead(503, { 'content-type': 'application/json' }), res.end('{"code":"unavailable"}'));
          }
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
            let text = Buffer.from(await up.arrayBuffer());
            // Core V2 DO-74 TEST AIDS: Payment's real answer, with observationConflicts removed (an older Payment) or replaced by a malformed value
            const obsMode = m && req.method === 'GET' ? proxyMode.get(m[1]!) : undefined;
            if (up.status === 200 && (obsMode === 'pay08_obs_absent' || obsMode === 'pay08_obs_malformed')) {
              const j = JSON.parse(text.toString('utf8')) as Record<string, unknown>;
              if (obsMode === 'pay08_obs_absent') delete j.observationConflicts;
              else j.observationConflicts = [{ refundAttemptId: 'not-a-uuid', conflictIds: [], observations: 7 }];
              text = Buffer.from(JSON.stringify(j));
            }
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
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauthdo74cert');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingdo74cert');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymentdo74cert');
      auditDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauditdo74cert');
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

    // ═══════════════════════════════════════════════════════════════ DO-73 STEP 0 CHARACTERIZATION (test-only; observes, asserts nothing about policy)
    // LABELLED TEST-ONLY FIXTURE: `factRaw`, a refund notification signed by the test through Payment's real webhook pipeline, with a chosen currency.
    // No row is written by SQL. Every observation is appended as one JSON line to $DO73_OUT.
    const OUT = process.env.DO74_OUT ?? '';
    const record = (scenario: string, step: string, data: unknown) => {
      if (OUT) appendFileSync(OUT, `${JSON.stringify({ scenario, step, at: new Date().toISOString(), data })}\n`);
    };
    const factRaw = (attemptId: string, amount: number, txn: string, currency: string) =>
      JSON.stringify({ eventId: `do73_${randomUUID()}`, type: 'refund.succeeded', reference: attemptId, providerTransactionId: txn, amount, currency });
    const blockOf = async (txn: string) => (await one(paymentAdmin, `SELECT b.reason FROM refund_fact_allocation_block b JOIN provider_transaction_fact f ON f.id = b."factId"
      WHERE f."providerTxnId" = $1`, [txn]))?.reason as string | undefined;
    const waitBlock = (txn: string) => waitFor(async () => (await blockOf(txn)) !== undefined, 30_000, `the allocation block of ${txn}\n${tails()}`);
    const counts = async (p: { paymentId: string; paymentRequestId: string }) => ({
      facts: await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact WHERE "paymentId" = $1`, [p.paymentId]),
      conflicts: await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact_conflict WHERE "paymentId" = $1`, [p.paymentId]),
      blocks: await n(paymentAdmin, `SELECT count(*) AS n FROM refund_fact_allocation_block b JOIN provider_transaction_fact f ON f.id = b."factId" WHERE f."paymentId" = $1`, [p.paymentId]),
      allocations: await n(paymentAdmin, `SELECT count(*) AS n FROM refund_allocation WHERE "paymentId" = $1`, [p.paymentId]),
      cases: await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "paymentId" = $1 OR "paymentRequestId" = $2`, [p.paymentId, p.paymentRequestId]),
      audit: await n(auditAdmin, `SELECT count(*) AS n FROM audit_record WHERE changes::text LIKE '%' || $1 || '%' OR "resourceId"::text = $1`, [p.paymentId]),
    });
    /** Every audit record that names the payment, its refund attempts or its Billing cases, by action. */
    const auditTrail = async (p: { paymentId: string; paymentRequestId: string }) => {
      const ids = [p.paymentId, p.paymentRequestId,
        ...(await paymentAdmin.query(`SELECT id::text FROM refund_attempt WHERE "paymentId" = $1`, [p.paymentId])).rows.map((r) => r.id as string),
        ...(await paymentAdmin.query(`SELECT id::text FROM provider_transaction_fact WHERE "paymentId" = $1`, [p.paymentId])).rows.map((r) => r.id as string),
        ...(await billingAdmin.query(`SELECT id::text FROM reconciliation_case WHERE "paymentId" = $1 OR "paymentRequestId" = $2`, [p.paymentId, p.paymentRequestId])).rows.map((r) => r.id as string),
        ...(await billingAdmin.query(`SELECT id::text FROM refund_case WHERE "paymentId" = $1`, [p.paymentId])).rows.map((r) => r.id as string)];
      return (await auditAdmin.query(`SELECT action, count(*)::int AS n FROM audit_record WHERE "resourceId"::text = ANY($1::text[]) OR changes::text LIKE '%' || $2 || '%'
        GROUP BY action ORDER BY action`, [ids, p.paymentId])).rows;
    };
    const caseRead = async (caseId: string) => {
      const r = await call(B1, 'GET', owners.a.token, `/billing/admin/refund-cases/${caseId}`);
      return { status: r.status, caseStatus: r.json?.status, relays: (r.json?.relays ?? r.json?.authorizations ?? []).map((x: Record<string, unknown>) => x.attemptStatus) };
    };
    /** The Owner's second refund case for the same payment, relayed with a valid receipt: Payment's answer (FC-5) decides. */
    async function secondRefund(paymentId: string, amount: number) {
      const opened = await call(B1, 'POST', owners.a.token, '/billing/admin/refund-cases', { paymentId, reason: 'customer_request' });
      if (opened.status !== 201) return { open: [opened.status, opened.json?.code ?? null] };
      const r = await receipt(owners.a, 'refund.authorize', { operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: opened.json.id, paymentId, amount,
        currency: 'TND', reason: 'customer_request', legalOverride: false });
      const relay = await call(B1, 'POST', owners.a.token, `/billing/admin/refund-cases/${opened.json.id}/authorizations`, { receiptSecret: r.secret });
      return { open: [opened.status, null], relay: [relay.status, relay.json?.code ?? null] };
    }
    /** A relay the Owner approved with a receipt bound to another reason: Auth refuses it, the attempt ends `authorization_refused` (never dispatched). */
    async function refusedRelay(paymentId: string, amount: number) {
      const opened = await call(B1, 'POST', owners.a.token, '/billing/admin/refund-cases', { paymentId, reason: 'customer_request' });
      expect(opened.status, `${JSON.stringify(opened.json)}\n${tails()}`).toBe(201);
      const caseId = opened.json.id as string;
      const r = await receipt(owners.a, 'refund.authorize', { operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId, amount, currency: 'TND',
        reason: 'duplicate_charge', legalOverride: false });
      const relay = await call(B1, 'POST', owners.a.token, `/billing/admin/refund-cases/${caseId}/authorizations`, { receiptSecret: r.secret });
      const attemptId = (await one(billingAdmin, `SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [caseId]))!.id as string;
      return { caseId, attemptId, relay: [relay.status, relay.json?.code ?? null] };
    }
    const cancelCase = async (caseId: string) => {
      const r = await call(B1, 'POST', owners.a.token, `/billing/admin/refund-cases/${caseId}/cancel`, undefined);
      return [r.status, r.json?.code ?? null];
    };
    /** Replays the identical notification and reports whether anything changed anywhere. */
    async function replay(scenario: string, p: { paymentId: string; paymentRequestId: string }, raw: string) {
      const before = { counts: await counts(p), fin: await financial(p) };
      const status = await signedRaw(raw);
      await settle();
      const after = { counts: await counts(p), fin: await financial(p) };
      const unchanged = JSON.stringify(before) === JSON.stringify(after);
      record(scenario, 'replay', { status, unchanged, before: before.counts, after: after.counts });
      return unchanged;
    }

    // ═══════════════════════════════════════════════════════════════ DO-73 CERTIFICATION (BIL-33 P; U-1 to U-7)
    const unallocated = (factId: string) => one(billingAdmin, `SELECT c.id, c."companyId", c."paymentId", c.amount, c.currency, c.detail, c."captureFactId", r.kind FROM reconciliation_case c
      LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id WHERE c."caseType" = 'refund_fact_unallocated' AND c."evidenceKey" = $1`, [factId]);
    const unallocatedEvidence = (caseId: string) => one(billingAdmin, `SELECT "paymentId", "refundFactId", "refundAttemptId", "relayId", "captureFactId", "blockedReason"
      FROM reconciliation_unallocated_evidence WHERE "caseId" = $1`, [caseId]);
    const waitUnallocated = (factId: string) => waitFor(async () => !!(await unallocated(factId)), 90_000, `the unallocated case of ${factId}\n${tails()}`);
    const factIdOf = async (txn: string) => (await one(paymentAdmin, `SELECT id FROM provider_transaction_fact WHERE "providerTxnId" = $1 AND kind = 'refund'`, [txn]))!.id as string;
    const blockAuditRecords = async (factId: string) => (await auditAdmin.query(`SELECT changes FROM audit_record WHERE action = 'refund_fact.allocation_blocked' AND "resourceId"::text = $1`, [factId])).rows;
    const openedRecords = async (caseId: string) => n(auditAdmin, `SELECT count(*) AS n FROM audit_record WHERE action = 'reconciliation_case.opened' AND "resourceId"::text = $1`, [caseId]);
    /** Billing's money and Payment's money of one payment, without the reconciliation cases: discovery may change none of it. */
    const money2 = async (p: { paymentId: string; paymentRequestId: string }, org?: string) => financial(p, org);
    const casesOf = async (p: { paymentId: string; paymentRequestId: string }) => (await billingCases(p)).map((c) => `${c.caseType}:${c.kind ?? 'open'}:${c.reason ?? ''}`).sort();
    /** Hide the evidence from Billing (Payment unavailable for this kind), record a block, take the "before discovery" snapshot, then let Billing read. */
    async function blockThenDiscover(S: string, p: { paymentId: string; paymentRequestId: string }, org: string | undefined, raw: string, txn: string, settled: () => Promise<unknown> = async () => undefined) {
      hidden.blocked = true;
      let before: unknown;
      let casesBefore: string[] = [];
      try {
        expect(await signedRaw(raw)).toBe(200);
        await waitBlock(txn);
        await settled(); // what the block itself sets in motion elsewhere (Billing's relay mirror, the discrepancy case) lands first
        await settle();
        before = await money2(p, org);
        casesBefore = await casesOf(p);
        expect(await unallocated(await factIdOf(txn)), `${S}: hidden from Billing`).toBeUndefined();
      } finally {
        hidden.blocked = false;
      }
      const factId = await factIdOf(txn);
      await waitUnallocated(factId);
      await settle(); // both workers pass again
      const after = await money2(p, org);
      expect(after, `${S}: discovery changes no financial record on either side`).toEqual(before);
      const casesAfter = await casesOf(p);
      expect(casesAfter.filter((c) => !casesBefore.includes(c)), `${S}: discovery adds exactly the one case`).toEqual(['refund_fact_unallocated:open:']);
      record(S, 'discovered', { before: casesBefore, after: casesAfter });
      return factId;
    }
    const expectOneCase = async (S: string, factId: string, expected: Record<string, unknown>, attemptId: string | null) => {
      const c = (await unallocated(factId))!;
      expect(c, S).toMatchObject({ companyId: COMPANY, kind: null, ...expected });
      const e = (await unallocatedEvidence(c.id))!;
      expect(e, S).toMatchObject({ refundFactId: factId, refundAttemptId: attemptId, relayId: attemptId, blockedReason: expected.detail });
      expect(e.captureFactId, S).toBe(c.captureFactId);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_fact_unallocated' AND "evidenceKey" = $1`, [factId]), S).toBe(1);
      await recordedOnce(c.id, 'refund_fact_unallocated'); // two Billing processes: one case, one evidence row, one Audit record
      const audits = await blockAuditRecords(factId);
      expect(audits, S).toHaveLength(1);
      expect(Object.keys(audits[0].changes).sort(), S).toEqual(['amount', 'payment_id', 'reason', 'refund_attempt_id']);
      return c;
    };
    const ackAll = async (caseId: string) => {
      const out: Record<string, unknown> = {};
      for (const reason of ['reviewed_no_financial_effect', 'provider_statement_reviewed', 'duplicate_evidence_reviewed']) {
        const a = await ack(B1, caseId, reason);
        out[reason] = [a.status, a.json?.code ?? null];
      }
      return out;
    };
    const discrepancyCase = async (attemptId: string) => one(billingAdmin, `SELECT c.id, r.kind, r.reason FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
      WHERE c."caseType" = 'refund_discrepancy' AND c."evidenceKey" = $1`, [attemptId]);


    // ═══════════════════════════════════════════════════════════════ DO-74 CERTIFICATION (observer side; BIL-33 Q)
    const ageWebhook = async (providerEventId: string) => {
      const cl = await paymentAdmin.connect();
      try {
        await cl.query(`SET session_replication_role = replica`);
        await cl.query(`UPDATE webhook_event SET "receivedAt" = now() - interval '301 seconds' WHERE "providerEventId" = $1`, [providerEventId]);
      } finally {
        await cl.query(`SET session_replication_role = origin`);
        cl.release();
      }
    };
    /** The provider reports the refund `txn` under a reference Payment cannot match; past the grace window it is kept as an UNMATCHED fact. */
    async function unmatchedRefund(txn: string, amount: number) {
      const eventId = `do74_u_${randomUUID()}`;
      const raw = JSON.stringify({ eventId, type: 'refund.succeeded', reference: randomUUID(), providerTransactionId: txn, amount, currency: 'TND' });
      expect(await signedRaw(raw)).toBe(200);
      await ageWebhook(eventId);
      expect(await signedRaw(raw)).toBe(200);
      const f = await one(paymentAdmin, `SELECT id, "paymentId", "refundAttemptId" FROM provider_transaction_fact WHERE "providerTxnId" = $1 AND kind = 'refund'`, [txn]);
      expect(f, `the unmatched fact\n${tails()}`).toBeDefined();
      return f!.id as string;
    }
    /** The provider's report of `txn` naming `attemptId` (its own reference): a signed notification; a new notification id unless `eventId` is given. */
    const reportFor = (attemptId: string, txn: string, amount: number, eventId = `do74_o_${randomUUID()}`) =>
      JSON.stringify({ eventId, type: 'refund.succeeded', reference: attemptId, providerTransactionId: txn, amount, currency: 'TND' });
    const observationsOf = (attemptId: string) => paymentAdmin.query(`SELECT id, "factId", "paymentId" FROM provider_transaction_fact_conflict WHERE "refundAttemptId" = $1 ORDER BY id`, [attemptId])
      .then((r) => r.rows as { id: string; factId: string; paymentId: string }[]);
    const waitObservations = (attemptId: string, count: number) => waitFor(async () => (await observationsOf(attemptId)).length === count, 30_000, `${count} observation(s)\n${tails()}`);
    const observationCase = (attemptId: string) => one(billingAdmin, `SELECT c.id, c."companyId", c."paymentId", c.amount, c.currency, c.detail, c."captureFactId", r.kind FROM reconciliation_case c
      LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id WHERE c."caseType" = 'refund_observation_conflict' AND c."evidenceKey" = $1`, [attemptId]);
    const observationEvidence = (caseId: string) => one(billingAdmin, `SELECT "paymentId", "refundAttemptId", "observationId", "captureFactId" FROM reconciliation_observation_evidence WHERE "caseId" = $1`, [caseId]);
    const captureOf = async (refundCaseId: string) => (await one(billingAdmin, `SELECT "captureFactId" FROM refund_case WHERE id = $1`, [refundCaseId]))!.captureFactId as string | null;
    /** Everything Billing holds and shows about one observation case: its row, its evidence, the Owner's read and the Owner's list entry. */
    const caseSurface = async (caseId: string, owner: Owner = owners.a) => JSON.stringify({
      row: await one(billingAdmin, `SELECT * FROM reconciliation_case WHERE id = $1`, [caseId]),
      evidence: await one(billingAdmin, `SELECT * FROM reconciliation_observation_evidence WHERE "caseId" = $1`, [caseId]),
      read: (await call(B1, 'GET', owner.token, `/billing/admin/reconciliation-cases/${caseId}`)).json,
      listed: ((await call(B2, 'GET', owner.token, '/billing/admin/reconciliation-cases?status=open&type=refund_observation_conflict')).json?.items ?? []).filter((x: { id: string }) => x.id === caseId),
      opened: (await billingAdmin.query(`SELECT payload FROM outbox WHERE name = 'audit.reconciliation_case.opened' AND payload->'resource'->>'id' = $1`, [caseId])).rows,
    });
    /** R1 up to the attempt's own report: the unmatched fact, then the report; Payment's own effects (discrepancy) and Billing's mirror and review settle. */
    async function r1(p: { paymentId: string }, r: { attemptId: string }, amount: number) {
      const txn = await providerRef(r.attemptId);
      const factId = await unmatchedRefund(txn, amount);
      const raw = reportFor(r.attemptId, txn, amount);
      expect(await signedRaw(raw)).toBe(200);
      await waitObservations(r.attemptId, 1);
      await mirrored(r.attemptId, 'discrepancy');
      await waitFor(async () => !!(await discrepancyCase(r.attemptId)), 60_000, `the discrepancy case\n${tails()}`);
      return { txn, factId, raw, paymentId: p.paymentId };
    }
    const billingOnly = (f: Awaited<ReturnType<typeof financial>>) => ({ refundCases: f.refundCases, relays: f.relays, disputeLosses: f.disputeLosses, losses: f.losses, obligations: f.obligations,
      purchases: f.purchases, restrictions: f.restrictions, allocations: f.allocations, authorizations: f.authorizations, balance: f.balance, attempts: f.attempts });

    for (const kind of ['assisted', 'direct'] as const) {
      it(`D1/D2/D3 (${kind}, R1): the attempt's own refund reported first under an unknown reference, then by the attempt: ONE figure-free case per observing attempt, never acknowledgeable; the discrepancy can no longer be closed as a duplicate or as no financial effect; replays add nothing; no money moves; S0-C14 still waits and S0-C15A still opens after a chargeback`, async () => {
        const { o, p } = await buy(kind);
        const r = await relayed(p.paymentId, p.amount);
        const txn = await providerRef(r.attemptId);
        const factId = await unmatchedRefund(txn, p.amount);
        await settle();
        expect(await observationCase(r.attemptId), 'an unmatched fact alone is no observation of this payment').toBeUndefined();
        const eventId = `do74_o_${randomUUID()}`;
        const raw = reportFor(r.attemptId, txn, p.amount, eventId);
        expect(await signedRaw(raw)).toBe(200);
        await waitObservations(r.attemptId, 1);
        await mirrored(r.attemptId, 'discrepancy'); // Billing's existing relay mirror (not DO-74) settles before the baseline
        await waitFor(async () => !!(await discrepancyCase(r.attemptId)), 60_000, `the discrepancy case\n${tails()}`);
        const before = await financial(p, o?.org);
        await waitCase(() => observationCase(r.attemptId), 'the observation case');
        await settle();
        const c = (await observationCase(r.attemptId))!;
        const capture = await captureOf(r.caseId);
        expect(c).toMatchObject({ companyId: COMPANY, paymentId: p.paymentId, amount: null, currency: null, detail: null, captureFactId: capture, kind: null });
        const [obs] = await observationsOf(r.attemptId);
        expect(obs!.factId).toBe(factId);
        expect(await observationEvidence(c.id)).toEqual({ paymentId: p.paymentId, refundAttemptId: r.attemptId, observationId: obs!.id, captureFactId: capture });
        expect(await caseSurface(c.id), 'nothing of the contradicted fact is held or shown by Billing').not.toContain(factId);
        await recordedOnce(c.id, 'refund_observation_conflict');
        expect(await openedIntents(c.id)).toBe(1);
        await waitFor(async () => (await conflictAudit(factId)).length === 1, 60_000, `Payment's audit of the observation\n${audit.tail()}`);
        // D3: the same notification again, then two new notification ids (one with another amount): more observations at Payment, the SAME case
        expect(await signedRaw(raw)).toBe(200);
        expect(await signedRaw(reportFor(r.attemptId, txn, p.amount))).toBe(200);
        expect(await signedRaw(reportFor(r.attemptId, txn, p.amount + 7))).toBe(200);
        await waitObservations(r.attemptId, 3);
        await settle();
        expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_observation_conflict' AND "paymentId" = $1`, [p.paymentId])).toBe(1);
        expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_observation_evidence WHERE "paymentId" = $1`, [p.paymentId])).toBe(1);
        expect(await openedIntents(c.id)).toBe(1);
        expect((await observationEvidence(c.id))!.observationId, 'the identity never moves').toBe(obs!.id);
        // the R1 defect, corrected: what the Owner may state
        for (const reason of ['reviewed_no_financial_effect', 'provider_statement_reviewed', 'duplicate_evidence_reviewed']) {
          expect((await ack(B1, c.id, reason)).json?.code, reason).toBe('reconciliation_case_not_acknowledgeable');
        }
        const d = (await discrepancyCase(r.attemptId))!;
        const dup = await ack(B2, d.id, 'duplicate_evidence_reviewed');
        expect([dup.status, dup.json?.code]).toEqual([409, 'reconciliation_case_contested']);
        const nfe = await ack(B1, d.id, 'reviewed_no_financial_effect');
        expect([nfe.status, nfe.json?.code]).toEqual([409, 'reconciliation_case_contested']);
        expect((await ack(B2, d.id, 'provider_statement_reviewed')).status).toBe(200);
        expect(await contestCase(factId), 'never S0-C15B\'s case: the fact is not this payment\'s').toBeUndefined();
        expect(await financial(p, o?.org), 'no money moved on either side').toEqual(before);
        expect((await one(paymentAdmin, `SELECT "paymentId", "refundAttemptId" FROM provider_transaction_fact WHERE id = $1`, [factId]))).toEqual({ paymentId: null, refundAttemptId: null });
        // S0-C14 and S0-C15A afterwards (unchanged): a verified full chargeback; the effect waits on the live attempt; the exposure opens; nothing is written off
        const disputeId = await dispute(p.paymentId, p.amount);
        await hasExposure(disputeId);
        await settle();
        expect(await caseOf('chargeback_effect_waiting', disputeId), 'S0-C14 still waits').toBeDefined();
        const after = await financial(p, o?.org);
        expect(after.losses, 'no write-off').toEqual([]);
        expect(after.obligations, 'no obligation').toEqual([]);
      }, T);
    }

    it('D4 (control, order reversed): the attempt\'s own report first, then the same refund under an unknown reference: one matched fact, no observation, no case', async () => {
      const { p } = await buy('direct');
      const r = await relayed(p.paymentId, p.amount);
      const txn = await providerRef(r.attemptId);
      expect(await rawRefund(r.attemptId, p.amount, txn)).toBe(200);
      await completedCase(r.caseId);
      await unmatchedRefund(txn, p.amount);
      await settle();
      expect(await observationsOf(r.attemptId)).toEqual([]);
      expect((await one(paymentAdmin, `SELECT "paymentId" FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [txn]))!.paymentId).toBe(p.paymentId);
      expect(await observationCase(r.attemptId)).toBeUndefined();
    }, T);

    it('D5 (R2 control): a contradiction of the payment\'s OWN matched fact stays S0-C15B\'s refund_fact_contested; no observation case', async () => {
      const { p } = await buy('direct');
      const r = await relayed(p.paymentId, p.amount);
      const txn = await providerRef(r.attemptId);
      expect(await rawRefund(r.attemptId, p.amount, txn)).toBe(200);
      await completedCase(r.caseId);
      expect(await rawRefund(r.attemptId, p.amount - 1, txn)).toBe(200);
      const factId = await refundFactOf(txn);
      await waitCase(() => contestCase(factId), 'the S0-C15B contest case');
      await settle();
      expect(await observationCase(r.attemptId)).toBeUndefined();
    }, T);

    it('D12 (R3, UNCHANGED AND STILL AN OPEN RISK): an unmatched refund naming a FAILED attempt\'s own provider reference, never reported by the attempt, then a chargeback: no observation exists, so no case; S0-C14 applies the loss effect (the potential unsafe write-off is NOT addressed by DO-74)', async () => {
      const { p } = await buy('direct');
      const r = await relayed(p.paymentId, p.amount);
      const txn = await providerRef(r.attemptId);
      await refundOutcome(r.attemptId, 'failed');
      await mirrored(r.attemptId, 'failed');
      const factId = await unmatchedRefund(txn, p.amount);
      await settle();
      expect(await observationsOf(r.attemptId)).toEqual([]);
      const disputeId = await dispute(p.paymentId, p.amount);
      await waitFor(async () => (await n(billingAdmin, `SELECT count(*) AS n FROM dispute_loss_effect WHERE "disputeId" = $1`, [disputeId])) === 1, 60_000, `the loss effect\n${tails()}`);
      await settle();
      expect(await observationCase(r.attemptId)).toBeUndefined();
      const s = await snapshot(p);
      record('D12-R3', 'unchanged_risk', { losses: s.billing.losses, obligations: s.billing.obligations, unmatchedFact: await one(paymentAdmin, `SELECT "paymentId", amount FROM provider_transaction_fact WHERE id = $1`, [factId]),
        attemptProviderRefundIdEqualsFact: true, openCases: s.billing.openCases });
      expect(s.billing.losses.length, 'R3: the direct write-off is applied although Payment holds an unmatched refund under the failed attempt\'s own provider reference').toBe(1);
    }, T);

    it('D6 (cross-payment, same Company): B\'s attempt reports A\'s matched refund: B gets one case naming nothing of A; A\'s Billing view, cases and money are unchanged (O-2 stays open)', async () => {
      const { p: pa } = await buy('direct');
      const a = await relayed(pa.paymentId, pa.amount);
      const txnA = await providerRef(a.attemptId);
      expect(await rawRefund(a.attemptId, pa.amount, txnA)).toBe(200);
      await completedCase(a.caseId);
      await settle();
      const aFactId = await refundFactOf(txnA);
      const aCases = await billingCases(pa);
      const aMoney = billingOnly(await financial(pa));
      const { p: pb } = await buy('direct');
      const b = await relayed(pb.paymentId, pb.amount);
      expect(await signedRaw(reportFor(b.attemptId, txnA, pb.amount))).toBe(200);
      await waitObservations(b.attemptId, 1);
      expect((await observationsOf(b.attemptId))[0]!.factId).toBe(aFactId);
      await mirrored(b.attemptId, 'discrepancy');
      await waitFor(async () => !!(await discrepancyCase(b.attemptId)), 60_000, `B's discrepancy case\n${tails()}`);
      const bBefore = await financial(pb);
      await waitCase(() => observationCase(b.attemptId), 'B\'s observation case');
      await settle();
      const c = (await observationCase(b.attemptId))!;
      expect(c).toMatchObject({ paymentId: pb.paymentId, amount: null, currency: null, detail: null, kind: null });
      const surface = await caseSurface(c.id);
      for (const foreign of [aFactId, txnA, pa.paymentId, pa.paymentRequestId, a.attemptId, a.caseId]) expect(surface, `B's case names nothing of A (${foreign})`).not.toContain(foreign);
      expect(await billingCases(pa), 'A\'s Billing cases are unchanged').toEqual(aCases);
      expect(billingOnly(await financial(pa)), 'A\'s money is unchanged').toEqual(aMoney);
      expect(await financial(pb), 'B\'s money is unchanged').toEqual(bBefore);
      const d = (await discrepancyCase(b.attemptId))!;
      expect((await ack(B1, d.id, 'duplicate_evidence_reviewed')).json?.code).toBe('reconciliation_case_contested');
    }, T);

    it('D7 (cross-Company): Company A\'s attempt reports Company X\'s matched refund: A\'s case names nothing of X; X\'s Owner sees nothing of A at Billing (list, read) or Payment; X\'s cases and money are unchanged', async () => {
      const px = await directPurchase(owners.x.company);
      // LABELLED TEST AID: Billing's refund route serves Company A's platform only in this harness (X's Owner gets its collapsed 404), so X's refund is
      // requested directly at Payment with the producer's credential and a REAL receipt of X's Owner; Payment dispatches it and records X's matched fact
      expect((await call(B1, 'POST', owners.x.token, '/billing/admin/refund-cases', { paymentId: px.paymentId, reason: 'customer_request' })).status).toBe(404);
      const x = { caseId: randomUUID(), attemptId: randomUUID() };
      const rx = await receipt(owners.x, 'refund.authorize', { operation: 'refund', audience: 'payment-service', companyId: owners.x.company, refundCaseId: x.caseId,
        paymentId: px.paymentId, amount: px.amount, currency: 'TND', reason: 'customer_request', legalOverride: false });
      const made = await call(PAYMENT_URL, 'POST', billingToPaymentToken.token, `/payment/payments/${px.paymentId}/refunds`, { refundAttemptId: x.attemptId, refundCaseId: x.caseId,
        amount: px.amount, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: rx.secret });
      expect(made.status, JSON.stringify(made.json)).toBe(201);
      await waitFor(async () => (await one(paymentAdmin, `SELECT status FROM refund_attempt WHERE id = $1`, [x.attemptId]))?.status === 'submitted', 30_000, `Payment to dispatch X's refund\n${tails()}`);
      const txnX = await providerRef(x.attemptId);
      expect(await rawRefund(x.attemptId, px.amount, txnX)).toBe(200);
      await waitFor(async () => (await one(paymentAdmin, `SELECT status FROM refund_attempt WHERE id = $1`, [x.attemptId]))?.status === 'succeeded', 30_000, `X's refund\n${tails()}`);
      await settle();
      const xFactId = await refundFactOf(txnX);
      const xCases = await billingCases(px);
      const xMoney = billingOnly(await financial(px));
      const { p: pa } = await buy('direct');
      const a = await relayed(pa.paymentId, pa.amount);
      expect(await signedRaw(reportFor(a.attemptId, txnX, pa.amount))).toBe(200);
      await waitObservations(a.attemptId, 1);
      await mirrored(a.attemptId, 'discrepancy');
      await waitCase(() => observationCase(a.attemptId), 'A\'s observation case');
      await settle();
      const c = (await observationCase(a.attemptId))!;
      expect(c).toMatchObject({ companyId: COMPANY, paymentId: pa.paymentId, amount: null, currency: null });
      const surface = await caseSurface(c.id);
      for (const foreign of [xFactId, txnX, px.paymentId, px.paymentRequestId, x.attemptId, x.caseId, owners.x.company]) expect(surface, `A's case names nothing of X (${foreign})`).not.toContain(foreign);
      // PAY-08 for A's producer: only A's own rows
      const pay08 = (await call(PAYMENT_URL, 'GET', billingToPaymentToken.token, `/payment/payments/${pa.paymentId}/refunds`)).json;
      expect(pay08.observationConflicts).toEqual([{ refundAttemptId: a.attemptId, conflictIds: (await observationsOf(a.attemptId)).map((r) => r.id).sort(), observations: 1, firstObservedAt: expect.any(String) }]);
      for (const foreign of [xFactId, px.paymentId, x.attemptId, owners.x.company]) expect(JSON.stringify(pay08), foreign).not.toContain(foreign);
      // X's Owner: nothing of A at Billing or Payment
      const xList = (await call(B1, 'GET', owners.x.token, '/billing/admin/reconciliation-cases?status=open&type=refund_observation_conflict')).json?.items as { id: string }[];
      expect(xList.some((i) => i.id === c.id)).toBe(false);
      expect((await call(B2, 'GET', owners.x.token, `/billing/admin/reconciliation-cases/${c.id}`)).status).toBe(404);
      expect((await call(B1, 'POST', owners.x.token, `/billing/admin/reconciliation-cases/${c.id}/acknowledgement`, { reason: 'provider_statement_reviewed' })).status).toBe(404);
      const xItems = (await call(PAYMENT_URL, 'GET', owners.x.token, '/payment/admin/reconciliation-items?kind=fact_conflict&limit=200')).json?.items as { paymentId: string }[];
      expect(xItems.some((i) => i.paymentId === pa.paymentId), 'X\'s Owner sees no fact_conflict item of A').toBe(false);
      expect(await billingCases(px), 'X\'s Billing cases are unchanged').toEqual(xCases);
      expect(billingOnly(await financial(px)), 'X\'s money is unchanged').toEqual(xMoney);
      // DISCLOSED, PRE-EXISTING (unchanged, not widened): Payment's existing fact_conflict item for A's Owner carries X's fact's opaque id (never its figures, reference,
      // payment or Company); Payment's provider_fact_conflict.recorded audit, under A's organization, names that fact as its resource
      const aItems = ((await call(PAYMENT_URL, 'GET', owners.a.token, '/payment/admin/reconciliation-items?kind=fact_conflict&limit=200')).json?.items as { paymentId: string; factId: string }[])
        .filter((i) => i.paymentId === pa.paymentId);
      record('D7', 'pre_existing_disclosure', { ownerItemCarriesForeignFactId: aItems.some((i) => i.factId === xFactId), itemKeys: Object.keys(aItems[0] ?? {}).sort() });
      expect(aItems.some((i) => i.factId === xFactId)).toBe(true);
      for (const foreign of [txnX, px.paymentId, x.attemptId, owners.x.company]) expect(JSON.stringify(aItems), foreign).not.toContain(foreign);
    }, T);

    it('D8 (LABELLED TEST AID: a lock on the relay row pauses a worker between the case and its evidence): no case is visible meanwhile; two processes open one case, one evidence row, one audit intent', async () => {
      const { p } = await buy('direct');
      const r = await relayed(p.paymentId, p.amount);
      const txn = await providerRef(r.attemptId);
      await unmatchedRefund(txn, p.amount);
      await settle();
      const hold = await billingAdmin.connect();
      await hold.query('BEGIN');
      await hold.query('SELECT 1 FROM refund_authorization_relay WHERE id = $1 FOR UPDATE', [r.attemptId]);
      try {
        expect(await signedRaw(reportFor(r.attemptId, txn, p.amount))).toBe(200);
        await waitObservations(r.attemptId, 1);
        await waitFor(async () => (await n(billingAdmin, `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE '%reconciliation_observation_evidence%'`)) >= 1,
          60_000, `a worker to wait between its case and its evidence\n${tails()}`);
        await pause(12_000); // both processes pass meanwhile
        expect(await observationCase(r.attemptId), 'an uncommitted case is invisible: no orphan can be read').toBeUndefined();
      } finally {
        await hold.query('ROLLBACK');
        hold.release();
      }
      await waitCase(() => observationCase(r.attemptId), 'the case after the pause');
      await settle();
      const c = (await observationCase(r.attemptId))!;
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_observation_conflict' AND "evidenceKey" = $1`, [r.attemptId])).toBe(1);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_observation_evidence WHERE "refundAttemptId" = $1`, [r.attemptId])).toBe(1);
      expect(await openedIntents(c.id)).toBe(1);
      await recordedOnce(c.id, 'refund_observation_conflict');
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case c WHERE c."caseType" = 'refund_observation_conflict'
        AND NOT EXISTS (SELECT 1 FROM reconciliation_observation_evidence e WHERE e."caseId" = c.id)`)).toBe(0);
    }, T);

    it('D9 (B-D6): Payment unavailable, a malformed answer, an older Payment without the field, or a malformed field: nothing opens and nothing changes; the case opens once the reads agree', async () => {
      const { p } = await buy('direct');
      const r = await relayed(p.paymentId, p.amount);
      proxyMode.set(p.paymentId, 'pay08_obs_absent'); // an older Payment while the observation is recorded (Billing's relay mirror still reads PAY-08)
      let before: unknown;
      try {
        await r1(p, r, p.amount);
        await settle();
        before = await financial(p);
        for (const mode of ['pay08_503', 'pay08_malformed', 'pay08_obs_absent', 'pay08_obs_malformed'] as const) {
          proxyMode.set(p.paymentId, mode);
          await settle();
          expect(await observationCase(r.attemptId), mode).toBeUndefined();
        }
      } finally {
        proxyMode.delete(p.paymentId);
      }
      await waitCase(() => observationCase(r.attemptId), 'the observation case once the reads agree');
      expect(await financial(p)).toEqual(before);
      const log = billing1.tail() + billing2.tail();
      expect(log).toContain('reason=observation_conflicts_malformed');
      expect(log).toContain('reason=fact_not_stated');
    }, T);

    /**
     * D13, two modes (never skipped):
     *  - MIXED VERSIONS (DO74_OLD_BILLING_DIR names a main build without DO-74, migrations to 0053): that OLD Billing serves the history database while the
     *    observation is recorded and reads Payment's NEW PAY-08 (with observationConflicts): it opens its discrepancy case, opens no contest, keeps working,
     *    and its Owner acknowledges the discrepancy as a duplicate (the historical R1 outcome).
     *  - REPOSITORY MIGRATIONS (unset, as in CI): NO old binary runs. The history database is migrated with this repository's migrations through 0053 only.
     *    LABELLED TEST AID: the purchase and relay are made by THIS tree's Billing on that schema, which is STOPPED before the observation is recorded.
     * Both then apply 0054 and start the DO-74 Billing: exactly one case with its evidence; Owner-visible, never acknowledgeable; no money moves.
     */
    it(`D13 (${OLD_BILLING_DIR ? 'mixed versions: an old main Billing reads the new Payment' : 'repository migrations to 0053, no old binary'}): an observation recorded before 0054 opens exactly one case at the first DO-74 pass; an earlier acknowledgement stands; no money moves`, async () => {
      await billing1.stop();
      await billing2.stop();
      const histDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingdo74hist');
      const hist = new pg.Pool({ connectionString: histDb.url });
      const histN = async (sql: string, params: unknown[] = []) => Number((await hist.query(sql, params)).rows[0].n);
      let pre: LiveService | undefined;
      let fresh: LiveService | undefined;
      let pre0054Dir: string | undefined;
      try {
        if (OLD_BILLING_DIR) {
          await runMigrations(histDb.url, [kitMigrationsDir, `${OLD_BILLING_DIR}/db/migrations/`]);
        } else {
          pre0054Dir = mkdtempSync(join(tmpdir(), 'do74-d13-pre0054-'));
          const names = readdirSync(`${BILLING_DIR}/db/migrations/`).filter((f) => f.endsWith('.sql') && f < '0054').sort();
          for (const f of names) copyFileSync(`${BILLING_DIR}/db/migrations/${f}`, join(pre0054Dir, f));
          expect(names.at(-1), 'D13: the copied set ends at 0053').toMatch(/^0053_/);
          await runMigrations(histDb.url, [kitMigrationsDir, pre0054Dir]);
        }
        expect(await histN(`SELECT count(*) AS n FROM schema_migrations WHERE name ~ '^0053_'`), 'D13: 0053 applied').toBe(1);
        expect(await histN(`SELECT count(*) AS n FROM schema_migrations WHERE name ~ '^[0-9]{4}_' AND name >= '0054'`), 'D13: 0054 not applied').toBe(0);
        expect((await hist.query(`SELECT to_regclass('reconciliation_observation_evidence') AS t`)).rows[0]).toEqual({ t: null });
        await hist.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [TEST_PLATFORM, COMPANY, randomUUID()]);
        const envOf = (port: number) => ({ ...billingEnv(port), DATABASE_URL: histDb.url });
        pre = spawnService(OLD_BILLING_DIR ? 'billing-main' : 'billing-pre0054-standin', OLD_BILLING_DIR || BILLING_DIR, envOf(PORT.b3));
        await waitForHealth(`http://127.0.0.1:${PORT.b3}/health`, 30_000);
        await waitFor(async () => pre!.tail().includes('financial_reconciliation_check_passed'), 30_000, `the pre-0054 Billing to start\n${pre.tail()}`);
        const HB = `http://127.0.0.1:${PORT.b3}`;
        const pid = (await hist.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
          VALUES ('test-producer', 'company', $1, $2, 'Personal plan', 'active', 'personal', $3) RETURNING id`, [COMPANY, `h-${randomUUID().slice(0, 8)}`, TEST_PLATFORM])).rows[0].id;
        const prc = (await hist.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, $2, 'TND', $3, 'recurring', 'month', 1) RETURNING id`,
          [pid, `h-${randomUUID().slice(0, 8)}`, PRICE])).rows[0].id;
        const inv = await call(HB, 'POST', producerToken.token, '/billing/invoices', { invoiceRequestId: randomUUID(), seller: { type: 'company', id: COMPANY }, payer: { type: 'user', id: payerId },
          sourceType: 'contract', sourceId: `src-${randomUUID()}`, issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: prc, quantity: 1 }] });
        expect(inv.status, JSON.stringify(inv.json)).toBe(201);
        expect((await call(HB, 'POST', producerToken.token, `/billing/invoices/${inv.json.id}/issue`)).status).toBe(200);
        const pr = await call(HB, 'POST', producerToken.token, `/billing/invoices/${inv.json.id}/payment-requests`);
        await waitFor(async () => (await hist.query(`SELECT "paymentId" FROM payment_request WHERE id = $1 AND status = 'requested'`, [pr.json.id])).rows[0]?.paymentId != null, 30_000, `the payment\n${pre.tail()}`);
        const paymentId = (await hist.query(`SELECT "paymentId" FROM payment_request WHERE id = $1`, [pr.json.id])).rows[0].paymentId as string;
        const at = await attemptOf(paymentId, payerToken);
        await outcome(paymentId, at.id, { outcome: 'succeeded' });
        await waitFor(async () => (await histN(`SELECT count(*) AS n FROM subscription_purchase WHERE "invoiceId" = $1`, [inv.json.id])) === 1, 45_000, `the purchase\n${pre.tail()}`);
        const opened = await call(HB, 'POST', owners.a.token, '/billing/admin/refund-cases', { paymentId, reason: 'customer_request' });
        expect(opened.status, JSON.stringify(opened.json)).toBe(201);
        const rc = await receipt(owners.a, 'refund.authorize', { operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: opened.json.id, paymentId, amount: PRICE,
          currency: 'TND', reason: 'customer_request', legalOverride: false });
        expect((await call(HB, 'POST', owners.a.token, `/billing/admin/refund-cases/${opened.json.id}/authorizations`, { receiptSecret: rc.secret })).status).toBe(201);
        const attemptId = (await hist.query(`SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [opened.json.id])).rows[0].id as string;
        await waitFor(async () => (await one(paymentAdmin, `SELECT status FROM refund_attempt WHERE id = $1`, [attemptId]))?.status === 'submitted', 30_000, `dispatch\n${pre.tail()}`);
        if (!OLD_BILLING_DIR) { // the stand-in stops BEFORE the observation exists: no Billing process runs while it is recorded
          await pre.stop();
          pre = undefined;
        }
        const txn = await providerRef(attemptId);
        await unmatchedRefund(txn, PRICE);
        expect(await signedRaw(reportFor(attemptId, txn, PRICE))).toBe(200);
        await waitObservations(attemptId, 1);
        const disc = `SELECT c.id, r.kind, r.reason FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id WHERE c."caseType" = 'refund_discrepancy' AND c."evidenceKey" = $1`;
        if (pre) {
          // the OLD Billing reads the NEW Payment: its discrepancy case opens, no contest, no failure; its Owner closes the discrepancy as a duplicate (R1 as it was)
          await waitFor(async () => (await hist.query(disc, [attemptId])).rows.length === 1, 60_000, `the old Billing's discrepancy case\n${pre.tail()}`);
          await settle();
          expect(pre.tail()).toContain('reason=fact_not_stated');
          expect(pre.tail()).not.toContain('malformed');
          const d = (await hist.query(disc, [attemptId])).rows[0];
          expect((await call(HB, 'POST', owners.a.token, `/billing/admin/reconciliation-cases/${d.id}/acknowledgement`, { reason: 'duplicate_evidence_reviewed' })).status).toBe(200);
          await pre.stop();
          pre = undefined;
        }
        const histMoney = async () => ({
          refundCases: (await hist.query(`SELECT id, status FROM refund_case WHERE "paymentId" = $1 ORDER BY id`, [paymentId])).rows,
          relays: (await hist.query(`SELECT id FROM refund_authorization_relay WHERE "paymentId" = $1 ORDER BY id`, [paymentId])).rows,
          purchases: (await hist.query(`SELECT s.id, r.cause FROM subscription_purchase s LEFT JOIN subscription_purchase_reversal r ON r."purchaseId" = s.id WHERE s."invoiceId" = $1 ORDER BY s.id`, [inv.json.id])).rows,
          losses: await histN(`SELECT count(*) AS n FROM financial_loss`),
          obligations: await histN(`SELECT count(*) AS n FROM recovery_obligation`),
          earlierResolutions: (await hist.query(`SELECT "caseId", kind, reason FROM reconciliation_case_resolution ORDER BY "caseId"`)).rows,
          paymentFacts: (await paymentAdmin.query(`SELECT id, kind, amount, currency FROM provider_transaction_fact WHERE "paymentId" = $1 ORDER BY id`, [paymentId])).rows,
          paymentAllocations: await n(paymentAdmin, `SELECT count(*) AS n FROM refund_allocation WHERE "paymentId" = $1`, [paymentId]),
          paymentAttempts: (await paymentAdmin.query(`SELECT id, status, amount FROM refund_attempt WHERE "paymentId" = $1 ORDER BY id`, [paymentId])).rows,
        });
        const before = await histMoney();
        await runMigrations(histDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
        expect(await histN(`SELECT count(*) AS n FROM schema_migrations WHERE name ~ '^0054_'`), 'D13: 0054 now applied').toBe(1);
        expect(await histMoney(), 'D13: the migration changed nothing').toEqual(before);
        fresh = spawnService('billing-do74', BILLING_DIR, envOf(PORT.b4));
        const FB = `http://127.0.0.1:${PORT.b4}`;
        await waitForHealth(`${FB}/health`, 30_000);
        const caseQ = `SELECT c.id, c."companyId", c.amount, c.currency, c.detail, e."refundAttemptId", e."observationId" FROM reconciliation_case c
          JOIN reconciliation_observation_evidence e ON e."caseId" = c.id WHERE c."caseType" = 'refund_observation_conflict' AND c."evidenceKey" = $1`;
        await waitFor(async () => (await hist.query(caseQ, [attemptId])).rows.length === 1, 90_000, `the historical observation case\n${fresh.tail()}`);
        await settle();
        const c = (await hist.query(caseQ, [attemptId])).rows[0];
        expect(c).toMatchObject({ companyId: COMPANY, amount: null, currency: null, detail: null, refundAttemptId: attemptId, observationId: (await observationsOf(attemptId))[0]!.id });
        const list = (await call(FB, 'GET', owners.a.token, '/billing/admin/reconciliation-cases?status=open&type=refund_observation_conflict')).json?.items as { id: string }[];
        expect(list.some((x) => x.id === c.id), 'D13: Owner-visible').toBe(true);
        for (const reason of ['reviewed_no_financial_effect', 'provider_statement_reviewed', 'duplicate_evidence_reviewed']) {
          const r = await call(FB, 'POST', owners.a.token, `/billing/admin/reconciliation-cases/${c.id}/acknowledgement`, { reason });
          expect([r.status, r.json?.code], `D13: ${reason}`).toEqual([409, 'reconciliation_case_not_acknowledgeable']);
        }
        expect(await histN(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.reconciliation_case.opened' AND payload->'resource'->>'id' = $1`, [c.id]), 'D13: one Audit intent').toBe(1);
        const after = await histMoney();
        expect(after, 'D13: no money moved; the earlier acknowledgement (mixed mode) stands').toEqual(before);
        record('D13', 'historical', { mode: OLD_BILLING_DIR ? 'mixed_versions_old_binary' : 'repository_migrations_0053_no_old_binary', case: c, earlierResolutions: after.earlierResolutions });
      } finally {
        await pre?.stop();
        await fresh?.stop();
        await hist.end();
        await histDb.drop();
        if (pre0054Dir) rmSync(pre0054Dir, { recursive: true, force: true });
        billing1 = spawnService('billing1', BILLING_DIR, billingEnv(PORT.b1));
        billing2 = spawnService('billing2', BILLING_DIR, billingEnv(PORT.b2));
        await Promise.all([waitForHealth(`${B1}/health`, 30_000), waitForHealth(`${B2}/health`, 30_000)]);
      }
    }, T);
  },
);
