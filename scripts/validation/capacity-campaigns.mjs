#!/usr/bin/env node
// Stage 15.8: capacity and runtime tuning campaigns (test-only). Plan, results and decisions: docs/architecture/core-validation.md §13.8.
//
//   node scripts/validation/capacity-campaigns.mjs [--out results.json] [--label name] [campaign ...]     (default: all, in plan order)
//
// Starts its OWN throwaway RabbitMQ and PostgreSQL containers (`validation-*`, loopback) and removes them at the end. Real Auth,
// Organization, Billing and Payment processes from `dist`. THIS MACHINE IS NOT A PRODUCTION CAPACITY MODEL: the numbers are relative
// (before / after, one knob at a time), never a claim about production users or requests per second.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { DbService, OutboxRelay, OutboxService, RabbitMqEventBus, describeFailure, generateServiceToken, kitMigrationsDir, runMigrations } from '../../libs/service-kit/dist/index.js';
import { BrokerProxy } from '../../libs/service-kit/dist/testing/broker-proxy.js';
import * as h from './lib/harness.mjs';
import { coreStacks } from './lib/core-stack.mjs';
import { liveCore, probe } from './lib/live-core.mjs';
import { medianOf, runLoad } from './lib/load.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('refusing to run with NODE_ENV=production');
const log = (...a) => process.stderr.write(`[15.8] ${a.join(' ')}\n`);
let uncaught = 0;
process.on('uncaughtException', (e) => {
  uncaught++;
  log('UNCAUGHT', describeFailure(e), String(e?.message).slice(0, 160));
});
process.on('unhandledRejection', (e) => {
  uncaught++;
  log('UNHANDLED', describeFailure(e), String(e?.message).slice(0, 160));
});

const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const outFile = take('--out');
const RUN_S = Number(take('--run-seconds') ?? 60);
const RUNS = Number(take('--runs') ?? 3);
const BACKOFF_CAPS = (take('--backoff-caps') ?? '60000,15000,5000').split(',').map((x) => (x === 'default' ? undefined : Number(x)));
const LEVELS = (take('--levels') ?? 'light,moderate,pressure').split(',');
const MULTI_MIX = take('--multi-mix') ?? 'mixed'; // mixed | read
const MULTI_COUNTS = (take('--multi-counts') ?? '1,2,4').split(',').map(Number);
const PREFETCH_VALUES = (take('--prefetch-values') ?? '1,5,10,20').split(',').map((x) => (x === 'default' ? x : Number(x)));

const rabbit = await h.throwawayRabbit();
const pgc = await h.throwawayPostgres();
const ADMIN = pgc.adminUrl;
log(`throwaway broker ${rabbit.name} :${rabbit.port}, postgres ${pgc.name} :${pgc.port}`);
const stack = coreStacks({ adminUrl: ADMIN, rabbit, pgPort: pgc.port });
const core = liveCore({ adminUrl: ADMIN, rabbit });
const C = {};

// ------------------------------------------------------------------------------------------------ resources
/** Samples CPU / RSS of the given processes and the database sessions every second while `fn` runs. */
async function sampled(procs, fn) {
  let on = true;
  const series = [];
  const first = Object.fromEntries(Object.entries(procs).filter(([, p]) => p?.alive()).map(([n, p]) => [n, h.processSample(p.child.pid)]));
  const loop = (async () => {
    while (on) {
      await h.sleep(1000);
      const s = await h.sessions(ADMIN, null).catch(() => null);
      const rss = Object.fromEntries(Object.entries(procs).filter(([, p]) => p?.alive()).map(([n, p]) => [n, h.processSample(p.child.pid).rssMb]));
      series.push({ sessions: s?.total ?? null, active: s?.byState?.active ?? 0, idleInTx: s?.byState?.['idle in transaction'] ?? 0, byDb: s?.byDatabase ?? {}, rss });
    }
  })();
  const pgBefore = pgCpu();
  const result = await fn();
  on = false;
  await loop;
  const pgAfter = pgCpu();
  const last = Object.fromEntries(Object.entries(first).map(([n]) => [n, procs[n]?.alive() ? h.processSample(procs[n].child.pid) : null]));
  const cpu = Object.fromEntries(Object.entries(first).map(([n, a]) => [n, last[n] ? h.cpuPercent(a, last[n]) : null]));
  const rssMax = Object.fromEntries(Object.keys(first).map((n) => [n, h.round(Math.max(...series.map((x) => x.rss[n] ?? 0)))]));
  const byDbMax = {};
  for (const x of series) for (const [d, n] of Object.entries(x.byDb)) byDbMax[d] = Math.max(byDbMax[d] ?? 0, n);
  return {
    result, cpuPct: cpu, rssMaxMb: rssMax, dbSessionsMax: Math.max(0, ...series.map((x) => x.sessions ?? 0)), dbActiveMax: Math.max(0, ...series.map((x) => x.active)),
    idleInTxMax: Math.max(0, ...series.map((x) => x.idleInTx)), sessionsByDbMax: byDbMax, postgresCpuPct: pgBefore !== null && pgAfter !== null ? h.round(((pgAfter.t - pgBefore.t) > 0 ? ((pgAfter.cpu - pgBefore.cpu) / (pgAfter.t - pgBefore.t)) : 0) * 100, 1) : null,
  };
}
/** PostgreSQL container CPU seconds (cgroup), for a CPU % over an interval. */
function pgCpu() {
  try {
    const usec = Number(execFileSync('docker', ['exec', pgc.name, 'sh', '-c', 'cat /sys/fs/cgroup/cpu.stat | head -1 | cut -d" " -f2']).toString().trim());
    return { cpu: usec / 1e6, t: Date.now() / 1000 };
  } catch {
    return null;
  }
}
const brokerView = () => {
  try {
    const q = rabbit.queues().find((x) => x.name === 'billing.payment-events');
    return { connections: rabbit.connections().length, channels: rabbit.channels().length, unacked: Number(q?.messages_unacknowledged ?? 0), ready: Number(q?.messages_ready ?? 0) };
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------------------------------------ world: four real services
async function world({ billingEnv = {}, paymentEnv = {}, withEdge = true } = {}) {
  const s = await stack({ billingEnv, paymentEnv });
  const items = await s.seed(30, { orgs: [randomUUID(), randomUUID(), randomUUID()] });
  const payments = [];
  for (const it of items) payments.push((await s.paymentOf(it))[0].id);
  let edge = null;
  if (withEdge) {
    const adb = await h.throwawayDatabase(ADMIN, 'auth-service');
    const odb = await h.throwawayDatabase(ADMIN, 'organization-service');
    const auth = await core.start('auth-service', { db: adb, extra: { NODE_ENV: 'development', BASELINE_RATE_LIMIT_PER_MINUTE: '1000000' } });
    const orgTok = generateServiceToken();
    const org = await core.start('organization-service', {
      db: odb, extra: { AUTH_SERVICE_URL: auth.base, SERVICE_TOKENS: `loadtest:${orgTok.digest}`, SERVICE_POLICY: JSON.stringify({ callers: { loadtest: { capabilities: ['hierarchy.reference.read'], allowedPlatforms: [randomUUID()] } } }) },
    });
    edge = { auth, org, orgTok, adb, odb };
  }
  const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
  const bBase = s.base('billing');
  const pBase = s.base('payment');
  const price = await s.billingApi('GET', `/billing/invoices/${items[0].invoiceId}`);
  const org0 = items[0].org;
  const priceId = (await s.bq(`SELECT "priceId" FROM invoice_line WHERE "invoiceId" = $1`, [items[0].invoiceId]))[0].priceId;
  const R = {
    billingRead: () => ({ name: 'billingRead', method: 'GET', url: `${bBase}/billing/invoices/${pick(items).invoiceId}`, headers: { authorization: `Bearer ${s.producer.token}` } }),
    billingWrite: () => ({
      name: 'billingWrite', method: 'POST', url: `${bBase}/billing/invoices`, headers: { authorization: `Bearer ${s.producer.token}` },
      body: { invoiceRequestId: randomUUID(), seller: { type: 'organization', id: org0 }, payer: { type: 'user', id: `u-${randomUUID()}` }, sourceType: 'contract', sourceId: `src-${randomUUID()}`, issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId, quantity: 1 }] },
    }),
    paymentRead: () => ({ name: 'paymentRead', method: 'GET', url: `${pBase}/payment/payments/${pick(payments)}`, headers: { authorization: `Bearer ${s.b2p.token}` } }),
    orgRead: edge ? () => ({ name: 'orgRead', method: 'GET', url: `${edge.org.base}/organization/reference/organizations/${randomUUID()}`, headers: { authorization: `Bearer ${edge.orgTok.token}` } }) : null,
    authHealth: edge ? () => ({ name: 'authHealth', method: 'GET', url: `${edge.auth.base}/auth/health` }) : null,
  };
  const mix = () => {
    const x = Math.random();
    if (!edge) return x < 0.45 ? R.billingRead() : x < 0.6 ? R.billingWrite() : R.paymentRead();
    return x < 0.3 ? R.billingRead() : x < 0.4 ? R.billingWrite() : x < 0.65 ? R.paymentRead() : x < 0.8 ? R.orgRead() : R.authHealth();
  };
  // org reference read of an unknown id: 404 (collapsed not-found) or 409 before authority is activated; both are correct answers
  const ok = (st, name) => (name === 'orgRead' ? st === 404 || st === 409 : st >= 200 && st < 300);
  const procs = () => ({ billing: s.procs.billing, payment: s.procs.payment, ...(edge ? { auth: edge.auth, organization: edge.org } : {}) });
  void price;
  return {
    s, edge, items, payments, R, mix, ok, procs,
    close: async () => {
      if (edge) {
        for (const p of [edge.auth, edge.org]) if (p.alive()) { p.child.kill('SIGKILL'); await p.exited; }
        await edge.adb.drop();
        await edge.odb.drop();
      }
      await s.close();
    },
  };
}

