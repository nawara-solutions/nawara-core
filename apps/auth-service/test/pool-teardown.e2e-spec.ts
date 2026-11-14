import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { trackPoolClients, type TrackedPool } from './helpers/pool-teardown.js';

/**
 * The test-harness teardown race behind the intermittent Auth CI failure: an uncaught `57P01 terminating connection due to administrator
 * command` after every test had passed. `test/helpers/app.ts` closed its own pool with `pool.end()` and then ran `DROP DATABASE … WITH (FORCE)`;
 * `pool.end()` resolves before the clients' connections have ended, so the drop could terminate a backend whose client was still connected,
 * and that pool has (deliberately) no 'error' listener.
 *
 * To make the window deterministic, each client's socket is corked before teardown: pg's Terminate message stays buffered, so the backend
 * is still alive when `pool.end()` returns, exactly the state the race produces by chance. The probe pool here records its 'error' events so
 * that the failure is observed and asserted; it is a detector local to this file, not the harness's behaviour.
 */
type Probe = { pool: pg.Pool; tracked: TrackedPool; clients: pg.PoolClient[]; errors: (Error & { code?: string; client?: unknown })[]; dbName: string };

describe('Auth test harness: a test-owned pool is fully closed before its database is force-dropped', () => {
  const adminUrl = inject('pgAdminUrl');
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
  });

  async function probe(): Promise<Probe> {
    const dbName = `t_teardown_${randomUUID().replace(/-/g, '')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const pool = new pg.Pool({ connectionString: adminUrl.replace(/\/[^/]*$/, `/${dbName}`), max: 3 });
    const p: Probe = { pool, tracked: trackPoolClients(pool), clients: [], errors: [], dbName };
    pool.on('error', (e) => void p.errors.push(e));
    // three clients, all connected, then released idle
    const held = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
    for (const c of held) await c.query('SELECT 1');
    p.clients = held;
    for (const c of held) c.release();
    return p;
  }
  const backends = async (dbName: string) =>
    (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [dbName])).rows[0].n;
  const cork = (p: Probe) => p.clients.forEach((c) => (c as unknown as { connection: { stream: NodeJS.WritableStream & { cork(): void } } }).connection.stream.cork());
  const uncork = (p: Probe) => p.clients.forEach((c) => (c as unknown as { connection: { stream: NodeJS.WritableStream & { uncork(): void } } }).connection.stream.uncork());
  const drop = (dbName: string) => admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);

  it('T1 (reproduction / negative control): the former order, pool.end() then the forced drop, delivers 57P01 to a still-connected pool client', async () => {
    const p = await probe();
    cork(p);
    await p.pool.end(); // resolves although no connection has ended
    expect(await backends(p.dbName)).toBe(3);
    await drop(p.dbName);
    // the terminated backends' errors arrive on the pool (on the harness pool, without a listener, each was an uncaught exception)
    await expect.poll(() => p.errors.length, { timeout: 10_000, interval: 20 }).toBeGreaterThanOrEqual(1);
    for (const e of p.errors) {
      expect(e.code).toBe('57P01');
      expect(p.clients).toContain(e.client); // pg-pool's idle listener: the client was still the pool's connection
    }
    uncork(p);
  });

  it('T2: the corrected teardown does not return while a client connection is still open, and fails visibly when it stays open', async () => {
    const p = await probe();
    const { tracked } = p;
    expect(tracked.open()).toBe(3);
    cork(p);
    await expect(tracked.end(500)).rejects.toThrow('test pool teardown: 3 client connection(s) still open after 500 ms');
    expect(await backends(p.dbName)).toBe(3); // nothing was dropped or terminated
    uncork(p); // Terminate is flushed, the connections end
    await expect.poll(() => tracked.open(), { timeout: 10_000, interval: 20 }).toBe(0);
    await drop(p.dbName);
    expect(p.errors).toEqual([]);
  });

  it('T3: the corrected teardown waits for the connections and then the forced drop terminates nothing', async () => {
    const p = await probe();
    const { tracked } = p;
    cork(p);
    let settled = false;
    const ended = tracked.end().then(() => void (settled = true));
    expect(await backends(p.dbName)).toBe(3); // a round trip later the teardown is still waiting: the connections are open
    expect(settled).toBe(false);
    uncork(p);
    await ended;
    expect(tracked.open()).toBe(0);
    await drop(p.dbName);
    expect(p.errors).toEqual([]);
  });

  it('T4: the harness pool itself has no error listener, so an unexpected pool error is never swallowed', async () => {
    const t = await createTestApp();
    try {
      expect(t.db.listenerCount('error')).toBe(0);
    } finally {
      await t.close();
    }
  });

  it('T5: repeated real harness lifecycles (all three pool clients used) tear down with no stray connection and no error', async () => {
    for (let i = 0; i < 15; i++) {
      const t = await createTestApp();
      await Promise.all([t.db.query('SELECT pg_sleep(0.01)'), t.db.query('SELECT pg_sleep(0.01)'), t.db.query('SELECT pg_sleep(0.01)')]);
      const dbName = new URL(t.env.DATABASE_URL).pathname.slice(1);
      await t.close();
      expect(await backends(dbName)).toBe(0);
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])).rowCount).toBe(0);
    }
  });
});
