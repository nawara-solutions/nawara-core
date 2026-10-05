import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JsonLogger, MetricsHost, installMetrics, loadBaseConfig } from '../src/index.js';
import { createTestApp, type TestApp } from './support/app.js';
import { METRICS_ON, MetricsProbeModule, allLabelValues, metricsUrl, scrape, seriesOf } from './support/metrics.js';

/**
 * V2 A12.2 negative controls: values a request carries must never reach the metrics exposition, the application port must expose no
 * metrics, the listener binds loopback unless told otherwise, and the series count stays bounded under hostile traffic.
 */
let t: TestApp;

const seeded = {
  uuid: randomUUID(),
  organizationId: `org-${randomUUID()}`,
  email: 'seeded.person+metrics@example.org',
  token: 'eyJhbGciOiJIUzI1NiJ9.c2VlZGVkLXNlY3JldC10aWNrZXQ.c2lnbmF0dXJlLXZhbHVl',
  requestId: 'req-seeded-0c7d1f9a',
  correlationId: 'corr-seeded-5be21d44',
  header: 'x-seeded-header-value-8f2e',
  query: 'seeded-query-term-71aa',
};

beforeAll(async () => {
  t = await createTestApp({ env: METRICS_ON, extraImports: [MetricsProbeModule] });
  const http = request(t.app.getHttpServer());
  await http.get(`/m/orgs/${seeded.organizationId}/members/${seeded.uuid}`).set('x-request-id', seeded.requestId).set('x-correlation-id', seeded.correlationId).expect(200);
  await http.get(`/m/t/${seeded.token}`).set('x-random-header', seeded.header).set('user-agent', `agent ${seeded.email}`).expect(200);
  await http.get(`/m/search?q=${seeded.query}&email=${encodeURIComponent(seeded.email)}`).expect(200);
  await http.get(`/m/orgs/${seeded.organizationId}`).expect(404);
  await http.get(`/${seeded.token}/${seeded.uuid}`).expect(404);
  await http.post('/probe/echo').send({ name: seeded.email, organizationId: seeded.organizationId }).expect(400);
  await http.get('/probe/boom').expect(500);
});
afterAll(() => t.app.close());

describe('no request value reaches the exposition (V2 A12.2)', () => {
  it('none of the seeded identifiers, secrets, headers or query values appears anywhere in /metrics', async () => {
    const body = await scrape(t.app);
    for (const [kind, value] of Object.entries(seeded)) expect(body, kind).not.toContain(value);
    for (const leak of ['hunter2', 'payment_idem_uk', 'postgres://', 'duplicate key', 'seeded']) expect(body).not.toContain(leak);
  });

  it('route labels are declared templates or __unmatched__ only', async () => {
    const routes = new Set(seriesOf(await scrape(t.app), 'nawara_http_server_requests_total').map((s) => s.route));
    expect(routes).toEqual(new Set(['/m/orgs/:organizationId/members/:memberId', '/m/t/:token', '/m/search', '__unmatched__', '/probe/echo', '/probe/boom']));
  });

  it('every label value in the exposition is a closed value (no free text, no identifier shape)', async () => {
    for (const v of allLabelValues(await scrape(t.app))) {
      expect(v, v).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      expect(v, v).not.toContain('@');
    }
  });

  it('the series count stays bounded under 400 randomized hostile requests', async () => {
    const http = request(t.app.getHttpServer());
    const before = seriesOf(await scrape(t.app), 'nawara_http_server_requests_total').length;
    await Promise.all(
      Array.from({ length: 400 }, (_, i) => {
        const id = randomUUID();
        const path = [`/m/orgs/${id}/members/${id}`, `/m/t/${id}`, `/${id}`, `/m/search?q=${id}`][i % 4]!;
        return http.get(path).set('x-request-id', `req-${id}`).set('x-correlation-id', `corr-${id}`);
      }),
    );
    const series = seriesOf(await scrape(t.app), 'nawara_http_server_requests_total');
    expect(series.length).toBeLessThanOrEqual(before + 1);
    expect(series.length).toBeLessThan(12);
  });
});

describe('exposure', () => {
  it('the application port exposes no metrics endpoint (not at the root, not under a routed prefix)', async () => {
    const http = request(t.app.getHttpServer());
    for (const p of ['/metrics', '/auth/metrics', '/probe/metrics']) {
      const r = await http.get(p);
      expect(r.status, p).toBe(404);
      expect(r.text, p).not.toContain('nawara_');
    }
  });

  it('the metrics listener binds loopback by default', async () => {
    expect(t.app.get(MetricsHost).metrics).toBeDefined();
    const addr = await t.app.get(MetricsHost).address();
    expect(addr?.address).toBe('127.0.0.1');
  });

  it('the metrics listener answers /metrics only', async () => {
    const base = await metricsUrl(t.app);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/probe/ok`)).status).toBe(404);
    expect((await fetch(`${base}/metrics/../probe/ok`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(405);
  });

  it('a second installation is refused', () => {
    const config = loadBaseConfig('probe-service', METRICS_ON);
    expect(() => installMetrics(t.app, config, new JsonLogger('probe-service', 'error', () => undefined))).toThrow(/already installed/);
  });
});
