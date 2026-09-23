import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, describeFailure } from '../src/index.js';
import { BrokerProxy, createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 15.2, invariant I9: a query whose answer never comes (the server or the network goes silent AFTER accepting it) must still end
 * within a configured bound. `statement_timeout` cannot do it (the server is the silent party) and `DB_CONNECTION_TIMEOUT_MS` only covers
 * getting or opening a connection; the client-side `query_timeout` (`DB_QUERY_TIMEOUT_MS`) does. The TCP proxy's `freeze()` stalls the
 * server-to-client direction of the established connection: the query reaches PostgreSQL, the answer never reaches the client.
 */
const pool = (d: DbService) => (d as unknown as { pool: pg.Pool }).pool;
const settledWithin = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return describeFailure(e);
  }
};

describeWithEnv('client-side query deadline (real PostgreSQL, stalled connection)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let proxy: BrokerProxy;
  let viaProxy: string;
  const closers: (() => Promise<unknown>)[] = [];
  const admin = async (sql: string, params?: unknown[]) => {
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      return (await c.query(sql, params)).rows;
    } finally {
      await c.end();
    }
  };
  const service = (o: Partial<ConstructorParameters<typeof DbService>[0]> = {}) => {
    const d = new DbService({ url: viaProxy, applicationName: 'query-deadline', ...o });
    closers.push(() => d.onApplicationShutdown().catch(() => undefined));
    return d;
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'qdeadline');
    await admin('CREATE TABLE marker (id text PRIMARY KEY)');
    const u = new URL(db.url);
    proxy = new BrokerProxy({ host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname, port: Number(u.port || 5432) });
    await proxy.start();
    u.hostname = '127.0.0.1';
    u.port = String(proxy.port);
    viaProxy = u.toString();
  });
  afterAll(async () => {
    proxy.thaw();
    for (const c of closers.reverse()) await c();
    await proxy.sever();
    await db.drop();
  });

  it('negative control: without a client deadline the query waits for as long as the fault lasts', async () => {
    const d = service({ statementTimeoutMs: 1000, queryTimeoutMs: 600_000 });
    await d.query('SELECT 1');
    proxy.freeze();
    const q = d.query('SELECT 1');
    expect(await settledWithin(q, 3000)).toBe(false); // statement_timeout (1 s) cannot end it: the answer is lost, not late
    proxy.thaw();
    await expect(q).resolves.toBeTruthy(); // it only returns because the fault cleared
  });

  it('a query on an established connection fails within DB_QUERY_TIMEOUT_MS, the client is destroyed, and the pool recovers', async () => {
    const d = service({ statementTimeoutMs: 1000, queryTimeoutMs: 1500 });
    await d.query('SELECT 1');
    proxy.freeze();
    const t = Date.now();
    const f = await failure(d.query('SELECT 1'));
    const ms = Date.now() - t;
    expect(f).toBe('error=Error kind=db_query_timeout');
    expect(ms).toBeGreaterThanOrEqual(1400);
    expect(ms).toBeLessThan(3000); // without the fault being removed
    expect(pool(d).totalCount).toBe(0); // never returned to the pool
    proxy.thaw();
    await expect(d.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });

  it('a transaction whose statement times out is NOT committed later by the next borrower (the client is destroyed, not reused)', async () => {
    // Before the fix, the client went back to the pool inside the open transaction and the next caller's COMMIT committed A and B.
    const d = service({ max: 1, statementTimeoutMs: 1000, queryTimeoutMs: 1500 });
    await d.query('SELECT 1');
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    const t = Date.now();
    const f = await failure(
      d.tx(async (q) => {
        await q.query('INSERT INTO marker VALUES ($1)', [a]);
        proxy.freeze();
        await q.query('INSERT INTO marker VALUES ($1)', [b]);
      }),
    );
    const ms = Date.now() - t;
    expect(f).toBe('error=Error kind=db_query_timeout');
    expect(ms).toBeLessThan(2500); // one deadline: no ROLLBACK queued behind the silent statement
    expect(pool(d).totalCount).toBe(0);
    proxy.thaw();
    await d.tx((q) => q.query('INSERT INTO marker VALUES ($1)', [c]));
    const rows = await admin('SELECT id FROM marker WHERE id = ANY($1)', [[a, b, c]]);
    expect(rows.map((r) => r.id)).toEqual([c]); // A and B were never committed
    const open = await admin(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`);
    expect(open[0].n).toBe(0); // the destroyed connection's session and its transaction ended on the server
  });

  it('shutdown is not held by a query that will never be answered', async () => {
    const d = new DbService({ url: viaProxy, statementTimeoutMs: 1000, queryTimeoutMs: 1500 });
    await d.query('SELECT 1');
    proxy.freeze();
    const q = failure(d.query('SELECT 1'));
    await new Promise((r) => setTimeout(r, 200));
    const t = Date.now();
    await d.onApplicationShutdown(); // pool.end() waits for checked-out clients: bounded by the deadline now
    expect(Date.now() - t).toBeLessThan(3000);
    expect(await q).toBe('error=Error kind=db_query_timeout');
    proxy.thaw();
  });

  it('a directly constructed DbService is bounded too: the deadline defaults to the statement timeout + 5 s', () => {
    const opts = (d: DbService) => (pool(d) as unknown as { options: { query_timeout: number; statement_timeout: number } }).options;
    expect(opts(service()).query_timeout).toBe(35_000);
    expect(opts(service({ statementTimeoutMs: 1000 })).query_timeout).toBe(6000);
    expect(opts(service({ statementTimeoutMs: 1000, queryTimeoutMs: 1500 })).query_timeout).toBe(1500);
  });
});
