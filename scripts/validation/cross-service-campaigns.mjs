#!/usr/bin/env node
// Stage 15.6: cross-service failure campaigns (test-only). Plan, invariants and criteria: docs/architecture/core-validation.md.
//
//   node scripts/validation/cross-service-campaigns.mjs [--out results.json] [campaign ...]      (default: all, in plan order)
//
// Starts its OWN throwaway RabbitMQ and PostgreSQL containers (`validation-*`, loopback) and removes them at the end. Real Billing and
// Payment processes (lib/core-stack.mjs: every cross-service edge individually breakable), real Auth and Organization where their
// behaviour is under test. Never touches another container, a non-loopback host or production. Needs built workspaces.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { describeFailure } from '../../libs/service-kit/dist/index.js';
import * as h from './lib/harness.mjs';
import { coreStacks } from './lib/core-stack.mjs';
import { paymentEventPublisher } from './lib/fake-payment.mjs';
import { liveCore, probe } from './lib/live-core.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('refusing to run with NODE_ENV=production');
const log = (...a) => process.stderr.write(`[15.6] ${a.join(' ')}\n`);
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
const stack = coreStacks({ adminUrl: ADMIN, rabbit, pgPort: pgc.port });
const core = liveCore({ adminUrl: ADMIN, rabbit });
const count = (xs) => xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

const C = {};

C.smoke = async () => {
  // The stack drives the real flow end to end: invoice → request → dispatcher → Payment; the payer pays (payment.succeeded → paid);
  // the producer cancels another (payment.cancelled → cancelled).
  const s = await stack();
  try {
    const [a, b] = await s.seed(2);
    const paid = await s.pay(a);
    const cancel = await s.billingCancel(b);
    const fa = await s.until(a, (x) => x.request === 'paid');
    const fb = await s.until(b, (x) => x.request === 'cancelled');
    return { paid, cancel: cancel.status, a: fa, b: fb, readiness: await s.readiness(), resources: await s.resources() };
  } finally {
    await s.close();
  }
};

// ------------------------------------------------------------------------------------------------ helpers
const waitingOnLock = async (db) => (await h.adminQuery(ADMIN, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [db.name]))[0].n;
/** Test-only barriers in Billing's consumer transaction (15.5): stage B after the receipt INSERT, stage C inside COMMIT; lock 4242. */
async function consumerBarriers(s) {
  await s.bq(`
    CREATE TABLE IF NOT EXISTS validation_barrier (event_id text PRIMARY KEY, stage text NOT NULL);
    CREATE OR REPLACE FUNCTION validation_wait() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM validation_barrier WHERE event_id = NEW."eventId"::text AND stage = TG_ARGV[0]) THEN
        PERFORM pg_advisory_lock_shared(4242);
        PERFORM pg_advisory_unlock_shared(4242);
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS validation_b ON payment_event_receipt;
    DROP TRIGGER IF EXISTS validation_c ON payment_event_receipt;
    CREATE TRIGGER validation_b AFTER INSERT ON payment_event_receipt FOR EACH ROW EXECUTE FUNCTION validation_wait('B');
    CREATE CONSTRAINT TRIGGER validation_c AFTER INSERT ON payment_event_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validation_wait('C');`);
  const pg = (await import('pg')).default;
  const gate = new pg.Client({ connectionString: s.bdb.url, application_name: 'validation-gate' });
  await gate.connect();
  return {
    hold: () => gate.query('SELECT pg_advisory_lock(4242)'),
    release: () => gate.query('SELECT pg_advisory_unlock(4242)'),
    close: () => gate.end().catch(() => undefined),
  };
}
/** The id of the terminal Payment event for `item` (Payment's own outbox row id is the event id). */
const eventIdOf = async (s, item, name = 'payment.cancelled') => {
  const [p] = await s.paymentOf(item);
  return (await s.pq(`SELECT id::text FROM outbox WHERE payload->>'paymentId' = $1 AND name = $2`, [p.id, name]))[0]?.id;
};
/** Simulates a restart policy (`--restart unless-stopped`): starts `name` again whenever it exits, until `stop()`. */
function supervise(s, name, extra = {}) {
  let go = true;
  const starts = [];
  const loop = (async () => {
    while (go) {
      if (!s.procs[name]?.alive()) {
        starts.push(h.now());
        await s.start(name, { waitReady: false, extra }).catch(() => undefined);
      }
      await h.sleep(1000);
    }
  })();
  return { starts, stop: async () => { go = false; await loop; } };
}

C.paymentDownBillingUp = async () => {
  // Campaign A. Payment unavailable while Billing runs: (1) the process stopped (connections refused); (2) Payment hung (accepted, never
  // answered). Billing: liveness/readiness, unrelated operations, a new payment request, the cancel of a sent one (the synchronous
  // Billing → Payment contract), its retry. Then Payment back: convergence. 3 runs per mode.
  const out = {};
  for (const mode of ['stopped', 'hung']) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const s = await stack();
      try {
        const [x] = await s.seed(1);
        if (mode === 'stopped') await s.stop('payment');
        else s.payHttp.setMode('blackhole');
        const ready = await s.readiness();
        const inv = await s.invoice();
        const unrelated = { invoiceCreatedAndIssued: true, read: (await s.billingApi('GET', `/billing/invoices/${inv.invoiceId}`)).status };
        const fresh = await s.request(inv);
        const cancel1 = await s.billingCancel(x);
        const cancel2 = await s.billingCancel(x);
        await h.sleep(1500);
        const [fr] = await s.bq('SELECT status FROM payment_request WHERE id = $1', [fresh.requestId]);
        const whileDown = { billing: ready.billing, unrelated, cancel: [cancel1.status, cancel1.json?.code, cancel1.ms], cancelRetry: cancel2.status, newRequestAccepted: true, newRequestState: fr.status, xState: (await s.state(x)).request, xPayment: (await s.paymentOf(x))[0]?.status };
        const t = h.now();
        if (mode === 'stopped') await s.start('payment');
        else s.payHttp.setMode('pass');
        const retry = await s.billingCancel(x);
        const cx = await s.until(x, (st) => st.request === 'cancelled');
        const ok = await s.requested([fresh]);
        runs.push({ whileDown, recovery: { cancelRetry: retry.status, xConverged: Boolean(cx), freshRequested: Boolean(ok), convergedMs: h.round(h.now() - t) }, account: await s.account([x, fresh]) });
      } finally {
        await s.close();
      }
    }
    out[mode] = { runs, cancelErrorMs: h.stats(runs.map((r) => r.whileDown.cancel[2])) };
    log(`paymentDownBillingUp ${mode}: cancel ${JSON.stringify(out[mode].cancelErrorMs)}`);
  }
  return out;
};

