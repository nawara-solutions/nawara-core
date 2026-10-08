import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, inject, it } from 'vitest';
import { createTestApp } from './helpers/app.js';

/**
 * V2 A4.4 (A4 record §8): Auth's HTTP bootstrap as a process: the BUILT `dist/main.js`, exactly as the image starts it (Core CI builds
 * the service before its integration tests). The expectations were observed on the bootstrap before A4.4 and must hold after it; the
 * approved changes (no CORS when no origin is configured, BODY_LIMIT_KB) are in their own block.
 */
const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const ALLOWED = 'https://admin.example.test';
const DOCS_PASSWORD = 'docs-password-0123456789';
const JSON_HEADERS = { 'content-type': 'application/json' };
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };
const key = () => randomBytes(32).toString('base64');
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number };
    s.close(() => resolve(port));
  });
});

const created: string[] = [];
const running: ChildProcess[] = [];
const adminUrl = () => inject('pgAdminUrl');
async function database(): Promise<string> {
  const name = `boot_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const a = new pg.Client({ connectionString: adminUrl() });
  await a.connect();
  await a.query(`CREATE DATABASE ${name} TEMPLATE ${inject('pgTemplate')}`);
  await a.end();
  created.push(name);
  return adminUrl().replace(/\/[^/]*$/, `/${name}`);
}
afterEach(async () => {
  for (const c of running.splice(0)) if (c.exitCode === null && c.signalCode === null) { c.kill('SIGKILL'); await new Promise((r) => c.once('exit', r)); }
});
afterAll(async () => {
  const a = new pg.Client({ connectionString: adminUrl() });
  await a.connect();
  for (const n of created) await a.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
  await a.end();
});

/** Starts dist/main.js with a complete test configuration plus `extra`, and waits until /auth/health answers. */
async function start(extra: Record<string, string> = {}) {
  const port = await freePort();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', NODE_ENV: 'test', PORT: String(port), DATABASE_URL: await database(), LOG_LEVEL: 'error', BCRYPT_COST: '4', AUTH_EVENTS: 'off',
    JWT_SECRET: key(), OPERATOR_CODE_PEPPER: key(), SECRET_KEY_PEPPER: key(), THROTTLE_KEY_PEPPER: key(), JOIN_CODE_PEPPER: key(),
    TOTP_ENCRYPTION_KEYS: `k1:${key()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', ...extra,
  };
  const child = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.push(child);
  let output = '';
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/auth/health`)).status) break;
    } catch {
      if (i > 200 || child.exitCode !== null) throw new Error(`auth-service did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { base, child, output: () => output };
}
const login = (base: string, headers: Record<string, string>, body: string) => fetch(`${base}/auth/login`, { method: 'POST', headers, body });
const credentials = (password: string) => JSON.stringify({ email: 'nobody@example.test', password });
const envelope = async (res: Response) => {
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.requestId).toBe(res.headers.get('x-request-id'));
  const { requestId: _requestId, ...rest } = body;
  return rest;
};

