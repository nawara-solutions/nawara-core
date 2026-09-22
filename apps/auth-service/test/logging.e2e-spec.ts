import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestCtx } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);

/**
 * Stage 13.2: the real `JsonLogger` wired into main.ts (mirrored in the test harness as `ctx.jsonLogs`) is
 * structured JSON with request/correlation ids, and redacts credential-shaped fields (`libs/service-kit`'s
 * `redact`/`redactString`). These tests prove the SHAPE and prove no plaintext secret from a realistic
 * onboarding/login/error flow ever reaches a log line — not that logging exists (it already did via Nest's
 * own Logger); the property under test is what Stage 13.2 actually changed.
 */
describe('structured logging', () => {
  let t: TestCtx | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it('every JSON log line has the base structured shape: ts, level, service, msg', async () => {
    t = await createTestApp({ DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' });
    // /auth/login is public and queries the database immediately: with the database unreachable this is a
    // genuine unhandled (non-HttpException) error, which is the one path that always logs (Stage 13.2's
    // AuthExceptionFilter only logs >= 500s, by design, so as not to log every routine 4xx).
    const r = await t.http.post('/auth/login').send({ email: 'a@b.test', password: 'x' });
    expect(r.status).toBe(500);

    expect(t.jsonLogs.length).toBeGreaterThan(0);
    for (const line of t.jsonLogs) {
      expect(typeof line.ts).toBe('string');
      expect(typeof line.level).toBe('string');
      expect(line.service).toBe('auth-service');
      expect('msg' in line).toBe(true);
    }
  });

  it('a request-scoped log line carries the same requestId/correlationId as the response', async () => {
    t = await createTestApp({ DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' });
    const r = await t.http.post('/auth/login').send({ email: 'a@b.test', password: 'x' });
    expect(r.status).toBe(500);
    expect(r.body.requestId).toBeDefined();
    const scoped = t.jsonLogs.filter((l) => l.requestId !== undefined);
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.some((l) => l.requestId === r.body.requestId && typeof l.correlationId === 'string')).toBe(true);
  });

  it('a realistic owner bootstrap+login+refresh+bad-login flow never logs a raw password, TOTP secret, access token or refresh token', async () => {
    t = await createTestApp();
    const companyId = await t.newCompany();
    const email = `owner${uniq()}@a.test`;
    const password = 'correct horse battery staple 1';
    const owner = await t.owner(companyId, email, password);
    const enrolled = await t.enrollFirstTotp(owner);
    await t.ownerLogin(owner, enrolled.totpSecret);
    await t.http.post('/auth/login').send({ email, password: 'totally wrong password' }).expect(401); // a failed attempt too
    await t.http.post('/auth/refresh').send({ refreshToken: enrolled.tokens.refreshToken });

    const blob = JSON.stringify(t.jsonLogs);
    for (const secret of [password, enrolled.totpSecret, enrolled.tokens.accessToken, enrolled.tokens.refreshToken, 'totally wrong password']) {
      expect(blob).not.toContain(secret);
    }
  });

  it('a low-level DB-pool warning never logs a connection string or credential (redaction applies to Nest-Logger-routed lines too)', async () => {
    t = await createTestApp();
    // DbService.pool.on('error', ...) logs via Nest's Logger, which app.useLogger() routes into the same JsonLogger.
    (t.dbs as unknown as { pool: { emit: (event: string, err: unknown) => void } }).pool.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: '08006' }));
    await new Promise((r) => setTimeout(r, 10));
    const blob = JSON.stringify(t.jsonLogs);
    expect(blob).not.toMatch(/postgres:\/\/[^"]*:[^"]*@/);
  });
});
