// Stage 15 validation harness (test-only). Shared by the campaign scripts in scripts/validation/.
// Fails closed: never production, loopback hosts only, only on a throwaway cluster, only on databases it created itself.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
// A cluster that hosts any of these is a real (compose or deployed) Core cluster, never a throwaway one.
const REAL_DATABASES = ['auth', 'billing', 'payment', 'organization'];
export const THROWAWAY_PREFIX = 'validation_';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();
export const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);
export function pct(xs, p) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
export const stats = (xs) => ({ n: xs.length, median: round(pct(xs, 50), 2), min: round(Math.min(...xs), 2), max: round(Math.max(...xs), 2) });

/** Refuses anything that is not a loopback, throwaway PostgreSQL. Call once before any destructive step. */
export async function assertThrowawayCluster(adminUrl) {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to run with NODE_ENV=production');
  if (!adminUrl) throw new Error('VALIDATION_DATABASE_ADMIN_URL is required (a throwaway PostgreSQL, never a real cluster)');
  if (!LOOPBACK.has(new URL(adminUrl).hostname)) throw new Error('refusing a non-loopback database host');
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const { rows } = await c.query('SELECT datname FROM pg_database WHERE datname = ANY($1)', [REAL_DATABASES]);
    if (rows.length > 0) throw new Error(`refusing a cluster that hosts real Core databases (${rows.map((r) => r.datname).join(', ')}): use a throwaway PostgreSQL`);
  } finally {
    await c.end();
  }
}

export function assertLoopbackBroker(url) {
  if (!url || !LOOPBACK.has(new URL(url).hostname)) throw new Error('refusing a non-loopback broker');
}

export async function adminQuery(adminUrl, sql, params) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

/** A throwaway database (name marked with THROWAWAY_PREFIX), migrated with the real runner for `service`. */
export async function throwawayDatabase(adminUrl, service) {
  const name = `${THROWAWAY_PREFIX}${service ? service.replace(/-service$/, '') : 'raw'}_${randomBytes(4).toString('hex')}`;
  await adminQuery(adminUrl, `CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  if (service) migrate(service, url.toString());
  return {
    name,
    url: url.toString(),
    async drop() {
      if (!name.startsWith(THROWAWAY_PREFIX)) throw new Error('refusing to drop a database the harness did not create');
      await adminQuery(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

export function migrate(service, url) {
  const env = { PATH: process.env.PATH, MIGRATION_DATABASE_URL: url };
  if (service === 'auth-service') execFileSync(process.execPath, [`${root}apps/auth-service/dist/cli/migrate.js`], { env, stdio: 'ignore' });
  else execFileSync(process.execPath, [`${root}libs/service-kit/dist/cli/migrate.js`, '--dir', `${root}apps/${service}/db/migrations`], { env, stdio: 'ignore' });
}

/** Rewrites `url` to go through a local TCP proxy on `port`. */
export function via(url, port) {
  const u = new URL(url);
  u.hostname = '127.0.0.1';
  u.port = String(port);
  return u.toString();
}

const rnd = () => randomBytes(32).toString('hex');
/** Minimal valid development environment per service (random secrets, unreachable peers). */
export function serviceEnv(service, { databaseUrl, brokerUrl, port, extra = {} }) {
  const base = { PATH: process.env.PATH, NODE_ENV: 'development', PORT: String(port), DATABASE_URL: databaseUrl, ...extra };
  if (service === 'billing-service') {
    return { ...base, RABBITMQ_URL: brokerUrl, BILLING_SUPPORTED_CURRENCIES: 'TND', AUTH_SERVICE_URL: 'http://127.0.0.1:9', PAYMENT_SERVICE_URL: 'http://127.0.0.1:9', PAYMENT_SERVICE_TOKEN: rnd(), ...extra };
  }
  if (service === 'payment-service') return { ...base, RABBITMQ_URL: brokerUrl, PAYMENT_SUPPORTED_CURRENCIES: 'TND', AUTH_SERVICE_URL: 'http://127.0.0.1:9', PAYMENT_TEST_PROVIDER: 'true', ...extra };
  if (service === 'organization-service') return { ...base, AUTH_SERVICE_URL: 'http://127.0.0.1:9', ...extra };
  if (service === 'auth-service') {
    return {
      ...base, AUTH_EVENTS: 'off', JWT_SECRET: rnd(), OPERATOR_CODE_PEPPER: rnd(), SECRET_KEY_PEPPER: rnd(), THROTTLE_KEY_PEPPER: rnd(), JOIN_CODE_PEPPER: rnd(),
      TOTP_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGINS: 'http://localhost', ...extra,
    };
  }
  throw new Error(`unknown service ${service}`);
}

/** Starts a built service from dist. Collects its JSON log lines with arrival times. */
export function launch(service, env) {
  const t0 = now();
  const child = spawn(process.execPath, [`${root}apps/${service}/dist/main.js`], { env });
  const lines = [];
  let buf = '';
  const take = (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!raw.trim()) continue;
      let j;
      try {
        j = JSON.parse(raw);
      } catch {
        j = { level: 'raw', msg: raw };
      }
      lines.push({ t: now(), raw, ...j });
    }
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal, t: now() })));
  const base = `http://127.0.0.1:${env.PORT}`;
  return {
    service, child, lines, exited, t0, base,
    alive: () => child.exitCode === null && child.signalCode === null,
    status: async (path, timeoutMs = 10_000) => {
      const t = now();
      try {
        const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
        return { status: r.status, ms: now() - t, body: await r.text() };
      } catch (e) {
        return { status: e?.name === 'TimeoutError' ? 'timeout' : 'unreachable', ms: now() - t };
      }
    },
    since: (t, pred = () => true) => lines.filter((l) => l.t >= t && pred(l)),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      return exited;
    },
  };
}

