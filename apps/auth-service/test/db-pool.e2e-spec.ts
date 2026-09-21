import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DbService } from '../src/db/db.service.js';
import { createTestApp, type TestCtx } from './helpers/app.js';

/**
 * Audit finding N-01: an idle pooled connection that PostgreSQL terminates (restart, failover, administrator kill) is reported on the pool as an
 * 'error' event. With no listener, Node throws it as an uncaught exception and the whole Auth process exits. The pool now handles it: it is logged
 * by code, the process stays up, and the next query uses a fresh connection.
 */
describe('Auth database pool survives a terminated idle connection', () => {
  let t: TestCtx;
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => void uncaught.push(e);

  beforeAll(async () => {
    t = await createTestApp();
    process.on('uncaughtException', onUncaught);
  });
  afterAll(async () => {
    process.off('uncaughtException', onUncaught);
    await t.close();
  });

  const terminateOtherBackendsOfThisDatabase = async () => {
    const admin = new pg.Client({ connectionString: inject('pgAdminUrl') });
    await admin.connect();
    try {
      const dbName = new URL((t.env as { DATABASE_URL: string }).DATABASE_URL).pathname.slice(1);
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
    } finally {
      await admin.end();
    }
  };

  it('registers a pool error listener (without one, an idle-connection error is fatal)', () => {
    const pool = (t.app.get(DbService) as unknown as { pool: pg.Pool }).pool;
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
  });

  it('keeps the process alive when PostgreSQL terminates an idle client, logs it by code only, and serves the next query on a new connection', async () => {
    const db = t.app.get(DbService);
    await Promise.all(Array.from({ length: 4 }, () => db.query('SELECT 1'))); // leaves several idle clients in the pool
    await terminateOtherBackendsOfThisDatabase(); // what a restart or an administrator's kill does to them
    await new Promise((r) => setTimeout(r, 750)); // the 'error' events arrive asynchronously

    expect(uncaught).toEqual([]); // before the fix: an uncaught "terminating connection due to administrator command" (57P01)
    expect((await db.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    const warnings = t.logger.lines.filter((l) => l.includes('db_pool_idle_client_error'));
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((l) => /code=57P01/.test(l))).toBe(true);
    expect(warnings.join('\n')).not.toMatch(/postgres:\/\/|password|terminating connection/i); // code only: no message, no connection detail
  });
});
