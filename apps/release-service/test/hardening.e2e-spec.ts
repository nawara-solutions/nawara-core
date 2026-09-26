import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type EventBus, type EventEnvelope } from '@nawara/service-kit';
import { releaseMigrationsDir } from '../src/app.module.js';
import { CompatibilityLimiterJanitor, CompatibilityReporter } from '../src/compatibility/compatibility-ops.js';
import { ReleaseOpsReporter } from '../src/ops/release-ops.js';
import { createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

type Row = Record<string, any>;

class SwitchableBus implements EventBus {
  up = true;
  async publish(_e: EventEnvelope): Promise<void> {
    if (!this.up) throw new Error('broker unavailable (test)');
  }
  async subscribe(): Promise<{ close(): Promise<void> }> {
    throw new Error('release-service consumes nothing');
  }
  async close(): Promise<void> {}
}

/**
 * Stage 20.6: operational and adversarial hardening of the whole Release Management surface, through the REAL application as the runtime
 * role on real PostgreSQL 16: bounded counters from real traffic, the outbox backlog signal, dependency classification (Auth, broker,
 * limiter storage), the rate-limit client address under TRUST_PROXY, public-input abuse, and shutdown.
 */
describeWithEnv('release-service operational hardening (Stage 20.6) — real PostgreSQL, runtime role', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  const bus = new SwitchableBus();
  const ci = generateServiceToken();
  const other = generateServiceToken();
  const tokens = `prod-ci:${ci.digest},other-ci:${other.digest}`;
  const policy = JSON.stringify({ callers: { 'prod-ci': { products: { prod: ['release.register', 'release.publish'] } }, 'other-ci': { products: { else: ['release.register'] } } } });
  let n = 0;
  const key = (p = 'h') => `${p}-${n++}`;
  const register = (app: TestApp, component: string, version: string, who = ci, extra: Row = {}) =>
    request(app.app.getHttpServer()).post(`/release/products/prod/components/${component}/releases`).set('authorization', `Bearer ${who.token}`).send({ kind: 'web', version, ...extra });
  const publish = (app: TestApp, component: string, version: string) =>
    request(app.app.getHttpServer()).post(`/release/products/prod/components/${component}/releases/${version}/publish`).set('authorization', `Bearer ${ci.token}`);
  const check = (app: TestApp, component: string, version: string, headers: Record<string, string> = {}) =>
    request(app.app.getHttpServer()).get(`/release/products/prod/components/${component}/compatibility`).query({ version }).set(headers);
  const lastLine = (app: TestApp, prefix: string) => app.logs.map((l) => String(l.msg)).filter((m) => m.startsWith(`${prefix} `)).at(-1) ?? '';
  const cells = (line: string) => Object.fromEntries(line.split(' ').slice(1).map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'relhard');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, releaseMigrationsDir]);
    t = await createTestApp({
      databaseUrl: d.appUrl, bus,
      env: {
        SERVICE_TOKENS: tokens, RELEASE_SERVICE_POLICY: policy, RELEASE_COMPATIBILITY_RATE_PER_CLIENT: '100000',
        AUTH_SERVICE_URL: 'http://127.0.0.1:9', RELEASE_OPERATING_COMPANY_ID: '00000000-0000-4000-8000-000000000001', // Auth DOWN (nothing listens)
      },
    });
    await t.app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
  });

  describe('bounded operational counters from real traffic', () => {
    it('automation and admin outcomes are counted in the snapshot with closed labels only; no product, version, caller, owner or address', async () => {
      const reporter = t.app.get(ReleaseOpsReporter);
      reporter.counterLines(); // start from zero
      const c = key('counted');
      expect((await register(t, c, '4.5.6', ci, { buildId: 'SECRET-BUILD' })).status).toBe(201);
      expect((await register(t, c, '4.5.6', ci, { buildId: 'SECRET-BUILD' })).status).toBe(200); // unchanged
      expect((await register(t, c, '4.5.6', ci, { buildId: 'OTHER' })).status).toBe(409); // conflict
      expect((await register(t, c, '4.5.6', other)).status).toBe(403); // denied (another product)
      expect((await publish(t, c, '4.5.6')).status).toBe(200);
      expect((await publish(t, c, '9.9.9')).status).toBe(404);
      expect((await request(server()).post(`/release/admin/products/prod/components/${c}/releases/4.5.6/withdraw`).set('authorization', 'Bearer some-owner')).status).toBe(503); // Auth down
      reporter.counterLines();
      const a = cells(lastLine(t, 'release_automation_snapshot'));
      expect(a).toMatchObject({ register_changed: 1, register_unchanged: 1, register_conflict: 1, register_denied: 1, publish_changed: 1, publish_not_found: 1 });
      expect(cells(lastLine(t, 'release_admin_snapshot'))).toMatchObject({ withdraw_auth_unavailable: 1 });
      for (const line of [lastLine(t, 'release_automation_snapshot'), lastLine(t, 'release_admin_snapshot')]) {
        expect(line).toMatch(/^release_(automation|admin)_snapshot( [a-z_]+=\d+)+$/);
        expect(line).not.toMatch(/prod|4\.5\.6|counted|SECRET|ci|owner/);
      }
      const startup = lastLine(t, 'release_surfaces');
      expect(startup).toMatch(/^release_surfaces automation_callers=2 owner_admin=enabled auth_timeout_ms=3000 compatibility_max_age_s=60 compatibility_rate_per_client=100000 trust_proxy=false cors_origins=0$/);
      expect(JSON.stringify(t.logs)).not.toMatch(/127\.0\.0\.1:9|RELEASE_RATE_LIMIT_KEY/);
    });
    const server = () => t.app.getHttpServer();
  });

  describe('outbox backlog (audit delivery stays asynchronous)', () => {
    it('broker down: mutations still commit; the snapshot shows the pending backlog, its age and the retries; back up: it drains to 0', async () => {
      const reporter = t.app.get(ReleaseOpsReporter);
      await expect.poll(async () => (await reporter.backlog()).pending, { timeout: 15_000 }).toBe(0);
      bus.up = false;
      const c = key('backlog');
      expect((await register(t, c, '1.0.0')).status).toBe(201);
      expect((await publish(t, c, '1.0.0')).status).toBe(200);
      await expect.poll(async () => (await reporter.backlog()).retrying, { timeout: 10_000 }).toBeGreaterThan(0);
      await reporter.snapshot();
      const line = lastLine(t, 'release_outbox_snapshot');
      expect(cells(line).pending).toBeGreaterThanOrEqual(2);
      expect(cells(line).max_attempts).toBeGreaterThanOrEqual(1);
      expect(line).toMatch(/^release_outbox_snapshot pending=\d+ oldest_pending_s=\d+ retrying=\d+ max_attempts=\d+$/);
      expect((await check(t, c, '1.0.0')).status).toBe(200); // the public read is unaffected by the broker
      expect((await request(t.app.getHttpServer()).get('/ready')).status).toBe(200); // the broker is not a readiness dependency
      bus.up = true;
      await expect.poll(async () => (await reporter.backlog()).pending, { timeout: 30_000, interval: 250 }).toBe(0);
    });
  });

  describe('dependency classification', () => {
    it('Auth unavailable: automation and the public read keep working; owner administration fails closed (503); /ready stays 200', async () => {
      const c = key('authdown');
      expect((await register(t, c, '1.0.0')).status).toBe(201);
      expect((await publish(t, c, '1.0.0')).status).toBe(200);
      expect((await check(t, c, '1.0.0')).body.update).toBe('none');
      const admin = await request(t.app.getHttpServer()).post(`/release/admin/products/prod/components/${c}/compatibility-policy`).set('authorization', 'Bearer owner').send({ minimumVersion: '1.0.0', expectedPolicyVersion: 0 });
      expect([admin.status, admin.body.code]).toEqual([503, 'auth_unavailable']);
      expect(JSON.stringify(admin.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
      expect(await sql(d.adminUrl, `SELECT 1 FROM compatibility_policy p JOIN component c ON c.id = p."componentId" WHERE c.key = $1`, [c])).toEqual([]);
      const ready = await request(t.app.getHttpServer()).get('/ready');
      expect([ready.status, ready.body]).toEqual([200, { status: 'ready' }]);
    });

    it('limiter storage failure: the public read answers a bounded 500, never a decision; it is counted `failed`; it recovers', async () => {
      const c = key('limfail');
      await register(t, c, '1.0.0');
      await publish(t, c, '1.0.0');
      await sql(d.adminUrl, `CREATE OR REPLACE FUNCTION s206_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'limiter refused (test)'; END $$;
                             CREATE TRIGGER s206_refuse BEFORE INSERT OR UPDATE ON kit_rate_limit FOR EACH ROW EXECUTE FUNCTION s206_refuse()`);
      try {
        t.app.get(CompatibilityReporter).snapshot();
        const r = await check(t, c, '1.0.0');
        expect(r.status).toBe(500);
        expect(r.body.update).toBeUndefined();
        expect(r.headers['cache-control']).toBe('no-store');
        expect(JSON.stringify(r.body)).not.toMatch(/limiter|refused|trigger|kit_rate_limit/);
        t.app.get(CompatibilityReporter).snapshot();
        expect(lastLine(t, 'release_compatibility_snapshot')).toMatch(/ failed=1 /);
      } finally {
        await sql(d.adminUrl, 'DROP TRIGGER IF EXISTS s206_refuse ON kit_rate_limit');
      }
      expect((await check(t, c, '1.0.0')).status).toBe(200);
    });
  });

  describe('public compatibility abuse', () => {
    it('oversized or malformed input is bounded: 404 / 400, never 500, never a decision', async () => {
      const c = key('abuse');
      await register(t, c, '1.0.0');
      await publish(t, c, '1.0.0');
      const s = () => request(t.app.getHttpServer());
      expect((await s().get(`/release/products/${'p'.repeat(2000)}/components/${c}/compatibility?version=1.0.0`)).body.code).toBe('unknown_component');
      expect((await s().get(`/release/products/prod/components/${'c'.repeat(2000)}/compatibility?version=1.0.0`)).body.code).toBe('unknown_component');
      expect((await s().get(`/release/products/prod/components/${c}/compatibility?version=${'1'.repeat(4000)}`)).body.code).toBe('invalid_version');
      expect((await s().get(`/release/products/prod/components/${c}/compatibility?version[a]=1.0.0`)).status).toBe(400); // an unknown key: validation_error
      const badPct = await s().get(`/release/products/%E0%A4%A/components/${c}/compatibility?version=1.0.0`);
      expect(badPct.status).toBeLessThan(500);
      expect((await s().get(`/release/products/prod/components/${c}/compatibility?version=1.0.0%00`)).body.code).toBe('invalid_version');
      expect((await s().get(`/release/products/prod/components/..%2F..%2Fadmin/compatibility?version=1.0.0`)).status).toBe(404);
    });

    it('If-None-Match cannot force a false 304: malformed, oversized (even containing the tag) or foreign tags answer 200', async () => {
      const c = key('inm');
      await register(t, c, '1.0.0');
      await publish(t, c, '1.0.0');
      const etag = (await check(t, c, '1.0.0')).headers.etag as string;
      for (const inm of ['"', '""', 'W/', ',,,', `${'"x", '.repeat(1500)}"nope"`, etag.slice(0, -2) + '"', etag.toLowerCase() === etag ? etag.toUpperCase() : etag.toLowerCase(), `${etag.slice(0, -1)}x"`]) {
        expect((await check(t, c, '1.0.0', { 'if-none-match': inm })).status, inm.slice(0, 40)).toBe(200);
      }
      expect((await check(t, c, '1.0.0', { 'if-none-match': etag })).status).toBe(304);
      expect((await check(t, c, '1.0.0', { 'if-none-match': `${'"x", '.repeat(300)}${etag}` })).status).toBe(304); // a long list that DOES contain the tag: a true match
    });

    it('identity, cookie and odd Origin headers never change the representation, and never open CORS', async () => {
      const c = key('cors');
      await register(t, c, '1.0.0');
      await publish(t, c, '1.0.0');
      const plain = await check(t, c, '1.0.0');
      for (const h of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: '*' }, { cookie: 'a=b', authorization: 'Bearer x', 'x-user-id': 'u' }] as Array<Record<string, string>>) {
        const r = await check(t, c, '1.0.0', h);
        expect(r.body).toEqual(plain.body);
        expect(r.headers.etag).toBe(plain.headers.etag);
        expect(r.headers['access-control-allow-origin']).toBeUndefined();
      }
      const pre = await request(t.app.getHttpServer()).options(`/release/products/prod/components/${c}/compatibility`).set({ origin: 'https://evil.example', 'access-control-request-method': 'GET' });
      expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('the rate-limit client address under TRUST_PROXY (Stage 20.6 fix)', () => {
    let proxied: TestApp;
    beforeAll(async () => {
      proxied = await createTestApp({ databaseUrl: d.appUrl, env: { TRUST_PROXY: 'true', RELEASE_COMPATIBILITY_RATE_PER_CLIENT: '3', RELEASE_RATE_LIMIT_KEY: Buffer.alloc(32, 5).toString('base64') } });
    });
    afterAll(async () => {
      await proxied?.app.close();
    });

    it('a client cannot escape its bucket by writing X-Forwarded-For: only the rightmost (proxy-appended) hop counts', async () => {
      await sql(d.adminUrl, `DELETE FROM kit_rate_limit WHERE bucket = 'release_compatibility'`);
      const c = key('proxy');
      await register(t, c, '1.0.0');
      await publish(t, c, '1.0.0');
      const hit = (xff: string) => check(proxied, c, '1.0.0', { 'x-forwarded-for': xff });
      // The same real client (rightmost 203.0.113.50) with a different spoofed prefix each time: ONE bucket.
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await hit(`10.${i}.0.1, 198.51.100.${i}, 203.0.113.50`)).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
      // Another real client is unaffected (no cross-client poisoning).
      expect((await hit('203.0.113.51')).status).toBe(200);
      // IPv6: rotating the host bits of one /64 stays in one bucket.
      const v6 = [];
      for (let i = 1; i <= 4; i++) v6.push((await hit(`2001:db8:5:6::${i}`)).status);
      expect(v6).toEqual([200, 200, 200, 429]);
    });
  });

  describe('shutdown', () => {
    it('closing the application stops every timer and loop, writes the final snapshot and closes promptly', async () => {
      const app = await createTestApp({ databaseUrl: d.appUrl });
      await app.app.listen(0, '127.0.0.1');
      const janitor = app.app.get(CompatibilityLimiterJanitor) as unknown as { loop: { running: boolean } };
      expect(janitor.loop.running).toBe(true);
      const t0 = Date.now();
      await app.app.close();
      expect(Date.now() - t0).toBeLessThan(6_000);
      expect(janitor.loop.running).toBe(false);
      const msgs = app.logs.map((l) => String(l.msg));
      expect(msgs.some((m) => m.startsWith('release_automation_snapshot '))).toBe(true);
      expect(msgs.some((m) => m.startsWith('release_compatibility_snapshot '))).toBe(true);
      expect(msgs.some((m) => m.startsWith('service_shutdown_complete'))).toBe(true);
    });
  });
});