C.billingDownPaymentUp = async () => {
  // Campaign B. Billing stopped; Payment progresses on its own: the producer's cancel straight to Payment, and a payer's payment. Payment
  // needs Billing for neither; the events wait in Billing's durable queue; Billing restarted: each applied once. 5 runs.
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const s = await stack();
    try {
      const [a, b] = await s.seed(2);
      await s.stop('billing');
      const c = await s.paymentCancelDirect(a);
      const p = await s.pay(b);
      const paymentReady = (await s.readiness()).payment;
      await h.waitFor(async () => (await s.resources()).outboxPending.payment === 0, 15_000, 100);
      const queued = (await s.resources()).queueReady;
      const beforeRestart = [(await s.state(a)).request, (await s.state(b)).request];
      const t = h.now();
      await s.start('billing');
      const fa = await s.until(a, (x) => x.request === 'cancelled');
      const fb = await s.until(b, (x) => x.request === 'paid');
      runs.push({ paymentCancel: c.status, pay: p, paymentReadyWhileBillingDown: paymentReady, eventsQueued: queued, billingStateBeforeRestart: beforeRestart, convergedAfterRestartMs: h.round(h.now() - t), a: fa, b: fb, account: await s.account([a, b]) });
    } finally {
      await s.close();
    }
  }
  return { runs, eventsQueued: [...new Set(runs.map((r) => r.eventsQueued))], converged: runs.filter((r) => r.a && r.b).length, convergedMs: h.stats(runs.map((r) => r.convergedAfterRestartMs)) };
};

C.paymentRestartDuringBillingRequest = async () => {
  // Campaign C. The synchronous Billing → Payment calls cut at each point, 20 iterations per window:
  //   C1 before Payment (connection dropped); C2 inside Payment's transaction (its database frozen) and Payment SIGKILLed;
  //   C3 after Payment committed, the answer lost; C4 the answer cut after its status line; C5 the dispatcher's create answer lost;
  //   C6 Payment SIGKILLed inside the create (database frozen). The caller retries the same call; one payment, one cancellation.
  const s = await stack({ billingEnv: { BILLING_DISPATCH_STALE_SENDING_MS: '3000' } });
  const rows = [];
  try {
    const cancelWindow = async (name, cut) => {
      for (let i = 0; i < 20; i++) {
        const [x] = await s.seed(1);
        const first = await cut(x);
        s.payHttp.setMode('pass');
        const retry = await (async () => { for (let k = 0; k < 20; k++) { const r = await s.billingCancel(x); if (r.status === 200) return r.status; await h.sleep(300); } return 'gave-up'; })();
        const fin = await s.until(x, (st) => st.request === 'cancelled', 30_000);
        rows.push({ window: name, first, retry, final: fin || (await s.state(x)) });
      }
      log(`paymentRestartDuringBillingRequest ${name} done`);
    };
    await cancelWindow('C1 before Payment', async (x) => { s.payHttp.setMode('refuse'); return (await s.billingCancel(x)).status; });
    await cancelWindow('C2 Payment killed inside its transaction', async (x) => {
      s.dbProxy.payment.freeze();
      const pending = s.billingCancel(x);
      await h.sleep(400);
      await s.kill('payment');
      s.dbProxy.payment.thaw();
      const r = await pending;
      await s.start('payment');
      return r.status;
    });
    await cancelWindow('C3 committed, answer lost', async (x) => { s.payHttp.setOnRequest((req) => (req.url.endsWith('/cancel') ? 'drop' : null)); const r = await s.billingCancel(x); s.payHttp.setOnRequest(null); return r.status; });
    await cancelWindow('C4 answer cut after the status line', async (x) => { s.payHttp.setOnRequest((req) => (req.url.endsWith('/cancel') ? 'truncate' : null)); const r = await s.billingCancel(x); s.payHttp.setOnRequest(null); return r.status; });
    for (let i = 0; i < 20; i++) {
      s.payHttp.setOnRequest((req) => (req.method === 'POST' && req.url === '/payment/payments' ? 'drop' : null));
      const [x] = await s.seed(1, { wait: false });
      await h.waitFor(() => s.payHttp.seen.filter((r) => r.mode === 'drop').length > i, 10_000, 20);
      s.payHttp.setOnRequest(null);
      const ok = await s.requested([x], 30_000);
      rows.push({ window: 'C5 create answer lost', first: 'dropped', retry: ok ? 'requested' : 'stuck', final: await s.state(x) });
    }
    log('paymentRestartDuringBillingRequest C5 done');
    for (let i = 0; i < 10; i++) {
      s.dbProxy.payment.freeze();
      const [x] = await s.seed(1, { wait: false });
      await h.sleep(1200); // the dispatcher's create is inside Payment, waiting on its frozen database
      await s.kill('payment');
      s.dbProxy.payment.thaw();
      await s.start('payment');
      const ok = await s.requested([x], 30_000);
      rows.push({ window: 'C6 Payment killed inside the create', first: 'killed', retry: ok ? 'requested' : 'stuck', final: await s.state(x) });
    }
  } finally {
    await s.close();
  }
  const group = {};
  for (const r of rows) (group[r.window] ??= []).push(r);
  return Object.fromEntries(Object.entries(group).map(([k, xs]) => [k, {
    iterations: xs.length, firstAnswers: count(xs.map((x) => x.first)), retries: count(xs.map((x) => x.retry)), finalRequest: count(xs.map((x) => x.final.request)),
    maxPayments: Math.max(...xs.map((x) => x.final.payments)), maxTerminalEvents: Math.max(...xs.map((x) => x.final.terminalEvents)), maxApplied: Math.max(...xs.map((x) => x.final.applied)), idMismatch: xs.filter((x) => x.final.payments && !x.final.paymentIdMatches).length,
  }]));
};

C.billingRestartDuringPaymentEvent = async () => {
  // Campaign D. A real Payment terminal event (the producer's cancel straight to Payment) reaches Billing, and Billing is SIGKILLed:
  //   D1 before delivery (Billing down when the event is published); D2 after the receipt INSERT, before COMMIT; D3 inside COMMIT (the
  //   commit then completes on the server: after commit, before ack). 20 iterations for D2 and D3, 5 for D1. One commercial effect.
  const s = await stack();
  const rows = [];
  const bar = await consumerBarriers(s);
  try {
    for (let i = 0; i < 5; i++) {
      const [x] = await s.seed(1);
      await s.stop('billing');
      await s.paymentCancelDirect(x);
      await h.sleep(500);
      await s.start('billing');
      rows.push({ window: 'D1 before delivery', final: (await s.until(x, (st) => st.request === 'cancelled', 30_000)) || (await s.state(x)) });
    }
    log('billingRestartDuringPaymentEvent D1 done');
    // D2 / D3 with the barrier in place BEFORE the event is published: Payment's broker link frozen while the cancel commits, then thawed.
    for (const [name, stage] of [['D2 after receipt, before commit', 'B'], ['D3 inside commit (after commit, before ack)', 'C']]) {
      for (let i = 0; i < 20; i++) {
        const [x] = await s.seed(1);
        s.brokerProxy.payment.freeze();
        await s.paymentCancelDirect(x);
        const eventId = await eventIdOf(s, x);
        await s.bq('INSERT INTO validation_barrier (event_id, stage) VALUES ($1, $2) ON CONFLICT DO NOTHING', [eventId, stage]);
        await bar.hold();
        s.brokerProxy.payment.thaw();
        const reached = await h.waitFor(async () => (await waitingOnLock(s.bdb)) > 0, 20_000, 20);
        await s.kill('billing');
        await h.sleep(200);
        await bar.release();
        await h.sleep(200);
        const afterKill = await s.state(x);
        await s.start('billing');
        const fin = await s.until(x, (st) => st.request === 'cancelled', 30_000);
        rows.push({ window: name, reached: Boolean(reached), committedBeforeRestart: afterKill.receipts, final: fin || (await s.state(x)) });
      }
      log(`billingRestartDuringPaymentEvent ${name} done`);
    }
  } finally {
    await bar.close();
    await s.close();
  }
  const group = {};
  for (const r of rows) (group[r.window] ??= []).push(r);
  return Object.fromEntries(Object.entries(group).map(([k, xs]) => [k, {
    iterations: xs.length, barrierReached: xs.filter((x) => x.reached).length, committedBeforeRestart: xs.filter((x) => x.committedBeforeRestart).length,
    finalRequest: count(xs.map((x) => x.final.request)), receipts: count(xs.map((x) => x.final.receipts)), maxApplied: Math.max(...xs.map((x) => x.final.applied)), maxTerminalEvents: Math.max(...xs.map((x) => x.final.terminalEvents)),
  }]));
};