describe('V2 A4.4: characterization of the Auth HTTP bootstrap (unchanged by the configureApp convergence)', () => {
  it('/auth/health answers 200 {status:"ok"} with helmet\'s headers and a request id; an id the client sends is echoed', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/auth/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok' });
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(r.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(r.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await fetch(`${base}/auth/health`, { headers: { 'x-request-id': 'req-a44-characterization' } });
    expect(echoed.headers.get('x-request-id')).toBe('req-a44-characterization');
  });

  it('error envelopes: unknown route 404, invalid credentials 401 (with its code), all with helmet headers', async () => {
    const { base } = await start();
    const notFound = await fetch(`${base}/auth/nope`);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await envelope(notFound)).toEqual({ statusCode: 404, message: 'Cannot GET /auth/nope', error: 'Not Found' });
    const denied = await login(base, JSON_HEADERS, credentials('pw-1234567'));
    expect(denied.status).toBe(401);
    expect(await envelope(denied)).toEqual({ statusCode: 401, message: 'Invalid credentials.', error: 'Unauthorized', code: 'invalid_credentials' });
  });

  it.each([
    ['en', 'property extra should not exist'],
    ['fr', 'la propriété extra ne doit pas être présente'],
    ['ar', 'يجب ألا تكون الخاصية extra موجودة'],
  ])('validation errors are localized (%s), with code validation_error and Content-Language', async (language, message) => {
    const { base } = await start();
    const r = await login(base, { ...JSON_HEADERS, 'accept-language': language }, JSON.stringify({ email: 'a@example.test', password: 'pw-1234567', extra: 1 }));
    expect(r.status).toBe(400);
    expect(r.headers.get('content-language')).toBe(language);
    expect(await envelope(r)).toEqual({ statusCode: 400, message: [message], error: 'Bad Request', code: 'validation_error' });
  });

  it('CORS with configured origins: the allowed origin is echoed (no credentials), a foreign one is not; preflight answers 204', async () => {
    const { base } = await start({ CORS_ORIGINS: ALLOWED });
    const allowed = await fetch(`${base}/auth/health`, { headers: { origin: ALLOWED } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
    const foreign = await fetch(`${base}/auth/health`, { headers: { origin: 'https://evil.example.test' } });
    expect(foreign.status).toBe(200);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${base}/auth/login`, {
      method: 'OPTIONS', headers: { origin: ALLOWED, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET,HEAD,PUT,PATCH,POST,DELETE');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type,authorization');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('OD-A4.4-1: a body that cannot be parsed is refused WITH the allowed origin\'s CORS headers (malformed 400, oversized 413)', async () => {
    const { base } = await start({ CORS_ORIGINS: ALLOWED });
    const malformed = await login(base, { ...JSON_HEADERS, origin: ALLOWED }, '{"email":');
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(await envelope(malformed)).toEqual({ statusCode: 400, message: 'Unexpected end of JSON input', error: 'Bad Request' });
    const oversized = await login(base, { ...JSON_HEADERS, origin: ALLOWED }, credentials('x'.repeat(101 * 1024)));
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(await envelope(oversized)).toEqual({ statusCode: 413, message: 'Payload Too Large', error: 'Payload Too Large' });
    const form = await login(base, { ...FORM_HEADERS, origin: ALLOWED }, `email=a%40example.test&password=${'x'.repeat(101 * 1024)}`);
    expect(form.status).toBe(413);
    expect(form.headers.get('access-control-allow-origin')).toBe(ALLOWED);
  });

  it('JSON and (OD-A4.4-2) URL-encoded bodies are parsed, each up to 100 KB', async () => {
    const { base } = await start();
    const json = await login(base, JSON_HEADERS, credentials('x'.repeat(100 * 1024 - 60))); // parsed: refused by validation, not by size
    expect(json.status).toBe(400);
    expect(await envelope(json)).toEqual({ statusCode: 400, message: ['password must be shorter than or equal to 72 characters'], error: 'Bad Request', code: 'validation_error' });
    const form = await login(base, FORM_HEADERS, 'email=a%40example.test&password=pw-1234567');
    expect(form.status).toBe(401);
    expect(await envelope(form)).toEqual({ statusCode: 401, message: 'Invalid credentials.', error: 'Unauthorized', code: 'invalid_credentials' });
    const nested = await login(base, FORM_HEADERS, 'email=a%40example.test&password=pw-1234567&extra[a]=1'); // extended parsing: an object
    expect(nested.status).toBe(400);
    expect(await envelope(nested)).toMatchObject({ code: 'validation_error', message: ['property extra should not exist'] });
    const bigForm = await login(base, FORM_HEADERS, `email=a%40example.test&password=${'x'.repeat(100 * 1024 - 60)}`);
    expect(bigForm.status).toBe(400);
    expect((await bigForm.json()).code).toBe('validation_error');
    expect((await login(base, FORM_HEADERS, `email=a%40example.test&password=${'x'.repeat(101 * 1024)}`)).status).toBe(413);
  });

  it.each([['0', [401, 429]], ['1', [401, 401]]] as const)(
    'TRUST_PROXY_HOPS=%s decides whether X-Forwarded-For is the client address (one login per IP)',
    async (hops, statuses) => {
      const { base } = await start({ TRUST_PROXY_HOPS: hops, RATE_LOGIN_IP_LIMIT: '1' });
      const seen: number[] = [];
      for (const ip of ['198.51.100.1', '198.51.100.2']) seen.push((await login(base, { ...JSON_HEADERS, 'x-forwarded-for': ip }, credentials('pw-1234567'))).status);
      expect(seen).toEqual(statuses);
    },
  );

  it('the pipeline also sets Express\'s own trust proxy to TRUST_PROXY_HOPS (the Express default, false, at 0): nothing reads req.ip today, kept for defence in depth', async () => {
    for (const [hops, expected] of [['2', 2], ['0', false]] as const) {
      const ctx = await createTestApp({ TRUST_PROXY_HOPS: hops });
      try {
        expect(ctx.app.getHttpAdapter().getInstance().get('trust proxy'), `TRUST_PROXY_HOPS=${hops}`).toBe(expected);
      } finally {
        await ctx.close();
      }
    }
  });

  it('metrics are served only on their own port, never on the service port', async () => {
    const metricsPort = await freePort();
    const { base } = await start({ METRICS_ENABLED: 'true', METRICS_PORT: String(metricsPort) });
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).status).toBe(200);
  });

  it('API docs: absent without SWAGGER_PASSWORD; otherwise /auth/docs and /auth/docs-json behind Basic auth (realm "auth-service docs")', async () => {
    const closed = await start();
    expect((await fetch(`${closed.base}/auth/docs`)).status).toBe(404);
    expect((await fetch(`${closed.base}/auth/docs-json`)).status).toBe(404);
    const { base } = await start({ SWAGGER_PASSWORD: DOCS_PASSWORD });
    for (const path of ['/auth/docs', '/auth/docs-json']) {
      const anonymous = await fetch(`${base}${path}`);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get('www-authenticate')).toBe('Basic realm="auth-service docs", charset="UTF-8"');
      const wrong = await fetch(`${base}${path}`, { headers: { authorization: `Basic ${Buffer.from('docs:wrong-password').toString('base64')}` } });
      expect(wrong.status).toBe(401);
    }
    const auth = { authorization: `Basic ${Buffer.from(`docs:${DOCS_PASSWORD}`).toString('base64')}` };
    const ui = await fetch(`${base}/auth/docs`, { headers: auth });
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain('Swagger UI');
    const json = await fetch(`${base}/auth/docs-json`, { headers: auth });
    expect(json.status).toBe(200);
    expect(((await json.json()) as { openapi: string; info: { title: string } })).toMatchObject({ openapi: '3.0.0', info: { title: 'auth-service API' } });
  });

  it('SIGTERM shuts the process down promptly (Nest\'s shutdown hooks, then the signal)', async () => {
    const { child } = await start();
    const started = Date.now();
    child.kill('SIGTERM');
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((r) => child.once('exit', (c, s) => r([c, s])));
    expect({ code, signal }).toEqual({ code: null, signal: 'SIGTERM' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('a configuration error stops the process before it listens, naming the variable', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', PORT: String(port), DATABASE_URL: 'postgres://x' }, stdio: ['ignore', 'pipe', 'pipe'] });
    running.push(child);
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += d));
    const code = await new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    expect(code).not.toBe(0);
    expect(stderr).toContain('JWT_SECRET is required');
  });
});

describe('V2 A4.4: approved changes', () => {
  it('OD-A4.4-3: with no CORS_ORIGINS there is no CORS at all (the former bootstrap answered Access-Control-Allow-Origin: *)', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/auth/health`, { headers: { origin: 'https://evil.example.test' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${base}/auth/login`, { method: 'OPTIONS', headers: { origin: 'https://evil.example.test', 'access-control-request-method': 'POST' } });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(preflight.headers.get('access-control-allow-methods')).toBeNull();
  });

  it('OD-A4.4-4: BODY_LIMIT_KB bounds both JSON and URL-encoded bodies (413, with the error envelope)', async () => {
    const { base } = await start({ BODY_LIMIT_KB: '2' });
    const json = await login(base, JSON_HEADERS, credentials('x'.repeat(3 * 1024)));
    expect(json.status).toBe(413);
    expect(await envelope(json)).toEqual({ statusCode: 413, message: 'Payload Too Large', error: 'Payload Too Large' });
    expect((await login(base, FORM_HEADERS, `email=a%40example.test&password=${'x'.repeat(3 * 1024)}`)).status).toBe(413);
    expect((await login(base, JSON_HEADERS, credentials('pw-1234567'))).status).toBe(401); // under the limit: parsed
  });
});
