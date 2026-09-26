import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { releaseMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { FakeAuth } from './support/fake-auth.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

type Row = Record<string, any>;

const OPERATING = randomUUID();

/**
 * Stage 20.7 (focused certification): two cross-surface proofs the per-stage suites do not make in one place.
 * 1. The certified AUTHORITY MATRIX: every caller type against all five operations (CI register / publish, owner withdraw / minimum,
 *    public read) on the SAME application — no credential opens a surface it does not own.
 * 2. The POSTGRESQL-DOWN row of the failure matrix, per surface: every persistence-dependent surface fails with a bounded error (never a
 *    partial write, never a compatibility decision), `/health` stays up, `/ready` fails, and everything recovers.
 * Test-only: no runtime change.
 */
describeWithEnv('Stage 20.7 certification: authority matrix and PostgreSQL-down failure matrix (real PostgreSQL, runtime role)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  const auth = new FakeAuth();
  const ci = generateServiceToken(); // prod: register + publish
  const otherCi = generateServiceToken(); // else: register + publish (another product's automation)
  const registerOnly = generateServiceToken(); // prod: register only
  const foreign = generateServiceToken(); // a credential registered nowhere in this service
  const B = { owner: 'cert-owner', wrongOwner: 'cert-owner-other-company', operator: 'cert-operator', member: 'cert-member' };
  const server = () => t.app.getHttpServer();

  beforeAll(async () => {
    await auth.start();
    auth.identities.set(B.owner, { userId: randomUUID(), kind: 'owner', companyId: OPERATING });
    auth.identities.set(B.wrongOwner, { userId: randomUUID(), kind: 'owner', companyId: randomUUID() });
    auth.identities.set(B.operator, { userId: randomUUID(), kind: 'operator', companyId: null });
    auth.identities.set(B.member, { userId: randomUUID(), kind: 'member', companyId: null });
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'relcert');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, releaseMigrationsDir]);
    t = await createTestApp({
      databaseUrl: d.appUrl,
      env: {
        SERVICE_TOKENS: `prod-ci:${ci.digest},else-ci:${otherCi.digest},prod-register:${registerOnly.digest}`,
        RELEASE_SERVICE_POLICY: JSON.stringify({ callers: {
          'prod-ci': { products: { prod: ['release.register', 'release.publish'] } },
          'else-ci': { products: { else: ['release.register', 'release.publish'] } },
          'prod-register': { products: { prod: ['release.register'] } },
        } }),
        AUTH_SERVICE_URL: auth.url, RELEASE_OPERATING_COMPANY_ID: OPERATING, RELEASE_COMPATIBILITY_RATE_PER_CLIENT: '100000',
      },
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
    await auth.stop();
  });

  type Caller = { name: string; headers: () => Record<string, string>; bearer?: string };
  const callers: Caller[] = [
    { name: 'CI (own product)', headers: () => ({ authorization: `Bearer ${ci.token}` }) },
    { name: 'CI (register-only)', headers: () => ({ authorization: `Bearer ${registerOnly.token}` }) },
    { name: 'CI (wrong product)', headers: () => ({ authorization: `Bearer ${otherCi.token}` }) },
    { name: 'foreign service credential', headers: () => ({ authorization: `Bearer ${foreign.token}` }) },
    { name: 'owner (operating Company)', headers: () => ({ authorization: `Bearer ${B.owner}` }), bearer: B.owner },
    { name: 'owner (wrong Company)', headers: () => ({ authorization: `Bearer ${B.wrongOwner}` }), bearer: B.wrongOwner },
    { name: 'operator', headers: () => ({ authorization: `Bearer ${B.operator}` }), bearer: B.operator },
    { name: 'member', headers: () => ({ authorization: `Bearer ${B.member}` }), bearer: B.member },
    { name: 'anonymous', headers: () => ({}) },
    { name: 'anonymous with forged identity headers', headers: () => ({ 'x-service': 'prod-ci', 'x-caller': 'prod-ci', 'x-product': 'prod', 'x-owner': 'true', 'x-role': 'owner', 'x-user-id': randomUUID(), 'x-company': OPERATING, 'x-permissions': 'release.register release.publish' }) },
  ];

  /** Expected outcome per caller and operation: `ok` (the operation ran) or the HTTP status of the refusal. */
  const EXPECTED: Record<string, Record<'register' | 'publish' | 'withdraw' | 'minimum' | 'read', 'ok' | number>> = {
    'CI (own product)':                         { register: 'ok', publish: 'ok', withdraw: 401, minimum: 401, read: 'ok' },
    'CI (register-only)':                       { register: 'ok', publish: 403, withdraw: 401, minimum: 401, read: 'ok' },
    'CI (wrong product)':                       { register: 403, publish: 403, withdraw: 401, minimum: 401, read: 'ok' },
    'foreign service credential':               { register: 401, publish: 401, withdraw: 401, minimum: 401, read: 'ok' },
    'owner (operating Company)':                { register: 401, publish: 401, withdraw: 'ok', minimum: 'ok', read: 'ok' },
    'owner (wrong Company)':                    { register: 401, publish: 401, withdraw: 403, minimum: 403, read: 'ok' },
    'operator':                                 { register: 401, publish: 401, withdraw: 403, minimum: 403, read: 'ok' },
    'member':                                   { register: 401, publish: 401, withdraw: 403, minimum: 403, read: 'ok' },
    'anonymous':                                { register: 401, publish: 401, withdraw: 401, minimum: 401, read: 'ok' },
    'anonymous with forged identity headers':   { register: 401, publish: 401, withdraw: 401, minimum: 401, read: 'ok' },
  };

  it.each(callers.map((c) => [c.name, c] as const))('authority matrix — %s', async (_name, caller) => {
    // A fresh component with 1.0.0 and 2.0.0 published (by the real CI), and 3.0.0 registered, for every caller.
    const c = `m-${randomUUID().slice(0, 8)}`;
    const ciPost = (path: string, body?: Row) => request(server()).post(`/release/products/prod/components/${c}${path}`).set('authorization', `Bearer ${ci.token}`).send(body);
    for (const v of ['1.0.0', '2.0.0']) {
      expect((await ciPost('/releases', { kind: 'web', version: v })).status).toBe(201);
      expect((await ciPost(`/releases/${v}/publish`)).status).toBe(200);
    }
    expect((await ciPost('/releases', { kind: 'web', version: '3.0.0' })).status).toBe(201);
    const proof = (purpose: string) => (caller.bearer ? { 'x-step-up-token': auth.issue(caller.bearer, purpose) } : { 'x-step-up-token': randomUUID() });

    const results = {
      register: await request(server()).post(`/release/products/prod/components/${c}/releases`).set(caller.headers()).send({ kind: 'web', version: '4.0.0' }),
      publish: await request(server()).post(`/release/products/prod/components/${c}/releases/3.0.0/publish`).set(caller.headers()),
      withdraw: await request(server()).post(`/release/admin/products/prod/components/${c}/releases/2.0.0/withdraw`).set({ ...caller.headers(), ...proof('release.withdraw') }),
      minimum: await request(server()).post(`/release/admin/products/prod/components/${c}/compatibility-policy`).set({ ...caller.headers(), ...proof('compatibility_policy.change') }).send({ minimumVersion: '1.0.0', expectedPolicyVersion: 0 }),
      read: await request(server()).get(`/release/products/prod/components/${c}/compatibility`).query({ version: '1.0.0' }).set(caller.headers()),
    };
    for (const [op, r] of Object.entries(results)) {
      const want = EXPECTED[caller.name]![op as keyof (typeof EXPECTED)[string]];
      if (want === 'ok') expect(r.status, `${op}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
      else expect(r.status, `${op}: ${JSON.stringify(r.body)}`).toBe(want);
    }
    // What actually changed matches exactly what was allowed.
    const rows = await sql<Row>(d.adminUrl, `SELECT r.version, r.status FROM release r JOIN component k ON k.id = r."componentId" WHERE k.key = $1 ORDER BY r.major, r.minor`, [c]);
    const state = Object.fromEntries(rows.map((r) => [r.version, r.status]));
    const allowed = EXPECTED[caller.name]!;
    expect('4.0.0' in state).toBe(allowed.register === 'ok');
    expect(state['3.0.0']).toBe(allowed.publish === 'ok' ? 'published' : 'registered');
    expect(state['2.0.0']).toBe(allowed.withdraw === 'ok' ? 'withdrawn' : 'published');
    const policies = await sql<Row>(d.adminUrl, `SELECT 1 FROM compatibility_policy p JOIN component k ON k.id = p."componentId" WHERE k.key = $1`, [c]);
    expect(policies.length).toBe(allowed.minimum === 'ok' ? 1 : 0);
    // release-service's OWN service credentials are never forwarded to Auth. (A credential registered only at another service is an
    // opaque value indistinguishable from any unknown bearer: it reaches Auth, which refuses it — 401 — exactly like a forged bearer.)
    for (const tok of [ci, otherCi, registerOnly]) expect(JSON.stringify(auth.received)).not.toContain(tok.token);
  });

  describe('failure matrix — PostgreSQL down', () => {
    it('every persistence-dependent surface fails bounded (no decision, no partial write); /health 200, /ready 503; all recover', async () => {
      const c = `db-${randomUUID().slice(0, 8)}`;
      const post = (path: string, body?: Row, headers: Record<string, string> = { authorization: `Bearer ${ci.token}` }) =>
        request(server()).post(`/release/products/prod/components/${c}${path}`).set(headers).send(body);
      expect((await post('/releases', { kind: 'web', version: '1.0.0' })).status).toBe(201);
      expect((await post('/releases/1.0.0/publish')).status).toBe(200);
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS false`);
      await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND application_name = 'release-service'`, [d.name]);
      try {
        const down = {
          register: await post('/releases', { kind: 'web', version: '2.0.0' }),
          publish: await post('/releases/1.0.0/publish'),
          withdraw: await request(server()).post(`/release/admin/products/prod/components/${c}/releases/1.0.0/withdraw`).set({ authorization: `Bearer ${B.owner}`, 'x-step-up-token': auth.issue(B.owner, 'release.withdraw') }),
          read: await request(server()).get(`/release/products/prod/components/${c}/compatibility`).query({ version: '1.0.0' }),
        };
        for (const [op, r] of Object.entries(down)) {
          expect(r.status, op).toBeGreaterThanOrEqual(500);
          expect(r.body.update, op).toBeUndefined(); // never a compatibility decision
          expect(JSON.stringify(r.body), op).not.toMatch(/ECONN|terminat|password|postgres|127\.0\.0\.1|release_app/i);
        }
        expect(down.read.headers['cache-control']).toBe('no-store');
        expect((await request(server()).get('/health')).status).toBe(200);
        const ready = await request(server()).get('/ready');
        expect(ready.status).toBe(503);
        expect(ready.body.failed).toContain('database');
      } finally {
        await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS true`);
      }
      // Recovery: nothing was half-written; the surfaces answer again.
      await expect.poll(async () => (await request(server()).get('/ready')).status, { timeout: 15_000 }).toBe(200);
      const rows = await sql<Row>(d.adminUrl, `SELECT r.version, r.status FROM release r JOIN component k ON k.id = r."componentId" WHERE k.key = $1`, [c]);
      expect(rows).toEqual([{ version: '1.0.0', status: 'published' }]);
      expect((await request(server()).get(`/release/products/prod/components/${c}/compatibility`).query({ version: '1.0.0' })).body).toEqual({ update: 'none', latestVersion: '1.0.0', minimumVersion: null });
    });
  });
});
