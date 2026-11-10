import { appendFileSync } from 'node:fs';


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
 * Core V2 R3 (BIL-33 R; PAY-08 I; the Owner's GO 2026-11-10): DETERMINISTIC CERTIFICATION that credible refund evidence after a FAILED refund attempt (a verified
 * unmatched refund fact, or a signature-verified refund notification still pending, under the attempt's own provider refund reference) HOLDS the loss's
 * automatic financial effect (a direct chargeback write-off, an assisted recovery obligation), records one append-only marker per relay, and keeps the
 * existing waiting and exposure cases Owner-visible; that unknown, absent, malformed or unavailable evidence holds as well; and that evidence surfacing after a
 * committed effect is detected without rewriting it. Across separately spawned processes (real Auth, Payment, Audit, TWO Billing processes, RabbitMQ).
 * DEVELOPMENT AND SIMULATION ONLY. Nothing here associates, allocates, completes, reverses or writes off anything. LABELLED TEST-ONLY FIXTURES and TEST AIDS:
 * signed notifications (`signedRaw`), `ageWebhook` (the 5-minute grace window), the proxy's R3 modes (PAY-08 without `failedAttemptEvidence`, or malformed),
 * and X's refund requested directly at Payment (R3-8, as DO-74 D7). No financial row is written by SQL.
 *
 * (The harness, from DO-74:)
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
const PORT = { auth: 13941, b1: 13942, b2: 13943, payment: 13944, audit: 13946, b3: 13947, b4: 13948 };
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
  'Core V2 R3-F1: the loss cases state recorded, unreconciled failed-attempt refund evidence (read-only; R3 harness (real Auth, Payment, Audit, TWO Billing processes, RabbitMQ with Billing\'s identity; simulation)',
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
    const proxyMode = new Map<string, 'drop_relay' | 'pay08_503' | 'pay08_malformed' | 'pay08_obs_absent' | 'pay08_obs_malformed' | 'pay08_fae_absent' | 'pay08_fae_malformed'>(); // DO-74: an older Payment; a malformed field
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
            // Core V2 R3 TEST AIDS: Payment's real answer without failedAttemptEvidence (an older Payment), or with a malformed one
            if (up.status === 200 && (obsMode === 'pay08_fae_absent' || obsMode === 'pay08_fae_malformed')) {
              const j = JSON.parse(text.toString('utf8')) as Record<string, unknown>;
              if (obsMode === 'pay08_fae_absent') delete j.failedAttemptEvidence;
              else j.failedAttemptEvidence = [{ refundAttemptId: 'not-a-uuid', state: 'clean' }];
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
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauthr3f1cert');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingr3f1cert');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymentr3f1cert');
      auditDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauditr3f1cert');
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


    const settle = () => pause(25_000);
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
    const ack = (via: string, id: string, reason: string, key?: string) => call(via, 'POST', owners.a.token, `/billing/admin/reconciliation-cases/${id}/acknowledgement`, { reason }, key);
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
    const conflictsOf = async (paymentId: string) => (await paymentAdmin.query(`SELECT id, kind, reason, amount, "chargebackTxnId", "chargebackAmount" FROM payment_dispute_observation
      WHERE "paymentId" = $1 AND disposition = 'conflict' ORDER BY "observedAt"`, [paymentId])).rows;
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
    const providerRef = async (attemptId: string) => (await one(paymentAdmin, `SELECT "providerRefundId" FROM refund_attempt WHERE id = $1`, [attemptId]))!.providerRefundId as string;
    /** The money of one payment, on both sides: S0-C15B may change none of it. */
    const financial = async (p: { paymentId: string; paymentRequestId: string }, org?: string) => {
      const s = await snapshot(p);
      return { facts: s.payment.facts, attempts: s.payment.refundAttempts, allocations: s.payment.allocations, blocks: s.payment.blocks, authorizations: s.payment.authorizations,
        disputes: s.payment.disputes, balance: s.payment.balance, refundCases: s.billing.refundCases, relays: s.billing.relays, disputeLosses: s.billing.disputeLosses, losses: s.billing.losses,
        obligations: s.billing.obligations, purchases: s.billing.purchases, restrictions: org ? (await restrictions(org)).map((x) => x.kind) : [] };
    };
    const signedRaw = async (raw: string) => (await fetch(`${PAYMENT_URL}/payment/webhooks/simulation`, { method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'x-simulation-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') } })).status;

    // ═══════════════════════════════════════════════════════════════ DO-73 STEP 0 CHARACTERIZATION (test-only; observes, asserts nothing about policy)
    // LABELLED TEST-ONLY FIXTURE: `factRaw`, a refund notification signed by the test through Payment's real webhook pipeline, with a chosen currency.
    // No row is written by SQL. Every observation is appended as one JSON line to $DO73_OUT.
    const OUT = process.env.R3F1_CERT_OUT ?? '';
    const record = (scenario: string, step: string, data: unknown) => {
      if (OUT) appendFileSync(OUT, `${JSON.stringify({ scenario, step, at: new Date().toISOString(), data })}\n`);
    };


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
    const billingOnly = (f: Awaited<ReturnType<typeof financial>>) => ({ refundCases: f.refundCases, relays: f.relays, disputeLosses: f.disputeLosses, losses: f.losses, obligations: f.obligations,
      purchases: f.purchases, restrictions: f.restrictions, allocations: f.allocations, authorizations: f.authorizations, balance: f.balance, attempts: f.attempts });


    // ═══════════════════════════════════════════════════════════════ R3 STEP 0 CHARACTERIZATION (test-only; nothing here is certified behaviour)
    // R3: an UNMATCHED verified refund fact (the provider stated it under a reference Payment cannot match) whose provider transaction id equals a FAILED
    // refund attempt's own provider refund id, never reported by that attempt. LABELLED TEST-ONLY FIXTURES: notifications signed by the test through
    // Payment's real webhook pipeline; `ageWebhook` (the 5-minute grace window, as DO-74). No financial row is written by SQL. Every observation is appended
    // to $R3_OUT. These tests CHARACTERIZE: their assertions pin what happens today, including outcomes that may be unsafe.
    const notice = (txn: string, amount: number, eventId = `r3_u_${randomUUID()}`, reference: string = randomUUID()) =>
      ({ eventId, raw: JSON.stringify({ eventId, type: 'refund.succeeded', reference, providerTransactionId: txn, amount, currency: 'TND' }) });
    /** the unknown-reference notification, delivered, aged past the grace window and redelivered (the retrier's pass): an unmatched fact. */
    async function unmatched(txn: string, amount: number) {
      const u = notice(txn, amount);
      expect(await signedRaw(u.raw)).toBe(200);
      await ageWebhook(u.eventId);
      expect(await signedRaw(u.raw)).toBe(200);
      const f = await one(paymentAdmin, `SELECT id, "paymentId", "refundAttemptId", amount FROM provider_transaction_fact WHERE "providerTxnId" = $1 AND kind = 'refund'`, [txn]);
      expect(f, `the unmatched fact\n${tails()}`).toBeDefined();
      return { factId: f!.id as string, eventId: u.eventId, fact: f };
    }
    async function failedAttempt(p: { paymentId: string; amount: number }) {
      const r = await relayed(p.paymentId, p.amount);
      const txn = await providerRef(r.attemptId);
      await refundOutcome(r.attemptId, 'failed');
      await mirrored(r.attemptId, 'failed');
      return { ...r, txn };
    }
    /** a second authorization of the SAME refund case (R6B-10: a failed relay frees the case), through Billing's real route */
    async function relayAgain(caseId: string, paymentId: string, amount: number) {
      const r = await receipt(owners.a, 'refund.authorize', { operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId, amount, currency: 'TND',
        reason: 'customer_request', legalOverride: false });
      const relay = await call(B1, 'POST', owners.a.token, `/billing/admin/refund-cases/${caseId}/authorizations`, { receiptSecret: r.secret });
      if (relay.status !== 201) return { refused: [relay.status, relay.json?.code ?? null] as const };
      const attemptId = (await one(billingAdmin, `SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1 ORDER BY "requestedAt" DESC LIMIT 1`, [caseId]))!.id as string;
      await waitFor(async () => (await one(paymentAdmin, `SELECT status FROM refund_attempt WHERE id = $1`, [attemptId]))?.status === 'submitted', 30_000, `the second dispatch\n${tails()}`);
      return { attemptId };
    }
    const effects = async (disputeId: string) => ({
      effect: (await billingAdmin.query(`SELECT * FROM dispute_loss_effect WHERE "disputeId" = $1`, [disputeId])).rows.map((r) => Object.keys(r).filter((k) => r[k] !== null).sort()),
      losses: (await billingAdmin.query(`SELECT kind, amount FROM financial_loss WHERE "disputeId" = $1`, [disputeId])).rows,
      obligations: (await billingAdmin.query(`SELECT status, "baseAmount" FROM recovery_obligation WHERE "disputeId" = $1`, [disputeId])).rows,
    });
    /** the S0-C14-gated outcome (a direct write-off or a recovery obligation); `dispute_loss_effect` is the purchase effect (S6d), recorded either way */
    const writtenOff = (e: { losses: unknown[]; obligations: unknown[] }) => e.losses.length + e.obligations.length;
    const effectApplied = (disputeId: string) => waitFor(async () => writtenOff(await effects(disputeId)) === 1, 90_000, `the write-off or obligation\n${tails()}`);
    const auditActions = async (paymentId: string) => (await auditAdmin.query(`SELECT action, count(*)::int AS n FROM audit_record WHERE changes->>'payment_id' = $1 GROUP BY action ORDER BY action`, [paymentId])).rows;
    const auditMentions = async (needle: string) => n(auditAdmin, `SELECT count(*) AS n FROM audit_record WHERE "resourceId"::text = $1 OR changes::text LIKE '%' || $1 || '%'`, [needle]);

    // ═══════════════════════════════════════════════════════════════ R3 CERTIFICATION
    const markerOf = (relayId: string) => one(billingAdmin, `SELECT "firstState", "paymentId" FROM refund_relay_failure_evidence WHERE "relayId" = $1`, [relayId]);
    const markers = (relayId: string) => n(billingAdmin, `SELECT count(*) AS n FROM refund_relay_failure_evidence WHERE "relayId" = $1`, [relayId]);
    const waitingOf = (disputeId: string) => one(billingAdmin, `SELECT c.id, c.detail, c.amount, r.kind FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
      WHERE c."caseType" = 'chargeback_effect_waiting' AND c."evidenceKey" = $1`, [disputeId]);
    const caseCount = (type: string, disputeId: string) => n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = $1 AND "evidenceKey" = $2`, [type, disputeId]);
    /** held: after every worker passed on both Billing processes, no write-off and no obligation, and the waiting case states why */
    const held = async (disputeId: string, detail: string) => {
      await waitFor(async () => (await waitingOf(disputeId))?.detail === detail, 90_000, `the waiting case (${detail})\n${tails()}`);
      await settle();
      const e = await effects(disputeId);
      expect(writtenOff(e), `held: ${detail}`).toBe(0);
      expect(await caseCount('chargeback_effect_waiting', disputeId)).toBe(1);
      return e;
    };


    // ═══════════════════════════════════════════════════════════════ R3-F1 CERTIFICATION (read-only visibility; the Owner's F1-a and F1-b, 2026-11-10)
    // `unreconciledFailedAttemptEvidence` on the three loss cases (chargeback_refund_overlap, chargeback_effect_waiting, chargeback_refund_exposure): true
    // when Billing holds an R3 marker on the loss's movement. Derived when read; it changes no stored case, status, resolution, precedence, uniqueness or
    // acknowledgement. LABELLED TEST-ONLY FIXTURES: notifications signed by the test through Payment's real webhook pipeline; `ageWebhook`. LABELLED TEST
    // AID: the proxy's `pay08_503` mode (Payment unavailable). MIXED VERSIONS: R3F1_OLD_BILLING_DIR names a main build without R3-F1. No row is written by SQL.
    const OLD_DIR = process.env.R3F1_OLD_BILLING_DIR ?? '';
    const F1 = 'unreconciledFailedAttemptEvidence';
    const LOSS_CASE_KEYS = ['amount', 'captureFactId', 'caseType', 'companyId', 'currency', 'detail', 'evidenceId', 'id', 'openedAt', 'organizationId', 'paymentId',
      'paymentRequestId', 'platformId', 'resolution', 'reviewOnly', 'status', F1].sort();
    const read = async (caseId: string, o: Owner = owners.a, via = B1) => call(via, 'GET', o.token, `/billing/admin/reconciliation-cases/${caseId}`);
    const listed = async (caseId: string, type: string, o: Owner = owners.a, via = B1) => {
      for (const status of ['open', 'resolved']) {
        const items = ((await call(via, 'GET', o.token, `/billing/admin/reconciliation-cases?status=${status}&type=${type}&limit=200`)).json?.items ?? []) as { id: string }[];
        const hit = items.find((i) => i.id === caseId);
        if (hit) return hit as Record<string, unknown>;
      }
      return undefined;
    };
    const caseIdOf = async (type: string, disputeId: string) => (await one(billingAdmin, `SELECT id FROM reconciliation_case WHERE "caseType" = $1 AND "evidenceKey" = $2`, [type, disputeId]))?.id as string | undefined;
    /** the stored case and resolution rows of a loss: never changed by a read */
    const stored = async (disputeId: string) => (await billingAdmin.query(`SELECT c.*, to_jsonb(r) AS resolution FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
      WHERE c."evidenceKey" = $1 ORDER BY c."caseType"`, [disputeId])).rows;
    /** every read surface of one loss case: both Billing processes and the list; the value must agree everywhere */
    async function visible(type: string, disputeId: string, needles: string[] = []) {
      const id = (await caseIdOf(type, disputeId))!;
      expect(id, `${type} exists\n${tails()}`).toBeTruthy();
      const r1 = await read(id);
      const r2 = await read(id, owners.a, B2);
      expect(r1.status).toBe(200);
      expect(r2.json).toEqual(r1.json);
      const item = await listed(id, type);
      expect(item, `${type} is listed`).toEqual(r1.json);
      expect(Object.keys(r1.json).sort(), `${type}: exactly one field added`).toEqual(LOSS_CASE_KEYS);
      expect(typeof r1.json[F1], `${type}: a boolean, nothing else`).toBe('boolean');
      for (const x of needles) expect(JSON.stringify(r1.json), `${type} names nothing of the evidence (${x})`).not.toContain(x);
      return { id, body: r1.json as Record<string, any> };
    }
    /** reads change nothing: stored cases and resolutions, money and audit, before and after many reads on both processes */
    async function readsChangeNothing(p: { paymentId: string; paymentRequestId: string }, disputeId: string, ids: string[]) {
      const before = { stored: await stored(disputeId), money: billingOnly(await financial(p)), audit: await auditActions(p.paymentId) };
      for (let i = 0; i < 3; i++) for (const id of ids) { await read(id); await read(id, owners.a, B2); }
      expect({ stored: await stored(disputeId), money: billingOnly(await financial(p)), audit: await auditActions(p.paymentId) }).toEqual(before);
      return before;
    }
    const ackStatuses = async (caseId: string) => {
      const out: Record<string, unknown> = {};
      for (const reason of ['reviewed_no_financial_effect', 'duplicate_evidence_reviewed', 'provider_statement_reviewed']) {
        const r = await ack(B1, caseId, reason);
        out[reason] = [r.status, r.json?.code ?? null];
      }
      return out;
    };
    const NOT_ACK = { reviewed_no_financial_effect: [409, 'reconciliation_case_not_acknowledgeable'], duplicate_evidence_reviewed: [409, 'reconciliation_case_not_acknowledgeable'],
      provider_statement_reviewed: [409, 'reconciliation_case_not_acknowledgeable'] };
    const secondSucceeds = async (r: { caseId: string }, p: { paymentId: string; amount: number }) => {
      const second = await relayAgain(r.caseId, p.paymentId, p.amount);
      expect('attemptId' in second, JSON.stringify(second)).toBe(true);
      const a2 = (second as { attemptId: string }).attemptId;
      await refundOutcome(a2, 'succeeded');
      await mirrored(a2, 'succeeded');
      await completedCase(r.caseId);
      return a2;
    };
    const overlapFor = (disputeId: string) => waitFor(async () => !!(await caseIdOf('chargeback_refund_overlap', disputeId)), 90_000, `the overlap case\n${tails()}`);
    const kindOf = async (type: string, disputeId: string) => (await one(billingAdmin, `SELECT r.kind FROM reconciliation_case c JOIN reconciliation_case_resolution r ON r."caseId" = c.id
      WHERE c."caseType" = $1 AND c."evidenceKey" = $2`, [type, disputeId]))?.kind as string | undefined;
    const historical: { disputeId?: string; plainDisputeId?: string; needles: string[] } = { needles: [] };

    for (const kind of ['direct', 'assisted'] as const) {
      it(`F1V-1 (${kind}): evidence BEFORE the refund completes; the overlap case states it (both processes, list); nothing else changes; acknowledgements unchanged`, async () => {
        const { p } = await buy(kind);
        const r = await failedAttempt(p);
        const u = await unmatched(r.txn, p.amount);
        await waitFor(async () => !!(await markerOf(r.attemptId)), 60_000, `the marker\n${tails()}`);
        await secondSucceeds(r, p);
        const disputeId = await dispute(p.paymentId, p.amount);
        await overlapFor(disputeId);
        await settle();
        const needles = [u.factId, r.txn, u.eventId];
        const o = await visible('chargeback_refund_overlap', disputeId, needles);
        expect(o.body).toMatchObject({ status: 'open', resolution: null, detail: 'refund_and_chargeback', [F1]: true });
        expect(await caseCount('chargeback_refund_overlap', disputeId)).toBe(1);
        expect(await caseIdOf('chargeback_effect_waiting', disputeId)).toBeUndefined(); // precedence unchanged
        expect(await caseIdOf('chargeback_refund_exposure', disputeId)).toBeUndefined();
        const snap = await readsChangeNothing(p, disputeId, [o.id]);
        expect(writtenOff(await effects(disputeId))).toBe(0);
        expect(await ackStatuses(o.id)).toEqual(NOT_ACK);
        const reversal = (await one(billingAdmin, `SELECT id FROM reconciliation_case WHERE "caseType" = 'second_reversal_cause' AND "paymentId" = $1`, [p.paymentId]))?.id as string | undefined;
        if (reversal) {
          const rr = await read(reversal);
          expect(F1 in rr.json, 'a review-only case carries no R3-F1 field').toBe(false);
          // the S0-C14 item 9 and R6H-2 rules, exactly as before R3-F1 (Step 0 ACK-C / ACK-F1)
          expect(await ackStatuses(reversal)).toEqual({ reviewed_no_financial_effect: [409, 'reconciliation_case_in_overlap'], duplicate_evidence_reviewed: [200, null],
            provider_statement_reviewed: [409, 'reconciliation_case_resolved'] });
        }
        expect(await auditMentions(u.factId)).toBe(0);
        record(`F1V-1-${kind}`, 'visible', { overlap: o.body, snap, reversalCase: !!reversal });
      }, T);
    }

    it('F1V-2 (direct): evidence AFTER the refund completed and before the chargeback: the overlap case states it', async () => {
      const { p } = await buy('direct');
      const r = await failedAttempt(p);
      await secondSucceeds(r, p);
      const u = await unmatched(r.txn, p.amount);
      await waitFor(async () => !!(await markerOf(r.attemptId)), 120_000, `the marker after completion\n${tails()}`);
      const disputeId = await dispute(p.paymentId, p.amount);
      await overlapFor(disputeId);
      await settle();
      const o = await visible('chargeback_refund_overlap', disputeId, [u.factId, r.txn]);
      expect(o.body).toMatchObject({ status: 'open', [F1]: true });
      await readsChangeNothing(p, disputeId, [o.id]);
      record('F1V-2', 'visible', { overlap: o.body });
    }, T);

    it('F1V-3 (direct): evidence AFTER the chargeback effect (write-off on a clean read): the exposure case states it; the write-off stands', async () => {
      const { p } = await buy('direct');
      const r = await failedAttempt(p);
      const disputeId = await dispute(p.paymentId, p.amount);
      await effectApplied(disputeId);
      const before = await effects(disputeId);
      const u = await unmatched(r.txn, p.amount);
      await waitFor(async () => !!(await markerOf(r.attemptId)), 120_000, `the late marker\n${tails()}`);
      await waitFor(async () => !!(await caseIdOf('chargeback_refund_exposure', disputeId)), 90_000, `the exposure case\n${tails()}`);
      await settle();
      const e = await visible('chargeback_refund_exposure', disputeId, [u.factId, r.txn]);
      expect(e.body).toMatchObject({ status: 'open', resolution: null, [F1]: true });
      expect(await ackStatuses(e.id)).toEqual(NOT_ACK);
      await readsChangeNothing(p, disputeId, [e.id]);
      expect(await effects(disputeId)).toEqual(before);
      record('F1V-3', 'visible', { exposure: e.body });
    }, T);

    it('F1V-4 (R3-F2 historical ordering): a second attempt in flight before the dispute; held; the refund completes: both closed cases and the overlap state the evidence; stored resolutions unchanged; two workers, one case each', async () => {
      const { p } = await buy('direct');
      const r = await failedAttempt(p);
      const second = await relayAgain(r.caseId, p.paymentId, p.amount); // dispatched, no outcome yet: live
      expect('attemptId' in second, JSON.stringify(second)).toBe(true);
      const a2 = (second as { attemptId: string }).attemptId;
      const u = await unmatched(r.txn, p.amount);
      await waitFor(async () => !!(await markerOf(r.attemptId)), 60_000, `the marker\n${tails()}`);
      const disputeId = await dispute(p.paymentId, p.amount);
      await waitFor(async () => !!(await waitingOf(disputeId)), 90_000, `the waiting case\n${tails()}`);
      await waitFor(async () => !!(await caseIdOf('chargeback_refund_exposure', disputeId)), 90_000, `the exposure case\n${tails()}`);
      const heldWaiting = await visible('chargeback_effect_waiting', disputeId, [u.factId, r.txn]);
      expect(heldWaiting.body).toMatchObject({ status: 'open', [F1]: true });
      await refundOutcome(a2, 'succeeded');
      await mirrored(a2, 'succeeded');
      await completedCase(r.caseId);
      await overlapFor(disputeId);
      await waitFor(async () => (await waitingOf(disputeId))?.kind === 'refund_completed', 90_000, `the waiting case to close\n${tails()}`);
      await waitFor(async () => (await kindOf('chargeback_refund_exposure', disputeId)) === 'refund_completed', 90_000, `the exposure case to close\n${tails()}`);
      await settle();
      const w = await visible('chargeback_effect_waiting', disputeId, [u.factId, r.txn]);
      const x = await visible('chargeback_refund_exposure', disputeId, [u.factId, r.txn]);
      const o = await visible('chargeback_refund_overlap', disputeId, [u.factId, r.txn]);
      expect(w.body).toMatchObject({ status: 'resolved', resolution: { kind: 'refund_completed' }, [F1]: true });
      expect(o.body).toMatchObject({ status: 'open', [F1]: true });
      expect(x.body).toMatchObject({ status: 'resolved', resolution: { kind: 'refund_completed' }, [F1]: true });
      for (const t of ['chargeback_effect_waiting', 'chargeback_refund_exposure', 'chargeback_refund_overlap']) expect(await caseCount(t, disputeId), t).toBe(1);
      const snap = await readsChangeNothing(p, disputeId, [w.id, x.id, o.id]);
      expect(writtenOff(await effects(disputeId))).toBe(0);
      historical.disputeId = disputeId;
      historical.needles = [u.factId, r.txn];
      record('F1V-4', 'historical', { waiting: w.body, exposure: x.body, overlap: o.body, stored: snap.stored });
    }, T);

    it('F1V-5 (controls, no marker): a plain refund and chargeback states false on its overlap; a Payment-outage hold that later applies states false on its resolved waiting case', async () => {
      const { p } = await buy('direct');
      const a = await relayed(p.paymentId, p.amount);
      expect(await rawRefund(a.attemptId, p.amount, await providerRef(a.attemptId))).toBe(200);
      await completedCase(a.caseId);
      const d1 = await dispute(p.paymentId, p.amount);
      await overlapFor(d1);
      await settle();
      const o = await visible('chargeback_refund_overlap', d1);
      expect(o.body).toMatchObject({ status: 'open', [F1]: false });
      historical.plainDisputeId = d1;
      const { p: q } = await buy('assisted');
      const r = await failedAttempt(q);
      proxyMode.set(q.paymentId, 'pay08_503');
      let d2 = '';
      try {
        d2 = await dispute(q.paymentId, q.amount);
        await held(d2, 'payment_unavailable');
        const held2 = await visible('chargeback_effect_waiting', d2);
        expect(held2.body).toMatchObject({ status: 'open', [F1]: false });
      } finally {
        proxyMode.delete(q.paymentId);
      }
      await effectApplied(d2);
      await waitFor(async () => (await waitingOf(d2))?.kind === 'effect_applied', 90_000, `effect_applied\n${tails()}`);
      const w = await visible('chargeback_effect_waiting', d2);
      expect(w.body).toMatchObject({ status: 'resolved', resolution: { kind: 'effect_applied' }, [F1]: false });
      expect(await markers(r.attemptId)).toBe(0);
      record('F1V-5', 'controls', { overlap: o.body, waiting: w.body });
    }, T);

    it('F1V-6 (cross-Company, malformed and missing reads): another Company\'s Owner never sees the cases or the field; unknown and malformed ids answer as before; other case types carry no field', async () => {
      const d = historical.disputeId!;
      expect(d, 'F1V-4 ran first').toBeTruthy();
      for (const t of ['chargeback_effect_waiting', 'chargeback_refund_exposure', 'chargeback_refund_overlap']) {
        const id = (await caseIdOf(t, d))!;
        for (const via of [B1, B2]) expect((await read(id, owners.x, via)).status, `${t} via ${via}`).toBe(404);
        expect(await listed(id, t, owners.x), `${t} not in X's list`).toBeUndefined();
      }
      const xAll = JSON.stringify((await call(B1, 'GET', owners.x.token, '/billing/admin/reconciliation-cases?limit=200')).json ?? {});
      for (const t of ['chargeback_effect_waiting', 'chargeback_refund_exposure', 'chargeback_refund_overlap']) expect(xAll).not.toContain((await caseIdOf(t, d))!);
      expect((await read(randomUUID())).status).toBe(404);
      const malformed = { notUuid: (await read('not-a-uuid')).status, empty: (await call(B1, 'GET', owners.a.token, '/billing/admin/reconciliation-cases/%20')).status };
      const others = ((await call(B1, 'GET', owners.a.token, '/billing/admin/reconciliation-cases?limit=200')).json?.items ?? []) as { caseType: string }[];
      for (const c of others) expect(F1 in c, c.caseType).toBe(['chargeback_refund_overlap', 'chargeback_effect_waiting', 'chargeback_refund_exposure'].includes(c.caseType));
      record('F1V-6', 'isolation', { malformed, otherTypes: [...new Set(others.map((c) => c.caseType))].sort() });
    }, T);

    it(`F1V-7 (${OLD_DIR ? 'mixed versions: a main Billing without R3-F1 reads the same database' : 'repository mode, no old binary'}): the field is additive; everything else reads identically`, async () => {
      const d = historical.disputeId!;
      const ids = await Promise.all(['chargeback_effect_waiting', 'chargeback_refund_exposure', 'chargeback_refund_overlap'].map(async (t) => (await caseIdOf(t, d))!));
      const plain = (await caseIdOf('chargeback_refund_overlap', historical.plainDisputeId!))!;
      const strip = (b: Record<string, unknown>) => { const { [F1]: _f, ...rest } = b; return rest; };
      if (!OLD_DIR) {
        for (const id of [...ids, plain]) expect(Object.keys(strip((await read(id)).json)).sort()).toEqual(LOSS_CASE_KEYS.filter((k) => k !== F1));
        record('F1V-7', 'mode', { mode: 'repository_no_old_binary' });
        return;
      }
      const OLD = `http://127.0.0.1:${PORT.b3}`;
      const old = spawnService('billing-main-without-r3f1', OLD_DIR, billingEnv(PORT.b3));
      try {
        await waitForHealth(`${OLD}/health`, 30_000);
        for (const id of [...ids, plain]) {
          const now = (await read(id)).json;
          const was = await read(id, owners.a, OLD);
          expect(was.status).toBe(200);
          expect(F1 in was.json, 'the old Billing has no field').toBe(false);
          expect(was.json).toEqual(strip(now));
        }
        expect((await read(randomUUID(), owners.a, OLD)).status).toBe((await read(randomUUID())).status);
        expect((await read('not-a-uuid', owners.a, OLD)).status).toBe((await read('not-a-uuid')).status);
        record('F1V-7', 'mode', { mode: 'mixed_versions_old_binary', cases: ids.length + 1 });
      } finally {
        await old.stop();
      }
    }, T);
  },
);
