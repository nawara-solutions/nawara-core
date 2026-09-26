import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sampleAuditPayload } from '@nawara/audit-contract/testing';
import { RabbitMqEventBus, generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { APPS, deadDepth, resetAuditQueues, sql, startAudit, type LiveAudit } from './support/audit.js';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';
import { billingPolicy, paymentPolicy, startReferenceStub } from './support/admission.js';

/** Stage 21.C.2: a stand-in Organization reference read + test-only caller policies (support/admission.ts). */
const refStub = await startReferenceStub();
afterAll(() => refStub.close());

/**
 * Stage 18.7.7 closure: ALL FIVE Core producers (built dists) → their own outboxes → their kit relays → ONE real RabbitMQ → ONE live
 * audit-service → audit_record → the Stage 18.6 query API. Plus the cross-producer identity rules of ADR-0049: the same event id from two
 * producers is two records (the key is (source, id)); the same producer re-sending an id with different evidence is refused (dead letter),
 * never overwritten.
 */
const PORT = { audit: 3881, payment: 3882, billing: 3883, organization: 3884, file: 3885, auth: 3886 };
const url = (s: keyof typeof PORT) => `http://127.0.0.1:${PORT[s]}`;
const b64 = () => randomBytes(32).toString('base64');
const ORG = crypto.randomUUID(); // one tenant organization, seen by Payment, Billing, File and Auth

describeWithEnv('all Core producers → one audit-service → query (all real)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let audit: LiveAudit;
  const dbs: Record<string, TestDatabase> = {};
  const live: LiveService[] = [];
  const root = mkdtempSync(join(tmpdir(), 's187-closure-'));
  const caller = generateServiceToken();
  const provisioning = generateServiceToken();
  const call = async (svc: keyof typeof PORT, method: string, path: string, body: unknown, headers: Record<string, string> = {}, raw = false) => {
    const r = await fetch(`${url(svc)}${path}`, {
      method, body: raw ? new Uint8Array(body as Buffer) : body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${caller.token}`, ...(raw ? {} : { 'content-type': 'application/json' }), 'x-correlation-id': 'closure-corr-0001', ...headers },
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const start = async (name: keyof typeof PORT, dir: string, e: NodeJS.ProcessEnv, health = '/health') => {
    const svc = spawnService(name, `${APPS}${dir}`, { NODE_ENV: 'test', PORT: String(PORT[name]), RABBITMQ_URL: env.TEST_RABBITMQ_URL, ...e });
    live.push(svc);
    try {
      await waitForHealth(`${url(name)}${health}`, 30_000);
    } catch (err) {
      throw new Error(`${String(err)}\n${svc.tail()}`);
    }
  };
  const database = async (name: string, dirs: string[], opts?: Parameters<typeof runMigrations>[2]) => {
    dbs[name] = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, `e2eclosure${name}`);
    await runMigrations(dbs[name]!.url, dirs, opts);
    return dbs[name]!.url;
  };

  beforeAll(async () => {
    await resetAuditQueues(env.TEST_RABBITMQ_URL);
    audit = await startAudit(env.TEST_DATABASE_ADMIN_URL, env.TEST_RABBITMQ_URL, PORT.audit);

    await start('payment', 'payment-service', {
      DATABASE_URL: await database('payment', [kitMigrationsDir, `${APPS}payment-service/db/migrations/`]), AUTH_SERVICE_URL: 'http://127.0.0.1:9',
      SERVICE_TOKENS: `core-caller:${caller.digest}`, ...paymentPolicy('core-caller'), ...refStub.env, PAYMENT_SUPPORTED_CURRENCIES: 'TND',
    });
    await start('billing', 'billing-service', {
      DATABASE_URL: await database('billing', [kitMigrationsDir, `${APPS}billing-service/db/migrations/`]), AUTH_SERVICE_URL: 'http://127.0.0.1:9',
      BILLING_SUPPORTED_CURRENCIES: 'TND', SERVICE_TOKENS: `core-caller:${caller.digest}`, ...billingPolicy('core-caller'), ...refStub.env, PAYMENT_SERVICE_URL: 'http://127.0.0.1:9', PAYMENT_SERVICE_TOKEN: generateServiceToken().token,
      BILLING_DISPATCH_INTERVAL_MS: '300000', BILLING_RECONCILE_INTERVAL_MS: '3600000',
    });
    const orgUrl = await database('organization', [kitMigrationsDir, `${APPS}organization-service/db/migrations/`]);
    for (const step of [`environment_class = 'fresh'`, `phase = 'VERIFIED', verified_digest = 'test'`, `phase = 'ACTIVATABLE', approved_by = 't', approved_reference = 't', approved_at = now()`, `phase = 'ACTIVE', activated_by = 't', activated_at = now()`]) {
      await sql(orgUrl, `UPDATE ownership_state SET ${step}`);
    }
    await start('organization', 'organization-service', {
      DATABASE_URL: orgUrl, AUTH_SERVICE_URL: 'http://127.0.0.1:9', SERVICE_TOKENS: `provisioning:${provisioning.digest}`,
      SERVICE_POLICY: JSON.stringify({ callers: { provisioning: { capabilities: ['hierarchy.provision'] } } }),
    });
    await start('file', 'file-service', {
      DATABASE_URL: await database('file', [kitMigrationsDir, `${APPS}file-service/db/migrations/`]), SERVICE_TOKENS: `core-caller:${caller.digest}`,
      FILE_SERVICE_POLICY: JSON.stringify({ callers: { 'core-caller': { operations: ['upload', 'read', 'delete'], organizations: 'request', mediaTypes: ['application/pdf'], maxBytes: 1_048_576 } } }),
      FILE_STORAGE_PROVIDER: 'filesystem', FILE_STORAGE_ROOT: root, FILE_PUBLIC_BASE_URL: 'http://files.e2e.invalid', FILE_REQUEST_HASH_KEY: b64(), FILE_RATE_LIMIT_KEY: b64(),
    });
    const authUrl = await database('auth', [`${APPS}auth-service/db/migrations/`], { fileTransaction: 'strip', strictHistory: true, adoptLegacyChecksums: true });
    const hash = await bcrypt.hash('member password 1', 4);
    const [co, pl] = [crypto.randomUUID(), crypto.randomUUID()];
    await sql(authUrl, `INSERT INTO company(id,name) VALUES ($1,'C')`, [co]);
    await sql(authUrl, `INSERT INTO platform(id,"companyId",name) VALUES ($1,$2,'P')`, [pl, co]);
    await sql(authUrl, `INSERT INTO organization(id,"platformId",name) VALUES ($1,$2,'O')`, [ORG, pl]);
    await sql(authUrl, `INSERT INTO "user"(id,kind,email,"passwordHash",role) VALUES (gen_random_uuid(),'member','adm@closure.test',$1,'member'), (gen_random_uuid(),'member','app@closure.test',$1,'member')`, [hash]);
    await sql(authUrl, `INSERT INTO organization_membership("userId","organizationId",status,audience,"approvedAt","isOrganizationAdmin") SELECT id,$1,'active','staff',now(),true FROM "user" WHERE email='adm@closure.test'`, [ORG]);
    await sql(authUrl, `INSERT INTO organization_membership("userId","organizationId",status,audience) SELECT id,$1,'pending','student' FROM "user" WHERE email='app@closure.test'`, [ORG]);
    await start('auth', 'auth-service', {
      DATABASE_URL: authUrl, AUTH_EVENTS: 'off', JWT_SECRET: b64(), OPERATOR_CODE_PEPPER: b64(), SECRET_KEY_PEPPER: b64(), THROTTLE_KEY_PEPPER: b64(), JOIN_CODE_PEPPER: b64(),
      TOTP_ENCRYPTION_KEYS: `k1:${b64()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', WEBAUTHN_RP_ID: 'auth.e2e.test', WEBAUTHN_ORIGINS: 'https://auth.e2e.test', BCRYPT_COST: '4',
      REQUIRE_CONTACT_VERIFICATION: 'false',
    });
  }, 240_000);
  afterAll(async () => {
    for (const s of live.reverse()) await s.stop();
    await audit?.stop();
    for (const d of Object.values(dbs)) await d.drop();
    await audit?.db.drop();
    rmSync(root, { recursive: true, force: true });
  });

  it('one action per producer lands in ONE audit store, with its own source; the 18.6 query API returns them by organization and platform-wide', async () => {
    const from = new Date(Date.now() - 60_000).toISOString();
    const payment = await call('payment', 'POST', '/payment/payments', {
      paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: 'inv-1', payer: { type: 'user', id: crypto.randomUUID() },
      seller: { type: 'organization', id: ORG }, organizationId: ORG, amount: 1500, currency: 'TND',
    });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    const product = await call('billing', 'POST', '/billing/products', { seller: { type: 'organization', id: ORG }, code: 'closure-p', name: 'N' });
    expect(product.status).toBe(201);
    const company = await call('organization', 'POST', '/organization/companies', { name: 'Closure Co' }, { authorization: `Bearer ${provisioning.token}`, 'idempotency-key': `k-${crypto.randomUUID()}` });
    expect(company.status).toBe(201);
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300, 0x20), Buffer.from('\n%%EOF\n')]);
    const file = await call('file', 'POST', '/file/files', pdf, { 'x-organization-id': ORG, 'idempotency-key': crypto.randomUUID(), 'x-attach': 'true', 'content-type': 'application/pdf' }, true);
    expect(file.status, JSON.stringify(file.body)).toBe(201);
    expect((await call('file', 'DELETE', `/file/files/${file.body.id}`, undefined, { 'x-organization-id': ORG })).status).toBe(202);
    const login = await fetch(`${url('auth')}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'adm@closure.test', password: 'member password 1' }) });
    const token = ((await login.json()) as { accessToken: string }).accessToken;
    const [{ id: mid }] = await sql<{ id: string }>(dbs.auth!.url, `SELECT m.id FROM organization_membership m JOIN "user" u ON u.id = m."userId" WHERE u.email = 'app@closure.test'`);
    expect((await fetch(`${url('auth')}/auth/organizations/${ORG}/memberships/${mid}/approve`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

    const expected = ['auth-service', 'billing-service', 'file-service', 'organization-service', 'payment-service'];
    await waitFor(async () => new Set((await audit.records(`"sourceService" <> 'audit-service'`)).map((r) => r.sourceService)).size === 5, 60_000, 'a record from every producer');
    const rows = await audit.records(`"sourceService" <> 'audit-service'`);
    expect([...new Set(rows.map((r) => r.sourceService))].sort()).toEqual(expected);
    expect(rows.map((r) => `${r.sourceService} ${r.action}`).sort()).toEqual([
      'auth-service membership.approved', 'billing-service product.created', 'file-service file.deleted', 'organization-service company.created', 'payment-service payment.created',
    ]);

    const to = new Date(Date.now() + 60_000).toISOString();
    const byOrg = await audit.get(`/audit/organizations/${ORG}/records?from=${from}&to=${to}`, audit.orgReader.token);
    expect(byOrg.status).toBe(200);
    expect(byOrg.body.items.map((i: any) => i.sourceService).sort()).toEqual(['auth-service', 'billing-service', 'file-service', 'payment-service']);
    for (const i of byOrg.body.items) expect(i.organizationId).toBe(ORG);
    // An organization reader asking for ANOTHER organization sees none of this evidence.
    const other = await audit.get(`/audit/organizations/${crypto.randomUUID()}/records?from=${from}&to=${to}`, audit.orgReader.token);
    expect(other.status).toBe(200);
    expect(other.body.items).toEqual([]);
    const platform = await audit.get(`/audit/platform/records?from=${from}&to=${to}`, audit.platformReader.token);
    expect(platform.status).toBe(200);
    expect(new Set(platform.body.items.map((i: any) => i.sourceService))).toEqual(new Set(expected));
    // The platform read is itself evidence (18.6: written in the read's own transaction, so visible after it).
    expect(await audit.records(`"sourceService" = 'audit-service' AND action = 'platform_query.executed'`)).toHaveLength(1);
    expect(await deadDepth(env.TEST_RABBITMQ_URL)).toBe(0);
  });

  it('the same event id from two producers is two records (the key is source + id); the same producer re-sending it with different evidence is dead-lettered, never overwritten', async () => {
    const shared = crypto.randomUUID();
    await sql(dbs.payment!.url, `INSERT INTO outbox(id, name, payload) VALUES ($1, 'audit.payment.created', $2::jsonb)`, [shared, JSON.stringify(sampleAuditPayload('payment.created'))]);
    await sql(dbs.billing!.url, `INSERT INTO outbox(id, name, payload) VALUES ($1, 'audit.product.created', $2::jsonb)`, [shared, JSON.stringify(sampleAuditPayload('product.created'))]);
    await waitFor(async () => (await audit.records(`"eventId" = $1`, [shared])).length === 2, 30_000, 'both records');
    const both = await audit.records(`"eventId" = $1`, [shared]);
    expect(both.map((r) => `${r.sourceService} ${r.action}`).sort()).toEqual(['billing-service product.created', 'payment-service payment.created']);

    const deadBefore = await deadDepth(env.TEST_RABBITMQ_URL);
    const forger = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, confirmTimeoutMs: 5000 });
    try {
      await forger.publish({
        id: shared, name: 'audit.payment.created', payload: { ...sampleAuditPayload('payment.created'), organizationId: crypto.randomUUID() },
        headers: { eventId: shared, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 },
      });
    } finally {
      await forger.close();
    }
    await waitFor(async () => (await deadDepth(env.TEST_RABBITMQ_URL)) === deadBefore + 1, 30_000, 'the conflicting copy dead-lettered');
    const after = await audit.records(`"eventId" = $1 AND "sourceService" = 'payment-service'`, [shared]);
    expect(after).toHaveLength(1);
    expect(after[0]!.organizationId).toBe(both.find((r) => r.sourceService === 'payment-service')!.organizationId); // the stored evidence is untouched
  });
});
