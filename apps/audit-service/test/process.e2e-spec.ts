import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken } from '@nawara/service-kit';

/**
 * Stage 18.2: the BUILT service (`dist/main.js`, exactly what the image runs) as a real OS process, production configuration: boots,
 * answers /health and /ready, logs structured JSON with no secret, exits on SIGTERM / SIGINT within its bound, and refuses to start on
 * invalid configuration with a clear, non-secret message and a non-zero exit. The database is UNREACHABLE on purpose: liveness and
 * shutdown must not depend on it (a real runtime-role boot is proven in runtime-role.e2e-spec and by the production image).
 */
const DB_PASSWORD = 'db-password-never-logged-0072';
const RUNTIME_DB = `postgres://audit_app:${DB_PASSWORD}@127.0.0.1:1/audit`;
const POLICY = JSON.stringify({ callers: { 'some-core-service': { operations: ['read_organization'], categories: ['business', 'commercial'] } } });
const REQUIRED = { DATABASE_URL: RUNTIME_DB, AUDIT_SERVICE_POLICY: POLICY };
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

describe('audit-service as a built process (production configuration)', () => {
  const runs: Run[] = [];
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' }); // CI runs this suite before its own build step
  }, 120_000);
  afterEach(() => {
    for (const r of runs.splice(0)) if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill('SIGKILL');
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('boots with its database down: live, not ready (503), JSON logs without secrets, %s exit within its bound', async (signal) => {
    const port = await freePort();
    const { digest } = generateServiceToken();
    const run = start({ NODE_ENV: 'production', PORT: String(port), ...REQUIRED, SERVICE_TOKENS: `some-core-service:${digest}`, HTTP_DRAIN_TIMEOUT_MS: '2000', DB_CONNECTION_TIMEOUT_MS: '500' });
    runs.push(run);
    const base = `http://127.0.0.1:${port}`;
    await waitHealthy(base, run);
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'unavailable', failed: ['database', 'migrations'] });
    expect((await fetch(`${base}/`)).status).toBe(404); // no starter route

    const t0 = Date.now();
    run.child.kill(signal);
    const exit = await run.exited;
    // Nest re-raises the signal once shutdown has completed (outside a container that ends the process by the signal; as PID 1 in the
    // image the re-raised signal is ignored and the process ends with code 0: see the production image smoke).
    expect(exit.signal === signal || exit.code === 0).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2_000 + 1_000);

    const lines = run.out().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.every((l) => l.service === 'audit-service' && typeof l.ts === 'string' && typeof l.level === 'string')).toBe(true);
    const msgs = lines.map((l) => String(l.msg));
    expect(msgs).toContain('service_started');
    expect(msgs.filter((m) => m.startsWith('service_shutdown_started'))).toHaveLength(1); // one shutdown, never twice
    expect(msgs.some((m) => m.startsWith(`service_shutdown_complete signal=${signal}`))).toBe(true);
    expect(msgs.some((m) => m.startsWith('readiness_check_failed check=database'))).toBe(true); // the cause is logged, as a class only
    for (const s of [digest, DB_PASSWORD]) expect(run.out()).not.toContain(s);
    expect(run.out()).not.toMatch(/SERVICE_TOKENS|AUDIT_SERVICE_POLICY|some-core-service/);
  }, 30_000);

  it.each([
    ['a missing DATABASE_URL', { DATABASE_URL: '' }, /DATABASE_URL/],
    ['a non-PostgreSQL DATABASE_URL', { DATABASE_URL: `mysql://audit_app:${DB_PASSWORD}@db/audit` }, /DATABASE_URL/],
    ['the superuser as the runtime database role', { DATABASE_URL: `postgres://postgres:${DB_PASSWORD}@db/audit` }, /least-privilege runtime role/],
    ['the migrator as the runtime database role', { DATABASE_URL: `postgres://audit_migrator:${DB_PASSWORD}@db/audit` }, /least-privilege runtime role/],
    ['an invalid port', { PORT: '70000' }, /PORT/],
    ['an invalid drain timeout', { HTTP_DRAIN_TIMEOUT_MS: '10' }, /HTTP_DRAIN_TIMEOUT_MS/],
    ['an unknown environment', { NODE_ENV: 'staging' }, /NODE_ENV/],
    ['malformed service tokens', { SERVICE_TOKENS: 'caller:secret-looking-value-0123' }, /SERVICE_TOKENS/],
    ['a registered caller without a policy', { AUDIT_SERVICE_POLICY: '' }, /AUDIT_SERVICE_POLICY/],
    ['a malformed caller policy', { AUDIT_SERVICE_POLICY: '{"callers": {"some-core-service": {"operations": ["*"], "categories": ["business"]}}}' }, /AUDIT_SERVICE_POLICY/],
    ['a caller policy that is not JSON', { AUDIT_SERVICE_POLICY: '{callers' }, /AUDIT_SERVICE_POLICY/],
    ['an unbounded database pool', { DB_POOL_MAX: '1000' }, /DB_POOL_MAX/],
    ['a query deadline not above the statement timeout', { DB_QUERY_TIMEOUT_MS: '1000' }, /DB_QUERY_TIMEOUT_MS/],
  ])('refuses to start on %s: non-zero exit, a clear message, the value never echoed', async (_label, env, name) => {
    const { digest } = generateServiceToken();
    const run = start({ NODE_ENV: 'production', PORT: String(await freePort()), ...REQUIRED, SERVICE_TOKENS: `some-core-service:${digest}`, ...env });
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