/** `runs` measured runs (after one warm-up each) of `next` at `concurrency`: per-run results and medians. */
async function measure(w, { next, concurrency, runs = RUNS, seconds = RUN_S, label }) {
  const out = [];
  for (let i = 0; i < runs; i++) {
    const r = await sampled(w.procs(), () => runLoad({ next, concurrency, durationMs: seconds * 1000, warmupMs: 10_000, ok: w.ok }));
    out.push({ ...r.result, cpuPct: r.cpuPct, rssMaxMb: r.rssMaxMb, dbSessionsMax: r.dbSessionsMax, dbActiveMax: r.dbActiveMax, idleInTxMax: r.idleInTxMax, sessionsByDbMax: r.sessionsByDbMax, postgresCpuPct: r.postgresCpuPct });
    log(`${label} c=${concurrency} run ${i + 1}: ${out.at(-1).rps} rps p50 ${out.at(-1).p50} p95 ${out.at(-1).p95} p99 ${out.at(-1).p99} err ${out.at(-1).errorRate} sessions ${out.at(-1).dbSessionsMax}`);
  }
  return {
    concurrency, runs: out, rps: medianOf(out, (r) => r.rps), p50: medianOf(out, (r) => r.p50), p95: medianOf(out, (r) => r.p95), p99: medianOf(out, (r) => r.p99), errorRate: medianOf(out, (r) => r.errorRate),
    byName: Object.fromEntries(Object.keys(out[0].byName).map((n) => [n, { rps: medianOf(out, (r) => r.byName[n]?.rps), p50: medianOf(out, (r) => r.byName[n]?.p50), p95: medianOf(out, (r) => r.byName[n]?.p95), p99: medianOf(out, (r) => r.byName[n]?.p99), errorRate: medianOf(out, (r) => r.byName[n]?.errorRate) }])),
  };
}

// ------------------------------------------------------------------------------------------------ campaigns
C.baselineLoad = async () => {
  // The mixed profile (Billing read 30 %, Billing write 10 %, Payment read 25 %, Organization reference read 15 %, Auth health 20 %)
  // at light / moderate / pressure concurrency. 3 runs of RUN_S seconds each, after a 10 s warm-up.
  const w = await world();
  try {
    const idle = await sampled(w.procs(), () => h.sleep(15_000));
    const out = { idle: { cpuPct: idle.cpuPct, rssMaxMb: idle.rssMaxMb, dbSessionsMax: idle.dbSessionsMax }, broker: brokerView() };
    for (const [name, c] of [['light', 4], ['moderate', 16], ['pressure', 64]].filter(([n]) => LEVELS.includes(n))) out[name] = await measure(w, { next: w.mix, concurrency: c, label: `baseline ${name}` });
    await h.sleep(5000);
    const post = await sampled(w.procs(), () => h.sleep(10_000));
    out.postLoad = { cpuPct: post.cpuPct, rssMaxMb: post.rssMaxMb, dbSessionsMax: post.dbSessionsMax, idleInTxMax: post.idleInTxMax, broker: brokerView(), readiness: await w.s.readiness() };
    return out;
  } finally {
    await w.close();
  }
};

C.poolSize = async () => {
  // Billing read-heavy load (Billing read 75 %, write 25 %) at pressure concurrency with DB_POOL_MAX 5 / 10 / 20 (Billing only).
  const out = {};
  for (const pool of [5, 10, 20]) {
    const w = await world({ billingEnv: { DB_POOL_MAX: String(pool) }, withEdge: false });
    try {
      const next = () => (Math.random() < 0.75 ? w.R.billingRead() : w.R.billingWrite());
      out[`pool${pool}`] = { c16: await measure(w, { next, concurrency: 16, seconds: 30, label: `pool ${pool}` }), c64: await measure(w, { next, concurrency: 64, seconds: 30, label: `pool ${pool}` }) };
    } finally {
      await w.close();
    }
  }
  return out;
};

