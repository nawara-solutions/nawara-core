#!/usr/bin/env node
// Stage 15.5: shutdown and restart campaigns (test-only). Plan, invariants S1–S15 and criteria: docs/architecture/core-validation.md.
//
//   node scripts/validation/shutdown-campaigns.mjs [--out results.json] [campaign ...]      (default: all, in plan order)
//
// Starts its OWN throwaway RabbitMQ and PostgreSQL containers (`validation-*`, loopback) and removes them at the end; the Docker-stop
// campaigns also run the services as containers from `validation-<service>:15-5` images (built from this checkout) on their own
// `validation-net-*` network. Never touches another container, a non-loopback host or production. Needs built workspaces.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { PollLoop, describeFailure } from '../../libs/service-kit/dist/index.js';
import { BrokerProxy } from '../../libs/service-kit/dist/testing/broker-proxy.js';
import * as h from './lib/harness.mjs';
import { liveCore, probe, timeline } from './lib/live-core.mjs';
import http from 'node:http';
import { paymentEventPublisher } from './lib/fake-payment.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('refusing to run with NODE_ENV=production');
const log = (...a) => process.stderr.write(`[15.5] ${a.join(' ')}\n`);
let uncaught = 0;
process.on('uncaughtException', (e) => {
  uncaught++;
  log('UNCAUGHT', describeFailure(e), String(e?.message).slice(0, 160));
});
process.on('unhandledRejection', (e) => {
  uncaught++;
  log('UNHANDLED', describeFailure(e), String(e?.message).slice(0, 160));
});

const rabbit = await h.throwawayRabbit();
const pgc = await h.throwawayPostgres();
const ADMIN = pgc.adminUrl;
log(`throwaway broker ${rabbit.name} :${rabbit.port}, postgres ${pgc.name} :${pgc.port}`);
const core = liveCore({ adminUrl: ADMIN, rabbit });
const closers = [];
const later = (fn) => closers.push(fn);

// ------------------------------------------------------------------------------------------------ helpers
/** A pg client holding an open transaction (the "other worker" of a lock campaign). */
async function holder(url) {
  const c = new pg.Client({ connectionString: url, application_name: 'validation-holder' });
  await c.connect();
  await c.query('BEGIN');
  return { q: (sql, p) => c.query(sql, p), release: async () => { await c.query('COMMIT').catch(() => undefined); await c.end().catch(() => undefined); } };
}
const sessionsOf = async (db) => h.sessions(ADMIN, db.name);
const waitingOnLock = async (db) => (await h.adminQuery(ADMIN, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [db.name]))[0].n;
const leftovers = async (db) => {
  const s = await sessionsOf(db);
  const [l] = await h.adminQuery(ADMIN, `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database WHERE d.datname = $1 AND l.locktype IN ('tuple', 'transactionid', 'advisory') AND l.pid <> pg_backend_pid()`, [db.name]);
  return { sessions: s.total, idleInTransaction: s.byState['idle in transaction'] ?? 0, locks: l.n };
};

// ------------------------------------------------------------------------------------------------ campaigns
const C = {};

C.idleBaseline = async () => {
  // 3 idle SIGTERMs per service: signal → shutdown started → complete → exit, and what /ready and /health answer meanwhile.
  const out = {};
  for (const service of ['auth-service', 'organization-service', 'billing-service', 'payment-service']) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const db = await h.throwawayDatabase(ADMIN, service);
      try {
        const svc = await core.start(service, { db, extra: service === 'auth-service' ? { NODE_ENV: 'development' } : {} });
        await h.sleep(1500);
        const r = await core.signalAndWatch(svc);
        runs.push({ ...r, leftover: await leftovers(db) });
      } finally {
        await db.drop();
      }
    }
    out[service] = { timeline: timeline(runs), phases: runs[0].phases, leftovers: runs.map((r) => r.leftover) };
    log(`idleBaseline ${service}: exit ${JSON.stringify(out[service].timeline.exitedMs)}`);
  }
  return out;
};

C.httpInFlight = async () => {
  // Billing: an `issue` request blocked on the invoice's row lock (held by another transaction) is in flight when SIGTERM arrives.
  // (1) the lock is released 2 s later; (2) it is never released (the statement timeout ends the wait). New requests are sent every
  // 100 ms throughout. Auth: requests every 20 ms across SIGTERM (its pool closes in onModuleDestroy, before the HTTP server).
  const out = {};
  for (const [label, releaseAfterMs] of [['lockReleasedAfter2s', 2000], ['lockNeverReleased', null]]) {
    const w = await core.billingWorld();
    try {
      const svc = await w.startBilling();
      const org = randomUUID();
      const [, other] = await w.seed(2, { orgs: [org], waitRequested: false });
      const draft = await w.api('POST', '/billing/invoices', {
        invoiceRequestId: randomUUID(), seller: { type: 'organization', id: org }, payer: { type: 'user', id: 'payer-inflight' }, sourceType: 'contract', sourceId: 'src-inflight',
        issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: (await w.q(`SELECT id FROM price LIMIT 1`))[0].id, quantity: 1 }],
      });
      const lock = await holder(w.db.url);
      await lock.q('SELECT 1 FROM invoice WHERE id = $1 FOR UPDATE', [draft.json.id]);
      const tReq = h.now();
      const inflight = w.api('POST', `/billing/invoices/${draft.json.id}/issue`).then((r) => ({ status: r.status, code: r.json?.code, ms: h.round(h.now() - tReq) }), (e) => ({ status: 'error', error: describeFailure(e), ms: h.round(h.now() - tReq) }));
      await h.waitFor(async () => (await waitingOnLock(w.db)) > 0, 5000, 20);
      const news = [];
      let sending = true;
      const sender = (async () => {
        while (sending) {
          const t = h.now();
          const r = await probe(svc.base, `/billing/invoices/${other.invoiceId}`, 2000);
          news.push({ t, status: r.status });
          await h.sleep(100);
        }
      })();
      let tSig;
      const released = releaseAfterMs === null ? null : h.sleep(releaseAfterMs + 60).then(() => lock.release());
      const r = await core.signalAndWatch(svc, { limitMs: 90_000, onSignal: (t) => (tSig = t) });
      sending = false;
      await sender;
      await released;
      if (releaseAfterMs === null) await lock.release();
      const res = await inflight;
      const [inv] = await w.q('SELECT status FROM invoice WHERE id = $1', [draft.json.id]);
      const after = news.filter((x) => x.t >= tSig);
      const acceptedAfterSignal = after.filter((x) => x.status === 200);
      out[label] = {
        inFlightRequest: res, invoiceStatusAfter: inv.status, exitedMs: r.exitedMs, exit: r.exit,
        newRequestsAfterSignal: { sent: after.length, ok200: acceptedAfterSignal.length, lastOkMs: acceptedAfterSignal.length ? h.round(acceptedAfterSignal.at(-1).t - tSig) : null, statuses: [...new Set(after.map((x) => x.status))] },
        readyLast200Ms: r.readyLast200Ms, connectionsRefusedMs: r.connectionsRefusedMs, phases: r.phases, leftover: await leftovers(w.db),
      };
      log(`httpInFlight ${label}: in-flight ${JSON.stringify(res)} exit ${r.exitedMs} ms`);
    } finally {
      await w.close();
    }
  }
  // Auth: a stream of DB-backed requests across SIGTERM.
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const db = await h.throwawayDatabase(ADMIN, 'auth-service');
    try {
      const svc = await core.start('auth-service', { db, extra: { NODE_ENV: 'development' } });
      const seen = [];
      let go = true;
      const streams = Array.from({ length: 4 }, async () => {
        while (go) {
          const t = h.now();
          seen.push({ t, status: (await probe(svc.base, '/auth/health', 2000)).status });
          await h.sleep(20);
        }
      });
      await h.sleep(300);
      let tSig;
      const r = await core.signalAndWatch(svc, { onSignal: (t) => (tSig = t) });
      go = false;
      await Promise.all(streams);
      const after = seen.filter((x) => x.t >= tSig);
      runs.push({ exitedMs: r.exitedMs, exit: r.exit, afterSignal: after.reduce((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {}), first503Ms: (() => { const f = after.find((x) => x.status === 503); return f ? h.round(f.t - tSig) : null; })() });
    } finally {
      await db.drop();
    }
  }
  out.authRequestsAcrossSigterm = runs;
  return out;
};

