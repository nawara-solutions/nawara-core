import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken } from '@nawara/service-kit';

/**
 * Stage 16.3: the BUILT service (`dist/main.js`, exactly what the image runs) as a real OS process, production configuration:
 * boots, answers /health and /ready, logs structured JSON with no secret, exits on SIGTERM within its bound, and refuses to start on
 * invalid configuration with a clear, non-secret message and a non-zero exit. The database here is UNREACHABLE on purpose: liveness
 * and shutdown must not depend on it (a real runtime-role boot is proven in runtime-role.e2e-spec and by the production image).
 */
const DB_PASSWORD = 'db-password-never-logged-0042';
const RUNTIME_DB = `postgres://notification_app:${DB_PASSWORD}@127.0.0.1:1/notification`;
const BROKER_PASSWORD = 'broker-password-never-logged-0043';
// Fixed (so the log scan can look for them) but random-looking: production refuses a patterned key (Stage 16.9).
const SECRET_KEY = createHash('sha256').update('process-spec-secret-key').digest().toString('base64');
/** Production-shaped: every required setting present; the database and the broker are unreachable on purpose. */
const HASH_KEY = createHash('sha256').update('process-spec-request-hash-key').digest().toString('base64');
const REQUIRED = {
  DATABASE_URL: RUNTIME_DB, RABBITMQ_URL: `amqp://notify:${BROKER_PASSWORD}@127.0.0.1:1`, NOTIFICATION_SECRET_KEYS: `k1:${SECRET_KEY}`, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k1',
  NOTIFICATION_DEFAULT_LOCALE: 'en', NOTIFICATION_REQUEST_HASH_KEY: HASH_KEY,
  NOTIFICATION_SERVICE_POLICY: JSON.stringify({ callers: { 'some-core-service': { templates: ['membership.approved'], channels: ['EMAIL'], organizations: 'none' } } }),
};
const ROOT = fileURLToPath(new URL('../', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

interface Run {
  child: ChildProcess;
  out: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(env: Record<string, string>): Run {
  let out = '';
  const child = spawn(process.execPath, ['dist/main.js'], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, out: () => out, exited };
}

async function waitHealthy(base: string, run: Run): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (run.child.exitCode !== null) throw new Error(`exited during startup:\n${run.out()}`);
    try {
      if ((await fetch(`${base}/health`)).status === 200) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`not healthy within 10 s:\n${run.out()}`);
}

describe('notification-service as a built process (production configuration)', () => {
  const runs: Run[] = [];
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' }); // CI runs this suite before its own build step
  }, 120_000);
  afterEach(() => {
    for (const r of runs.splice(0)) if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill('SIGKILL');
  });

  it('boots with its database down: live, not ready (503), structured JSON logs without secrets, SIGTERM exit within its bound', async () => {
    const port = await freePort();
    const { digest } = generateServiceToken();
    const run = start({ NODE_ENV: 'production', PORT: String(port), ...REQUIRED, SERVICE_TOKENS: `some-core-service:${digest}`, HTTP_DRAIN_TIMEOUT_MS: '2000', DB_CONNECTION_TIMEOUT_MS: '500' });
    runs.push(run);
    const base = `http://127.0.0.1:${port}`;
    await waitHealthy(base, run);
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'unavailable', failed: ['database', 'event-intake', 'migrations', 'rabbitmq'] });
    expect((await fetch(`${base}/`)).status).toBe(404); // no starter route

    const t0 = Date.now();
    run.child.kill('SIGTERM');
    const exit = await run.exited;
    const took = Date.now() - t0;
    // Nest re-raises the signal once shutdown has completed: outside a container that ends the process by SIGTERM (in a container,
    // as PID 1, the re-raised signal is ignored and the process ends naturally with code 0: see the production image smoke).
    expect(exit.signal === 'SIGTERM' || exit.code === 0).toBe(true);
    expect(took).toBeLessThan(2_000 + 1_000);

    const lines = run.out().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.every((l) => l.service === 'notification-service' && typeof l.ts === 'string' && typeof l.level === 'string')).toBe(true);
    const msgs = lines.map((l) => String(l.msg));
    expect(msgs).toContain('service_started');
    expect(msgs.some((m) => m.startsWith('service_shutdown_started'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('service_shutdown_complete signal=SIGTERM'))).toBe(true);
    expect(run.out()).not.toContain(digest);
    expect(run.out()).not.toContain(DB_PASSWORD);
    expect(run.out()).not.toContain(BROKER_PASSWORD);
    expect(run.out()).not.toContain(SECRET_KEY);
    expect(run.out()).not.toContain(HASH_KEY);
    expect(msgs.some((m) => m.startsWith('event_intake_waiting reason=database_unavailable'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('readiness_check_failed check=database'))).toBe(true); // the cause is logged, as a class only
    expect(run.out()).not.toMatch(/SERVICE_TOKENS|some-core-service/);
  }, 30_000);

  it.each([
    ['a missing RABBITMQ_URL', { RABBITMQ_URL: '' }, /RABBITMQ_URL/],
    ['a missing secret key ring', { NOTIFICATION_SECRET_KEYS: '' }, /NOTIFICATION_SECRET_KEYS/],
    ['a short secret key', { NOTIFICATION_SECRET_KEYS: 'k1:c2hvcnQ=' }, /NOTIFICATION_SECRET_KEYS/],
    ['a missing default locale', { NOTIFICATION_DEFAULT_LOCALE: '' }, /NOTIFICATION_DEFAULT_LOCALE/],
    ['a missing DATABASE_URL', { DATABASE_URL: '' }, /DATABASE_URL/],
    ['a non-PostgreSQL DATABASE_URL', { DATABASE_URL: `mysql://notification_app:${DB_PASSWORD}@db/notification` }, /DATABASE_URL/],
    ['the superuser as the runtime database role', { DATABASE_URL: `postgres://postgres:${DB_PASSWORD}@db/notification` }, /least-privilege runtime role/],
    ['the migrator as the runtime database role', { DATABASE_URL: `postgres://notification_migrator:${DB_PASSWORD}@db/notification` }, /least-privilege runtime role/],
    ['an invalid port', { PORT: '70000' }, /PORT/],
    ['an invalid drain timeout', { HTTP_DRAIN_TIMEOUT_MS: '10' }, /HTTP_DRAIN_TIMEOUT_MS/],
    ['an unknown environment', { NODE_ENV: 'staging' }, /NODE_ENV/],
    ['malformed service tokens', { SERVICE_TOKENS: 'caller:secret-looking-value-0123' }, /SERVICE_TOKENS/],
  ])('refuses to start on %s: non-zero exit, a clear message, the value never echoed', async (_label, env, name) => {
    const run = start({ NODE_ENV: 'production', PORT: String(await freePort()), ...REQUIRED, ...env });
    runs.push(run);
    const exit = await run.exited;
    expect(exit.code).not.toBe(0);
    expect(exit.code).not.toBeNull();
    expect(run.out()).toMatch(/ConfigError/);
    expect(run.out()).toMatch(name);
    expect(run.out()).not.toContain('secret-looking-value-0123');
    expect(run.out()).not.toContain(DB_PASSWORD);
    expect(run.out()).not.toContain('service_started');
  }, 30_000);
});
