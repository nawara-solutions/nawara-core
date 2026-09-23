import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeFailure } from '@nawara/service-kit';
import { BrokerProxy } from '@nawara/service-kit/testing';
import { DbService } from '../src/db/db.service.js';
import type { AppConfig } from '../src/config/app-config.js';
import { createTestApp, type TestCtx } from './helpers/app.js';

/**
 * Stage 15.2, invariant I9, for Auth's OWN DbService (Auth is the deployed service): a query whose answer never comes must end within
 * DB_QUERY_TIMEOUT_MS, and a transaction whose statement timed out must never be committed later through a reused client. A TCP proxy
 * stalls the server-to-client direction of the established connection (the query reaches PostgreSQL; the answer never arrives).
 */
describe('Auth database: client-side query deadline on a stalled connection', () => {
  let t: TestCtx;
  let proxy: BrokerProxy;
  let viaProxy: string;
  let dbUrl: string;
  const services: DbService[] = [];

  const admin = async (sql: string, params?: unknown[]) => {
    const c = new pg.Client({ connectionString: dbUrl });
    await c.connect();
    try {
      return (await c.query(sql, params)).rows;
    } finally {
      await c.end();
    }
  };
  const service = (db: Partial<AppConfig['db']>) => {
    const cfg = { databaseUrl: viaProxy, db: { poolMax: 1, connectionTimeoutMs: 5000, statementTimeoutMs: 1000, idleInTransactionTimeoutMs: 60_000, ...db } } as AppConfig;
    const s = new DbService(cfg);
    services.push(s);
    return s;
  };
  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return describeFailure(e);
    }
  };

  beforeAll(async () => {
    t = await createTestApp();
    dbUrl = (t.env as { DATABASE_URL: string }).DATABASE_URL;
    await admin('CREATE TABLE validation_marker (id text PRIMARY KEY)');
    const u = new URL(dbUrl);
    proxy = new BrokerProxy({ host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname, port: Number(u.port || 5432) });
    await proxy.start();
    u.hostname = '127.0.0.1';
    u.port = String(proxy.port);
    viaProxy = u.toString();
  });
  afterAll(async () => {
    proxy.thaw();
    for (const s of services) await s.onApplicationShutdown().catch(() => undefined);
    await proxy.sever();
    await admin('DROP TABLE IF EXISTS validation_marker');
    await t.close();
  });

  it('a query fails within DB_QUERY_TIMEOUT_MS instead of waiting for the fault to clear, and the pool recovers', async () => {
    const d = service({ queryTimeoutMs: 1500 });
    await d.query('SELECT 1');
    proxy.freeze();
    const started = Date.now();
    const f = await failure(d.query('SELECT 1'));
    const ms = Date.now() - started;
    proxy.thaw();
    expect(f).toBe('error=Error kind=db_query_timeout');
    expect(ms).toBeGreaterThanOrEqual(1400);
    expect(ms).toBeLessThan(3000);
    await expect(d.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });

  it('a transaction whose statement timed out is not committed later by the next borrower', async () => {
    const d = service({ queryTimeoutMs: 1500 });
    await d.query('SELECT 1');
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    const f = await failure(
      d.tx(async (q) => {
        await q.query('INSERT INTO validation_marker VALUES ($1)', [a]);
        proxy.freeze();
        await q.query('INSERT INTO validation_marker VALUES ($1)', [b]);
      }),
    );
    proxy.thaw();
    expect(f).toBe('error=Error kind=db_query_timeout');
    await d.tx((q) => q.query('INSERT INTO validation_marker VALUES ($1)', [c]));
    const rows = await admin('SELECT id FROM validation_marker WHERE id = ANY($1)', [[a, b, c]]);
    expect(rows.map((r) => r.id)).toEqual([c]);
  });

  it('the deadline defaults to the statement timeout + 5 s when the configuration omits it (direct construction)', () => {
    const d = service({});
    expect((d as unknown as { pool: { options: { query_timeout: number } } }).pool.options.query_timeout).toBe(6000);
    expect((t.app.get(DbService) as unknown as { pool: { options: { query_timeout: number } } }).pool.options.query_timeout).toBe(35_000); // the wired app: default config
  });
});
