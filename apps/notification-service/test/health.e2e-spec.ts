import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { createTestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/** Stage 16.4: readiness now depends on the database and its migrations (the kit checks); liveness never does; the pool closes at shutdown. */
describeWithEnv('health, readiness and database shutdown (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifhealth');
  });
  afterAll(() => db.drop());

  it('/ready is 503 naming only `migrations` while they are pending, and 200 once they are applied; /health stays 200', async () => {
    const t = await createTestApp({ databaseUrl: db.url });
    try {
      await request(t.app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
      const pending = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(pending.body).toEqual({ status: 'unavailable', failed: ['migrations'] });
      await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
      await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' });
    } finally {
      await t.app.close();
    }
  });

  it('/ready fails closed when the database goes away after startup, then recovers; /health never depends on it', async () => {
    const t = await createTestApp({ databaseUrl: db.url });
    try {
      await request(t.app.getHttpServer()).get('/ready').expect(200);
      // Take the database away from this service only: forbid new connections and end the pool's sessions.
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${new URL(db.url).pathname.slice(1)}" WITH ALLOW_CONNECTIONS false`);
      await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'notification-service' AND datname = $1`, [new URL(db.url).pathname.slice(1)]);
      const down = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(down.body.failed).toContain('database');
      await request(t.app.getHttpServer()).get('/health').expect(200);
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${new URL(db.url).pathname.slice(1)}" WITH ALLOW_CONNECTIONS true`);
      await request(t.app.getHttpServer()).get('/ready').expect(200);
      expect(t.logs.some((l) => String(l.msg).startsWith('readiness_check_failed check=database'))).toBe(true);
      expect(t.logs.some((l) => String(l.msg).startsWith('readiness_check_recovered check=database'))).toBe(true);
      expect(JSON.stringify(t.logs)).not.toContain(new URL(env.TEST_DATABASE_ADMIN_URL).password || 'no-password-set');
    } finally {
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${new URL(db.url).pathname.slice(1)}" WITH ALLOW_CONNECTIONS true`);
      await t.app.close();
    }
  });

  it('identifies its sessions as `notification-service`, and closing the application ends every one of them (the pool closes last)', async () => {
    const t = await createTestApp({ databaseUrl: db.url });
    await request(t.app.getHttpServer()).get('/ready').expect(200);
    const name = new URL(db.url).pathname.slice(1);
    const open = await sql<{ n: number }>(env.TEST_DATABASE_ADMIN_URL, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'notification-service'`, [name]);
    expect(open[0].n).toBeGreaterThan(0);
    const t0 = Date.now();
    await t.app.close();
    expect(Date.now() - t0).toBeLessThan(6_000);
    const left = await sql<{ n: number }>(env.TEST_DATABASE_ADMIN_URL, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'notification-service'`, [name]);
    expect(left[0].n).toBe(0);
    const lines = t.logs.map((l) => String(l.msg));
    expect(lines.some((m) => m.startsWith('service_shutdown_complete'))).toBe(true);
  });

  it('shutdown with the database unreachable is prompt (nothing waits on a dead pool)', async () => {
    const t = await createTestApp({ env: { DB_CONNECTION_TIMEOUT_MS: '500' } }); // the unreachable default
    await request(t.app.getHttpServer()).get('/ready').expect(503);
    const t0 = Date.now();
    await t.app.close();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
