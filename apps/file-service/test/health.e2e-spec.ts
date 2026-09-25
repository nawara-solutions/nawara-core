import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { STORAGE_PORT, type StoragePort } from '../src/storage/storage.port.js';
import { createTestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 17.2: readiness depends on the database and its migrations only (the kit checks; ADR-0048 §8: object storage is not a
 * readiness dependency); liveness never depends on them; the pool closes at shutdown. Stage 17.3: the baseline is the kit's migrations
 * plus the file schema (`0001_file_schema.sql`); a database missing the file schema is not ready.
 */
describeWithEnv('health, readiness and database shutdown (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'filehealth');
  });
  afterAll(() => db.drop());
  const name = () => new URL(db.url).pathname.slice(1);

  it('/ready is 503 naming only `migrations` while any is pending (the kit baseline alone is not enough), 200 once the file schema is applied; /health stays 200', async () => {
    const t = await createTestApp({ databaseUrl: db.url });
    try {
      await request(t.app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
      const pending = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(pending.body).toEqual({ status: 'unavailable', failed: ['migrations'] });
      const kitOnly = await runMigrations(db.url, [kitMigrationsDir]);
      expect(kitOnly.applied.every((n) => n.startsWith('kit_'))).toBe(true);
      expect((await request(t.app.getHttpServer()).get('/ready').expect(503)).body.failed).toEqual(['migrations']); // the file schema is missing
      await request(t.app.getHttpServer()).get('/health').expect(200);
      const applied = await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
      expect(applied.applied).toEqual(['0001_file_schema.sql', '0002_file_deletion_worker.sql']);
      await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' });
      const again = await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
      expect(again.applied).toEqual([]); // a re-run is a no-op
      const tables = await sql<{ t: string }>(db.url, `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'file%' ORDER BY 1`);
      expect(tables.map((r) => r.t)).toEqual(['file', 'file_access_ticket']);
    } finally {
      await t.app.close();
    }
  });

  it('/ready fails closed when the database goes away after startup, then recovers; /health never depends on it', async () => {
    const t = await createTestApp({ databaseUrl: db.url });
    try {
      await request(t.app.getHttpServer()).get('/ready').expect(200);
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${name()}" WITH ALLOW_CONNECTIONS false`);
      await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'file-service' AND datname = $1`, [name()]);
      const down = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(down.body.failed).toContain('database');
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

  it('identifies its sessions as `file-service`, and closing the application ends every one of them (the pool closes last)', async () => {
    const t = await createTestApp({ databaseUrl: db.url });
    await request(t.app.getHttpServer()).get('/ready').expect(200);
    const open = await sql<{ n: number }>(env.TEST_DATABASE_ADMIN_URL, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'file-service'`, [name()]);
    expect(open[0].n).toBeGreaterThan(0);
    const t0 = Date.now();
    await t.app.close();
    expect(Date.now() - t0).toBeLessThan(6_000);
    const left = await sql<{ n: number }>(env.TEST_DATABASE_ADMIN_URL, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'file-service'`, [name()]);
    expect(left[0].n).toBe(0);
    expect(t.logs.map((l) => String(l.msg)).some((m) => m.startsWith('service_shutdown_complete'))).toBe(true);
  });

  it('Stage 17.4: object storage is NOT readiness — with the store unreachable, /ready is 200 and /health 200 (ADR-0048 §8)', async () => {
    const t = await createTestApp({
      databaseUrl: db.url,
      env: { FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: 'http://127.0.0.1:1', FILE_S3_REGION: 'us-east-1', FILE_S3_BUCKET: 'unreachable-bucket',
        FILE_S3_ACCESS_KEY_ID: 'AKIDREADY', FILE_S3_SECRET_ACCESS_KEY: 'ready-secret-not-real-000' },
    });
    try {
      await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' });
      await request(t.app.getHttpServer()).get('/health').expect(200);
      const storage = t.app.get<StoragePort>(STORAGE_PORT);
      expect(storage.provider).toBe('s3');
      const e = await storage.head('files/2b1f1c2e-6d7a-4a39-9c43-2c8f1f7d9a10/0123456789abcdef0123456789abcdef', { signal: new AbortController().signal }).catch((x: unknown) => x);
      expect((e as { code?: string }).code).toBe('storage_unavailable'); // the outage is per operation
      await request(t.app.getHttpServer()).get('/ready').expect(200); // … and still not a readiness failure
      expect(t.logs.some((l) => String(l.msg).startsWith('storage_op op=head provider=s3 outcome=storage_unavailable'))).toBe(true);
      expect(JSON.stringify(t.logs)).not.toMatch(/ready-secret|AKIDREADY|unreachable-bucket|2b1f1c2e/);
    } finally {
      await t.app.close();
    }
  });

  it('shutdown with the database unreachable is prompt (nothing waits on a dead pool)', async () => {
    const t = await createTestApp({ env: { DB_CONNECTION_TIMEOUT_MS: '500' } }); // the unreachable default
    await request(t.app.getHttpServer()).get('/ready').expect(503);
    const t0 = Date.now();
    await t.app.close();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