C.poolExhaustion = async () => {
  // Every Billing pool client blocked (an ACCESS EXCLUSIVE lock on `invoice` held for 15 s) while 100 concurrent reads arrive: waits are
  // bounded by DB_CONNECTION_TIMEOUT_MS (5 s) for callers without a client, and by the lock for the 10 that got one; no leak; recovery.
  const w = await world({ withEdge: false });
  const runs = [];
  try {
    for (let i = 0; i < 3; i++) {
      const locker = new pg.Client({ connectionString: w.s.bdb.url, application_name: 'validation-locker' });
      await locker.connect();
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE invoice IN ACCESS EXCLUSIVE MODE');
      const t0 = h.now();
      const reqs = Array.from({ length: 100 }, () => w.s.billingApi('GET', `/billing/invoices/${w.items[i].invoiceId}`));
      await h.sleep(15_000);
      const during = await h.sessions(ADMIN, w.s.bdb.name);
      await locker.query('COMMIT');
      await locker.end();
      const res = await Promise.all(reqs);
      const statuses = res.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
      const maxMs = Math.max(...res.map((r) => r.ms));
      const fails = res.filter((r) => r.status !== 200).map((r) => r.ms);
      await h.sleep(2000);
      const after = await h.sessions(ADMIN, w.s.bdb.name);
      const recovery = await w.s.billingApi('GET', `/billing/invoices/${w.items[i].invoiceId}`);
      runs.push({ statuses, maxMs: h.round(maxMs), failedWithinMs: fails.length ? { min: h.round(Math.min(...fails)), max: h.round(Math.max(...fails)) } : null, sessionsDuring: during.total, idleInTxAfter: after.byState['idle in transaction'] ?? 0, sessionsAfter: after.total, recovery: { status: recovery.status, ms: recovery.ms }, elapsedMs: h.round(h.now() - t0), readiness: await w.s.readiness() });
      log(`poolExhaustion run ${i + 1}: ${JSON.stringify(runs.at(-1).statuses)} max ${runs.at(-1).maxMs} ms, failed within ${JSON.stringify(runs.at(-1).failedWithinMs)}, idleInTx ${runs.at(-1).idleInTxAfter}`);
    }
    return { runs };
  } finally {
    await w.close();
  }
};

// ------------------------------------------------------------------------------------------------ Billing dispatcher
/** A Billing whose dispatcher is idle while `n` requests are seeded (interval 300 s), then restarted with `env`: the backlog to drain. */
async function dispatchBacklog(n, env, stackOpts = {}) {
  const s = await stack({ billingEnv: { BILLING_DISPATCH_INTERVAL_MS: '300000', ...(stackOpts.billingEnv ?? {}) }, paymentEnv: stackOpts.paymentEnv });
  const items = await s.seed(n, { orgs: [randomUUID(), randomUUID(), randomUUID(), randomUUID()], wait: false });
  await s.stop('billing');
  return { s, items, restart: () => s.start('billing', { extra: { BILLING_DISPATCH_INTERVAL_MS: '2000', ...env } }) };
}
const countRequested = async (s, items) => (await s.bq(`SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1) AND status = 'requested'`, [items.map((x) => x.requestId)]))[0].n;
/** Drains a dispatch backlog: remaining at 10 / 30 / 60 s, time to zero, the latency of a Billing read probed every 250 ms meanwhile. */
async function drainDispatch(s, items, limitMs = 180_000) {
  const t0 = h.now();
  const marks = {};
  const lat = [];
  let done = null;
  const readUrl = `/billing/invoices/${items[0].invoiceId}`;
  while (h.now() - t0 < limitMs) {
    const r = await s.billingApi('GET', readUrl);
    lat.push(r.ms);
    const left = items.length - (await countRequested(s, items));
    const el = h.now() - t0;
    for (const m of [10_000, 30_000, 60_000]) if (el >= m && marks[m / 1000] === undefined) marks[m / 1000] = left;
    if (left === 0) { done = h.round(el); break; }
    await h.sleep(250);
  }
  const sorted = [...lat].sort((a, b) => a - b);
  return { timeToZeroMs: done, remainingAt: marks, readLatency: { p50: h.round(sorted[Math.floor(sorted.length / 2)]), p99: h.round(sorted[Math.floor(sorted.length * 0.99)] ?? sorted.at(-1)), max: h.round(sorted.at(-1)) } };
}

C.dispatcherBatch = async () => {
  // 200 requests waiting to be sent; the dispatcher (interval 2 s) drains them with batch 10 / 25 / 50, Payment fast (3 runs) or slowed
  // to 200 ms per call (1 run). One Payment call per request expected in every case.
  const out = {};
  for (const [label, mode, runs] of [['fast', 'pass', 3], ['slow200ms', 'slow:200', 1]]) {
    for (const batch of [10, 25, 50]) {
      const rs = [];
      for (let i = 0; i < runs; i++) {
        const { s, items, restart } = await dispatchBacklog(200, { BILLING_DISPATCH_BATCH_SIZE: String(batch) });
        try {
          s.payHttp.setMode(mode);
          const seenBefore = s.payHttp.seen.length;
          await restart();
          const d = await drainDispatch(s, items);
          const calls = s.payHttp.seen.slice(seenBefore).filter((x) => x.method === 'POST' && x.url === '/payment/payments').length;
          rs.push({ ...d, paymentCalls: calls, payments: (await s.pq(`SELECT count(*)::int AS n FROM payment`))[0].n });
          log(`dispatcherBatch ${label} batch ${batch} run ${i + 1}: zero at ${d.timeToZeroMs} ms, left ${JSON.stringify(d.remainingAt)}, calls ${calls}, read p99 ${d.readLatency.p99}`);
        } finally {
          await s.close();
        }
      }
      out[`${label}_batch${batch}`] = { runs: rs, timeToZeroMs: medianOf(rs, (r) => r.timeToZeroMs) };
    }
  }
  return out;
};

C.dispatcherStale = async () => {
  // The stale-sending relationship, scaled down 6× (PAYMENT_TIMEOUT_MS 1 s, stale 10 s, batch 20 → a 20 s envelope) with TWO Billing
  // instances. Payment is hung for the first ~10.5 s after the first instance claims its batch, then healthy again. Every claimed row
  // was stamped `sendingSince` at claim time, so at the 10 s mark the idle second instance finds the WHOLE batch stale and re-sends it
  // while the first instance, Payment now fast, sends the same rows: two calls for one request within moments (a duplicate in flight;
  // safe by Payment's natural key, but a wasted call and a misleading `payment_dispatch_stale_recovery`). With the Stage 15.8 renewal the
  // first instance keeps its unsent claims fresh and the second finds nothing to take. 3 runs.
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const env = { BILLING_DISPATCH_BATCH_SIZE: '20', BILLING_DISPATCH_STALE_SENDING_MS: '10000', PAYMENT_TIMEOUT_MS: '1000', BILLING_DISPATCH_INTERVAL_MS: '500' };
    const { s, restart } = await dispatchBacklog(20, env);
    let second = null;
    try {
      s.payHttp.setMode('blackhole');
      await restart();
      const claimedAt = await h.waitFor(async () => (await s.bq(`SELECT count(*)::int AS n FROM payment_request WHERE status = 'sending'`))[0].n > 0 && h.now(), 30_000, 20);
      second = await core.start('billing-service', {
        db: s.bdb, databaseUrl: s.bdb.url, brokerUrl: rabbit.url,
        extra: { SERVICE_TOKENS: `test-producer:${s.producer.digest}`, PAYMENT_SERVICE_URL: s.payHttp.url, PAYMENT_SERVICE_TOKEN: s.b2p.token, AUTH_SERVICE_URL: s.auth.url, ...env },
      });
      await h.sleep(Math.max(0, claimedAt + 10_500 - h.now()));
      s.payHttp.setMode('pass'); // Payment recovers just after the stale mark
      await h.sleep(20_000);
      const calls = s.payHttp.seen.filter((x) => x.paymentRequestId && x.mode === 'pass');
      const byReq = new Map();
      for (const c of calls) byReq.set(c.paymentRequestId, [...(byReq.get(c.paymentRequestId) ?? []), c.t]);
      let closePairs = 0;
      for (const ts of byReq.values()) {
        ts.sort((a, b) => a - b);
        for (let k = 1; k < ts.length; k++) if (ts[k] - ts[k - 1] < 2000) closePairs++; // two successful-path calls for one request within 2 s
      }
      const lines = [s.procs.billing, second].flatMap((p) => p.lines).filter((l) => /payment_dispatch_stale_recovery/.test(String(l.msg))).length;
      const [st] = await s.bq(`SELECT count(*) FILTER (WHERE status = 'requested')::int AS requested, count(*)::int AS n FROM payment_request`);
      const [pay] = await s.pq(`SELECT count(*)::int AS n FROM payment`);
      runs.push({ callsAfterRecovery: calls.length, requestsCalledAfterRecovery: byReq.size, duplicateCallsWithin2s: closePairs, staleRecoveryLines: lines, requested: st.requested, requests: st.n, payments: pay.n });
      log(`dispatcherStale run ${i + 1}: ${JSON.stringify(runs.at(-1))}`);
    } finally {
      if (second?.alive()) { second.child.kill('SIGKILL'); await second.exited; }
      await s.close();
    }
  }
  return { runs, duplicates: medianOf(runs, (r) => r.duplicateCallsWithin2s) };
};

