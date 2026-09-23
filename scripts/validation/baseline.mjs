#!/usr/bin/env node
// Stage 15.1 baseline: idle / light-load reference measurements of ONE Core service (billing-service, the service with every
// Stage 14 runtime mechanism: pool, outbox relay, consumer, two poll loops). NOT a load test.
//
//   TEST_DATABASE_ADMIN_URL=postgres://postgres:...@127.0.0.1:5433/postgres TEST_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672 \
//     node scripts/validation/baseline.mjs [--runs 3] [--samples 200]
//
// Needs the built workspaces (npm run build -w @nawara/service-kit -w billing-service). Safety: refuses NODE_ENV=production and
// any non-loopback database or broker; every run uses its own throwaway database (created, migrated, dropped) and its own
// exchange/queue names. Prints one JSON document (environment, per-run values, median and range) and nothing secret.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { RabbitMqEventBus } from '../../libs/service-kit/dist/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const RUNS = arg('runs', 3);
const SAMPLES = arg('samples', 200);
const IDLE_WINDOW_MS = 10_000;

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const brokerUrl = process.env.TEST_RABBITMQ_URL;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
if (process.env.NODE_ENV === 'production') throw new Error('refusing to run with NODE_ENV=production');
if (!adminUrl || !brokerUrl) throw new Error('TEST_DATABASE_ADMIN_URL and TEST_RABBITMQ_URL are required');
for (const u of [adminUrl, brokerUrl]) if (!LOOPBACK.has(new URL(u).hostname)) throw new Error('refusing a non-loopback database or broker');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const lat = (xs) => ({ p50: round(pct(xs, 50)), p95: round(pct(xs, 95)), p99: round(pct(xs, 99)), max: round(Math.max(...xs)) });
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const cpuTicks = (pid) => {
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return Number(f[11]) + Number(f[12]); // utime + stime (fields 14, 15)
};
const rssMb = (pid) => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024;
const CLK_TCK = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim());

