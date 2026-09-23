import { createServer, type Server, type Socket } from 'node:net';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbModule, DbService, HealthModule, JsonLogger, configureApp, loadBaseConfig, pgCode, type DbOptions } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 14.4: the database runtime limits are real, not just configuration. Each protection is driven against a real PostgreSQL
 * (or a real socket that never answers) and must end in a BOUNDED, explicit failure that leaves the process and the pool usable.
 * Margins are deliberately generous: every assertion is "well under the unprotected outcome", never a tight timing window.
 */
describeWithEnv('database runtime limits (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  const services: DbService[] = [];
  const svc = (opts: Omit<DbOptions, 'url'> & { url?: string }) => {
    const s = new DbService({ url: db.url, ...opts });
    services.push(s);
    return s;
  };
  const elapsed = async (fn: () => Promise<unknown>) => {
    const start = Date.now();
    let error: unknown;
    try {
      await fn();
    } catch (e) {
      error = e;
    }
    return { ms: Date.now() - start, error };
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'dbresil');
    const setup = new DbService({ url: db.url });
    await setup.query('CREATE TABLE t_resil(id int PRIMARY KEY)');
    await setup.onApplicationShutdown();
  });
  afterAll(async () => {
    for (const s of services) await s.onApplicationShutdown().catch(() => undefined);
    await db.drop();
  });

  it('statement timeout: PostgreSQL cancels a long statement (57014), and the pool stays usable', async () => {
    const s = svc({ statementTimeoutMs: 1000 });
    const r = await elapsed(() => s.query('SELECT pg_sleep(20)'));
    expect(pgCode(r.error)).toBe('57014'); // query_canceled: statement timeout
    expect(r.ms).toBeLessThan(10_000); // bounded far below the 20 s the statement asked for
    expect((await s.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  });

  it('statement timeout inside a transaction rolls the whole transaction back', async () => {
    const s = svc({ statementTimeoutMs: 1000 });
    const r = await elapsed(() =>
      s.tx(async (q) => {
        await q.query('INSERT INTO t_resil VALUES (1)');
        await q.query('SELECT pg_sleep(20)');
      }),
    );
    expect(pgCode(r.error)).toBe('57014');
    expect((await s.query('SELECT count(*)::int AS n FROM t_resil WHERE id = 1')).rows[0].n).toBe(0);
  });

  it('pool exhaustion: a caller waits a BOUNDED time for a client, then fails explicitly; the pool recovers', async () => {
    const s = svc({ max: 1, connectionTimeoutMs: 500 });
    let releaseHolder!: () => void;
    const held = new Promise<void>((r) => (releaseHolder = r));
    const holder = s.tx(async () => held); // occupies the only connection
    await new Promise((r) => setTimeout(r, 200));
    const r = await elapsed(() => s.query('SELECT 1'));
    expect((r.error as Error).message).toMatch(/timeout exceeded when trying to connect/);
    expect(r.ms).toBeLessThan(5_000); // unprotected, this waited until the holder finished (here: forever)
    releaseHolder();
    await holder;
    expect((await s.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  });

  it('idle in transaction: PostgreSQL ends the session (25P03), the transaction fails and rolls back, the process survives, the pool recovers', async () => {
    const s = svc({ idleInTransactionTimeoutMs: 1000 });
    const r = await elapsed(() =>
      s.tx(async (q) => {
        await q.query('INSERT INTO t_resil VALUES (2)');
        await new Promise((res) => setTimeout(res, 4000)); // the application stalls with the transaction open
        await q.query('SELECT 1');
      }),
    );
    // Before Stage 14.4 the terminated, checked-out client's 'error' event had no listener and crashed the process: this test
    // itself would not have been able to report anything.
    expect(r.error).toBeDefined();
    expect((await s.query('SELECT count(*)::int AS n FROM t_resil WHERE id = 2')).rows[0].n).toBe(0); // nothing committed
    expect((await s.query('SELECT 1 AS ok')).rows[0].ok).toBe(1); // a fresh connection replaced the destroyed one
  });

  it('a database that never answers: connecting fails within the connection timeout instead of hanging', async () => {
    const sockets = new Set<Socket>();
    const silent: Server = createServer((sock) => {
      sockets.add(sock); // accept the TCP connection, never speak the PostgreSQL protocol
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as { port: number }).port;
    try {
      const s = svc({ url: `postgres://nobody:nothing@127.0.0.1:${port}/none`, connectionTimeoutMs: 1000 });
      const r = await elapsed(() => s.query('SELECT 1'));
      expect(r.error).toBeDefined();
      expect(r.ms).toBeLessThan(5_000);
    } finally {
      for (const sock of sockets) sock.destroy();
      await new Promise((r) => silent.close(r));
    }
  });

  it('/ready stays bounded (503) while the pool is exhausted, and /health stays 200', async () => {
    const config = loadBaseConfig('probe-service', { NODE_ENV: 'test' });
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule.forRoot({ checkTimeoutMs: 1500 }), DbModule.forRoot({ url: db.url, max: 1, connectionTimeoutMs: 500 })],
    }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    configureApp(app, config, new JsonLogger('probe-service', 'error', () => undefined));
    await app.init();
    try {
      const dbs = app.get(DbService);
      let releaseHolder!: () => void;
      const held = new Promise<void>((r) => (releaseHolder = r));
      const holder = dbs.tx(async () => held);
      await new Promise((r) => setTimeout(r, 200));
      const start = Date.now();
      const ready = await request(app.getHttpServer()).get('/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({ status: 'unavailable', failed: ['database'] });
      expect(Date.now() - start).toBeLessThan(5_000);
      await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
      releaseHolder();
      await holder;
      await request(app.getHttpServer()).get('/ready').expect(200);
    } finally {
      await app.close();
    }
  });
});
