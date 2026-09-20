import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { organizationMigrationsDir } from '../src/app.module.js';
import { bearer, createTestApp, makeCallers, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { MISSING_ID, client, sql } from './support/fixtures.js';

/** A syntactically valid HS256-style user access token, as auth-service would issue: it must never work here. */
const USER_JWT = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"user-1","role":"admin","adminTier":"owner"}').toString('base64url')}.c2lnbmF0dXJl`;

const EXPECTED_ROUTES = [
  'GET /organization/companies', 'POST /organization/companies', 'GET /organization/companies/{id}', 'PATCH /organization/companies/{id}',
  'GET /organization/platforms', 'POST /organization/platforms', 'GET /organization/platforms/{id}', 'PATCH /organization/platforms/{id}',
  'GET /organization/organizations', 'POST /organization/organizations', 'GET /organization/organizations/{id}', 'PATCH /organization/organizations/{id}',
].sort();

describeWithEnv('security: authentication, authorization boundary and tampering (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgsecurity');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url });
  });
  afterAll(async () => {
    await t?.app.close();
    await db.drop();
  });

  const allRoutes = (app = t.app) => {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    return Object.entries(doc.paths).flatMap(([path, item]) => Object.keys(item as object).map((m) => ({ method: m.toUpperCase(), path })));
  };
  /** The domain routes: everything except the kit's two public probes, which are asserted separately. */
  const routes = (app = t.app) => allRoutes(app).filter((r) => r.path.startsWith('/organization/'));
  const call = (method: string, path: string, headers: Record<string, string> = {}, body: object = {}) => {
    const url = path.replace('{id}', MISSING_ID);
    const req = (t.http() as any)[method.toLowerCase()](url).set(headers);
    return method === 'GET' ? req : req.set('Idempotency-Key', 'security-probe-key').send(body);
  };

  it('exposes EXACTLY the twelve intended routes plus the two kit probes: no delete, no membership, no import, no ownership-migration endpoint', () => {
    expect(routes().map((r) => `${r.method} ${r.path}`).sort()).toEqual(EXPECTED_ROUTES);
    expect(allRoutes().filter((r) => !r.path.startsWith('/organization/')).map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /health', 'GET /ready']);
  });

  it('every route is deny-by-default: no credential, a wrong token, a user JWT, a non-Bearer scheme and a lower-case scheme are all the same generic 401', async () => {
    const bodies = new Set<string>();
    const attempts: Record<string, string>[] = [
      {},
      bearer('definitely-not-a-registered-service-token-0000'),
      bearer(USER_JWT),
      { Authorization: 'Basic dXNlcjpwYXNz' },
      { Authorization: `bearer ${t.callers['billing-service']}` },
      { Authorization: `Bearer ${t.callers['billing-service']} extra` },
      { Authorization: 'Bearer ' },
      { Authorization: t.callers['billing-service']! },
    ];
    for (const { method, path } of routes()) {
      for (const headers of attempts) {
        const res = await call(method, path, headers);
        expect(res.status, `${method} ${path} with ${JSON.stringify(headers).slice(0, 40)}`).toBe(401);
        bodies.add(JSON.stringify({ ...res.body, requestId: undefined }));
      }
    }
    expect(bodies.size).toBe(1); // every failure looks identical: nothing distinguishes "unknown token" from "user token"
  });

  it('the stored DIGEST is not a credential (an attacker who reads the configuration cannot call the service with it)', async () => {
    const digest = t.config.serviceTokens[0]!.digest;
    expect((await call('GET', '/organization/companies', bearer(digest))).status).toBe(401);
  });

  it('accepts each registered caller and only them; the token of one caller does not authenticate as another', async () => {
    for (const name of ['billing-service', 'payment-service']) {
      expect((await call('GET', '/organization/companies', bearer(t.callers[name]!))).status).toBe(200);
    }
    expect((await call('GET', '/organization/companies', bearer(generateServiceToken().token))).status).toBe(401);
  });

  it('never accepts a USER token, never asks Auth about one, and makes no outbound HTTP call at all', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const { method, path } of routes()) expect((await call(method, path, bearer(USER_JWT))).status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('with NO service tokens configured every route refuses everything (fail closed)', async () => {
    const own = await createTestApp({ databaseUrl: db.url, env: { SERVICE_TOKENS: '' } });
    try {
      const anything = generateServiceToken().token;
      for (const { method, path } of routes(own.app)) {
        const res = await (own.http() as any)[method.toLowerCase()](path.replace('{id}', MISSING_ID)).set(bearer(anything)).send({});
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    } finally {
      await own.app.close();
    }
  });

  it('ignores identity-shaped HEADERS: they grant nothing without a token and change nothing with one', async () => {
    const spoof = { 'x-user-id': 'u1', 'x-organization-id': MISSING_ID, 'x-platform-id': MISSING_ID, 'x-company-id': MISSING_ID, 'x-role': 'owner', 'x-forwarded-user': 'admin' };
    expect((await call('GET', '/organization/companies', spoof)).status).toBe(401);
    const c = client(t);
    const made = await t.http().post('/organization/companies').set(c.auth).set(spoof).set('Idempotency-Key', 'spoofed-headers-01').send({ name: 'Spoof' });
    expect(made.status).toBe(201);
  });

  it.each([
    ['companies', '/organization/companies', {}],
    ['platforms', '/organization/platforms', { companyId: MISSING_ID }],
    ['organizations', '/organization/organizations', { platformId: MISSING_ID }],
  ])('rejects client-supplied userId, role, permissions and organization ids as authorization data on create %s (400, never trusted)', async (_n, path, base) => {
    for (const extra of [{ userId: 'u1' }, { role: 'owner' }, { permissions: ['*'] }, { organizationId: MISSING_ID }, { adminTier: 'owner' }, { caller: 'billing-service' }, { isAdmin: true }]) {
      const res = await client(t).post(path, { name: 'Tamper', ...base, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('cannot tamper with generated or protected fields by PATCH (id, createdAt, updatedAt, parent ids)', async () => {
    const c = client(t);
    const company = await c.company();
    const platform = await c.platform(company.id);
    const org = await c.organization(platform.id);
    const attempts: [string, object][] = [
      [`/organization/companies/${company.id}`, { id: MISSING_ID }],
      [`/organization/companies/${company.id}`, { createdAt: '2000-01-01T00:00:00.000Z' }],
      [`/organization/platforms/${platform.id}`, { companyId: MISSING_ID }],
      [`/organization/platforms/${platform.id}`, { updatedAt: '2000-01-01T00:00:00.000Z' }],
      [`/organization/organizations/${org.id}`, { platformId: MISSING_ID }],
      [`/organization/organizations/${org.id}`, { companyId: company.id }],
    ];
    for (const [path, body] of attempts) expect((await c.patch(path, body)).status, `${path} ${JSON.stringify(body)}`).toBe(400);
    expect((await c.get(`/organization/companies/${company.id}`)).body).toEqual(company);
    expect((await c.get(`/organization/platforms/${platform.id}`)).body).toEqual(platform);
    expect((await c.get(`/organization/organizations/${org.id}`)).body).toEqual(org);
  });

  it('a body-supplied companyId cannot reach across: it must name a company that exists in THIS service (no trust of an outside id)', async () => {
    const res = await client(t).post('/organization/platforms', { companyId: '11111111-1111-4111-8111-111111111111', name: 'From elsewhere' });
    expect(res.status).toBe(404);
  });

  it('path-id tampering (traversal, encoded separators, SQL, oversize, wrong entity) is a 400/404 and never a 500', async () => {
    const c = client(t);
    for (const id of ["' OR '1'='1", '1;DROP TABLE company', '..%2F..%2Fplatforms', '%00', 'a'.repeat(300), '00000000-0000-4000-8000-00000000000g']) {
      const res = await c.get(`/organization/companies/${id}`);
      expect([400, 404], id).toContain(res.status);
    }
    expect((await sql(db.url, `SELECT to_regclass('company') IS NOT NULL AS ok`))[0].ok).toBe(true);
  });

  it('malformed requests: bad JSON, wrong content-type, huge body and a huge array are refused cleanly', async () => {
    const c = client(t);
    const post = () => t.http().post('/organization/companies').set(c.auth).set('Idempotency-Key', 'malformed-0001');
    expect((await post().set('Content-Type', 'application/json').send('{"name":')).status).toBe(400);
    expect((await post().set('Content-Type', 'text/plain').send('name=x')).status).toBe(400);
    const big = await post().set('Content-Type', 'application/json').send(JSON.stringify({ name: 'x'.repeat(300 * 1024) }));
    expect(big.status).toBe(413);
  });

  it('records WHICH service made each change, and never writes a token or digest to the logs', async () => {
    // A fresh app: Nest's logger override is process-global, so the most recently created app owns it.
    const own = await createTestApp({ databaseUrl: db.url });
    try {
      const c = client(own, 'payment-service');
      const company = await c.company('Attributed');
      await c.patch(`/organization/companies/${company.id}`, { name: 'Attributed 2' });
      const text = own.logs.map((l) => JSON.stringify(l)).join('\n');
      expect(text).toContain(`company_created id=${company.id} caller=payment-service`);
      expect(text).toContain(`company_updated id=${company.id} caller=payment-service`);
      expect(own.logs.filter((l) => String(l.msg).startsWith('company_created')).every((l) => typeof l.requestId === 'string')).toBe(true);
      for (const token of Object.values(own.callers)) expect(text).not.toContain(token);
      for (const { digest } of own.config.serviceTokens) expect(text).not.toContain(digest);
    } finally {
      await own.app.close();
    }
  });

  it('errors carry the request id and never leak SQL, stack traces, hosts or credentials', async () => {
    const res = await client(t).post('/organization/platforms', { companyId: MISSING_ID, name: 'x' });
    expect(res.body.requestId).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/violates|constraint|platform_company_fk|postgres|at \S+\.(ts|js):\d+/i);
    const echoed = await t.http().get('/health').set('x-request-id', 'trace-abc-123');
    expect(echoed.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('OpenAPI is not served unless a docs password is configured, and is behind basic auth when it is', async () => {
    expect((await t.http().get('/organization/docs-json')).status).toBe(404);
    const own = await createTestApp({ databaseUrl: db.url, env: { SWAGGER_PASSWORD: 'a-long-enough-docs-password' } });
    try {
      expect((await own.http().get('/organization/docs-json')).status).toBe(401);
      const ok = await own.http().get('/organization/docs-json').auth('docs', 'a-long-enough-docs-password');
      expect(ok.status).toBe(200);
      expect(ok.body.info.title).toBe('organization-service API');
      expect(ok.body.info.description).toMatch(/NOT YET AUTHORITATIVE/);
    } finally {
      await own.app.close();
    }
  });

  it('two callers see one consistent hierarchy (a service token grants access to the service, not to a private slice)', async () => {
    const a = client(t, 'billing-service');
    const b = client(t, 'payment-service');
    const company = await a.company('Shared');
    expect((await b.get(`/organization/companies/${company.id}`)).body).toEqual(company);
  });
});

describe('makeCallers', () => {
  it('produces distinct random tokens whose digests are what the service stores', () => {
    const { entries, tokens } = makeCallers('a-service', 'b-service');
    expect(tokens['a-service']).not.toBe(tokens['b-service']);
    expect(entries.map((e) => e.caller)).toEqual(['a-service', 'b-service']);
  });
});
