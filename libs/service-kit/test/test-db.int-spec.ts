import pg from 'pg';
import { expect, it } from 'vitest';
import { createTestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

/**
 * R11 (the Billing `57P01` teardown race, observed in Core CI on PR #237; A15 record §6, A3M record §12): `pg.Pool#end()` resolves once its
 * clients are REMOVED, before their sockets have closed (pg-pool `_remove` starts `client.end()` without waiting). A scratch database
 * dropped right after it terminated those still-closing sessions, and the 57P01 FATAL reached a client whose pool had no error listener:
 * an uncaught exception. `drop()` must let sessions that are closing disappear first, and terminate only what is still connected.
 */
const exists = async (adminUrl: string, name: string): Promise<boolean> => {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1;
  } finally {
    await c.end();
  }
};
const nameOf = (url: string) => new URL(url).pathname.slice(1);

describeWithEnv('scratch database teardown (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  it('a session that is still closing when drop() starts is never terminated: it closes on its own, with no error', async () => {
    const db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'teardown');
    const client = new pg.Client({ connectionString: db.url });
    const errors: unknown[] = [];
    client.on('error', (e) => errors.push(e)); // records only; an error here is a failure of the property under test
    await client.connect();
    await client.query('SELECT 1');
    // A controlled delayed disconnect: the client closes 300 ms after drop() starts, as a pool's removed client does a moment later.
    const closing = new Promise<void>((resolve) => setTimeout(() => void client.end().then(resolve, resolve), 300));
    await db.drop();
    await closing;
    expect(errors.map((e) => (e as { code?: string }).code)).toEqual([]);
    expect(await exists(env.TEST_DATABASE_ADMIN_URL, nameOf(db.url))).toBe(false);
  });

  it('immediately after pool.end() with several idle clients, drop() raises no pool error and removes the database (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'teardown');
      const pool = new pg.Pool({ connectionString: db.url, max: 8 });
      const errors: unknown[] = [];
      pool.on('error', (e) => errors.push(e)); // records only
      await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT pg_sleep(0.01)')));
      await pool.end(); // resolves before the eight sockets have closed
      await db.drop();
      expect(errors.map((e) => (e as { code?: string }).code), `round ${round}`).toEqual([]);
      expect(await exists(env.TEST_DATABASE_ADMIN_URL, nameOf(db.url))).toBe(false);
    }
  });

  it('a connection that is really retained is terminated after the bound, reported by state, and the database is still removed', async () => {
    const db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'teardown');
    const idle = new pg.Client({ connectionString: db.url });
    const inTx = new pg.Client({ connectionString: db.url });
    const first = new Map<pg.Client, string>(); // each client's FIRST error (pg follows a FATAL with a code-less "connection terminated")
    for (const c of [idle, inTx]) c.on('error', (e) => { if (!first.has(c)) first.set(c, (e as { code?: string }).code ?? 'none'); });
    await idle.connect();
    await inTx.connect();
    await inTx.query('BEGIN');
    await inTx.query('SELECT 1');
    const started = Date.now();
    const report = await db.drop({ closingTimeoutMs: 400 });
    const elapsed = Date.now() - started;
    expect(report.terminated).toBe(2);
    expect(report.leaked).toEqual({ idle: 1, 'idle in transaction': 1 });
    expect(elapsed).toBeGreaterThanOrEqual(400); // waited the bound for them to close on their own
    expect(elapsed).toBeLessThan(5000); // and no longer: bounded
    expect(await exists(env.TEST_DATABASE_ADMIN_URL, nameOf(db.url))).toBe(false);
    await new Promise((r) => setTimeout(r, 50)); // let the FATAL reach the clients' sockets
    expect([first.get(idle), first.get(inTx)]).toEqual(['57P01', '57P01']); // the leaked sessions were terminated by the drop
    for (const c of [idle, inTx]) await c.end().catch(() => undefined);
  });

  it('with nothing connected, drop() waits for nothing, terminates nothing and removes the database', async () => {
    const db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'teardown');
    const report = await db.drop();
    expect(report).toMatchObject({ terminated: 0, leaked: {} });
    expect(report.waitedMs).toBeLessThan(1000);
    expect(await exists(env.TEST_DATABASE_ADMIN_URL, nameOf(db.url))).toBe(false);
  });
});