C.keepAlive = async () => {
  // Minimal reproducer. A client reuses ONE keep-alive connection (http.Agent keepAlive, maxSockets 1), as a reverse proxy's pooled
  // upstream connection does, and SIGTERM arrives while a request is IN FLIGHT on it (a `/ready`, ~60 ms, sent 15 ms earlier). The
  // client then keeps sending on that connection (every 10 ms) for 20 s, then stops. Controls: the same with the connection idle at
  // SIGTERM (a request every 200 ms, SIGTERM between two) and with a fresh connection per request. 3 runs per mode and service.
  const out = {};
  for (const service of ['billing-service', 'payment-service']) {
    const rows = [];
    for (const mode of ['keepAliveBusyAtSigterm', 'keepAliveIdleAtSigterm', 'freshConnections']) {
      for (let i = 0; i < 3; i++) {
        const db = await h.throwawayDatabase(ADMIN, service);
        try {
          const svc = await core.start(service, { db });
          const agent = mode === 'freshConnections' ? false : new http.Agent({ keepAlive: true, maxSockets: 1 });
          const gap = mode === 'keepAliveIdleAtSigterm' ? 200 : 10;
          const answers = [];
          let go = true;
          let tS = null;
          let n = 0;
          const client = (async () => {
            while (go) {
              const t = h.now();
              n++;
              if (n === 20 && mode !== 'keepAliveIdleAtSigterm') setTimeout(() => { tS = h.now(); svc.child.kill('SIGTERM'); }, 15);
              const r = await new Promise((resolve) => {
                const req = http.get(`${svc.base}/ready`, { agent }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
                req.on('error', (e) => resolve(e.code ?? 'error'));
              });
              answers.push({ t, r });
              if (n === 20 && mode === 'keepAliveIdleAtSigterm') setTimeout(() => { tS = h.now(); svc.child.kill('SIGTERM'); }, 100);
              await h.sleep(gap);
            }
          })();
          await h.waitFor(() => tS !== null, 30_000, 5);
          const exitedWhileClientRuns = await Promise.race([svc.exited.then((x) => h.round(x.t - tS)), h.sleep(20_000).then(() => null)]);
          const tStop = h.now();
          go = false;
          await client;
          const ex = await Promise.race([svc.exited, h.sleep(30_000).then(() => null)]);
          if (!ex) svc.child.kill('SIGKILL');
          const after = answers.filter((a) => a.t >= tS);
          const ok = after.filter((a) => a.r === 200);
          rows.push({
            mode, run: i, exitedWhileClientRunsMs: exitedWhileClientRuns, exitAfterClientStoppedMs: exitedWhileClientRuns === null && ex ? h.round(ex.t - tStop) : null,
            answersAfterSigterm: after.reduce((m, a) => ((m[a.r] = (m[a.r] ?? 0) + 1), m), {}), last200AfterSigtermMs: ok.length ? h.round(ok.at(-1).t - tS) : null,
            phases: svc.since(tS, (l) => /shutdown|drain/.test(String(l.msg))).map((l) => `${h.round(l.t - tS)}ms ${String(l.msg).split(' —')[0]}`),
          });
          if (agent) agent.destroy();
        } finally {
          await db.drop();
        }
      }
    }
    out[service] = rows;
    log(`keepAlive ${service}: ${rows.map((r) => `${r.mode}:${r.exitedWhileClientRunsMs ?? 'HUNG'}`).join(' ')}`);
  }
  return out;
};

/**
 * Test-only barriers inside Billing's consumer transaction (`applyPaymentEvent`), installed in the THROWAWAY database: an event whose
 * id is listed in `validation_barrier` for stage B blocks right after its first mutation (the receipt INSERT), for stage C inside
 * COMMIT (a deferred constraint trigger), until the harness releases advisory lock 4242. Stage A needs no trigger: the harness holds
 * the invoice row lock, so the transaction waits before its first mutation.
 */
async function installConsumerBarriers(dbUrl) {
  await h.adminQuery(dbUrl, `
    CREATE TABLE validation_barrier (event_id text PRIMARY KEY, stage text NOT NULL);
    CREATE FUNCTION validation_wait() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM validation_barrier WHERE event_id = NEW."eventId"::text AND stage = TG_ARGV[0]) THEN
        PERFORM pg_advisory_lock_shared(4242);
        PERFORM pg_advisory_unlock_shared(4242);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER validation_b AFTER INSERT ON payment_event_receipt FOR EACH ROW EXECUTE FUNCTION validation_wait('B');
    CREATE CONSTRAINT TRIGGER validation_c AFTER INSERT ON payment_event_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validation_wait('C');`);
}

C.consumerWindows = async () => {
  // Billing's payment-event consumer, a real RabbitMQ delivery of `payment.succeeded`, stopped at three points of its transaction:
  //   A: waiting for the invoice lock (before the first mutation); B: after the receipt INSERT (first mutation), before COMMIT;
  //   C: inside COMMIT. Modes: `sigtermRelease` (SIGTERM, barrier released 1 s later: inside the 5 s consumer drain), `sigkill`
  //   (SIGKILL, barrier released 300 ms after the death: for C the COMMIT then completes on the server with no client to ack),
  //   `sigtermHold` (SIGTERM, barrier held until the process exits; default statement timeout 30 s).
  // After each: the state right after the death (no partial state), then a fresh instance: the event is applied exactly once.
  const w = await core.billingWorld();
  const pub = paymentEventPublisher(rabbit.url);
  const plan = [];
  for (const window of ['A', 'B', 'C']) {
    for (let i = 0; i < 20; i++) plan.push({ window, mode: 'sigtermRelease' });
    for (let i = 0; i < 20; i++) plan.push({ window, mode: 'sigkill' });
    for (let i = 0; i < 3; i++) plan.push({ window, mode: 'sigtermHold' });
  }
  const rows = [];
  try {
    await installConsumerBarriers(w.db.url);
    let svc = await w.startBilling();
    const items = await w.seed(plan.length, { orgs: Array.from({ length: 10 }, () => randomUUID()) });
    const gate = await holder(w.db.url);
    await gate.q('COMMIT');
    for (const [k, step] of plan.entries()) {
      const item = items[k];
      const p = w.pay.payments.get(w.pay.byRequest.get(item.requestId));
      w.pay.settle(p.id, 'succeeded');
      const eventId = randomUUID();
      let lock = null;
      if (step.window === 'A') {
        lock = await holder(w.db.url);
        await lock.q('SELECT 1 FROM invoice WHERE id = $1 FOR UPDATE', [item.invoiceId]);
      } else {
        await w.q('INSERT INTO validation_barrier (event_id, stage) VALUES ($1, $2)', [eventId, step.window]);
        await gate.q('SELECT pg_advisory_lock(4242)');
      }
      const release = async () => {
        if (lock) await lock.release();
        else await gate.q('SELECT pg_advisory_unlock(4242)');
      };
      await pub.publish('payment.succeeded', p, { eventId });
      const reached = await h.waitFor(async () => (await waitingOnLock(w.db)) > 0, 10_000, 10);
      const tS = h.now();
      let exitMs;
      if (step.mode === 'sigkill') {
        svc.child.kill('SIGKILL');
        await svc.exited;
        exitMs = h.round(h.now() - tS);
        await h.sleep(300);
        await release();
      } else {
        svc.child.kill('SIGTERM');
        const released = step.mode === 'sigtermRelease' ? h.sleep(1000).then(release) : null;
        const ex = await Promise.race([svc.exited, h.sleep(90_000).then(() => null)]);
        exitMs = ex ? h.round(ex.t - tS) : null;
        if (!ex) svc.child.kill('SIGKILL');
        await released;
        if (step.mode === 'sigtermHold') await release();
      }
      await h.sleep(200);
      const state = async () => {
        const [r] = await w.q(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "eventId" = $1`, [eventId]);
        const [inv] = await w.q('SELECT status FROM invoice WHERE id = $1', [item.invoiceId]);
        const [req] = await w.q('SELECT status FROM payment_request WHERE id = $1', [item.requestId]);
        const [tr] = await w.q(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityType" = 'invoice' AND "toStatus" = 'paid' AND "entityId" = $1`, [item.invoiceId]);
        return { receipts: r.n, invoice: inv.status, request: req.status, invoicePaidTransitions: tr.n };
      };
      const afterDeath = await state();
      const q = rabbit.queues().find((x) => x.name === 'billing.payment-events');
      const queueAfterDeath = { ready: Number(q?.messages_ready ?? 0), unacked: Number(q?.messages_unacknowledged ?? 0) };
      const partial = afterDeath.receipts === 1 && afterDeath.invoice !== 'paid';
      const leftover = await leftovers(w.db);
      const tR = h.now();
      svc = await w.startBilling();
      const done = await h.waitFor(async () => { const s = await state(); return s.receipts === 1 && s.invoice === 'paid' && s; }, 30_000, 50);
      const final = await state();
      rows.push({
        ...step, reached: Boolean(reached), exitMs, afterDeath, queueAfterDeath, partial, leftoverAfterDeath: leftover, convergedAfterRestartMs: done ? h.round(h.now() - tR) : null, final,
      });
      if (k % 10 === 9) log(`consumerWindows ${k + 1}/${plan.length}`);
    }
    await gate.release();
    await svc.stop();
  } finally {
    await pub.close().catch(() => undefined);
    await w.close();
  }
  const group = (xs) => ({
    iterations: xs.length, barrierReached: xs.filter((x) => x.reached).length, exitMs: h.stats(xs.map((x) => x.exitMs).filter((x) => x !== null)), notExited: xs.filter((x) => x.exitMs === null).length,
    committedBeforeRestart: xs.filter((x) => x.afterDeath.receipts === 1).length, partialStates: xs.filter((x) => x.partial).length,
    requeuedAfterDeath: xs.filter((x) => x.queueAfterDeath.ready > 0).length, idleInTxAfterDeath: Math.max(...xs.map((x) => x.leftoverAfterDeath.idleInTransaction)),
    locksAfterDeath: Math.max(...xs.map((x) => x.leftoverAfterDeath.locks)), converged: xs.filter((x) => x.convergedAfterRestartMs !== null).length,
    receiptsFinal: [...new Set(xs.map((x) => x.final.receipts))], invoicePaidTransitionsFinal: [...new Set(xs.map((x) => x.final.invoicePaidTransitions))],
    convergedAfterRestartMs: h.stats(xs.map((x) => x.convergedAfterRestartMs).filter((x) => x !== null)),
  });
  const out = {};
  for (const window of ['A', 'B', 'C']) for (const mode of ['sigtermRelease', 'sigkill', 'sigtermHold']) out[`${window}.${mode}`] = group(rows.filter((r) => r.window === window && r.mode === mode));
  return out;
};

/** Workers reported as interrupted (their `worker_drain_timeout` lines), with offsets. */
const drains = (r) => r.phases.filter((p) => /drain_timeout/.test(p.msg)).map((p) => `${p.ms}ms ${p.msg.replace(/^(worker_drain_timeout|rabbitmq_consumer_drain_timeout) /, '').split(' ')[0]}`);

C.frozenPostgres = async () => {
  // Billing and Payment reach PostgreSQL through a TCP proxy that is frozen (server-to-client stalled: the server executes, the client
  // hears nothing) once every worker loop has started a pass, so every worker is hung in the database. SIGTERM. Run 3 times with
  // DB_STATEMENT_TIMEOUT_MS 2000 (client deadline 7000) for speed, once with the defaults (30000 / 35000). Afterwards: no session or
  // lock left, and the service starts normally.
  const out = {};
  for (const service of ['billing-service', 'payment-service']) {
    for (const [label, extra, runs] of [['statementTimeout2s', { DB_STATEMENT_TIMEOUT_MS: '2000' }, 3], ['defaults', {}, 1]]) {
      const rows = [];
      for (let i = 0; i < runs; i++) {
        const db = await h.throwawayDatabase(ADMIN, service);
        const proxy = new BrokerProxy({ host: '127.0.0.1', port: pgc.port });
        await proxy.start();
        try {
          const more = service === 'billing-service' ? { BILLING_RECONCILE_INTERVAL_MS: '1000', BILLING_DISPATCH_INTERVAL_MS: '300' } : {};
          const svc = await core.start(service, { db, databaseUrl: h.via(db.url, proxy.port), extra: { ...extra, ...more } });
          await h.sleep(1500);
          proxy.freeze();
          await h.sleep(6500); // Payment's workers run every 5 s: each has started a pass by now
          const r = await core.signalAndWatch(svc, { limitMs: 180_000 });
          proxy.thaw();
          await h.sleep(500);
          const left = await leftovers(db);
          const again = await core.start(service, { db, extra: { ...extra, ...more } });
          await again.stop();
          rows.push({ exitedMs: r.exitedMs, exit: r.exit, shutdownStartedMs: r.shutdownStartedMs, shutdownCompleteMs: r.shutdownCompleteMs, drains: drains(r), readyFirstNot200Ms: r.readyFirstNot200Ms, connectionsRefusedMs: r.connectionsRefusedMs, phases: r.phases.slice(0, 16), leftover: left, restartedReady: true });
          log(`frozenPostgres ${service} ${label} ${i}: exit ${r.exitedMs} ms, drains ${JSON.stringify(drains(r))}`);
        } finally {
          proxy.thaw();
          await proxy.sever();
          await db.drop();
        }
      }
      out[`${service}.${label}`] = { exitedMs: h.stats(rows.map((r) => r.exitedMs).filter((x) => x !== null)), notExited: rows.filter((r) => r.exitedMs === null).length, runs: rows };
    }
  }
  return out;
};

C.frozenRabbit = async () => {
  // The broker container is frozen (`docker pause`: TCP still accepted, nothing answered) under an established connection; SIGTERM.
  // Billing: consumer attached. Payment: a publish in flight (a cancellation made after the freeze). 3 runs each, with the broker's
  // default heartbeat and with a broker that disables heartbeats.
  const out = {};
  for (const [label, hb] of [['brokerDefaultHeartbeat', undefined], ['brokerHeartbeatDisabled', 0]]) {
    const r = hb === undefined ? rabbit : await h.throwawayRabbit({ heartbeatS: hb });
    try {
      for (const service of ['billing-service', 'payment-service']) {
        const rows = [];
        for (let i = 0; i < 3; i++) {
          const db = await h.throwawayDatabase(ADMIN, service);
          let paused = false;
          try {
            const token = (await import('../../libs/service-kit/dist/index.js')).generateServiceToken();
            const svc = await core.start(service, { db, brokerUrl: r.url, extra: service === 'payment-service' ? { SERVICE_TOKENS: `billing-service:${token.digest}` } : {} });
            const cancelOne = async () => {
              const org = randomUUID();
              const c = await fetch(`${svc.base}/payment/payments`, {
                method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: randomUUID(), payer: { type: 'user', id: 'payer-frozen' }, seller: { type: 'organization', id: org }, organizationId: org, amount: 1000, currency: 'TND', reference: 'INV-FROZEN' }),
              }).then((x) => x.json());
              await fetch(`${svc.base}/payment/payments/${c.id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token.token}` } });
            };
            if (service === 'payment-service') {
              await cancelOne();
              await h.waitFor(async () => (await h.adminQuery(db.url, `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`))[0].n === 0, 10_000, 50);
            } else await h.sleep(1500);
            r.pause();
            paused = true;
            if (service === 'payment-service') await cancelOne();
            await h.sleep(1500);
            const res = await core.signalAndWatch(svc, { limitMs: 180_000 });
            r.unpause();
            paused = false;
            rows.push({ exitedMs: res.exitedMs, exit: res.exit, shutdownCompleteMs: res.shutdownCompleteMs, drains: drains(res), phases: res.phases.slice(0, 12) });
            log(`frozenRabbit ${label} ${service} ${i}: exit ${res.exitedMs} ms`);
          } finally {
            if (paused) r.unpause();
            await db.drop();
          }
        }
        out[`${label}.${service}`] = { exitedMs: h.stats(rows.map((x) => x.exitedMs).filter((x) => x !== null)), notExited: rows.filter((x) => x.exitedMs === null).length, runs: rows };
      }
    } finally {
      if (r !== rabbit) r.stop();
    }
  }
  return out;
};

/**
 * Billing + a REAL Payment (Payment's broker connection through a TCP proxy that can be frozen), Billing consuming Payment's events
 * directly. Requests are seeded through the real dispatcher; `cancel(item)` makes Payment write a `payment.cancelled` outbox row.
 */
async function pairWorld() {
  const { generateServiceToken } = await import('../../libs/service-kit/dist/index.js');
  const payDb = await h.throwawayDatabase(ADMIN, 'payment-service');
  const proxy = new BrokerProxy({ host: '127.0.0.1', port: rabbit.port });
  await proxy.start();
  const pPort = await h.freePort();
  const b2p = generateServiceToken();
  const payments = [];
  const startPayment = async () => {
    const svc = await core.start('payment-service', { db: payDb, brokerUrl: proxy.url, port: pPort, extra: { SERVICE_TOKENS: `billing-service:${b2p.digest}` } });
    payments.push(svc);
    return svc;
  };
  await startPayment();
  const w = await core.billingWorld({ pay: { url: `http://127.0.0.1:${pPort}`, close: async () => undefined }, extra: { PAYMENT_SERVICE_TOKEN: b2p.token } });
  await w.startBilling();
  const cancel = (item) => w.api('POST', `/billing/payment-requests/${item.requestId}/cancel`);
  const pq = (sql, p) => h.adminQuery(payDb.url, sql, p);
  const account = async (items) => {
    const ids = items.map((x) => x.requestId);
    const [r] = await w.q(`SELECT count(*)::int AS receipts, count(DISTINCT "eventId")::int AS events FROM payment_event_receipt WHERE "paymentRequestId" = ANY($1) AND "eventName" = 'payment.cancelled'`, [ids]);
    const [s] = await w.q(`SELECT count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled FROM payment_request WHERE id = ANY($1)`, [ids]);
    const [o] = await pq(`SELECT count(*) FILTER (WHERE name = 'payment.cancelled')::int AS events, count(*) FILTER (WHERE "publishedAt" IS NULL)::int AS pending FROM outbox`);
    return { requests: ids.length, receipts: r.receipts, distinctEventsReceipted: r.events, requestsCancelled: s.cancelled, paymentCancelledEvents: o.events, outboxPending: o.pending };
  };
  const close = async () => {
    proxy.thaw();
    for (const s of payments) if (s.alive()) s.child.kill('SIGKILL');
    await Promise.all(payments.map((s) => s.exited));
    await w.close();
    await proxy.sever();
    await payDb.drop();
  };
  return { w, proxy, payDb, pq, startPayment, payments, cancel, account, close };
}

C.outboxShutdown = async () => {
  // Payment's relay stopped by SIGTERM while it holds its claim transaction:
  //   K (cold): the publisher has no channel yet; the broker is frozen, so the pass is stuck between the claim and the publish;
  //   L (warm): one event already published on the channel; the broker is frozen after the publish is sent: the confirm is pending.
  // `thawInDrain`: the broker answers again 1 s after SIGTERM (20 each); `neverThaw`: only after the process exited (3 each).
  // After each: Payment restarted; every event published, Billing applies each cancellation once.
  const pw = await pairWorld();
  const plan = [];
  for (const window of ['K', 'L']) {
    for (let i = 0; i < 20; i++) plan.push({ window, mode: 'thawInDrain' });
    for (let i = 0; i < 3; i++) plan.push({ window, mode: 'neverThaw' });
  }
  const rows = [];
  try {
    const items = await pw.w.seed(plan.length * 2, { orgs: Array.from({ length: 5 }, () => randomUUID()) });
    let svc = pw.payments.at(-1);
    for (const [k, step] of plan.entries()) {
      const target = items[2 * k];
      if (step.window === 'L') {
        await pw.cancel(items[2 * k + 1]);
        await h.waitFor(async () => (await pw.pq(`SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`))[0].n === 0, 15_000, 25);
      }
      pw.proxy.freeze();
      const c = await pw.cancel(target);
      const claimed = await h.waitFor(async () => ((await h.sessions(ADMIN, pw.payDb.name)).byState['idle in transaction'] ?? 0) > 0, 10_000, 10);
      const tS = h.now();
      svc.child.kill('SIGTERM');
      const thaw = step.mode === 'thawInDrain' ? h.sleep(1000).then(() => pw.proxy.thaw()) : null;
      const ex = await Promise.race([svc.exited, h.sleep(120_000).then(() => null)]);
      const exitMs = ex ? h.round(ex.t - tS) : null;
      if (!ex) svc.child.kill('SIGKILL');
      await thaw;
      pw.proxy.thaw();
      const [row] = await pw.pq(`SELECT attempts, "publishedAt" IS NOT NULL AS published, "lastError" IS NOT NULL AS failed FROM outbox WHERE name = 'payment.cancelled' ORDER BY "occurredAt" DESC LIMIT 1`);
      const phases = svc.since(tS, (l) => /drain|shutdown|outbox|rabbitmq/.test(String(l.msg))).map((l) => `${h.round(l.t - tS)}ms ${String(l.msg).split(' —')[0].slice(0, 90)}`);
      svc = await pw.startPayment();
      const done = await h.waitFor(async () => { const a = await pw.account([target]); return a.requestsCancelled === 1 && a.receipts >= 1 && a; }, 30_000, 50);
      rows.push({ ...step, cancelStatus: c.status, claimed: Boolean(claimed), exitMs, rowAtExit: row, phases, converged: Boolean(done) });
      if (k % 10 === 9) log(`outboxShutdown ${k + 1}/${plan.length}`);
    }
    await h.waitFor(async () => (await pw.account(items.filter((_, i) => i % 2 === 0 || plan[Math.floor(i / 2)]?.window === 'L'))).outboxPending === 0, 30_000, 100);
    const used = items.filter((_, i) => i % 2 === 0 || plan[Math.floor(i / 2)].window === 'L');
    const acct = await pw.account(used);
    const group = (xs) => ({
      iterations: xs.length, claimedAtSignal: xs.filter((x) => x.claimed).length, exitMs: h.stats(xs.map((x) => x.exitMs).filter((x) => x !== null)), notExited: xs.filter((x) => x.exitMs === null).length,
      publishedAtExit: xs.filter((x) => x.rowAtExit?.published).length, pendingAtExit: xs.filter((x) => x.rowAtExit && !x.rowAtExit.published).length, attemptsAtExit: [...new Set(xs.map((x) => x.rowAtExit?.attempts))],
      converged: xs.filter((x) => x.converged).length, samplePhases: xs[0]?.phases,
    });
    const out = { accounting: acct };
    for (const window of ['K', 'L']) for (const mode of ['thawInDrain', 'neverThaw']) out[`${window}.${mode}`] = group(rows.filter((r) => r.window === window && r.mode === mode));
    return out;
  } finally {
    await pw.close();
  }
};

