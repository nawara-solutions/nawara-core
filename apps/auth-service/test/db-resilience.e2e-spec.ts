import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService, pgCode } from '../src/db/db.service.js';
import { createTestApp, type TestCtx } from './helpers/app.js';

/**
 * Stage 14.4: auth-service's own DbService enforces the same bounded database limits as the service-kit, against a real
 * PostgreSQL: a long statement is cancelled, a transaction left idle is ended by the server without crashing the process, and a
 * caller waiting on an exhausted pool fails within the connection timeout. Generous margins; no tight timing windows.
 */
describe('database runtime limits (auth-service, real PostgreSQL)', () => {
  let t: TestCtx;
  let db: DbService;
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
    t = await createTestApp({
      DB_POOL_MAX: '2',
      DB_CONNECTION_TIMEOUT_MS: '500',
      DB_STATEMENT_TIMEOUT_MS: '1000',
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '1000',
    });
    db = t.app.get(DbService);
  });
  afterAll(() => t?.close());

  it('the validated configuration reaches the pool', () => {
    // queryTimeoutMs (Stage 15.2) is derived: the statement timeout + 5 s.
    expect(t.cfg.db).toEqual({ poolMax: 2, connectionTimeoutMs: 500, statementTimeoutMs: 1000, idleInTransactionTimeoutMs: 1000, queryTimeoutMs: 6000 });
  });

  it('statement timeout: PostgreSQL cancels a long statement (57014); the pool stays usable', async () => {
    const r = await elapsed(() => db.query('SELECT pg_sleep(20)'));
    expect(pgCode(r.error)).toBe('57014');
    expect(r.ms).toBeLessThan(10_000);
    expect((await db.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  });

  it('idle in transaction: the server ends the session (25P03); the transaction fails and rolls back, the process survives', async () => {
    const r = await elapsed(() =>
      db.tx(async (q) => {
        await q.query(`INSERT INTO company(id, name) VALUES ('00000000-0000-4000-8000-00000000c0de', 'Idle')`);
        await new Promise((res) => setTimeout(res, 4000));
        await q.query('SELECT 1');
      }),
    );
    expect(r.error).toBeDefined();
    expect((await db.query(`SELECT count(*)::int AS n FROM company WHERE id = '00000000-0000-4000-8000-00000000c0de'`)).rows[0].n).toBe(0);
    expect((await db.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  });

  it('pool exhaustion: a caller fails within the connection timeout instead of waiting forever; the pool recovers', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holders = [db.tx(async () => held), db.tx(async () => held)]; // both connections of a pool of 2
    await new Promise((r) => setTimeout(r, 200));
    const r = await elapsed(() => db.query('SELECT 1'));
    expect((r.error as Error).message).toMatch(/timeout exceeded when trying to connect/);
    expect(r.ms).toBeLessThan(5_000);
    release();
    await Promise.all(holders);
    expect((await db.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  });

  it('GET /auth/health stays bounded (503, same body) while the pool is exhausted; root /health stays 200', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holders = [db.tx(async () => held), db.tx(async () => held)];
    await new Promise((r) => setTimeout(r, 200));
    const start = Date.now();
    await t.http.get('/auth/health').expect(503, { status: 'unavailable' });
    expect(Date.now() - start).toBeLessThan(5_000);
    await t.http.get('/health').expect(200, { status: 'ok' });
    release();
    await Promise.all(holders);
    await t.http.get('/auth/health').expect(200, { status: 'ok' });
  });
});
