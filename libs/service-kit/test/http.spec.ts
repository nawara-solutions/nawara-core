import { Controller, Get, Module, Param } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken } from '../src/index.js';
import { createTestApp, type TestApp } from './support/app.js';

const current = generateServiceToken();
const previous = generateServiceToken();
const other = generateServiceToken();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    tokens: [
      { caller: 'billing-service', digest: current.digest },
      { caller: 'billing-service', digest: previous.digest },
      { caller: 'accounting-service', digest: other.digest },
    ],
  });
});
afterAll(() => t.app.close());

describe('request and correlation ids', () => {
  it('generates ids, echoes them, and defaults the correlation id to the request id', async () => {
    const r = await request(t.app.getHttpServer()).get('/probe/ok').expect(200);
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.headers['x-correlation-id']).toBe(r.headers['x-request-id']);
  });

  it('propagates a valid inbound id pair and replaces unsafe ones', async () => {
    const ok = await request(t.app.getHttpServer()).get('/probe/ok').set('x-request-id', 'req-abcdef12').set('x-correlation-id', 'corr-abcdef12');
    expect(ok.headers['x-request-id']).toBe('req-abcdef12');
    expect(ok.headers['x-correlation-id']).toBe('corr-abcdef12');
    const bad = await request(t.app.getHttpServer()).get('/probe/ok').set('x-request-id', 'x y\t<script>');
    expect(bad.headers['x-request-id']).not.toContain('script');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('puts the ids on server log lines emitted while handling the request', async () => {
    t.logs.length = 0;
    await request(t.app.getHttpServer()).get('/probe/boom').set('x-request-id', 'req-logline1').set('x-correlation-id', 'corr-logline1').expect(500);
    const line = t.logs.find((l) => l.level === 'error');
    expect(line).toMatchObject({ service: 'probe-service', requestId: 'req-logline1', correlationId: 'corr-logline1' });
  });
});

describe('uniform error model', () => {
  it('passes an HttpException through in the shared shape, with the request id', async () => {
    const r = await request(t.app.getHttpServer()).get('/probe/conflict').expect(409);
    expect(r.body).toEqual({ statusCode: 409, message: 'already exists', error: 'Conflict', requestId: r.headers['x-request-id'] });
  });

  it('passes an additive machine-readable code through untouched, and omits it when the thrower did not supply one', async () => {
    const withCode = await request(t.app.getHttpServer()).get('/probe/conflict-with-code').expect(409);
    expect(withCode.body).toEqual({ statusCode: 409, message: 'already exists', error: 'Conflict', code: 'already_exists', requestId: withCode.headers['x-request-id'] });
    const withoutCode = await request(t.app.getHttpServer()).get('/probe/conflict').expect(409);
    expect(withoutCode.body.code).toBeUndefined();
  });

  it('has a 502 status text entry for provider-facing errors', async () => {
    const r = await request(t.app.getHttpServer()).get('/probe/bad-gateway').expect(502);
    expect(r.body).toEqual({ statusCode: 502, message: 'upstream provider failed', error: 'Bad Gateway', requestId: r.headers['x-request-id'] });
  });

  it('turns an unexpected error into an opaque 500: no message, SQL, constraint name, stack or credential', async () => {
    t.logs.length = 0;
    const r = await request(t.app.getHttpServer()).get('/probe/boom').expect(500);
    expect(r.body).toEqual({ statusCode: 500, message: 'Internal server error', error: 'Internal Server Error', code: 'internal_error', requestId: r.headers['x-request-id'] });
    const body = JSON.stringify(r.body) + JSON.stringify(r.headers);
    for (const s of ['payment_idem_uk', 'hunter2', 'postgres://', 'duplicate key', 'at ']) expect(body).not.toContain(s);
    // the server log gets the failure's facts, never its message (Stage 22 F13): no SQL, constraint name, host or credential
    const logged = JSON.stringify(t.logs);
    expect(logged).toContain('unhandled error');
    for (const s of ['payment_idem_uk', 'hunter2', 'postgres://', 'duplicate key', 'db:5432']) expect(logged).not.toContain(s);
  });

  it('rejects unknown and invalid body fields with a 400 (no client-supplied field is trusted)', async () => {
    const r1 = await request(t.app.getHttpServer()).post('/probe/echo').send({ name: 'a', organizationId: 'x' }).expect(400);
    expect(r1.body.statusCode).toBe(400);
    expect(JSON.stringify(r1.body.message)).toContain('organizationId');
    await request(t.app.getHttpServer()).post('/probe/echo').send({ name: 5 }).expect(400);
    await request(t.app.getHttpServer()).post('/probe/echo').send({ name: 'ok' }).expect(201);
  });

  it('answers malformed JSON with a generic 400 that does not echo the input', async () => {
    const r = await request(t.app.getHttpServer()).post('/probe/echo').set('content-type', 'application/json').send('{"name": "SECRET-FRAGMENT", ');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(JSON.stringify(r.body)).not.toContain('SECRET-FRAGMENT');
  });

  it('rejects a body above the configured limit', async () => {
    const r = await request(t.app.getHttpServer()).post('/probe/echo').send({ name: 'x'.repeat(5000) });
    expect(r.status).toBe(413);
  });
});

describe('health is not readiness', () => {
  it('/health stays 200 while a dependency is down; /ready is 503 and names the failing check only', async () => {
    t.registry.register('database', async () => {
      throw new Error('ECONNREFUSED 10.0.0.5:5432 password=hunter2');
    });
    await request(t.app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
    const r = await request(t.app.getHttpServer()).get('/ready').expect(503);
    expect(r.body).toEqual({ status: 'unavailable', failed: ['database'] });
    expect(JSON.stringify(r.body)).not.toContain('hunter2');
    t.registry.register('database', async () => undefined);
    await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' });
  });

  it('a check that hangs is a failure, not a hung readiness probe', async () => {
    t.registry.register('slow-broker', () => new Promise(() => undefined));
    const started = Date.now();
    const r = await request(t.app.getHttpServer()).get('/ready').expect(503);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.body.failed).toContain('slow-broker');
    t.registry.register('slow-broker', async () => undefined);
  });
});

describe('secure defaults', () => {
  it('sets security headers and does not advertise the framework', async () => {
    const r = await request(t.app.getHttpServer()).get('/probe/ok');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['access-control-allow-origin']).toBeUndefined(); // CORS off by default
  });
});