export async function waitFor(cond, timeoutMs = 30_000, stepMs = 25) {
  const end = now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (now() > end) return undefined;
    await sleep(stepMs);
  }
}

/** Server-side view of the sessions of one database (or of every throwaway database). */
export async function sessions(adminUrl, dbName) {
  const rows = await adminQuery(
    adminUrl,
    `SELECT datname, coalesce(application_name, '') AS app, state, count(*)::int AS n FROM pg_stat_activity
      WHERE backend_type = 'client backend' AND ($1::text IS NULL AND datname LIKE '${THROWAWAY_PREFIX}%' OR datname = $1) GROUP BY 1, 2, 3`,
    [dbName ?? null],
  );
  const total = rows.reduce((a, r) => a + r.n, 0);
  const by = (k) => rows.reduce((m, r) => ((m[r[k] || '-'] = (m[r[k] || '-'] ?? 0) + r.n), m), {});
  return { total, byState: by('state'), byDatabase: by('datname'), byApp: by('app') };
}

const CLK_TCK = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim());
export function processSample(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  const rss = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024;
  return { t: now(), cpuTicks: Number(stat[11]) + Number(stat[12]), rssMb: rss };
}
export const cpuPercent = (a, b) => round(((b.cpuTicks - a.cpuTicks) / CLK_TCK / ((b.t - a.t) / 1000)) * 100, 2);