C.staleResend = async () => {
  // How long a request waits after a transient Payment failure (503) before it is sent again, and how long a normal send takes.
  const { s, items, restart } = await dispatchBacklog(10, {});
  try {
    s.payHttp.setMode('unavailable');
    await restart();
    await h.sleep(3000); // the first pass fails every send
    s.payHttp.setMode('pass');
    const t0 = h.now();
    const ok = await h.waitFor(async () => (await countRequested(s, items)) === items.length, 120_000, 250);
    const recoveredMs = ok ? h.round(h.now() - t0) : null;
    // normal send duration: a fresh request, Payment healthy
    const [x] = await s.seed(1, { wait: false });
    const t1 = h.now();
    await h.waitFor(async () => (await countRequested(s, [x])) === 1, 30_000, 20);
    return { recoveredAfterPaymentBackMs: recoveredMs, normalCreateToRequestedMs: h.round(h.now() - t1), note: 'the resend waits for BILLING_DISPATCH_STALE_SENDING_MS (60 s) after the failed send' };
  } finally {
    await s.close();
  }
};

// ------------------------------------------------------------------------------------------------ ExpirySweeper scan and index
C.sweeperIndex = async () => {
  // The sweeper's scan on 1 k … 500 k payments (97 % closed, 2 % open with a future expiry, 1 % open without one), without and with
  // the Stage 15.8 partial index; index size and the write cost of 10 k inserts with the index.
  const db = await h.throwawayDatabase(ADMIN, 'payment-service');
  const hasIndex = (await h.adminQuery(db.url, `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'payment_expiry_open_idx'`))[0].n === 1;
  const idxSql = `CREATE INDEX IF NOT EXISTS payment_expiry_open_idx ON payment ("expiresAt") WHERE status IN ('created', 'pending') AND "expiresAt" IS NOT NULL`;
  const sweepSql = `SELECT id FROM payment WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= now() AND status IN ('created', 'pending')`;
  const insert = (from, to) => h.adminQuery(db.url, `SET session_replication_role = replica;
    INSERT INTO payment (id, producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency, "expiresAt", status, "createdAt", "updatedAt", "closedAt")
    SELECT md5('p' || g)::uuid, 'billing-service', md5('r' || g)::uuid, 'invoice', 'src-' || g, 'user', 'u-' || (g % 1000), 'organization', md5('o' || (g % 50))::uuid::text, md5('o' || (g % 50))::uuid, 1000, 'TND',
           CASE WHEN g % 100 < 2 THEN now() + interval '1 day' WHEN g % 100 = 2 THEN NULL ELSE now() - make_interval(secs => g) END,
           CASE WHEN g % 100 < 3 THEN 'created' WHEN g % 2 = 0 THEN 'cancelled' ELSE 'expired' END, now() - make_interval(secs => g), now() - make_interval(secs => g),
           CASE WHEN g % 100 < 3 THEN NULL ELSE now() - make_interval(secs => g) END
      FROM generate_series(${from}, ${to}) g`);
  const out = { migrationIndexPresent: hasIndex, levels: {} };
  try {
    if (hasIndex) await h.adminQuery(db.url, 'DROP INDEX payment_expiry_open_idx'); // measured both ways at every level
    let done = 0;
    for (const L of [1_000, 10_000, 50_000, 100_000, 500_000]) {
      await insert(done + 1, L);
      done = L;
      await h.adminQuery(db.url, 'VACUUM ANALYZE payment');
      const without = await explain(db.url, sweepSql);
      await h.adminQuery(db.url, idxSql);
      await h.adminQuery(db.url, 'ANALYZE payment');
      const withIdx = await explain(db.url, sweepSql);
      const [sz] = await h.adminQuery(db.url, `SELECT pg_relation_size('payment_expiry_open_idx') AS idx, pg_relation_size('payment') AS heap, pg_indexes_size('payment') AS allidx`);
      await h.adminQuery(db.url, 'DROP INDEX payment_expiry_open_idx');
      out.levels[L] = { without, with: withIdx, indexBytes: Number(sz.idx), heapBytes: Number(sz.heap), allIndexesBytes: Number(sz.allidx) };
      log(`sweeperIndex ${L}: without ${without.ms.median} ms ${without.scans} | with ${withIdx.ms.median} ms ${withIdx.scans} | index ${sz.idx} B`);
    }
    // write overhead: 10 k more payments inserted without, then with, the index (3 runs each, fresh id ranges)
    const timeInsert = async (base) => { const t = h.now(); await insert(base + 1, base + 10_000); return h.round(h.now() - t); };
    const w = { without: [], with: [] };
    let base = 1_000_000;
    for (let i = 0; i < 3; i++) { w.without.push(await timeInsert(base)); base += 10_000; }
    await h.adminQuery(db.url, idxSql);
    for (let i = 0; i < 3; i++) { w.with.push(await timeInsert(base)); base += 10_000; }
    out.insert10k = { withoutMs: medianOf(w.without.map((x) => ({ x })), (r) => r.x), withMs: medianOf(w.with.map((x) => ({ x })), (r) => r.x) };
    return out;
  } finally {
    await db.drop();
  }
};

/** EXPLAIN (ANALYZE, BUFFERS) 3 times: median execution time and the scans used. */
async function explain(url, sql) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      await c.query('BEGIN');
      runs.push((await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN'][0]);
      await c.query('ROLLBACK');
    }
    const scans = new Set();
    const walk = (p) => { if (/Scan/.test(p['Node Type'])) scans.add(`${p['Node Type']}${p['Index Name'] ? `(${p['Index Name']})` : ''}`); for (const k of p.Plans ?? []) walk(k); };
    walk(runs[0].Plan);
    return { ms: medianOf(runs.map((r) => ({ x: r['Execution Time'] })), (r) => r.x), scans: [...scans].join(','), buffers: (runs[2].Plan['Shared Hit Blocks'] ?? 0) + (runs[2].Plan['Shared Read Blocks'] ?? 0) };
  } finally {
    await c.end();
  }
}

