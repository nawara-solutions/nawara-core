import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { QueryCounters } from '../src/query/query-counters.js';
import { QueryReporter } from '../src/query/query-reporter.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Stage 19.5: the operation of Audit-X. The outcome of every owner read is classified (a refusal of the caller is `denied`, never an error,
 * the 19.4 H11 finding; an Auth failure is `auth_timeout` / `auth_unavailable`; a read that cannot be recorded is `unavailable`), Auth is
 * given ONE budget per request, its latency is observable, a failing dependency recovers without a restart, and readiness never depends
 * on Auth. Auth is a stub on its exact contract.
 */
const COMPANY_A = randomUUID();
const A1 = randomUUID();
const OWNER = randomUUID();
const WINDOW = { from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' };
const msgOf = (l: Record<string, unknown>): string => (typeof l.msg === 'string' ? l.msg : '');

function stubAuth() {
  const state = { mode: 'ok' as 'ok' | 'down' | 'hang' | 'malformed' | 'slow_each', delayMs: 0 };
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const answer = () => {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (state.mode === 'down') return send(500, {});
      if (state.mode === 'malformed') return send(200, { nope: true });
      if (token === 'member-bearer' && req.url === '/auth/grants') return send(200, { userId: randomUUID(), kind: 'member', companyId: null, platformAssignments: [], organizationAdminMemberships: [] });
      if (token !== 'owner-bearer') return send(401, {});
      if (req.url === '/auth/grants') return send(200, { userId: OWNER, kind: 'owner', companyId: COMPANY_A, platformAssignments: [], organizationAdminMemberships: [] });
      if (req.url === `/auth/admin/organizations/${A1}`) return send(200, { id: A1, platformId: randomUUID() });
      return send(404, {});
    };
    if (state.mode === 'hang') return;
    if (state.mode === 'slow_each') return void setTimeout(answer, state.delayMs);
    answer();
  });
  return { server, state };
}