export async function environment(adminUrl) {
  const [v] = await adminQuery(adminUrl, `SELECT current_setting('server_version') AS version, current_setting('max_connections') AS max,
    current_setting('superuser_reserved_connections') AS reserved`);
  let docker = 'unknown';
  try {
    docker = execFileSync('docker', ['version', '--format', '{{.Server.Version}}']).toString().trim();
  } catch {
    /* docker not reachable */
  }
  return {
    gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
    dirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root }).toString().trim().length > 0,
    node: process.version, docker, cpu: `${os.cpus()[0]?.model} x${os.cpus().length}`, memGiB: round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()}`, postgres: v.version, maxConnections: Number(v.max), superuserReserved: Number(v.reserved),
  };
}

// ------------------------------------------------------------------------------------------------ throwaway containers (Stage 15.3)
// The harness starts, pauses, stops and removes ONLY containers it created itself (name prefix `validation-`), on loopback ports.
const CONTAINER_PREFIX = 'validation-';
const docker = (...args) => execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
/** A free loopback port, published explicitly: Docker re-assigns a randomly published port on `docker restart`, a fixed one survives it. */
async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
function ownContainer(name) {
  if (!name.startsWith(CONTAINER_PREFIX)) throw new Error(`refusing to touch container ${name}: not created by the validation harness`);
  return name;
}

/**
 * A throwaway RabbitMQ (same image as compose) on a free loopback port, guest/guest, default configuration. `heartbeatS` sets the
 * broker's proposed heartbeat (a server setting, `heartbeat = N`; 0 disables heartbeats) to reproduce a broker configured that way.
 */
export async function throwawayRabbit({ heartbeatS } = {}) {
  const name = `${CONTAINER_PREFIX}rabbitmq-${randomBytes(3).toString('hex')}`;
  const port = await freePort();
  const extra = [];
  if (heartbeatS !== undefined) {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const dir = mkdtempSync(`${os.tmpdir()}/validation-rabbitmq-`);
    writeFileSync(`${dir}/90-heartbeat.conf`, `heartbeat = ${Number(heartbeatS)}\n`);
    extra.push('-v', `${dir}/90-heartbeat.conf:/etc/rabbitmq/conf.d/90-heartbeat.conf:ro`);
  }
  docker('run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:5672`, ...extra, 'rabbitmq:3.13-management-alpine');
  const url = `amqp://guest:guest@127.0.0.1:${port}`;
  const ready = async () => {
    for (let i = 0; i < 120; i++) {
      // Readiness by an AMQP handshake only: `docker exec`-ing the CLI while the broker boots races the entrypoint's Erlang cookie
      // creation and makes the broker exit.
      try {
        const amqp = (await import('amqplib')).default;
        const c = await amqp.connect(url);
        await c.close();
        return;
      } catch {
        await sleep(500);
      }
    }
    throw new Error('throwaway RabbitMQ did not become ready');
  };
  await ready();
  const ctl = (...a) => docker('exec', '-u', 'rabbitmq', ownContainer(name), 'rabbitmqctl', '-q', ...a);
  const table = (cmd, cols) =>
    ctl(cmd, '--no-table-headers', ...cols).split('\n').filter((l) => l.trim()).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v])));
  return {
    name, port, url,
    pause: () => docker('pause', ownContainer(name)),
    unpause: () => docker('unpause', ownContainer(name)),
    stop: () => docker('stop', '-t', '5', ownContainer(name)), // --rm: stopping removes it, so `stop` is only used for the final teardown
    /** Broker process stopped and started again inside the same container: queues, messages and the port survive (a broker restart). */
    appStop: () => ctl('stop_app'),
    appStart: async () => {
      ctl('start_app');
      await ready();
    },
    restart: async () => {
      docker('restart', '-t', '10', ownContainer(name));
      await ready();
    },
    queues: () => table('list_queues', ['name', 'messages_ready', 'messages_unacknowledged', 'consumers']),
    connections: () => table('list_connections', ['name', 'channels', 'state']),
    channels: () => table('list_channels', ['connection', 'number', 'consumer_count', 'messages_unacknowledged', 'prefetch_count']),
    consumers: () => table('list_consumers', ['queue_name', 'channel_pid', 'prefetch_count']),
  };
}

/** A throwaway PostgreSQL 16 on a random loopback port; returns an admin URL that passes `assertThrowawayCluster`. */
export async function throwawayPostgres() {
  const name = `${CONTAINER_PREFIX}postgres-${randomBytes(3).toString('hex')}`;
  const password = randomBytes(18).toString('hex');
  const port = await freePort();
  docker('run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:5432`, '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:16-alpine');
  const adminUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  for (let i = 0; i < 120; i++) {
    try {
      await adminQuery(adminUrl, 'SELECT 1');
      break;
    } catch {
      await sleep(500);
    }
  }
  await assertThrowawayCluster(adminUrl);
  return { name, port, adminUrl, stop: () => docker('stop', '-t', '5', ownContainer(name)) };
}
