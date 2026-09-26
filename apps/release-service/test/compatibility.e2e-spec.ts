import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { releaseMigrationsDir } from '../src/app.module.js';
import { ReleaseStore } from '../src/persistence/release-store.js';
import { createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

type Row = Record<string, any>;
type Kind = 'backend' | 'web' | 'desktop' | 'mobile_ios' | 'mobile_android';

/**
 * Stage 20.5 (ADR-0051 decisions 7, 10): the public compatibility decision through the REAL application, as the least-privilege runtime role
 * on real PostgreSQL 16. The state is built by CI (the 20.3 routes) and changed by the 20.4 primitives (withdrawal, append-only policy).
 */
describeWithEnv('release-service public compatibility decision (Stage 20.5) — real PostgreSQL, runtime role', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  let store: ReleaseStore;
  const ci = generateServiceToken();
  let n = 0;
  const key = (p = 'app') => `${p}-${n++}`;
  const server = () => t.app.getHttpServer();
  const path = (component: string, product = 'prod') => `/release/products/${product}/components/${component}/compatibility`;
  const check = (component: string, version: string, headers: Record<string, string> = {}, product = 'prod') =>
    request(server()).get(path(component, product)).query({ version }).set(headers);
  const register = (component: string, version: string, kind: Kind = 'web') =>
    request(server()).post(`/release/products/prod/components/${component}/releases`).set('authorization', `Bearer ${ci.token}`).send({ kind, version });
  const publish = (component: string, version: string) =>
    request(server()).post(`/release/products/prod/components/${component}/releases/${version}/publish`).set('authorization', `Bearer ${ci.token}`);
  const published = async (component: string, versions: string[], kind: Kind = 'web') => {
    for (const v of versions) {
      expect((await register(component, v, kind)).status).toBe(201);
      expect((await publish(component, v)).status).toBe(200);
    }
  };
  const componentId = async (component: string) => (await sql<Row>(d.adminUrl, `SELECT id FROM component WHERE key = $1`, [component]))[0]!.id as string;
  const releaseId = async (component: string, v: string) => (await store.findRelease(await componentId(component), v))!.id;
  const setMinimum = async (component: string, minimum: string) => {
    const cid = await componentId(component);
    await store.appendPolicy(cid, (await store.currentPolicy(cid))?.policyVersion ?? 0, minimum);
  };
  const withdraw = async (component: string, v: string) => store.withdrawRelease(await releaseId(component, v));

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'relcompat');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, releaseMigrationsDir]);
    t = await createTestApp({
      databaseUrl: d.appUrl,
      env: {
        SERVICE_TOKENS: `prod-ci:${ci.digest}`,
        RELEASE_SERVICE_POLICY: JSON.stringify({ callers: { 'prod-ci': { products: { prod: ['release.register', 'release.publish'] } } } }),
        RELEASE_COMPATIBILITY_RATE_PER_CLIENT: '100000', // the rate-limit suite below uses its own application
      },
    });
    store = t.app.get(ReleaseStore);
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
  });

  describe('the decision matrix (ADR-0051 decision 7)', () => {
    it.each([
      // client, minimum, published (latest = highest stable), client withdrawn?, expected
      ['3.0.0', '2.0.0', ['2.0.0', '2.5.0', '3.0.0'], false, { update: 'none' }],
      ['2.5.0', '2.0.0', ['2.0.0', '2.5.0', '3.0.0'], false, { update: 'available' }],
      ['1.5.0', '2.0.0', ['1.5.0', '2.0.0', '3.0.0'], false, { update: 'required', reason: 'below_minimum' }],
      ['2.5.0', '2.0.0', ['2.0.0', '2.5.0', '3.0.0'], true, { update: 'required', reason: 'withdrawn' }],
      ['3.0.0', null, ['2.0.0', '3.0.0'], false, { update: 'none' }],
      ['2.0.0', null, ['2.0.0', '3.0.0'], false, { update: 'available' }],
    ] as const)('client %s, minimum %s, published %j, withdrawn %s → %o', async (client, minimum, versions, withdrawn, expected) => {
      const c = key();
      await published(c, [...versions]);
      if (minimum) await setMinimum(c, minimum);
      if (withdrawn) await withdraw(c, client);
      const r = await check(c, client);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ...expected, latestVersion: '3.0.0', minimumVersion: minimum });
      expect(Object.keys(r.body)).not.toContain('supported'); // derived by the client: never a second, contradictable field
    });

    it('works identically for every client kind (web first-class; desktop technology-neutral; iOS and Android distinct)', async () => {
      for (const kind of ['web', 'desktop', 'mobile_ios', 'mobile_android'] as const) {
        const c = key(kind.replace('_', '-'));
        await published(c, ['1.0.0', '2.0.0'], kind);
        expect((await check(c, '1.0.0')).body).toEqual({ update: 'available', latestVersion: '2.0.0', minimumVersion: null });
      }
    });

    it('a newer release alone never requires an update; withdrawal and the minimum do (withdrawn wins)', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0', '3.0.0', '4.0.0']);
      expect((await check(c, '1.0.0')).body.update).toBe('available');
      await setMinimum(c, '2.0.0');
      expect((await check(c, '1.0.0')).body).toMatchObject({ update: 'required', reason: 'below_minimum' });
      await withdraw(c, '1.0.0');
      expect((await check(c, '1.0.0')).body).toMatchObject({ update: 'required', reason: 'withdrawn' });
    });

    it('a withdrawn release ABOVE the latest stays required / withdrawn; latestVersion is lower (a fact, never a downgrade target)', async () => {
      const c = key();
      await published(c, ['2.0.0', '3.0.0', '4.0.0']);
      await withdraw(c, '4.0.0');
      expect((await check(c, '4.0.0')).body).toEqual({ update: 'required', reason: 'withdrawn', latestVersion: '3.0.0', minimumVersion: null });
      expect((await check(c, '3.0.0')).body).toEqual({ update: 'none', latestVersion: '3.0.0', minimumVersion: null }); // latest excludes withdrawn
    });

    it('latest excludes pre-releases and registered-only releases; a registered (unpublished) or pre-release client gets its own decision', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0-rc.1']);
      await register(c, '3.0.0'); // registered, never published
      expect((await check(c, '1.0.0')).body).toEqual({ update: 'none', latestVersion: '1.0.0', minimumVersion: null });
      expect((await check(c, '2.0.0-rc.1')).body).toEqual({ update: 'none', latestVersion: '1.0.0', minimumVersion: null });
      expect((await check(c, '3.0.0')).body).toEqual({ update: 'none', latestVersion: '1.0.0', minimumVersion: null });
      await published(c, ['2.0.0']);
      expect((await check(c, '2.0.0-rc.1')).body.update).toBe('available'); // 2.0.0 > 2.0.0-rc.1
    });

    it('no policy and nothing published: none, with null facts', async () => {
      const c = key();
      await register(c, '0.1.0');
      expect((await check(c, '0.1.0')).body).toEqual({ update: 'none', latestVersion: null, minimumVersion: null });
    });

    it('SemVer precedence, never string order (1.10.0 > 1.9.0)', async () => {
      const c = key();
      await published(c, ['1.9.0', '1.10.0']);
      expect((await check(c, '1.9.0')).body).toMatchObject({ update: 'available', latestVersion: '1.10.0' });
    });

    it('the CURRENT policy is the highest version, never an older one', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0', '3.0.0']);
      await setMinimum(c, '3.0.0');
      await setMinimum(c, '1.0.0'); // lowered again: v2
      expect((await check(c, '2.0.0')).body).toEqual({ update: 'available', latestVersion: '3.0.0', minimumVersion: '1.0.0' });
    });
  });

  describe('input errors are never decisions', () => {
    it.each([
      ['v1.0.0'], ['1.0'], ['1.0.0+7'], ['01.0.0'], ['1.0.0-01'], [' 1.0.0'], [`1.0.0-${'a'.repeat(130)}`], [''],
    ])('invalid_version for %j (400, no-store, no decision fields)', async (version) => {
      const c = key();
      await published(c, ['1.0.0']);
      const r = await check(c, version);
      expect([r.status, r.body.code]).toEqual([400, 'invalid_version']);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers.etag).toBeUndefined();
      expect(r.body.update).toBeUndefined();
    });

    it('a missing or repeated version is invalid_version; any other query parameter is 400 validation_error', async () => {
      const c = key();
      await published(c, ['1.0.0']);
      expect((await request(server()).get(path(c))).body.code).toBe('invalid_version');
      expect((await request(server()).get(`${path(c)}?version=1.0.0&version=1.0.0`)).body.code).toBe('invalid_version');
      const extra = await request(server()).get(path(c)).query({ version: '1.0.0', userId: 'u-1', deviceId: 'd' });
      expect([extra.status, extra.body.code]).toEqual([400, 'validation_error']);
    });

    it('unknown_component (404): an unknown product, component or malformed key, and a BACKEND (traceability only)', async () => {
      const b = key('api');
      await published(b, ['1.0.0'], 'backend');
      for (const [component, product] of [['nope', 'prod'], [b, 'other'], ['Bad_Key', 'prod'], [b, 'prod']]) {
        const r = await check(component!, '1.0.0', {}, product);
        expect([r.status, r.body.code], `${product}/${component}`).toEqual([404, 'unknown_component']);
        expect(r.body.update).toBeUndefined();
      }
    });

    it('unknown_release (404) for a well-formed version that is not registered: never guessed as required, available or none', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      await setMinimum(c, '2.0.0');
      for (const v of ['1.5.0', '9.0.0', '2.0.0-rc.1']) {
        const r = await check(c, v);
        expect([r.status, r.body.code]).toEqual([404, 'unknown_release']);
        expect(r.headers['cache-control']).toBe('no-store');
      }
    });

    it('error bodies are bounded: no ids, SQL, stack, policy history, owner or configuration', async () => {
      const r = await check('nope', '1.0.0');
      expect(Object.keys(r.body).sort()).toEqual(['code', 'error', 'message', 'requestId', 'statusCode']);
      expect(JSON.stringify({ ...r.body, requestId: undefined })).not.toMatch(/select|release_|stack|policy|owner|company|[0-9a-f]{8}-[0-9a-f]{4}-/i);
    });
  });

  describe('public, read-only, no identity', () => {
    it('needs no credential; a bearer, a user or an organization header changes nothing; nothing but the limiter counter is written; no audit', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      const tables = async () => (await sql<Row>(d.adminUrl, `SELECT (SELECT count(*)::int FROM product) p, (SELECT count(*)::int FROM component) c, (SELECT count(*)::int FROM release) r,
        (SELECT count(*)::int FROM compatibility_policy) cp, (SELECT count(*)::int FROM outbox) o, (SELECT max(r."publishedAt") FROM release r) pub`))[0];
      const before = await tables();
      const plain = await check(c, '1.0.0');
      const decorated = await check(c, '1.0.0', { authorization: 'Bearer anything', 'x-user-id': 'u', 'x-organization-id': 'o', cookie: 'sid=1' });
      expect(decorated.body).toEqual(plain.body);
      expect(decorated.headers.etag).toBe(plain.headers.etag);
      expect(await tables()).toEqual(before);
      expect(plain.headers['set-cookie']).toBeUndefined();
      expect(plain.headers['access-control-allow-origin']).toBeUndefined(); // CORS stays the deployment's exact-origin choice (CORS_ORIGINS)
      expect(plain.headers['x-content-type-options']).toBe('nosniff');
      expect(plain.headers['content-type']).toMatch(/^application\/json/);
    });

    it('the limiter stores only a keyed digest of the client address (no address, no version, no path)', async () => {
      const rows = await sql<Row>(d.adminUrl, `SELECT bucket, key FROM kit_rate_limit WHERE bucket = 'release_compatibility'`);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.key).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows)).not.toMatch(/127\.0\.0\.1|::1|ffff/);
    });

    it('logs carry no product, component, version or address; the snapshot line has closed labels only', async () => {
      const c = key('logcheck');
      await published(c, ['7.7.7']);
      await check(c, '7.7.7');
      const reporter = t.app.get((await import('../src/compatibility/compatibility-ops.js')).CompatibilityReporter);
      reporter.snapshot();
      const lines = t.logs.map((l) => String(l.msg)).filter((m) => m.startsWith('release_compatibility_snapshot'));
      expect(lines.at(-1)).toMatch(/^release_compatibility_snapshot required_withdrawn=\d+ required_below_minimum=\d+ available=\d+ none=\d+ not_modified=\d+ invalid_version=\d+ invalid_request=\d+ unknown_component=\d+ unknown_release=\d+ rate_limited=\d+ failed=\d+ latency_count=\d+ latency_avg_ms=\d+ latency_max_ms=\d+$/);
      const compat = JSON.stringify(t.logs.filter((l) => /compatibility/i.test(String(l.msg)) || /compatibility/.test(String(l.context))));
      expect(compat).not.toMatch(/7\.7\.7|logcheck|127\.0\.0\.1/);
    });
  });

  describe('cache and ETag', () => {
    it('a decision is public for a short bounded time with a strong ETag; If-None-Match → 304 (no body) while the state holds', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      const a = await check(c, '1.0.0');
      expect(a.headers['cache-control']).toBe('public, max-age=60');
      expect(a.headers.etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
      expect((await check(c, '1.0.0')).headers.etag).toBe(a.headers.etag); // same state, same tag
      for (const inm of [a.headers.etag, `W/${a.headers.etag}`, `"other", ${a.headers.etag}`, '*']) {
        const r = await check(c, '1.0.0', { 'if-none-match': inm });
        expect(r.status, inm).toBe(304);
        expect(r.text).toBeFalsy();
        expect(r.headers.etag).toBe(a.headers.etag);
        expect(r.headers['cache-control']).toBe('public, max-age=60');
      }
      expect((await check(c, '1.0.0', { 'if-none-match': '"stale"' })).status).toBe(200);
      expect((await check(c, '2.0.0')).headers.etag).not.toBe(a.headers.etag); // another release, another representation
    });

    it('every compatibility-relevant change changes the ETag (no stale 304); an irrelevant one does not', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      await register(c, '9.0.0'); // registered only: never latest
      const tag = async () => (await check(c, '2.0.0')).headers.etag as string;
      const conditional = async (etag: string) => (await check(c, '2.0.0', { 'if-none-match': etag })).status;
      let prev = await tag();

      await register(c, '8.0.0'); // irrelevant: a registration changes nothing about 2.0.0's answer
      expect(await tag()).toBe(prev);
      await withdraw(c, '1.0.0'); // irrelevant to 2.0.0: not the latest, not the client
      expect(await tag()).toBe(prev);

      await published(c, ['3.0.0']); // a newer stable release: none → available
      expect(await conditional(prev)).toBe(200);
      expect((await check(c, '2.0.0')).body.update).toBe('available');
      prev = await tag();

      await setMinimum(c, '2.0.0'); // the minimum changes (even without changing the verdict): the tag changes
      expect(await conditional(prev)).toBe(200);
      prev = await tag();
      await setMinimum(c, '3.0.0'); // → required / below_minimum
      expect(await conditional(prev)).toBe(200);
      expect((await check(c, '2.0.0')).body).toMatchObject({ update: 'required', reason: 'below_minimum' });
      prev = await tag();

      await setMinimum(c, '2.0.0');
      await withdraw(c, '2.0.0'); // the client's own release withdrawn
      expect(await conditional(prev)).toBe(200);
      expect((await check(c, '2.0.0')).body).toMatchObject({ update: 'required', reason: 'withdrawn' });
    });

    it('withdrawing ONLY the client\'s own release (policy and latest unchanged) changes its ETag: no stale 304 for a withdrawn build', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0', '3.0.0']);
      const before = (await check(c, '2.0.0')).headers.etag as string;
      const other = (await check(c, '1.0.0')).headers.etag as string;
      await withdraw(c, '2.0.0'); // not the latest; no policy
      const r = await check(c, '2.0.0', { 'if-none-match': before });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ update: 'required', reason: 'withdrawn' });
      expect(r.headers.etag).not.toBe(before);
      expect((await check(c, '1.0.0', { 'if-none-match': other })).status).toBe(304); // another client's answer did not change
    });
  });

  describe('rate limit (kit limiter, per keyed client address)', () => {
    let limited: TestApp;
    beforeAll(async () => {
      limited = await createTestApp({ databaseUrl: d.appUrl, env: { RELEASE_COMPATIBILITY_RATE_PER_CLIENT: '5', RELEASE_RATE_LIMIT_KEY: Buffer.alloc(32, 9).toString('base64') } });
      await sql(d.adminUrl, `DELETE FROM kit_rate_limit WHERE bucket = 'release_compatibility'`);
    });
    afterAll(async () => {
      await limited?.app.close();
    });
    const hit = (q: string, headers: Record<string, string> = {}) => request(limited.app.getHttpServer()).get(`${path('prod-rl')}${q}`).set(headers);

    it('every request counts (malformed ones too, before validation); over the limit → 429 rate_limited, never a decision; the window then recovers', async () => {
      await published('prod-rl', ['1.0.0']);
      await sql(d.adminUrl, `DELETE FROM kit_rate_limit WHERE bucket = 'release_compatibility'`);
      expect((await hit('?version=1.0.0')).status).toBe(200);
      expect((await hit('?version=bogus')).status).toBe(400);
      expect((await hit('')).status).toBe(400);
      expect((await hit('?version=1.0.0&x=1')).status).toBe(400);
      expect((await hit('?version=9.9.9')).status).toBe(404);
      const r = await hit('?version=1.0.0');
      expect([r.status, r.body.code]).toEqual([429, 'rate_limited']);
      expect(r.body.update).toBeUndefined();
      expect(r.headers['cache-control']).toBe('no-store');
      expect((await hit('?version=1.0.0', { 'if-none-match': '*' })).status).toBe(429); // a conditional request is counted too
      // A caller-chosen header does not pick another bucket (TRUST_PROXY is off): X-Forwarded-For changes nothing.
      expect((await hit('?version=1.0.0', { 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.1' })).status).toBe(429);
      // The window ends (simulated by ageing it): the client is served again. Nobody is blocked for good.
      await sql(d.adminUrl, `UPDATE kit_rate_limit SET "windowStart" = now() - interval '61 seconds' WHERE bucket = 'release_compatibility'`);
      expect((await hit('?version=1.0.0')).status).toBe(200);
    });

    it('the janitor purges ended windows only (no address history accumulates)', async () => {
      const { CompatibilityLimiterJanitor } = await import('../src/compatibility/compatibility-ops.js');
      await sql(d.adminUrl, `INSERT INTO kit_rate_limit (bucket, key, "windowStart", count) VALUES ('release_compatibility', repeat('a', 64), now() - interval '2 minutes', 3), ('release_compatibility', repeat('b', 64), now(), 1), ('other_bucket', repeat('c', 64), now() - interval '2 hours', 1)`);
      const removed = await limited.app.get(CompatibilityLimiterJanitor).pass();
      expect(removed).toBeGreaterThanOrEqual(1);
      const keys = (await sql<Row>(d.adminUrl, `SELECT bucket, left(key, 1) k FROM kit_rate_limit WHERE key IN (repeat('a', 64), repeat('b', 64), repeat('c', 64)) ORDER BY 1, 2`)).map((x) => `${x.bucket}:${x.k}`);
      expect(keys).toEqual(['other_bucket:c', 'release_compatibility:b']);
    });
  });

  describe('consistency under concurrent administration (real, separate sessions)', () => {
    it('reads racing withdrawals and minimum changes only ever return a decision of some committed state', async () => {
      const c = key('race');
      await published(c, ['1.0.0', '2.0.0', '3.0.0', '4.0.0']);
      const cid = await componentId(c);
      const admin = (async () => {
        for (let i = 0; i < 15; i++) {
          const minimum = ['1.0.0', '2.0.0', '3.0.0'][i % 3]!;
          await store.tx(async (q) => {
            await store.lockComponent(cid, q);
            const now = await store.currentPolicy(cid, q);
            if (now?.minimumVersion !== minimum) await store.appendPolicy(cid, now?.policyVersion ?? 0, minimum, q);
          });
        }
        await store.appendPolicy(cid, (await store.currentPolicy(cid))!.policyVersion, '1.0.0');
        await withdraw(c, '4.0.0'); // latest 4.0.0 → 3.0.0
        await withdraw(c, '2.0.0');
      })();
      const reads: Array<{ client: string; body: Row; status: number }> = [];
      const reader = (async () => {
        for (let i = 0; i < 60; i++) {
          const client = ['1.0.0', '2.0.0', '3.0.0', '4.0.0'][i % 4]!;
          const r = await check(c, client);
          reads.push({ client, body: r.body, status: r.status });
        }
      })();
      await Promise.all([admin, reader]);
      const cmp = (a: string, b: string) => { const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)]; for (let k = 0; k < 3; k++) if (x[k] !== y[k]) return x[k]! - y[k]!; return 0; };
      for (const { client, body, status } of reads) {
        expect(status).toBe(200);
        const { update, reason, latestVersion, minimumVersion } = body;
        expect(['3.0.0', '4.0.0']).toContain(latestVersion);
        if (minimumVersion) expect(cmp(minimumVersion, latestVersion)).toBeLessThanOrEqual(0); // minimum ≤ latest in every answer
        if (update === 'required') {
          if (reason === 'below_minimum') expect(cmp(client, minimumVersion)).toBeLessThan(0);
          else expect(['2.0.0', '4.0.0']).toContain(client); // only these were ever withdrawn
        } else {
          expect(reason).toBeUndefined();
          if (minimumVersion) expect(cmp(client, minimumVersion)).toBeGreaterThanOrEqual(0);
          expect(update).toBe(cmp(latestVersion, client) > 0 ? 'available' : 'none');
        }
      }
      expect(reads.length).toBe(60);
    });
  });
});