C.transitionIndex = async () => {
  // billing_transition with and without the duplicate non-unique index: catalog proof of redundancy, storage and insert cost at 200 k
  // rows, the plans of the two lookups that use it (the BI-19 history trigger, an entity's history).
  const db = await h.throwawayDatabase(ADMIN, 'billing-service');
  try {
    const defs = await h.adminQuery(db.url, `SELECT i.relname AS name, pg_get_indexdef(i.oid) AS def, x.indisunique AS "unique", x.indpred IS NOT NULL AS partial, c.conname AS constraint
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid LEFT JOIN pg_constraint c ON c.conindid = x.indexrelid WHERE x.indrelid = 'billing_transition'::regclass ORDER BY 1`);
    const fks = await h.adminQuery(db.url, `SELECT conname FROM pg_constraint WHERE confrelid = 'billing_transition'::regclass`);
    const present = defs.some((d) => d.name === 'billing_transition_entity_idx');
    const dupSql = `CREATE INDEX IF NOT EXISTS billing_transition_entity_idx ON billing_transition ("entityType", "entityId", revision)`;
    const load = (from, to) => h.adminQuery(db.url, `SET session_replication_role = replica;
      INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "causeType")
      SELECT 'payment_request', md5('e' || (g / 7))::uuid, CASE WHEN g % 7 = 0 THEN NULL ELSE 'created' END, 'sending', g % 7, 'system', 'dispatcher' FROM generate_series(${from}, ${to}) g`);
    const measureInsert = async (withDup, base) => {
      if (withDup) await h.adminQuery(db.url, dupSql); else await h.adminQuery(db.url, 'DROP INDEX IF EXISTS billing_transition_entity_idx');
      await h.adminQuery(db.url, 'TRUNCATE billing_transition');
      const t = h.now();
      await load(base, base + 199_999);
      const ms = h.round(h.now() - t);
      await h.adminQuery(db.url, 'VACUUM ANALYZE billing_transition');
      const [sz] = await h.adminQuery(db.url, `SELECT pg_indexes_size('billing_transition') AS idx, pg_total_relation_size('billing_transition') AS total`);
      const trig = await explain(db.url, `SELECT 1 FROM billing_transition WHERE "entityType" = 'payment_request' AND "entityId" = md5('e1000')::uuid AND "toStatus" = 'sending' AND revision = 3`);
      const hist = await explain(db.url, `SELECT * FROM billing_transition WHERE "entityType" = 'payment_request' AND "entityId" = md5('e1000')::uuid ORDER BY revision`);
      return { insert200kMs: ms, indexesBytes: Number(sz.idx), totalBytes: Number(sz.total), triggerLookup: trig, history: hist };
    };
    const runs = { withDuplicate: [], without: [] };
    for (let i = 0; i < 3; i++) {
      runs.withDuplicate.push(await measureInsert(true, i * 1_000_000));
      runs.without.push(await measureInsert(false, i * 1_000_000));
    }
    const sum = (rs) => ({ insert200kMs: medianOf(rs, (r) => r.insert200kMs), indexesBytes: rs[0].indexesBytes, totalBytes: rs[0].totalBytes, triggerLookup: rs[0].triggerLookup, history: rs[0].history });
    return { duplicatePresentAfterMigrations: present, indexes: defs, referencingForeignKeys: fks.map((f) => f.conname), withDuplicate: sum(runs.withDuplicate), without: sum(runs.without) };
  } finally {
    await db.drop();
  }
};

// ------------------------------------------------------------------------------------------------ kit: outbox relay batch / backoff
/** A producer database with the kit outbox and a relay publishing through a BrokerProxy to a counting consumer. */
async function relayWorld({ batchSize, maxBackoffMs, intervalMs = 1000 }) {
  const db = await h.throwawayDatabase(ADMIN, null);
  await runMigrations(db.url, [kitMigrationsDir]);
  const dbs = new DbService({ url: db.url, applicationName: 'validation-relay' });
  const proxy = new BrokerProxy({ host: '127.0.0.1', port: rabbit.port });
  await proxy.start();
  const fixedPort = proxy.port;
  const exchange = `validation.relay.${randomUUID().slice(0, 8)}`;
  const pub = new RabbitMqEventBus({ url: `amqp://guest:guest@127.0.0.1:${proxy.port}`, exchange, confirmTimeoutMs: 5000, connectTimeoutMs: 2000 });
  const sub = new RabbitMqEventBus({ url: rabbit.url, exchange });
  const got = new Map();
  await sub.subscribe({ queue: `${exchange}.q`, bindings: ['validation.#'], handler: async (e) => void got.set(e.id, (got.get(e.id) ?? 0) + 1) });
  const errors = [];
  const relay = new OutboxRelay(dbs, pub, { source: 'validation', batchSize, maxBackoffMs }, (m) => errors.push({ t: h.now(), m }));
  const outbox = new OutboxService();
  const enqueue = async (n) => {
    const payload = { filler: 'x'.repeat(600) }; // about the size of a Payment event (Stage 15.7: 733 B)
    await dbs.tx(async (q) => { for (let i = 0; i < n; i++) await outbox.enqueue(q, { name: 'validation.happened', payload }); });
  };
  const pending = async () => (await h.adminQuery(db.url, `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`))[0].n;
  return {
    relay, enqueue, pending, got, errors, proxy,
    start: () => relay.start(intervalMs),
    brokerDown: async () => { proxy.thaw(); await proxy.sever(); },
    brokerUp: async () => { proxy.port = fixedPort; await proxy.start(); },
    close: async () => { await relay.stop(); await pub.close(); await sub.close(); await proxy.sever().catch(() => undefined); await dbs.onApplicationShutdown(); await db.drop(); },
  };
}

C.outboxBatch = async () => {
  // Backlog of 5 000 events drained by ONE relay (interval 1 s) with batch 10 / 50 / 200: drain rate, the claim transaction's length,
  // duplicates (at least once, so a duplicate would be a redelivery, not a loss). 3 runs each.
  const out = {};
  for (const batch of [10, 50, 200]) {
    const rs = [];
    for (let i = 0; i < 3; i++) {
      const w = await relayWorld({ batchSize: batch });
      try {
        await w.enqueue(5000);
        const t0 = h.now();
        const marks = {};
        const passMs = [];
        while ((await w.pending()) > 0 && h.now() - t0 < 600_000) { // passes back to back measure the pass itself; the 1 s interval is added below
          const tp = h.now();
          await w.relay.drainOnce();
          passMs.push(h.now() - tp);
        }
        const elapsed = h.now() - t0;
        await h.sleep(1500);
        const dup = [...w.got.values()].filter((n) => n > 1).length;
        const sortedPass = [...passMs].sort((a, b) => a - b);
        const passMedian = sortedPass[Math.floor(sortedPass.length / 2)];
        rs.push({ passes: passMs.length, passMsMedian: h.round(passMedian), publishRatePerSInPass: h.round((batch / passMedian) * 1000), drainRateAt1sIntervalPerS: h.round(batch / ((passMedian + 1000) / 1000), 1), backToBackDrainMs: h.round(elapsed), delivered: w.got.size, duplicates: dup, marks });
      } finally {
        await w.close();
      }
    }
    out[`batch${batch}`] = { runs: rs, passMs: medianOf(rs, (r) => r.passMsMedian), drainRateAt1sInterval: medianOf(rs, (r) => r.drainRateAt1sIntervalPerS) };
    log(`outboxBatch ${batch}: pass ${out[`batch${batch}`].passMs.median} ms → ${out[`batch${batch}`].drainRateAt1sInterval.median}/s at the 1 s interval`);
  }
  return out;
};

