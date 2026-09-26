import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { releaseMigrationsDir } from '../src/app.module.js';
import { createTestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 20.2: readiness depends on the database and its migrations only (release-service calls no other service); liveness never
 * depends on them; the pool closes at shutdown; there is no route besides /health and /ready.
 */
describeWithEnv('release-service foundation: health, readiness, routes and shutdown (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'relhealth');
  });
  afterAll(() => db.drop());
  const name = () => new URL(db.url).pathname.slice(1);

  it('/ready is 503 naming only `migrations` while they are pending, then 200; the release migration is applied; a re-run applies nothing; /health stays 200', async () => {
    const t = await createTestApp({ databaseUrl: db.url });
    try {
      await request(t.app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
      const pending = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(pending.body).toEqual({ status: 'unavailable', failed: ['migrations'] });
      const applied = await runMigrations(db.url, [kitMigrationsDir, releaseMigrationsDir]);
      expect(applied.applied).toContain('0001_release_domain.sql');
      await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' });
      const again = await runMigrations(db.url, [kitMigrationsDir, releaseMigrationsDir]);
      expect(again.applied).toEqual([]);
      const tables = (await sql<{ t: string }>(db.url, `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).map((r) => r.t);
      expect(tables).toEqual(expect.arrayContaining(['product', 'component', 'release', 'compatibility_policy']));
      // ADR-0051: no deployment, environment, artifact or channel table.
      expect(tables.filter((x) => /deploy|environment|artifact|channel/.test(x))).toEqual([]);
    } finally {
      await t.app.close();
    }
  });

  it('exposes no business route in Stage 20.2 (registration, administration and the compatibility read are later stages)', async () => {
    const t = await createTestApp({ databaseUrl: db.url });
    try {
      for (const [method, path] of [['get', '/release'], ['get', '/release/compatibility'], ['post', '/release/releases'], ['get', '/release/docs'], ['get', '/docs']] as const) {
        const r = await request(t.app.getHttpServer())[method](path);
        expect(r.status, `${method} ${path}`).toBe(404);
        expect(JSON.stringify(r.body)).not.toMatch(/release_|product|component|stack/i);
      }
    } finally {
      await t.app.close();
    }
  });

  it('/ready fails closed when the database goes away after startup, then recovers; /health never depends on it', async () => {
    const t = await createTestApp({ databaseUrl: db.url });
    try {
      await request(t.app.getHttpServer()).get('/ready').expect(200);
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${name()}" WITH ALLOW_CONNECTIONS false`);
      await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'release-service' AND datname = $1`, [name()]);
      const down = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(down.body.failed).toContain('database');
      expect(JSON.stringify(down.body)).not.toMatch(/ECONN|password|127\.0\.0\.1|terminat/i);
      await request(t.app.getHttpServer()).get('/health').expect(200);
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${name()}" WITH ALLOW_CONNECTIONS true`);
      await request(t.app.getHttpServer()).get('/ready').expect(200);
      expect(JSON.stringify(t.logs)).not.toContain(new URL(env.TEST_DATABASE_ADMIN_URL).password || 'no-password-set');
    } finally {
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${name()}" WITH ALLOW_CONNECTIONS true`);
      await t.app.close();
    }
  });

  it('identifies its sessions as `release-service`, and closing the application ends every one of them (the pool closes last)', async () => {
    const t = await createTestApp({ databaseUrl: db.url });
    await request(t.app.getHttpServer()).get('/ready').expect(200);
    const count = async () => (await sql<{ n: number }>(env.TEST_DATABASE_ADMIN_URL, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'release-service'`, [name()]))[0]!.n;
    expect(await count()).toBeGreaterThan(0);
    const t0 = Date.now();
    await t.app.close();
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(await count()).toBe(0);
    expect(t.logs.map((l) => String(l.msg)).some((m) => m.startsWith('service_shutdown_complete'))).toBe(true);
  });

  it('shutdown with the database unreachable is prompt (nothing waits on a dead pool)', async () => {
    const t = await createTestApp({ env: { DB_CONNECTION_TIMEOUT_MS: '500' } });
    await request(t.app.getHttpServer()).get('/ready').expect(503);
    const t0 = Date.now();
    await t.app.close();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