C.dispatcherShutdown = async () => {
  // Billing's dispatcher claims a batch of 5 and is sending the first row to (fake) Payment, which holds it, when SIGTERM arrives.
  // `respondInDrain`: Payment answers 1 s later; `dropInDrain`: Payment creates the payment 1 s later and the response is lost;
  // `neverRespond`: Payment never answers the old instance (PAYMENT_TIMEOUT_MS 5000). A new instance (stale window 3 s, test value)
  // then finishes the batch: every request `requested`, one payment each, the recorded id matching Payment's.
  const w = await core.billingWorld({ extra: { BILLING_DISPATCH_STALE_SENDING_MS: '3000' } });
  const plan = [...Array(20).fill('respondInDrain'), ...Array(20).fill('dropInDrain'), ...Array(3).fill('neverRespond')];
  const rows = [];
  try {
    let svc = await w.startBilling();
    await w.seed(1, { waitRequested: true });
    for (const [k, mode] of plan.entries()) {
      let release;
      const gate = new Promise((r) => (release = r));
      const arrivals = [];
      let held = false;
      w.pay.setHook(async (key) => {
        arrivals.push({ key, t: h.now() });
        if (!held) {
          held = true;
          return gate;
        }
        return 'normal';
      });
      const items = await w.seed(5, { waitRequested: false });
      await h.waitFor(() => held, 10_000, 5);
      const tS = h.now();
      svc.child.kill('SIGTERM');
      const answer = mode === 'respondInDrain' ? 'normal' : mode === 'dropInDrain' ? 'drop' : 'abort';
      const r = mode === 'neverRespond' ? null : h.sleep(1000).then(() => release(answer));
      const ex = await Promise.race([svc.exited, h.sleep(120_000).then(() => null)]);
      const exitMs = ex ? h.round(ex.t - tS) : null;
      if (!ex) svc.child.kill('SIGKILL');
      await r;
      if (mode === 'neverRespond') release('abort');
      const sentByOldAfterSignal = arrivals.filter((a) => a.t > tS).length;
      const statesAtExit = await w.q(`SELECT status, count(*)::int AS n FROM payment_request WHERE id = ANY($1) GROUP BY 1`, [items.map((x) => x.requestId)]);
      w.pay.setHook(async () => 'normal');
      const tR = h.now();
      svc = await w.startBilling();
      const ok = await w.requested(items, 60_000);
      const rs = await w.q(`SELECT id, "paymentId" FROM payment_request WHERE id = ANY($1)`, [items.map((x) => x.requestId)]);
      rows.push({
        mode, exitMs, sentByOldAfterSignal, statesAtExit: Object.fromEntries(statesAtExit.map((x) => [x.status, x.n])), allRequested: Boolean(ok), recoveredMs: ok ? h.round(h.now() - tR) : null,
        onePaymentMatching: rs.every((x) => w.pay.byRequest.get(x.id) === x.paymentId), createCalls: rs.map((x) => w.pay.creates.get(x.id) ?? 0),
      });
      if (k % 10 === 9) log(`dispatcherShutdown ${k + 1}/${plan.length}`);
    }
    await svc.stop();
  } finally {
    await w.close();
  }
  const group = (xs) => ({
    iterations: xs.length, exitMs: h.stats(xs.map((x) => x.exitMs).filter((x) => x !== null)), notExited: xs.filter((x) => x.exitMs === null).length,
    sentByOldAfterSignal: [...new Set(xs.map((x) => x.sentByOldAfterSignal))], statesAtExit: [...new Set(xs.map((x) => JSON.stringify(x.statesAtExit)))],
    allRequested: xs.filter((x) => x.allRequested).length, onePaymentMatching: xs.filter((x) => x.onePaymentMatching).length,
    createCallsPerRequest: [...new Set(xs.flatMap((x) => x.createCalls))], recoveredMs: h.stats(xs.map((x) => x.recoveredMs).filter((x) => x !== null)),
  });
  return Object.fromEntries(['respondInDrain', 'dropInDrain', 'neverRespond'].map((m) => [m, group(rows.filter((r) => r.mode === m))]));
};

C.sweeperShutdown = async () => {
  // Live Payment. (1) The expiry sweeper waits for a due payment's row lock (held by another transaction) when SIGTERM arrives:
  // released 1 s later (3 runs), or never (3 runs; default statement timeout 30 s). (2) The sweeper is inside its expiry transaction
  // (a test-only trigger blocks the `payment.expired` outbox INSERT, after the status UPDATE) when the process is SIGKILLed (20 runs).
  // After each: restarted, the payment is expired once with one event.
  const { generateServiceToken } = await import('../../libs/service-kit/dist/index.js');
  const db = await h.throwawayDatabase(ADMIN, 'payment-service');
  const token = generateServiceToken();
  const extra = { SERVICE_TOKENS: `billing-service:${token.digest}` };
  const rows = [];
  try {
    await h.adminQuery(db.url, `
      CREATE TABLE validation_barrier (payment_id text PRIMARY KEY);
      CREATE FUNCTION validation_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'payment.expired' AND EXISTS (SELECT 1 FROM validation_barrier WHERE payment_id = NEW.payload->>'paymentId') THEN
          PERFORM pg_advisory_lock_shared(4343);
          PERFORM pg_advisory_unlock_shared(4343);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER validation_expiry BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION validation_wait();`);
    let svc = await core.start('payment-service', { db, extra });
    const create = async () => {
      const org = randomUUID();
      const r = await fetch(`${svc.base}/payment/payments`, {
        method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: randomUUID(), payer: { type: 'user', id: 'payer-sweep' }, seller: { type: 'organization', id: org }, organizationId: org, amount: 1000, currency: 'TND', reference: 'INV-SWEEP', expiresAt: new Date(Date.now() + 1500).toISOString() }),
      });
      return (await r.json()).id;
    };
    const gate = await holder(db.url);
    await gate.q('COMMIT');
    const plan = [...Array(3).fill('lockReleasedInDrain'), ...Array(3).fill('lockNeverReleased'), ...Array(20).fill('sigkillInExpiryTx')];
    for (const [k, mode] of plan.entries()) {
      const id = await create();
      let lock = null;
      if (mode === 'sigkillInExpiryTx') {
        await h.adminQuery(db.url, 'INSERT INTO validation_barrier VALUES ($1)', [id]);
        await gate.q('SELECT pg_advisory_lock(4343)');
      } else {
        lock = await holder(db.url);
        await lock.q('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [id]);
      }
      const reached = await h.waitFor(async () => (await waitingOnLock(db)) > 0, 15_000, 20);
      const tS = h.now();
      let exitMs;
      if (mode === 'sigkillInExpiryTx') {
        svc.child.kill('SIGKILL');
        await svc.exited;
        exitMs = h.round(h.now() - tS);
        await h.sleep(300);
        await gate.q('SELECT pg_advisory_unlock(4343)');
      } else {
        svc.child.kill('SIGTERM');
        const rel = mode === 'lockReleasedInDrain' ? h.sleep(1000).then(() => lock.release()) : null;
        const ex = await Promise.race([svc.exited, h.sleep(120_000).then(() => null)]);
        exitMs = ex ? h.round(ex.t - tS) : null;
        if (!ex) svc.child.kill('SIGKILL');
        await rel;
        if (mode === 'lockNeverReleased') await lock.release();
      }
      await h.sleep(200);
      const [st] = await h.adminQuery(db.url, `SELECT p.status, (SELECT count(*)::int FROM outbox o WHERE o.name = 'payment.expired' AND o.payload->>'paymentId' = p.id::text) AS events FROM payment p WHERE p.id = $1`, [id]);
      const phases = svc.since(tS, (l) => /drain|shutdown|expiry/.test(String(l.msg))).map((l) => `${h.round(l.t - tS)}ms ${String(l.msg).split(' —')[0].slice(0, 90)}`);
      const leftover = await leftovers(db);
      svc = await core.start('payment-service', { db, extra });
      const done = await h.waitFor(async () => { const [x] = await h.adminQuery(db.url, `SELECT p.status, (SELECT count(*)::int FROM outbox o WHERE o.name = 'payment.expired' AND o.payload->>'paymentId' = p.id::text) AS events FROM payment p WHERE p.id = $1`, [id]); return x.status === 'expired' && x.events === 1 && x; }, 20_000, 100);
      rows.push({ mode, reached: Boolean(reached), exitMs, atExit: st, partial: st.status === 'expired' && st.events === 0, leftover, final: done || null, phases });
    }
    await gate.release();
    await svc.stop();
  } finally {
    await db.drop();
  }
  const group = (xs) => ({
    iterations: xs.length, reached: xs.filter((x) => x.reached).length, exitMs: h.stats(xs.map((x) => x.exitMs).filter((x) => x !== null)), notExited: xs.filter((x) => x.exitMs === null).length,
    atExit: [...new Set(xs.map((x) => `${x.atExit.status}/${x.atExit.events}`))], partialStates: xs.filter((x) => x.partial).length, idleInTxAfterExit: Math.max(...xs.map((x) => x.leftover.idleInTransaction)),
    expiredOnceAfterRestart: xs.filter((x) => x.final).length, samplePhases: xs[0].phases,
  });
  return Object.fromEntries(['lockReleasedInDrain', 'lockNeverReleased', 'sigkillInExpiryTx'].map((m) => [m, group(rows.filter((r) => r.mode === m))]));
};

