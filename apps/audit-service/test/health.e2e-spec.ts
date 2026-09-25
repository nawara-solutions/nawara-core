import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { auditMigrationsDir } from '../src/app.module.js';
import { createTestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 18.2: readiness depends on the database and its migrations only (no broker until 18.5, never Auth, Organization or a product);
 * liveness never depends on them; the pool closes at shutdown. The migration baseline is the service-kit's (`auditMigrationsDir` holds
 * no migration until Stage 18.3).
 */
describeWithEnv('health, readiness and database shutdown (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'audithealth');
  });
  afterAll(() => db.drop());
  const name = () => new URL(db.url).pathname.slice(1);

  it('/ready is 503 naming only `migrations` while they are pending, and 200 once the baseline is applied; a re-run applies nothing; /health stays 200', async () => {
    const t = await createTestApp({ databaseUrl: db.url });
    try {
      await request(t.app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
      const pending = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(pending.body).toEqual({ status: 'unavailable', failed: ['migrations'] });
      const applied = await runMigrations(db.url, [kitMigrationsDir, auditMigrationsDir]);
      expect(applied.applied.length).toBeGreaterThan(0);
      expect(applied.applied.every((n) => n.startsWith('kit_'))).toBe(true); // the service has no migration of its own yet
      await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' });
      const again = await runMigrations(db.url, [kitMigrationsDir, auditMigrationsDir]);
      expect(again.applied).toEqual([]); // a re-run is a no-op
      expect(again.alreadyApplied).toEqual(applied.applied);
      // No audit domain yet (Stage 18.3): no audit table, no column of the future record.
      expect(await sql(db.url, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'audit%'`)).toEqual([]);
      expect(await sql(db.url, `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('actorType', 'actorId', 'recordedAt', 'resourceType', 'resourceId', 'sourceService')`)).toEqual([]);
    } finally {
      await t.app.close();
    }
  });

  it('/ready fails closed when the database goes away after startup, then recovers; /health never depends on it', async () => {
    const t = await createTestApp({ databaseUrl: db.url });
    try {
      await request(t.app.getHttpServer()).get('/ready').expect(200);
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${name()}" WITH ALLOW_CONNECTIONS false`);
      await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'audit-service' AND datname = $1`, [name()]);
      const down = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(down.body.failed).toContain('database');
      expect(JSON.stringify(down.body)).not.toMatch(/ECONN|password|127\.0\.0\.1|terminat/i); // check names only
      await request(t.app.getHttpServer()).get('/health').expect(200);
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${name()}" WITH ALLOW_CONNECTIONS true`);
      await request(t.app.getHttpServer()).get('/ready').expect(200);
      expect(t.logs.some((l) => String(l.msg).startsWith('readiness_check_failed check=database'))).toBe(true);
      expect(t.logs.some((l) => String(l.msg).startsWith('readiness_check_recovered check=database'))).toBe(true);
      expect(JSON.stringify(t.logs)).not.toContain(new URL(env.TEST_DATABASE_ADMIN_URL).password || 'no-password-set');
    } finally {
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${name()}" WITH ALLOW_CONNECTIONS true`);
      await t.app.close();
    }
  });

  it('a ledger that no longer records an applied migration is "pending": /ready fails closed naming `migrations`, then recovers when it is recorded again', async () => {
    const [first] = await sql<{ name: string; checksum: string | null }>(db.url, `SELECT name, checksum FROM schema_migrations ORDER BY name LIMIT 1`);
    const t = await createTestApp({ databaseUrl: db.url });
    try {
      await request(t.app.getHttpServer()).get('/ready').expect(200);
      await sql(db.url, `DELETE FROM schema_migrations WHERE name = $1`, [first!.name]); // as the admin: a damaged or rolled-back ledger
      const r = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(r.body).toEqual({ status: 'unavailable', failed: ['migrations'] });
      await request(t.app.getHttpServer()).get('/health').expect(200);
    } finally {
      await sql(db.url, `INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [first!.name, first!.checksum]);
      await request(t.app.getHttpServer()).get('/ready').expect(200);
      await t.app.close();
    }
  });

  it('identifies its sessions as `audit-service`, and closing the application ends every one of them (the pool closes last)', async () => {
    const t = await createTestApp({ databaseUrl: db.url });
    await request(t.app.getHttpServer()).get('/ready').expect(200);
    const open = await sql<{ n: number }>(env.TEST_DATABASE_ADMIN_URL, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'audit-service'`, [name()]);
    expect(open[0].n).toBeGreaterThan(0);
    const t0 = Date.now();
    await t.app.close();
    expect(Date.now() - t0).toBeLessThan(6_000);
    const left = await sql<{ n: number }>(env.TEST_DATABASE_ADMIN_URL, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'audit-service'`, [name()]);
    expect(left[0].n).toBe(0);
    expect(t.logs.map((l) => String(l.msg)).some((m) => m.startsWith('service_shutdown_complete'))).toBe(true);
  });

  it('shutdown with the database unreachable is prompt (nothing waits on a dead pool)', async () => {
    const t = await createTestApp({ env: { DB_CONNECTION_TIMEOUT_MS: '500' } }); // the unreachable default
    await request(t.app.getHttpServer()).get('/ready').expect(503);
    const t0 = Date.now();
    await t.app.close();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
