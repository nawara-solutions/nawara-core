import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken } from '@nawara/service-kit';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';

/**
 * Stage 18.2: the audit-service foundation, on the REAL application module (plus test-only probe routes, see support/probe.ts): the
 * kit's health / readiness, request and correlation ids, error contract, validation, service authentication, the caller policy (deny
 * by default), log hygiene and bounded HTTP drain. These run without PostgreSQL (an unreachable database URL): the database behaviour
 * is proven against a real PostgreSQL in health and runtime-role specs.
 */
describe('audit-service foundation', () => {
  let t: TestApp;
  const reader = generateServiceToken();
  const denied = generateServiceToken();
  const other = generateServiceToken();
  beforeAll(async () => {
    t = await createTestApp({
      tokens: [{ caller: 'core-reader', digest: reader.digest }, { caller: 'core-admin', digest: denied.digest }],
      policy: JSON.stringify({ callers: {
        'core-reader': { operations: ['read_organization'], categories: ['business'] },
        'core-admin': { operations: ['read_platform'], categories: ['security'] },
      } }),
    });
  });
  afterAll(async () => {
    await t.app.close();
  });
  const server = () => t.app.getHttpServer();

  // --------------------------------------------------------------------------------------------------- health and readiness

  it('/health is the kit liveness contract', async () => {
    await request(server()).get('/health').expect(200, { status: 'ok' });
  });

  it('/ready depends on the database, its migrations, the broker and the ingestion consumer (no Auth, Organization or product check): with none of them it is 503, /health 200', async () => {
    await request(server()).get('/health').expect(200);
    const r = await request(server()).get('/ready').expect(503);
    expect(r.body).toEqual({ status: 'unavailable', failed: ['audit-ingestion', 'database', 'migrations', 'rabbitmq'] });
    expect(JSON.stringify(r.body)).not.toMatch(/nobody|nothing|127\.0\.0\.1|ECONNREFUSED/); // no host, credential or error text
  });

  it('ships only health, readiness and the two read routes (18.6, service token required); never an HTTP ingestion, write or delete route (A16)', async () => {
    const app = await createTestApp({ probes: false });
    try {
      for (const [method, path] of [['get', '/'], ['get', '/audit/records'], ['post', '/audit/records'], ['post', '/audit/events'], ['get', '/audit/records/x'],
        ['delete', '/audit/records/x'], ['post', '/audit/organizations/x/records'], ['delete', '/audit/organizations/x/records'], ['post', '/audit/platform/records'],
        ['put', '/audit/platform/records'], ['get', '/docs'], ['get', '/audit/docs']] as const) {
        await request(app.app.getHttpServer())[method](path).expect(404);
      }
      for (const path of ['/audit/organizations/x/records', '/audit/platform/records']) await request(app.app.getHttpServer()).get(path).expect(401);
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
    expect(JSON.stringify(r.body)).not.toMatch(/s3cr3t|postgres:|ECONNREFUSED|\/srv\/|\.js:|leaked-bearer/);
  });

  it('unknown fields and invalid values are 400; malformed JSON and an oversized JSON body are refused without echo', async () => {
    await request(server()).post('/probe/echo').send({ name: 'ok', isAdmin: true }).expect(400);
    await request(server()).post('/probe/echo').send({ name: 'x'.repeat(21) }).expect(400);
    await request(server()).post('/probe/echo').send({ name: 'fine' }).expect(201, { name: 'fine' });
    const bad = await request(server()).post('/probe/echo').set('content-type', 'application/json').send('{"name": "x"').expect(400);
    expect(JSON.stringify(bad.body)).not.toContain('"name"');
    await request(server()).post('/probe/echo').set('content-type', 'application/json').send(JSON.stringify({ name: 'a'.repeat(200 * 1024) })).expect(413);
  });

  it('the only body parser is the bounded JSON one: a non-JSON body is never parsed into a DTO (no upload, no multipart)', async () => {
    await request(server()).post('/probe/echo').set('content-type', 'application/octet-stream').send(Buffer.alloc(2 * 1024 * 1024)).expect(400); // the DTO sees no body
    await request(server()).post('/probe/echo').set('content-type', 'multipart/form-data; boundary=x').send('--x\r\nContent-Disposition: form-data; name="name"\r\n\r\nok\r\n--x--').expect(400);
  });

  // ------------------------------------------------------------------------------------------ request and correlation ids

  it('generates a request id and a correlation id when none is supplied, and propagates supplied ones into logs', async () => {
    const r = await request(server()).get('/probe/public').expect(200);
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.headers['x-correlation-id']).toBe(r.headers['x-request-id']);
    const e = await request(server()).get('/probe/boom').set('x-request-id', 'req-audit-0001').set('x-correlation-id', 'corr-audit-0001').expect(500);
    expect(e.headers['x-correlation-id']).toBe('corr-audit-0001');
    expect(e.body.requestId).toBe('req-audit-0001');
    expect(t.logs.find((l) => l.requestId === 'req-audit-0001')).toMatchObject({ service: 'audit-service', level: 'error', correlationId: 'corr-audit-0001' });
  });

  it('refuses an unsafe client-supplied id instead of echoing it', async () => {
    const r = await request(server()).get('/probe/public').set('x-request-id', 'bad id\twith;<script>').expect(200);
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ------------------------------------------------------------------------------------- service authentication and policy

  it('a valid service token identifies the calling service', async () => {
    expect((await request(server()).get('/probe/service').set('authorization', `Bearer ${reader.token}`).expect(200)).body).toEqual({ caller: 'core-reader' });
  });

  it.each([
    ['no authorization header', undefined],
    ['a wrong token', 'Bearer not-a-real-token'],
    ['an unregistered service token', `Bearer ${other.token}`],
    ['a non-bearer scheme', `Basic ${Buffer.from('a:b').toString('base64')}`],
    ['a user-shaped JWT', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2ln'],
  ])('a service-only route refuses %s with one generic 401', async (_label, header) => {
    const req = request(server()).get('/probe/service');
    const r = await (header === undefined ? req : req.set('authorization', header)).expect(401);
    expect(r.body.message).toBe('Unauthorized');
  });

  it('the caller identity comes from the token only: a caller header, query or body cannot change it', async () => {
    const r = await request(server()).get('/probe/service?caller=core-admin').set('authorization', `Bearer ${reader.token}`).set('x-caller', 'core-admin').set('x-service-name', 'core-admin').expect(200);
    expect(r.body).toEqual({ caller: 'core-reader' });
  });

  it('the caller policy denies by default: an operation not granted is 403, a granted one passes', async () => {
    await request(server()).get('/probe/policy/read-organization').set('authorization', `Bearer ${reader.token}`).expect(200, { caller: 'core-reader', allowed: 'read_organization' });
    const r = await request(server()).get('/probe/policy/read-organization').set('authorization', `Bearer ${denied.token}`).expect(403); // platform scope does not imply organization scope
    expect(r.body.code).toBe('operation_not_allowed');
  });

  it('no request value can widen what a caller may read: scope, category and organization headers or query are ignored', async () => {
    const r = await request(server()).get('/probe/policy/grants?operations=read_platform&categories=security&organizationId=all')
      .set('authorization', `Bearer ${reader.token}`)
      .set('x-audit-scope', 'platform').set('x-organization-id', '*').set('x-categories', 'security,administrative').set('x-caller', 'core-admin')
      .expect(200);
    expect(r.body).toEqual({ caller: 'core-reader', operations: ['read_organization'], categories: ['business'] });
  });

  it('with no SERVICE_TOKENS (the default) every service-token call is refused: fail closed', async () => {
    const app = await createTestApp();
    try {
      await request(app.app.getHttpServer()).get('/probe/service').set('authorization', `Bearer ${reader.token}`).expect(401);
    } finally {
      await app.app.close();
    }
  });

  // ------------------------------------------------------------------------------------------------------ logging hygiene

  it('structured JSON lines, one service identity, and no token, digest, credential or body in any log line', async () => {
    await request(server()).post('/probe/echo').set('authorization', `Bearer ${reader.token}`).send({ name: 'x'.repeat(21), password: 'hunter2-body-secret' });
    await request(server()).get('/probe/boom').set('authorization', `Bearer ${reader.token}`).set('cookie', 'session=cookie-secret-value');
    await request(server()).get('/probe/service').set('authorization', 'Bearer wrong-token-value');
    await request(server()).get('/probe/public/some-secret-in-a-path-0099').expect(404); // a secret-looking path segment
    expect(t.logs.some((l) => l.msg === 'unhandled error')).toBe(true); // the failure WAS logged: the scan below is not vacuous
    const all = JSON.stringify(ALL_LOGS); // every application's lines (the static Logger follows the last application created)
    for (const secret of [reader.token, reader.digest, denied.token, 'hunter2-body-secret', 'wrong-token-value', 'cookie-secret-value', 's3cr3t-password',
      'leaked-bearer-value', 'some-secret-in-a-path-0099']) {
      expect(all, `log leaked ${secret.slice(0, 8)}…`).not.toContain(secret);
    }
    expect(t.logs.every((l) => l.service === 'audit-service' && typeof l.level === 'string')).toBe(true);
  });

  it('sets secure headers, no framework banner, CORS off by default', async () => {
    const r = await request(server()).get('/probe/public').set('origin', 'https://evil.example').expect(200);
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('audit-service graceful shutdown (Stage 15.5 kit drain)', () => {
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