C.paymentWorkerWindows = async () => {
  // Component level, with the real lifecycle hooks Nest calls (the in-process Payment layer of 15.4; each instance has its own pool).
  // Resolver R1: the provider status call is in flight when the instance shuts down (beforeApplicationShutdown, then its pool is
  //   closed); the provider then answers. R2: the provider answered and the resolution transaction waits for the payment lock when the
  //   instance's connections are terminated (what PostgreSQL sees of a SIGKILL). Retrier S1: reprocessing blocked before its
  //   bookkeeping commits, instance terminated; S2: the same on a row's 10th (last) attempt. After each, a second instance finishes.
  const { AttemptResolverService, WEBHOOK_RETRY_MAX_ATTEMPTS: MAX, paymentWorlds, scriptedProvider } = await import('./lib/payment-world.mjs');
  const w = await paymentWorlds({ adminUrl: ADMIN, later })();
  const caps = w.testProvider.capabilities;
  const terminate = (app) => h.adminQuery(ADMIN, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND application_name = $2`, [w.db.name, app]);
  const out = { R1: [], R2: [], S1: [], S2: [] };
  const eventsFor = async (pid) => (await w.q(`SELECT count(*)::int AS n FROM outbox WHERE payload->>'paymentId' = $1 AND name IN ('payment.succeeded', 'payment.failed')`, [pid]))[0].n;
  for (let i = 0; i < 20; i++) {
    // R1
    {
      const { payment } = await w.createPayment();
      const { attempt } = await w.startAttempt(payment.id, 'timeout_after_accept');
      let release;
      const gate = new Promise((r) => (release = r));
      const calls = [];
      const provA = { get: () => scriptedProvider(caps, () => ({ kind: 'succeeded', amount: 1000, currency: 'TND' }), () => gate, calls), tryGet: () => provA.get() };
      const a = w.instance(`r1a-${i}`, provA);
      const svcA = new AttemptResolverService(a.resolver);
      a.resolver.start(20);
      await h.waitFor(() => calls.length > 0, 5000, 5);
      const t = h.now();
      await svcA.beforeApplicationShutdown();
      const drainMs = h.round(h.now() - t);
      await a.pool.onApplicationShutdown();
      release();
      await h.sleep(100);
      const [mid] = await w.q('SELECT status FROM payment_attempt WHERE id = $1', [attempt.id]);
      const provB = { get: () => scriptedProvider(caps, () => ({ kind: 'succeeded', amount: 1000, currency: 'TND' }), null, []), tryGet: () => provB.get() };
      const b = w.instance(`r1b-${i}`, provB);
      await b.resolver.drainOnce();
      const [fin] = await w.q('SELECT a.status AS attempt, p.status AS payment FROM payment_attempt a JOIN payment p ON p.id = a."paymentId" WHERE a.id = $1', [attempt.id]);
      out.R1.push({ drainMs, attemptAfterOldInstance: mid.status, final: `${fin.attempt}/${fin.payment}`, terminalEvents: await eventsFor(payment.id), providerCalls: calls.length });
      await b.pool.onApplicationShutdown();
    }
    // R2
    {
      const { payment } = await w.createPayment();
      const { attempt } = await w.startAttempt(payment.id, 'timeout_after_accept');
      const lock = await holder(w.db.url);
      await lock.q('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [payment.id]);
      const provA = { get: () => scriptedProvider(caps, () => ({ kind: 'succeeded', amount: 1000, currency: 'TND' }), null, []), tryGet: () => provA.get() };
      const a = w.instance(`r2a-${i}`, provA);
      const pass = a.resolver.drainOnce().catch((e) => describeFailure(e));
      await h.waitFor(async () => (await waitingOnLock(w.db)) > 0, 5000, 10);
      await terminate(`validation-payment-r2a-${i}`);
      await lock.release();
      await pass;
      const [mid] = await w.q('SELECT status FROM payment_attempt WHERE id = $1', [attempt.id]);
      const b = w.instance(`r2b-${i}`, provA);
      await b.resolver.drainOnce();
      const [fin] = await w.q('SELECT a.status AS attempt, p.status AS payment FROM payment_attempt a JOIN payment p ON p.id = a."paymentId" WHERE a.id = $1', [attempt.id]);
      out.R2.push({ attemptAfterKill: mid.status, final: `${fin.attempt}/${fin.payment}`, terminalEvents: await eventsFor(payment.id) });
      await a.pool.onApplicationShutdown().catch(() => undefined);
      await b.pool.onApplicationShutdown();
    }
  }
  // Retrier windows: a trigger holds the bookkeeping UPDATE of listed rows until advisory lock 4444 is released.
  await w.q(`
    CREATE TABLE validation_barrier (webhook_id text PRIMARY KEY);
    CREATE FUNCTION validation_wait() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM validation_barrier WHERE webhook_id = NEW.id::text) THEN
        PERFORM pg_advisory_lock_shared(4444);
        PERFORM pg_advisory_unlock_shared(4444);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER validation_retry BEFORE UPDATE ON webhook_event FOR EACH ROW EXECUTE FUNCTION validation_wait();`);
  const gate = await holder(w.db.url);
  await gate.q('COMMIT');
  for (const [label, startAttempts] of [['S1', 3], ['S2', MAX - 1]]) {
    for (let i = 0; i < 20; i++) {
      const body = Buffer.from(JSON.stringify({ eventId: `evt_${randomUUID()}`, type: 'payment.succeeded', reference: `ghost-${randomUUID()}`, amount: 1000, currency: 'TND' }));
      const [{ id }] = await w.q(`INSERT INTO webhook_event(provider, "providerEventId", "eventType", "rawBody", "receivedAt", state, attempts) VALUES ('test', $1, 'payment.succeeded', $2, now() - interval '1 day', 'unmatched', $3) RETURNING id`, [`evt_${randomUUID()}`, body, startAttempts]);
      await w.q('INSERT INTO validation_barrier VALUES ($1)', [String(id)]);
      await gate.q('SELECT pg_advisory_lock(4444)');
      const a = w.instance(`${label.toLowerCase()}a-${i}`);
      const pass = a.retrier.drainOnce().catch((e) => describeFailure(e));
      await h.waitFor(async () => (await waitingOnLock(w.db)) > 0, 5000, 10);
      await terminate(`validation-payment-${label.toLowerCase()}a-${i}`);
      await gate.q('SELECT pg_advisory_unlock(4444)');
      await pass;
      await w.q('DELETE FROM validation_barrier WHERE webhook_id = $1', [String(id)]);
      const [mid] = await w.q('SELECT attempts, state, outcome FROM webhook_event WHERE id = $1', [id]);
      const b = w.instance(`${label.toLowerCase()}b-${i}`);
      await b.retrier.drainOnce();
      await b.retrier.drainOnce();
      const [fin] = await w.q('SELECT attempts, state, outcome FROM webhook_event WHERE id = $1', [id]);
      out[label].push({ attemptsBefore: startAttempts, afterKill: `${mid.attempts}/${mid.state}/${mid.outcome ?? '-'}`, final: `${fin.attempts}/${fin.state}/${fin.outcome ?? '-'}` });
      await a.pool.onApplicationShutdown().catch(() => undefined);
      await b.pool.onApplicationShutdown();
    }
  }
  await gate.release();
  const sum = (xs, keys) => Object.fromEntries(keys.map((k) => [k, [...new Set(xs.map((x) => x[k]))]]));
  return {
    R1: { iterations: out.R1.length, ...sum(out.R1, ['attemptAfterOldInstance', 'final', 'terminalEvents']), drainMs: h.stats(out.R1.map((x) => x.drainMs)) },
    R2: { iterations: out.R2.length, ...sum(out.R2, ['attemptAfterKill', 'final', 'terminalEvents']) },
    S1: { iterations: out.S1.length, ...sum(out.S1, ['afterKill', 'final']) }, S2: { iterations: out.S2.length, ...sum(out.S2, ['afterKill', 'final']) },
  };
};

// ------------------------------------------------------------------------------------------------ containers (Docker stop semantics)
const dockerCmd = (...a) => execFileSync('docker', a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const own = (name) => {
  if (!name.startsWith('validation-')) throw new Error(`refusing to touch ${name}`);
  return name;
};

/**
 * Runs the services as containers from the `validation-<service>:15-5` images (built from this checkout: same Dockerfile, same
 * `node dist/main.js` as PID 1, same default stop signal) on a `validation-net-*` network shared with the throwaway broker and database.
 */
async function containerWorld() {
  const { mkdtempSync, writeFileSync: wf, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const net = own(`validation-net-${randomBytes(3).toString('hex')}`);
  dockerCmd('network', 'create', net);
  dockerCmd('network', 'connect', net, own(rabbit.name));
  dockerCmd('network', 'connect', net, own(pgc.name));
  const dir = mkdtempSync(`${os.tmpdir()}/validation-env-`);
  const names = [];
  const inNet = (url) => { const u = new URL(url); u.hostname = pgc.name; u.port = '5432'; return u.toString(); };
  const attached = [];
  /** Connects another throwaway broker (e.g. one with heartbeats disabled) to this network. */
  const attach = (broker) => {
    dockerCmd('network', 'connect', net, own(broker.name));
    attached.push(broker.name);
  };
  const run = async (service, db, extra = {}, { broker = rabbit } = {}) => {
    const name = own(`validation-${service}-${randomBytes(3).toString('hex')}`);
    const port = await h.freePort();
    const env = h.serviceEnv(service, { databaseUrl: inNet(db.url), brokerUrl: `amqp://guest:guest@${broker.name}:5672`, port: 3000, extra: { NODE_ENV: 'development', ...extra } });
    delete env.PATH;
    const file = `${dir}/${name}.env`;
    wf(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
    dockerCmd('run', '-d', '--name', name, '--network', net, '-p', `127.0.0.1:${port}:3000`, '--env-file', file, `validation-${service}:15-5`);
    rmSync(file);
    names.push(name);
    const base = `http://127.0.0.1:${port}`;
    const readyPath = service === 'auth-service' ? '/auth/health' : '/ready';
    const ready = async () => h.waitFor(async () => (await probe(base, readyPath, 2000)).status === 200, 60_000, 100);
    if (!(await ready())) throw new Error(`${service} container not ready: ${dockerCmd('logs', '--tail', '5', name)}`);
    return {
      name, base, readyPath, ready,
      stop: (args = []) => { const t = Date.now(); dockerCmd('stop', ...args, name); return Date.now() - t; },
      /** `docker stop` without blocking this process's event loop (a client of the container must keep running meanwhile). */
      stopAsync: (args = []) => new Promise((resolve) => { const t = Date.now(); spawn('docker', ['stop', ...args, name], { stdio: 'ignore' }).on('exit', () => resolve(Date.now() - t)); }),
      exec: (...cmd) => spawnSync('docker', ['exec', name, ...cmd]).stdout.toString(),
      start: async () => { dockerCmd('start', name); return ready(); },
      state: () => JSON.parse(dockerCmd('inspect', '-f', '{{json .State}}', name)),
      logs: () => { const r = spawnSync('docker', ['logs', name]); return `${r.stdout}\n${r.stderr}`.split('\n'); },
      lifecycle: () => (() => { const r = spawnSync('docker', ['logs', name]); return `${r.stdout}\n${r.stderr}`.split('\n'); })().filter((l) => /shutdown|drain|rabbitmq_|expiry|_failure/.test(l)).map((l) => { try { return JSON.parse(l).msg.split(' —')[0].slice(0, 100); } catch { return l.slice(0, 100); } }),
    };
  };
  const close = () => {
    for (const n of names) try { dockerCmd('rm', '-f', n); } catch { /* already gone */ }
    for (const c of [rabbit.name, pgc.name, ...attached]) try { dockerCmd('network', 'disconnect', net, c); } catch { /* not connected */ }
    try { dockerCmd('network', 'rm', net); } catch { /* removed */ }
    rmSync(dir, { recursive: true, force: true });
  };
  return { run, close, net, attach };
}

C.dockerStop = async () => {
  // `docker stop` with the effective default (SIGTERM, 10 s grace, then SIGKILL) on real containers:
  //   idle (3 per service); broker frozen (Billing consumer; Payment with a publish in flight); a keep-alive connection busy at the
  //   stop; the sweeper waiting on a row lock. After every SIGKILL the same container is started again and must recover.
  const { generateServiceToken } = await import('../../libs/service-kit/dist/index.js');
  const cw = await containerWorld();
  const out = {};
  const record = (c, ms) => { const s = c.state(); return { stopMs: ms, exitCode: s.ExitCode, killedBySigkill: s.ExitCode === 137, lifecycle: c.lifecycle() }; };
  try {
    for (const service of ['auth-service', 'organization-service', 'billing-service', 'payment-service']) {
      const rows = [];
      for (let i = 0; i < 3; i++) {
        const db = await h.throwawayDatabase(ADMIN, service);
        try {
          const c = await cw.run(service, db);
          await h.sleep(1500);
          rows.push(record(c, c.stop()));
        } finally {
          await db.drop();
        }
      }
      out[`idle.${service}`] = { stopMs: h.stats(rows.map((r) => r.stopMs)), exitCodes: [...new Set(rows.map((r) => r.exitCode))], lifecycle: rows[0].lifecycle };
      log(`dockerStop idle ${service}: ${JSON.stringify(out[`idle.${service}`].stopMs)} exit ${out[`idle.${service}`].exitCodes}`);
    }
    for (const service of ['billing-service', 'payment-service']) {
      const rows = [];
      for (let i = 0; i < 3; i++) {
        const db = await h.throwawayDatabase(ADMIN, service);
        const token = generateServiceToken();
        let paused = false;
        try {
          const c = await cw.run(service, db, service === 'payment-service' ? { SERVICE_TOKENS: `billing-service:${token.digest}` } : {});
          const cancelOne = async () => {
            const org = randomUUID();
            const p = await fetch(`${c.base}/payment/payments`, { method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: randomUUID(), payer: { type: 'user', id: 'payer-docker' }, seller: { type: 'organization', id: org }, organizationId: org, amount: 1000, currency: 'TND', reference: 'INV-DOCKER' }) }).then((x) => x.json());
            await fetch(`${c.base}/payment/payments/${p.id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token.token}` } });
          };
          if (service === 'payment-service') {
            await cancelOne();
            await h.waitFor(async () => (await h.adminQuery(db.url, `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`))[0].n === 0, 15_000, 50);
          } else await h.sleep(1500);
          rabbit.pause();
          paused = true;
          if (service === 'payment-service') await cancelOne();
          await h.sleep(1500);
          const rec = record(c, c.stop());
          const [pend] = await h.adminQuery(db.url, service === 'payment-service' ? `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL` : `SELECT 0 AS n`);
          const left = await leftovers(db);
          rabbit.unpause();
          paused = false;
          const t = h.now();
          const back = await c.start();
          const drained = await h.waitFor(async () => (await h.adminQuery(db.url, service === 'payment-service' ? `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL` : `SELECT 0 AS n`))[0].n === 0, 60_000, 100);
          const consumers = service === 'billing-service' ? await h.waitFor(() => Number(rabbit.queues().find((q) => q.name === 'billing.payment-events')?.consumers) === 1 && 1, 30_000, 250) : null;
          rows.push({ ...rec, outboxPendingAfterKill: pend.n, sessionsAfterKill: left, restartedReady: Boolean(back), readyAfterRestartMs: h.round(h.now() - t), outboxDrainedAfterRestart: Boolean(drained), billingQueueConsumers: consumers });
          c.stop();
        } finally {
          if (paused) rabbit.unpause();
          await db.drop();
        }
      }
      out[`brokerFrozen.${service}`] = { stopMs: h.stats(rows.map((r) => r.stopMs)), exitCodes: [...new Set(rows.map((r) => r.exitCode))], runs: rows };
      log(`dockerStop brokerFrozen ${service}: ${JSON.stringify(out[`brokerFrozen.${service}`].stopMs)} exit ${out[`brokerFrozen.${service}`].exitCodes}`);
    }
    {
      const rows = [];
      for (let i = 0; i < 3; i++) {
        const db = await h.throwawayDatabase(ADMIN, 'billing-service');
        try {
          const c = await cw.run('billing-service', db);
          const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
          let go = true;
          let n = 0;
          let stopMs;
          const answers = [];
          const client = (async () => {
            while (go) {
              n++;
              if (n === 20) setTimeout(() => { c.stopAsync().then((ms) => { stopMs = ms; go = false; }); }, 15);
              const r = await new Promise((resolve) => { const req = http.get(`${c.base}/ready`, { agent }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', (e) => resolve(e.code)); });
              answers.push(r);
              await h.sleep(10);
            }
          })();
          await h.waitFor(() => stopMs !== undefined, 60_000, 20);
          go = false;
          await client;
          agent.destroy();
          rows.push({ ...record(c, stopMs), answersDuringStop: answers.slice(20).reduce((m, a) => ((m[a] = (m[a] ?? 0) + 1), m), {}) });
        } finally {
          await db.drop();
        }
      }
      out.keepAliveBusy = { stopMs: h.stats(rows.map((r) => r.stopMs)), exitCodes: [...new Set(rows.map((r) => r.exitCode))], runs: rows };
      log(`dockerStop keepAliveBusy: ${JSON.stringify(out.keepAliveBusy.stopMs)} exit ${out.keepAliveBusy.exitCodes}`);
    }
    {
      const rows = [];
      for (let i = 0; i < 3; i++) {
        const db = await h.throwawayDatabase(ADMIN, 'payment-service');
        const token = generateServiceToken();
        try {
          const c = await cw.run('payment-service', db, { SERVICE_TOKENS: `billing-service:${token.digest}` });
          const org = randomUUID();
          const p = await fetch(`${c.base}/payment/payments`, { method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: randomUUID(), payer: { type: 'user', id: 'payer-docker' }, seller: { type: 'organization', id: org }, organizationId: org, amount: 1000, currency: 'TND', reference: 'INV-DOCKER', expiresAt: new Date(Date.now() + 1500).toISOString() }) }).then((x) => x.json());
          const lock = await holder(db.url);
          await lock.q('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [p.id]);
          await h.waitFor(async () => (await waitingOnLock(db)) > 0, 15_000, 50);
          const rec = record(c, c.stop());
          await lock.release();
          await c.start();
          const expired = await h.waitFor(async () => { const [x] = await h.adminQuery(db.url, `SELECT p.status, (SELECT count(*)::int FROM outbox o WHERE o.name = 'payment.expired' AND o.payload->>'paymentId' = p.id::text) AS events FROM payment p WHERE p.id = $1`, [p.id]); return x.status === 'expired' && x.events === 1; }, 20_000, 100);
          rows.push({ ...rec, expiredOnceAfterRestart: Boolean(expired) });
          c.stop();
        } finally {
          await db.drop();
        }
      }
      out.sweeperBlockedOnLock = { stopMs: h.stats(rows.map((r) => r.stopMs)), exitCodes: [...new Set(rows.map((r) => r.exitCode))], runs: rows };
      log(`dockerStop sweeperBlockedOnLock: ${JSON.stringify(out.sweeperBlockedOnLock.stopMs)} exit ${out.sweeperBlockedOnLock.exitCodes}`);
    }
    return out;
  } finally {
    cw.close();
  }
};