describe('service authentication', () => {
  const get = (auth?: string) => {
    const r = request(t.app.getHttpServer()).get('/probe/service');
    return auth ? r.set('authorization', auth) : r;
  };

  it('accepts a valid service token and reports WHICH service called', async () => {
    expect((await get(`Bearer ${current.token}`).expect(200)).body).toEqual({ caller: 'billing-service' });
    expect((await get(`Bearer ${other.token}`).expect(200)).body).toEqual({ caller: 'accounting-service' });
  });

  it('supports rotation: both tokens of a caller work', async () => {
    expect((await get(`Bearer ${previous.token}`).expect(200)).body.caller).toBe('billing-service');
  });

  it('refuses missing, malformed, wrong and user-shaped credentials with one identical generic 401', async () => {
    const userJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIiwicm9sZSI6ImFkbWluIn0.c2lnbmF0dXJl'; // an "administrator" user token
    const responses = await Promise.all([get(), get('Basic abc'), get('Bearer'), get('Bearer wrong-token'), get(`Bearer ${userJwt}`), get(`bearer ${current.token}`)]);
    for (const r of responses) {
      expect(r.status).toBe(401);
      expect({ ...r.body, requestId: undefined }).toEqual({ ...responses[0].body, requestId: undefined });
    }
    expect(responses[0].body.message).toBe('Unauthorized');
  });

  it('is deny-by-default when no tokens are configured', async () => {
    const empty = await createTestApp({ tokens: [] });
    await request(empty.app.getHttpServer()).get('/probe/service').set('authorization', `Bearer ${current.token}`).expect(401);
    await empty.app.close();
  });
});

