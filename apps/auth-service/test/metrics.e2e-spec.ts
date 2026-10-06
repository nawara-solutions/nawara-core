import { randomUUID } from 'node:crypto';
import { MetricsHost } from '@nawara/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestCtx } from './helpers/app.js';

/**
 * V2 A12.2: auth-service's explicit metrics wiring (it builds its HTTP pipeline itself, so main.ts calls the kit's installMetrics at
 * the point configureApp does). Off by default; when on, the metrics live on their own listener only (never under the routed
 * /auth prefix), the public /auth/health probe is unchanged and excluded, and no request value reaches the exposition.
 */
let on: TestCtx;
let off: TestCtx;
const email = `seeded.metrics.${randomUUID().slice(0, 8)}@example.org`;
const ids = { request: 'req-auth-seeded-4d1c', correlation: 'corr-auth-seeded-9e07' };

async function scrape(t: TestCtx): Promise<string> {
  const addr = await t.app.get(MetricsHost).address();
  if (!addr) throw new Error('the metrics listener is not running');
  return (await fetch(`http://127.0.0.1:${addr.port}/metrics`)).text();
}

beforeAll(async () => {
  on = await createTestApp({ METRICS_ENABLED: 'true', METRICS_PORT: '0' });
  off = await createTestApp();
  await on.http.post('/auth/login').set('x-request-id', ids.request).set('x-correlation-id', ids.correlation).send({ email, password: 'not the password at all' });
  await on.http.get(`/auth/organizations/${randomUUID()}/members`);
});
afterAll(async () => {
  await on?.close();
  await off?.close();
});

describe('auth-service metrics (V2 A12.2)', () => {
  it('is off by default: no metrics, no listener', async () => {
    expect(off.app.get(MetricsHost).metrics).toBeUndefined();
    expect(await off.app.get(MetricsHost).address()).toBeUndefined();
  });

  it('/auth/health is unchanged (same status and body with metrics on and off) and is not an HTTP metric', async () => {
    const a = await on.http.get('/auth/health');
    const b = await off.http.get('/auth/health');
    expect({ status: a.status, body: a.body }).toEqual({ status: b.status, body: b.body });
    expect(a.body).toEqual({ status: 'ok' });
    expect(await scrape(on)).not.toMatch(/route="\/auth\/health"/);
  });

  it('no metrics endpoint on the application port, not under /auth', async () => {
    for (const p of ['/metrics', '/auth/metrics']) {
      const r = await on.http.get(p);
      expect(r.status, p).toBe(404);
      expect(r.text, p).not.toContain('nawara_');
    }
  });

  it('records route templates only: no email, identifier or request id in the exposition', async () => {
    const body = await scrape(on);
    expect(body).toMatch(/nawara_http_server_requests_total\{method="POST",route="\/auth\/login",status_class="4xx"\} 1/);
    expect(body).toContain('nawara_service_info{service="auth-service"} 1');
    for (const v of [email, ids.request, ids.correlation, 'not the password']) expect(body).not.toContain(v);
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('readiness metrics follow the kit /ready probe (database, migrations) without running it', async () => {
    await on.http.get('/ready').expect(200);
    const body = await scrape(on);
    expect(body).toMatch(/^nawara_readiness_ready 1$/m);
    expect(body).toMatch(/^nawara_readiness_check_up\{check="database"\} 1$/m);
    expect(body).toMatch(/^nawara_readiness_check_up\{check="migrations"\} 1$/m);
  });

  it('V2 A12.3: the Auth pool (behind the kit DbService token) and its central-audit outbox relay feed the passive metrics', async () => {
    const body = await (async () => {
      const end = Date.now() + 10_000;
      for (;;) {
        const b = await scrape(on);
        if (/^nawara_outbox_stats_timestamp_seconds \d/m.test(b) || Date.now() > end) return b;
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    expect(body).toMatch(/^nawara_db_pool_max_connections\{pool="main"\} 10$/m);
    expect(body).toMatch(/^nawara_db_pool_connections\{pool="main"\} \d+$/m);
    expect(body).toMatch(/^nawara_db_pool_waiting_clients\{pool="main"\} \d+$/m);
    expect(body).toMatch(/^nawara_outbox_pending_events \d+$/m);
    expect(body).toMatch(/^nawara_outbox_stats_timestamp_seconds \d/m);
    // the in-memory test bus has no observer hook: no publish metrics, and nothing breaks
    expect(body).not.toContain('nawara_events_published_total{');
  });

  it('the listener binds loopback by default', async () => {
    expect((await on.app.get(MetricsHost).address())?.address).toBe('127.0.0.1');
  });
});
