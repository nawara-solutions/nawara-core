import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/app.js';
import { METRICS_ON, MetricsProbeModule, scrape, seriesOf } from './support/metrics.js';

/** Auth's own probe route, reproduced: it must be excluded from HTTP metrics by its template. */
@Controller('auth')
class AuthHealthLike {
  @Get('health') health(@Res({ passthrough: true }) res: Response) {
    res.status(200);
    return { status: 'ok' };
  }
}

let t: TestApp;
const series = async () => seriesOf(await scrape(t.app), 'nawara_http_server_requests_total');
const has = async (labels: Record<string, string>) => expect(await series()).toContainEqual(labels);

beforeAll(async () => {
  t = await createTestApp({ env: METRICS_ON, extraImports: [MetricsProbeModule, { module: class AuthLikeModule {}, controllers: [AuthHealthLike] }] });
});
afterAll(() => t.app.close());

describe('HTTP metrics labels (V2 A12.2)', () => {
  it('a normal matched request: method, template, 2xx', async () => {
    await request(t.app.getHttpServer()).get('/probe/ok').expect(200);
    await has({ method: 'GET', route: '/probe/ok', status_class: '2xx' });
  });

  it('a guard refusal is recorded under its template', async () => {
    await request(t.app.getHttpServer()).get('/probe/service').expect(401);
    await has({ method: 'GET', route: '/probe/service', status_class: '4xx' });
  });

  it('a pipe refusal is recorded under its template', async () => {
    await request(t.app.getHttpServer()).post('/probe/echo').send({ name: 1 }).expect(400);
    await has({ method: 'POST', route: '/probe/echo', status_class: '4xx' });
  });

  it('an unknown path is __unmatched__', async () => {
    await request(t.app.getHttpServer()).get('/nowhere/0b6f2c1e').expect(404);
    await has({ method: 'GET', route: '__unmatched__', status_class: '4xx' });
  });

  it('a thrown error is 5xx under its template', async () => {
    await request(t.app.getHttpServer()).get('/probe/boom').expect(500);
    await has({ method: 'GET', route: '/probe/boom', status_class: '5xx' });
  });

  it('a tokenized path is recorded as its template, never the token', async () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.dG9rZW4tdmFsdWU.c2ln';
    await request(t.app.getHttpServer()).get(`/m/t/${token}`).expect(200);
    await has({ method: 'GET', route: '/m/t/:token', status_class: '2xx' });
    expect(await scrape(t.app)).not.toContain(token);
  });

  it('a method outside the closed set is "other"', async () => {
    const port = (t.app.getHttpServer().address() as AddressInfo).port;
    await new Promise<void>((resolve) => httpRequest({ host: '127.0.0.1', port, method: 'PURGE', path: '/probe/ok' }, (res) => res.resume().on('end', resolve)).end());
    await has({ method: 'other', route: '__unmatched__', status_class: '4xx' });
  });

  it('an aborted request is counted once, as aborted, and in-flight returns to zero', async () => {
    const port = (t.app.getHttpServer().address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/m/slow' });
      req.on('error', () => resolve());
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 100);
    });
    await new Promise((r) => setTimeout(r, 500));
    const body = await scrape(t.app);
    expect(seriesOf(body, 'nawara_http_server_requests_total')).toContainEqual({ method: 'GET', route: '/m/slow', status_class: 'aborted' });
    expect(body).toMatch(/^nawara_http_server_requests_total\{method="GET",route="\/m\/slow",status_class="aborted"\} 1$/m);
    expect(body).toMatch(/^nawara_http_server_requests_in_flight 0$/m);
  });

  it('records a duration histogram with the same labels', async () => {
    const body = await scrape(t.app);
    expect(seriesOf(body, 'nawara_http_server_request_duration_seconds_count')).toContainEqual({ method: 'GET', route: '/probe/ok', status_class: '2xx' });
    expect(body).toMatch(/nawara_http_server_request_duration_seconds_bucket\{le="60",method="GET",route="\/probe\/ok",status_class="2xx"\}/);
  });
});

describe('hostile request targets (V2 A12.2a, promoted from the security review)', () => {
  const raw = (target: string) =>
    new Promise<number>((resolve) => {
      const port = (t.app.getHttpServer().address() as AddressInfo).port;
      httpRequest({ host: '127.0.0.1', port, path: target }, (res) => res.resume().on('end', () => resolve(res.statusCode ?? 0))).end();
    });

  it('an encoded slash, unicode and malformed percent-encoding are recorded as the template or __unmatched__, never as the raw target', async () => {
    expect(await raw('/m/t/ENCODED%2FSLASHMARKER')).toBe(200);
    expect(await raw(`/m/t/${encodeURIComponent('ÜNÏCÖDEMARKER')}`)).toBe(200);
    expect(await raw('/m/t/MALFORMEDMARKER%ZZ')).toBe(400);
    expect(await raw('/m/t/%E0%A4%A')).toBe(400);
    const body = await scrape(t.app);
    for (const marker of ['MARKER', '%2F', '%ZZ', '%E0', 'Ü']) expect(body, marker).not.toContain(marker);
    const routes = new Set((await series()).map((s) => s.route));
    for (const r of routes) expect(['/probe/ok', '/probe/service', '/probe/echo', '/probe/boom', '/m/t/:token', '/m/slow', '/m/moved/:id', '__unmatched__']).toContain(r);
    await has({ method: 'GET', route: '/m/t/:token', status_class: '2xx' });
  });

  it('a redirect is recorded under its template as 3xx', async () => {
    expect(await raw('/m/moved/0b6f2c1e-4a8e-4f57-9d55-3f0d6e3a1b22')).toBe(302);
    await has({ method: 'GET', route: '/m/moved/:id', status_class: '3xx' });
    expect(await scrape(t.app)).not.toContain('0b6f2c1e');
  });

  it('the HTTP metrics middleware sits right after the request-context middleware (configureApp order)', () => {
    const names = (t.app.getHttpAdapter().getInstance() as { router: { stack: Array<{ name: string; route?: unknown }> } }).router.stack
      .filter((l) => !l.route)
      .map((l) => l.name);
    const i = names.indexOf('requestContextMiddleware');
    expect(i).toBeGreaterThan(-1);
    expect(names[i + 1]).toBe('httpMetrics');
    expect(names[i + 2]).toBe('helmetMiddleware');
  });
});

describe('probe routes and /metrics are not HTTP metrics', () => {
  it('/health, /ready and /auth/health are excluded', async () => {
    const http = request(t.app.getHttpServer());
    await http.get('/health').expect(200);
    await http.get('/ready');
    await http.get('/auth/health').expect(200);
    const routes = (await series()).map((s) => s.route);
    for (const p of ['/health', '/ready', '/auth/health']) expect(routes).not.toContain(p);
  });

  it('scraping /metrics (on its own listener) adds no HTTP series', async () => {
    const before = JSON.stringify(await series());
    await scrape(t.app);
    await scrape(t.app);
    expect(JSON.stringify(await series())).toBe(before);
  });
});