// ── Stage 22 F13: an internal error's MESSAGE never reaches the response or the server log; its facts do ─────────────────────────────
const F13 = {
  host: Object.assign(new Error('connect ECONNREFUSED 10.9.8.7:5432 (host nawara-core-db-F13HOST)'), { code: 'ECONNREFUSED' }),
  path: Object.assign(new Error("ENOENT: no such file or directory, open '/home/ubuntu/nawara-core/F13PATH/recipient.pem'"), { code: 'ENOENT' }),
  sql: Object.assign(new Error('duplicate key value violates unique constraint "f13_idem_uk" for postgres://svc:F13URLPASS@db-F13HOST:5432/app'), { code: '23505' }),
  input: Object.assign(new Error('invalid input syntax for type uuid: "pii-F13USER@example.test"'), { code: '22P02' }),
  secret: new Error('login failed: password=F13PLAINSECRET for user svc'),
  bug: new TypeError("Cannot read properties of undefined (reading 'F13PROP')"),
  string: 'thrown-string-F13STR',
} as const;
const F13_SENTINELS = ['F13HOST', '10.9.8.7', 'F13PATH', '/home/ubuntu', 'f13_idem_uk', 'duplicate key', 'F13URLPASS', 'F13USER', 'F13PLAINSECRET', 'password=', 'F13PROP', 'F13STR'];

@Controller('f13')
class F13Controller {
  @Get(':name') fail(@Param('name') name: keyof typeof F13) {
    throw F13[name];
  }
}
@Module({ controllers: [F13Controller] })
class F13Module {}

describe('Stage 22 F13: internal errors are opaque to the client and logged by their facts only', () => {
  let f: TestApp;
  beforeAll(async () => {
    f = await createTestApp({ extraImports: [F13Module] });
  });
  afterAll(() => f.app.close());

  const cases: [keyof typeof F13, string][] = [
    ['host', 'error=Error code=ECONNREFUSED kind=network_unreachable'],
    ['path', 'error=Error code=ENOENT'],
    ['sql', 'error=Error code=23505'],
    ['input', 'error=Error code=22P02'],
    ['secret', 'error=Error'],
    ['bug', 'error=TypeError'],
    ['string', 'error=unknown'],
  ];
  it.each(cases)('%s: an opaque 500 with the request id; the log line has the facts and the ids, never the message', async (name, failure) => {
    f.logs.length = 0;
    const r = await request(f.app.getHttpServer()).get(`/f13/${name}`).set('x-correlation-id', `corr-f13-${name}`).expect(500);
    expect(r.body).toEqual({ statusCode: 500, message: 'Internal server error', error: 'Internal Server Error', code: 'internal_error', requestId: r.headers['x-request-id'] });
    const raw = F13[name] instanceof Error ? (F13[name] as Error).message : String(F13[name]);
    const response = JSON.stringify(r.body) + JSON.stringify(r.headers);
    const logged = JSON.stringify(f.logs);
    for (const s of [raw, ...F13_SENTINELS]) {
      expect(response).not.toContain(s);
      expect(logged).not.toContain(s);
    }
    const line = f.logs.find((l) => l.msg === 'unhandled error');
    expect(line).toMatchObject({ level: 'error', failure, requestId: r.headers['x-request-id'], correlationId: `corr-f13-${name}` });
    expect(line).not.toHaveProperty('detail');
    expect(line).not.toHaveProperty('message');
  });

  it('public errors are unchanged: status, message and code reach the client, and nothing is logged as unhandled', async () => {
    f.logs.length = 0;
    const conflict = await request(f.app.getHttpServer()).get('/probe/conflict-with-code').expect(409);
    expect(conflict.body).toMatchObject({ statusCode: 409, message: 'already exists', error: 'Conflict', code: 'already_exists' });
    const invalid = await request(f.app.getHttpServer()).post('/probe/echo').set('content-type', 'application/json').send({ name: 42 }).expect(400);
    expect(JSON.stringify(invalid.body.message)).toContain('name');
    const gateway = await request(f.app.getHttpServer()).get('/probe/bad-gateway').expect(502);
    expect(gateway.body).toMatchObject({ statusCode: 502, message: 'upstream provider failed', error: 'Bad Gateway' });
    expect(f.logs.some((l) => l.msg === 'unhandled error')).toBe(false);
  });
});