async function withAdmin(fn) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function oneRun() {
  const db = `validation_${randomBytes(4).toString('hex')}`;
  await withAdmin((c) => c.query(`CREATE DATABASE ${db}`));
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = `/${db}`;
  const port = 4100 + Math.floor(Math.random() * 800);
  const out = {};
  let child;
  try {
    execFileSync(process.execPath, [`${root}libs/service-kit/dist/cli/migrate.js`, '--dir', `${root}apps/billing-service/db/migrations`], {
      env: { PATH: process.env.PATH, MIGRATION_DATABASE_URL: dbUrl.toString() },
      stdio: 'ignore',
    });

    // 1. startup: spawn -> `service_started` log line -> first /ready 200
    const t0 = process.hrtime.bigint();
    child = spawn(process.execPath, [`${root}apps/billing-service/dist/main.js`], {
      env: {
        PATH: process.env.PATH, NODE_ENV: 'development', PORT: String(port), DATABASE_URL: dbUrl.toString(), RABBITMQ_URL: brokerUrl,
        BILLING_SUPPORTED_CURRENCIES: 'TND', AUTH_SERVICE_URL: 'http://127.0.0.1:9', PAYMENT_SERVICE_URL: 'http://127.0.0.1:9',
        PAYMENT_SERVICE_TOKEN: randomBytes(32).toString('hex'),
      },
    });
    const lines = [];
    let started;
    child.stdout.on('data', (d) => {
      for (const l of String(d).split('\n').filter(Boolean)) {
        lines.push(l);
        if (!started && l.includes('"msg":"service_started"')) started = ms(t0);
      }
    });
    const base = `http://127.0.0.1:${port}`;
    for (;;) {
      try {
        if ((await fetch(`${base}/ready`)).status === 200) break;
      } catch {
        /* not listening yet */
      }
      if (ms(t0) > 30_000) throw new Error('service did not become ready within 30 s');
      await sleep(10);
    }
    out.startup = { toServiceStartedMs: round(started ?? NaN, 0), toReadyMs: round(ms(t0), 0) };

    // 2. idle footprint: RSS and CPU over a quiet window (the relay polls every 1 s, the dispatcher every 2 s)
    await sleep(2_000);
    const c0 = cpuTicks(child.pid);
    await sleep(IDLE_WINDOW_MS);
    const c1 = cpuTicks(child.pid);
    out.idle = { rssMb: round(rssMb(child.pid), 1), cpuPercentOfOneCore: round(((c1 - c0) / CLK_TCK / (IDLE_WINDOW_MS / 1000)) * 100, 2) };

    // 3. sequential request latency (one client, no concurrency): liveness vs readiness (DB + migrations + broker checks)
    const time = async (fn) => {
      const xs = [];
      for (let i = 0; i < SAMPLES; i++) {
        const t = process.hrtime.bigint();
        await fn();
        xs.push(ms(t));
      }
      return lat(xs);
    };
    out.httpMs = {
      health: await time(async () => (await fetch(`${base}/health`)).arrayBuffer()),
      ready: await time(async () => (await fetch(`${base}/ready`)).arrayBuffer()),
    };

    // 4. database round trip from this host (same server, same database), through a 1-connection pool
    const pool = new pg.Pool({ connectionString: dbUrl.toString(), max: 1 });
    await pool.query('SELECT 1');
    out.dbSelect1Ms = await time(() => pool.query('SELECT 1'));
    await pool.end();

    // 5. broker round trip: confirmed publish -> consumer handler, on a private exchange and queue
    const exchange = `nawara.validation.${randomBytes(3).toString('hex')}`;
    const bus = new RabbitMqEventBus({ url: brokerUrl, exchange });
    const waiters = new Map();
    await bus.subscribe({ queue: `${exchange}.q`, bindings: ['validation.#'], handler: async (e) => waiters.get(e.id)?.() });
    const rt = [];
    for (let i = 0; i < Math.min(SAMPLES, 100); i++) {
      const id = randomUUID();
      const got = new Promise((r) => waiters.set(id, r));
      const t = process.hrtime.bigint();
      await bus.publish({ id, name: 'validation.ping', payload: { i }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'validation', version: 1 } });
      await got;
      rt.push(ms(t));
      waiters.delete(id);
    }
    out.eventRoundTripMs = lat(rt);
    const ch = await (await import('amqplib')).default.connect(brokerUrl);
    const c = await ch.createChannel();
    for (const q of [`${exchange}.q`, `${exchange}.q.retry`, `${exchange}.q.dead`]) await c.deleteQueue(q).catch(() => undefined);
    for (const x of [exchange, `${exchange}.dlx`]) await c.deleteExchange(x).catch(() => undefined);
    await bus.close();
    await ch.close();

    // 6. clean shutdown: SIGTERM -> exit (idle: no pass in flight is expected)
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    const ts = process.hrtime.bigint();
    child.kill('SIGTERM');
    const how = await exited;
    out.shutdown = { sigtermToExitMs: round(ms(ts), 0), exit: how.code ?? how.signal, completeLogged: lines.some((l) => l.includes('service_shutdown_complete')) };
    child = undefined;
    const warnOrError = lines.filter((l) => /"level":"(warn|error)"/.test(l)).length;
    out.logLines = { total: lines.length, warnOrError };
  } finally {
    if (child) child.kill('SIGKILL');
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  }
  return out;
}

const env = {
  gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  node: process.version,
  cpu: `${os.cpus()[0]?.model} x${os.cpus().length}`,
  memGiB: round(os.totalmem() / 2 ** 30, 1),
  os: `${os.type()} ${os.release()}`,
  postgres: await withAdmin(async (c) => (await c.query('SHOW server_version')).rows[0].server_version),
  runs: RUNS,
  samplesPerLatency: SAMPLES,
  service: 'billing-service (dist, NODE_ENV=development, default limits)',
};
const runs = [];
for (let i = 0; i < RUNS; i++) runs.push(await oneRun());

// median and range of every numeric leaf across runs
const leaves = (o, p = []) => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? leaves(v, [...p, k]) : typeof v === 'number' ? [[[...p, k].join('.'), v]] : []));
const summary = {};
for (const [key] of leaves(runs[0])) {
  const vs = runs.map((r) => leaves(r).find(([k]) => k === key)[1]);
  summary[key] = { median: round(pct(vs, 50)), min: round(Math.min(...vs)), max: round(Math.max(...vs)) };
}
console.log(JSON.stringify({ env, summary, runs }, null, 2));
