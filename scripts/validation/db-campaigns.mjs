#!/usr/bin/env node
// Stage 15.2: database stress and recovery campaigns (test-only). Plan and criteria: docs/architecture/core-validation.md.
//
//   VALIDATION_DATABASE_ADMIN_URL=postgres://postgres:<pw>@127.0.0.1:<port>/postgres \
//   VALIDATION_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672 \
//     node scripts/validation/db-campaigns.mjs [--out results.json] [campaign ...]      (default: all, in plan order)
//
// Needs built workspaces. Refuses production, non-loopback hosts and any cluster hosting real Core databases (use a throwaway
// PostgreSQL container). Every campaign creates and drops its own databases. Prints progress on stderr and one JSON document to --out
// (or stdout: prefer --out, because editor tooling that injects itself into Node processes can write to stdout too).
// Library-level campaigns drive the services' own DbService classes (kit and Auth) with the Stage 14 defaults unless a campaign
// states an override (only to avoid waiting the 30 s / 60 s production bounds on every iteration; the default is verified separately).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { DbModule, DbService, HealthModule, OutboxRelay, OutboxService, ReadinessRegistry, describeFailure, kitMigrationsDir, runMigrations } from '../../libs/service-kit/dist/index.js';
import { BrokerProxy } from '../../libs/service-kit/dist/testing/broker-proxy.js';
import { DbService as AuthDbService } from '../../apps/auth-service/dist/db/db.service.js';
import * as h from './lib/harness.mjs';

