import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { releaseMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { FakeAuth } from './support/fake-auth.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

type Row = Record<string, any>;
const OPERATING = randomUUID();
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Core V2 S2-Release.1 (register REL-01, REL-02, REL-03; ADR-0050 decision 1): the owner's reads of the release registry, through the REAL
 * application as the runtime role on real PostgreSQL 16, behind the same live owner verification as the Stage 20.4 writes.
 */
describeWithEnv('release-service owner reads (S2-Release.1) — real PostgreSQL, runtime role', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  const auth = new FakeAuth();
  const ci = generateServiceToken();
  const server = () => t.app.getHttpServer();
  const B = { owner: 'owner-1', otherOwner: 'other-owner', operator: 'operator-1', member: 'member-1', revoked: 'owner-revoked' };
  const get = (path: string, bearer: string | null = B.owner, query: Record<string, string> = {}) => {
    const r = request(server()).get(path).query(query);
    return bearer ? r.set('authorization', `Bearer ${bearer}`) : r;
  };
  const PRODUCTS = '/release/admin/products';
  const releases = (component: string, product = 'prod') => `/release/admin/products/${product}/components/${component}/releases`;
  const history = (component: string, product = 'prod') => `/release/admin/products/${product}/components/${component}/compatibility-policy/history`;
  const register = (component: string, version: string, kind = 'web') =>
    request(server()).post(`/release/products/prod/components/${component}/releases`).set('authorization', `Bearer ${ci.token}`).send({ kind, version });
  const publish = (component: string, version: string) =>
    request(server()).post(`/release/products/prod/components/${component}/releases/${version}/publish`).set('authorization', `Bearer ${ci.token}`);
  const setMinimum = (component: string, minimumVersion: string, expectedPolicyVersion: number) =>
    request(server()).post(`/release/admin/products/prod/components/${component}/compatibility-policy`)
      .set('authorization', `Bearer ${B.owner}`).set('x-step-up-token', auth.issue(B.owner, 'compatibility_policy.change'))
      .send({ minimumVersion, expectedPolicyVersion });

  beforeAll(async () => {
    await auth.start();
    auth.identities.set(B.owner, { userId: randomUUID(), kind: 'owner', companyId: OPERATING });
    auth.identities.set(B.revoked, { userId: randomUUID(), kind: 'owner', companyId: OPERATING });
    auth.identities.set(B.otherOwner, { userId: randomUUID(), kind: 'owner', companyId: randomUUID() });
    auth.identities.set(B.operator, { userId: randomUUID(), kind: 'operator', companyId: null });
    auth.identities.set(B.member, { userId: randomUUID(), kind: 'member', companyId: null });
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'relreads');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, releaseMigrationsDir]);
    t = await createTestApp({
      databaseUrl: d.appUrl,
      env: {
        SERVICE_TOKENS: `prod-ci:${ci.digest}`,
        RELEASE_SERVICE_POLICY: JSON.stringify({ callers: { 'prod-ci': { products: { prod: ['release.register', 'release.publish'] } } } }),
        AUTH_SERVICE_URL: auth.url, RELEASE_OPERATING_COMPANY_ID: OPERATING, AUTH_TIMEOUT_MS: '800',
      },
    });
    // fixtures through the real routes: a web client with five releases and three policy versions; a backend; an android client
    for (const v of ['1.0.0', '1.1.0', '2.0.0', '2.1.0-beta.1', '3.0.0']) expect((await register('web-app', v)).status).toBe(201);
    for (const v of ['1.0.0', '2.0.0', '3.0.0']) expect((await publish('web-app', v)).status).toBe(200);
    expect((await setMinimum('web-app', '1.0.0', 0)).status).toBe(200);
    expect((await setMinimum('web-app', '2.0.0', 1)).status).toBe(200);
    expect((await setMinimum('web-app', '3.0.0', 2)).status).toBe(200);
    expect((await register('api', '1.0.0', 'backend')).status).toBe(201);
    expect((await register('android', '0.9.0', 'mobile_android')).status).toBe(201);
    // a second product, created by its own CI in production; inserted directly here (no CI policy for it in this app)
    await sql(d.migratorUrl, `WITH p AS (INSERT INTO product (key) VALUES ('other-product') RETURNING id) INSERT INTO component ("productId", key, kind) SELECT id, 'desk', 'desktop' FROM p`);
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
    await auth.stop();
  });
  afterEach(() => {
    auth.mode = 'ok';
  });

  describe('REL-01 products', () => {
    it('lists every product with its components (keys and kinds), ordered by key; no internal id', async () => {
      const r = await get(PRODUCTS);
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body).toEqual({
        products: [
          { product: 'other-product', components: [{ component: 'desk', kind: 'desktop' }] },
          { product: 'prod', components: [{ component: 'android', kind: 'mobile_android' }, { component: 'api', kind: 'backend' }, { component: 'web-app', kind: 'web' }] },
        ],
      });
      expect(JSON.stringify(r.body)).not.toMatch(UUID_ANYWHERE);
    });

    it('accepts no query parameter', async () => {
      expect((await get(PRODUCTS, B.owner, { companyId: OPERATING })).status).toBe(400);
      expect((await get(PRODUCTS, B.owner, { limit: '10' })).body.code).toBe('validation_error');
    });
  });

  describe('REL-02 releases', () => {
    it('returns the component\'s releases with state and timestamps, newest registration first; no internal id', async () => {
      const r = await get(releases('web-app'));
      expect(r.status).toBe(200);
      expect([r.body.product, r.body.component, r.body.kind, r.body.nextCursor]).toEqual(['prod', 'web-app', 'web', null]);
      expect(r.body.releases.map((x: Row) => x.version)).toEqual(['3.0.0', '2.1.0-beta.1', '2.0.0', '1.1.0', '1.0.0']);
      const byVersion = Object.fromEntries(r.body.releases.map((x: Row) => [x.version, x]));
      expect(byVersion['3.0.0']).toMatchObject({ status: 'published', publishedAt: expect.any(String), withdrawnAt: null });
      expect(byVersion['1.1.0']).toMatchObject({ status: 'registered', publishedAt: null });
      expect(Object.keys(byVersion['1.0.0']).sort()).toEqual(['buildId', 'notesRef', 'publishedAt', 'registeredAt', 'sourceRevision', 'status', 'version', 'withdrawnAt']);
      expect(JSON.stringify(r.body)).not.toMatch(UUID_ANYWHERE);
    });

    it('filters by status; an unknown status, parameter or bad limit is 400', async () => {
      expect((await get(releases('web-app'), B.owner, { status: 'registered' })).body.releases.map((x: Row) => x.version)).toEqual(['2.1.0-beta.1', '1.1.0']);
      const bad: Array<Record<string, string>> = [{ status: 'live' }, { limit: '0' }, { limit: '101' }, { limit: 'ten' }, { sort: 'asc' }, { companyId: OPERATING }];
      for (const q of bad) {
        const r = await get(releases('web-app'), B.owner, q);
        expect([r.status, r.body.code], JSON.stringify(q)).toEqual([400, 'validation_error']);
      }
    });

    it('paginates without duplicates or gaps, including releases registered at the SAME instant (the id breaks the tie)', async () => {
      const [c] = await sql<Row>(d.adminUrl, `SELECT c.id FROM component c JOIN product p ON p.id = c."productId" WHERE p.key = 'prod' AND c.key = 'android'`);
      await sql(d.adminUrl, `INSERT INTO release ("componentId", version, "registeredAt") SELECT $1, v, '2026-01-01T00:00:00Z' FROM unnest(ARRAY['1.0.0','1.0.1','1.0.2','1.0.3']) v`, [c!.id]);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const r = await get(releases('android'), B.owner, { limit: '2', ...(cursor ? { cursor } : {}) });
        expect(r.status).toBe(200);
        seen.push(...r.body.releases.map((x: Row) => x.version));
        cursor = r.body.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen)).toEqual(new Set(['0.9.0', '1.0.0', '1.0.1', '1.0.2', '1.0.3']));
    });

    it('a cursor is bound to its query: another component, status or route, or a tampered one, is 400 invalid_cursor', async () => {
      const first = await get(releases('web-app'), B.owner, { limit: '1' });
      const c = first.body.nextCursor as string;
      const tampered = Buffer.from(JSON.stringify({ v: 1, p: '1:00000000-0000-4000-8000-000000000000', q: 'x'.repeat(24) })).toString('base64url');
      for (const [path, q] of [[releases('android'), { cursor: c }], [releases('web-app'), { cursor: c, status: 'published' }], [history('web-app'), { cursor: c }],
        [releases('web-app'), { cursor: tampered }], [releases('web-app'), { cursor: '!!!' }]] as const) {
        const r = await get(path, B.owner, q);
        expect([r.status, r.body.code], `${path} ${JSON.stringify(q)}`).toEqual([400, 'invalid_cursor']);
      }
    });

    it('an unknown component is 404; a malformed key is 400', async () => {
      expect([(await get(releases('nope'))).status, (await get(releases('nope'))).body.code]).toEqual([404, 'component_not_found']);
      expect((await get(releases('web-app', 'nope'))).status).toBe(404);
      expect((await get(releases('Web_App'))).status).toBe(400);
    });
  });

  describe('REL-03 compatibility-policy history', () => {
    it('returns the append-only history, newest version first, and pages through it', async () => {
      const r = await get(history('web-app'));
      expect(r.status).toBe(200);
      expect(r.body.entries.map((e: Row) => [e.policyVersion, e.minimumVersion])).toEqual([[3, '3.0.0'], [2, '2.0.0'], [1, '1.0.0']]);
      expect(Object.keys(r.body.entries[0]).sort()).toEqual(['createdAt', 'minimumVersion', 'policyVersion']);
      const versions: number[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const p = await get(history('web-app'), B.owner, { limit: '1', ...(cursor ? { cursor } : {}) });
        versions.push(...p.body.entries.map((e: Row) => e.policyVersion));
        cursor = p.body.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(versions).toEqual([3, 2, 1]);
    });

    it('a component with no policy has an empty history; a backend has none at all (409)', async () => {
      expect((await get(history('android'))).body).toMatchObject({ entries: [], nextCursor: null });
      expect([(await get(history('api'))).status, (await get(history('api'))).body.code]).toEqual([409, 'policy_not_applicable']);
    });
  });

  describe('authority (ADR-0050 decision 1): only the live owner of the operating Company', () => {
    const paths = [PRODUCTS, releases('web-app'), history('web-app')];

    it('no bearer, an unknown or revoked bearer: 401 on every read', async () => {
      for (const p of paths) {
        expect((await get(p, null)).status, p).toBe(401);
        expect((await get(p, 'unknown-session')).status, p).toBe(401);
      }
      const ok = await get(PRODUCTS, B.revoked);
      expect(ok.status).toBe(200);
      auth.identities.delete(B.revoked); // revoked / blocked: Auth now refuses the bearer
      for (const p of paths) expect((await get(p, B.revoked)).status, p).toBe(401);
    });

    it('another Company\'s owner, an operator and a member: one 403 on every read', async () => {
      for (const p of paths) for (const who of [B.otherOwner, B.operator, B.member]) {
        const r = await get(p, who);
        expect([r.status, r.body.code], `${p} ${who}`).toEqual([403, 'operation_not_allowed']);
        expect(r.body.products ?? r.body.releases ?? r.body.entries).toBeUndefined();
      }
    });

    it('a CI service token is never a human: 401, never forwarded to Auth', async () => {
      const sent = auth.received.length;
      for (const p of paths) expect((await get(p, ci.token)).status, p).toBe(401);
      expect(auth.received.length).toBe(sent);
    });

    it('Auth unavailable or slow: 503, nothing returned', async () => {
      for (const mode of ['down', 'hang'] as const) {
        auth.mode = mode;
        for (const p of paths) {
          const r = await get(p);
          expect(r.status, `${mode} ${p}`).toBe(503);
          expect(r.body.products ?? r.body.releases ?? r.body.entries).toBeUndefined();
        }
      }
    });

    it('reads change nothing and spend no step-up', async () => {
      const before = await sql<Row>(d.adminUrl, `SELECT (SELECT count(*)::int FROM release) r, (SELECT count(*)::int FROM compatibility_policy) p, (SELECT count(*)::int FROM outbox) o`);
      for (const p of paths) await get(p);
      expect(await sql<Row>(d.adminUrl, `SELECT (SELECT count(*)::int FROM release) r, (SELECT count(*)::int FROM compatibility_policy) p, (SELECT count(*)::int FROM outbox) o`)).toEqual(before);
      expect(auth.received.filter((x) => x.path === '/auth/step-up/verify').length).toBe(3); // only the three policy changes of the fixtures
    });
  });
});
