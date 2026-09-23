import { afterEach, describe, expect, it } from 'vitest';
import { DbService } from '../src/db/db.service.js';
import { createTestApp, type TestCtx } from './helpers/app.js';

/**
 * Stage 13.2: the kit's root GET /health (pure liveness) and GET /ready (ReadinessRegistry) are ADDITIVE — the
 * existing GET /auth/health that production deploy tooling, Docker Compose and CI already poll is unchanged.
 */
describe('health, readiness and graceful shutdown', () => {
  let t: TestCtx | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it('GET /health is pure liveness: 200 {status: ok} with no dependency check at all', async () => {
    t = await createTestApp();
    const r = await t.http.get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok' });
  });

  it('GET /ready is 200 {status: ready} when the database is reachable, and the only registered check is "database"', async () => {
    t = await createTestApp();
    const r = await t.http.get('/ready');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ready' });
  });

  it('GET /ready fails closed with 503 naming exactly "database" and "migrations" (which cannot be confirmed either; Stage 14.5) when the database is unreachable, while /health stays 200 and RabbitMQ is never a dependency', async () => {
    t = await createTestApp({ AUTH_EVENTS: 'off', DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' });
    const health = await t.http.get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });

    const ready = await t.http.get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: 'unavailable', failed: ['database', 'migrations'] });
  });

  it('GET /ready leaks no host, credential or SQL text when the database is unreachable', async () => {
    t = await createTestApp({ DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' });
    const r = await t.http.get('/ready');
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toMatch(/nobody|nothing|127\.0\.0\.1|ECONNREFUSED|SELECT/i);
  });

  it('GET /auth/health is byte-identical to before Stage 13.2: 200 {status: ok} when the database is reachable', async () => {
    t = await createTestApp();
    const r = await t.http.get('/auth/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok' });
  });

  it('GET /auth/health is byte-identical to before Stage 13.2 when the database is unreachable: 503 {status: unavailable}, no error text', async () => {
    t = await createTestApp({ DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' });
    const r = await t.http.get('/auth/health');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ status: 'unavailable' });
  });

  it('graceful shutdown: signal hooks are installed (app.enableShutdownHooks(), main.ts), and closing the app actually closes the database pool', async () => {
    const before = process.listenerCount('SIGTERM');
    t = await createTestApp();
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(before);

    const dbService = t.app.get(DbService);
    await dbService.query('SELECT 1'); // the pool is live before shutdown

    await t.close();
    await expect(dbService.query('SELECT 1')).rejects.toThrow(/pool/i); // and refuses queries after
    expect(process.listenerCount('SIGTERM')).toBe(before); // Nest unsubscribes its signal handlers on close()
    t = undefined; // already closed above; afterEach must not close it a second time
  });
});