/** Real Auth and Organization (their own throwaway databases; Organization's Auth is the real Auth). */
async function edgeServices() {
  const adb = await h.throwawayDatabase(ADMIN, 'auth-service');
  const odb = await h.throwawayDatabase(ADMIN, 'organization-service');
  const auth = await core.start('auth-service', { db: adb, extra: { NODE_ENV: 'development' } });
  const org = await core.start('organization-service', { db: odb, extra: { AUTH_SERVICE_URL: auth.base } });
  return {
    auth, org, adb, odb,
    snapshot: async () => {
      const one = async (svc, ready, op) => {
        if (!svc.alive()) return { alive: false };
        const [r, l, o] = await Promise.all([probe(svc.base, ready, 3000), probe(svc.base, '/health', 3000), op()]);
        return { alive: true, health: l.status, ready: r.status, operation: o };
      };
      return {
        auth: await one(auth, '/ready', async () => (await fetch(`${auth.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'nobody@example.test', password: 'wrong-password-123' }) }).catch(() => ({ status: 'unreachable' }))).status),
        organization: await one(org, '/ready', async () => (await probe(org.base, '/health', 3000)).status),
      };
    },
    close: async () => {
      for (const p of [auth, org]) if (p.alive()) { p.child.kill('SIGKILL'); await p.exited; }
      await adb.drop();
      await odb.drop();
    },
  };
}

C.rabbitDown = async () => {
  // Campaign E. RabbitMQ stopped while Auth, Organization, Billing, Payment and PostgreSQL run. Per service: process, /health, /ready,
  // an unrelated operation, an event-producing operation, outbox accumulation. Then RabbitMQ back: reconnect, one consumer, outboxes
  // drain, delayed events applied once. 3 runs (timings: outage detection, consumer restored, backlog drained).
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const s = await stack();
    const e = await edgeServices();
    try {
      const [a, b, c] = await s.seed(3);
      rabbit.appStop();
      const tDown = h.now();
      const detected = await h.waitFor(async () => (await s.readiness()).billing.ready === 503 && h.now(), 30_000, 100);
      const inv = await s.invoice(); // Billing: unrelated, and it writes Billing's own outbox events (invoice.*)
      const cancel = await s.billingCancel(a); // synchronous to Payment: needs no broker; Payment's event waits in its outbox
      const direct = await s.paymentCancelDirect(b);
      const paid = await s.pay(c);
      await h.sleep(2000);
      const res = await s.resources();
      const matrix = { ...(await e.snapshot()), ...(await s.readiness()) };
      const whileDown = { detectedMs: detected ? h.round(detected - tDown) : null, matrix, unrelatedBilling: Boolean(inv.invoiceId), billingCancel: cancel.status, paymentDirectCancel: direct.status, pay: paid, outboxPending: res.outboxPending, states: [(await s.state(a)).request, (await s.state(b)).request, (await s.state(c)).request] };
      const tUp = h.now();
      await rabbit.appStart();
      const consumer = await h.waitFor(async () => (await s.resources()).queueConsumers === 1 && h.now(), 60_000, 100);
      const done = await h.waitFor(async () => { const r = await s.resources(); const sa = await s.state(a); const sb = await s.state(b); const sc = await s.state(c); return r.outboxPending.payment === 0 && r.outboxPending.billing === 0 && sa.request === 'cancelled' && sb.request === 'cancelled' && sc.request === 'paid' && h.now(); }, 120_000, 200);
      runs.push({ whileDown, recovery: { consumerRestoredMs: consumer ? h.round(consumer - tUp) : null, convergedMs: done ? h.round(done - tUp) : null, resources: await s.resources(), matrix: { ...(await e.snapshot()), ...(await s.readiness()) } }, account: await s.account([a, b, c]) });
      log(`rabbitDown ${i}: detected ${runs.at(-1).whileDown.detectedMs} ms, consumer back ${runs.at(-1).recovery.consumerRestoredMs} ms, converged ${runs.at(-1).recovery.convergedMs} ms`);
    } finally {
      await e.close();
      await s.close();
    }
  }
  return { runs, detectedMs: h.stats(runs.map((r) => r.whileDown.detectedMs ?? 0)), consumerRestoredMs: h.stats(runs.map((r) => r.recovery.consumerRestoredMs ?? 0)), convergedMs: h.stats(runs.map((r) => r.recovery.convergedMs ?? 0)) };
};

C.perServiceDbDown = async () => {
  // Campaigns F and H. One service's database gone (connections refused) or hung (frozen) while the other service and its database are fine.
  //   F1 Billing DB down: Billing /ready 503; Payment unaffected (its own operations); recovery without any restart.
  //   F2 / H Payment DB down or hung: Payment /ready 503; Billing's unrelated operations fine; Billing's cancel (needs Payment) answers
  //   503 within a bound, never success; retry after recovery succeeds once. 3 runs each.
  const out = {};
  for (const [label, svc, fault] of [['billingDbDown', 'billing', 'down'], ['paymentDbDown', 'payment', 'down'], ['paymentDbHung', 'payment', 'freeze']]) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const s = await stack();
      try {
        const [x, y] = await s.seed(2);
        const t0 = h.now();
        if (fault === 'down') await s.dbProxy[svc].down();
        else s.dbProxy[svc].freeze();
        const detected = await h.waitFor(async () => (await s.readiness())[svc].ready === 503 && h.now(), 30_000, 100);
        const matrix = await s.readiness();
        let ops;
        if (svc === 'billing') {
          ops = { paymentDirectCancel: (await s.paymentCancelDirect(y)).status, paymentReady: matrix.payment.ready, billingInvoiceRead: (await s.billingApi('GET', `/billing/invoices/${x.invoiceId}`)).status };
        } else {
          const inv = await s.invoice();
          const c = await s.billingCancel(x);
          ops = { billingUnrelated: Boolean(inv.invoiceId), billingCancel: [c.status, c.json?.code, c.ms], xPayment: (await s.paymentOf(x))[0]?.status ?? '(db unreachable)' };
        }
        const tUp = h.now();
        if (fault === 'down') await s.dbProxy[svc].up();
        else s.dbProxy[svc].thaw();
        const back = await h.waitFor(async () => (await s.readiness())[svc].ready === 200 && h.now(), 60_000, 100);
        if (svc === 'payment') {
          await (async () => { for (let k = 0; k < 20; k++) { if ((await s.billingCancel(x)).status === 200) return; await h.sleep(500); } })();
          await s.until(x, (st) => st.request === 'cancelled', 30_000);
        } else await s.until(y, (st) => st.request === 'cancelled', 60_000);
        runs.push({ detectedMs: detected ? h.round(detected - t0) : null, matrix, ops, readyAgainMs: back ? h.round(back - tUp) : null, noRestart: s.procs.billing.alive() && s.procs.payment.alive(), account: await s.account([x, y]), finals: [(await s.state(x)).request, (await s.state(y)).request] });
      } finally {
        await s.close();
      }
    }
    out[label] = { runs, readyAgainMs: h.stats(runs.map((r) => r.readyAgainMs ?? 0)), ...(svc === 'payment' ? { billingCancelErrorMs: h.stats(runs.map((r) => r.ops.billingCancel[2])) } : {}) };
    log(`perServiceDbDown ${label}: ${JSON.stringify(runs.map((r) => r.ops))}`);
  }
  return out;
};

C.billingDbDownWhileEventArrives = async () => {
  // Campaign G. A real Payment event reaches Billing while Billing's database is gone. Short outage (5 s, inside the consumer's retry
  // budget of 3 × 5 s): retried, applied once. Long outage (25 s): dead-lettered, then the reconciler settles it from Payment (reconciler
  // every 2 s, stale window 5 s: test values). Never acked as done before the effect is committed; one effect either way.
  const out = {};
  for (const [label, outageMs, runs] of [['shortOutage', 5000, 5], ['longOutage', 25_000, 3]]) {
    const rows = [];
    for (let i = 0; i < runs; i++) {
      const s = await stack({ billingEnv: { BILLING_RECONCILE_INTERVAL_MS: '2000', BILLING_RECONCILE_STALE_REQUESTED_MS: '5000' } });
      try {
        const [x] = await s.seed(1);
        await s.dbProxy.billing.down();
        await s.paymentCancelDirect(x);
        await h.sleep(outageMs);
        const during = await s.resources();
        const dlq = (() => { try { return rabbit.queues(); } catch { return []; } })().find((q) => q.name === 'billing.payment-events.dead');
        const deadBefore = Number(dlq?.messages_ready ?? 0);
        await s.dbProxy.billing.up();
        const t = h.now();
        const fin = await s.until(x, (st) => st.request === 'cancelled', 90_000);
        const [rc] = await s.bq(`SELECT array_agg(DISTINCT "causeType") AS causes, count(*)::int AS n FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [x.requestId]);
        rows.push({ queueDuringOutage: { ready: during.queueReady, unacked: during.queueUnacked }, deadLettered: deadBefore, convergedAfterDbBackMs: fin ? h.round(h.now() - t) : null, final: fin || (await s.state(x)), receipts: rc });
      } finally {
        await s.close();
      }
    }
    out[label] = { rows, converged: rows.filter((r) => r.final.request === 'cancelled').length, maxApplied: Math.max(...rows.map((r) => r.final.applied)), deadLettered: rows.map((r) => r.deadLettered) };
    log(`billingDbDownWhileEventArrives ${label}: ${JSON.stringify(rows.map((r) => [r.deadLettered, r.convergedAfterDbBackMs, r.final.request, r.final.applied]))}`);
  }
  return out;
};

C.dbAndRabbitDown = async () => {
  // Campaign I. A service's database AND RabbitMQ down together; restored in both orders.
  //   I1 Billing DB + RabbitMQ: Payment keeps working (cancel, pay: events wait in its outbox). I2 Payment DB + RabbitMQ: Billing keeps
  //   working (invoices; its cancel of a sent request answers 503). Orders: database then broker, broker then database.
  const out = {};
  for (const svc of ['billing', 'payment']) {
    for (const order of ['dbFirst', 'rabbitFirst']) {
      const s = await stack({ billingEnv: { BILLING_RECONCILE_INTERVAL_MS: '2000', BILLING_RECONCILE_STALE_REQUESTED_MS: '5000' } });
      try {
        const [a, b] = await s.seed(2);
        await s.dbProxy[svc].down();
        rabbit.appStop();
        const ops = svc === 'billing'
          ? { paymentCancel: (await s.paymentCancelDirect(a)).status, pay: await s.pay(b) }
          : { billingInvoice: Boolean((await s.invoice()).invoiceId), billingCancel: (await s.billingCancel(a)).status };
        await h.sleep(2000);
        const matrix = await s.readiness();
        const restoreDb = () => s.dbProxy[svc].up();
        const restoreRabbit = () => rabbit.appStart();
        const t = h.now();
        if (order === 'dbFirst') { await restoreDb(); await h.sleep(3000); await restoreRabbit(); } else { await restoreRabbit(); await h.sleep(3000); await restoreDb(); }
        if (svc === 'payment') await (async () => { for (let k = 0; k < 30; k++) { if ((await s.billingCancel(a)).status === 200) return; await h.sleep(500); } })();
        const fa = await s.until(a, (st) => st.request === 'cancelled', 120_000);
        const fb = svc === 'billing' ? await s.until(b, (st) => st.request === 'paid', 120_000) : true;
        out[`${svc}Db+rabbit.${order}`] = { ops, matrixWhileDown: matrix, convergedMs: fa && fb ? h.round(h.now() - t) : null, a: fa || (await s.state(a)), b: svc === 'billing' ? fb || (await s.state(b)) : null, account: await s.account([a, b]), resources: await s.resources() };
        log(`dbAndRabbitDown ${svc} ${order}: converged ${out[`${svc}Db+rabbit.${order}`].convergedMs} ms`);
      } finally {
        await s.close();
      }
    }
  }
  return out;
};

C.serviceAndDependencyDown = async () => {
  // Campaigns J and K. (J) Billing down AND RabbitMQ down; Payment settles a payment. Order 1: Billing started first (it exits: broker
  // unreachable at startup is fail-fast by design; a restart policy keeps starting it), then RabbitMQ. Order 2: RabbitMQ, then Billing.
  // (K) Billing SIGKILLed AND its database down; Payment emits the event. Order 1: Billing first (alive, unready), then its database.
  // Order 2: database, then Billing. Same logical end state in every order.
  const out = {};
  for (const order of ['billingFirst', 'rabbitFirst']) {
    const s = await stack();
    try {
      const [a] = await s.seed(1);
      await s.stop('billing');
      rabbit.appStop();
      await s.paymentCancelDirect(a);
      const t = h.now();
      let sup = null;
      if (order === 'billingFirst') {
        sup = supervise(s, 'billing');
        await h.sleep(5000);
        await rabbit.appStart();
      } else {
        await rabbit.appStart();
        await h.sleep(3000);
        sup = supervise(s, 'billing');
      }
      const fin = await s.until(a, (st) => st.request === 'cancelled', 120_000);
      await sup.stop();
      out[`J.billing+rabbit.${order}`] = { billingStarts: sup.starts.length, convergedMs: fin ? h.round(h.now() - t) : null, final: fin || (await s.state(a)), resources: await s.resources() };
      log(`serviceAndDependencyDown J ${order}: starts ${sup.starts.length}, converged ${out[`J.billing+rabbit.${order}`].convergedMs} ms`);
    } finally {
      await s.close();
    }
  }
  for (const order of ['billingFirst', 'dbFirst']) {
    const s = await stack({ billingEnv: { BILLING_RECONCILE_INTERVAL_MS: '2000', BILLING_RECONCILE_STALE_REQUESTED_MS: '5000' } });
    try {
      const [a] = await s.seed(1);
      await s.kill('billing');
      await s.dbProxy.billing.down();
      await s.paymentCancelDirect(a);
      const t = h.now();
      let readyWhileDbDown = null;
      if (order === 'billingFirst') {
        await s.start('billing', { waitReady: false });
        await h.sleep(3000);
        readyWhileDbDown = (await s.readiness()).billing;
        await s.dbProxy.billing.up();
      } else {
        await s.dbProxy.billing.up();
        await s.start('billing');
      }
      const fin = await s.until(a, (st) => st.request === 'cancelled', 120_000);
      out[`K.billing+billingDb.${order}`] = { readyWhileDbDown, convergedMs: fin ? h.round(h.now() - t) : null, final: fin || (await s.state(a)) };
      log(`serviceAndDependencyDown K ${order}: converged ${out[`K.billing+billingDb.${order}`].convergedMs} ms`);
    } finally {
      await s.close();
    }
  }
  return out;
};

C.multiServiceRestart = async () => {
  // Campaign L. Billing and Payment restarted together (alternately SIGKILL and SIGTERM) with durable work outstanding: Payment events
  // unpublished (its broker link frozen), Billing requests not yet sent (Payment unreachable from Billing), a payer's payment in progress,
  // stored webhooks due for retry. 5 repetitions: every item converges once; consumers, connections and sessions as before.
  const s = await stack({ billingEnv: { BILLING_DISPATCH_STALE_SENDING_MS: '3000' } });
  const reps = [];
  const all = [];
  try {
    const baseline = await s.resources();
    for (let i = 0; i < 5; i++) {
      const [a, b] = await s.seed(2);
      s.brokerProxy.payment.freeze();
      await s.paymentCancelDirect(a);
      await s.pay(b);
      s.payHttp.setMode('refuse');
      const fresh = await s.seed(2, { wait: false });
      for (let k = 0; k < 3; k++) {
        const body = Buffer.from(JSON.stringify({ eventId: `evt_${randomUUID()}`, type: 'payment.succeeded', reference: `ghost-${randomUUID()}`, amount: 1000, currency: 'TND' }));
        await s.pq(`INSERT INTO webhook_event(provider, "providerEventId", "eventType", "rawBody", "receivedAt", state, attempts) VALUES ('test', $1, 'payment.succeeded', $2, now() - interval '1 day', 'unmatched', 0)`, [`evt_${randomUUID()}`, body]);
      }
      await h.sleep(1000);
      const pending = await s.resources();
      const how = i % 2 === 0 ? 'SIGKILL' : 'SIGTERM';
      if (how === 'SIGKILL') { await s.kill('billing'); await s.kill('payment'); } else { await Promise.all([s.stop('billing'), s.stop('payment')]); }
      s.brokerProxy.payment.thaw();
      s.payHttp.setMode('pass');
      const t = h.now();
      await Promise.all([s.start('payment'), s.start('billing')]);
      const ok = await h.waitFor(async () => (await s.state(a)).request === 'cancelled' && (await s.state(b)).request === 'paid' && (await s.requested(fresh, 100)), 90_000, 250);
      await h.sleep(1500);
      all.push(a, b, ...fresh);
      reps.push({ rep: i, how, pendingBefore: { paymentOutbox: pending.outboxPending.payment }, convergedMs: ok ? h.round(h.now() - t) : null, resources: await s.resources() });
      log(`multiServiceRestart ${i} ${how}: converged ${reps.at(-1).convergedMs} ms`);
    }
    const [wh] = await s.pq(`SELECT min(attempts)::int AS min, max(attempts)::int AS max, count(*)::int AS n FROM webhook_event`);
    return { baseline, reps, account: await s.account(all), webhooks: wh };
  } finally {
    await s.close();
  }
};

C.recoveryOrders = async () => {
  // Campaign M. Billing down + RabbitMQ down + Payment has a durable terminal state (cancelled, event unpublished). Recovery orders:
  //   1 Billing → RabbitMQ (Billing keeps exiting until the broker is back: fail-fast startup + restart policy);
  //   2 RabbitMQ → Billing; 3 Payment restarted → Billing → RabbitMQ; 4 RabbitMQ → Payment restarted → Billing. 3 items each.
  const out = {};
  for (const order of ['billing>rabbit', 'rabbit>billing', 'payment>billing>rabbit', 'rabbit>payment>billing']) {
    const s = await stack();
    let sup = null;
    try {
      const items = await s.seed(3);
      await s.stop('billing');
      rabbit.appStop();
      for (const it of items) await s.paymentCancelDirect(it);
      const t = h.now();
      for (const step of order.split('>')) {
        if (step === 'billing') sup = supervise(s, 'billing');
        if (step === 'rabbit') await rabbit.appStart();
        if (step === 'payment') { await s.stop('payment'); await s.start('payment', { waitReady: false }); }
        await h.sleep(3000);
      }
      const ok = await h.waitFor(async () => { for (const it of items) if ((await s.state(it)).request !== 'cancelled') return false; return true; }, 120_000, 250);
      await sup?.stop();
      out[order] = { convergedMs: ok ? h.round(h.now() - t) : null, billingStarts: sup?.starts.length ?? 0, account: await s.account(items), resources: await s.resources() };
      log(`recoveryOrders ${order}: ${out[order].convergedMs} ms`);
    } finally {
      await sup?.stop();
      await s.close();
    }
  }
  return out;
};

C.eventOrdering = async () => {
  // Campaigns N, O, P.
  //   N delayed event: request 1's `payment.cancelled` is held (Payment's broker link frozen); meanwhile the reconciler settles request 1
  //     from Payment, a second request is created and paid (invoice paid). Then the old event arrives: nothing moves backwards. 5 runs.
  //   O duplicate after recovery: an already-applied event is published again, identical (same event id), 20 times: no second effect;
  //     and the same terminal fact under a NEW event id (a replayed fact): a recorded no-op, 20 times.
  //   P out of order: Payment's `payment.succeeded` reaches Billing BEFORE Billing learned the payment id (the create answer was lost, the
  //     request is still `sending`): the event is deferred, the dispatcher's resend (natural key) and the reconciler converge to paid once. 10 runs.
  const s = await stack({ billingEnv: { BILLING_RECONCILE_INTERVAL_MS: '2000', BILLING_RECONCILE_STALE_REQUESTED_MS: '5000', BILLING_DISPATCH_STALE_SENDING_MS: '3000' } });
  const pub = paymentEventPublisher(rabbit.url);
  const out = { N: [], O: {}, P: [] };
  try {
    for (let i = 0; i < 5; i++) {
      const inv = await s.invoice();
      const r1 = await s.request(inv);
      await s.requested([r1]);
      s.brokerProxy.payment.freeze();
      await s.billingCancel(r1); // Payment cancels; its event is held
      const settled = await s.until(r1, (st) => st.request === 'cancelled', 30_000); // the reconciler, from Payment's state
      const r2 = await s.request(inv);
      await s.requested([r2]);
      await s.pay(r2);
      const [inv1] = await s.bq('SELECT status FROM invoice WHERE id = $1', [inv.invoiceId]);
      s.brokerProxy.payment.thaw(); // the old event now arrives (and r2's payment.succeeded, if it was held too)
      await s.until(r2, (st) => st.request === 'paid', 60_000);
      await h.sleep(3000);
      const [rc] = await s.bq(`SELECT count(*)::int AS n, array_agg(outcome ORDER BY "receivedAt") AS outcomes, array_agg("causeType" ORDER BY "receivedAt") AS causes FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [r1.requestId]);
      const [inv2] = await s.bq('SELECT status FROM invoice WHERE id = $1', [inv.invoiceId]);
      out.N.push({ r1SettledByReconciler: Boolean(settled), invoiceBeforeOldEvent: inv1?.status, invoiceAfterOldEvent: inv2.status, r1: (await s.state(r1)).request, r2: (await s.state(r2)).request, r1Receipts: rc });
    }
    log('eventOrdering N done');
    const items = await s.seed(20);
    for (const it of items) await s.billingCancel(it);
    for (const it of items) await s.until(it, (st) => st.request === 'cancelled', 30_000);
    const replay = { identical: [], newEventId: [] };
    for (const it of items) {
      const [p] = await s.paymentOf(it);
      const [row] = await s.pq(`SELECT id::text, payload FROM outbox WHERE payload->>'paymentId' = $1 AND name = 'payment.cancelled'`, [p.id]);
      const before = await s.state(it);
      await pub.publish('payment.cancelled', { ...row.payload, id: row.payload.paymentId }, { eventId: row.id });
      await pub.publish('payment.cancelled', { ...row.payload, id: row.payload.paymentId }, { eventId: randomUUID() });
      await h.sleep(300);
      const after = await s.state(it);
      replay.identical.push(after.applied - before.applied);
      replay.newEventId.push(after.receipts - before.receipts);
    }
    await h.sleep(1500);
    const acct = await s.account(items);
    out.O = { iterations: items.length, extraEffectsFromIdenticalReplay: count(replay.identical), extraReceiptsFromNewEventId: count(replay.newEventId), account: acct, finalRequests: count(await Promise.all(items.map(async (it) => (await s.state(it)).request))) };
    log('eventOrdering O done');
    for (let i = 0; i < 10; i++) {
      s.payHttp.setOnRequest((req) => (req.method === 'POST' && req.url === '/payment/payments' ? 'drop' : null));
      const [x] = await s.seed(1, { wait: false });
      await h.waitFor(async () => (await s.paymentOf(x)).length === 1, 10_000, 20);
      s.payHttp.setOnRequest((req) => (req.method === 'POST' && req.url === '/payment/payments' ? 'refuse' : null)); // keep Billing unaware for a while
      const paid = await s.pay(x); // the payer pays: payment.succeeded arrives while Billing's request is still `sending`
      await h.sleep(1500);
      const [early] = await s.bq(`SELECT pr.status, (SELECT array_agg(outcome) FROM payment_event_receipt r WHERE r."paymentRequestId" = pr.id) AS outcomes FROM payment_request pr WHERE pr.id = $1`, [x.requestId]);
      s.payHttp.setOnRequest(null);
      const fin = await s.until(x, (st) => st.request === 'paid', 60_000);
      out.P.push({ paid, whileSending: early, final: fin || (await s.state(x)) });
    }
    log('eventOrdering P done');
  } finally {
    await pub.close().catch(() => undefined);
    await s.close();
  }
  return {
    N: { runs: out.N.length, invoiceAfterOldEvent: count(out.N.map((r) => r.invoiceAfterOldEvent)), r1: count(out.N.map((r) => r.r1)), r2: count(out.N.map((r) => r.r2)), r1ReceiptOutcomes: out.N.map((r) => r.r1Receipts), settledByReconciler: out.N.filter((r) => r.r1SettledByReconciler).length },
    O: out.O,
    P: { runs: out.P.length, stateWhileSending: count(out.P.map((r) => `${r.whileSending.status}:${(r.whileSending.outcomes ?? []).join('+') || 'no-receipt'}`)), final: count(out.P.map((r) => r.final.request)), maxPayments: Math.max(...out.P.map((r) => r.final.payments)), maxApplied: Math.max(...out.P.map((r) => r.final.applied)), idMismatch: out.P.filter((r) => !r.final.paymentIdMatches).length },
  };
};

C.serviceAuth = async () => {
  // Campaigns Q and R. (Q) Missing, invalid, malformed and user-shaped credentials on the service-token routes of Billing, Payment and
  // Organization: 401, nothing written. User-bearer routes with Auth unavailable: 503 (fail closed), never public. (R) Billing started
  // with a WRONG Payment token: it runs and is ready; its dispatch and cancel are refused by Payment (no payment created, cancel 503);
  // logs name the category, never the token; restarted with the right token, it recovers (configuration is read at startup).
  const s = await stack();
  const e = await edgeServices();
  const out = {};
  try {
    const [x] = await s.seed(1);
    const [bInv] = await s.bq('SELECT count(*)::int AS n FROM invoice');
    const [pPay] = await s.pq('SELECT count(*)::int AS n FROM payment');
    const bad = { missing: undefined, invalid: 'not-a-token', malformed: 'Bearer', userShaped: 'u-someone', otherServiceShaped: `nwsk_${'a'.repeat(40)}` };
    const results = {};
    for (const [k, tok] of Object.entries(bad)) {
      const hdr = tok === 'Bearer' ? { authorization: 'Bearer' } : {};
      results[k] = {
        billingCreateInvoice: (await s.call(s.base('billing'), 'POST', '/billing/invoices', { token: tok === 'Bearer' ? undefined : tok, headers: hdr, body: { invoiceRequestId: randomUUID() } })).status,
        paymentCreate: (await s.call(s.base('payment'), 'POST', '/payment/payments', { token: tok === 'Bearer' ? undefined : tok, headers: hdr, body: { paymentRequestId: randomUUID() } })).status,
        paymentCancel: (await s.call(s.base('payment'), 'POST', `/payment/payments/${(await s.paymentOf(x))[0].id}/cancel`, { token: tok === 'Bearer' ? undefined : tok, headers: { ...hdr, 'idempotency-key': 'k-12345678' } })).status,
        organizationServiceRoute: (await s.call(e.org.base, 'GET', '/organization/companies', { token: tok === 'Bearer' ? undefined : tok, headers: hdr })).status,
      };
    }
    const [bInv2] = await s.bq('SELECT count(*)::int AS n FROM invoice');
    const [pPay2] = await s.pq('SELECT count(*)::int AS n FROM payment');
    out.Q = { results, mutations: { billingInvoices: bInv2.n - bInv.n, paymentPayments: pPay2.n - pPay.n }, paymentStillPayable: (await s.paymentOf(x))[0].status };
    // Auth unavailable: a payer route must fail closed (503), never fall through to public or service access.
    s.auth.setDown(true);
    const [p] = await s.paymentOf(x);
    const payerWhileAuthDown = await s.call(s.base('payment'), 'POST', `/payment/payments/${p.id}/attempts`, { token: x.payer, body: { provider: 'test', providerOptions: { scenario: 'success' } }, headers: { 'idempotency-key': `a-${randomUUID()}` } });
    const billingPayerRead = await s.call(s.base('billing'), 'GET', `/billing/invoices/${x.invoiceId}`, { token: x.payer });
    const serviceRouteWhileAuthDown = (await s.billingApi('GET', `/billing/invoices/${x.invoiceId}`)).status;
    s.auth.setDown(false);
    out.authUnavailable = { paymentPayerRoute: [payerWhileAuthDown.status, payerWhileAuthDown.json?.code], billingPayerRoute: billingPayerRead.status, billingServiceRoute: serviceRouteWhileAuthDown, attemptsCreated: (await s.pq('SELECT count(*)::int AS n FROM payment_attempt WHERE "paymentId" = $1', [p.id]))[0].n };
    // R: Billing with a wrong Payment token.
    await s.stop('billing');
    const wrong = (await import('../../libs/service-kit/dist/index.js')).generateServiceToken();
    await s.start('billing', { extra: { PAYMENT_SERVICE_TOKEN: wrong.token } });
    const readyWrong = (await s.readiness()).billing;
    const fresh = await s.request(await s.invoice());
    await h.sleep(3000);
    const [fr] = await s.bq('SELECT status, "sendAttempts" FROM payment_request WHERE id = $1', [fresh.requestId]);
    const created = (await s.paymentOf(fresh)).length;
    const [y] = [x];
    const cancelWrong = await s.billingCancel(y);
    const lines = s.procs.billing.lines.map((l) => String(l.raw));
    const cats = [...new Set(s.procs.billing.lines.filter((l) => /payment_dispatch|payment_cancel/.test(String(l.msg))).map((l) => String(l.msg).split(' ')[0] + ' ' + (/reason=[a-z_]+|outcome=[a-z_]+/.exec(String(l.msg))?.[0] ?? '')))];
    const tokenLeaks = lines.filter((l) => l.includes(wrong.token) || l.includes(s.b2p.token) || l.includes(s.producer.token)).length;
    await s.stop('billing');
    await s.start('billing');
    const t = h.now();
    const ok = await s.requested([fresh], 90_000); // the auth-faulted send is retried after the 60 s stale window
    const sentAfterMs = ok ? h.round(h.now() - t) : null;
    const cancelRight = await s.billingCancel(y);
    out.R = { readyWithWrongToken: readyWrong, requestWhileWrong: fr, paymentsCreatedWhileWrong: created, cancelWhileWrong: [cancelWrong.status, cancelWrong.json?.code], logCategories: cats, tokenLeaksInLogs: tokenLeaks, afterFix: { requested: Boolean(ok), sentAfterMs, payments: (await s.paymentOf(fresh)).length, cancel: cancelRight.status } };
    const allLines = [...s.procs.payment.lines, ...e.auth.lines, ...e.org.lines].map((l) => String(l.raw));
    out.tokenLeaksAllServices = allLines.filter((l) => l.includes(s.b2p.token) || l.includes(s.producer.token) || l.includes(wrong.token) || /Bearer [A-Za-z0-9_-]{20,}/.test(l)).length;
  } finally {
    await e.close();
    await s.close();
  }
  return out;
};

C.tenantIsolation = async () => {
  // Campaign S. Organizations A and B, interleaved retries during a Payment outage, a RabbitMQ outage with events for both, replays of
  // A's events. Every request ends in ITS OWN intended state; Payment's payment carries its own invoice's organization; no receipt
  // points at another organization's request.
  const s = await stack();
  const pub = paymentEventPublisher(rabbit.url);
  try {
    const A = randomUUID();
    const B = randomUUID();
    const items = await s.seed(12, { orgs: [A, B] });
    const cancelSet = items.filter((_, i) => i % 3 !== 2);
    const paySet = items.filter((_, i) => i % 3 === 2);
    await s.stop('payment');
    const firstTry = await Promise.all(cancelSet.map((it) => s.billingCancel(it)));
    await s.start('payment');
    rabbit.appStop();
    await Promise.all(cancelSet.map((it) => s.billingCancel(it)));
    for (const it of paySet) await s.pay(it);
    await rabbit.appStart();
    for (const it of cancelSet) await s.until(it, (st) => st.request === 'cancelled', 60_000);
    for (const it of paySet) await s.until(it, (st) => st.request === 'paid', 60_000);
    for (const it of cancelSet.filter((i) => i.org === A)) {
      const [p] = await s.paymentOf(it);
      const [row] = await s.pq(`SELECT id::text, payload FROM outbox WHERE payload->>'paymentId' = $1 AND name = 'payment.cancelled'`, [p.id]);
      await pub.publish('payment.cancelled', { ...row.payload, id: row.payload.paymentId }, { eventId: row.id });
    }
    await h.sleep(2000);
    const mismatches = [];
    for (const it of items) {
      const [p] = await s.pq(`SELECT "organizationId"::text AS org, "sellerId" AS seller FROM payment WHERE "paymentRequestId"::text = $1`, [it.requestId]);
      const [inv] = await s.bq(`SELECT "organizationId"::text AS org FROM invoice WHERE id = $1`, [it.invoiceId]);
      if (p.org !== it.org || inv.org !== it.org || p.seller !== it.org) mismatches.push(it.requestId);
    }
    const [cross] = await s.bq(`SELECT count(*)::int AS n FROM payment_event_receipt r JOIN payment_request pr ON pr.id = r."paymentRequestId" WHERE r."paymentId" IS NOT NULL AND pr."paymentId" <> r."paymentId"`);
    const want = (it) => (paySet.includes(it) ? 'paid' : 'cancelled');
    const states = await Promise.all(items.map(async (it) => ({ org: it.org === A ? 'A' : 'B', want: want(it), got: (await s.state(it)).request })));
    return { firstTryDuringPaymentOutage: count(firstTry.map((r) => r.status)), states: count(states.map((x) => `${x.org}:${x.want}->${x.got}`)), wrongFinal: states.filter((x) => x.want !== x.got).length, organizationMismatches: mismatches.length, receiptsPointingElsewhere: cross.n, account: await s.account(items) };
  } finally {
    await pub.close().catch(() => undefined);
    await s.close();
  }
};

C.repeatedCycles = async () => {
  // Campaign T. 10 cycles of: traffic, Payment stopped → back, RabbitMQ stopped → back, Billing restarted. After each: broker connections,
  // channels, consumers, database sessions, pending outboxes, receipts, pending requests, process memory. No monotonic growth.
  const s = await stack();
  const items = [];
  const cycles = [];
  try {
    for (let i = 0; i < 10; i++) {
      const batch = await s.seed(3);
      items.push(...batch);
      await s.stop('payment');
      const cancels = await Promise.all(batch.slice(0, 2).map((it) => s.billingCancel(it)));
      await s.start('payment');
      for (const it of batch.slice(0, 2)) await (async () => { for (let k = 0; k < 20; k++) { if ((await s.billingCancel(it)).status === 200) return; await h.sleep(300); } })();
      rabbit.appStop();
      await s.pay(batch[2]);
      await h.sleep(1000);
      await rabbit.appStart();
      await s.stop('billing');
      await s.start('billing');
      await h.waitFor(async () => (await s.state(batch[2])).request === 'paid' && (await s.state(batch[0])).request === 'cancelled' && (await s.state(batch[1])).request === 'cancelled', 90_000, 250);
      await h.sleep(1500);
      const r = await s.resources();
      const [pend] = await s.bq(`SELECT count(*) FILTER (WHERE status IN ('created','sending','requested'))::int AS open, (SELECT count(*)::int FROM payment_event_receipt) AS receipts FROM payment_request`);
      const rss = [s.procs.billing, s.procs.payment].map((p) => h.round(h.processSample(p.child.pid).rssMb));
      cycles.push({ cycle: i, cancelsWhilePaymentDown: cancels.map((c) => c.status), ...r, openRequests: pend.open, receipts: pend.receipts, rssMb: rss });
      log(`repeatedCycles ${i}: ${JSON.stringify(cycles.at(-1))}`);
    }
    return { cycles, account: await s.account(items), brokerConnections: [...new Set(cycles.map((c) => c.brokerConnections))], queueConsumers: [...new Set(cycles.map((c) => c.queueConsumers))], dbSessions: [...new Set(cycles.map((c) => JSON.stringify(c.dbSessions)))] };
  } finally {
    await s.close();
  }
};

C.startupOrder = async () => {
  // Startup orders: Payment → Billing (normal); Billing → Payment (Billing starts with Payment down: ready, requests wait, then sent once);
  // RabbitMQ unavailable (Billing exits by design, Payment starts unready); PostgreSQL unavailable (both alive, unready, recover in place).
  const out = {};
  {
    const s = await stack({ startBilling: false, startPayment: false });
    try {
      const tb = h.now();
      await s.start('billing');
      const billingReadyMs = h.round(h.now() - tb);
      const x = await s.request(await s.invoice());
      await h.sleep(2000);
      const [st] = await s.bq('SELECT status FROM payment_request WHERE id = $1', [x.requestId]);
      await s.start('payment');
      const t = h.now();
      const ok = await s.requested([x], 90_000); // a send that failed leaves the request `sending` until BILLING_DISPATCH_STALE_SENDING_MS (60 s)
      out.billingBeforePayment = { sentAfterMs: ok ? h.round(h.now() - t) : null, billingReadyWithPaymentDownMs: billingReadyMs, requestWhilePaymentDown: st.status, sentOnceAfterPaymentStarted: Boolean(ok), payments: (await s.paymentOf(x)).length };
    } finally {
      await s.close();
    }
  }
  {
    const s = await stack({ startBilling: false, startPayment: false });
    try {
      await s.brokerProxy.billing.down();
      await s.brokerProxy.payment.down();
      const b = await s.start('billing', { waitReady: false });
      const p = await s.start('payment', { waitReady: false });
      await h.sleep(5000);
      out.rabbitUnavailableAtStartup = { billing: { alive: b.alive(), exit: b.child.exitCode }, payment: { alive: p.alive(), ...(await s.readiness()).payment } };
      await s.brokerProxy.billing.up();
      await s.brokerProxy.payment.up();
      const pr = await h.waitFor(async () => (await s.readiness()).payment.ready === 200, 30_000, 200);
      await s.start('billing');
      out.rabbitUnavailableAtStartup.recovered = { paymentSameProcess: Boolean(pr), billingStartedAfterBrokerBack: true };
    } finally {
      await s.close();
    }
  }
  {
    const s = await stack({ startBilling: false, startPayment: false });
    try {
      await s.dbProxy.billing.down();
      await s.dbProxy.payment.down();
      await s.start('billing', { waitReady: false });
      await s.start('payment', { waitReady: false });
      await h.sleep(4000);
      const r = await s.readiness();
      await s.dbProxy.billing.up();
      await s.dbProxy.payment.up();
      const ok = await h.waitFor(async () => { const x = await s.readiness(); return x.billing.ready === 200 && x.payment.ready === 200; }, 60_000, 200);
      out.databaseUnavailableAtStartup = { whileDown: r, recoveredInPlace: Boolean(ok) };
    } finally {
      await s.close();
    }
  }
  return out;
};

C.readinessMatrix = async () => {
  // Every service's process, /health, /ready and a relevant operation under each single failure, with all four services running.
  const s = await stack();
  const e = await edgeServices();
  const rows = {};
  const snap = async () => ({ ...(await e.snapshot()), ...(await s.readiness()) });
  try {
    await s.seed(1);
    rows.healthy = await snap();
    rabbit.appStop(); await h.sleep(3000); rows.rabbitDown = await snap(); await rabbit.appStart(); await h.waitFor(async () => (await s.readiness()).billing.ready === 200, 60_000, 200);
    await s.dbProxy.billing.down(); await h.sleep(2500); rows.billingDbDown = await snap(); await s.dbProxy.billing.up(); await h.waitFor(async () => (await s.readiness()).billing.ready === 200, 60_000, 200);
    await s.dbProxy.payment.down(); await h.sleep(2500); rows.paymentDbDown = await snap(); await s.dbProxy.payment.up(); await h.waitFor(async () => (await s.readiness()).payment.ready === 200, 60_000, 200);
    await s.stop('billing'); rows.billingDown = await snap(); await s.start('billing');
    await s.stop('payment'); rows.paymentDown = await snap(); await s.start('payment');
    e.auth.child.kill('SIGTERM'); await e.auth.exited; rows.authDown = await snap();
    return rows;
  } finally {
    await e.close();
    await s.close();
  }
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
  const env = await h.environment(ADMIN).catch(() => ({}));
  rabbit.stop();
  pgc.stop();
  const doc = JSON.stringify({ env: { ...env, rabbitmq: '3.13 (throwaway container)' }, started, results, uncaughtOrUnhandled: uncaught, finished: new Date().toISOString() }, null, 1);
  if (outFile) writeFileSync(outFile, doc);
  else process.stdout.write(doc + '\n');
}