describeWithEnv('Audit-X operation (Stage 19.5, real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  let auth: ReturnType<typeof stubAuth>;
  let authUrl: string;
  const read = (bearer: string, org = A1, query: Record<string, string> = {}, app: TestApp = t) =>
    request(app.app.getHttpServer()).get(`/audit/owner/organizations/${org}/records`).query({ ...WINDOW, ...query }).set('authorization', `Bearer ${bearer}`);
  const counts = (app: TestApp = t) => app.app.get(QueryCounters).drain();
  const adminDb = () => env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, `/${d.name}`);

  beforeAll(async () => {
    auth = stubAuth();
    await new Promise<void>((r) => auth.server.listen(0, '127.0.0.1', r));
    authUrl = `http://127.0.0.1:${(auth.server.address() as AddressInfo).port}`;
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'aownerops');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    t = await createTestApp({ databaseUrl: d.appUrl, env: { AUTH_SERVICE_URL: authUrl, AUDIT_OWNER_QUERY_RATE_PER_OWNER: '1000', AUTH_TIMEOUT_MS: '400' } });
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
    auth?.server.closeAllConnections();
    await new Promise((r) => auth?.server.close(r));
  });

  it('H11: a refusal of the caller (401, 403, 404) is `denied`, never `error`; a bad request is `invalid`; a read is `ok`', async () => {
    counts();
    await read('owner-bearer').expect(200);
    await read('revoked-bearer').expect(401);
    await read('member-bearer').expect(403);
    await read('owner-bearer', randomUUID()).expect(404);
    await read('owner-bearer', A1, { limit: '999' }).expect(400);
    const c = counts().counts;
    expect(c).toMatchObject({ owner_ok: 1, owner_denied: 3, owner_invalid: 1, owner_error: 0, owner_auth_timeout: 0, owner_auth_unavailable: 0 });
    // closed per scope: the owner-only outcomes never appear for the service scopes
    expect(Object.keys(c).filter((k) => k.startsWith('organization_auth') || k.startsWith('platform_auth'))).toEqual([]);
  });

  it('an Auth failure is its own class: auth_timeout (budget spent) vs auth_unavailable (anything else); the body names the class only', async () => {
    counts();
    for (const [mode, code] of [['hang', 'auth_timeout'], ['down', 'auth_unavailable'], ['malformed', 'auth_unavailable']] as const) {
      auth.state.mode = mode;
      try {
        const r = await read('owner-bearer');
        expect([r.status, r.body.code], mode).toEqual([503, code]);
        expect(JSON.stringify(r.body)).not.toContain('127.0.0.1');
        expect(r.body.items).toBeUndefined();
      } finally {
        auth.state.mode = 'ok';
      }
    }
    expect(counts().counts).toMatchObject({ owner_auth_timeout: 1, owner_auth_unavailable: 2, owner_error: 0, owner_unavailable: 0 });
  });

  it('ONE Auth budget per request: two calls that each fit the timeout but not together time out, and the read is bounded by it', async () => {
    counts();
    auth.state.mode = 'slow_each';
    auth.state.delayMs = 250; // each call < 400 ms, both > 400 ms
    try {
      const t0 = Date.now();
      const r = await read('owner-bearer');
      const ms = Date.now() - t0;
      expect([r.status, r.body.code]).toEqual([503, 'auth_timeout']);
      expect(ms).toBeLessThan(400 + 300); // the budget, plus scheduling slack: never 2 × the timeout
    } finally {
      auth.state.mode = 'ok';
    }
    const s = counts();
    expect(s.counts.owner_auth_timeout).toBe(1);
    expect(s.ownerAuthLatency.count).toBe(1);
    expect(s.ownerAuthLatency.maxMs).toBeGreaterThanOrEqual(350);
  });

  it('Auth latency is observable before it times out (count / avg / max per snapshot, no labels)', async () => {
    counts();
    auth.state.mode = 'slow_each';
    auth.state.delayMs = 60;
    try {
      await read('owner-bearer').expect(200);
      await read('owner-bearer').expect(200);
    } finally {
      auth.state.mode = 'ok';
    }
    const s = counts();
    expect(s.counts.owner_ok).toBe(2);
    expect(s.ownerAuthLatency.count).toBe(2);
    expect(s.ownerAuthLatency.avgMs).toBeGreaterThanOrEqual(100); // two calls of ≥ 60 ms each
  });

  it('refused connection and unresolvable name are auth_unavailable, within the budget; the process keeps serving', async () => {
    for (const url of ['http://127.0.0.1:1', 'http://auth-does-not-exist.invalid']) {
      const app = await createTestApp({ databaseUrl: d.appUrl, env: { AUTH_SERVICE_URL: url, AUTH_TIMEOUT_MS: '2000' } });
      try {
        const r = await read('owner-bearer', A1, {}, app);
        expect([r.status, r.body.code], url).toEqual([503, 'auth_unavailable']);
        expect(counts(app).counts.owner_auth_unavailable).toBe(1);
        await request(app.app.getHttpServer()).get('/health').expect(200);
      } finally {
        await app.app.close();
      }
    }
  });

  it('recovery without a restart: Auth down → 503; Auth back → the next read succeeds', async () => {
    auth.state.mode = 'down';
    try {
      await read('owner-bearer').expect(503);
    } finally {
      auth.state.mode = 'ok';
    }
    await read('owner-bearer').expect(200);
  });

  it('an Audit database failure is `unavailable` (no evidence), not an Auth failure; it recovers when the database does', async () => {
    counts();
    await sql(adminDb(), `REVOKE SELECT ON audit_record FROM ${d.app}`);
    try {
      const r = await read('owner-bearer');
      expect([r.status, r.body.code]).toEqual([503, 'accountability_unavailable']);
      expect(r.body.items).toBeUndefined();
    } finally {
      await sql(adminDb(), `GRANT SELECT ON audit_record TO ${d.app}`);
    }
    await read('owner-bearer').expect(200);
    expect(counts().counts).toMatchObject({ owner_unavailable: 1, owner_ok: 1, owner_auth_unavailable: 0 });
  });

  it('the snapshot line carries the owner outcomes and Auth latency; the startup line says enabled or disabled, never Auth\'s address', async () => {
    const before = ALL_LOGS.length;
    await read('owner-bearer').expect(200);
    t.app.get(QueryReporter).snapshot();
    const lines = ALL_LOGS.slice(before).map((l) => msgOf(l));
    const snap = lines.find((m) => m.startsWith('audit_query_snapshot'))!;
    expect(snap).toMatch(/owner_ok=1 .*owner_auth_timeout=0 owner_auth_unavailable=0/);
    expect(snap).toMatch(/owner_auth_count=1 owner_auth_avg_ms=\d+ owner_auth_max_ms=\d+/);
    const boot = ALL_LOGS.map((l) => msgOf(l)).filter((m) => m.startsWith('audit_owner_access'));
    expect(boot).toContain('audit_owner_access enabled auth_timeout_ms=400 rate_per_owner=1000');
    expect(boot.join(' ')).not.toContain('127.0.0.1');
    const plain = await createTestApp({ databaseUrl: d.appUrl });
    try {
      expect(ALL_LOGS.map((l) => msgOf(l))).toContain('audit_owner_access disabled (AUTH_SERVICE_URL not set)');
    } finally {
      await plain.app.close();
    }
  });

  it('readiness never depends on Auth: with Auth down, /ready names only Audit\'s own dependencies and /health stays 200', async () => {
    auth.state.mode = 'down';
    try {
      const ready = await request(t.app.getHttpServer()).get('/ready');
      expect(JSON.stringify(ready.body)).not.toMatch(/auth/i);
      await request(t.app.getHttpServer()).get('/health').expect(200);
    } finally {
      auth.state.mode = 'ok';
    }
  });
});
