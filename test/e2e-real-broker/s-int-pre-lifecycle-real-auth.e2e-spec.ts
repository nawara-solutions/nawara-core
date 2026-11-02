import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
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
import { billingPolicy, TEST_PLATFORM } from './support/admission.js';
import { createPaymentIdentity, type PaymentIdentity } from './support/payment-identity.js';

let paymentIdentity: PaymentIdentity | undefined;

/**
 * Core V2 S-INT G8 (readiness record §7.3; S0-C7 item 1, DN-1.4) with NO stand-in for Auth: the BUILT organization-service, auth-service,
 * billing-service and payment-service as separate processes, over real HTTP and a REAL RabbitMQ, on simulation. `s-int-organization-reference`
 * uses a stand-in for `/auth/me` and so proves nothing about Auth; this suite does.
 *
 * Two Organizations of one Platform, one plain and one whose Organization Service answers carry a NON-CONTRACT lifecycle field. No Core V2 service
 * can produce that field, so a small relay in this test adds it to the real service's answers for that Organization only: the relay is the only
 * stand-in, and it proves how consumers treat an unexpected field, never that such a field exists. Auth's real `ensure` places each Organization
 * through the relay; Auth, Billing and Payment must then behave identically for both.
 *
 * SEEDED BY SQL (test setup, not under test): Organization Service's hierarchy and its test activation in this disposable database (the service
 * suites' `activateOwnership`, with Auth's real `hierarchy-retire` CLI on Auth's disposable database; this is NOT F7 and activates nothing anywhere else), Auth's Company, Owner, users and memberships (the memberships
 * only after `ensure` placed the Organization), and Billing's Platform configuration and catalog. DEVELOPMENT AND SIMULATION ONLY. It does not
 * exercise an inactive scope, which belongs to the first lifecycle-enabled release (S0-C7 items 2 and 3).
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ORG_DIR = `${ROOT}apps/organization-service`;
const AUTH_DIR = `${ROOT}apps/auth-service`;
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const ORG_PORT = 13761;
const AUTH_PORT = 13762;
const BILLING_PORT = 13763;
const PAYMENT_PORT = 13764;
const ORG_URL = `http://127.0.0.1:${ORG_PORT}`;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const COMPANY = randomUUID();
const PLATFORM = randomUUID();
const ORG_PLAIN = randomUUID();
const ORG_FIELD = randomUUID(); // its Organization Service answers carry the non-contract field
const OWNER = randomUUID();
const OWNER_EMAIL = `owner-${randomUUID().slice(0, 8)}@s-int.e2e.test`;
const PASSWORD = 's-int pre-lifecycle certification password';
const NON_CONTRACT = { effectiveStatus: 'SUSPENDED', effectiveSince: '2026-01-01T00:00:00.000Z', lifecycle: { state: 'SUSPENDED' } };
const LIFECYCLE_TEXT = /effectiveStatus|SUSPENDED|effectiveSince|lifecycle/;
const BASE = 3900;
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
const nextTotpStep = () => new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 500));

/** The structure of an answer with its identifiers and instants abstracted: what must be IDENTICAL for both Organizations. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, shape(x)]));
  if (typeof v === 'string' && (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v) || /^\d{4}-\d{2}-\d{2}T/.test(v))) return '<id-or-instant>';
  return v;
}

type Actor = { id: string; email: string; token: string };

describeWithEnv(
  'Core V2 S-INT G8: the real Organization Service, the real Auth, Billing and Payment behave identically for an Organization whose answers carry a non-contract lifecycle field (real RabbitMQ; simulation)',
  ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'],
  (env) => {
    let orgDb: TestDatabase;
    let authDb: TestDatabase;
    let billingDb: TestDatabase;
    let paymentDb: TestDatabase;
    let org: LiveService;
    let auth: LiveService;
    let billing: LiveService;
    let payment: LiveService;
    let relay: Server;
    let relayUrl = '';
    let amqpConn: ChannelModel;
    let orgAdmin: pg.Pool;
    let authAdmin: pg.Pool;
    let billingAdmin: pg.Pool;
    let paymentAdmin: pg.Pool;
    let productId = '';
    let priceId = '';
    let ownerToken = '';
    let totpSecret = '';
    const relayed: { path: string; injected: boolean }[] = [];
    const authRead = generateServiceToken();
    const billingRef = generateServiceToken();
    const paymentRef = generateServiceToken();
    const producerToken = generateServiceToken();
    const billingToPaymentToken = generateServiceToken();
    const harnessToken = generateServiceToken();
    const person = (): Actor => ({ id: randomUUID(), email: `${randomUUID().slice(0, 8)}@s-int.e2e.test`, token: '' });
    const people: Record<string, { admin: Actor; beneficiary: Actor }> = { [ORG_PLAIN]: { admin: person(), beneficiary: person() }, [ORG_FIELD]: { admin: person(), beneficiary: person() } };

    async function call(base: string, method: 'GET' | 'POST', token: string | null, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(method === 'POST' ? { 'idempotency-key': `idem-${randomUUID()}` } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    }
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
    const tails = () => `--- organization ---\n${org?.tail()}\n--- auth ---\n${auth?.tail()}\n--- payment ---\n${payment?.tail()}\n--- billing ---\n${billing?.tail()}`;

    beforeAll(async () => {
      orgDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eorgsintg8a');
      authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauthsintg8a');
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingsintg8a');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymentsintg8a');
      await runMigrations(orgDb.url, [kitMigrationsDir, `${ORG_DIR}/db/migrations/`]);
      await runMigrations(authDb.url, [`${AUTH_DIR}/db/migrations/`], { fileTransaction: 'strip', strictHistory: true, adoptLegacyChecksums: true });
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      orgAdmin = new pg.Pool({ connectionString: orgDb.url });
      authAdmin = new pg.Pool({ connectionString: authDb.url });
      billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      paymentAdmin = new pg.Pool({ connectionString: paymentDb.url });

      // Organization Service: its hierarchy, then the test activation (this disposable database only; not F7)
      await orgAdmin.query(`INSERT INTO company(id, name) VALUES ($1, 'G8 Company')`, [COMPANY]);
      await orgAdmin.query(`INSERT INTO platform(id, "companyId", name) VALUES ($1, $2, 'G8 Platform')`, [PLATFORM, COMPANY]);
      for (const o of [ORG_PLAIN, ORG_FIELD]) await orgAdmin.query(`INSERT INTO organization(id, "platformId", name) VALUES ($1, $2, 'G8 Organization')`, [o, PLATFORM]);
      await orgAdmin.query(`UPDATE ownership_state SET environment_class = COALESCE(environment_class, 'fresh')`);
      if ((await orgAdmin.query(`SELECT phase FROM ownership_state`)).rows[0].phase === 'PREPARED') await orgAdmin.query(`UPDATE ownership_state SET phase = 'VERIFIED', verified_digest = 'test'`);
      await orgAdmin.query(`UPDATE ownership_state SET phase = 'ACTIVATABLE', approved_by = 'test', approved_reference = 'test', approved_at = now()`);
      await orgAdmin.query(`UPDATE ownership_state SET phase = 'ACTIVE', activated_by = 'test', activated_at = now()`);

      // Auth: only the Company and its Owner; the Platform and the Organizations reach Auth through its real `ensure`
      const hash = await bcrypt.hash(PASSWORD, 4);
      await authAdmin.query(`INSERT INTO company(id, name) VALUES ($1, 'G8 Company')`, [COMPANY]);
      const oc = await authAdmin.connect();
      try {
        await oc.query('BEGIN');
        await oc.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'owner', $2, $3, 'admin')`, [OWNER, OWNER_EMAIL, hash]);
        await oc.query(`INSERT INTO owner("userId", "companyId") VALUES ($1, $2)`, [OWNER, COMPANY]);
        await oc.query('COMMIT');
      } finally {
        oc.release();
      }

      await billingAdmin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [PLATFORM, COMPANY, randomUUID()]);
      productId = (await billingAdmin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
        VALUES ('billing-owner', 'company', $1, 'g8-plan', 'Personal plan', 'active', 'personal', $2) RETURNING id`, [COMPANY, PLATFORM])).rows[0].id;
      priceId = (await billingAdmin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom")
        VALUES ($1, 'monthly', 'TND', $2, 'recurring', 'month', 1, '2020-01-01') RETURNING id`, [productId, BASE])).rows[0].id;

      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      paymentIdentity = await createPaymentIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
      await purgeQueue(BILLING_QUEUE);
      await purgeQueue(BILLING_DEAD_QUEUE);

      org = spawnService('organization', ORG_DIR, {
        NODE_ENV: 'test', PORT: String(ORG_PORT), DATABASE_URL: orgDb.url, AUTH_SERVICE_URL: 'http://127.0.0.1:1',
        SERVICE_TOKENS: `auth-service:${authRead.digest},billing-service:${billingRef.digest},payment-service:${paymentRef.digest}`,
        SERVICE_POLICY: JSON.stringify({ callers: {
          'auth-service': { capabilities: ['hierarchy.read'], allowedPlatforms: [PLATFORM] },
          'billing-service': { capabilities: ['hierarchy.reference.read'], allowedPlatforms: [PLATFORM] },
          'payment-service': { capabilities: ['hierarchy.reference.read'], allowedPlatforms: [PLATFORM] },
        } }),
      });
      try {
        await waitForHealth(`${ORG_URL}/health`, 30_000);
      } catch (e) {
        throw new Error(`${String(e)}\n${org.tail()}`);
      }
      // The relay: the real service's status and body, plus the non-contract field for ORG_FIELD's own answers
      relay = createServer((req, res) => {
        void (async () => {
          const path = req.url ?? '';
          const upstream = await fetch(`${ORG_URL}${path}`, { headers: { authorization: req.headers.authorization ?? '', accept: 'application/json' } });
          const text = await upstream.text();
          const injected = upstream.status === 200 && path.endsWith(`/organizations/${ORG_FIELD}`);
          relayed.push({ path, injected });
          res.writeHead(upstream.status, { 'content-type': 'application/json' });
          res.end(injected ? JSON.stringify({ ...JSON.parse(text), ...NON_CONTRACT }) : text);
        })().catch(() => { res.writeHead(502); res.end(); });
      });
      await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
      relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;

      const authEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'test', PORT: String(AUTH_PORT), DATABASE_URL: authDb.url, AUTH_EVENTS: 'off', RABBITMQ_URL: env.TEST_RABBITMQ_URL,
        JWT_SECRET: b64(), OPERATOR_CODE_PEPPER: b64(), SECRET_KEY_PEPPER: b64(), THROTTLE_KEY_PEPPER: b64(), JOIN_CODE_PEPPER: b64(),
        TOTP_ENCRYPTION_KEYS: `k1:${b64()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', WEBAUTHN_RP_ID: 'auth.e2e.test', WEBAUTHN_ORIGINS: 'https://auth.e2e.test',
        BCRYPT_COST: '4', REQUIRE_CONTACT_VERIFICATION: 'false',
        AUTH_HIERARCHY_SOURCE: 'organization-service', ORGANIZATION_SERVICE_URL: relayUrl, ORGANIZATION_SERVICE_TOKEN: authRead.token,
      };
      // Auth's real switch (its own operator CLI), in this disposable database only: first touches fail closed until the marker says so. NOT F7.
      const retired = spawnSync('node', ['dist/cli/main.js', 'hierarchy-retire', '--actor', 's-int-test', '--evidence', 's-int disposable test activation', '--fresh'],
        { cwd: AUTH_DIR, env: { ...process.env, ...authEnv }, encoding: 'utf8', timeout: 60_000 });
      expect(retired.status, `${retired.stdout}\n${retired.stderr}`).toBe(0);
      auth = spawnService('auth', AUTH_DIR, authEnv);
      payment = spawnService('payment', PAYMENT_DIR, {
        NODE_ENV: 'test', PORT: String(PAYMENT_PORT), DATABASE_URL: paymentDb.url, AUTH_SERVICE_URL: AUTH_URL,
        RABBITMQ_URL: paymentIdentity!.url(env.TEST_RABBITMQ_URL), PAYMENT_SUPPORTED_CURRENCIES: 'TND',
        PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
        SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest},simulation-harness:${harnessToken.digest}`,
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.create.assisted_settlement'], allowedPlatforms: [PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
        ORGANIZATION_SERVICE_URL: relayUrl, ORGANIZATION_REFERENCE_TOKEN: paymentRef.token,
      });
      billing = spawnService('billing', BILLING_DIR, {
        NODE_ENV: 'test', PORT: String(BILLING_PORT), DATABASE_URL: billingDb.url, AUTH_SERVICE_URL: AUTH_URL,
        RABBITMQ_URL: env.TEST_RABBITMQ_URL, BILLING_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `test-producer:${producerToken.digest}`,
        BILLING_SERVICE_POLICY: billingPolicy('test-producer').BILLING_SERVICE_POLICY.replaceAll(TEST_PLATFORM, PLATFORM),
        PAYMENT_SERVICE_URL: PAYMENT_URL, PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
        BILLING_DISPATCH_INTERVAL_MS: '300', BILLING_RECONCILE_INTERVAL_MS: '3600000', BILLING_ASSISTANCE_SWEEP_INTERVAL_MS: '1000',
        ORGANIZATION_SERVICE_URL: relayUrl, ORGANIZATION_REFERENCE_TOKEN: billingRef.token,
      });
      try {
        await Promise.all([waitForHealth(`${AUTH_URL}/health`, 30_000), waitForHealth(`${PAYMENT_URL}/health`, 30_000), waitForHealth(`${BILLING_URL}/health`, 30_000)]);
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n${tails()}`);
      }
      const start = await call(AUTH_URL, 'POST', null, '/auth/login', { email: OWNER_EMAIL, password: PASSWORD });
      expect(start.json?.status, JSON.stringify(start.json)).toBe('enrollment_required');
      const begin = await call(AUTH_URL, 'POST', null, '/auth/admin/enroll/totp', { enrollmentToken: start.json.enrollmentToken });
      totpSecret = begin.json.secret;
      const confirm = await call(AUTH_URL, 'POST', null, '/auth/admin/enroll/totp/confirm', { enrollmentToken: start.json.enrollmentToken, factorId: begin.json.factorId, code: totp(totpSecret) });
      expect(confirm.status, JSON.stringify(confirm.json)).toBe(200);
      ownerToken = confirm.json.accessToken;
    }, 150_000);

    afterAll(async () => {
      await billing?.stop();
      await payment?.stop();
      await auth?.stop();
      await org?.stop();
      if (relay) await new Promise<void>((r) => relay.close(() => r()));
      await paymentIdentity?.remove();
      if (amqpConn) {
        await purgeQueue(BILLING_QUEUE);
        await purgeQueue(BILLING_DEAD_QUEUE);
        await amqpConn.close().catch(() => undefined);
      }
      await orgAdmin?.end();
      await authAdmin?.end();
      await billingAdmin?.end();
      await paymentAdmin?.end();
      await orgDb?.drop();
      await authDb?.drop();
      await billingDb?.drop();
      await paymentDb?.drop();
    }, 45_000);

    /** The Owner's join code for an Organization: Auth's first touch, through its real `ensure` (AUTH_HIERARCHY_SOURCE=organization-service). */
    async function joinCode(organizationId: string) {
      await nextTotpStep();
      const su = await call(AUTH_URL, 'POST', ownerToken, '/auth/admin/step-up', { purpose: 'join_code.create', method: 'totp', code: totp(totpSecret) });
      expect(su.status, JSON.stringify(su.json)).toBe(200);
      return call(AUTH_URL, 'POST', ownerToken, `/auth/organizations/${organizationId}/join-codes`, { audience: 'member', requiresApproval: false, requiresSubscription: false },
        { 'x-step-up-token': su.json.stepUpToken });
    }
    /** An Organization's whole assisted path through the real Auth, Billing and Payment; every step's answer, abstracted, for comparison. */
    async function assistedPath(organizationId: string) {
      const { admin, beneficiary } = people[organizationId]!;
      const seen: Record<string, unknown> = {};
      const created = await call(BILLING_URL, 'POST', beneficiary.token, '/billing/assistance-requests', { organizationId, productId, priceId, consent: true });
      expect(created.status, `${JSON.stringify(created.json)}\n${tails()}`).toBe(201);
      expect(JSON.stringify(created.json)).not.toMatch(LIFECYCLE_TEXT);
      expect((await billingAdmin.query(`SELECT "organizationId", "platformId" FROM assistance_request WHERE id = $1`, [created.json.id])).rows[0]).toEqual({ organizationId, platformId: PLATFORM });
      seen.created = shape(created.json);
      seen.restrictionsAfterCreate = (await billingAdmin.query(`SELECT kind FROM billing_assistance_restrictions($1, now())`, [organizationId])).rows.map((r) => r.kind);
      await new Promise((r) => setTimeout(r, 20));
      const cash = await call(BILLING_URL, 'POST', admin.token, `/billing/assistance-requests/${created.json.id}/cash-collection`, { cashCollectedAt: new Date().toISOString() });
      expect(cash.status, JSON.stringify(cash.json)).toBe(200);
      seen.cash = shape(cash.json);
      const settled = await call(BILLING_URL, 'POST', admin.token, `/billing/assistance-requests/${created.json.id}/settlement`);
      expect(settled.status, JSON.stringify(settled.json)).toBe(201);
      seen.settlement = shape(settled.json);
      await waitFor(async () => (await billingAdmin.query(`SELECT "paymentId" FROM payment_request WHERE id = $1 AND status = 'requested'`, [settled.json.paymentRequestId])).rows[0]?.paymentId != null,
        20_000, `Billing's dispatcher to create the payment, which Payment verifies through the reference\n${tails()}`);
      const paymentId = (await billingAdmin.query(`SELECT "paymentId" FROM payment_request WHERE id = $1`, [settled.json.paymentRequestId])).rows[0].paymentId as string;
      expect((await paymentAdmin.query(`SELECT "payerType", "payerId", "organizationId", purpose FROM payment WHERE id = $1`, [paymentId])).rows[0])
        .toEqual({ payerType: 'organization', payerId: organizationId, organizationId, purpose: 'assisted_settlement' });
      const attempt = await call(PAYMENT_URL, 'POST', admin.token, `/payment/payments/${paymentId}/attempts`, {});
      expect(attempt.json, `${JSON.stringify(attempt.json)}\n${tails()}`).toMatchObject({ provider: 'simulation', status: 'submitted' });
      seen.attempt = shape({ provider: attempt.json.provider, status: attempt.json.status });
      const r = await call(PAYMENT_URL, 'POST', harnessToken.token, `/payment/simulation/payments/${paymentId}/attempts/${attempt.json.id}/outcomes`, { commandId: `g8a-${randomUUID()}`, outcome: 'succeeded' });
      expect(r.json?.delivered, JSON.stringify(r.json)).toEqual({ status: 200 });
      await waitFor(async () => (await billingAdmin.query(`SELECT 1 FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [created.json.id])).rowCount === 1,
        30_000, `Billing to record the beneficiary's purchase from the verified event\n${tails()}`);
      const ent = await call(BILLING_URL, 'GET', producerToken.token, `/billing/users/${beneficiary.id}/platforms/${PLATFORM}/products/${productId}/entitlement`);
      expect(ent.json?.valid, JSON.stringify(ent.json)).toBe(true);
      seen.entitlement = shape(ent.json);
      const own = await call(BILLING_URL, 'GET', beneficiary.token, `/billing/me/platforms/${PLATFORM}/personal-subscriptions`);
      expect(own.status, JSON.stringify(own.json)).toBe(200);
      seen.own = shape(own.json);
      seen.restrictionsAfterPurchase = (await billingAdmin.query(`SELECT kind FROM billing_assistance_restrictions($1, now())`, [organizationId])).rows.map((x) => x.kind);
      return seen;
    }

    it('Organization Service\'s own reference read carries exactly the three anchors; the non-contract field exists only on the relay\'s answers', async () => {
      for (const id of [ORG_PLAIN, ORG_FIELD]) {
        const direct = await call(ORG_URL, 'GET', billingRef.token, `/organization/reference/organizations/${id}`);
        expect(direct.json, JSON.stringify(direct.json)).toEqual({ organizationId: id, platformId: PLATFORM, companyId: COMPANY });
      }
      expect((await call(relayUrl, 'GET', billingRef.token, `/organization/reference/organizations/${ORG_PLAIN}`)).json).toEqual({ organizationId: ORG_PLAIN, platformId: PLATFORM, companyId: COMPANY });
      expect((await call(relayUrl, 'GET', billingRef.token, `/organization/reference/organizations/${ORG_FIELD}`)).json).toEqual({ organizationId: ORG_FIELD, platformId: PLATFORM, companyId: COMPANY, ...NON_CONTRACT });
    });

    it('Auth: its real ensure places both Organizations identically; the non-contract field is never stored or answered; /auth/me and its Organization read carry no lifecycle', async () => {
      const results: unknown[] = [];
      for (const id of [ORG_PLAIN, ORG_FIELD]) {
        const code = await joinCode(id);
        expect(code.status, `${JSON.stringify(code.json)}\n${tails()}`).toBe(201);
        expect(JSON.stringify(code.json)).not.toMatch(LIFECYCLE_TEXT);
        const row = (await authAdmin.query(`SELECT * FROM organization WHERE id = $1`, [id])).rows[0];
        expect(row, `Auth placed ${id}`).toMatchObject({ platformId: PLATFORM, name: 'G8 Organization' });
        expect(JSON.stringify(row)).not.toMatch(LIFECYCLE_TEXT);
        const read = await call(AUTH_URL, 'GET', ownerToken, `/auth/admin/organizations/${id}`);
        expect(read.json, JSON.stringify(read.json)).toEqual({ id, platformId: PLATFORM });
        results.push({ code: shape({ ...code.json, code: '<random join code>' }), row: shape(row) });
      }
      expect(results[1]).toEqual(results[0]);
      expect(relayed.filter((c) => c.path === `/organization/organizations/${ORG_FIELD}` && c.injected), 'Auth did read the field-carrying answer').not.toEqual([]);
      expect((await authAdmin.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('company', 'platform', 'organization') AND column_name ~* 'status|lifecycle|effective|suspend'`)).rows[0].n).toBe(0);
      // the members (SEEDED: Auth's own rows, on the Organizations ensure just placed), then real logins; `/auth/me` is what Billing and Payment verify
      const hash = await bcrypt.hash(PASSWORD, 4);
      const me: unknown[] = [];
      for (const id of [ORG_PLAIN, ORG_FIELD]) {
        for (const [a, isAdmin] of [[people[id]!.admin, true], [people[id]!.beneficiary, false]] as const) {
          const c = await authAdmin.connect();
          try {
            await c.query('BEGIN');
            await c.query(`INSERT INTO "user"(id, kind, email, "passwordHash", role) VALUES ($1, 'member', $2, $3, 'member')`, [a.id, a.email, hash]);
            await c.query(`INSERT INTO organization_membership ("userId", "organizationId", status, audience, "approvedAt", "isOrganizationAdmin") VALUES ($1, $2, 'active', 'member', now(), $3)`, [a.id, id, isAdmin]);
            await c.query('COMMIT');
          } finally {
            c.release();
          }
          const login = await call(AUTH_URL, 'POST', null, '/auth/login', { email: a.email, password: PASSWORD });
          expect(login.status, JSON.stringify(login.json)).toBe(200);
          a.token = login.json.accessToken;
        }
        const read = await call(AUTH_URL, 'GET', people[id]!.admin.token, '/auth/me');
        expect(read.status, JSON.stringify(read.json)).toBe(200);
        expect(JSON.stringify(read.json)).not.toMatch(LIFECYCLE_TEXT);
        const { email: _email, ...rest } = read.json as Record<string, unknown>;
        me.push(shape(rest));
      }
      expect(me[1]).toEqual(me[0]);
    }, 180_000);

    it('Billing and Payment: the whole assisted path behaves identically for both Organizations, verified live by the real Auth; no inactive restriction; nothing echoes the field', async () => {
      const plain = await assistedPath(ORG_PLAIN);
      const field = await assistedPath(ORG_FIELD);
      expect(field).toEqual(plain);
      expect(plain.restrictionsAfterCreate).toEqual([]);
      expect(plain.restrictionsAfterPurchase).toEqual([]);
      expect(relayed.filter((c) => c.path === `/organization/reference/organizations/${ORG_FIELD}` && c.injected), 'Billing and Payment did read the field-carrying answer').not.toEqual([]);
      const ch = await amqpConn.createChannel();
      expect((await ch.checkQueue(BILLING_DEAD_QUEUE)).messageCount).toBe(0);
      await ch.close();
    }, 180_000);
  },
);