const ADMIN = process.env.VALIDATION_DATABASE_ADMIN_URL;
const BROKER = process.env.VALIDATION_RABBITMQ_URL ?? 'amqp://guest:guest@127.0.0.1:5672';
await h.assertThrowawayCluster(ADMIN);
h.assertLoopbackBroker(BROKER);
const PG_PORT = Number(new URL(ADMIN).port || 5432);
const log = (...a) => process.stderr.write(`[15.2] ${a.join(' ')}\n`);
const failureOf = async (p) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return describeFailure(e);
  }
};
const poolOf = (db) => db.pool; // test-only: pg-pool counters of the service's own pool
const counts = (db) => ({ total: poolOf(db).totalCount, idle: poolOf(db).idleCount, waiting: poolOf(db).waitingCount });
let uncaught = 0;
process.on('uncaughtException', (e) => {
  uncaught++;
  log('UNCAUGHT', describeFailure(e));
});
const closers = [];
const kitDb = (url, o = {}) => {
  const d = new DbService({ url, applicationName: 'validation', ...o });
  closers.push(() => d.onApplicationShutdown().catch(() => undefined));
  return d;
};
const newProxy = async () => {
  const p = new BrokerProxy({ host: '127.0.0.1', port: PG_PORT });
  await p.start();
  closers.push(async () => {
    p.thaw();
    await p.sever();
  });
  return p;
};
const port = () => 4700 + Math.floor(Math.random() * 1200);
const quiet = (l) => !String(l.msg).includes('Console Ninja');
const warnErr = (lines) => lines.filter((l) => quiet(l) && (l.level === 'warn' || l.level === 'error'));
const dominant = (lines) => {
  const m = {};
  for (const l of lines) {
    const k = String(l.msg).split(' ')[0];
    m[k] = (m[k] ?? 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k}×${n}`);
};

// ------------------------------------------------------------------------------------------------ campaigns
const C = {};

C.control = async () => {
  const db = await h.throwawayDatabase(ADMIN, 'billing-service');
  const svc = h.launch('billing-service', h.serviceEnv('billing-service', { databaseUrl: db.url, brokerUrl: BROKER, port: port() }));
  try {
    const ready = await h.waitFor(async () => (await svc.status('/ready', 2000)).status === 200 && h.now(), 20_000, 20);
    await h.sleep(3000);
    const health = [], readyMs = [];
    for (let i = 0; i < 50; i++) health.push((await svc.status('/health')).ms);
    for (let i = 0; i < 50; i++) readyMs.push((await svc.status('/ready')).ms);
    const lib = kitDb(db.url);
    const sel = [];
    await lib.query('SELECT 1');
    for (let i = 0; i < 200; i++) {
      const t = h.now();
      await lib.query('SELECT 1');
      sel.push(h.now() - t);
    }
    const s0 = h.processSample(svc.child.pid);
    await h.sleep(5000);
    const s1 = h.processSample(svc.child.pid);
    return {
      startupToReadyMs: h.round(ready - svc.t0), healthMs: h.stats(health), readyMs: h.stats(readyMs), select1Ms: h.stats(sel),
      libraryPool: counts(lib), serverSessions: await h.sessions(ADMIN, db.name), rssMb: h.round(s1.rssMb), cpuPct: h.cpuPercent(s0, s1),
      warnOrErrorLines: warnErr(svc.lines).length,
    };
  } finally {
    await svc.stop();
    await db.drop();
  }
};

C.poolSaturation = async () => {
  // Every caller runs one statement holding its client for HOLD ms. Callers beyond DB_POOL_MAX (10) queue for a client, bounded by
  // DB_CONNECTION_TIMEOUT_MS (5000, default). HOLD 6000 > 5000: the queued callers must FAIL at ~5 s. HOLD 2000: they must SUCCEED late.
  const db = await h.throwawayDatabase(ADMIN, null);
  const out = { curve: [], queued: [], leak: [] };
  try {
    const point = async (c, hold) => {
      const d = kitDb(db.url); // defaults: max 10, connection timeout 5000
      let peakWaiting = 0, peakServer = 0;
      const sampler = setInterval(async () => {
        peakWaiting = Math.max(peakWaiting, poolOf(d).waitingCount);
        peakServer = Math.max(peakServer, (await h.sessions(ADMIN, db.name)).total);
      }, 100);
      const res = await Promise.all(Array.from({ length: c }, async () => {
        const t = h.now();
        const r = await failureOf(d.query(`SELECT pg_sleep(${hold / 1000})`));
        return { r, ms: h.now() - t };
      }));
      clearInterval(sampler);
      const ok = res.filter((x) => x.r === 'ok'), bad = res.filter((x) => x.r !== 'ok');
      const t = h.now();
      const after = await failureOf(d.query('SELECT 1'));
      const recoveryMs = h.now() - t;
      await h.sleep(300);
      const row = {
        concurrency: c, holdMs: hold, succeeded: ok.length, failed: bad.length, failureKinds: [...new Set(bad.map((x) => x.r))],
        okLatencyMs: ok.length ? h.stats(ok.map((x) => x.ms)) : null, failLatencyMs: bad.length ? h.stats(bad.map((x) => x.ms)) : null,
        peakWaiting, peakServerSessions: peakServer, afterSelect1: after, afterMs: h.round(recoveryMs), poolAfter: counts(d),
      };
      await d.onApplicationShutdown();
      return row;
    };
    for (const c of [1, 5, 9, 10, 11, 15, 20]) for (let run = 0; run < 3; run++) out.curve.push({ run, ...(await point(c, 6000)) });
    for (const c of [11, 20]) out.queued.push(await point(c, 2000));
    // Leak check: ONE long-lived pool saturated 20 times in a row; the pool and the server must return to the same state every time.
    const d = kitDb(db.url);
    for (let i = 0; i < 20; i++) {
      await Promise.all(Array.from({ length: 15 }, () => failureOf(d.query('SELECT pg_sleep(0.3)'))));
      await Promise.all(Array.from({ length: 12 }, () => failureOf(d.tx(async (q) => {
        await q.query('SELECT 1');
        throw new Error('rollback on purpose');
      }))));
      await h.sleep(200);
      const s = await h.sessions(ADMIN, db.name);
      out.leak.push({ i, pool: counts(d), serverSessions: s.total, idleInTx: s.byState['idle in transaction'] ?? 0, active: s.byState.active ?? 0 });
    }
    log('poolSaturation done');
    return out;
  } finally {
    await db.drop();
  }
};

C.statementTimeout = async () => {
  const db = await h.throwawayDatabase(ADMIN, null);
  try {
    const dflt = kitDb(db.url);
    const configured = (await dflt.query('SHOW statement_timeout')).rows[0].statement_timeout;
    await h.adminQuery(db.url, 'CREATE TABLE marker (id uuid PRIMARY KEY)');
    const d = kitDb(db.url, { statementTimeoutMs: 1000 }); // test override (minimum allowed bound), default verified above
    const plain = [], inTx = [];
    for (let i = 0; i < 20; i++) {
      const t = h.now();
      const f = await failureOf(d.query('SELECT pg_sleep(3)'));
      const ms = h.now() - t;
      plain.push({ f, ms, after: await failureOf(d.query('SELECT 1')) });
    }
    for (let i = 0; i < 20; i++) {
      const id = randomUUID();
      const t = h.now();
      const f = await failureOf(d.tx(async (q) => {
        await q.query('INSERT INTO marker VALUES ($1)', [id]);
        await q.query('SELECT pg_sleep(3)');
      }));
      const ms = h.now() - t;
      const leaked = (await d.query('SELECT count(*)::int AS n FROM marker WHERE id = $1', [id])).rows[0].n;
      const next = randomUUID();
      const nextTx = await failureOf(d.tx((q) => q.query('INSERT INTO marker VALUES ($1)', [next])));
      const committed = (await d.query('SELECT count(*)::int AS n FROM marker WHERE id = $1', [next])).rows[0].n;
      inTx.push({ f, ms, partialCommit: leaked, nextTx, nextCommitted: committed });
    }
    log('statementTimeout done');
    return {
      defaultStatementTimeout: configured,
      outside: { runs: 20, kinds: [...new Set(plain.map((x) => x.f))], cancelMs: h.stats(plain.map((x) => x.ms)), afterAllOk: plain.every((x) => x.after === 'ok') },
      insideTx: {
        runs: 20, kinds: [...new Set(inTx.map((x) => x.f))], cancelMs: h.stats(inTx.map((x) => x.ms)), partialCommits: inTx.reduce((a, x) => a + x.partialCommit, 0),
        nextTxAllCommitted: inTx.every((x) => x.nextTx === 'ok' && x.nextCommitted === 1),
      },
      pool: counts(d),
    };
  } finally {
    await db.drop();
  }
};

C.idleTransaction = async () => {
  const db = await h.throwawayDatabase(ADMIN, null);
  try {
    await h.adminQuery(db.url, 'CREATE TABLE acct (id int PRIMARY KEY, v int NOT NULL)');
    await h.adminQuery(db.url, 'INSERT INTO acct VALUES (1, 0)');
    const dflt = kitDb(db.url);
    const configured = (await dflt.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout;
    const a = kitDb(db.url, { idleInTransactionTimeoutMs: 1000 }); // test override; default verified above
    const b = kitDb(db.url, { statementTimeoutMs: 10_000 });
    const runs = [];
    for (let i = 0; i < 20; i++) {
      const before = uncaught;
      let lockedAt = 0;
      const txA = failureOf(a.tx(async (q) => {
        await q.query('UPDATE acct SET v = v + 1000 WHERE id = 1'); // row lock held
        lockedAt = h.now();
        await h.sleep(2500); // idle inside the transaction: PostgreSQL ends the session at ~1 s
        await q.query('SELECT 1');
      }));
      await h.waitFor(() => lockedAt > 0, 5000, 5);
      const tB = h.now();
      const fB = await failureOf(b.tx((q) => q.query('UPDATE acct SET v = v + 1 WHERE id = 1')));
      const lockReleasedAfterMs = h.now() - lockedAt;
      const bWaitedMs = h.now() - tB;
      const fA = await txA;
      runs.push({ fA, fB, lockReleasedAfterMs, bWaitedMs, uncaught: uncaught - before, poolA: counts(a), afterA: await failureOf(a.query('SELECT 1')) });
    }
    const v = (await a.query('SELECT v FROM acct WHERE id = 1')).rows[0].v;
    log('idleTransaction done');
    return {
      defaultIdleTimeout: configured, runs: 20, kindsA: [...new Set(runs.map((r) => r.fA))], transactionB: [...new Set(runs.map((r) => r.fB))],
      lockReleasedAfterMs: h.stats(runs.map((r) => r.lockReleasedAfterMs)), bWaitedMs: h.stats(runs.map((r) => r.bWaitedMs)),
      processCrashes: runs.reduce((x, r) => x + r.uncaught, 0), poolAfterEach: runs.at(-1).poolA, afterAllOk: runs.every((r) => r.afterA === 'ok'),
      finalValue: v, expectedValue: 20, // only B's +1 per run may commit; A's +1000 never
    };
  } finally {
    await db.drop();
  }
};

C.lockContention = async () => {
  const db = await h.throwawayDatabase(ADMIN, null);
  try {
    await h.adminQuery(db.url, 'CREATE TABLE acct (id int PRIMARY KEY, v int NOT NULL)');
    await h.adminQuery(db.url, 'INSERT INTO acct VALUES (1, 0)');
    const holder = kitDb(db.url);
    const waiter = kitDb(db.url, { statementTimeoutMs: 1000 }); // lock waits count toward statement_timeout (no lock_timeout is set)
    const runs = [];
    for (let i = 0; i < 20; i++) {
      let release;
      const gate = new Promise((r) => (release = r));
      let locked = false;
      const hold = holder.tx(async (q) => {
        await q.query('UPDATE acct SET v = v + 1 WHERE id = 1');
        locked = true;
        await gate;
      });
      await h.waitFor(() => locked, 5000, 5);
      const t = h.now();
      const f = await failureOf(waiter.tx((q) => q.query('UPDATE acct SET v = v + 100 WHERE id = 1')));
      const ms = h.now() - t;
      release();
      await hold;
      const next = await failureOf(waiter.tx((q) => q.query('UPDATE acct SET v = v + 100 WHERE id = 1')));
      runs.push({ f, ms, next, pool: counts(waiter) });
    }
    const v = (await holder.query('SELECT v FROM acct WHERE id = 1')).rows[0].v;
    log('lockContention done');
    return { runs: 20, kinds: [...new Set(runs.map((r) => r.f))], waitMs: h.stats(runs.map((r) => r.ms)), nextAllOk: runs.every((r) => r.next === 'ok'), finalValue: v, expectedValue: 20 + 20 * 100 };
  } finally {
    await db.drop();
  }
};

C.midQueryDisconnect = async () => {
  const db = await h.throwawayDatabase(ADMIN, null);
  try {
    await h.adminQuery(db.url, 'CREATE TABLE marker (id uuid PRIMARY KEY)');
    const proxy = await newProxy();
    const d = kitDb(h.via(db.url, proxy.port), { connectionTimeoutMs: 2000 });
    const q1 = [], tx = [];
    for (let i = 0; i < 20; i++) {
      await d.query('SELECT 1');
      const before = uncaught;
      const p = failureOf(d.query('SELECT pg_sleep(2)'));
      await h.sleep(300);
      await proxy.sever();
      const f = await p;
      await proxy.start();
      const after = [];
      for (let k = 0; k < 15; k++) after.push(await failureOf(d.query('SELECT 1'))); // a poisoned client would fail here
      q1.push({ f, uncaught: uncaught - before, afterOk: after.every((x) => x === 'ok'), pool: counts(d) });
    }
    for (let i = 0; i < 20; i++) {
      const [a, b] = [randomUUID(), randomUUID()];
      const before = uncaught;
      const f = await failureOf(d.tx(async (q) => {
        await q.query('INSERT INTO marker VALUES ($1)', [a]);
        await q.query('INSERT INTO marker VALUES ($1)', [b]);
        await proxy.sever(); // before COMMIT is sent: the outcome is not ambiguous
      }));
      await proxy.start();
      const present = (await h.adminQuery(db.url, 'SELECT count(*)::int AS n FROM marker WHERE id = ANY($1)', [[a, b]]))[0].n;
      const fresh = randomUUID();
      const next = await failureOf(d.tx((q) => q.query('INSERT INTO marker VALUES ($1)', [fresh])));
      const nextPresent = (await h.adminQuery(db.url, 'SELECT count(*)::int AS n FROM marker WHERE id = $1', [fresh]))[0].n;
      tx.push({ f, present, next, nextPresent, uncaught: uncaught - before });
    }
    log('midQueryDisconnect done');
    return {
      midQuery: { runs: 20, kinds: [...new Set(q1.map((x) => x.f))], processCrashes: q1.reduce((a, x) => a + x.uncaught, 0), allLaterQueriesOk: q1.every((x) => x.afterOk), poolAfter: q1.at(-1).pool },
      midTransaction: {
        runs: 20, kinds: [...new Set(tx.map((x) => x.f))], partialRowsFound: tx.reduce((a, x) => a + x.present, 0), processCrashes: tx.reduce((a, x) => a + x.uncaught, 0),
        freshTxAllCommitted: tx.every((x) => x.next === 'ok' && x.nextPresent === 1),
      },
    };
  } finally {
    await db.drop();
  }
};

C.connectionStall = async () => {
  // freeze(): TCP stays open, the client's bytes reach PostgreSQL, but nothing comes back (a black-holed network path).
  const db = await h.throwawayDatabase(ADMIN, null);
  try {
    const proxy = await newProxy();
    const url = h.via(db.url, proxy.port);
    const newConn = [], established = [], ready = [];
    for (let i = 0; i < 3; i++) {
      // 1. a NEW connection during the stall: bounded by DB_CONNECTION_TIMEOUT_MS (default 5000)?
      proxy.freeze();
      const d = kitDb(url);
      let t = h.now();
      const f = await failureOf(d.query('SELECT 1'));
      newConn.push({ f, ms: h.now() - t });
      proxy.thaw();
      const recovered = await failureOf(d.query('SELECT 1'));
      newConn.at(-1).afterThaw = recovered;
      // 2. readiness during the stall: bounded by the registry's per-check timeout (2000)?
      const reg = new ReadinessRegistry(2000, () => undefined);
      const r = new DbService({ url, applicationName: 'validation' }, reg);
      closers.push(() => r.onApplicationShutdown().catch(() => undefined));
      r.onModuleInit();
      await r.query('SELECT 1');
      proxy.freeze();
      t = h.now();
      const res = await reg.run();
      ready.push({ ok: res.ok, failed: res.failed, ms: h.now() - t });
      proxy.thaw();
      // 3. a query on an ALREADY-ESTABLISHED connection during the stall: what bounds it? (observed for up to 45 s)
      const e = kitDb(url);
      await e.query('SELECT 1');
      proxy.freeze();
      t = h.now();
      const q = failureOf(e.query('SELECT 1'));
      const settled = await Promise.race([q.then((v) => ({ v })), h.sleep(45_000).then(() => undefined)]);
      const stalledMs = h.now() - t;
      proxy.thaw();
      const lateResult = settled ? settled.v : await Promise.race([q, h.sleep(5000).then(() => 'still pending 5 s after thaw')]);
      established.push({ settledWithin45s: Boolean(settled), stalledMs, result: lateResult, afterThaw: await failureOf(e.query('SELECT 1')) });
      log(`connectionStall run ${i} done`);
    }
    return { newConnection: newConn, readinessDuringStall: ready, establishedConnection: established };
  } finally {
    await db.drop();
  }
};

C.readinessUnderExhaustion = async () => {
  // A real Nest app with the kit's HealthModule + DbModule at their defaults (pool 10, connect 5000, readiness check 2000).
  const db = await h.throwawayDatabase(ADMIN, 'billing-service');
  class App {}
  Module({ imports: [HealthModule.forRoot(), DbModule.forRoot({ url: db.url, applicationName: 'validation', migrations: { dirs: [kitMigrationsDir, `${h.root}apps/billing-service/db/migrations`] } })] })(App);
  const app = await NestFactory.create(App, { logger: false });
  await app.listen(0);
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const d = app.get(DbService);
  const get = async (p) => {
    const t = h.now();
    const r = await fetch(base + p, { signal: AbortSignal.timeout(15_000) }).catch(() => ({ status: 'timeout' }));
    return { status: r.status, ms: h.now() - t };
  };
  const runs = [];
  try {
    for (let i = 0; i < 20; i++) {
      let release;
      const gate = new Promise((r) => (release = r));
      const holders = Array.from({ length: 10 }, () => d.tx(async (q) => {
        await q.query('SELECT 1');
        await gate;
      }));
      await h.waitFor(() => poolOf(d).idleCount === 0 && poolOf(d).totalCount === 10, 5000, 5);
      const [ready, health] = await Promise.all([get('/ready'), get('/health')]);
      release();
      await Promise.all(holders);
      const t = h.now();
      const back = await h.waitFor(async () => (await get('/ready')).status === 200, 10_000, 20);
      runs.push({ ready, health, readyRecoveredMs: back ? h.now() - t : null, pool: counts(d) });
    }
    log('readinessUnderExhaustion done');
    return {
      runs: 20, readyStatuses: [...new Set(runs.map((r) => r.ready.status))], readyMs: h.stats(runs.map((r) => r.ready.ms)),
      healthStatuses: [...new Set(runs.map((r) => r.health.status))], healthMs: h.stats(runs.map((r) => r.health.ms)),
      recoveredMs: h.stats(runs.map((r) => r.readyRecoveredMs ?? NaN)), poolAfter: runs.at(-1).pool,
    };
  } finally {
    await app.close();
    await db.drop();
  }
};

async function outageCycles(service, cycles, probeEveryMs = 100) {
  // Runtime outage and recovery, service process kept running. DATABASE_URL uses host `localhost` (as CI does), so Node's multi-address
  // connect produces an AggregateError: the logs must still say `error=Error code=ECONNREFUSED kind=network_unreachable`.
  const db = await h.throwawayDatabase(ADMIN, service);
  const proxy = await newProxy();
  const u = new URL(h.via(db.url, proxy.port));
  u.hostname = 'localhost';
  const svc = h.launch(service, h.serviceEnv(service, { databaseUrl: u.toString(), brokerUrl: BROKER, port: port() }));
  const readyPath = '/ready';
  const out = [];
  try {
    await h.waitFor(async () => (await svc.status(readyPath, 2000)).status === 200, 20_000, 20);
    await h.sleep(2000);
    for (let c = 0; c < cycles; c++) {
      const s0 = h.processSample(svc.child.pid);
      const sessBefore = (await h.sessions(ADMIN, db.name)).total;
      const tDown = h.now();
      await proxy.sever();
      let readyDownAt, liveness = new Set(), authHealth = new Set();
      const probes = [];
      while (h.now() - tDown < 10_000) {
        const [r, l] = await Promise.all([svc.status(readyPath, 5000), svc.status('/health', 5000)]);
        probes.push(r);
        liveness.add(l.status);
        if (service === 'auth-service') authHealth.add((await svc.status('/auth/health', 7000)).status);
        if (r.status === 503 && !readyDownAt) readyDownAt = h.now();
        await h.sleep(probeEveryMs);
      }
      const s1 = h.processSample(svc.child.pid);
      const downLines = svc.since(tDown, quiet);
      const tUp = h.now();
      await proxy.start();
      const upAt = await h.waitFor(async () => (await svc.status(readyPath, 5000)).status === 200 && h.now(), 30_000, Math.max(50, probeEveryMs));
      await h.sleep(1500);
      const s2 = h.processSample(svc.child.pid);
      const outageLines = downLines.filter((l) => l.level === 'warn' || l.level === 'error');
      out.push({
        cycle: c, readyDetectMs: readyDownAt ? h.round(readyDownAt - tDown) : null, readyProbeMs: h.stats(probes.map((p) => p.ms)),
        livenessStatuses: [...liveness], authHealthStatuses: service === 'auth-service' ? [...authHealth] : undefined,
        recoveryMs: upAt ? h.round(upAt - tUp) : null,
        readinessLogs: svc.since(tDown, (l) => /readiness_check_(failed|recovered)/.test(String(l.msg))).map((l) => String(l.msg).split(' —')[0]),
        warnPerSec: h.round(outageLines.filter((l) => l.level === 'warn').length / 10, 2), errorPerSec: h.round(outageLines.filter((l) => l.level === 'error').length / 10, 2),
        dominant: dominant(outageLines), aggregateErrorInLogs: svc.lines.some((l) => String(l.msg).includes('AggregateError')),
        sessionsBefore: sessBefore, sessionsAfter: (await h.sessions(ADMIN, db.name)).total,
        rssMb: [h.round(s0.rssMb), h.round(s1.rssMb), h.round(s2.rssMb)], cpuPctDuringOutage: h.cpuPercent(s0, s1), alive: svc.alive(),
      });
      log(`${service} cycle ${c}: ready 503 after ${out.at(-1).readyDetectMs} ms, 200 again after ${out.at(-1).recoveryMs} ms`);
      await h.sleep(2000);
    }
    const leaks = svc.lines.filter((l) => /postgres(ql)?:\/\/[^ ]*:[^ ]*@|guest:guest/.test(l.raw)).length;
    return { service, cycles: out, credentialLinesInLogs: leaks, crashed: !svc.alive() };
  } finally {
    await svc.stop();
    await db.drop();
  }
}
C.runtimeOutage = async () => ({ billing: await outageCycles('billing-service', 5), auth: await outageCycles('auth-service', 5, 1000) });
// Auth applies its baseline rate limit to every route, /health and /ready included: probing 10 times a second is answered 429 and hides
// the result. Auth is therefore probed once a second (still far above the compose healthcheck's once every 10 s).
C.authOutage = async () => outageCycles('auth-service', 5, 1000);

C.connectBlackhole = async () => {
  // A listener that accepts TCP and never answers: what a new connection meets on a hung server or a black-holed path.
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('error', () => undefined);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const hole = `postgres://validation:unused@127.0.0.1:${server.address().port}/validation`;
  const runs = [];
  try {
    for (let i = 0; i < 5; i++) {
      const d = kitDb(hole); // defaults: DB_CONNECTION_TIMEOUT_MS 5000
      const t = h.now();
      runs.push({ f: await failureOf(d.query('SELECT 1')), ms: h.now() - t });
    }
    const reg = new ReadinessRegistry(2000, () => undefined);
    const r = new DbService({ url: hole }, reg);
    closers.push(() => r.onApplicationShutdown().catch(() => undefined));
    r.onModuleInit();
    const t = h.now();
    const res = await reg.run();
    return { runs: 5, kinds: [...new Set(runs.map((x) => x.f))], connectMs: h.stats(runs.map((x) => x.ms)), readiness: { failed: res.failed, ms: h.round(h.now() - t) } };
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
};

const serverFrozen = async (extraEnv = {}) => {
  // `docker pause` of the THROWAWAY PostgreSQL container: the server process is frozen while its kernel still accepts and acknowledges
  // TCP (a hung or frozen database host). Requires VALIDATION_PG_CONTAINER naming the container that publishes the admin URL's port.
  const name = process.env.VALIDATION_PG_CONTAINER;
  if (!name) return { skipped: 'VALIDATION_PG_CONTAINER not set' };
  const ports = execFileSync('docker', ['port', name, '5432/tcp']).toString();
  if (!ports.includes(`:${PG_PORT}`)) throw new Error(`container ${name} does not publish port ${PG_PORT}: refusing to pause it`);
  const docker = (cmd) => execFileSync('docker', [cmd, name]);
  const db = await h.throwawayDatabase(ADMIN, 'billing-service');
  const svc = h.launch('billing-service', h.serviceEnv('billing-service', { databaseUrl: db.url, brokerUrl: BROKER, port: port(), extra: extraEnv }));
  let paused = false;
  try {
    await h.waitFor(async () => (await svc.status('/ready', 2000)).status === 200, 20_000, 50);
    const lib = kitDb(db.url, extraEnv.DB_STATEMENT_TIMEOUT_MS ? { statementTimeoutMs: Number(extraEnv.DB_STATEMENT_TIMEOUT_MS), queryTimeoutMs: Number(extraEnv.DB_QUERY_TIMEOUT_MS) } : {});
    await lib.query('SELECT 1');
    await h.sleep(3000);
    const FREEZE_MS = 40_000;
    docker('pause');
    paused = true;
    const tFreeze = h.now();
    const inFlight = failureOf(lib.query('SELECT 1')).then((f) => ({ f, ms: h.now() - tFreeze })); // established connection
    const fresh = kitDb(db.url);
    const tNew = h.now();
    const newConn = await failureOf(fresh.query('SELECT 1'));
    const newConnMs = h.now() - tNew;
    const probes = [];
    while (h.now() - tFreeze < FREEZE_MS) {
      probes.push({ at: h.round(h.now() - tFreeze), ready: (await svc.status('/ready', 5000)), health: (await svc.status('/health', 5000)).status });
      await h.sleep(2000);
    }
    const settledDuringFreeze = await Promise.race([inFlight.then(() => true), h.sleep(1).then(() => false)]);
    const linesDuringFreeze = svc.since(tFreeze, (l) => quiet(l) && (l.level === 'warn' || l.level === 'error'));
    docker('unpause');
    paused = false;
    const tThaw = h.now();
    const inFlightResult = await Promise.race([inFlight, h.sleep(10_000).then(() => ({ f: 'still pending 10 s after unpause' }))]);
    const readyAgain = await h.waitFor(async () => (await svc.status('/ready', 5000)).status === 200 && h.now(), 30_000, 100);
    await h.sleep(10_000); // worker passes after the database returns
    const passFailures = svc.since(tFreeze, (l) => /_pass_failure/.test(String(l.msg)));
    const firstPassFailure = passFailures[0];
    const afterUnpause = svc.since(tThaw + 2000, (l) => quiet(l) && (l.level === 'warn' || l.level === 'error'));
    return {
      config: Object.keys(extraEnv).length ? extraEnv : 'defaults (statement 30 s, query deadline 35 s)',
      firstWorkerFailureAfterMs: firstPassFailure ? h.round(firstPassFailure.t - tFreeze) : null,
      firstWorkerFailure: firstPassFailure ? String(firstPassFailure.msg).split(' —')[0] : null,
      workerFailuresDuringFreeze: passFailures.filter((l) => l.t < tThaw).length,
      warnOrErrorFrom2sAfterUnpauseFor10s: dominant(afterUnpause),
      freezeMs: FREEZE_MS,
      establishedQuery: { settledDuringFreeze, result: inFlightResult.f, returnedAfterMs: h.round(inFlightResult.ms ?? NaN), note: 'returnedAfterMs counts from the freeze' },
      newConnection: { result: newConn, ms: h.round(newConnMs) },
      readyDuringFreeze: [...new Set(probes.map((p) => p.ready.status))], readyProbeMs: h.stats(probes.map((p) => p.ready.ms)), healthDuringFreeze: [...new Set(probes.map((p) => p.health))],
      workerSignalsDuringFreeze: dominant(linesDuringFreeze), readyAfterUnpauseMs: readyAgain ? h.round(readyAgain - tThaw) : null, alive: svc.alive(),
    };
  } finally {
    if (paused) docker('unpause');
    await svc.stop();
    await db.drop();
  }
};
C.serverFrozen = () => serverFrozen();
// Test-specific short bounds (never a production value): several worker passes fit inside one freeze.
C.serverFrozenShortBounds = () => serverFrozen({ DB_STATEMENT_TIMEOUT_MS: '1000', DB_QUERY_TIMEOUT_MS: '3000' });

async function startupUnavailable(service) {
  const db = await h.throwawayDatabase(ADMIN, service);
  const proxy = new BrokerProxy({ host: '127.0.0.1', port: PG_PORT });
  await proxy.start();
  const p = proxy.port;
  await proxy.sever(); // the port is now closed: PostgreSQL "down" at service start
  closers.push(async () => proxy.sever());
  const svc = h.launch(service, h.serviceEnv(service, { databaseUrl: h.via(db.url, p), brokerUrl: BROKER, port: port() }));
  try {
    const live = await h.waitFor(async () => (await svc.status('/health', 2000)).status === 200 && h.now(), 20_000, 20);
    const statusesDown = [];
    for (let i = 0; i < 5; i++) statusesDown.push((await svc.status('/ready', 5000)).status);
    const tUp = h.now();
    await proxy.start(); // same port, same configuration
    const upAt = await h.waitFor(async () => (await svc.status('/ready', 5000)).status === 200 && h.now(), 30_000, 50);
    return {
      service, processAlive: svc.alive(), livenessAfterMs: live ? h.round(live - svc.t0) : null, readyWhileDown: [...new Set(statusesDown)],
      recoveredWithoutRestartMs: upAt ? h.round(upAt - tUp) : null, stillAlive: svc.alive(),
      firstFailureLog: String(svc.lines.find((l) => l.level === 'warn' || l.level === 'error')?.msg ?? '').split(' —')[0],
    };
  } finally {
    await svc.stop();
    await db.drop();
  }
}
C.startupUnavailable = async () => {
  const r = [];
  for (const s of ['billing-service', 'auth-service', 'payment-service', 'organization-service']) for (let i = 0; i < 3; i++) r.push({ run: i, ...(await startupUnavailable(s)) });
  log('startupUnavailable done');
  return r;
};

C.authLibrary = async () => {
  // Auth's OWN DbService (not the kit's), wired as Auth wires it: config-driven pool and a 1500 ms readiness registry.
  const db = await h.throwawayDatabase(ADMIN, 'auth-service');
  const cfg = (o = {}) => ({ databaseUrl: db.url, db: { poolMax: 10, connectionTimeoutMs: 5000, statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 60_000, ...o } });
  const mk = (o, reg) => {
    const a = new AuthDbService(cfg(o), reg);
    closers.push(() => a.onModuleDestroy().catch(() => undefined));
    return a;
  };
  try {
    const dflt = mk();
    const shown = (await dflt.query(`SELECT current_setting('statement_timeout') AS s, current_setting('idle_in_transaction_session_timeout') AS i`)).rows[0];
    const st = mk({ statementTimeoutMs: 1000 });
    const stRuns = [];
    for (let i = 0; i < 10; i++) {
      const t = h.now();
      stRuns.push({ f: await failureOf(st.query('SELECT pg_sleep(3)')), ms: h.now() - t, after: await failureOf(st.query('SELECT 1')) });
    }
    const reg = new ReadinessRegistry(1500, () => undefined);
    const ex = mk({}, reg);
    ex.onModuleInit();
    const exRuns = [];
    for (let i = 0; i < 10; i++) {
      let release;
      const gate = new Promise((r) => (release = r));
      const holders = Array.from({ length: 10 }, () => ex.tx(async (q) => {
        await q.query('SELECT 1');
        await gate;
      }));
      await h.waitFor(() => ex.pool.idleCount === 0 && ex.pool.totalCount === 10, 5000, 5);
      let t = h.now();
      const r = await reg.run();
      const readyMs = h.now() - t;
      t = h.now();
      const authHealthSelect = await failureOf(ex.query('SELECT 1')); // what GET /auth/health does, with no wrapper of its own
      const authHealthMs = h.now() - t;
      release();
      await Promise.all(holders);
      exRuns.push({ ready: r, readyMs, authHealthSelect, authHealthMs, after: (await reg.run()).ok });
    }
    const unreachable = new URL(db.url);
    unreachable.hostname = 'localhost';
    unreachable.port = '1';
    const refused = new AuthDbService({ databaseUrl: unreachable.toString(), db: cfg().db }, undefined);
    let t = h.now();
    const refusal = await failureOf(refused.query('SELECT 1'));
    const refusalMs = h.now() - t;
    await refused.onModuleDestroy();
    log('authLibrary done');
    return {
      serverDefaults: shown,
      statementTimeout: { runs: 10, kinds: [...new Set(stRuns.map((x) => x.f))], cancelMs: h.stats(stRuns.map((x) => x.ms)), afterAllOk: stRuns.every((x) => x.after === 'ok') },
      exhaustion: {
        runs: 10, readyFailed: [...new Set(exRuns.map((x) => x.ready.failed.join(',')))], readyMs: h.stats(exRuns.map((x) => x.readyMs)),
        authHealthSelect: [...new Set(exRuns.map((x) => x.authHealthSelect))], authHealthMs: h.stats(exRuns.map((x) => x.authHealthMs)), recoveredAll: exRuns.every((x) => x.after),
      },
      refusal: { kind: refusal, ms: h.round(refusalMs) },
    };
  } finally {
    await db.drop();
  }
};

C.connectionAccounting = async () => {
  const measure = async (svcs, label) => {
    const burst = async () => Promise.all(svcs.flatMap((s) => Array.from({ length: 40 }, () => s.status('/ready', 10_000))));
    let peak = { total: 0 };
    const sampler = setInterval(async () => {
      const s = await h.sessions(ADMIN);
      if (s.total > peak.total) peak = s;
    }, 50);
    await burst();
    await burst();
    clearInterval(sampler);
    await h.sleep(300);
    const afterBurst = await h.sessions(ADMIN);
    await h.sleep(12_000); // pg-pool closes idle clients after 10 s (idleTimeoutMillis default)
    const settled = await h.sessions(ADMIN);
    return { scenario: label, processes: svcs.length, configuredMax: svcs.length * 10, peakTotal: peak.total, peakByDatabase: peak.byDatabase, afterBurst: afterBurst.total, afterIdle12s: settled.total };
  };
  const rows = [];
  const all = [];
  try {
    const dbs = {};
    for (const s of ['auth-service', 'organization-service', 'billing-service', 'payment-service']) {
      dbs[s] = await h.throwawayDatabase(ADMIN, s);
      all.push(dbs[s]);
    }
    let svcs = [];
    for (const s of Object.keys(dbs)) svcs.push(h.launch(s, h.serviceEnv(s, { databaseUrl: dbs[s].url, brokerUrl: BROKER, port: port() })));
    await Promise.all(svcs.map((s) => h.waitFor(async () => (await s.status('/ready', 2000)).status === 200, 20_000, 50)));
    await h.sleep(2000);
    rows.push({ ...(await measure(svcs, 'four services, 1 replica each')), idleBaseline: (await h.sessions(ADMIN)).total });
    for (const s of svcs) await s.stop();
    for (const n of [1, 2, 3]) {
      svcs = Array.from({ length: n }, () => h.launch('billing-service', h.serviceEnv('billing-service', { databaseUrl: dbs['billing-service'].url, brokerUrl: BROKER, port: port() })));
      await Promise.all(svcs.map((s) => h.waitFor(async () => (await s.status('/ready', 2000)).status === 200, 20_000, 50)));
      await h.sleep(2000);
      rows.push(await measure(svcs, `billing-service × ${n}`));
      for (const s of svcs) await s.stop();
    }
    log('connectionAccounting done');
    return rows;
  } finally {
    for (const d of all) await d.drop();
  }
};

C.relayConnectionHold = async () => {
  // DB side only: how many pool clients do relays hold while the broker is slow? A fake bus whose publish takes 5 s stands in for a
  // publisher-confirm timeout (the real broker campaign is 15.3).
  const db = await h.throwawayDatabase(ADMIN, null);
  try {
    await runMigrations(db.url, [kitMigrationsDir]);
    const d = kitDb(db.url);
    const outbox = new OutboxService();
    for (let i = 0; i < 200; i++) await d.tx((q) => outbox.enqueue(q, { name: 'validation.probe', payload: { i } }));
    const slowBus = { publish: () => h.sleep(5000).then(() => { throw new Error('confirm timeout (simulated)'); }), subscribe: async () => ({ close: async () => undefined }), close: async () => undefined };
    const rows = [];
    for (const relays of [1, 3]) {
      const rs = Array.from({ length: relays }, () => new OutboxRelay(d, slowBus, { source: 'validation' }));
      const passes = rs.map((r) => r.drainOnce());
      await h.sleep(1000);
      const during = counts(d);
      const s = await h.sessions(ADMIN, db.name);
      const results = await Promise.all(passes);
      rows.push({ relays, poolDuringSlowPublish: during, idleInTransactionSessions: s.byState['idle in transaction'] ?? 0, results, poolAfter: counts(d) });
    }
    log('relayConnectionHold done');
    return rows;
  } finally {
    await db.drop();
  }
};

const frozenShutdown = async (extraEnv = {}) => {
  // SIGTERM while the database is frozen and worker passes are waiting on it (a Stage 15.5 observation, recorded here for I9).
  const name = process.env.VALIDATION_PG_CONTAINER;
  if (!name) return { skipped: 'VALIDATION_PG_CONTAINER not set' };
  if (!execFileSync('docker', ['port', name, '5432/tcp']).toString().includes(`:${PG_PORT}`)) throw new Error(`refusing to pause ${name}`);
  const db = await h.throwawayDatabase(ADMIN, 'billing-service');
  const svc = h.launch('billing-service', h.serviceEnv('billing-service', { databaseUrl: db.url, brokerUrl: BROKER, port: port(), extra: extraEnv }));
  let paused = false;
  try {
    await h.waitFor(async () => (await svc.status('/ready', 2000)).status === 200, 20_000, 50);
    await h.sleep(3000);
    execFileSync('docker', ['pause', name]);
    paused = true;
    await h.sleep(2500); // the relay (1 s) and the dispatcher (2 s) have started passes that now wait on the frozen server
    const t = h.now();
    svc.child.kill('SIGTERM');
    const exit = await Promise.race([svc.exited, h.sleep(60_000).then(() => undefined)]);
    const exitMs = exit ? h.round(exit.t - t) : null;
    const phases = svc.since(t, (l) => /service_shutdown|worker_drain_timeout|_pass_failure/.test(String(l.msg))).map((l) => `${h.round(l.t - t)}ms ${String(l.msg).split(' —')[0]}`);
    return { config: Object.keys(extraEnv).length ? extraEnv : 'defaults', exitedWithin60s: Boolean(exit), sigtermToExitMs: exitMs, exit: exit ? exit.code ?? exit.signal : 'still running', phases };
  } finally {
    if (paused) execFileSync('docker', ['unpause', name]);
    if (svc.alive()) svc.child.kill('SIGKILL');
    await db.drop();
  }
};

C.frozenShutdown = () => frozenShutdown();
C.frozenShutdownShortBounds = () => frozenShutdown({ DB_STATEMENT_TIMEOUT_MS: '1000', DB_QUERY_TIMEOUT_MS: '3000' });

// ------------------------------------------------------------------------------------------------ run
const order = ['control', 'poolSaturation', 'statementTimeout', 'idleTransaction', 'lockContention', 'midQueryDisconnect', 'connectionStall', 'connectBlackhole', 'serverFrozen', 'serverFrozenShortBounds', 'frozenShutdown', 'frozenShutdownShortBounds', 'readinessUnderExhaustion', 'startupUnavailable', 'runtimeOutage', 'authLibrary', 'connectionAccounting', 'relayConnectionHold'];
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outFile = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
const wanted = args.length ? args : order;
const report = { env: await h.environment(ADMIN), started: new Date().toISOString(), results: {} };
for (const name of wanted) {
  if (!C[name]) throw new Error(`unknown campaign ${name}`);
  log(`campaign ${name} ...`);
  const t = h.now();
  try {
    const r = await C[name]();
    report.results[name] = Array.isArray(r) ? { durationS: 0, rows: r } : { durationS: 0, ...r };
  } catch (e) {
    report.results[name] = { error: describeFailure(e), message: String(e?.message).slice(0, 300) };
  }
  report.results[name].durationS = h.round((h.now() - t) / 1000);
}
for (const c of closers.reverse()) await c();
report.uncaughtExceptions = uncaught;
report.finished = new Date().toISOString();
if (outFile) (await import('node:fs')).writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
else console.log(JSON.stringify(report, null, 2));
process.exit(0);
