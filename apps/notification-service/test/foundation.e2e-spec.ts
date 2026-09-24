import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken } from '@nawara/service-kit';
import { createTestApp, type TestApp } from './support/app.js';

/**
 * Stage 16.3: the notification-service foundation, on the REAL application module (plus test-only probe routes, see
 * support/probe.ts): the kit's health / readiness, request and correlation ids, error contract, validation, service authentication,
 * log hygiene and bounded HTTP drain. No database or broker: the foundation has neither (they arrive in 16.4 / 16.5).
 */
describe('notification-service foundation', () => {
  let t: TestApp;
  const producer = generateServiceToken();
  const other = generateServiceToken();
  beforeAll(async () => {
    t = await createTestApp({ tokens: [{ caller: 'test-producer', digest: producer.digest }] });
  });
  afterAll(async () => {
    await t.app.close();
  });
  const server = () => t.app.getHttpServer();

  // --------------------------------------------------------------------------------------------------- health and readiness

  it('/health is the kit liveness contract', async () => {
    await request(server()).get('/health').expect(200, { status: 'ok' });
  });

  it('/ready is ready with no dependency check: the foundation depends on nothing yet (no database, broker or provider)', async () => {
    await request(server()).get('/ready').expect(200, { status: 'ready' });
  });

  it('exposes no business route and no starter route: the send API is Stage 16.6', async () => {
    const app = await createTestApp({ probes: false });
    try {
      await request(app.app.getHttpServer()).get('/').expect(404);
      for (const path of ['/notification/notifications', '/notification/notifications/x', '/notification/docs']) {
        await request(app.app.getHttpServer()).get(path).expect(404);
      }
      await request(app.app.getHttpServer()).post('/notification/notifications').send({}).expect(404);
      await request(app.app.getHttpServer()).post('/notification/notifications/x/cancel').send({}).expect(404);
    } finally {
      await app.app.close();
    }
  });

  // --------------------------------------------------------------------------------------------------------- error contract

  it('an unknown route is the kit 404 body, with the request id', async () => {
    const r = await request(server()).get('/nothing-here').expect(404);
    expect(r.body).toMatchObject({ statusCode: 404, error: 'Not Found' });
    expect(typeof r.body.requestId).toBe('string');
  });

  it('a known application error passes its stable code through, with the uniform body', async () => {
    const r = await request(server()).get('/probe/known-error').expect(409);
    expect(r.body).toMatchObject({ statusCode: 409, message: 'Not allowed in this state.', error: 'Conflict', code: 'invalid_state_transition' });
  });

  it('an unexpected error is an opaque 500: no message, stack, path or credential reaches the client', async () => {
    const r = await request(server()).get('/probe/boom').expect(500);
    expect(r.body).toMatchObject({ statusCode: 500, message: 'Internal server error', error: 'Internal Server Error' });
    expect(JSON.stringify(r.body)).not.toMatch(/s3cr3t|amqp:|ECONNREFUSED|\/srv\/|\.js:|leaked-bearer/);
  });

  it('unknown fields and invalid values are 400 (no mass assignment); malformed JSON and an oversized body are refused without echo', async () => {
    await request(server()).post('/probe/echo').send({ name: 'ok', isAdmin: true }).expect(400);
    await request(server()).post('/probe/echo').send({ name: 'x'.repeat(21) }).expect(400);
    await request(server()).post('/probe/echo').send({ name: 'fine' }).expect(201, { name: 'fine' });
    const bad = await request(server()).post('/probe/echo').set('content-type', 'application/json').send('{"name": "x"').expect(400);
    expect(JSON.stringify(bad.body)).not.toContain('"name"');
    await request(server()).post('/probe/echo').set('content-type', 'application/json').send(JSON.stringify({ name: 'a'.repeat(200 * 1024) })).expect(413);
  });

  // ------------------------------------------------------------------------------------------ request and correlation ids

  it('generates a request id and a correlation id when none is supplied', async () => {
    const r = await request(server()).get('/probe/public').expect(200);
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.headers['x-correlation-id']).toBe(r.headers['x-request-id']);
  });

  it('propagates supplied ids into the response headers, error bodies and log lines', async () => {
    const r = await request(server()).get('/probe/boom').set('x-request-id', 'req-notif-0001').set('x-correlation-id', 'corr-notif-0001').expect(500);
    expect(r.headers['x-request-id']).toBe('req-notif-0001');
    expect(r.headers['x-correlation-id']).toBe('corr-notif-0001');
    expect(r.body.requestId).toBe('req-notif-0001');
    const line = t.logs.find((l) => l.requestId === 'req-notif-0001');
    expect(line).toMatchObject({ service: 'notification-service', level: 'error', correlationId: 'corr-notif-0001' });
    expect(String(line?.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('refuses an unsafe client-supplied id instead of echoing it', async () => {
    const r = await request(server()).get('/probe/public').set('x-request-id', 'bad id\twith;<script>').expect(200);
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ------------------------------------------------------------------------------------------------- service authentication

  it('a valid service token identifies the calling service', async () => {
    const r = await request(server()).get('/probe/service').set('authorization', `Bearer ${producer.token}`).expect(200);
    expect(r.body).toEqual({ caller: 'test-producer' });
  });

  it.each([
    ['no authorization header', undefined],
    ['a wrong token', 'Bearer not-a-real-token'],
    ['an unregistered service token', `Bearer ${other.token}`],
    ['a non-bearer scheme', `Basic ${Buffer.from('a:b').toString('base64')}`],
  ])('a service-only route refuses %s with one generic 401', async (_label, header) => {
    const req = request(server()).get('/probe/service');
    const r = await (header === undefined ? req : req.set('authorization', header)).expect(401);
    expect(r.body.message).toBe('Unauthorized');
  });

  it('with no SERVICE_TOKENS (the default) every service-token call is refused: fail closed', async () => {
    const app = await createTestApp();
    try {
      await request(app.app.getHttpServer()).get('/probe/service').set('authorization', `Bearer ${producer.token}`).expect(401);
    } finally {
      await app.app.close();
    }
  });

  // ------------------------------------------------------------------------------------------------------ logging hygiene

  it('structured JSON lines, one service identity, and no token, digest, credential or body in any log line', async () => {
    await request(server()).post('/probe/echo').set('authorization', `Bearer ${producer.token}`).send({ name: 'x'.repeat(21), password: 'hunter2-body-secret' });
    await request(server()).get('/probe/boom').set('authorization', `Bearer ${producer.token}`).set('cookie', 'session=cookie-secret-value');
    await request(server()).get('/probe/service').set('authorization', 'Bearer wrong-token-value');
    expect(t.logs.some((l) => l.msg === 'unhandled error')).toBe(true); // the failure WAS logged: the scan below is not vacuous
    const all = JSON.stringify(t.logs);
    for (const secret of [producer.token, producer.digest, 'hunter2-body-secret', 'wrong-token-value', 'cookie-secret-value', 's3cr3t-password', 'leaked-bearer-value']) {
      expect(all, `log leaked ${secret.slice(0, 8)}…`).not.toContain(secret);
    }
    expect(t.logs.every((l) => l.service === 'notification-service' && typeof l.level === 'string')).toBe(true);
  });

  it('sets secure headers, no framework banner, CORS off by default', async () => {
    const r = await request(server()).get('/probe/public').set('origin', 'https://evil.example').expect(200);
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('notification-service graceful shutdown (Stage 15.5 kit drain)', () => {
  it('a request running when shutdown starts completes; new requests and /ready get 503; the close is bounded by HTTP_DRAIN_TIMEOUT_MS', async () => {
    const t = await createTestApp({ env: { HTTP_DRAIN_TIMEOUT_MS: '3000' } });
    await t.app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
    const inFlight = fetch(`${base}/probe/slow`);
    await new Promise((r) => setTimeout(r, 200)); // the slow request is now being handled
    const t0 = Date.now();
    const closing = t.app.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await t.registry.run()).toEqual({ ok: false, failed: ['shutting_down'] });
    const answered = await inFlight;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ done: true });
    await closing;
    expect(Date.now() - t0).toBeLessThan(3_000 + 1_000);
    const lines = t.logs.map((l) => String(l.msg));
    expect(lines.some((m) => m.startsWith('service_shutdown_started'))).toBe(true);
    expect(lines.some((m) => m.startsWith('service_shutdown_complete'))).toBe(true);
  });

  it('a request that outlives the drain bound is cut off: shutdown never waits longer than HTTP_DRAIN_TIMEOUT_MS', async () => {
    const t = await createTestApp({ env: { HTTP_DRAIN_TIMEOUT_MS: '500' } });
    await t.app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
    const inFlight = fetch(`${base}/probe/slow`).then((r) => r.status, () => 'cut');
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await t.app.close();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(400);
    expect(took).toBeLessThan(1_400); // the 1.5 s request did not hold shutdown
    expect(await inFlight).toBe('cut');
    expect(t.logs.some((l) => String(l.msg).startsWith('http_drain_timeout'))).toBe(true);
  });
});
