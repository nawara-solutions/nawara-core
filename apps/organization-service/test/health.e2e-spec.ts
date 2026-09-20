import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations, DbService } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { organizationMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

describeWithEnv('health, readiness and shutdown (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orghealth');
  });
  afterAll(() => db.drop());

  it('/health is public and 200 while migrations are pending; /ready is 503 naming only the failing check, and 200 once they are applied', async () => {
    const t: TestApp = await createTestApp({ databaseUrl: db.url });
    try {
      await t.http().get('/health').expect(200, { status: 'ok' });
      const pending = await t.http().get('/ready').expect(503);
      expect(pending.body).toEqual({ status: 'unavailable', failed: ['migrations'] });

      await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
      await t.http().get('/ready').expect(200, { status: 'ready' });
    } finally {
      await t.app.close();
    }
  });

  it('/ready fails closed with 503 when the database is unreachable, while /health stays 200; no host or credential appears', async () => {
    const t: TestApp = await createTestApp({ databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none' });
    try {
      await t.http().get('/health').expect(200);
      const r = await t.http().get('/ready').expect(503);
      expect(r.body.failed).toContain('database');
      expect(JSON.stringify(r.body)).not.toMatch(/nobody|nothing|127\.0\.0\.1|ECONNREFUSED/);
    } finally {
      await t.app.close();
    }
  });

  it('a domain request while the database is down is an opaque 5xx: no SQL, host or credential in the body', async () => {
    const t: TestApp = await createTestApp({ databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none' });
    try {
      const res = await t.http().get('/organization/companies').set('Authorization', `Bearer ${t.callers['billing-service']}`);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(res.body)).not.toMatch(/nobody|nothing|127\.0\.0\.1|ECONNREFUSED|postgres:/);
    } finally {
      await t.app.close();
    }
  });

  it('is ready with NO broker and NO Auth registered: the readiness checks are exactly database and migrations', async () => {
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    const t: TestApp = await createTestApp({ databaseUrl: db.url });
    try {
      await t.http().get('/ready').expect(200);
      // Break the database only, then prove the failing set is exactly what this service depends on.
      const broken: TestApp = await createTestApp({ databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none' });
      try {
        const r = await broken.http().get('/ready').expect(503);
        expect(r.body.failed.sort()).toEqual(['database', 'migrations']);
      } finally {
        await broken.app.close();
      }
    } finally {
      await t.app.close();
    }
  });

  it('graceful shutdown: signal hooks are installed, and closing the app closes the database pool (no leaked connections)', async () => {
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    const before = process.listenerCount('SIGTERM');
    const t: TestApp = await createTestApp({ databaseUrl: db.url });
    const dbService = t.app.get(DbService);
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(before); // enableShutdownHooks() (configureApp)
    await dbService.query('SELECT 1');
    await t.app.close();
    await expect(dbService.query('SELECT 1')).rejects.toThrow(/pool/i);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('an in-flight request finishes before shutdown completes (shutdown waits for it, then closes the pool)', async () => {
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    const t: TestApp = await createTestApp({ databaseUrl: db.url });
    // Hold a lock so the request is provably blocked in the database while shutdown begins.
    const locker = new pg.Client({ connectionString: db.url });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE company IN ACCESS EXCLUSIVE MODE');
    const { port } = t.app.getHttpServer().address() as AddressInfo;
    const inflight = fetch(`http://127.0.0.1:${port}/organization/companies`, { headers: { Authorization: `Bearer ${t.callers['billing-service']}` } }).then((r) => r.status);
    await new Promise((r) => setTimeout(r, 300));
    let closed = false;
    const closing = t.app.close().then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(closed).toBe(false); // shutdown is waiting for the request
    await locker.query('COMMIT');
    await locker.end();
    expect(await inflight).toBe(200); // the request completed against a still-open pool
    await closing;
    expect(closed).toBe(true);
  });
});
