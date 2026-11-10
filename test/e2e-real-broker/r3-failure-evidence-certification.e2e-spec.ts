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
/** Core V2 DO-74 D13: a main build without DO-74 (migrations to 0053) for the mixed-version proof; DO74_OLD_BILLING_DIR names it. Unset (CI), D13 runs its
 * repository-migrations mode instead (no old binary): see D13. */
const OLD_BILLING_DIR = process.env.DO74_OLD_BILLING_DIR ?? '';
const PORT = { auth: 13911, b1: 13912, b2: 13913, payment: 13914, audit: 13916, b3: 13917, b4: 13918 };
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
  'Core V2 R3: credible refund evidence after a failed refund attempt holds the loss\'s automatic effect (real Auth, Payment, Audit, TWO Billing processes, RabbitMQ with Billing\'s identity; simulation)',
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
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauthr3cert');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingr3cert');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymentr3cert');
      auditDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauditr3cert');
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
    const OUT = process.env.R3_CERT_OUT ?? '';
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
    const pay08 = async (paymentId: string) => (await call(PAYMENT_URL, 'GET', billingToPaymentToken.token, `/payment/payments/${paymentId}/refunds`)).json;
    const auditActions = async (paymentId: string) => (await auditAdmin.query(`SELECT action, count(*)::int AS n FROM audit_record WHERE changes->>'payment_id' = $1 GROUP BY action ORDER BY action`, [paymentId])).rows;
    const auditMentions = async (needle: string) => n(auditAdmin, `SELECT count(*) AS n FROM audit_record WHERE "resourceId"::text = $1 OR changes::text LIKE '%' || $1 || '%'`, [needle]);
    const webhookOf = (eventId: string) => one(paymentAdmin, `SELECT state, outcome, "matchedAttemptId" FROM webhook_event WHERE "providerEventId" = $1`, [eventId]);
    const ownerSeesAnywhere = async (o: Owner, needles: string[]) => {
      const hits: string[] = [];
      for (const kind of ['fact_conflict', 'allocation_blocked', 'refund_discrepancy', 'association', 'chargeback', 'over_return', 'late_success']) {
        const body = JSON.stringify((await call(PAYMENT_URL, 'GET', o.token, `/payment/admin/reconciliation-items?kind=${kind}&limit=200`)).json ?? {});
        for (const x of needles) if (body.includes(x)) hits.push(`${kind}:${x}`);
      }
      const cases = JSON.stringify((await call(B1, 'GET', o.token, '/billing/admin/reconciliation-cases?status=open')).json ?? {});
      for (const x of needles) if (cases.includes(x)) hits.push(`billing_cases:${x}`);
      return hits;
    };
    const linkingEvidence = async (attemptId: string, factId: string) => one(paymentAdmin, `SELECT a.status AS "attemptStatus", a."providerRefundId" = f."providerTxnId" AS "sameProviderReference",
      a.provider = f.provider AS "sameProvider", f."paymentId" IS NULL AS "factUnmatched", f."refundAttemptId" IS NULL AS "factNamesNoAttempt", f.amount AS "factAmount", a.amount AS "attemptAmount",
      (SELECT count(*)::int FROM refund_attempt x WHERE x.provider = f.provider AND x."providerRefundId" = f."providerTxnId") AS "attemptsWithThatReference",
      (SELECT count(*)::int FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id) AS "observations",
      (SELECT count(*)::int FROM provider_fact_association s WHERE s."factId" = f.id) AS associations
      FROM refund_attempt a, provider_transaction_fact f WHERE a.id = $1 AND f.id = $2`, [attemptId, factId]);

    // ═══════════════════════════════════════════════════════════════ R3 CERTIFICATION
    const markerOf = (relayId: string) => one(billingAdmin, `SELECT "firstState", "paymentId" FROM refund_relay_failure_evidence WHERE "relayId" = $1`, [relayId]);
    const markers = (relayId: string) => n(billingAdmin, `SELECT count(*) AS n FROM refund_relay_failure_evidence WHERE "relayId" = $1`, [relayId]);
    const waitingOf = (disputeId: string) => one(billingAdmin, `SELECT c.id, c.detail, c.amount, r.kind FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
      WHERE c."caseType" = 'chargeback_effect_waiting' AND c."evidenceKey" = $1`, [disputeId]);
    const caseCount = (type: string, disputeId: string) => n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = $1 AND "evidenceKey" = $2`, [type, disputeId]);
    const exposureOf = (disputeId: string) => one(billingAdmin, `SELECT id, detail FROM reconciliation_case WHERE "caseType" = 'chargeback_refund_exposure' AND "evidenceKey" = $1`, [disputeId]);
    /** held: after every worker passed on both Billing processes, no write-off and no obligation, and the waiting case states why */
    const held = async (disputeId: string, detail: string) => {
      await waitFor(async () => (await waitingOf(disputeId))?.detail === detail, 90_000, `the waiting case (${detail})\n${tails()}`);
      await settle();
      const e = await effects(disputeId);
      expect(writtenOff(e), `held: ${detail}`).toBe(0);
      expect(await caseCount('chargeback_effect_waiting', disputeId)).toBe(1);
      return e;
    };
    const paymentMoney = async (paymentId: string) => ({
      facts: (await paymentAdmin.query(`SELECT id, kind, amount, "paymentId" FROM provider_transaction_fact WHERE "paymentId" = $1 ORDER BY id`, [paymentId])).rows,
      allocations: await n(paymentAdmin, `SELECT count(*) AS n FROM refund_allocation WHERE "paymentId" = $1`, [paymentId]),
      associations: await n(paymentAdmin, `SELECT count(*) AS n FROM provider_fact_association WHERE "paymentId" = $1`, [paymentId]),
    });

    for (const kind of ['direct', 'assisted'] as const) {
      it(`R3-1 (${kind}): an unmatched refund under the FAILED attempt's own reference HOLDS the ${kind === 'direct' ? 'write-off' : 'obligation'}; one marker, one waiting case, the exposure case; nothing of the fact crosses; nothing associated or allocated`, async () => {
        const { p } = await buy(kind);
        const r = await failedAttempt(p);
        const u = await unmatched(r.txn, p.amount);
        await waitFor(async () => !!(await markerOf(r.attemptId)), 60_000, `the marker\n${tails()}`);
        const payBefore = await paymentMoney(p.paymentId);
        const auditBefore = await auditActions(p.paymentId);
        const disputeId = await dispute(p.paymentId, p.amount);
        const e = await held(disputeId, 'refund_evidence_after_failure');
        expect(await markerOf(r.attemptId)).toEqual({ firstState: 'unmatched_fact', paymentId: p.paymentId });
        expect(await markers(r.attemptId)).toBe(1);
        await waitFor(async () => !!(await exposureOf(disputeId)), 60_000, `the exposure case\n${tails()}`);
        expect(await caseCount('chargeback_refund_exposure', disputeId)).toBe(1);
        expect(await n(billingAdmin, `SELECT count(*) AS n FROM loss_effect_attestation WHERE "disputeId" = $1`, [disputeId])).toBe(0);
        const read = await pay08(p.paymentId);
        expect(read.failedAttemptEvidence).toEqual([{ refundAttemptId: r.attemptId, state: 'unmatched_fact' }]);
        for (const leak of [u.factId, r.txn]) expect(JSON.stringify(read.failedAttemptEvidence), leak).not.toContain(leak);
        const waiting = await waitingOf(disputeId);
        for (const leak of [u.factId, r.txn]) expect(JSON.stringify(waiting), leak).not.toContain(leak);
        const payAfter = await paymentMoney(p.paymentId);
        expect({ allocations: payAfter.allocations, associations: payAfter.associations }).toEqual({ allocations: payBefore.allocations, associations: payBefore.associations });
        expect(payAfter.facts.filter((f: { kind: string }) => f.kind === 'refund')).toEqual([]); // the fact is still nobody's
        record(`R3-1-${kind}`, 'held', { effects: e, waiting, marker: await markerOf(r.attemptId), exposure: await exposureOf(disputeId), payBefore, payAfter, auditBefore, auditAfter: await auditActions(p.paymentId),
          auditMentionsFact: await auditMentions(u.factId), auditMentionsTxn: await auditMentions(r.txn) });
        expect(await auditMentions(u.factId)).toBe(0);
        expect(await auditMentions(r.txn)).toBe(0);
      }, T);
    }

    it('R3-2 (control): an unmatched refund under an UNRELATED reference holds nothing: the failed attempt reads `none` and the write-off proceeds with its attestation', async () => {
      const { p } = await buy('direct');
      const r = await failedAttempt(p);
      await unmatched(`simr_${randomUUID()}`, p.amount);
      expect((await pay08(p.paymentId)).failedAttemptEvidence).toEqual([{ refundAttemptId: r.attemptId, state: 'none' }]);
      const disputeId = await dispute(p.paymentId, p.amount);
      await effectApplied(disputeId);
      expect(await markers(r.attemptId)).toBe(0);
      expect(await one(billingAdmin, `SELECT effect, "clearRelays", "clearedByRead" FROM loss_effect_attestation WHERE "disputeId" = $1`, [disputeId]))
        .toEqual({ effect: 'direct_chargeback_write_off', clearRelays: [r.attemptId], clearedByRead: [r.attemptId] });
    }, T);

    it('R3-3 (grace window, replay, contradiction): a signed notification not yet a fact holds; it becomes a fact, is replayed and contradicted: still one marker (its first state), one fact, held', async () => {
      const { p } = await buy('direct');
      const r = await failedAttempt(p);
      const first = notice(r.txn, p.amount - 1);
      expect(await signedRaw(first.raw)).toBe(200); // inside the grace window: no fact yet
      expect(await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [r.txn])).toBe(0);
      const disputeId = await dispute(p.paymentId, p.amount);
      await held(disputeId, 'refund_evidence_after_failure');
      expect((await markerOf(r.attemptId))?.firstState).toBe('notification_pending');
      await ageWebhook(first.eventId);
      expect(await signedRaw(first.raw)).toBe(200); // now the unmatched fact
      expect(await signedRaw(first.raw)).toBe(200); // replay
      const contra = notice(r.txn, p.amount); // the same refund, another notification id and amount
      expect(await signedRaw(contra.raw)).toBe(200);
      await ageWebhook(contra.eventId);
      expect(await signedRaw(contra.raw)).toBe(200);
      await settle();
      expect(await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [r.txn])).toBe(1);
      expect(await markers(r.attemptId)).toBe(1);
      expect((await markerOf(r.attemptId))?.firstState).toBe('notification_pending');
      expect(writtenOff(await effects(disputeId))).toBe(0);
    }, T);

    it('R3-4 (late evidence): the write-off committed on a clean read; the refund surfaces afterwards: the marker is recorded, the exposure case opens, the write-off stands unchanged', async () => {
      const { p } = await buy('direct');
      const r = await failedAttempt(p);
      const disputeId = await dispute(p.paymentId, p.amount);
      await effectApplied(disputeId);
      const before = await effects(disputeId);
      await unmatched(r.txn, p.amount);
      await waitFor(async () => !!(await markerOf(r.attemptId)), 120_000, `the late marker (relay reconciler)\n${tails()}`);
      await waitFor(async () => !!(await exposureOf(disputeId)), 90_000, `the exposure case\n${tails()}`);
      await settle();
      expect(await effects(disputeId)).toEqual(before);
      record('R3-4', 'late', { before, marker: await markerOf(r.attemptId), exposure: await exposureOf(disputeId) });
    }, T);

    it('R3-5 (Payment outage, malformed and absent field): each holds as `payment_unavailable` or `failure_evidence_unknown` with no marker; once Payment answers `none`, the effect proceeds', async () => {
      for (const mode of ['pay08_503', 'pay08_fae_malformed', 'pay08_fae_absent'] as const) {
        const { p } = await buy('assisted');
        const r = await failedAttempt(p);
        proxyMode.set(p.paymentId, mode);
        try {
          const disputeId = await dispute(p.paymentId, p.amount);
          await held(disputeId, mode === 'pay08_503' ? 'payment_unavailable' : 'failure_evidence_unknown');
          expect(await markers(r.attemptId), mode).toBe(0);
          proxyMode.delete(p.paymentId); // Payment recovers: it answers `none`
          await effectApplied(disputeId);
          expect(await caseCount('chargeback_effect_waiting', disputeId)).toBe(1);
        } finally {
          proxyMode.delete(p.paymentId);
        }
      }
    }, T);

    it('R3-6 (multiple failed attempts): two failed attempts of one case; the refund names the FIRST: held; the second alone would read `none`', async () => {
      const { p } = await buy('direct');
      const r1 = await failedAttempt(p);
      const second = await relayAgain(r1.caseId, p.paymentId, p.amount);
      expect('attemptId' in second && second.attemptId, JSON.stringify(second)).toBeTruthy();
      const a2 = (second as { attemptId: string }).attemptId;
      await refundOutcome(a2, 'failed');
      await mirrored(a2, 'failed');
      await unmatched(r1.txn, p.amount);
      const fae = (await pay08(p.paymentId)).failedAttemptEvidence as { refundAttemptId: string; state: string }[];
      expect(fae.sort((x, y) => x.refundAttemptId.localeCompare(y.refundAttemptId))).toEqual(
        [{ refundAttemptId: r1.attemptId, state: 'unmatched_fact' }, { refundAttemptId: a2, state: 'none' }].sort((x, y) => x.refundAttemptId.localeCompare(y.refundAttemptId)));
      const disputeId = await dispute(p.paymentId, p.amount);
      await held(disputeId, 'refund_evidence_after_failure');
      expect(await markers(r1.attemptId)).toBe(1);
      expect(await markers(a2)).toBe(0);
    }, T);

    it('R3-7 (same-Company collision): the refund names P1\'s failed attempt; P2 of the same Company proceeds; P1 is held; P2 learns nothing of P1', async () => {
      const { p: p1 } = await buy('direct');
      const { p: p2 } = await buy('direct');
      const r1 = await failedAttempt(p1);
      const r2 = await failedAttempt(p2);
      await unmatched(r1.txn, p1.amount);
      const read2 = await pay08(p2.paymentId);
      expect(read2.failedAttemptEvidence).toEqual([{ refundAttemptId: r2.attemptId, state: 'none' }]);
      for (const leak of [r1.txn, r1.attemptId, p1.paymentId]) expect(JSON.stringify(read2), leak).not.toContain(leak);
      const d2 = await dispute(p2.paymentId, p2.amount);
      await effectApplied(d2);
      const d1 = await dispute(p1.paymentId, p1.amount);
      await held(d1, 'refund_evidence_after_failure');
      expect(await markers(r2.attemptId)).toBe(0);
    }, T);

    it('R3-8 (cross-Company): the refund names Company X\'s failed attempt; Company A\'s write-off proceeds; neither Owner sees the evidence; A\'s answer and cases name nothing of X', async () => {
      const px = await directPurchase(owners.x.company);
      // LABELLED TEST AID (as DO-74 D7): X's refund is requested directly at Payment with the producer's credential and a REAL receipt of X's Owner
      const x = { caseId: randomUUID(), attemptId: randomUUID() };
      const rx = await receipt(owners.x, 'refund.authorize', { operation: 'refund', audience: 'payment-service', companyId: owners.x.company, refundCaseId: x.caseId,
        paymentId: px.paymentId, amount: px.amount, currency: 'TND', reason: 'customer_request', legalOverride: false });
      const made = await call(PAYMENT_URL, 'POST', billingToPaymentToken.token, `/payment/payments/${px.paymentId}/refunds`, { refundAttemptId: x.attemptId, refundCaseId: x.caseId,
        amount: px.amount, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: rx.secret });
      expect(made.status, JSON.stringify(made.json)).toBe(201);
      await waitFor(async () => (await one(paymentAdmin, `SELECT status FROM refund_attempt WHERE id = $1`, [x.attemptId]))?.status === 'submitted', 30_000, `X's dispatch\n${tails()}`);
      const txnX = await providerRef(x.attemptId);
      await refundOutcome(x.attemptId, 'failed');
      await waitFor(async () => (await one(paymentAdmin, `SELECT status FROM refund_attempt WHERE id = $1`, [x.attemptId]))?.status === 'failed', 30_000, `X's failure\n${tails()}`);
      const u = await unmatched(txnX, px.amount);
      const { p: pa } = await buy('direct');
      const ra = await failedAttempt(pa);
      const da = await dispute(pa.paymentId, pa.amount);
      await effectApplied(da);
      const readA = await pay08(pa.paymentId);
      expect(readA.failedAttemptEvidence).toEqual([{ refundAttemptId: ra.attemptId, state: 'none' }]);
      for (const leak of [txnX, x.attemptId, px.paymentId, owners.x.company, u.factId]) expect(JSON.stringify(readA), leak).not.toContain(leak);
      expect(await ownerSeesAnywhere(owners.a, [u.factId, txnX, x.attemptId])).toEqual([]);
      expect(await ownerSeesAnywhere(owners.x, [u.factId, txnX])).toEqual([]);
      expect(await auditMentions(u.factId)).toBe(0);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM refund_relay_failure_evidence WHERE "paymentId" = $1`, [px.paymentId])).toBe(0); // Billing holds no relay of X's attempt
    }, T);
  },
);