C.outboxBackoff = async () => {
  // Broker unreachable for 90 s while 1 or 200 events wait; then back. Time from broker back to the backlog drained, and the relay's
  // failure lines during the outage, for the backoff ceiling 60 s (current) / 15 s / 5 s. 3 runs each.
  const out = {};
  for (const cap of BACKOFF_CAPS) {
    for (const backlog of [1, 200]) {
      const rs = [];
      for (let i = 0; i < 3; i++) {
        const w = await relayWorld({ maxBackoffMs: cap });
        try {
          await w.brokerDown();
          await w.enqueue(backlog);
          w.start();
          await h.sleep(90_000);
          const outageLines = w.errors.length;
          await w.brokerUp();
          const t0 = h.now();
          await h.waitFor(async () => (await w.pending()) === 0, 120_000, 100);
          rs.push({ drainAfterBrokerBackMs: h.round(h.now() - t0), outageFailureLinesPerMin: h.round(outageLines / 1.5, 1), delivered: w.got.size });
        } finally {
          await w.close();
        }
      }
      out[`cap${cap === undefined ? 'Default' : cap / 1000 + 's'}_backlog${backlog}`] = { runs: rs, drainMs: medianOf(rs, (r) => r.drainAfterBrokerBackMs), linesPerMin: medianOf(rs, (r) => r.outageFailureLinesPerMin) };
      log(`outboxBackoff cap ${cap / 1000}s backlog ${backlog}: drain ${JSON.stringify(out[`cap${cap === undefined ? 'Default' : cap / 1000 + 's'}_backlog${backlog}`].drainMs)} lines/min ${JSON.stringify(out[`cap${cap === undefined ? 'Default' : cap / 1000 + 's'}_backlog${backlog}`].linesPerMin)}`);
    }
  }
  return out;
};

C.outboxLoop = async () => {
  // The relay as services run it (its own poll loop, interval 1 s, batch 50): (a) a 5 000-event backlog, time to zero; (b) steady
  // production at 200 events/s for 30 s (about the invoice-create rate Billing sustained under the pressure profile): the backlog left
  // when production stops and the time to drain it. 3 runs each.
  const backlog = [];
  const steady = [];
  for (let i = 0; i < 3; i++) {
    const w = await relayWorld({ batchSize: 50 });
    try {
      await w.enqueue(5000);
      const t0 = h.now();
      w.start();
      const marks = {};
      while ((await w.pending()) > 0 && h.now() - t0 < 600_000) {
        const el = h.now() - t0;
        for (const m of [10, 30, 60]) if (el >= m * 1000 && marks[m] === undefined) marks[m] = await w.pending();
        await h.sleep(100);
      }
      backlog.push({ timeToZeroMs: h.round(h.now() - t0), remainingAt: marks, delivered: w.got.size, duplicates: [...w.got.values()].filter((n) => n > 1).length });
    } finally {
      await w.close();
    }
    const v = await relayWorld({ batchSize: 50 });
    try {
      v.start();
      const t0 = h.now();
      let produced = 0;
      while (h.now() - t0 < 30_000) {
        await v.enqueue(20); // 20 every 100 ms = 200/s
        produced += 20;
        await h.sleep(Math.max(0, 100 - ((h.now() - t0) % 100)));
      }
      const left = await v.pending();
      const t1 = h.now();
      await h.waitFor(async () => (await v.pending()) === 0, 600_000, 100);
      steady.push({ produced, pendingWhenProductionStopped: left, drainAfterMs: h.round(h.now() - t1) });
    } finally {
      await v.close();
    }
    log(`outboxLoop run ${i + 1}: backlog ${JSON.stringify(backlog.at(-1))} steady ${JSON.stringify(steady.at(-1))}`);
  }
  return { backlog, steady, backlogToZeroMs: medianOf(backlog, (r) => r.timeToZeroMs), steadyLeft: medianOf(steady, (r) => r.pendingWhenProductionStopped) };
};

C.readinessAfterLoad = async () => {
  // Stage 15.8 finding: right after the pressure profile, Billing and Payment answered /ready 503. Pressure for 30 s, then /ready every
  // 500 ms for 40 s with every readiness line and the outbox backlog, to name the failing check and how long it lasts.
  const w = await world();
  try {
    const t0 = h.now();
    await runLoad({ next: w.mix, concurrency: 64, durationMs: 30_000, warmupMs: 2000, ok: w.ok });
    const tEnd = h.now();
    const probes = [];
    while (h.now() - tEnd < 40_000) {
      const r = await w.s.readiness();
      const [bo] = await w.s.bq(`SELECT count(*) FILTER (WHERE "publishedAt" IS NULL)::int AS n FROM outbox`);
      probes.push({ s: h.round((h.now() - tEnd) / 1000, 1), billing: r.billing.ready, payment: r.payment.ready, billingOutboxPending: bo.n });
      await h.sleep(500);
    }
    const lines = ['billing', 'payment'].flatMap((n) => w.s.procs[n].since(t0).filter((l) => /readiness|rabbitmq|outbox/.test(String(l.msg))).map((l) => ({ svc: n, s: h.round((l.t - tEnd) / 1000, 1), msg: String(l.msg).slice(0, 160) })));
    return { probes, lines: lines.slice(0, 40), firstBilling200s: probes.find((p) => p.billing === 200)?.s ?? null, firstPayment200s: probes.find((p) => p.payment === 200)?.s ?? null };
  } finally {
    await w.close();
  }
};

