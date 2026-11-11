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
import { spawnService as spawnRaw, waitFor, waitForHealth, type LiveService } from './support/process.js';
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
const PORT = { auth: 13951, b1: 13952, b2: 13953, payment: 13954, audit: 13956, b3: 13957, b4: 13958 };
const AUTH_URL = `http://127.0.0.1:${PORT.auth}`;
const B1 = `http://127.0.0.1:${PORT.b1}`;
const B2 = `http://127.0.0.1:${PORT.b2}`;
const PAYMENT_URL = `http://127.0.0.1:${PORT.payment}`;
/** Core V2 O-2 TEST AID: where the proxy sends Billing's Payment traffic (the current Payment, or an older main build in O2C-7). */
const upstream = { url: PAYMENT_URL };
/** Core V2 O-2 TEST AID: each spawned service's environment, so an older binary starts with exactly the same configuration. */
const spawnedEnv: Record<string, NodeJS.ProcessEnv> = {};
const spawnService = (name: string, cwd: string, env: NodeJS.ProcessEnv): LiveService => { spawnedEnv[name] = env; return spawnRaw(name, cwd, env); };
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
  'Core V2 O-2: the fact owner\'s contested refund fact stays Owner-visible (R3 harness (real Auth, Payment, Audit, TWO Billing processes, RabbitMQ with Billing\'s identity; simulation)',
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
    const olderPayment = { presence: false, factOwner: false };
    /** Core V2 O-2 TEST AID (O2C-7, repository mode): every answer Payment gave while `olderPayment.factOwner` stood for a Payment without the kind. */
    const olderFactOwnerAnswers: { status: number; code: string | null }[] = [];
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
          // Core V2 O-2 TEST AID (O2C-7, repository mode): a Payment older than PAY-12 M does not know `refund_fact_contested`. Its contract for an unknown kind is
          // the current Payment's own code path (`invalid()`: 400 invalid_reconciliation_request), so the request goes to the REAL Payment with a kind it does not
          // know, and Payment's own answer is returned unchanged (nothing is hand-written here)
          const olderFactOwner = olderPayment.factOwner && (req.url ?? '').startsWith('/payment/reconciliation/items') && /[?&]kind=refund_fact_contested(&|$)/.test(req.url ?? '');
          const path = olderFactOwner ? (req.url ?? '').replace('kind=refund_fact_contested', 'kind=refund_fact_contested_unknown_before_o2') : req.url;
          try {
            const up = await fetch(`${upstream.url}${path}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body });
            let text = Buffer.from(await up.arrayBuffer());
            if (olderFactOwner) {
              let code: string | null = null;
              try { code = (JSON.parse(text.toString('utf8')) as { code?: string }).code ?? null; } catch { code = null; }
              olderFactOwnerAnswers.push({ status: up.status, code });
            }
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
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eautho2cert');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingo2cert');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymento2cert');
      auditDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eaudito2cert');
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

    // ═══════════════════════════════════════════════════════════════ DO-73 STEP 0 CHARACTERIZATION (test-only; observes, asserts nothing about policy)
    // LABELLED TEST-ONLY FIXTURE: `factRaw`, a refund notification signed by the test through Payment's real webhook pipeline, with a chosen currency.
    // No row is written by SQL. Every observation is appended as one JSON line to $DO73_OUT.
    const OUT = process.env.O2_CERT_OUT ?? '';
    const record = (scenario: string, step: string, data: unknown) => {
      if (OUT) appendFileSync(OUT, `${JSON.stringify({ scenario, step, at: new Date().toISOString(), data })}\n`);
    };
    /** The provider's report of `txn` naming `attemptId` (its own reference): a signed notification; a new notification id unless `eventId` is given. */
    const reportFor = (attemptId: string, txn: string, amount: number, eventId = `do74_o_${randomUUID()}`) =>
      JSON.stringify({ eventId, type: 'refund.succeeded', reference: attemptId, providerTransactionId: txn, amount, currency: 'TND' });
    const observationsOf = (attemptId: string) => paymentAdmin.query(`SELECT id, "factId", "paymentId" FROM provider_transaction_fact_conflict WHERE "refundAttemptId" = $1 ORDER BY id`, [attemptId])
      .then((r) => r.rows as { id: string; factId: string; paymentId: string }[]);
    const waitObservations = (attemptId: string, count: number) => waitFor(async () => (await observationsOf(attemptId)).length === count, 30_000, `${count} observation(s)\n${tails()}`);
    const observationCase = (attemptId: string) => one(billingAdmin, `SELECT c.id, c."companyId", c."paymentId", c.amount, c.currency, c.detail, c."captureFactId", r.kind FROM reconciliation_case c
      LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id WHERE c."caseType" = 'refund_observation_conflict' AND c."evidenceKey" = $1`, [attemptId]);
    const captureOf = async (refundCaseId: string) => (await one(billingAdmin, `SELECT "captureFactId" FROM refund_case WHERE id = $1`, [refundCaseId]))!.captureFactId as string | null;
    const billingOnly = (f: Awaited<ReturnType<typeof financial>>) => ({ refundCases: f.refundCases, relays: f.relays, disputeLosses: f.disputeLosses, losses: f.losses, obligations: f.obligations,
      purchases: f.purchases, restrictions: f.restrictions, allocations: f.allocations, authorizations: f.authorizations, balance: f.balance, attempts: f.attempts });
    const effects = async (disputeId: string) => ({
      effect: (await billingAdmin.query(`SELECT * FROM dispute_loss_effect WHERE "disputeId" = $1`, [disputeId])).rows.map((r) => Object.keys(r).filter((k) => r[k] !== null).sort()),
      losses: (await billingAdmin.query(`SELECT kind, amount FROM financial_loss WHERE "disputeId" = $1`, [disputeId])).rows,
      obligations: (await billingAdmin.query(`SELECT status, "baseAmount" FROM recovery_obligation WHERE "disputeId" = $1`, [disputeId])).rows,
    });
    /** the S0-C14-gated outcome (a direct write-off or a recovery obligation); `dispute_loss_effect` is the purchase effect (S6d), recorded either way */
    const writtenOff = (e: { losses: unknown[]; obligations: unknown[] }) => e.losses.length + e.obligations.length;


    // ═══════════════════════════════════════════════════════════════ CORE V2 O-2 CERTIFICATION (fact-owner visibility; the Owner's O2-a to O2-d)
    // PAY-12 `refund_fact_contested` (the fact OWNER's own contested refund fact) read by Billing into S0-C15B's existing `refund_fact_contested` case and
    // evidence. LABELLED TEST-ONLY FIXTURES: notifications signed by the test through Payment's real webhook pipeline. LABELLED TEST AIDS: a row lock on
    // Payment's payment row (O2C-4 only: places a contradiction between a fact and its allocation, FC-2's first lock); the proxy's `pay08_obs_absent` mode
    // (O2C-6: holds the observer's DO-74 agreement back). MIXED VERSIONS: O2_OLD_PAYMENT_DIR and O2_OLD_BILLING_DIR name main builds without O-2. No row is
    // written by SQL.
    const OLD_PAYMENT = process.env.O2_OLD_PAYMENT_DIR ?? '';
    const OLD_BILLING = process.env.O2_OLD_BILLING_DIR ?? '';
    const ownerContestCase = (factId: string) => one(billingAdmin, `SELECT c.id, c."companyId", c."paymentId", c."captureFactId", c.amount, c.currency, c.detail, r.kind FROM reconciliation_case c
      LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id WHERE c."caseType" = 'refund_fact_contested' AND c."evidenceKey" = $1`, [factId]);
    const contestEvidence = (caseId: string) => one(billingAdmin, `SELECT "paymentId", "refundFactId", "refundAttemptId", "captureFactId" FROM reconciliation_contest_evidence WHERE "caseId" = $1`, [caseId]);
    const contestCount = (factId: string) => n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_fact_contested' AND "evidenceKey" = $1`, [factId]);
    const openedFor = (caseId: string) => n(auditAdmin, `SELECT count(*) AS n FROM audit_record WHERE action = 'reconciliation_case.opened' AND "resourceId"::text = $1`, [caseId]);
    const ownerItemsOf = async (o: Owner, kind: string) => ((await call(PAYMENT_URL, 'GET', o.token, `/payment/admin/reconciliation-items?kind=${kind}&limit=200`)).json?.items ?? []) as Record<string, any>[];
    const producerItemsOf = async (kind: string) => ((await call(PAYMENT_URL, 'GET', billingToPaymentToken.token, `/payment/reconciliation/items?kind=${kind}&limit=200`)).json?.items ?? []) as Record<string, any>[];
    /** Everything Billing holds and shows of one case: its row, its evidence, the Owner's read and its list entry. */
    const surface = async (caseId: string, o: Owner = owners.a) => JSON.stringify({
      row: await one(billingAdmin, `SELECT * FROM reconciliation_case WHERE id = $1`, [caseId]), evidence: await contestEvidence(caseId),
      read: (await call(B1, 'GET', o.token, `/billing/admin/reconciliation-cases/${caseId}`)).json,
      list: ((await call(B1, 'GET', o.token, '/billing/admin/reconciliation-cases?status=open&type=refund_fact_contested&limit=200')).json?.items ?? []).filter((i: { id: string }) => i.id === caseId),
    });
    /** P1: a direct purchase refunded through Billing's relay; the attempt reports its own refund: P1's matched, allocated fact; the case completes. */
    const ownerFact = async () => {
      const { p } = await buy('direct');
      const a = await relayed(p.paymentId, p.amount);
      const txn = await providerRef(a.attemptId);
      expect(await rawRefund(a.attemptId, p.amount, txn)).toBe(200);
      await completedCase(a.caseId);
      return { p, a, txn, factId: await refundFactOf(txn) };
    };
    /** An observer: a payment whose own attempt reports P1's refund under P1's provider reference. */
    const observerOf = async (txn: string, times = 1) => {
      const { p } = await buy('direct');
      const b = await relayed(p.paymentId, p.amount);
      for (let k = 0; k < times; k++) expect(await signedRaw(reportFor(b.attemptId, txn, p.amount))).toBe(200);
      await waitObservations(b.attemptId, times);
      return { p, b };
    };
    const moneyOf = async (p: { paymentId: string; paymentRequestId: string }) => ({ billing: billingOnly(await financial(p)),
      payment: { facts: (await paymentAdmin.query(`SELECT id, kind, amount FROM provider_transaction_fact WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
        allocations: await n(paymentAdmin, `SELECT count(*) AS n FROM refund_allocation WHERE "paymentId" = $1`, [p.paymentId]),
        associations: await n(paymentAdmin, `SELECT count(*) AS n FROM provider_fact_association WHERE "paymentId" = $1`, [p.paymentId]) } });
    const waitContest = (factId: string) => waitFor(async () => !!(await ownerContestCase(factId)), 90_000, `the fact owner's contest case\n${tails()}`);

    it('O2C-1 (same-payment control): P1\'s own attempt contradicts P1\'s fact: ONE case (either path), one evidence row, one audit intent; the owner item exists', async () => {
      const f = await ownerFact();
      await settle();
      expect(await rawRefund(f.a.attemptId, f.p.amount - 1, f.txn)).toBe(200);
      await waitContest(f.factId);
      await settle();
      const c = (await ownerContestCase(f.factId))!;
      expect(c).toMatchObject({ paymentId: f.p.paymentId, detail: 'contested_after_allocation', kind: null });
      expect(await contestCount(f.factId)).toBe(1);
      expect(await openedFor(c.id)).toBe(1);
      expect((await producerItemsOf('refund_fact_contested')).filter((i) => i.id === f.factId)).toHaveLength(1);
      record('O2C-1', 'own', { case: c });
    }, T);

    it('O2C-2 (same Company, after completion; repeated and multiple observers; two Billing processes): P1 gets ONE case naming nothing of the observers; each observer keeps its DO-74 case; no money moves', async () => {
      const f = await ownerFact();
      await settle();
      const before = await moneyOf(f.p);
      const o1 = await observerOf(f.txn, 2);
      const o2 = await observerOf(f.txn);
      await waitContest(f.factId);
      for (const o of [o1, o2]) await waitCase(() => observationCase(o.b.attemptId), 'an observer\'s DO-74 case');
      await settle();
      const c = (await ownerContestCase(f.factId))!;
      const capture = await captureOf(f.a.caseId);
      expect(c).toMatchObject({ paymentId: f.p.paymentId, companyId: COMPANY, amount: String(f.p.amount), currency: 'TND', detail: 'contested_after_allocation', kind: null, captureFactId: capture });
      expect(await contestEvidence(c.id)).toEqual({ paymentId: f.p.paymentId, refundFactId: f.factId, refundAttemptId: f.a.attemptId, captureFactId: capture });
      expect(await contestCount(f.factId)).toBe(1);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_contest_evidence WHERE "refundFactId" = $1`, [f.factId])).toBe(1);
      expect(await openedFor(c.id)).toBe(1);
      const s = await surface(c.id);
      for (const x of [o1.p.paymentId, o1.b.attemptId, o2.p.paymentId, o2.b.attemptId, f.txn, ...(await paymentAdmin.query(`SELECT id FROM provider_transaction_fact_conflict WHERE "factId" = $1`, [f.factId])).rows.map((r) => r.id as string)]) {
        expect(s, `P1's case names nothing of an observer (${x})`).not.toContain(x);
      }
      for (const o of [o1, o2]) expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_observation_conflict' AND "evidenceKey" = $1`, [o.b.attemptId])).toBe(1);
      expect(await moneyOf(f.p), 'P1\'s money is unchanged').toEqual(before);
      for (const reason of ['reviewed_no_financial_effect', 'duplicate_evidence_reviewed', 'provider_statement_reviewed']) {
        expect((await ack(B1, c.id, reason)).json?.code, reason).toBe('reconciliation_case_not_acknowledgeable');
      }
      record('O2C-2', 'same_company', { case: c, observers: 2 });
    }, T);

    it('O2C-3 (cross-Company, after completion): Company X\'s attempt reports Company A\'s fact: A gets its case with nothing of X; X\'s Owner sees nothing of A; and a fact owner WITHOUT a Billing relay (X) gets nothing (fail closed)', async () => {
      const f = await ownerFact(); // A's fact, through Billing's relay
      await settle();
      // X's payment and refund, requested directly at Payment with the producer's credential and a REAL receipt of X's Owner (as DO-74 D7): no Billing relay
      const px = await directPurchase(owners.x.company);
      const x = { caseId: randomUUID(), attemptId: randomUUID() };
      const rx = await receipt(owners.x, 'refund.authorize', { operation: 'refund', audience: 'payment-service', companyId: owners.x.company, refundCaseId: x.caseId,
        paymentId: px.paymentId, amount: px.amount, currency: 'TND', reason: 'customer_request', legalOverride: false });
      const made = await call(PAYMENT_URL, 'POST', billingToPaymentToken.token, `/payment/payments/${px.paymentId}/refunds`, { refundAttemptId: x.attemptId, refundCaseId: x.caseId,
        amount: px.amount, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: rx.secret });
      expect(made.status, JSON.stringify(made.json)).toBe(201);
      await waitFor(async () => (await one(paymentAdmin, `SELECT status FROM refund_attempt WHERE id = $1`, [x.attemptId]))?.status === 'submitted', 30_000, `X's dispatch\n${tails()}`);
      expect(await signedRaw(reportFor(x.attemptId, f.txn, px.amount))).toBe(200); // X's attempt reports A's refund
      await waitObservations(x.attemptId, 1);
      await waitContest(f.factId);
      await settle();
      const c = (await ownerContestCase(f.factId))!;
      expect(c).toMatchObject({ companyId: COMPANY, paymentId: f.p.paymentId });
      const s = await surface(c.id);
      for (const leak of [px.paymentId, px.paymentRequestId, x.attemptId, x.caseId, owners.x.company]) expect(s, `A's case names nothing of X (${leak})`).not.toContain(leak);
      expect((await call(B1, 'GET', owners.x.token, `/billing/admin/reconciliation-cases/${c.id}`)).status).toBe(404);
      expect((await ownerItemsOf(owners.x, 'refund_fact_contested')).some((i) => i.id === f.factId || i.paymentId === f.p.paymentId)).toBe(false);
      const aItems = (await ownerItemsOf(owners.a, 'refund_fact_contested')).filter((i) => i.id === f.factId);
      expect(aItems).toHaveLength(1);
      for (const leak of [px.paymentId, x.attemptId, owners.x.company]) expect(JSON.stringify(aItems), leak).not.toContain(leak);
      // the reverse: X's own fact (X's attempt reports its own refund), contested by A's attempt: Payment states X's owner item, Billing holds no relay of it: NO case
      const txnX = await providerRef(x.attemptId);
      const pxFresh = await directPurchase(owners.x.company);
      const y = { caseId: randomUUID(), attemptId: randomUUID() };
      const ry = await receipt(owners.x, 'refund.authorize', { operation: 'refund', audience: 'payment-service', companyId: owners.x.company, refundCaseId: y.caseId,
        paymentId: pxFresh.paymentId, amount: pxFresh.amount, currency: 'TND', reason: 'customer_request', legalOverride: false });
      expect((await call(PAYMENT_URL, 'POST', billingToPaymentToken.token, `/payment/payments/${pxFresh.paymentId}/refunds`, { refundAttemptId: y.attemptId, refundCaseId: y.caseId,
        amount: pxFresh.amount, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: ry.secret })).status).toBe(201);
      await waitFor(async () => (await one(paymentAdmin, `SELECT status FROM refund_attempt WHERE id = $1`, [y.attemptId]))?.status === 'submitted', 30_000, `Y's dispatch\n${tails()}`);
      const txnY = await providerRef(y.attemptId);
      expect(await rawRefund(y.attemptId, pxFresh.amount, txnY)).toBe(200);
      const yFact = await refundFactOf(txnY);
      const ob = await observerOf(txnY); // a Company A payment's attempt reports X's refund
      await settle();
      expect((await producerItemsOf('refund_fact_contested')).some((i) => i.id === yFact), 'Payment states the owner item').toBe(true);
      expect(await contestCount(yFact), 'no Billing relay of the owner\'s attempt: nothing opens (own_relay_missing)').toBe(0);
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_observation_conflict' AND "evidenceKey" = $1`, [ob.b.attemptId])).toBe(1);
      record('O2C-3', 'cross_company', { case: c, xOwnRelayMissing: true, txnX: !!txnX });
    }, T);

    it('O2C-4 (BEFORE allocation; LABELLED TEST AID: P1\'s payment row lock): the contradiction lands between P1\'s fact and its allocation: the case is contested_unallocated; no DO-73 case; the refund case stays open', async () => {
      const { p } = await buy('direct');
      const a = await relayed(p.paymentId, p.amount);
      const txn = await providerRef(a.attemptId);
      const { p: pb } = await buy('direct');
      const b = await relayed(pb.paymentId, pb.amount);
      const lock = await paymentAdmin.connect();
      let own: Promise<number> | undefined;
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [p.paymentId]);
        own = rawRefund(a.attemptId, p.amount, txn);
        await waitFor(async () => (await n(paymentAdmin, `SELECT count(*) AS n FROM provider_transaction_fact WHERE "providerTxnId" = $1 AND kind = 'refund'`, [txn])) === 1, 30_000, `P1's fact\n${tails()}`);
        expect(await signedRaw(reportFor(b.attemptId, txn, pb.amount))).toBe(200);
        await waitObservations(b.attemptId, 1);
      } finally {
        await lock.query('COMMIT').catch(() => undefined);
        lock.release();
      }
      await own; // the transient answer while the row was held is the test aid's, not the product's
      const factId = await refundFactOf(txn);
      await waitFor(async () => (await one(paymentAdmin, `SELECT reason FROM refund_fact_allocation_block WHERE "factId" = $1`, [factId]))?.reason === 'contested', 120_000, `the contested block\n${tails()}`);
      await waitContest(factId);
      await settle();
      expect(await ownerContestCase(factId)).toMatchObject({ paymentId: p.paymentId, detail: 'contested_unallocated', kind: null });
      expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_fact_unallocated' AND "evidenceKey" = $1`, [factId])).toBe(0);
      expect((await one(billingAdmin, `SELECT status FROM refund_case WHERE id = $1`, [a.caseId]))!.status).toBe('open');
      record('O2C-4', 'before_allocation', { case: await ownerContestCase(factId) });
    }, T);

    it('O2C-5 (chargeback overlap): a contested completed refund, then a chargeback: the overlap and the contest case coexist; nothing is written off; R3-F1 states no marker', async () => {
      const f = await ownerFact();
      await observerOf(f.txn);
      await waitContest(f.factId);
      const disputeId = await dispute(f.p.paymentId, f.p.amount);
      await waitFor(async () => !!(await one(billingAdmin, `SELECT 1 AS x FROM reconciliation_case WHERE "caseType" = 'chargeback_refund_overlap' AND "evidenceKey" = $1`, [disputeId])), 90_000, `the overlap\n${tails()}`);
      await settle();
      expect(writtenOff(await effects(disputeId))).toBe(0);
      const overlap = (await one(billingAdmin, `SELECT id FROM reconciliation_case WHERE "caseType" = 'chargeback_refund_overlap' AND "evidenceKey" = $1`, [disputeId]))!;
      expect((await call(B1, 'GET', owners.a.token, `/billing/admin/reconciliation-cases/${overlap.id}`)).json?.unreconciledFailedAttemptEvidence).toBe(false);
      expect(await ownerContestCase(f.factId)).toMatchObject({ kind: null });
      record('O2C-5', 'overlap', { contest: await ownerContestCase(f.factId) });
    }, T);

    it('O2C-6 (ordering; LABELLED TEST AID: the observer\'s DO-74 agreement held back): the fact owner\'s case opens FIRST; the observer\'s DO-74 case still opens afterwards', async () => {
      const f = await ownerFact();
      const { p: pb } = await buy('direct');
      const b = await relayed(pb.paymentId, pb.amount);
      proxyMode.set(pb.paymentId, 'pay08_obs_absent');
      try {
        expect(await signedRaw(reportFor(b.attemptId, f.txn, pb.amount))).toBe(200);
        await waitObservations(b.attemptId, 1);
        await waitContest(f.factId);
        await settle();
        expect(await observationCase(b.attemptId), 'held back: no observer case yet').toBeUndefined();
      } finally {
        proxyMode.delete(pb.paymentId);
      }
      await waitCase(() => observationCase(b.attemptId), 'the observer\'s DO-74 case after the owner\'s');
      expect(await contestCount(f.factId)).toBe(1);
      record('O2C-6', 'ordering', { ownerFirst: true });
    }, T);

    it(`O2C-7 (${OLD_PAYMENT && OLD_BILLING ? 'mixed versions: an older Payment and an older Billing, real main builds without O-2' : 'mixed versions, repository mode: the older-Payment contract (the unknown kind answered 400 by Payment itself) through the proxy'}): each older side opens nothing for the fact owner and breaks nothing else; after the upgrade the historical contest is discovered`, async () => {
      expect.hasAssertions(); // no path of this test may pass without asserting
      if (!OLD_PAYMENT || !OLD_BILLING) {
        // REPOSITORY MODE (CI: no historical binaries). LABELLED TEST AID `olderPayment.factOwner`: Billing's request for the new kind reaches the REAL Payment
        // under a kind Payment does not know, which is exactly what a Payment older than PAY-12 M answers (400 invalid_reconciliation_request)
        const fa = await ownerFact();
        olderFactOwnerAnswers.length = 0;
        olderPayment.factOwner = true;
        let oa: Awaited<ReturnType<typeof observerOf>> | undefined;
        try {
          await waitFor(async () => olderFactOwnerAnswers.length >= 2, 90_000, `Billing to ask the older Payment for the kind on two passes\n${tails()}`);
          expect(olderFactOwnerAnswers.every((a) => a.status === 400 && a.code === 'invalid_reconciliation_request'), JSON.stringify(olderFactOwnerAnswers)).toBe(true);
          oa = await observerOf(fa.txn); // the fact is contested now, but this Payment cannot state it
          await waitCase(() => observationCase(oa!.b.attemptId), 'the observer\'s DO-74 case while the new kind is unavailable (every other kind is still read)');
          expect(tails(), 'the isolated reader logged its own unavailability').toContain('payment_refund_fact_contested_read_unavailable');
          const asked = olderFactOwnerAnswers.length;
          await settle();
          expect(olderFactOwnerAnswers.length, 'later passes asked again and were refused again').toBeGreaterThan(asked);
          expect(olderFactOwnerAnswers.every((a) => a.status === 400)).toBe(true);
          expect(await contestCount(fa.factId), 'no fact-owner case without the new Payment item').toBe(0);
        } finally {
          olderPayment.factOwner = false;
        }
        await waitContest(fa.factId); // the current Payment again: the historical contest is discovered on the next pass, no backfill
        await settle();
        expect(await ownerContestCase(fa.factId)).toMatchObject({ paymentId: fa.p.paymentId, detail: 'contested_after_allocation', kind: null });
        expect(await contestCount(fa.factId)).toBe(1);
        expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_contest_evidence WHERE "refundFactId" = $1`, [fa.factId])).toBe(1);
        expect(await n(billingAdmin, `SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_observation_conflict' AND "evidenceKey" = $1`, [oa!.b.attemptId]),
          'the observer\'s DO-74 case is not lost').toBe(1);
        record('O2C-7', 'mode', { mode: 'repository_older_payment_contract', refusedAnswers: olderFactOwnerAnswers.length });
        return;
      }
      // (a) an older Payment behind Billing (the kind is unknown there: 400): the other kinds are still read (the observer's DO-74 case opens)
      const oldPay = spawnService('payment-main-without-o2', OLD_PAYMENT, { ...spawnedEnv.payment, PORT: String(PORT.b4) });
      let fa: Awaited<ReturnType<typeof ownerFact>>;
      try {
        await waitForHealth(`http://127.0.0.1:${PORT.b4}/health`, 30_000);
        fa = await ownerFact();
        upstream.url = `http://127.0.0.1:${PORT.b4}`;
        const oa = await observerOf(fa.txn);
        await waitCase(() => observationCase(oa.b.attemptId), 'the observer\'s case through the older Payment');
        await settle();
        expect(await contestCount(fa.factId), 'older Payment: no owner item, nothing opened').toBe(0);
      } finally {
        upstream.url = PAYMENT_URL;
        await oldPay.stop();
      }
      await waitContest(fa!.factId); // the current Payment again: discovered on the next pass, no backfill
      // (b) an older Billing alone: the fact owner gets nothing (the pre-O-2 behaviour), the observer its DO-74 case. The purchases and the observer's relay are
      // made first, through the current Billing (the harness's purchase helpers use it); the owner's refund and both reports then run under the older Billing alone
      const { p } = await buy('direct');
      const { p: po } = await buy('direct');
      const bo = await relayed(po.paymentId, po.amount);
      await billing1.stop();
      await billing2.stop();
      const oldBill = spawnService('billing-main-without-o2', OLD_BILLING, { ...spawnedEnv.billing1, PORT: String(PORT.b3) });
      let fb: Awaited<ReturnType<typeof ownerFact>> | undefined;
      try {
        await waitForHealth(`http://127.0.0.1:${PORT.b3}/health`, 30_000);
        const a = await call(`http://127.0.0.1:${PORT.b3}`, 'POST', owners.a.token, '/billing/admin/refund-cases', { paymentId: p.paymentId, reason: 'customer_request' });
        expect(a.status, JSON.stringify(a.json)).toBe(201);
        const r = await receipt(owners.a, 'refund.authorize', { operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: a.json.id, paymentId: p.paymentId, amount: p.amount,
          currency: 'TND', reason: 'customer_request', legalOverride: false });
        expect((await call(`http://127.0.0.1:${PORT.b3}`, 'POST', owners.a.token, `/billing/admin/refund-cases/${a.json.id}/authorizations`, { receiptSecret: r.secret })).status).toBe(201);
        const attemptId = (await one(billingAdmin, `SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1 ORDER BY "requestedAt" DESC LIMIT 1`, [a.json.id]))!.id as string;
        await waitFor(async () => (await one(paymentAdmin, `SELECT status FROM refund_attempt WHERE id = $1`, [attemptId]))?.status === 'submitted', 30_000, `dispatch\n${tails()}`);
        const txn = await providerRef(attemptId);
        expect(await rawRefund(attemptId, p.amount, txn)).toBe(200);
        await completedCase(a.json.id);
        fb = { p, a: { caseId: a.json.id, attemptId, receiptId: r.receiptId }, txn, factId: await refundFactOf(txn) };
        expect(await signedRaw(reportFor(bo.attemptId, txn, po.amount))).toBe(200);
        await waitObservations(bo.attemptId, 1);
        await waitCase(() => observationCase(bo.attemptId), 'the observer\'s case under the older Billing');
        await settle();
        expect(await contestCount(fb.factId), 'older Billing: the fact owner gets nothing').toBe(0);
      } finally {
        await oldBill.stop();
        billing1 = spawnService('billing1', BILLING_DIR, spawnedEnv.billing1);
        billing2 = spawnService('billing2', BILLING_DIR, spawnedEnv.billing2);
        await Promise.all([waitForHealth(`${B1}/health`, 30_000), waitForHealth(`${B2}/health`, 30_000)]);
      }
      await waitContest(fb!.factId); // after the upgrade: the historical contest is discovered (full rescan per pass)
      expect(await contestCount(fb!.factId)).toBe(1);
      record('O2C-7', 'mode', { mode: 'mixed_versions_old_binaries' });
    }, T);
  },
);
