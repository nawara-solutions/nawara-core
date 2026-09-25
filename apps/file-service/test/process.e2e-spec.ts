import { randomBytes } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken } from '@nawara/service-kit';

/**
 * Stage 17.2: the BUILT service (`dist/main.js`, exactly what the image runs) as a real OS process, production configuration: boots,
 * answers /health and /ready, logs structured JSON with no secret, exits on SIGTERM / SIGINT within its bound, and refuses to start on
 * invalid configuration with a clear, non-secret message and a non-zero exit. The database is UNREACHABLE on purpose: liveness and
 * shutdown must not depend on it (a real runtime-role boot is proven in runtime-role.e2e-spec and by the production image).
 */
const DB_PASSWORD = 'db-password-never-logged-0072';
const RUNTIME_DB = `postgres://file_app:${DB_PASSWORD}@127.0.0.1:1/file`;
const POLICY = JSON.stringify({ callers: { 'some-core-service': { operations: ['upload', 'read'], organizations: 'request', mediaTypes: ['application/pdf'], maxBytes: 1_048_576 } } });
/** Stage 17.4: production needs an S3-compatible store. It is never contacted at startup (an unresolvable host proves it). */
const S3_SECRET = 's3-secret-looking-value-4567';
const STORAGE = { FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: 'https://objects.storage.invalid', FILE_S3_REGION: 'auto', FILE_S3_BUCKET: 'file-process-test', FILE_S3_ACCESS_KEY_ID: 'AKIDPROCESSTEST', FILE_S3_SECRET_ACCESS_KEY: S3_SECRET };
/** Stage 17.5: the upload settings (random keys per run). */
const UPLOAD = { FILE_PUBLIC_BASE_URL: 'https://files.process.invalid', FILE_REQUEST_HASH_KEY: randomBytes(32).toString('base64'), FILE_RATE_LIMIT_KEY: randomBytes(32).toString('base64') };
// Stage 18.7.4: the audit relay's broker, unreachable by construction (the relay retries in the background; it never gates startup or readiness).
const BROKER = { RABBITMQ_URL: 'amqp://guest:guest@127.0.0.1:9' };
const REQUIRED = { DATABASE_URL: RUNTIME_DB, FILE_SERVICE_POLICY: POLICY, ...STORAGE, ...UPLOAD, ...BROKER };
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

describe('file-service as a built process (production configuration)', () => {
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
    expect(lines.every((l) => l.service === 'file-service' && typeof l.ts === 'string' && typeof l.level === 'string')).toBe(true);
    const msgs = lines.map((l) => String(l.msg));
    expect(msgs).toContain('service_started');
    expect(msgs.filter((m) => m.startsWith('service_shutdown_started'))).toHaveLength(1); // one shutdown, never twice
    expect(msgs.some((m) => m.startsWith(`service_shutdown_complete signal=${signal}`))).toBe(true);
    expect(msgs.some((m) => m.startsWith('readiness_check_failed check=database'))).toBe(true); // the cause is logged, as a class only
    for (const s of [digest, DB_PASSWORD, S3_SECRET, 'AKIDPROCESSTEST', 'objects.storage.invalid', UPLOAD.FILE_REQUEST_HASH_KEY, UPLOAD.FILE_RATE_LIMIT_KEY]) expect(run.out()).not.toContain(s);
    expect(run.out()).not.toMatch(/SERVICE_TOKENS|FILE_SERVICE_POLICY|some-core-service/);
  }, 30_000);

  it.each([
    ['a missing DATABASE_URL', { DATABASE_URL: '' }, /DATABASE_URL/],
    ['a non-PostgreSQL DATABASE_URL', { DATABASE_URL: `mysql://file_app:${DB_PASSWORD}@db/file` }, /DATABASE_URL/],
    ['the superuser as the runtime database role', { DATABASE_URL: `postgres://postgres:${DB_PASSWORD}@db/file` }, /least-privilege runtime role/],
    ['the migrator as the runtime database role', { DATABASE_URL: `postgres://file_migrator:${DB_PASSWORD}@db/file` }, /least-privilege runtime role/],
    ['an invalid port', { PORT: '70000' }, /PORT/],
    ['an invalid drain timeout', { HTTP_DRAIN_TIMEOUT_MS: '10' }, /HTTP_DRAIN_TIMEOUT_MS/],
    ['an unknown environment', { NODE_ENV: 'staging' }, /NODE_ENV/],
    ['malformed service tokens', { SERVICE_TOKENS: 'caller:secret-looking-value-0123' }, /SERVICE_TOKENS/],
    ['a registered caller without a policy', { FILE_SERVICE_POLICY: '' }, /FILE_SERVICE_POLICY/],
    ['a malformed caller policy', { FILE_SERVICE_POLICY: '{"callers": {"some-core-service": {"operations": ["*"], "organizations": "none"}}}' }, /FILE_SERVICE_POLICY/],
    ['a FILE_MAX_BYTES over the 100 MiB bound', { FILE_MAX_BYTES: '104857601' }, /FILE_MAX_BYTES/],
    ['no storage provider (no default, no fallback)', { FILE_STORAGE_PROVIDER: '' }, /FILE_STORAGE_PROVIDER is required/],
    ['an unknown storage provider', { FILE_STORAGE_PROVIDER: 'local' }, /FILE_STORAGE_PROVIDER must be one of/],
    ['the filesystem store in production', { FILE_STORAGE_PROVIDER: 'filesystem', FILE_STORAGE_ROOT: '/tmp/file-process-test' }, /refused in production/],
    ['a plain-HTTP S3 endpoint in production', { FILE_S3_ENDPOINT: 'http://objects.storage.invalid' }, /FILE_S3_ENDPOINT/],
    ['a missing S3 bucket', { FILE_S3_BUCKET: '' }, /FILE_S3_BUCKET/],
    ['a missing S3 secret', { FILE_S3_SECRET_ACCESS_KEY: '' }, /FILE_S3_SECRET_ACCESS_KEY/],
    ['a missing request-hash key', { FILE_REQUEST_HASH_KEY: '' }, /FILE_REQUEST_HASH_KEY/],
    ['a plain-HTTP public base URL in production', { FILE_PUBLIC_BASE_URL: 'http://files.process.invalid' }, /FILE_PUBLIC_BASE_URL/],
    ['no broker for the audit relay in production (Stage 18.7.4)', { RABBITMQ_URL: '' }, /RABBITMQ_URL is required in production/],
    ['a non-AMQP broker URL', { RABBITMQ_URL: `http://guest:${DB_PASSWORD}@mq` }, /RABBITMQ_URL/],
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
    expect(run.out()).not.toContain(S3_SECRET);
    expect(run.out()).not.toContain('service_started');
  }, 30_000);
});