C.readinessCost = async () => {
  // What one /ready costs (Billing and Payment open and close an AMQP connection per probe): latency of 100 probes each, the broker's
  // connection count and churn, and /health for comparison.
  const s = await stack();
  try {
    const out = {};
    const churn0 = rabbitConnectionsCreated();
    for (const n of ['billing', 'payment']) {
      const ready = [];
      const health = [];
      for (let i = 0; i < 100; i++) {
        ready.push((await probe(s.base(n), '/ready', 3000)).ms);
        health.push((await probe(s.base(n), '/health', 3000)).ms);
      }
      const q = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return h.round(a[Math.min(a.length - 1, Math.floor(p * a.length))], 2); };
      out[n] = { readyP50: q(ready, 0.5), readyP99: q(ready, 0.99), healthP50: q(health, 0.5), healthP99: q(health, 0.99) };
    }
    const churn1 = rabbitConnectionsCreated();
    out.brokerConnectionsOpenAfter = brokerView()?.connections ?? null;
    out.connectionsOpenedDuring200Probes = churn0 !== null && churn1 !== null ? churn1 - churn0 : null;
    return out;
  } finally {
    await s.close();
  }
};
/** RabbitMQ's cumulative count of connections opened (node statistics), for connection churn. */
function rabbitConnectionsCreated() {
  try {
    const raw = execFileSync('docker', ['exec', rabbit.name, 'rabbitmqctl', '-q', 'eval', 'lists:sum([C || {_, C} <- [{x, proplists:get_value(connection_created, rabbit_global_counters:overview())}]]).']).toString().trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

C.multiInstance = async () => {
  // 1 / 2 / 4 Billing processes on ONE database (each DB_POOL_MAX 10), a Billing read/write mix (75 / 25) spread round-robin at 64
  // concurrent clients: throughput, latency, observed sessions against the theoretical n × 10 and PostgreSQL's max_connections. 3 runs of 30 s.
  const w = await world({ withEdge: false });
  const extra = [];
  const out = {};
  try {
    const [{ max_connections: maxConn }] = await h.adminQuery(ADMIN, 'SHOW max_connections');
    for (const n of MULTI_COUNTS) {
      while (extra.length < n - 1) {
        extra.push(await core.start('billing-service', {
          db: w.s.bdb, databaseUrl: w.s.bdb.url, brokerUrl: rabbit.url,
          extra: { SERVICE_TOKENS: `test-producer:${w.s.producer.digest}`, PAYMENT_SERVICE_URL: w.s.payHttp.url, PAYMENT_SERVICE_TOKEN: w.s.b2p.token, AUTH_SERVICE_URL: w.s.auth.url, BILLING_RATE_LIMIT_INVOICE_CREATE_PER_MINUTE: '100000', BILLING_RATE_LIMIT_PAYMENT_REQUEST_CREATE_PER_MINUTE: '100000' },
        }));
      }
      const bases = [w.s.base('billing'), ...extra.slice(0, n - 1).map((p) => p.base)];
      let k = 0;
      const next = () => {
        const r = MULTI_MIX === 'read' || Math.random() < 0.75 ? w.R.billingRead() : w.R.billingWrite();
        const base = bases[k++ % bases.length];
        return { ...r, url: r.url.replace(w.s.base('billing'), base) };
      };
      const procs = Object.fromEntries([['billing', w.s.procs.billing], ...extra.slice(0, n - 1).map((p, i) => [`billing${i + 2}`, p])]);
      const runs = [];
      for (let i = 0; i < 3; i++) {
        let waits = {};
        let sampling = true;
        const waitSampler = (async () => { // what the Billing sessions wait on during the run (lock waits = contention)
          while (sampling) {
            const rows = await h.adminQuery(ADMIN, `SELECT coalesce(wait_event_type, 'cpu') || ':' || coalesce(wait_event, '-') AS w, count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND state = 'active' GROUP BY 1`, [w.s.bdb.name]).catch(() => []);
            for (const x of rows) waits[x.w] = (waits[x.w] ?? 0) + x.n;
            await h.sleep(500);
          }
        })();
        const r = await sampled(procs, () => runLoad({ next, concurrency: 64, durationMs: 30_000, warmupMs: 5000, ok: w.ok }));
        sampling = false;
        await waitSampler;
        runs.push({ waits, rps: r.result.rps, p50: r.result.p50, p99: r.result.p99, errorRate: r.result.errorRate, billingDbSessionsMax: r.sessionsByDbMax[w.s.bdb.name] ?? null, cpuPct: r.cpuPct, postgresCpuPct: r.postgresCpuPct });
      }
      out[`instances${n}`] = { theoreticalBillingConnections: n * 10, postgresMaxConnections: Number(maxConn), runs, rps: medianOf(runs, (r) => r.rps), p99: medianOf(runs, (r) => r.p99), sessions: medianOf(runs, (r) => r.billingDbSessionsMax) };
      log(`multiInstance ${n}: rps ${JSON.stringify(out[`instances${n}`].rps)} p99 ${JSON.stringify(out[`instances${n}`].p99)} sessions ${JSON.stringify(out[`instances${n}`].sessions)}`);
    }
    return out;
  } finally {
    for (const p of extra) if (p.alive()) { p.child.kill('SIGKILL'); await p.exited; }
    await w.close();
  }
};

// ------------------------------------------------------------------------------------------------ RabbitMQ prefetch (Billing consumer)
const BUS_DIST = new URL('../../libs/service-kit/dist/events/rabbitmq-event-bus.js', import.meta.url);
/** TEMPORARY test-only patch of the built bus's prefetch (always restored); the source is never changed by this campaign. */
async function withPrefetch(n, fn) {
  const { readFileSync, writeFileSync: wf } = await import('node:fs');
  const original = readFileSync(BUS_DIST, 'utf8');
  const current = /ch\.prefetch\((\d+)\)/.exec(original)?.[1];
  if (!current) throw new Error('prefetch call not found in the built bus');
  wf(BUS_DIST, original.replace(/ch\.prefetch\(\d+\)/, `ch.prefetch(${n})`));
  try {
    return await fn();
  } finally {
    wf(BUS_DIST, original);
  }
}

C.prefetch = async () => {
  // 300 settled payments whose events wait in Billing's queue while Billing is stopped; Billing restarts (pool 10) and drains them.
  // `--prefetch-values` picks the prefetch values applied by the temporary dist patch ("default" = the built value, no patch).
  // Clean drain: paid count polled every 100 ms (nothing blocking the loop), a Billing read every 100 ms, sessions every 500 ms. 3 runs.
  // Then one run with a SIGKILL mid-drain: the unacknowledged deliveries come back; the receipts keep one effect.
  const out = {};
  for (const n of PREFETCH_VALUES) {
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const kill = i === 3;
      const s = await stack();
      try {
        const items = await s.seed(300, { orgs: [randomUUID(), randomUUID(), randomUUID()] });
        await s.stop('billing');
        for (const x of items) await s.pay(x);
        await h.sleep(3000); // Payment's outbox has published every payment.succeeded
        const run = async () => {
          await s.start('billing');
          const t0 = h.now();
          let peakSessions = 0;
          let sessionsAt = 0;
          const lat = [];
          let killed = false;
          let zero = null;
          while (h.now() - t0 < 180_000) {
            const paid = (await s.bq(`SELECT count(*)::int AS n FROM payment_request WHERE status = 'paid'`))[0].n;
            if (h.now() - sessionsAt > 500) { sessionsAt = h.now(); peakSessions = Math.max(peakSessions, (await h.sessions(ADMIN, s.bdb.name)).total); }
            lat.push((await s.billingApi('GET', `/billing/invoices/${items[0].invoiceId}`)).ms);
            if (kill && !killed && paid >= 150) { killed = true; await s.kill('billing'); await s.start('billing'); }
            if (paid === items.length) { zero = h.round(h.now() - t0); break; }
            await h.sleep(100);
          }
          const sorted = [...lat].sort((a, b) => a - b);
          return { drainMs: zero, peakBillingSessions: peakSessions, readP50: h.round(sorted[Math.floor(sorted.length / 2)]), readP99: h.round(sorted[Math.floor(sorted.length * 0.99)] ?? sorted.at(-1)), killedMidDrain: killed };
        };
        const r = n === 'default' ? await run() : await withPrefetch(n, run);
        const acct = await s.account(items);
        // The consumer's own processing span (first to last receipt), independent of when /ready started answering.
        const [span] = await s.bq(`SELECT extract(epoch FROM max("receivedAt") - min("receivedAt")) * 1000 AS ms, count(*)::int AS n FROM payment_event_receipt WHERE "paymentRequestId" = ANY($1)`, [items.map((x) => x.requestId)]);
        runs.push({ ...r, consumerSpanMs: h.round(Number(span.ms)), eventsPerS: h.round(span.n / (Number(span.ms) / 1000), 1), paid: acct.requestStates.paid ?? 0, maxAppliedPerRequest: acct.maxAppliedPerRequest, maxPaymentsPerRequest: acct.maxPaymentsPerRequest });
        log(`prefetch ${n} run ${i + 1}${kill ? ' (kill)' : ''}: ${JSON.stringify(runs.at(-1))}`);
      } finally {
        await s.close();
      }
    }
    const clean = runs.filter((r) => !r.killedMidDrain);
    out[`prefetch_${n}`] = { runs, consumerSpanMs: medianOf(clean, (r) => r.consumerSpanMs), eventsPerS: medianOf(clean, (r) => r.eventsPerS), drainMs: medianOf(clean, (r) => r.drainMs), readP50: medianOf(clean, (r) => r.readP50), readP99: medianOf(clean, (r) => r.readP99), peakSessions: medianOf(clean, (r) => r.peakBillingSessions) };
  }
  return out;
};

// ------------------------------------------------------------------------------------------------ backlog recovery, fairness, responsiveness
C.backlogRecovery = async () => {
  const out = {};
  // (1) Expired payments: 1 000 payments already past their expiry (created through Payment's API), one of them held locked by another
  // session for the whole drain (an attempt start or settlement in progress). The real sweeper (every 5 s) drains them; a Payment read
  // is probed every 250 ms meanwhile.
  {
    const s = await stack({ startBilling: false });
    const locker = new pg.Client({ connectionString: s.pdb.url, application_name: 'validation-locker' });
    try {
      const past = new Date(Date.now() - 60_000).toISOString();
      const ids = [];
      for (let i = 0; i < 1000; i++) {
        const org = randomUUID();
        const r = await s.call(s.base('payment'), 'POST', '/payment/payments', { token: s.b2p.token, body: { paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${i}`, payer: { type: 'user', id: `u-${i}` }, seller: { type: 'organization', id: org }, organizationId: org, amount: 1000, currency: 'TND', expiresAt: past } });
        ids.push(r.json.id);
      }
      await locker.connect();
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [ids[0]]);
      const t0 = h.now();
      const marks = {};
      const lat = [];
      let zero = null;
      while (h.now() - t0 < 120_000) {
        lat.push((await s.call(s.base('payment'), 'GET', `/payment/payments/${ids[1]}`, { token: s.b2p.token })).ms);
        const [{ n }] = await s.pq(`SELECT count(*)::int AS n FROM payment WHERE id = ANY($1) AND status = 'created'`, [ids]);
        const el = h.now() - t0;
        for (const m of [10, 30, 60]) if (el >= m * 1000 && marks[m] === undefined) marks[m] = n;
        if (n <= 1) { zero = h.round(el); break; } // everything but the locked payment
        await h.sleep(250);
      }
      const lockedStatus = (await s.pq(`SELECT status FROM payment WHERE id = $1`, [ids[0]]))[0].status;
      await locker.query('COMMIT');
      const tr = h.now();
      await h.waitFor(async () => (await s.pq(`SELECT status FROM payment WHERE id = $1`, [ids[0]]))[0].status === 'expired', 30_000, 200);
      const [ev] = await s.pq(`SELECT count(*)::int AS n, count(DISTINCT payload->>'paymentId')::int AS d FROM outbox WHERE name = 'payment.expired'`);
      const sorted = [...lat].sort((a, b) => a - b);
      out.expiredPayments = { backlog: 1000, remainingAt: marks, allButLockedExpiredMs: zero, lockedStatusDuringDrain: lockedStatus, lockedExpiredAfterReleaseMs: h.round(h.now() - tr), expiredEvents: ev.n, distinctExpiredEvents: ev.d, paymentReadP50: h.round(sorted[Math.floor(sorted.length / 2)]), paymentReadP99: h.round(sorted[Math.floor(sorted.length * 0.99)] ?? sorted.at(-1)) };
      log(`backlog expiredPayments: ${JSON.stringify(out.expiredPayments)}`);
    } finally {
      await locker.end().catch(() => undefined);
      await s.close();
    }
  }
  // (2) Outbox: RabbitMQ unreachable for Payment while 300 payments are paid; broker back → remaining at 10 / 30 / 60 s; Billing applies each once.
  {
    const s = await stack();
    try {
      const items = await s.seed(300, { orgs: [randomUUID(), randomUUID()] });
      await s.brokerProxy.payment.down();
      for (const x of items) await s.pay(x);
      await h.sleep(60_000); // a long enough outage for the relay's backoff to grow
      await s.brokerProxy.payment.up();
      const t0 = h.now();
      const marks = {};
      let zero = null;
      while (h.now() - t0 < 180_000) {
        const [{ n }] = await s.pq(`SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`);
        const el = h.now() - t0;
        for (const m of [10, 30, 60]) if (el >= m * 1000 && marks[m] === undefined) marks[m] = n;
        if (n === 0) { zero = h.round(el); break; }
        await h.sleep(250);
      }
      await h.waitFor(async () => (await s.bq(`SELECT count(*)::int AS n FROM payment_request WHERE status = 'paid'`))[0].n === 300, 60_000, 250);
      const acct = await s.account(items);
      out.outbox = { backlogEvents: 300, remainingAt: marks, timeToZeroMs: zero, paid: acct.requestStates.paid ?? 0, maxAppliedPerRequest: acct.maxAppliedPerRequest };
      log(`backlog outbox: ${JSON.stringify(out.outbox)}`);
    } finally {
      await s.close();
    }
  }
  // (3) Dispatcher fairness: 200 requests waiting; a NEW request created 2 s into the drain — when is it sent?
  {
    const { s, items, restart } = await dispatchBacklog(200, {});
    try {
      await restart();
      await h.sleep(2000);
      const [x] = await s.seed(1, { wait: false });
      const t0 = h.now();
      await h.waitFor(async () => (await countRequested(s, [x])) === 1, 180_000, 100);
      const newSentMs = h.round(h.now() - t0);
      await h.waitFor(async () => (await countRequested(s, items)) === items.length, 180_000, 250);
      out.dispatchFairness = { backlog: 200, newRequestSentAfterMs: newSentMs, order: 'FIFO by createdAt: new work waits behind older work, bounded by the backlog size' };
      log(`backlog dispatchFairness: ${JSON.stringify(out.dispatchFairness)}`);
    } finally {
      await s.close();
    }
  }
  return out;
};

// ------------------------------------------------------------------------------------------------ run
const names = args.length ? args : Object.keys(C);
const results = {};
const started = new Date().toISOString();
try {
  for (const n of names) {
    if (!C[n]) throw new Error(`unknown campaign ${n}`);
    log(`campaign ${n} ...`);
    const t = Date.now();
    try {
      results[n] = { ...(await C[n]()), durationS: h.round((Date.now() - t) / 1000) };
    } catch (e) {
      results[n] = { error: describeFailure(e), message: String(e?.message).slice(0, 300), stack: String(e?.stack).split('\n').slice(0, 4) };
      log(`campaign ${n} ERROR ${describeFailure(e)} ${String(e?.message).slice(0, 200)}`);
    }
  }
} finally {
  const env = await h.environment(ADMIN).catch(() => ({}));
  try { rabbit.queues(); } catch { await rabbit.appStart().catch(() => undefined); }
  rabbit.stop();
  pgc.stop();
  const doc = JSON.stringify({ env: { ...env, rabbitmq: '3.13 (throwaway container)' }, started, runSeconds: RUN_S, runs: RUNS, results, uncaughtOrUnhandled: uncaught, finished: new Date().toISOString() }, null, 1);
  if (outFile) writeFileSync(outFile, doc);
  else process.stdout.write(doc + '\n');
}