C.dockerStopWithGrace = async () => {
  // The slow graceful cases of dockerStop with an explicit stop grace (`docker stop -t 45`, the value 15.5 recommends): do they now finish
  // gracefully (exit 0, `service_shutdown_complete`) instead of being SIGKILLed at Docker's default 10 s? 3 runs each.
  const { generateServiceToken } = await import('../../libs/service-kit/dist/index.js');
  const cw = await containerWorld();
  const out = {};
  try {
    for (const service of ['billing-service', 'payment-service']) {
      const rows = [];
      for (let i = 0; i < 3; i++) {
        const db = await h.throwawayDatabase(ADMIN, service);
        const token = generateServiceToken();
        let paused = false;
        try {
          const c = await cw.run(service, db, service === 'payment-service' ? { SERVICE_TOKENS: `billing-service:${token.digest}` } : {});
          if (service === 'payment-service') {
            const org = randomUUID();
            const p = await fetch(`${c.base}/payment/payments`, { method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: randomUUID(), payer: { type: 'user', id: 'payer-grace' }, seller: { type: 'organization', id: org }, organizationId: org, amount: 1000, currency: 'TND', reference: 'INV-GRACE' }) }).then((x) => x.json());
            await h.waitFor(async () => (await h.adminQuery(db.url, `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`))[0].n === 0, 15_000, 50);
            rabbit.pause();
            paused = true;
            await fetch(`${c.base}/payment/payments/${p.id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'idempotency-key': `k-${randomUUID()}` } });
          } else {
            await h.sleep(1500);
            rabbit.pause();
            paused = true;
          }
          await h.sleep(1500);
          const ms = c.stop(['-t', '45']);
          const st = c.state();
          rows.push({ stopMs: ms, exitCode: st.ExitCode, lifecycle: c.lifecycle().slice(-3) });
        } finally {
          if (paused) rabbit.unpause();
          await db.drop();
        }
      }
      out[`brokerFrozen.${service}`] = { stopMs: h.stats(rows.map((r) => r.stopMs)), exitCodes: [...new Set(rows.map((r) => r.exitCode))], runs: rows };
      log(`dockerStopWithGrace brokerFrozen ${service}: ${JSON.stringify(out[`brokerFrozen.${service}`].stopMs)} exit ${out[`brokerFrozen.${service}`].exitCodes}`);
    }
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const db = await h.throwawayDatabase(ADMIN, 'payment-service');
      const token = generateServiceToken();
      try {
        const c = await cw.run('payment-service', db, { SERVICE_TOKENS: `billing-service:${token.digest}` });
        const org = randomUUID();
        const p = await fetch(`${c.base}/payment/payments`, { method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: randomUUID(), payer: { type: 'user', id: 'payer-grace' }, seller: { type: 'organization', id: org }, organizationId: org, amount: 1000, currency: 'TND', reference: 'INV-GRACE', expiresAt: new Date(Date.now() + 1500).toISOString() }) }).then((x) => x.json());
        const lock = await holder(db.url);
        await lock.q('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [p.id]);
        await h.waitFor(async () => (await waitingOnLock(db)) > 0, 15_000, 50);
        const ms = c.stop(['-t', '45']);
        const st = c.state();
        await lock.release();
        rows.push({ stopMs: ms, exitCode: st.ExitCode, lifecycle: c.lifecycle().slice(-3) });
      } finally {
        await db.drop();
      }
    }
    out.sweeperBlockedOnLock = { stopMs: h.stats(rows.map((r) => r.stopMs)), exitCodes: [...new Set(rows.map((r) => r.exitCode))], runs: rows };
    log(`dockerStopWithGrace sweeperBlockedOnLock: ${JSON.stringify(out.sweeperBlockedOnLock.stopMs)} exit ${out.sweeperBlockedOnLock.exitCodes}`);
    return out;
  } finally {
    cw.close();
  }
};

C.dockerFrozenBrokerDiag = async () => {
  // Diagnosis of the dockerStopWithGrace finding (no fix): Billing as a container (Node = PID 1), broker frozen, `docker stop -t 90`.
  // After `service_shutdown_complete`, what is still open in PID 1 (TCP sockets by peer port), and when does it exit, if at all?
  const cw = await containerWorld();
  const db = await h.throwawayDatabase(ADMIN, 'billing-service');
  let paused = false;
  try {
    const c = await cw.run('billing-service', db);
    await h.sleep(1500);
    const before = c.exec('netstat', '-tn');
    rabbit.pause();
    paused = true;
    await h.sleep(1500);
    const tS = Date.now();
    const stopping = c.stopAsync(['-t', '90']);
    let completeAt = null;
    await h.waitFor(() => { if (c.lifecycle().some((l) => /service_shutdown_complete/.test(l))) { completeAt = Date.now() - tS; return true; } return false; }, 80_000, 250);
    await h.sleep(3000);
    const afterComplete = c.state().Running ? c.exec('netstat', '-tn') : 'exited';
    const fds = c.state().Running ? c.exec('sh', '-c', 'ls -l /proc/1/fd | grep -c socket') : 'exited';
    const stopMs = await stopping;
    return { completeAtMs: completeAt, stopMs, exitCode: c.state().ExitCode, socketsBeforeFreeze: before.trim().split('\n').slice(2), socketsThreeSecondsAfterComplete: String(afterComplete).trim().split('\n').slice(2), socketFdsInPid1: String(fds).trim(), brokerPort5672: 'the throwaway broker listens on 5672 inside the network' };
  } finally {
    if (paused) rabbit.unpause();
    await db.drop();
    cw.close();
  }
};

/** Creates a payment through a Payment container's API; with `cancel`, cancels it (Payment writes a `payment.cancelled` outbox row). */
async function paymentThrough(base, token, { cancel = false, expiresInMs } = {}) {
  const org = randomUUID();
  const p = await fetch(`${base}/payment/payments`, {
    method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: randomUUID(), payer: { type: 'user', id: 'payer-fh' }, seller: { type: 'organization', id: org }, organizationId: org, amount: 1000, currency: 'TND', reference: 'INV-FH', ...(expiresInMs ? { expiresAt: new Date(Date.now() + expiresInMs).toISOString() } : {}) }),
  }).then((x) => x.json());
  if (cancel) await fetch(`${base}/payment/payments/${p.id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'idempotency-key': `k-${randomUUID()}` } });
  return p;
}

C.dockerFrozenBrokerFinal = async () => {
  // Stage 15.5 F-H final acceptance, in the production images (Node = PID 1): an established connection, the broker frozen
  // (`docker pause`), `docker stop -t 45`. Must exit NATURALLY (exit 0) before the grace, with the abandoned transport destroyed; then,
  // broker back, the same container starts again and recovers: ready, one consumer (Billing), the pending outbox row published
  // (Payment, whose publish was in flight at the freeze: the confirm-wait path). Broker with its default heartbeat and with heartbeats
  // disabled. 3 runs each.
  const { generateServiceToken } = await import('../../libs/service-kit/dist/index.js');
  const cw = await containerWorld();
  const noHb = await h.throwawayRabbit({ heartbeatS: 0 });
  cw.attach(noHb);
  const out = {};
  try {
    for (const [label, broker] of [['brokerDefaultHeartbeat', rabbit], ['brokerHeartbeatDisabled', noHb]]) {
      for (const service of ['billing-service', 'payment-service']) {
        const rows = [];
        for (let i = 0; i < 3; i++) {
          const db = await h.throwawayDatabase(ADMIN, service);
          const token = generateServiceToken();
          let paused = false;
          try {
            const c = await cw.run(service, db, service === 'payment-service' ? { SERVICE_TOKENS: `billing-service:${token.digest}` } : {}, { broker });
            let pending = null;
            if (service === 'payment-service') {
              await paymentThrough(c.base, token, { cancel: true });
              await h.waitFor(async () => (await h.adminQuery(db.url, `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`))[0].n === 0, 15_000, 50);
            } else await h.sleep(1500);
            broker.pause();
            paused = true;
            if (service === 'payment-service') pending = await paymentThrough(c.base, token, { cancel: true }); // publish in flight: confirm pending
            await h.sleep(1500);
            const stopMs = c.stop(['-t', '60']);
            const st = c.state();
            const lifecycle = c.lifecycle();
            const rowAtExit = pending ? (await h.adminQuery(db.url, `SELECT count(*) FILTER (WHERE "publishedAt" IS NULL)::int AS unpublished, max(attempts)::int AS attempts FROM outbox WHERE payload->>'paymentId' = $1`, [pending.id]))[0] : null;
            broker.unpause();
            paused = false;
            const t = h.now();
            const back = await c.start();
            const readyMs = h.round(h.now() - t);
            const drained = service === 'payment-service' ? await h.waitFor(async () => (await h.adminQuery(db.url, `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`))[0].n === 0, 60_000, 100) : null;
            const [events] = pending ? await h.adminQuery(db.url, `SELECT count(*) FILTER (WHERE name = 'payment.cancelled')::int AS cancelled FROM outbox WHERE payload->>'paymentId' = $1`, [pending.id]) : [null];
            const consumers = service === 'billing-service' ? await h.waitFor(() => Number(broker.queues().find((q) => q.name === 'billing.payment-events')?.consumers) === 1 && 1, 30_000, 250) : null;
            rows.push({
              stopMs, exitCode: st.ExitCode, completed: lifecycle.some((l) => /service_shutdown_complete/.test(l)), abandoned: lifecycle.some((l) => /rabbitmq_connection_abandoned/.test(l)),
              pendingRowAtExit: rowAtExit, restartedReady: Boolean(back), readyAfterRestartMs: readyMs, outboxDrained: drained, cancelledEventsForThatPayment: events?.cancelled ?? null, billingQueueConsumers: consumers,
            });
            c.stop();
          } finally {
            if (paused) broker.unpause();
            await db.drop();
          }
        }
        out[`${label}.${service}`] = { stopMs: h.stats(rows.map((r) => r.stopMs)), exitCodes: [...new Set(rows.map((r) => r.exitCode))], runs: rows };
        log(`dockerFrozenBrokerFinal ${label} ${service}: ${JSON.stringify(out[`${label}.${service}`].stopMs)} exit ${out[`${label}.${service}`].exitCodes}`);
      }
    }
    return out;
  } finally {
    cw.close();
    noHb.stop();
  }
};

C.dockerConsumerInFlightFrozen = async () => {
  // Billing's consumer holds an UNACKED delivery (its transaction is blocked right after the receipt INSERT, test-only barrier) when the
  // broker freezes and `docker stop -t 45` arrives. Must exit naturally; the delivery must not be acked; after the broker and the service
  // come back, it is redelivered and applied exactly once. 3 runs.
  const cw = await containerWorld();
  const out = [];
  try {
    for (let i = 0; i < 3; i++) {
      const db = await h.throwawayDatabase(ADMIN, 'billing-service');
      let paused = false;
      const gate = await holder(db.url);
      await gate.q('COMMIT');
      try {
        await installConsumerBarriers(db.url);
        const c = await cw.run('billing-service', db);
        const eventId = randomUUID();
        await h.adminQuery(db.url, 'INSERT INTO validation_barrier (event_id, stage) VALUES ($1, $2)', [eventId, 'B']);
        await gate.q('SELECT pg_advisory_lock(4242)');
        const pub = paymentEventPublisher(rabbit.url);
        await pub.publish('payment.succeeded', { id: randomUUID(), paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: randomUUID(), payer: { type: 'user', id: 'p' }, seller: { type: 'organization', id: randomUUID() }, organizationId: null, currency: 'TND', amount: 1000 }, { eventId });
        await pub.close();
        const blocked = await h.waitFor(async () => (await waitingOnLock(db)) > 0, 15_000, 20);
        rabbit.pause();
        paused = true;
        await h.sleep(500);
        const stopMs = c.stop(['-t', '60']);
        const st = c.state();
        const [atExit] = await h.adminQuery(db.url, 'SELECT count(*)::int AS n FROM payment_event_receipt WHERE "eventId"::text = $1', [eventId]);
        await gate.q('SELECT pg_advisory_unlock(4242)');
        await h.adminQuery(db.url, 'DELETE FROM validation_barrier');
        rabbit.unpause();
        paused = false;
        await c.start();
        const applied = await h.waitFor(async () => (await h.adminQuery(db.url, 'SELECT count(*)::int AS n FROM payment_event_receipt WHERE "eventId"::text = $1', [eventId]))[0].n === 1, 30_000, 100);
        await h.sleep(1000);
        const [fin] = await h.adminQuery(db.url, 'SELECT count(*)::int AS n FROM payment_event_receipt WHERE "eventId"::text = $1', [eventId]);
        const consumers = Number(rabbit.queues().find((q) => q.name === 'billing.payment-events')?.consumers);
        out.push({ blocked: Boolean(blocked), stopMs, exitCode: st.ExitCode, receiptsAtExit: atExit.n, redeliveredAndApplied: Boolean(applied), receiptsFinal: fin.n, queueConsumers: consumers, lifecycle: c.lifecycle().slice(-4) });
        c.stop();
      } finally {
        if (paused) rabbit.unpause();
        await gate.release();
        await db.drop();
      }
    }
    log(`dockerConsumerInFlightFrozen: ${JSON.stringify(out.map((r) => [r.stopMs, r.exitCode, r.receiptsFinal]))}`);
    return { runs: out, stopMs: h.stats(out.map((r) => r.stopMs)), exitCodes: [...new Set(out.map((r) => r.exitCode))] };
  } finally {
    cw.close();
  }
};

C.dockerBrokerVanishes = async () => {
  // The broker is frozen, `docker stop -t 45` starts, and 2 s later the broker container disappears (removed): the close must end
  // promptly (the connection is gone), the process must exit naturally. Billing and Payment, 3 runs each, each on its own broker.
  const { generateServiceToken } = await import('../../libs/service-kit/dist/index.js');
  const cw = await containerWorld();
  const out = {};
  try {
    for (const service of ['billing-service', 'payment-service']) {
      const rows = [];
      for (let i = 0; i < 3; i++) {
        const broker = await h.throwawayRabbit();
        cw.attach(broker);
        const db = await h.throwawayDatabase(ADMIN, service);
        const token = generateServiceToken();
        try {
          const c = await cw.run(service, db, service === 'payment-service' ? { SERVICE_TOKENS: `billing-service:${token.digest}` } : {}, { broker });
          if (service === 'payment-service') {
            await paymentThrough(c.base, token, { cancel: true });
            await h.waitFor(async () => (await h.adminQuery(db.url, `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`))[0].n === 0, 15_000, 50);
          } else await h.sleep(1500);
          broker.pause();
          const stopping = c.stopAsync(['-t', '60']);
          await h.sleep(2000);
          spawnSync('docker', ['rm', '-f', own(broker.name)]);
          const stopMs = await stopping;
          rows.push({ stopMs, exitCode: c.state().ExitCode, lifecycle: c.lifecycle().slice(-3) });
        } finally {
          await db.drop();
        }
      }
      out[service] = { stopMs: h.stats(rows.map((r) => r.stopMs)), exitCodes: [...new Set(rows.map((r) => r.exitCode))], runs: rows };
      log(`dockerBrokerVanishes ${service}: ${JSON.stringify(out[service].stopMs)} exit ${out[service].exitCodes}`);
    }
    return out;
  } finally {
    cw.close();
  }
};

C.dockerFrozenCycles = async () => {
  // 10 cycles of: Billing + Payment containers running (Billing consuming, Payment publishing), broker frozen, `docker stop -t 45` of both
  // at once, natural exit, broker back, both started again. After each: exit codes, broker connections / channels / consumers, database
  // sessions, container memory right after restart. No monotonic growth.
  const { generateServiceToken } = await import('../../libs/service-kit/dist/index.js');
  const cw = await containerWorld();
  const bdb = await h.throwawayDatabase(ADMIN, 'billing-service');
  const pdb = await h.throwawayDatabase(ADMIN, 'payment-service');
  const token = generateServiceToken();
  const rows = [];
  const payments = [];
  try {
    const bill = await cw.run('billing-service', bdb);
    const pay = await cw.run('payment-service', pdb, { SERVICE_TOKENS: `billing-service:${token.digest}` });
    const mem = (name) => spawnSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', name]).stdout.toString().trim().split(' ')[0];
    for (let i = 0; i < 10; i++) {
      payments.push(await paymentThrough(pay.base, token, { cancel: true }));
      await h.sleep(1000);
      rabbit.pause();
      payments.push(await paymentThrough(pay.base, token, { cancel: true })); // pending at the freeze
      await h.sleep(1000);
      const [bMs, pMs] = await Promise.all([bill.stopAsync(['-t', '60']), pay.stopAsync(['-t', '60'])]);
      const exits = [bill.state().ExitCode, pay.state().ExitCode];
      rabbit.unpause();
      await Promise.all([bill.start(), pay.start()]);
      await h.waitFor(async () => (await h.adminQuery(pdb.url, `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`))[0].n === 0, 60_000, 100);
      await h.waitFor(() => Number(rabbit.queues().find((q) => q.name === 'billing.payment-events')?.consumers) === 1, 30_000, 250);
      await h.sleep(1000);
      const s = await h.sessions(ADMIN, null);
      rows.push({
        cycle: i, stopMs: [bMs, pMs], exits, brokerConnections: rabbit.connections().length, brokerChannels: rabbit.channels().length,
        queueConsumers: Number(rabbit.queues().find((q) => q.name === 'billing.payment-events')?.consumers), dbSessions: s.byDatabase, memAfterRestart: [mem(bill.name), mem(pay.name)],
      });
      log(`dockerFrozenCycles ${i}: ${JSON.stringify(rows.at(-1))}`);
    }
    const [ev] = await h.adminQuery(pdb.url, `SELECT count(*)::int AS rows, count(DISTINCT payload->>'paymentId')::int AS payments, count(*) FILTER (WHERE "publishedAt" IS NULL)::int AS pending FROM outbox WHERE name = 'payment.cancelled' AND payload->>'paymentId' = ANY($1)`, [payments.map((p) => p.id)]);
    return {
      cycles: rows, exitCodes: [...new Set(rows.flatMap((r) => r.exits))], stopMs: h.stats(rows.flatMap((r) => r.stopMs)),
      brokerConnections: [...new Set(rows.map((r) => r.brokerConnections))], brokerChannels: [...new Set(rows.map((r) => r.brokerChannels))], queueConsumers: [...new Set(rows.map((r) => r.queueConsumers))],
      cancelledEvents: ev, payments: payments.length,
    };
  } finally {
    cw.close();
    await bdb.drop();
    await pdb.drop();
  }
};

C.dockerCrossServiceOutage = async () => {
  // Stage 15.6 production-container checks (Node = PID 1, `docker stop -t 60`, the adopted grace):
  //   (1) RabbitMQ STOPPED (not frozen) while Billing and Payment containers run and Payment cancels (its event waits in the outbox);
  //       both containers stopped and started again while the broker is still down (Billing keeps exiting: fail-fast startup, restarted
  //       by the harness as a restart policy would), then the broker returns: both natural exits, one consumer, the event applied once;
  //   (2) the throwaway PostgreSQL container paused (every database hangs) while a Payment container is stopped: it must exit naturally
  //       within the Core bound (worker drains, then the query deadline), then start again and be ready. 3 runs each.
  const { generateServiceToken } = await import('../../libs/service-kit/dist/index.js');
  const cw = await containerWorld();
  const out = { rabbitStopped: [], databasePaused: [] };
  try {
    for (let i = 0; i < 3; i++) {
      const bdb = await h.throwawayDatabase(ADMIN, 'billing-service');
      const pdb = await h.throwawayDatabase(ADMIN, 'payment-service');
      const token = generateServiceToken();
      let stopped = false;
      try {
        const bill = await cw.run('billing-service', bdb);
        const pay = await cw.run('payment-service', pdb, { SERVICE_TOKENS: `billing-service:${token.digest}` });
        rabbit.appStop();
        stopped = true;
        const p = await paymentThrough(pay.base, token, { cancel: true });
        await h.sleep(1500);
        const [bMs, pMs] = await Promise.all([bill.stopAsync(['-t', '60']), pay.stopAsync(['-t', '60'])]);
        const exits = [bill.state().ExitCode, pay.state().ExitCode];
        spawnSync('docker', ['start', pay.name]);
        spawnSync('docker', ['start', bill.name]);
        await h.sleep(4000);
        const billingWhileBrokerDown = bill.state();
        await rabbit.appStart();
        stopped = false;
        let billingStarts = 1;
        const back = await h.waitFor(async () => {
          if (!bill.state().Running) { spawnSync('docker', ['start', bill.name]); billingStarts++; }
          return Number(rabbit.queues().find((q) => q.name === 'billing.payment-events')?.consumers) === 1;
        }, 60_000, 1000);
        const drained = await h.waitFor(async () => (await h.adminQuery(pdb.url, `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`))[0].n === 0, 60_000, 200);
        const [ev] = await h.adminQuery(pdb.url, `SELECT count(*)::int AS n FROM outbox WHERE name = 'payment.cancelled' AND payload->>'paymentId' = $1`, [p.id]);
        out.rabbitStopped.push({ stopMs: [bMs, pMs], exits, billingRunningWhileBrokerDown: billingWhileBrokerDown.Running, billingExitWhileBrokerDown: billingWhileBrokerDown.ExitCode, billingStarts, consumerBack: Boolean(back), outboxDrained: Boolean(drained), cancelledEvents: ev.n });
        bill.stop(['-t', '60']);
        pay.stop(['-t', '60']);
      } finally {
        if (stopped) await rabbit.appStart();
        await bdb.drop();
        await pdb.drop();
      }
    }
    log(`dockerCrossServiceOutage rabbitStopped: ${JSON.stringify(out.rabbitStopped.map((r) => [r.stopMs, r.exits, r.billingStarts, r.consumerBack, r.outboxDrained, r.cancelledEvents]))}`);
    for (let i = 0; i < 3; i++) {
      const pdb = await h.throwawayDatabase(ADMIN, 'payment-service');
      const token = generateServiceToken();
      let paused = false;
      try {
        const pay = await cw.run('payment-service', pdb, { SERVICE_TOKENS: `billing-service:${token.digest}` });
        await paymentThrough(pay.base, token, {});
        await h.sleep(6000); // Payment's workers have started a pass
        dockerCmd('pause', own(pgc.name));
        paused = true;
        await h.sleep(6000); // every worker is now hung in the database
        const ms = pay.stop(['-t', '60']);
        const st = pay.state();
        dockerCmd('unpause', own(pgc.name));
        paused = false;
        const t = h.now();
        const ready = await pay.start();
        out.databasePaused.push({ stopMs: ms, exitCode: st.ExitCode, lifecycle: pay.lifecycle().slice(-3), restartedReady: Boolean(ready), readyMs: h.round(h.now() - t) });
        pay.stop(['-t', '60']);
      } finally {
        if (paused) dockerCmd('unpause', own(pgc.name));
        await pdb.drop();
      }
    }
    log(`dockerCrossServiceOutage databasePaused: ${JSON.stringify(out.databasePaused.map((r) => [r.stopMs, r.exitCode]))}`);
    return { ...out, rabbitStoppedExitCodes: [...new Set(out.rabbitStopped.flatMap((r) => r.exits))], databasePausedStopMs: h.stats(out.databasePaused.map((r) => r.stopMs)), databasePausedExitCodes: [...new Set(out.databasePaused.map((r) => r.exitCode))] };
  } finally {
    cw.close();
  }
};

C.dependencyStartup = async () => {
  // Start each service while (a) PostgreSQL is unreachable (a closed port), (b) RabbitMQ is unreachable (Billing, Payment), (c) its
  // database has no schema (migrations not applied). Watch 15 s (exit? /health? /ready?), then make the dependency available (a
  // proxy starts listening on that port; for (c) the migrations are run) and watch whether the SAME process becomes ready.
  const out = {};
  const watch = async (svc, ms) => {
    const seen = [];
    const end = h.now() + ms;
    while (h.now() < end && svc.alive()) {
      const [r, l] = await Promise.all([probe(svc.base, svc.readyPath), probe(svc.base, svc.readyPath === '/ready' ? '/health' : '/auth/health')]);
      seen.push(`${r.status}/${l.status}`);
      await h.sleep(250);
    }
    return { alive: svc.alive(), exit: svc.alive() ? null : svc.child.exitCode ?? svc.child.signalCode, answers: [...new Set(seen)] };
  };
  const cases = [];
  for (const service of ['auth-service', 'organization-service', 'billing-service', 'payment-service']) cases.push({ service, dep: 'postgres' });
  for (const service of ['billing-service', 'payment-service']) cases.push({ service, dep: 'rabbitmq' });
  for (const service of ['organization-service', 'billing-service', 'payment-service']) cases.push({ service, dep: 'schema' });
  for (const { service, dep } of cases) {
    const db = await h.throwawayDatabase(ADMIN, dep === 'schema' ? null : service);
    const proxy = new BrokerProxy({ host: '127.0.0.1', port: dep === 'postgres' ? pgc.port : rabbit.port });
    proxy.port = await h.freePort();
    try {
      const svc = await core.start(service, {
        db, waitReady: false, databaseUrl: dep === 'postgres' ? h.via(db.url, proxy.port) : db.url, brokerUrl: dep === 'rabbitmq' ? `amqp://guest:guest@127.0.0.1:${proxy.port}` : rabbit.url,
        extra: service === 'auth-service' ? { NODE_ENV: 'development' } : {},
      });
      const down = await watch(svc, 15_000);
      const lines = svc.lines.filter((l) => l.level === 'error' || l.level === 'warn' || /fatal|refus|Error/.test(String(l.msg))).map((l) => String(l.msg).split(' —')[0].slice(0, 120)).slice(0, 4);
      let recovered = null;
      if (svc.alive()) {
        const t = h.now();
        if (dep === 'schema') h.migrate(service, db.url);
        else await proxy.start();
        const ok = await h.waitFor(async () => (await probe(svc.base, svc.readyPath)).status === 200, 60_000, 100);
        recovered = { sameProcessReady: Boolean(ok), afterMs: ok ? h.round(h.now() - t) : null };
        if (ok && dep === 'rabbitmq' && service === 'billing-service') recovered.queueConsumers = await h.waitFor(() => Number(rabbit.queues().find((q) => q.name === 'billing.payment-events')?.consumers) >= 1 && Number(rabbit.queues().find((q) => q.name === 'billing.payment-events')?.consumers), 30_000, 250);
      }
      out[`${service}.${dep}Down`] = { whileDown: down, logs: lines, recovered };
      log(`dependencyStartup ${service} ${dep}: ${JSON.stringify(down)} ${JSON.stringify(recovered)}`);
      if (svc.alive()) { svc.child.kill('SIGKILL'); await svc.exited; }
    } finally {
      await proxy.sever();
      await db.drop();
    }
  }
  // Readiness while starting normally: when does /ready first answer 200, relative to the service's own `service_started` line?
  for (const service of ['billing-service', 'payment-service']) {
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const db = await h.throwawayDatabase(ADMIN, service);
      try {
        const svc = await core.start(service, { db, waitReady: false });
        const seen = [];
        const end = h.now() + 20_000;
        let first200;
        while (h.now() < end) {
          const r = await probe(svc.base, '/ready', 2000);
          seen.push(r.status);
          if (r.status === 200) { first200 = h.now(); break; }
          await h.sleep(20);
        }
        const started = svc.lines.find((l) => /service_started/.test(String(l.msg)));
        rows.push({ first200Ms: first200 ? h.round(first200 - svc.t0) : null, serviceStartedMs: started ? h.round(started.t - svc.t0) : null, answersBefore200: [...new Set(seen.slice(0, -1))] });
        await svc.stop();
      } finally {
        await db.drop();
      }
    }
    out[`${service}.normalStartup`] = { first200Ms: h.stats(rows.map((r) => r.first200Ms)), serviceStartedMs: h.stats(rows.map((r) => r.serviceStartedMs)), answersBefore200: [...new Set(rows.flatMap((r) => r.answersBefore200))] };
  }
  return out;
};

/**
 * Billing ×b + Payment ×p (real), each instance on its own process; Billing reaches Payment through a small failover HTTP proxy (the
 * first live Payment instance answers), and the harness's traffic goes to the first live Billing instance. Traffic: one invoice →
 * payment request every `everyMs`, and every earlier request that reached `requested` is cancelled (Payment writes the event, Billing
 * applies it). Accounting: every request ends `cancelled` with ONE receipt and ONE Payment payment.
 */
async function trafficWorld({ billings = 1, payments = 1 } = {}) {
  const { generateServiceToken } = await import('../../libs/service-kit/dist/index.js');
  const payDb = await h.throwawayDatabase(ADMIN, 'payment-service');
  const b2p = generateServiceToken();
  const pays = [];
  const startPayment = async (slot) => {
    const svc = await core.start('payment-service', { db: payDb, extra: { SERVICE_TOKENS: `billing-service:${b2p.digest}` } });
    pays[slot] = svc;
    return svc;
  };
  for (let i = 0; i < payments; i++) await startPayment(i);
  const lbPort = await h.freePort();
  const lb = http.createServer((req, res) => {
    const targets = pays.filter((p) => p && p.alive());
    const tryAt = (i) => {
      const t = targets[i];
      if (!t) { res.writeHead(502); res.end(); return; }
      const up = http.request(`${t.base}${req.url}`, { method: req.method, headers: req.headers, agent: false }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', () => tryAt(i + 1));
      req.pipe(up);
    };
    tryAt(0);
  });
  await new Promise((r) => lb.listen(lbPort, '127.0.0.1', r));
  const w = await core.billingWorld({ pay: { url: `http://127.0.0.1:${lbPort}`, close: async () => undefined }, extra: { PAYMENT_SERVICE_TOKEN: b2p.token } });
  const bills = [];
  const startBillingSlot = async (slot) => { const svc = await w.startBilling(); bills[slot] = svc; return svc; };
  for (let i = 0; i < billings; i++) await startBillingSlot(i);
  const api = async (method, path) => {
    for (const b of bills.filter((x) => x && x.alive())) {
      try { return await w.api(method, path, undefined, b); } catch { /* next instance */ }
    }
    return { status: 'unavailable' };
  };
  const items = [];
  const errors = [];
  const cancelLog = [];
  const cancelAccepted = new Set(); // a cancel whose API call failed (e.g. Payment restarting) is retried by the client, as the API contract says
  const cancelPending = async () => {
    const ready = await w.q(`SELECT id FROM payment_request WHERE status = 'requested' AND id = ANY($1)`, [items.map((x) => x.requestId)]).catch(() => []);
    for (const r of ready.filter((x) => !cancelAccepted.has(x.id))) {
      const c = await api('POST', `/billing/payment-requests/${r.id}/cancel`);
      cancelLog.push({ id: r.id, status: c.status, t: h.now(), code: c.json?.code });
      if (c.status === 200 || c.status === 202) cancelAccepted.add(r.id);
      else errors.push(`cancel ${c.status} ${c.json?.code ?? ''}`);
    }
  };
  let go = false;
  let loop;
  const startTraffic = (everyMs = 150) => {
    go = true;
    loop = (async () => {
      while (go) {
        try {
          const [it] = await w.seed(1, { waitRequested: false });
          items.push(it);
        } catch (e) { errors.push(`seed ${String(e.message).slice(0, 60)}`); }
        await cancelPending();
        await h.sleep(everyMs);
      }
    })();
  };
  const stopTraffic = async () => { go = false; await loop; };
  const account = async () => {
    const ids = items.map((x) => x.requestId);
    const st = await w.q(`SELECT status, count(*)::int AS n FROM payment_request WHERE id = ANY($1) GROUP BY 1`, [ids]);
    const [rc] = await w.q(`SELECT count(*)::int AS receipts, count(DISTINCT "paymentRequestId")::int AS requests, count(*) FILTER (WHERE outcome = 'applied')::int AS applied FROM payment_event_receipt WHERE "paymentRequestId" = ANY($1)`, [ids]);
    const [pp] = await h.adminQuery(payDb.url, `SELECT count(*)::int AS payments, count(DISTINCT "paymentRequestId")::int AS requests, (SELECT count(*)::int FROM outbox WHERE "publishedAt" IS NULL) AS outbox_pending FROM payment WHERE "paymentRequestId"::text = ANY($1)`, [ids]);
    const [dupe] = await h.adminQuery(payDb.url, `SELECT count(*)::int AS n FROM (SELECT "paymentRequestId" FROM payment WHERE "paymentRequestId"::text = ANY($1) GROUP BY 1 HAVING count(*) > 1) x`, [ids]);
    return { requests: ids.length, statuses: Object.fromEntries(st.map((x) => [x.status, x.n])), receipts: rc.receipts, receiptedRequests: rc.requests, applied: rc.applied, payments: pp.payments, paymentsPerRequestOver1: dupe.n, paymentOutboxPending: pp.outbox_pending };
  };
  /** Full state of every request that is not `cancelled`: Billing row, receipts, Payment payment and its outbox rows, the cancel calls made. */
  const diagnose = async () => {
    const rows = await w.q(`SELECT id, status, "paymentId", "cancelRequestedAt", "sendAttempts", "updatedAt" FROM payment_request WHERE id = ANY($1) AND status <> 'cancelled'`, [items.map((x) => x.requestId)]);
    const out = [];
    for (const r of rows) {
      const receipts = await w.q(`SELECT "eventName", outcome, "detailCode", "receivedAt" FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [r.id]).catch((e) => String(e.message));
      const pay = await h.adminQuery(payDb.url, `SELECT id, status, "closedAt", "expiresAt", "createdAt" FROM payment WHERE "paymentRequestId"::text = $1`, [r.id]);
      const ob = pay[0] ? await h.adminQuery(payDb.url, `SELECT name, attempts, "publishedAt", "lastError", "occurredAt" FROM outbox WHERE payload->>'paymentId' = $1 ORDER BY "occurredAt"`, [pay[0].id]) : [];
      out.push({ request: r, receipts, payment: pay[0] ?? null, paymentOutbox: ob, cancelCalls: cancelLog.filter((c) => c.id === r.id).map((c) => `${c.status}${c.code ? `/${c.code}` : ''}`), queue: rabbit.queues().find((q) => q.name === 'billing.payment-events') });
    }
    return out;
  };
  /** Waits until every request is `cancelled` (each cancellation event applied), then returns the accounting. */
  const settle = async (timeoutMs = 90_000) => {
    const end = h.now() + timeoutMs;
    for (;;) {
      await cancelPending();
      const a = await account();
      if (a.statuses.cancelled === a.requests || h.now() > end) return { ...a, settled: a.statuses.cancelled === a.requests, unsettled: a.statuses.cancelled === a.requests ? [] : await diagnose() };
      await h.sleep(500);
    }
  };
  const resources = async () => {
    const q = rabbit.queues().find((x) => x.name === 'billing.payment-events');
    const s = await h.sessions(ADMIN, null);
    return { queueConsumers: Number(q?.consumers ?? 0), brokerConnections: rabbit.connections().length, brokerChannels: rabbit.channels().length, dbSessions: s.byDatabase, idleInTx: s.byState['idle in transaction'] ?? 0, livingProcesses: [...bills, ...pays].filter((x) => x && x.alive()).length };
  };
  const close = async () => {
    go = false;
    await loop;
    for (const s of [...bills, ...pays]) if (s && s.alive()) s.child.kill('SIGKILL');
    await Promise.all([...w.nodes, ...pays].filter(Boolean).map((s) => s.exited));
    await new Promise((r) => lb.close(r));
    await w.close();
    await payDb.drop();
  };
  return { w, payDb, bills, pays, startPayment, startBillingSlot, startTraffic, stopTraffic, account, settle, resources, errors, items, close, api };
}

C.restartCycles = async () => {
  // Billing + Payment under continuous traffic: 10 graceful cycles (SIGTERM both, start both), then 10 forced cycles (SIGKILL both
  // mid-traffic, start both at once). After each cycle: consumers, broker connections and channels, database sessions. At the end every
  // request is cancelled exactly once (one receipt applied, one Payment payment).
  const tw = await trafficWorld();
  const cycles = [];
  try {
    tw.startTraffic(100);
    await h.sleep(3000);
    const baseline = await tw.resources();
    for (const mode of ['graceful', 'sigkill']) {
      for (let i = 0; i < 10; i++) {
        await h.sleep(1500);
        const t = h.now();
        const victims = [tw.bills[0], tw.pays[0]];
        if (mode === 'graceful') await Promise.all(victims.map((v) => v.stop()));
        else { for (const v of victims) v.child.kill('SIGKILL'); await Promise.all(victims.map((v) => v.exited)); }
        const downMs = h.round(h.now() - t);
        await Promise.all([tw.startPayment(0), tw.startBillingSlot(0)]);
        const back = h.round(h.now() - t);
        await h.sleep(1500);
        cycles.push({ mode, cycle: i, stopMs: downMs, backReadyMs: back, ...(await tw.resources()) });
      }
      log(`restartCycles ${mode} done: ${JSON.stringify(cycles.at(-1))}`);
    }
    await tw.stopTraffic();
    const final = await tw.settle();
    await h.sleep(1500);
    return { baseline, cycles, final, finalResources: await tw.resources(), trafficErrors: tw.errors.slice(0, 20), trafficErrorCount: tw.errors.length };
  } finally {
    await tw.close();
  }
};

C.rollingRestart = async () => {
  // Billing A, B + Payment A, B under traffic (Billing → Payment through a failover proxy; traffic to the first live Billing).
  // Rolling deploy: SIGTERM Billing A → start A' → SIGTERM Billing B → start B' → the same for Payment. 3 rounds.
  const tw = await trafficWorld({ billings: 2, payments: 2 });
  const steps = [];
  try {
    tw.startTraffic(100);
    await h.sleep(3000);
    for (let round = 0; round < 3; round++) {
      for (const [kind, arr, startSlot] of [['billing', tw.bills, tw.startBillingSlot], ['payment', tw.pays, tw.startPayment]]) {
        for (const slot of [0, 1]) {
          const errsBefore = tw.errors.length;
          const t = h.now();
          await arr[slot].stop();
          const stopMs = h.round(h.now() - t);
          await startSlot(slot);
          await h.sleep(1000);
          steps.push({ round, kind, slot, stopMs, replacedMs: h.round(h.now() - t), trafficErrorsDuringStep: tw.errors.length - errsBefore, ...(await tw.resources()) });
        }
      }
      log(`rollingRestart round ${round}: ${JSON.stringify(steps.at(-1))}`);
    }
    await tw.stopTraffic();
    const final = await tw.settle();
    return { steps, final, trafficErrors: tw.errors.slice(0, 20), trafficErrorCount: tw.errors.length, requests: tw.items.length };
  } finally {
    await tw.close();
  }
};

C.backlogRestart = async () => {
  // A backlog across every durable queue, then a full stop and restart:
  //   Payment outbox rows unpublished (broker frozen while 30 cancellations are made), Billing requests never sent (Payment down while
  //   30 more are created), 20 stored webhooks due for retry, messages waiting in Billing's queue (Payment restarted and publishing
  //   while Billing is down). Everything is stopped, then started; every item must drain with one effect each.
  const tw = await trafficWorld();
  try {
    const first = await tw.w.seed(30, { waitRequested: true });
    tw.items.push(...first);
    rabbit.pause();
    for (const it of first) await tw.api('POST', `/billing/payment-requests/${it.requestId}/cancel`);
    await h.sleep(1000);
    const [outboxPending] = await h.adminQuery(tw.payDb.url, `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`);
    await tw.pays[0].stop();
    rabbit.unpause();
    const second = await tw.w.seed(30, { waitRequested: false });
    tw.items.push(...second);
    await h.sleep(2500);
    const [unsent] = await tw.w.q(`SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1) AND status IN ('created', 'sending')`, [second.map((x) => x.requestId)]);
    for (let i = 0; i < 20; i++) {
      const body = Buffer.from(JSON.stringify({ eventId: `evt_${randomUUID()}`, type: 'payment.succeeded', reference: `ghost-${randomUUID()}`, amount: 1000, currency: 'TND' }));
      await h.adminQuery(tw.payDb.url, `INSERT INTO webhook_event(provider, "providerEventId", "eventType", "rawBody", "receivedAt", state, attempts) VALUES ('test', $1, 'payment.succeeded', $2, now() - interval '1 day', 'unmatched', 0)`, [`evt_${randomUUID()}`, body]);
    }
    await tw.bills[0].stop();
    const t = h.now();
    await tw.startPayment(0);
    const queued = await h.waitFor(() => { const q = rabbit.queues().find((x) => x.name === 'billing.payment-events'); return Number(q?.messages_ready) >= 30 && Number(q.messages_ready); }, 30_000, 250);
    await tw.startBillingSlot(0);
    const backlog = { paymentOutboxPending: outboxPending.n, billingRequestsUnsent: unsent.n, webhooksDue: 20, billingQueueMessagesWhileDown: queued || 0 };
    const final = await tw.settle(120_000);
    const drainedMs = h.round(h.now() - t);
    const [wh] = await h.adminQuery(tw.payDb.url, `SELECT min(attempts)::int AS min, max(attempts)::int AS max FROM webhook_event`);
    return { backlog, final, drainedMs, webhookAttemptsAfter: wh, resources: await tw.resources() };
  } finally {
    await tw.close();
  }
};

C.cancelDuringPaymentOutage = async () => {
  // Minimal reproducer of the restartCycles leftover. Billing's cancel of a `requested` request calls Payment once; Payment answers 503
  // (restarting). What does the producer get, and does anything deliver the cancellation later? Reconciler every 1 s, stale window
  // 1 s (test values, so a reconciliation would have run many times). 5 iterations. Then a client retry of the same cancel call.
  const w = await core.billingWorld({ extra: { BILLING_RECONCILE_INTERVAL_MS: '1000', BILLING_RECONCILE_STALE_REQUESTED_MS: '1000' } });
  const rows = [];
  try {
    await w.startBilling();
    for (let i = 0; i < 5; i++) {
      const [item] = await w.seed(1);
      const pid = w.pay.byRequest.get(item.requestId);
      w.pay.setCancelHook(async () => 'unavailable');
      const c = await w.api('POST', `/billing/payment-requests/${item.requestId}/cancel`);
      w.pay.setCancelHook(async () => 'normal');
      await h.sleep(10_000);
      const [r] = await w.q('SELECT status, "cancelRequestedAt" IS NOT NULL AS marked FROM payment_request WHERE id = $1', [item.requestId]);
      const after10s = { billingStatus: r.status, cancelMarked: r.marked, paymentStatus: w.pay.payments.get(pid).status, cancelCallsReceivedByPayment: w.pay.cancels.get(pid) ?? 0, reconcilerGets: w.pay.gets.get(pid) ?? 0 };
      const retry = await w.api('POST', `/billing/payment-requests/${item.requestId}/cancel`);
      const healed = await h.waitFor(async () => (await w.q('SELECT status FROM payment_request WHERE id = $1', [item.requestId]))[0].status === 'cancelled', 15_000, 200);
      rows.push({ cancelAnswer: c.status, cancelBody: { status: c.json?.status, cancelRequestedAt: Boolean(c.json?.cancelRequestedAt) }, after10s, clientRetryAnswer: retry.status, cancelledAfterClientRetry: Boolean(healed), paymentStatusAfterRetry: w.pay.payments.get(pid).status });
    }
  } finally {
    await w.close();
  }
  return { iterations: rows.length, rows };
};

C.cancellationContract = async () => {
  // Stage 15.5 F-B correction: "if Billing answers success, Payment has cancelled (or is already terminal)". Billing + fake Payment (Payment's
  // cancel semantics: same key replays, other terminal states refused); when the fake actually cancels, the harness publishes
  // `payment.cancelled` as Payment's outbox would; the reconciler runs every 1 s as the backup path. Every answer is checked against
  // Payment's state AT THAT MOMENT: a 2xx while the payment is still payable is a violation.
  const w = await core.billingWorld({ extra: { BILLING_RECONCILE_INTERVAL_MS: '1000', BILLING_RECONCILE_STALE_REQUESTED_MS: '1000' } });
  const pub = paymentEventPublisher(rabbit.url);
  const rows = [];
  const violations = [];
  const emitted = new Map();
  const payable = (pid) => ['pending', 'created'].includes(w.pay.payments.get(pid).status);
  const cancel = async (item, node) => {
    try {
      const r = await w.api('POST', `/billing/payment-requests/${item.requestId}/cancel`, undefined, node);
      const pid = w.pay.byRequest.get(item.requestId);
      if (r.status >= 200 && r.status < 300 && payable(pid)) violations.push({ requestId: item.requestId, answer: r.status, paymentStatus: w.pay.payments.get(pid).status });
      return r.status;
    } catch (e) {
      return e.code ?? 'error';
    }
  };
  const emitIfCancelled = async (pid) => {
    const p = w.pay.payments.get(pid);
    if (p.status === 'cancelled' && !emitted.has(pid)) {
      emitted.set(pid, randomUUID());
      await pub.publish('payment.cancelled', p, { eventId: emitted.get(pid) });
    }
  };
  const final = async (item) => {
    const pid = w.pay.byRequest.get(item.requestId);
    await emitIfCancelled(pid);
    const want = w.pay.payments.get(pid).status === 'succeeded' ? 'paid' : 'cancelled';
    const ok = await h.waitFor(async () => (await w.q('SELECT status FROM payment_request WHERE id = $1', [item.requestId]))[0].status === want, 20_000, 100);
    const [r] = await w.q('SELECT status FROM payment_request WHERE id = $1', [item.requestId]);
    const [rc] = await w.q(`SELECT count(*) FILTER (WHERE outcome = 'applied')::int AS applied, count(*)::int AS receipts FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [item.requestId]);
    return { billing: r.status, settled: Boolean(ok), payment: w.pay.payments.get(pid).status, logicalCancels: w.pay.logicalCancels.get(pid) ?? 0, cancelCalls: w.pay.cancels.get(pid) ?? 0, applied: rc.applied, receipts: rc.receipts };
  };
  const retryUntilOk = async (item, node) => {
    const answers = [];
    for (let i = 0; i < 50; i++) {
      const s = await cancel(item, node ?? w.nodes.find((x) => x.alive()));
      answers.push(s);
      if (s === 200) break;
      await h.sleep(100);
    }
    return answers;
  };
  try {
    let svc = await w.startBilling();
    const window = async (name, n, fn) => {
      for (let i = 0; i < n; i++) {
        const [item] = await w.seed(1);
        const pid = w.pay.byRequest.get(item.requestId);
        w.pay.setCancelHook(async () => 'normal');
        const r = await fn(item, pid);
        w.pay.setCancelHook(async () => 'normal');
        rows.push({ window: name, ...r, final: r.skipFinal ? null : await final(item) });
      }
      log(`cancellationContract ${name} done`);
    };
    await window('B1 Payment unavailable, then back', 20, async (item) => {
      w.pay.setCancelHook(async () => 'unavailable');
      const first = await cancel(item);
      w.pay.setCancelHook(async () => 'normal');
      return { answers: [first, ...(await retryUntilOk(item))] };
    });
    await window('B2 Payment cancels, response lost', 20, async (item) => {
      w.pay.setCancelHook(async () => 'drop');
      const first = await cancel(item);
      w.pay.setCancelHook(async () => 'normal');
      return { answers: [first, ...(await retryUntilOk(item))] };
    });
    await window('B3 Payment cancels, Billing dies before answering', 20, async (item, pid) => {
      let release;
      let arrived = false;
      w.pay.setCancelHook(async () => { arrived = true; await new Promise((r) => (release = r)); return 'normal'; });
      const first = cancel(item);
      await h.waitFor(() => arrived, 10_000, 5);
      svc.child.kill('SIGKILL');
      await svc.exited;
      w.pay.setCancelHook(async () => 'normal');
      release();
      const a = await first;
      await h.waitFor(() => !payable(pid), 5000, 10);
      svc = await w.startBilling();
      return { answers: [a, ...(await retryUntilOk(item, svc))] };
    });
    await window('B4 Billing dies right after answering', 20, async (item) => {
      const a = await cancel(item);
      svc.child.kill('SIGKILL');
      await svc.exited;
      await emitIfCancelled(w.pay.byRequest.get(item.requestId)); // Payment's event, published while Billing is down
      svc = await w.startBilling();
      return { answers: [a] };
    });
    await window('B6 duplicate cancellation', 20, async (item) => ({ answers: [await cancel(item), await cancel(item)] }));
    await window('B7 three concurrent cancellations', 20, async (item) => ({ answers: await Promise.all([cancel(item), cancel(item), cancel(item)]) }));
    await window('B8 cancellation races payment success', 20, async (item, pid) => {
      const succeed = (async () => {
        await h.sleep(Math.random() * 20);
        const p = w.pay.payments.get(pid);
        if (p.status !== 'pending') return 'refused'; // Payment: no attempt can start on a cancelled payment
        w.pay.settle(pid, 'succeeded');
        await pub.publish('payment.succeeded', p);
        return 'succeeded';
      })();
      const answers = await Promise.all([(async () => { await h.sleep(Math.random() * 20); return cancel(item); })(), succeed]);
      return { answers: [answers[0]], success: answers[1], okWhilePaymentSucceeded: answers[0] === 200 && answers[1] === 'succeeded' };
    });
    await window('B9 cancellation races reconciliation', 20, async (item) => {
      await h.sleep(1100); // the request is now stale for the reconciler (1 s), which reads Payment every 1 s
      const a = await cancel(item);
      await h.sleep(Math.random() * 1000);
      return { answers: [a] };
    });
    await window('B10 cancellation races a restart (SIGTERM)', 20, async (item, pid) => {
      let release;
      let arrived = false;
      const holdPastDrain = rows.filter((r) => r.window.startsWith('B10')).length % 2 === 1;
      w.pay.setCancelHook(async () => { arrived = true; await new Promise((r) => (release = r)); return 'normal'; });
      const first = cancel(item);
      await h.waitFor(() => arrived, 10_000, 5);
      const tS = h.now();
      svc.child.kill('SIGTERM');
      const rel = holdPastDrain ? null : h.sleep(1000).then(() => { w.pay.setCancelHook(async () => 'normal'); release(); });
      const ex = await svc.exited;
      const exitMs = h.round(ex.t - tS);
      await rel;
      if (holdPastDrain) { w.pay.setCancelHook(async () => 'normal'); release(); }
      const a = await first;
      await h.waitFor(() => !payable(pid), 3000, 10);
      svc = await w.startBilling();
      const more = a === 200 ? [] : await retryUntilOk(item, svc);
      return { answers: [a, ...more], exitMs, heldPastDrain: holdPastDrain };
    });
    await window('B11 Payment refuses (open attempt)', 20, async (item, pid) => {
      w.pay.setCancelHook(async () => 'open_attempt');
      const a = await cancel(item);
      const stillPayable = payable(pid);
      w.pay.setCancelHook(async () => 'normal');
      w.pay.settle(pid, 'cancelled'); // the attempt later fails and the caller cancels again: closes the fixture
      await emitIfCancelled(pid);
      return { answers: [a], paymentPayableAfterRefusal: stillPayable };
    });
    await window('B12 transient failures, then recovery', 20, async (item) => {
      let failures = 3;
      w.pay.setCancelHook(async () => (failures-- > 0 ? 'unavailable' : 'normal'));
      return { answers: await retryUntilOk(item) };
    });
    await svc.stop();
  } finally {
    await pub.close().catch(() => undefined);
    await w.close();
  }
  const groups = {};
  for (const r of rows) (groups[r.window] ??= []).push(r);
  const summary = {};
  for (const [name, xs] of Object.entries(groups)) {
    summary[name] = {
      iterations: xs.length, answers: [...new Set(xs.map((x) => x.answers.join('→')))],
      finalBilling: [...new Set(xs.map((x) => x.final?.billing))], finalPayment: [...new Set(xs.map((x) => x.final?.payment))],
      settled: xs.filter((x) => x.final?.settled).length, maxLogicalCancels: Math.max(...xs.map((x) => x.final?.logicalCancels ?? 0)),
      appliedReceipts: [...new Set(xs.map((x) => x.final?.applied))], cancelCallsPerRequest: [...new Set(xs.map((x) => x.final?.cancelCalls))],
      ...(xs[0].success !== undefined ? { paymentSideWinner: xs.reduce((m, x) => ((m[x.success] = (m[x.success] ?? 0) + 1), m), {}), answered200ButPaymentSucceeded: xs.filter((x) => x.okWhilePaymentSucceeded).length } : {}),
      ...(xs[0].exitMs !== undefined ? { exitMs: h.stats(xs.map((x) => x.exitMs)), heldPastDrain: xs.filter((x) => x.heldPastDrain).length } : {}),
      ...(xs[0].paymentPayableAfterRefusal !== undefined ? { paymentPayableAfterRefusal: xs.filter((x) => x.paymentPayableAfterRefusal).length } : {}),
    };
  }
  return { violations, summary };
};

C.cancellationLivePayment = async () => {
  // The same contract against the REAL payment-service and its real outbox/events: (1) Payment stopped: Billing answers 503; Payment
  // started again: the retry is accepted, the event arrives, the request is cancelled once. (2) Payment's broker frozen (B5): the
  // synchronous confirmation does not need the broker; the cancelled event waits in Payment's outbox and is delivered after the thaw.
  const pw = await pairWorld();
  const rows = [];
  try {
    const items = await pw.w.seed(20, { orgs: [randomUUID()] });
    const status = async (it) => (await pw.w.q('SELECT status FROM payment_request WHERE id = $1', [it.requestId]))[0].status;
    const paymentOf = async (it) => (await pw.pq(`SELECT status FROM payment WHERE "paymentRequestId"::text = $1`, [it.requestId]))[0].status;
    for (const [k, it] of items.entries()) {
      if (k < 10) {
        const p = pw.payments.at(-1);
        p.child.kill('SIGKILL');
        await p.exited;
        const first = await pw.cancel(it);
        const payableWhileDown = (await paymentOf(it)) === 'pending' || (await paymentOf(it)) === 'created';
        await pw.startPayment();
        const retry = await pw.cancel(it);
        const done = await h.waitFor(async () => (await status(it)) === 'cancelled', 30_000, 100);
        rows.push({ mode: 'paymentDown', answers: [first.status, retry.status], acceptedWhilePayable: first.status === 200 && payableWhileDown, billing: done ? 'cancelled' : await status(it), payment: await paymentOf(it) });
      } else {
        pw.proxy.freeze();
        const c = await pw.cancel(it);
        const paymentAfter = await paymentOf(it);
        await h.sleep(1000);
        const beforeThaw = await status(it);
        pw.proxy.thaw();
        const done = await h.waitFor(async () => (await status(it)) === 'cancelled', 60_000, 100);
        rows.push({ mode: 'brokerFrozen', answers: [c.status], paymentAfterAnswer: paymentAfter, billingBeforeThaw: beforeThaw, billing: done ? 'cancelled' : await status(it) });
      }
    }
    const acct = await pw.account(items);
    return {
      rows: ['paymentDown', 'brokerFrozen'].map((m) => {
        const xs = rows.filter((r) => r.mode === m);
        return { mode: m, iterations: xs.length, answers: [...new Set(xs.map((x) => x.answers.join('→')))], acceptedWhilePayable: xs.filter((x) => x.acceptedWhilePayable).length, billing: [...new Set(xs.map((x) => x.billing))], payment: [...new Set(xs.map((x) => x.payment ?? x.paymentAfterAnswer))], billingBeforeThaw: [...new Set(xs.map((x) => x.billingBeforeThaw).filter(Boolean))] };
      }),
      accounting: acct,
    };
  } finally {
    await pw.close();
  }
};

C.paymentCancelVsSuccess = async () => {
  // Payment's side of the race, in process (15.4 Payment layer): the producer's cancel and a successful attempt start on the same payment
  // at the same moment, 20 times. Payment serialises both on the payment row: exactly one terminal state and at most one terminal event.
  const { paymentWorlds } = await import('./lib/payment-world.mjs');
  const w = await paymentWorlds({ adminUrl: ADMIN, later })();
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const { payment } = await w.createPayment();
    const a = w.instance(`race-a-${i}`);
    const b = w.instance(`race-b-${i}`);
    const out = await Promise.allSettled([
      a.payments.cancel(payment.id, 'billing-service', `billing-cancel-${payment.id}`),
      w.startAttempt(payment.id, 'success', randomUUID(), b.attempts),
    ]);
    const [p] = await w.q('SELECT status FROM payment WHERE id = $1', [payment.id]);
    const [ev] = await w.q(`SELECT count(*) FILTER (WHERE name IN ('payment.succeeded', 'payment.cancelled', 'payment.failed', 'payment.expired'))::int AS terminal FROM outbox WHERE payload->>'paymentId' = $1`, [payment.id]);
    rows.push({ cancel: out[0].status === 'fulfilled' ? 'ok' : describeFailure(out[0].reason), attempt: out[1].status === 'fulfilled' ? 'ok' : describeFailure(out[1].reason), payment: p.status, terminalEvents: ev.terminal });
    await a.pool.onApplicationShutdown();
    await b.pool.onApplicationShutdown();
  }
  const key = (r) => `payment=${r.payment} cancel=${r.cancel.split(' ')[0]} attempt=${r.attempt.split(' ')[0]}`;
  return { iterations: rows.length, outcomes: rows.reduce((m, r) => ((m[key(r)] = (m[key(r)] ?? 0) + 1), m), {}), terminalEvents: [...new Set(rows.map((r) => r.terminalEvents))] };
};

C.keepAliveMany = async () => {
  // Stage 15.5 (F-A, case F): 10 keep-alive clients, each on its own connection, busy when SIGTERM arrives and still sending afterwards.
  // The shutdown must stay bounded by the drain design, not by clients × anything. 3 runs per service.
  const out = {};
  for (const service of ['billing-service', 'payment-service']) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const db = await h.throwawayDatabase(ADMIN, service);
      try {
        const svc = await core.start(service, { db });
        const agents = Array.from({ length: 10 }, () => new http.Agent({ keepAlive: true, maxSockets: 1 }));
        let go = true;
        const statuses = [];
        let tS = null;
        const clients = agents.map((agent) => (async () => {
          while (go) {
            const t = h.now();
            const r = await new Promise((resolve) => { const req = http.get(`${svc.base}/ready`, { agent }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', (e) => resolve(e.code)); });
            if (tS !== null && t >= tS) statuses.push(r);
            await h.sleep(5);
          }
        })());
        await h.sleep(500);
        tS = h.now();
        svc.child.kill('SIGTERM');
        const ex = await Promise.race([svc.exited, h.sleep(30_000).then(() => null)]);
        go = false;
        await Promise.all(clients);
        agents.forEach((a) => a.destroy());
        if (!ex) svc.child.kill('SIGKILL');
        runs.push({ exitedMs: ex ? h.round(ex.t - tS) : null, answersAfterSigterm: statuses.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {}) });
      } finally {
        await db.drop();
      }
    }
    out[service] = { exitedMs: h.stats(runs.map((r) => r.exitedMs ?? 30_000)), notExited: runs.filter((r) => r.exitedMs === null).length, runs };
    log(`keepAliveMany ${service}: ${JSON.stringify(out[service].exitedMs)}`);
  }
  return out;
};

C.repeatedStop = async () => {
  // The kit PollLoop with a pass that never ends: what does a second stop() (Nest calls stop in beforeApplicationShutdown AND in
  // onApplicationShutdown) and two concurrent stop() calls cost?
  const hang = () => new Promise(() => undefined);
  const drainTimeouts = [];
  const loop = new PollLoop(hang, () => undefined, (ms) => drainTimeouts.push(ms));
  loop.start(10, 0);
  await h.sleep(50);
  let t = h.now();
  const first = await loop.stop();
  const firstMs = h.now() - t;
  t = h.now();
  const second = await loop.stop();
  const secondMs = h.now() - t;
  const loop2 = new PollLoop(hang);
  loop2.start(10, 0);
  await h.sleep(50);
  t = h.now();
  const both = await Promise.all([loop2.stop(), loop2.stop()]);
  const concurrentMs = h.now() - t;
  const loop3 = new PollLoop(async () => h.sleep(200));
  loop3.start(10, 0);
  await h.sleep(50);
  t = h.now();
  const drained = await loop3.stop();
  const drainedMs = h.now() - t;
  t = h.now();
  const again = await loop3.stop();
  return {
    hungPass: { firstStop: first, firstMs: h.round(firstMs), secondStop: second, secondMs: h.round(secondMs), drainTimeoutNotices: drainTimeouts.length },
    concurrentStops: { outcomes: both, totalMs: h.round(concurrentMs) }, finishingPass: { first: drained, firstMs: h.round(drainedMs), second: again, secondMs: h.round(h.now() - t) },
  };
};

// ------------------------------------------------------------------------------------------------ run
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
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
  for (const c of closers.reverse()) await Promise.resolve().then(c).catch(() => undefined);
  const env = await h.environment(ADMIN).catch(() => ({}));
  rabbit.stop();
  pgc.stop();
  const doc = JSON.stringify({ env: { ...env, rabbitmq: '3.13 (throwaway container)' }, started, results, uncaughtOrUnhandled: uncaught, finished: new Date().toISOString() }, null, 1);
  if (outFile) writeFileSync(outFile, doc);
  else process.stdout.write(doc + '\n');
}
