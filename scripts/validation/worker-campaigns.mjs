#!/usr/bin/env node
// Stage 15.4: worker and concurrency campaigns (test-only). Plan, invariants C1–C13 and criteria: docs/architecture/core-validation.md.
//
//   node scripts/validation/worker-campaigns.mjs [--out results.json] [campaign ...]      (default: all, in plan order)
//
// Starts its OWN throwaway RabbitMQ and PostgreSQL containers (`validation-*`, loopback) and removes them at the end. Needs built
// workspaces. Three layers: the kit (relay, bus, inbox, PollLoop), payment-service's workers built directly from `dist` (each simulated
// instance has its own database pool: locking is decided in PostgreSQL), and live billing-service / payment-service processes (a
// fake Payment HTTP service stands in for payment-service where Billing's dispatcher and reconciler must be controlled).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import {
  DbService, OutboxRelay, PollLoop, RabbitMqEventBus, describeFailure, generateServiceToken, kitMigrationsDir, runMigrations,
} from '../../libs/service-kit/dist/index.js';
import * as h from './lib/harness.mjs';
import { envelopeHeaders, kitWorlds, uniq } from './lib/kit-world.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('refusing to run with NODE_ENV=production');
const log = (...a) => process.stderr.write(`[15.4] ${a.join(' ')}\n`);
let uncaught = 0;
process.on('uncaughtException', (e) => {
  uncaught++;
  log('UNCAUGHT', describeFailure(e), String(e?.message).slice(0, 160));
});
process.on('unhandledRejection', (e) => {
  uncaught++;
  log('UNHANDLED', describeFailure(e), String(e?.message).slice(0, 160));
});
// In-process Nest classes log through Nest's Logger: collect those lines (for accounting and log checks) instead of printing them.
const nestLines = [];
Logger.overrideLogger({ log: (m) => nestLines.push(['info', String(m)]), warn: (m) => nestLines.push(['warn', String(m)]), error: (m) => nestLines.push(['error', String(m)]), debug: () => undefined, verbose: () => undefined });
const failureOf = async (p) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return describeFailure(e);
  }
};
/** A reusable N-party barrier keyed by name: every party waits until N have arrived (or the timeout passes). */
function barriers(n, timeoutMs = 5000) {
  const m = new Map();
  return async (key) => {
    let b = m.get(key);
    if (!b) {
      let open;
      b = { count: 0, opened: new Promise((r) => (open = r)) };
      b.open = open;
      m.set(key, b);
    }
    b.count++;
    if (b.count >= n) b.open(true);
    return Promise.race([b.opened, h.sleep(timeoutMs).then(() => false)]);
  };
}
const closers = [];
const later = (fn) => closers.push(fn);

const rabbit = await h.throwawayRabbit();
const pgc = await h.throwawayPostgres();
const ADMIN = pgc.adminUrl;
const kitWorld = kitWorlds({ rabbit, adminUrl: ADMIN });
log(`throwaway broker ${rabbit.name} :${rabbit.port}, postgres ${pgc.name} :${pgc.port}`);
const lockWaits = async (dbName) => (await h.adminQuery(ADMIN, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [dbName]))[0].n;
const deadlocks = async (dbName) => Number((await h.adminQuery(ADMIN, 'SELECT deadlocks FROM pg_stat_database WHERE datname = $1', [dbName]))[0]?.deadlocks ?? 0);

const C = {};

// ================================================================================================ kit layer
C.pollLoopOverlap = async () => {
  // A pass that takes 3x the interval: are passes ever concurrent, and does the next one wait for the previous to END?
  let active = 0, maxActive = 0;
  const spans = [];
  const loop = new PollLoop(async () => {
    const s = Date.now();
    active++;
    maxActive = Math.max(maxActive, active);
    await h.sleep(150);
    active--;
    spans.push([s, Date.now()]);
  });
  loop.start(50, 0);
  await h.waitFor(() => spans.length >= 10, 10_000, 10);
  await loop.stop();
  const gaps = spans.slice(1).map((sp, i) => sp[0] - spans[i][1]);
  return { passes: spans.length, intervalMs: 50, passMs: 150, maxConcurrentPasses: maxActive, gapBetweenPassesMs: h.stats(gaps), overlapping: gaps.some((g) => g < 0) };
};

C.multiRelay = async () => {
  // 1, 2 and 4 relays (separate pools, as separate instances) draining 1000 rows (20 batches of 50) of one outbox concurrently.
  const rows = [];
  for (const n of [1, 2, 4]) {
    const w = await kitWorld();
    try {
      await w.enqueue(1000);
      const relays = Array.from({ length: n }, (_, i) => ({ i, published: 0, passes: 0, relay: new OutboxRelay(new DbService({ url: w.db.url, applicationName: `validation-relay-${i}` }), w.pub, { source: 'validation' }) }));
      let maxLockWaits = 0;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          maxLockWaits = Math.max(maxLockWaits, await lockWaits(w.db.name));
          await h.sleep(20);
        }
      })();
      const t = Date.now();
      await Promise.all(relays.map(async (r) => {
        for (;;) {
          const res = await r.relay.drainOnce();
          r.passes++;
          r.published += res.published;
          if (res.published === 0) break;
        }
      }));
      const drainMs = Date.now() - t;
      sampling = false;
      await sampler;
      await h.waitFor(async () => (await w.account()).lost === 0, 60_000, 50);
      const acc = await w.account();
      const [att] = await h.adminQuery(w.db.url, `SELECT min(attempts)::int AS min, max(attempts)::int AS max, count(*) FILTER (WHERE "publishedAt" IS NULL)::int AS unpublished FROM outbox`);
      rows.push({ relays: n, perRelay: relays.map((r) => r.published), passes: relays.map((r) => r.passes), drainMs, maxLockWaitSessions: maxLockWaits, attempts: att, accounting: acc });
      log(`multiRelay ${n}: ${JSON.stringify(rows.at(-1).perRelay)} in ${drainMs} ms`);
    } finally {
      await w.close();
    }
  }
  return rows;
};

C.slowBrokerContention = async () => {
  // Relay A claims a batch and its broker confirms slowly (test-only 400 ms per publish): what does it hold, and who can still progress?
  const w = await kitWorld();
  try {
    await w.enqueue(200);
    const slowPub = { publish: async (e) => { await h.sleep(400); return w.pub.publish(e); }, subscribe: async () => ({ close: async () => undefined }), close: async () => undefined };
    const a = new OutboxRelay(new DbService({ url: w.db.url, applicationName: 'validation-relay-slow' }), slowPub, { source: 'validation' });
    const others = [1, 2].map((i) => new OutboxRelay(new DbService({ url: w.db.url, applicationName: `validation-relay-${i}` }), w.pub, { source: 'validation' }));
    const tA = Date.now();
    const aPass = a.drainOnce().then((r) => ({ r, ms: Date.now() - tA }));
    await h.sleep(300);
    const lockedByA = (await h.adminQuery(ADMIN, `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid WHERE s.application_name = 'validation-relay-slow' AND l.locktype = 'tuple' OR (s.application_name = 'validation-relay-slow' AND l.locktype = 'transactionid')`))[0].n;
    // Others drain everything they can while A holds its batch.
    const tB = Date.now();
    let byOthers = 0;
    for (;;) {
      const rs = await Promise.all(others.map((o) => o.drainOnce()));
      const p = rs.reduce((x, r) => x + r.published, 0);
      byOthers += p;
      if (p === 0) break;
    }
    const othersMs = Date.now() - tB;
    // Unrelated business transactions and outbox inserts while A still holds its rows.
    const txMs = [];
    for (let i = 0; i < 20; i++) {
      const t = Date.now();
      await w.enqueue(1);
      txMs.push(Date.now() - t);
    }
    const idleInTx = (await h.sessions(ADMIN, w.db.name)).byState['idle in transaction'] ?? 0;
    const aStillRunning = !(await Promise.race([aPass.then(() => true), h.sleep(1).then(() => false)]));
    const aRes = await aPass;
    for (let i = 0; i < 5; i++) await Promise.all(others.map((o) => o.drainOnce()));
    await h.waitFor(async () => (await w.account()).lost === 0, 30_000, 50);
    return {
      rows: 220, relayA: { published: aRes.r.published, transactionMs: aRes.ms, batch: 50 }, relayAStillHoldingWhileOthersFinished: aStillRunning,
      othersPublishedWhileAHeld: byOthers, othersMs, rowLockInfoForA: lockedByA, unrelatedBusinessTxMs: h.stats(txMs), idleInTransactionDuringHold: idleInTx,
      maxLockWaitSessions: await lockWaits(w.db.name), accounting: await w.account(),
    };
  } finally {
    await w.close();
  }
};

C.kitDuplicateRace = async () => {
  // The same event id delivered to 3 competing consumers, their handlers released together by a barrier: 20 iterations x 5 events.
  const w = await kitWorld({ consumers: 3 });
  const gate = barriers(3, 5000);
  const released = [];
  w.handlerHooks.before = async (e) => released.push(await gate(e.id));
  const direct = await (await (await import('amqplib')).default.connect(rabbit.url)).createConfirmChannel();
  try {
    for (let i = 0; i < 20; i++) {
      const ids = Array.from({ length: 5 }, () => randomUUID());
      w.ids.push(...ids);
      for (const id of ids) for (let k = 0; k < 3; k++) direct.publish(w.exchange, 'validation.dup', Buffer.from(JSON.stringify({ id })), { persistent: true, messageId: id, type: 'validation.dup', headers: envelopeHeaders(id, 'validation.dup') });
      await direct.waitForConfirms();
      await h.waitFor(() => ids.every((id) => (w.deliveries.get(id) ?? 0) >= 3), 20_000, 10);
    }
    await h.sleep(500);
    const acc = await w.account();
    const eff = await h.adminQuery(w.db.url, 'SELECT count(DISTINCT event_id)::int AS events, max(c)::int AS maxPerEvent FROM (SELECT event_id, count(*) AS c FROM effect GROUP BY 1) x');
    return { iterations: 20, events: 100, copiesEach: 3, barrierReleasedTogether: released.filter(Boolean).length, barrierTimedOut: released.filter((x) => !x).length, effects: eff[0], accounting: acc };
  } finally {
    await direct.close().catch(() => undefined);
    await w.close();
  }
};

C.relaysConsumersBrokerInterruption = async () => {
  // 2 relays + 2 consumers + continuous traffic through 3 broker outages: counts converge, nothing lost or doubled.
  const w = await kitWorld({ consumers: 2 });
  const relays = [0, 1].map((i) => new OutboxRelay(new DbService({ url: w.db.url, applicationName: `validation-relay-${i}` }), w.pub, { source: 'validation' }));
  let generating = true;
  const gen = (async () => {
    while (generating) {
      await w.enqueue(1).catch(() => undefined);
      await h.sleep(50);
    }
  })();
  const cycles = [];
  try {
    for (const r of relays) r.start(500);
    await h.sleep(2000);
    for (let c = 0; c < 3; c++) {
      rabbit.appStop();
      await h.sleep(5000);
      await rabbit.appStart();
      await h.waitFor(() => w.buses.every((b) => b.consumerStatus().every((s) => s.state === 'consuming')), 60_000, 50);
      await h.sleep(3000);
      const q = rabbit.queues().find((x) => x.name === w.queue);
      cycles.push({ cycle: c, queueConsumers: Number(q?.consumers), brokerConnections: rabbit.connections().length, brokerChannels: rabbit.channels().length });
    }
    generating = false;
    await gen;
    const fin = await h.waitFor(async () => { const a = await w.account(); return a.pending === 0 && a.lost === 0 && a; }, 120_000, 200);
    return { cycles, accounting: fin ?? (await w.account()) };
  } finally {
    generating = false;
    for (const r of relays) await r.stop();
    await w.close();
  }
};

C.relayCrashHoldingLocks = async () => {
  // A relay process claims 50 rows (row locks held in its transaction) and is SIGKILLed: PostgreSQL must release the locks and another
  // relay must publish the rows, with no manual repair.
  const w = await kitWorld();
  const runs = [];
  try {
    for (let i = 0; i < 5; i++) {
      await w.enqueue(60);
      const child = spawn(process.execPath, [`${h.root}scripts/validation/lib/crash-relay.mjs`], { env: { PATH: process.env.PATH, DATABASE_URL: w.db.url } });
      const out = [];
      child.stdout.on('data', (d) => out.push(String(d)));
      const exited = new Promise((r) => child.on('exit', r));
      await h.waitFor(() => out.join('').includes('claimed'), 15_000, 10);
      await h.sleep(200);
      const heldBefore = (await h.adminQuery(ADMIN, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'validation-crash-relay' AND state = 'idle in transaction'`))[0].n;
      const t = Date.now();
      child.kill('SIGKILL');
      await exited;
      const released = await h.waitFor(async () => (await h.adminQuery(ADMIN, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'validation-crash-relay'`))[0].n === 0 && Date.now(), 30_000, 20);
      const done = await h.waitFor(async () => {
        await w.relay.drainOnce();
        const a = await w.account();
        return a.pending === 0 && a.lost === 0 && Date.now();
      }, 60_000, 50);
      runs.push({ sessionHeldBeforeKill: heldBefore, lockReleasedAfterMs: released ? released - t : null, allRowsPublishedAfterMs: done ? done - t : null });
    }
    return { runs, accounting: await w.account() };
  } finally {
    await w.close();
  }
};

C.outboxRetryRace = async () => {
  // A row whose publish is failing slowly on relay A while relay B polls: B must skip it (locked), attempts must count each failure once,
  // and `availableAt` must only move forward. 20 iterations.
  const db = await h.throwawayDatabase(ADMIN, null);
  await runMigrations(db.url, [kitMigrationsDir]);
  const d = new DbService({ url: db.url });
  const { OutboxService } = await import('../../libs/service-kit/dist/index.js');
  const outbox = new OutboxService();
  const slowFail = { publish: async () => { await h.sleep(300); throw new Error('broker refused'); }, subscribe: async () => ({ close: async () => undefined }), close: async () => undefined };
  const exchange = `validation.x.${uniq()}`;
  const ok = new RabbitMqEventBus({ url: rabbit.url, exchange });
  const a = new OutboxRelay(new DbService({ url: db.url }), slowFail, { source: 'validation' });
  const b = new OutboxRelay(new DbService({ url: db.url }), ok, { source: 'validation' });
  const iters = [];
  try {
    for (let i = 0; i < 20; i++) {
      const id = randomUUID();
      await d.tx((q) => outbox.enqueue(q, { id, name: 'validation.retry', payload: {} }));
      const pa = a.drainOnce();
      await h.sleep(100);
      const rb = await b.drainOnce(); // A holds the row: B must not publish it
      await pa;
      const [after1] = await h.adminQuery(db.url, 'SELECT attempts, "availableAt", "publishedAt" FROM outbox WHERE id = $1', [id]);
      await h.adminQuery(db.url, `UPDATE outbox SET "availableAt" = now() WHERE id = $1`, [id]);
      const rb2 = await b.drainOnce();
      const [after2] = await h.adminQuery(db.url, 'SELECT attempts, "availableAt", "publishedAt" FROM outbox WHERE id = $1', [id]);
      iters.push({ bPublishedWhileAHeld: rb.published, attemptsAfterAFailure: after1.attempts, publishedAfterA: after1.publishedAt !== null, bPublishedWhenDue: rb2.published, attemptsFinal: after2.attempts, published: after2.publishedAt !== null });
    }
    return {
      iterations: 20, bNeverTookARowAHeld: iters.every((x) => x.bPublishedWhileAHeld === 0), attemptsAfterAFailure: [...new Set(iters.map((x) => x.attemptsAfterAFailure))],
      attemptsFinal: [...new Set(iters.map((x) => x.attemptsFinal))], allPublished: iters.every((x) => x.published),
    };
  } finally {
    await ok.close();
    await d.onApplicationShutdown();
    await db.drop();
  }
};

// ================================================================================================ payment layer (in-process, from dist)
const P = `${h.root}apps/payment-service/dist`;
const [{ loadPaymentConfig }, { ProviderRegistry }, { TestPaymentProvider }, { PaymentService }, { AttemptService }, { AttemptResolver }, { WebhookService }, { WebhookRetriever, WEBHOOK_RETRY_MAX_ATTEMPTS }, { ExpirySweeper }, { IdempotencyService }, kit] =
  await Promise.all(['config/payment-config.js', 'providers/provider-registry.js', 'providers/test-provider.js', 'payments/payment.service.js', 'attempts/attempt.service.js', 'attempts/attempt-resolver.js', 'webhooks/webhook.service.js', 'webhooks/webhook-retrier.js', 'payments/expiry-sweeper.js', 'idempotency/idempotency.service.js', '../../../libs/service-kit/dist/index.js'].map((m) => import(`${P}/${m}`)));
let paymentWorldCache;
/** One Payment database; `instance(i)` builds the services a separate payment-service process would have (own pool). */
async function paymentWorld() {
  if (paymentWorldCache) return paymentWorldCache;
  const db = await h.throwawayDatabase(ADMIN, 'payment-service');
  const config = loadPaymentConfig({ NODE_ENV: 'test', DATABASE_URL: db.url, PAYMENT_SUPPORTED_CURRENCIES: 'TND', AUTH_SERVICE_URL: 'http://127.0.0.1:9', PAYMENT_TEST_PROVIDER: 'true' });
  const testProvider = new TestPaymentProvider();
  const registry = new ProviderRegistry(config, testProvider);
  const instance = (i, providers = registry) => {
    const pool = new DbService({ url: db.url, applicationName: `validation-payment-${i}` });
    later(() => pool.onApplicationShutdown());
    const outbox = new kit.OutboxService();
    const idem = new IdempotencyService(pool);
    const attempts = new AttemptService(pool, outbox, config, providers, idem);
    const webhooks = new WebhookService(pool, attempts);
    return { pool, payments: new PaymentService(pool, outbox, config, idem), attempts, webhooks, resolver: new AttemptResolver(pool, providers, attempts), retrier: new WebhookRetriever(pool, providers, webhooks), sweeper: new ExpirySweeper(pool, outbox) };
  };
  const seedInstance = instance('seed');
  const createPayment = async (o = {}) => {
    const org = o.org ?? randomUUID();
    return seedInstance.payments.create('billing-service', {
      paymentRequestId: o.paymentRequestId ?? randomUUID(), sourceType: 'invoice', sourceId: randomUUID(), payer: { type: 'user', id: `payer-${uniq()}` },
      seller: { type: 'organization', id: org }, organizationId: org, amount: 1000, currency: 'TND', reference: `INV-${uniq()}`, ...(o.expiresAt ? { expiresAt: o.expiresAt } : {}),
    });
  };
  const startAttempt = (paymentId, scenario, key = randomUUID(), svc = seedInstance.attempts) => svc.start(paymentId, 'payer-validation', key, { provider: 'test', providerOptions: { scenario } });
  const q = (sql, params) => h.adminQuery(db.url, sql, params);
  paymentWorldCache = { db, config, testProvider, registry, instance, createPayment, startAttempt, q };
  return paymentWorldCache;
}
/** A fake provider for the resolver: capabilities of the test provider, `fetchStatus` scripted per reference and synchronised by a barrier. */
function scriptedProvider(caps, script, gate, calls) {
  return {
    id: 'test', capabilities: caps,
    async fetchStatus(ref) {
      calls.push(ref);
      if (gate) await gate(ref);
      return script(ref);
    },
  };
}

C.attemptResolverRaces = async () => {
  // Two resolvers see the same `unknown` attempt, call the provider, and are released together (barrier) before either applies.
  // Scripts per pair (resolver A, resolver B): both succeeded; succeeded vs failed; failed vs succeeded; pending vs succeeded; notFound vs succeeded.
  const w = await paymentWorld();
  const caps = w.testProvider.capabilities;
  const pairs = [['succeeded', 'succeeded'], ['succeeded', 'failed'], ['failed', 'succeeded'], ['pending', 'succeeded'], ['notFound', 'succeeded']];
  const result = (k) => (k === 'succeeded' ? { kind: 'succeeded', amount: 1000, currency: 'TND' } : k === 'failed' ? { kind: 'failed', failureClass: 'terminal', failureCode: 'card_declined' } : { kind: k });
  const rows = [];
  for (let it = 0; it < 20; it++) {
    const items = [];
    for (const pair of pairs) {
      const { payment } = await w.createPayment();
      const { attempt } = await w.startAttempt(payment.id, 'timeout_after_accept');
      items.push({ pair, paymentId: payment.id, attemptId: attempt.id, ref: attempt.providerTransactionId ?? attempt.merchantReference, startStatus: attempt.status });
    }
    const byRef = new Map(items.map((x) => [x.ref, x]));
    const gate = barriers(2, 5000);
    const calls = [];
    const mk = (side) => {
      const reg = { tryGet: () => scriptedProvider(caps, (ref) => result(byRef.get(ref)?.pair[side] ?? 'pending'), gate, calls), get: () => undefined };
      return w.instance(`resolver-${side}`, reg).resolver;
    };
    const [a, b] = [mk(0), mk(1)];
    await Promise.all([a.drainOnce(), b.drainOnce()]);
    for (const x of items) {
      const [att] = await w.q('SELECT status FROM payment_attempt WHERE id = $1', [x.attemptId]);
      const [pay] = await w.q('SELECT status FROM payment WHERE id = $1', [x.paymentId]);
      const ev = await w.q(`SELECT name, count(*)::int AS n FROM outbox WHERE payload->>'paymentId' = $1 GROUP BY 1`, [x.paymentId]);
      const events = Object.fromEntries(ev.map((r) => [r.name, r.n]));
      rows.push({ pair: x.pair.join('/'), startStatus: x.startStatus, attempt: att.status, payment: pay.status, events });
    }
    await w.q(`UPDATE payment_attempt SET status = 'failed', "failureCode" = 'validation_cleanup', "completedAt" = now() WHERE status IN ('unknown', 'initiated')`).catch(() => undefined);
  }
  const byPair = {};
  for (const r of rows) {
    const k = r.pair;
    byPair[k] ??= { races: 0, outcomes: {}, maxSucceededEvents: 0, bothTerminalEvents: 0 };
    byPair[k].races++;
    const o = `attempt=${r.attempt} payment=${r.payment}`;
    byPair[k].outcomes[o] = (byPair[k].outcomes[o] ?? 0) + 1;
    byPair[k].maxSucceededEvents = Math.max(byPair[k].maxSucceededEvents, r.events['payment.succeeded'] ?? 0);
    if ((r.events['payment.succeeded'] ?? 0) > 0 && (r.events['payment.failed'] ?? 0) > 0) byPair[k].bothTerminalEvents++;
  }
  return { iterations: 20, racesPerPair: 20, startStatuses: [...new Set(rows.map((r) => r.startStatus))], byPair, resolverFailureLines: nestLines.filter(([, m]) => m.startsWith('attempt_resolver_failure')).length };
};

C.attemptResolverAmplification = async () => {
  // N resolvers (N instances) over the same 10 unresolved attempts, one pass each: how many provider calls?
  const w = await paymentWorld();
  const caps = w.testProvider.capabilities;
  const rows = [];
  for (const n of [1, 2, 4]) {
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const { payment } = await w.createPayment();
      ids.push((await w.startAttempt(payment.id, 'timeout_after_accept')).attempt.id);
    }
    const calls = [];
    const resolvers = Array.from({ length: n }, (_, i) => w.instance(`amp-${n}-${i}`, { tryGet: () => scriptedProvider(caps, () => ({ kind: 'pending' }), null, calls), get: () => undefined }).resolver);
    await Promise.all(resolvers.map((r) => r.drainOnce()));
    const [still] = await w.q(`SELECT count(*)::int AS n FROM payment_attempt WHERE id = ANY($1) AND status = 'unknown'`, [ids]);
    rows.push({ resolvers: n, unresolvedAttempts: 10, providerCallsInOnePass: calls.length, callsPerAttempt: calls.length / 10, stillUnknown: still.n });
    await w.q(`UPDATE payment_attempt SET status = 'failed', "failureCode" = 'validation_cleanup', "completedAt" = now() WHERE id = ANY($1)`, [ids]);
  }
  return rows;
};

C.webhookRetrierRaces = async () => {
  // Three retrier instances over a mixed set, 20 rounds: a matching success, a slow success, a transient failure (twice), an unmatched
  // event on its last attempt (must end retries_exhausted exactly once), and a fresh unmatched one. Reprocessing of one row by two
  // instances at once is detected by wrapping each instance's WebhookService.
  const w = await paymentWorld();
  const inFlight = new Map();
  let maxConcurrentPerRow = 0;
  const slow = new Set(), transient = new Map();
  const wrap = (svc) => {
    const real = svc.reprocess.bind(svc);
    svc.reprocess = async (ev, provider, q) => {
      const n = (inFlight.get(ev.id) ?? 0) + 1;
      inFlight.set(ev.id, n);
      maxConcurrentPerRow = Math.max(maxConcurrentPerRow, n);
      try {
        if (slow.has(ev.id)) await h.sleep(800);
        if ((transient.get(ev.id) ?? 0) > 0) {
          transient.set(ev.id, transient.get(ev.id) - 1);
          throw new Error('simulated transient reprocessing failure');
        }
        return await real(ev, provider, q);
      } finally {
        inFlight.set(ev.id, inFlight.get(ev.id) - 1);
      }
    };
  };
  const retriers = [0, 1, 2].map((i) => {
    const inst = w.instance(`retrier-${i}`);
    wrap(inst.webhooks);
    return inst.retrier;
  });
  const stored = async ({ reference, attempts = 0, secondsAgo = 86_400 }) => {
    const body = Buffer.from(JSON.stringify({ eventId: `evt_${randomUUID()}`, type: 'payment.succeeded', reference, amount: 1000, currency: 'TND' }));
    const [r] = await w.q(`INSERT INTO webhook_event(provider, "providerEventId", "eventType", "rawBody", "receivedAt", state, attempts)
      VALUES ('test', $1, 'payment.succeeded', $2, now() - make_interval(secs => $3), 'unmatched', $4) RETURNING id`, [`evt_${randomUUID()}`, body, secondsAgo, attempts]);
    return r.id;
  };
  const rounds = [];
  let exhaustedReported = 0;
  for (let it = 0; it < 20; it++) {
    const mk = async () => {
      const { payment } = await w.createPayment();
      const { attempt } = await w.startAttempt(payment.id, 'success');
      return { paymentId: payment.id, ref: attempt.merchantReference };
    };
    const ok = await mk(), slowOne = await mk(), trans = await mk();
    const ids = {
      success: await stored({ reference: ok.ref }), slow: await stored({ reference: slowOne.ref }), transient: await stored({ reference: trans.ref }),
      exhausting: await stored({ reference: `ghost-${randomUUID()}`, attempts: WEBHOOK_RETRY_MAX_ATTEMPTS - 1 }), fresh: await stored({ reference: `ghost-${randomUUID()}`, attempts: 0 }),
    };
    slow.add(ids.slow);
    transient.set(ids.transient, 2);
    for (let pass = 0; pass < 6; pass++) {
      const res = await Promise.all(retriers.map((r) => r.drainOnce()));
      exhaustedReported += res.reduce((a, r) => a + r.exhausted, 0);
      // rows were stored received a day ago: every attempt up to the 10th (due 10 s x 2^n after receipt) is already due (backoff: 15.3)
    }
    const st = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, (await w.q('SELECT state, outcome, attempts FROM webhook_event WHERE id = $1', [id]))[0]])));
    const succeededEvents = (await w.q(`SELECT count(*)::int AS n FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = ANY($1)`, [[ok.paymentId, slowOne.paymentId, trans.paymentId]]))[0].n;
    rounds.push({ st, succeededEvents });
  }
  const states = (k) => [...new Set(rounds.map((r) => `${r.st[k].state}/${r.st[k].outcome ?? '-'}`))];
  // Rows left unmatched in earlier rounds keep being retried in later ones and exhaust there too: reconcile the reported transitions
  // with the rows actually in the terminal state (a double transition would make the reported count exceed the rows).
  const [exhaustedRows] = await w.q(`SELECT count(*)::int AS n FROM webhook_event WHERE outcome = 'retries_exhausted'`);
  return {
    rounds: 20, retrierInstances: 3, maxConcurrentReprocessOfOneRow: maxConcurrentPerRow,
    success: states('success'), slow: states('slow'), transient: states('transient'), exhausting: states('exhausting'), fresh: states('fresh'),
    maxAttempts: Math.max(...rounds.flatMap((r) => Object.values(r.st).map((x) => x.attempts))), exhaustedTransitionsReported: exhaustedReported, rowsInRetriesExhausted: exhaustedRows.n,
    maxAttemptsInTable: (await w.q('SELECT max(attempts)::int AS n FROM webhook_event'))[0].n,
    paymentSucceededEventsPerRound: [...new Set(rounds.map((r) => r.succeededEvents))],
  };
};

C.expirySweeperRaces = async () => {
  // (1) three sweepers over 200 expired payments of 20 organizations; (2) one payment's row locked by another transaction; (3) the
  // expiry boundary: a sweep racing an attempt start on the same payment (both lock the payment row), 20 iterations.
  const w = await paymentWorld();
  const sweepers = [0, 1, 2].map((i) => w.instance(`sweeper-${i}`).sweeper);
  const orgs = Array.from({ length: 20 }, () => randomUUID());
  const ids = [];
  const soon = () => new Date(Date.now() + 1500).toISOString();
  for (let i = 0; i < 200; i++) ids.push((await w.createPayment({ org: orgs[i % 20], expiresAt: soon() })).payment.id);
  await h.sleep(2500);
  const t = Date.now();
  const res = await Promise.all(sweepers.map((s) => s.sweepOnce()));
  const sweepMs = Date.now() - t;
  const [expired] = await w.q(`SELECT count(*)::int AS n FROM payment WHERE id = ANY($1) AND status = 'expired'`, [ids]);
  const ev = await w.q(`SELECT count(*)::int AS rows, count(DISTINCT payload->>'paymentId')::int AS payments FROM outbox WHERE name = 'payment.expired' AND payload->>'paymentId' = ANY($1)`, [ids]);
  const perOrg = await w.q(`SELECT "organizationId", count(*)::int AS n FROM payment WHERE id = ANY($1) AND status = 'expired' GROUP BY 1`, [ids]);
  // (2) head-of-line: one expired payment locked by a long transaction while three sweepers run
  const ids2 = [];
  for (let i = 0; i < 30; i++) ids2.push((await w.createPayment({ expiresAt: soon() })).payment.id);
  await h.sleep(2500);
  const holder = new DbService({ url: w.db.url, applicationName: 'validation-lock-holder' });
  let release;
  const held = holder.tx(async (q) => {
    await q.query('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [ids2[0]]);
    await new Promise((r) => (release = r));
  });
  await h.sleep(200);
  const tH = Date.now();
  const passes = sweepers.map((s) => s.sweepOnce().then((r) => ({ r, ms: Date.now() - tH }), (e) => ({ error: describeFailure(e), ms: Date.now() - tH })));
  await h.sleep(3000);
  const [whileHeld] = await w.q(`SELECT count(*)::int AS n FROM payment WHERE id = ANY($1) AND status = 'expired'`, [ids2]);
  const waiting = await lockWaits(w.db.name);
  release();
  await held;
  const passRes = await Promise.all(passes);
  const [afterRelease] = await w.q(`SELECT count(*)::int AS n FROM payment WHERE id = ANY($1) AND status = 'expired'`, [ids2]);
  await holder.onApplicationShutdown();
  // (3) boundary race: payment expires now; one instance sweeps while another starts an attempt on it
  const boundary = [];
  const starter = w.instance('starter');
  for (let i = 0; i < 20; i++) {
    // Fire both within a few ms of `expiresAt` (database time decides "due" for both paths), alternating slightly before and after it.
    const expiresAt = Date.now() + 1000;
    const { payment } = await w.createPayment({ expiresAt: new Date(expiresAt).toISOString() });
    await h.sleep(Math.max(0, expiresAt - Date.now() + (i % 2 === 0 ? -15 : 15)));
    const [sweep, start] = await Promise.all([sweepers[i % 3].sweepOnce().then(() => 'ok', (e) => describeFailure(e)), failureOf(w.startAttempt(payment.id, 'success', randomUUID(), starter.attempts))]);
    const [p] = await w.q('SELECT status FROM payment WHERE id = $1', [payment.id]);
    const [open] = await w.q(`SELECT count(*)::int AS n FROM payment_attempt WHERE "paymentId" = $1 AND status IN ('initiated', 'submitted', 'unknown')`, [payment.id]);
    boundary.push({ payment: p.status, openAttempts: open.n, start, sweep });
  }
  return {
    concurrentSweep: { sweepers: 3, payments: 200, organizations: 20, expired: expired.n, expiredEventRows: ev[0].rows, expiredEventPayments: ev[0].payments, perSweeper: res.map((r) => r.expired), sweepMs, organizationsFullyExpired: perOrg.filter((r) => r.n === 10).length },
    lockedRow: { payments: 30, expiredWhileOneRowLocked3s: whileHeld.n, sessionsWaitingOnTheLock: waiting, passes: passRes.map((p) => ({ ms: p.ms, expired: p.r?.expired, error: p.error })), expiredAfterRelease: afterRelease.n },
    boundaryRace: { iterations: 20, outcomes: boundary.reduce((m, b) => { const k = `payment=${b.payment} openAttempts=${b.openAttempts} start=${b.start}`; m[k] = (m[k] ?? 0) + 1; return m; }, {}), expiredWithOpenAttempt: boundary.filter((b) => b.payment === 'expired' && b.openAttempts > 0).length },
    deadlocks: await deadlocks(w.db.name),
  };
};

C.paymentIdempotencyRaces = async () => {
  // Same key, 5 concurrent callers, 20 iterations: payment creation (natural key) and attempt start (Idempotency-Key). Distinct keys as
  // the negative control (nothing collapsed or serialised away).
  const w = await paymentWorld();
  const insts = [0, 1, 2, 3, 4].map((i) => w.instance(`idem-${i}`));
  const create = [];
  for (let it = 0; it < 20; it++) {
    const pr = randomUUID(), org = randomUUID(), src = randomUUID(), payer = `payer-${uniq()}`;
    const dto = { paymentRequestId: pr, sourceType: 'invoice', sourceId: src, payer: { type: 'user', id: payer }, seller: { type: 'organization', id: org }, organizationId: org, amount: 1000, currency: 'TND', reference: 'INV-RACE' };
    const out = await Promise.all(insts.map((x) => x.payments.create('billing-service', { ...dto }).then((r) => ({ id: r.payment.id, replayed: r.replayed }), (e) => ({ error: describeFailure(e) }))));
    const [n] = await w.q(`SELECT count(*)::int AS n FROM payment WHERE "paymentRequestId" = $1`, [pr]);
    create.push({ rows: n.n, ids: new Set(out.map((o) => o.id)).size, created: out.filter((o) => o.replayed === false).length, errors: out.filter((o) => o.error).map((o) => o.error) });
  }
  const start = [];
  for (let it = 0; it < 20; it++) {
    const { payment } = await w.createPayment();
    const key = randomUUID();
    const out = await Promise.all(insts.map((x) => w.startAttempt(payment.id, 'success', key, x.attempts).then((r) => ({ id: r.attempt.id, replayed: r.replayed }), (e) => ({ error: describeFailure(e) }))));
    const [n] = await w.q(`SELECT count(*)::int AS n FROM payment_attempt WHERE "paymentId" = $1`, [payment.id]);
    start.push({ rows: n.n, ids: new Set(out.filter((o) => o.id).map((o) => o.id)).size, fresh: out.filter((o) => o.replayed === false).length, errors: out.filter((o) => o.error).map((o) => o.error) });
  }
  // Negative control: 20 different payments, 20 different keys, all at once.
  const pays = [];
  for (let i = 0; i < 20; i++) pays.push((await w.createPayment()).payment.id);
  const distinct = await Promise.all(pays.map((id, i) => w.startAttempt(id, 'success', randomUUID(), insts[i % 5].attempts).then(() => 'ok', (e) => describeFailure(e))));
  const summarise = (xs) => ({ iterations: xs.length, rowsPerKey: [...new Set(xs.map((x) => x.rows))], idsReturnedPerKey: [...new Set(xs.map((x) => x.ids))], freshPerKey: [...new Set(xs.map((x) => x.created ?? x.fresh))], errors: [...new Set(xs.flatMap((x) => x.errors))] });
  return { createSameRequest5x: summarise(create), startSameKey5x: summarise(start), distinctKeys: { requests: 20, ok: distinct.filter((x) => x === 'ok').length, errors: [...new Set(distinct.filter((x) => x !== 'ok'))] } };
};

C.dbTimeoutUnderContention = async () => {
  // Sweeper B (test bounds: statement 1 s, query deadline 2 s) blocks on a payment row that transaction A holds: B must fail within the
  // bound, leave no transaction behind, and a later pass must expire the payment once A commits. 20 iterations.
  const w = await paymentWorld();
  const b = new ExpirySweeper(new DbService({ url: w.db.url, applicationName: 'validation-sweeper-b', statementTimeoutMs: 1000, queryTimeoutMs: 2000 }), new kit.OutboxService());
  const holder = new DbService({ url: w.db.url, applicationName: 'validation-holder-a' });
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const { payment } = await w.createPayment({ expiresAt: new Date(Date.now() + 500).toISOString() });
    await h.sleep(600);
    let release;
    const held = holder.tx(async (q) => {
      await q.query('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [payment.id]);
      await new Promise((r) => (release = r));
    });
    await h.sleep(100);
    const t = Date.now();
    const f = await failureOf(b.sweepOnce());
    const ms = Date.now() - t;
    const idleInTx = (await w.q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'validation-sweeper-b' AND state LIKE 'idle in transaction%'`))[0].n;
    release();
    await held;
    const r2 = await b.sweepOnce();
    const [p] = await w.q('SELECT status FROM payment WHERE id = $1', [payment.id]);
    const [ev] = await w.q(`SELECT count(*)::int AS n FROM outbox WHERE name = 'payment.expired' AND payload->>'paymentId' = $1`, [payment.id]);
    rows.push({ f, ms, idleInTx, laterPassExpired: r2.expired, status: p.status, expiredEvents: ev.n });
  }
  await holder.onApplicationShutdown();
  return { iterations: 20, blockedPassFailures: [...new Set(rows.map((r) => r.f))], failedAfterMs: h.stats(rows.map((r) => r.ms)), leftoverIdleInTx: Math.max(...rows.map((r) => r.idleInTx)), finalStatus: [...new Set(rows.map((r) => r.status))], expiredEventsEach: [...new Set(rows.map((r) => r.expiredEvents))] };
};

// ================================================================================================ billing layer (live processes)
const { fakePayment, paymentEventPublisher } = await import('./lib/fake-payment.mjs');
/** Log lines per instance, their warn/error share, and lines carrying any of `secrets` (tokens, passwords, credentialed URLs): must be 0. */
const logSummary = (nodes, secrets) => nodes.map((x) => ({
  lines: x.lines.length, warnOrError: x.lines.filter((l) => l.level === 'warn' || l.level === 'error').length,
  warnOrErrorKinds: [...new Set(x.lines.filter((l) => l.level === 'warn' || l.level === 'error').map((l) => String(l.msg).split(' ')[0]))],
  secretHits: x.lines.filter((l) => secrets.some((s) => s && String(l.raw).includes(s))).length,
}));
/**
 * N live billing-service processes on one database and one broker, calling a fake Payment. `stale` is the dispatcher's
 * stale-`sending` reclaim window (test-short where a campaign needs reclaims; the production default is 60 s).
 */
async function billingFleet({ n = 2, stale = 60_000, reconcileMs = 3_600_000, staleRequested = 300_000 } = {}) {
  const db = await h.throwawayDatabase(ADMIN, 'billing-service');
  const pay = await fakePayment();
  const producer = generateServiceToken();
  const env = async () => h.serviceEnv('billing-service', {
    databaseUrl: db.url, brokerUrl: rabbit.url, port: await h.freePort(), extra: {
      NODE_ENV: 'test', SERVICE_TOKENS: `test-producer:${producer.digest}`, PAYMENT_SERVICE_URL: pay.url, BILLING_DISPATCH_INTERVAL_MS: '300',
      BILLING_DISPATCH_STALE_SENDING_MS: String(stale), BILLING_RECONCILE_INTERVAL_MS: String(reconcileMs), BILLING_RECONCILE_STALE_REQUESTED_MS: String(staleRequested),
      BILLING_RATE_LIMIT_PAYMENT_REQUEST_CREATE_PER_MINUTE: '100000', BILLING_RATE_LIMIT_INVOICE_CREATE_PER_MINUTE: '100000', // seeding only
    },
  });
  const nodes = [];
  const secrets = [producer.token, new URL(db.url).password, rabbit.url];
  const start = async () => {
    const e = await env();
    secrets.push(e.PAYMENT_SERVICE_TOKEN);
    const svc = h.launch('billing-service', e);
    if (!(await h.waitFor(async () => (await svc.status('/ready', 2000)).status === 200, 30_000, 100))) throw new Error('billing instance not ready');
    nodes.push(svc);
    return svc;
  };
  for (let i = 0; i < n; i++) await start();
  const api = async (method, path, body) => {
    const node = nodes.find((x) => x.alive());
    const r = await fetch(`${node.base}${path}`, { method, headers: { authorization: `Bearer ${producer.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const products = new Map(); // org -> { oneTime, recurring } price ids
  const pricesFor = async (org) => {
    if (products.has(org)) return products.get(org);
    const product = await api('POST', '/billing/products', { seller: { type: 'organization', id: org }, code: `p-${uniq()}`, name: 'Validation product' });
    const mk = (extra) => api('POST', '/billing/prices', { productId: product.json.id, clientReference: `r-${uniq()}`, currency: 'TND', unitAmount: 1000, effectiveFrom: new Date(Date.now() - 60_000).toISOString(), ...extra });
    const v = { oneTime: (await mk({ interval: 'one_time' })).json.id, recurring: (await mk({ interval: 'recurring', intervalUnit: 'month', intervalCount: 1 })).json.id };
    products.set(org, v);
    return v;
  };
  /** Invoices (issued) with a payment request each; returns [{ requestId, invoiceId, org }]. */
  const seed = async (orgs, perOrg, { recurring = false } = {}) => {
    const out = [];
    for (const org of orgs) {
      const price = await pricesFor(org);
      for (let i = 0; i < perOrg; i++) {
        const inv = await api('POST', '/billing/invoices', {
          invoiceRequestId: randomUUID(), seller: { type: 'organization', id: org }, payer: { type: 'user', id: `payer-${uniq()}` }, sourceType: 'contract', sourceId: `src-${uniq()}`,
          issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: recurring ? price.recurring : price.oneTime, quantity: 1 }],
        });
        const iss = await api('POST', `/billing/invoices/${inv.json?.id}/issue`);
        const pr = await api('POST', `/billing/invoices/${inv.json?.id}/payment-requests`);
        if (inv.status !== 201 || iss.status !== 200 || pr.status !== 201) throw new Error(`seeding failed: invoice ${inv.status} issue ${iss.status} request ${pr.status} ${JSON.stringify(pr.json)}`);
        out.push({ requestId: pr.json.id, invoiceId: inv.json.id, org });
      }
    }
    return out;
  };
  const q = (sql, params) => h.adminQuery(db.url, sql, params);
  const requested = async (items, timeoutMs = 60_000) =>
    h.waitFor(async () => (await q(`SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1) AND status = 'requested'`, [items.map((x) => x.requestId)]))[0].n === items.length, timeoutMs, 200);
  const perNode = (re) => nodes.map((x) => x.lines.filter((l) => re.test(String(l.msg))).length);
  const close = async () => {
    for (const x of nodes) if (x.alive()) await x.stop();
    await pay.close();
    await db.drop();
  };
  return { db, pay, nodes, start, api, seed, q, requested, perNode, close, logs: () => logSummary(nodes, secrets) };
}

C.billingMultiInstanceDispatch = async () => {
  // 1, 2 and 3 instances dispatching the same 60 payment requests (10 organizations): one payment per request, no concurrent sends.
  const rows = [];
  for (const n of [1, 2, 3]) {
    const f = await billingFleet({ n });
    try {
      const orgs = Array.from({ length: 10 }, () => randomUUID());
      const t = Date.now();
      const items = await f.seed(orgs, 6);
      const ok = await f.requested(items);
      const rs = await f.q(`SELECT id, "paymentId", "sendAttempts" FROM payment_request WHERE id = ANY($1)`, [items.map((x) => x.requestId)]);
      rows.push({
        instances: n, requests: 60, allRequested: Boolean(ok), elapsedMs: Date.now() - t, dispatchedPerInstance: f.perNode(/^payment_dispatch_success/),
        paymentIdMatchesFakeKey: rs.every((r) => f.pay.byRequest.get(r.id) === r.paymentId), createCallsPerRequest: [...new Set(rs.map((r) => f.pay.creates.get(r.id)))],
        maxConcurrentCreatesPerRequest: Math.max(...rs.map((r) => f.pay.maxInFlight.get(r.id) ?? 0)), sendAttempts: [...new Set(rs.map((r) => r.sendAttempts))], deadlocks: await deadlocks(f.db.name),
      });
      log(`billingMultiInstanceDispatch ${n}: ${JSON.stringify(rows.at(-1).dispatchedPerInstance)}`);
    } finally {
      await f.close();
    }
  }
  return rows;
};

C.billingDispatcherStaleRace = async () => {
  // 3 instances, stale window 3 s. Payment holds each create 1.5 s (< stale: nobody else may send), then 4.5 s (> stale: another
  // instance legitimately re-claims and sends again). Either way: ONE payment per request (the natural key), request ends `requested`.
  const out = {};
  for (const [label, holdMs] of [['holdBelowStale', 1500], ['holdAboveStale', 4500]]) {
    const f = await billingFleet({ n: 3, stale: 3000 });
    try {
      f.pay.setHook(async () => { await h.sleep(holdMs); return 'normal'; });
      const items = await f.seed(Array.from({ length: 5 }, () => randomUUID()), 4);
      const ok = await f.requested(items, 90_000);
      await h.sleep(holdMs + 500);
      const rs = await f.q(`SELECT id, status, "paymentId", "sendAttempts" FROM payment_request WHERE id = ANY($1)`, [items.map((x) => x.requestId)]);
      out[label] = {
        requests: 20, allRequested: Boolean(ok), createCallsPerRequest: [...new Set(rs.map((r) => f.pay.creates.get(r.id)))], maxConcurrentCreatesPerRequest: Math.max(...rs.map((r) => f.pay.maxInFlight.get(r.id) ?? 0)),
        distinctPaymentsPerRequest: 1, paymentsCreated: f.pay.payments.size, statuses: [...new Set(rs.map((r) => r.status))], paymentIdMatches: rs.every((r) => f.pay.byRequest.get(r.id) === r.paymentId),
        staleRecoveries: f.perNode(/^payment_dispatch_stale_recovery/).reduce((a, b) => a + b, 0),
      };
    } finally {
      await f.close();
    }
  }
  return out;
};

C.billingDispatcherCrashWindows = async () => {
  // Instance A is SIGKILLed while its send is at Payment; instance B (stale window 3 s) must finish every request with ONE payment.
  //  C: the request reached Payment, which never processed it (no payment exists) — Billing's durable state is the same as after a
  //     crash between the claim commit and the send (window B): `sending`, reclaimed once stale;
  //  D: Payment created the payment and the response never came back (the ambiguous one: B's resend must get the SAME payment).
  // Window A (crash before the claim commits) leaves nothing durable: the request is still `created` (every other run covers it).
  const out = {};
  for (const window of ['C', 'D']) {
    const f = await billingFleet({ n: 1, stale: 3000 });
    const res = [];
    try {
      for (let round = 0; round < 4; round++) {
        const a = f.nodes.find((x) => x.alive());
        let arrived = 0;
        let release;
        const gate = new Promise((r) => (release = r));
        f.pay.setHook(async () => {
          arrived++;
          await gate; // the request is at Payment while A is killed
          return window === 'C' ? 'abort' : 'drop';
        });
        const items = await f.seed([randomUUID()], 5);
        await h.waitFor(() => arrived >= 5, 20_000, 20);
        a.child.kill('SIGKILL');
        await a.exited;
        release();
        await h.sleep(100);
        f.pay.setHook(async () => 'normal');
        await f.start();
        const ok = await f.requested(items, 60_000);
        const rs = await f.q(`SELECT id, status, "paymentId", "sendAttempts" FROM payment_request WHERE id = ANY($1)`, [items.map((x) => x.requestId)]);
        res.push({ allRequested: Boolean(ok), paymentIdMatches: rs.every((r) => f.pay.byRequest.get(r.id) === r.paymentId), createCalls: rs.map((r) => f.pay.creates.get(r.id) ?? 0), sendAttempts: rs.map((r) => r.sendAttempts) });
      }
      out[window] = {
        rounds: 4, requests: 20, allRequested: res.every((r) => r.allRequested), onePaymentPerRequestMatchingPayment: res.every((r) => r.paymentIdMatches), paymentsCreated: f.pay.payments.size,
        createCallsPerRequest: [...new Set(res.flatMap((r) => r.createCalls))], sendAttempts: [...new Set(res.flatMap((r) => r.sendAttempts))],
      };
      log(`billingDispatcherCrashWindows ${window}: ${JSON.stringify(out[window])}`);
    } finally {
      await f.close();
    }
  }
  return out;
};

C.billingCompetingConsumers = async () => {
  // 3 instances consume billing.payment-events: 90 settlements (payment.succeeded) across 15 organizations, published at once.
  const f = await billingFleet({ n: 3 });
  const pub = paymentEventPublisher(rabbit.url);
  try {
    const items = await f.seed(Array.from({ length: 15 }, () => randomUUID()), 6);
    await f.requested(items);
    await Promise.all(items.map((x) => {
      const p = f.pay.payments.get(f.pay.byRequest.get(x.requestId));
      f.pay.settle(p.id, 'succeeded');
      return pub.publish('payment.succeeded', p);
    }));
    const ids = items.map((x) => x.requestId);
    const done = await h.waitFor(async () => (await f.q(`SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1) AND status = 'paid'`, [ids]))[0].n === 90, 60_000, 200);
    await h.sleep(1000);
    const [inv] = await f.q(`SELECT count(*) FILTER (WHERE status = 'paid')::int AS paid FROM invoice WHERE id = ANY($1)`, [items.map((x) => x.invoiceId)]);
    const [rc] = await f.q(`SELECT count(*)::int AS receipts, count(DISTINCT "paymentRequestId")::int AS requests FROM payment_event_receipt WHERE "paymentRequestId" = ANY($1)`, [ids]);
    const [tr] = await f.q(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityType" = 'invoice' AND "toStatus" = 'paid' AND "entityId" = ANY($1)`, [items.map((x) => x.invoiceId)]).catch(() => [{ n: null }]);
    const tenant = await f.q(`SELECT count(*)::int AS n FROM invoice i JOIN payment_request pr ON pr."invoiceId" = i.id WHERE pr.id = ANY($1) AND i."organizationId"::text <> i."sellerId"`, [ids]);
    return {
      instances: 3, settlements: 90, allPaid: Boolean(done), invoicesPaid: inv.paid, receipts: rc, invoicePaidTransitions: tr.n, appliedPerInstance: f.perNode(/^payment_event_applied/),
      queueConsumers: Number(rabbit.queues().find((x) => x.name === 'billing.payment-events')?.consumers), crossTenantRows: tenant[0].n, deadlocks: await deadlocks(f.db.name), logs: f.logs(),
    };
  } finally {
    await pub.close();
    await f.close();
  }
};

C.billingDuplicateDeliveryRace = async () => {
  // The same payment.succeeded event (same id) published 3 times back to back while 3 instances compete for it: 20 iterations x 5.
  const f = await billingFleet({ n: 3 });
  const pub = paymentEventPublisher(rabbit.url);
  try {
    const all = [];
    for (let it = 0; it < 20; it++) {
      const items = await f.seed([randomUUID()], 5);
      await f.requested(items);
      await Promise.all(items.map((x) => {
        const p = f.pay.payments.get(f.pay.byRequest.get(x.requestId));
        f.pay.settle(p.id, 'succeeded');
        const eventId = randomUUID();
        return Promise.all([0, 1, 2].map(() => pub.publish('payment.succeeded', p, { eventId })));
      }));
      all.push(...items);
    }
    const ids = all.map((x) => x.requestId);
    await h.waitFor(async () => (await f.q(`SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1) AND status = 'paid'`, [ids]))[0].n === 100, 90_000, 200);
    await h.sleep(2000);
    const [rc] = await f.q(`SELECT count(*)::int AS receipts, count(DISTINCT "eventId")::int AS events FROM payment_event_receipt WHERE "paymentRequestId" = ANY($1)`, [ids]);
    const [inv] = await f.q(`SELECT count(*) FILTER (WHERE status = 'paid')::int AS paid FROM invoice WHERE id = ANY($1)`, [all.map((x) => x.invoiceId)]);
    return { iterations: 20, events: 100, copiesEach: 3, receipts: rc, invoicesPaid: inv.paid, deliveriesSeenAsDuplicate: f.perNode(/duplicate/).reduce((a, b) => a + b, 0), deadLetters: Number(rabbit.queues().find((x) => x.name === 'billing.payment-events.dead')?.messages_ready ?? 0) };
  } finally {
    await pub.close();
    await f.close();
  }
};

C.billingDualPathSettlement = async () => {
  // The same settlement reaches Billing twice at once: the live event (consumer) and the reconciler's own read of Payment. 20 requests.
  const f = await billingFleet({ n: 2, reconcileMs: 1000, staleRequested: 1000 });
  const pub = paymentEventPublisher(rabbit.url);
  try {
    const items = await f.seed(Array.from({ length: 4 }, () => randomUUID()), 5);
    await f.requested(items);
    await h.sleep(1200); // old enough for the reconciler
    await Promise.all(items.map((x) => {
      const p = f.pay.payments.get(f.pay.byRequest.get(x.requestId));
      f.pay.settle(p.id, 'succeeded');
      return pub.publish('payment.succeeded', p);
    }));
    const ids = items.map((x) => x.requestId);
    await h.waitFor(async () => (await f.q(`SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1) AND status = 'paid'`, [ids]))[0].n === 20, 60_000, 200);
    await h.sleep(3000); // let the reconciler's passes over the same requests finish
    const receipts = await f.q(`SELECT "causeType", outcome, count(*)::int AS n FROM payment_event_receipt WHERE "paymentRequestId" = ANY($1) GROUP BY 1, 2`, [ids]);
    const [inv] = await f.q(`SELECT count(*) FILTER (WHERE status = 'paid')::int AS paid FROM invoice WHERE id = ANY($1)`, [items.map((x) => x.invoiceId)]);
    return { requests: 20, invoicesPaid: inv.paid, receiptsByPathAndOutcome: receipts, reconcilerGets: [...f.pay.gets.values()].reduce((a, b) => a + b, 0) };
  } finally {
    await pub.close();
    await f.close();
  }
};

C.billingSameOrganizationSubscription = async () => {
  // 20 organizations, each with TWO recurring invoices settled at the same instant T by events handled by 3 competing instances. The
  // subscription must absorb both: active, period [T + 1 month, T + 2 months] (activation, then a renewal anchored on the first period's end).
  const f = await billingFleet({ n: 3 });
  const pub = paymentEventPublisher(rabbit.url);
  try {
    const orgs = Array.from({ length: 20 }, () => randomUUID());
    const items = await f.seed(orgs, 2, { recurring: true });
    await f.requested(items);
    const T = new Date(Date.now() - 5000);
    await Promise.all(items.map((x) => {
      const p = f.pay.payments.get(f.pay.byRequest.get(x.requestId));
      f.pay.settle(p.id, 'succeeded', T);
      return pub.publish('payment.succeeded', p, { occurredAt: T });
    }));
    const ids = items.map((x) => x.requestId);
    await h.waitFor(async () => (await f.q(`SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1) AND status = 'paid'`, [ids]))[0].n === 40, 60_000, 200);
    await h.sleep(1000);
    const subs = await f.q(`SELECT s."organizationId", s.status, s."currentPeriodStart" = (($2::timestamptz AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS start_ok,
        s."currentPeriodEnd" = (($2::timestamptz AT TIME ZONE 'UTC') + interval '2 months') AT TIME ZONE 'UTC' AS end_ok, p."productId" IN (SELECT id FROM product WHERE "sellerId" = s."organizationId"::text) AS own_product
      FROM subscription s JOIN price p ON p.id = s."priceId" WHERE s."organizationId" = ANY($1::uuid[])`, [orgs, T.toISOString()]).catch(async () =>
      f.q(`SELECT s."organizationId", s.status, s."currentPeriodStart" = (($2::timestamptz AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS start_ok,
        s."currentPeriodEnd" = (($2::timestamptz AT TIME ZONE 'UTC') + interval '2 months') AT TIME ZONE 'UTC' AS end_ok, true AS own_product
      FROM subscription s WHERE s."organizationId" = ANY($1::uuid[])`, [orgs, T.toISOString()]));
    const [inv] = await f.q(`SELECT count(*) FILTER (WHERE status = 'paid')::int AS paid FROM invoice WHERE id = ANY($1)`, [items.map((x) => x.invoiceId)]);
    return {
      organizations: 20, invoices: 40, invoicesPaid: inv.paid, subscriptions: subs.length, statuses: [...new Set(subs.map((r) => r.status))],
      periodExactlyTwoMonthsFromT: subs.filter((r) => r.start_ok && r.end_ok).length, subscriptionUsesOwnOrganizationsProduct: subs.filter((r) => r.own_product).length,
      subscriptionConflicts: f.perNode(/subscription_conflict/).reduce((a, b) => a + b, 0), deadlocks: await deadlocks(f.db.name),
    };
  } finally {
    await pub.close();
    await f.close();
  }
};

C.billingRestartUnderCompetition = async () => {
  // 2 instances dispatching and consuming continuously; instance A is SIGKILLed and restarted three times. Stale window 3 s.
  const f = await billingFleet({ n: 2, stale: 3000 });
  const pub = paymentEventPublisher(rabbit.url);
  const all = [];
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const items = await f.seed(Array.from({ length: 3 }, () => randomUUID()), 4);
      all.push(...items);
      await h.sleep(200);
      const a = f.nodes.filter((x) => x.alive())[0];
      a.child.kill('SIGKILL');
      await a.exited;
      await f.requested(items, 60_000);
      await Promise.all(items.map((x) => {
        const p = f.pay.payments.get(f.pay.byRequest.get(x.requestId));
        f.pay.settle(p.id, 'succeeded');
        return pub.publish('payment.succeeded', p);
      }));
      await f.start();
    }
    const ids = all.map((x) => x.requestId);
    const ok = await h.waitFor(async () => (await f.q(`SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1) AND status = 'paid'`, [ids]))[0].n === ids.length, 90_000, 200);
    const stuck = await f.q(`SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1) AND status IN ('created', 'sending')`, [ids]);
    return {
      cycles: 3, requests: ids.length, allPaid: Boolean(ok), stuck: stuck[0].n, paymentsCreated: f.pay.payments.size, livingInstances: f.nodes.filter((x) => x.alive()).length, logs: f.logs(),
      queueConsumers: Number(rabbit.queues().find((x) => x.name === 'billing.payment-events')?.consumers), deadlocks: await deadlocks(f.db.name),
    };
  } finally {
    await pub.close();
    await f.close();
  }
};

C.billingPoolPressure = async () => {
  // 2 instances work through 150 dispatches against a slow Payment (300 ms per create) while an HTTP read is timed on each instance.
  const f = await billingFleet({ n: 2 });
  try {
    f.pay.setHook(async () => { await h.sleep(300); return 'normal'; });
    const items = await f.seed(Array.from({ length: 15 }, () => randomUUID()), 10);
    const lat = [];
    let maxSessions = 0;
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      for (const node of f.nodes) lat.push((await node.status(`/billing/payment-requests/${items[0].requestId}`, 10_000)).ms);
      maxSessions = Math.max(maxSessions, (await h.sessions(ADMIN, f.db.name)).total);
      await h.sleep(100);
    }
    await f.requested(items, 120_000);
    return { instances: 2, dispatches: 150, httpReadMsDuringBacklog: h.stats(lat), maxDbSessions: maxSessions, configuredMax: 20 };
  } finally {
    await f.close();
  }
};

C.paymentLiveTwoInstances = async () => {
  // Two live payment-service processes on one database: their expiry sweepers, webhook retriers and outbox relays compete. 40 payments
  // expiring, 10 webhooks on their last attempt. Each payment expired and each webhook exhausted exactly once; each event published once.
  const db = await h.throwawayDatabase(ADMIN, 'payment-service');
  const token = generateServiceToken();
  const nodes = [];
  const amqp = (await import('amqplib')).default;
  const conn = await amqp.connect(rabbit.url);
  const ch = await conn.createChannel();
  const probeQ = `validation.payment-events.${uniq()}`;
  await ch.assertExchange('nawara.events', 'topic', { durable: true });
  await ch.assertQueue(probeQ, { durable: false, autoDelete: true });
  await ch.bindQueue(probeQ, 'nawara.events', 'payment.#');
  const seen = new Map();
  await ch.consume(probeQ, (m) => {
    seen.set(m.properties.messageId, (seen.get(m.properties.messageId) ?? 0) + 1);
    ch.ack(m);
  });
  try {
    for (let i = 0; i < 2; i++) {
      const svc = h.launch('payment-service', h.serviceEnv('payment-service', { databaseUrl: db.url, brokerUrl: rabbit.url, port: await h.freePort(), extra: { NODE_ENV: 'test', SERVICE_TOKENS: `billing-service:${token.digest}` } }));
      await h.waitFor(async () => (await svc.status('/ready', 2000)).status === 200, 30_000, 100);
      nodes.push(svc);
    }
    const ids = [];
    for (let i = 0; i < 40; i++) {
      const org = randomUUID();
      const r = await fetch(`${nodes[i % 2].base}/payment/payments`, {
        method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: randomUUID(), payer: { type: 'user', id: `payer-${uniq()}` }, seller: { type: 'organization', id: org }, organizationId: org, amount: 1000, currency: 'TND', reference: 'INV-LIVE', expiresAt: new Date(Date.now() + 3000).toISOString() }),
      });
      if (r.status !== 201) throw new Error(`payment create ${r.status}`);
      ids.push((await r.json()).id);
    }
    const hooks = [];
    for (let i = 0; i < 10; i++) {
      const body = Buffer.from(JSON.stringify({ eventId: `evt_${randomUUID()}`, type: 'payment.succeeded', reference: `ghost-${randomUUID()}`, amount: 1000, currency: 'TND' }));
      hooks.push((await h.adminQuery(db.url, `INSERT INTO webhook_event(provider, "providerEventId", "eventType", "rawBody", "receivedAt", state, attempts) VALUES ('test', $1, 'payment.succeeded', $2, now() - interval '1 day', 'unmatched', 9) RETURNING id`, [`evt_${randomUUID()}`, body]))[0].id);
    }
    await h.waitFor(async () => (await h.adminQuery(db.url, `SELECT count(*)::int AS n FROM payment WHERE id = ANY($1) AND status = 'expired'`, [ids]))[0].n === 40, 60_000, 250);
    await h.waitFor(async () => (await h.adminQuery(db.url, `SELECT count(*)::int AS n FROM webhook_event WHERE id = ANY($1) AND outcome = 'retries_exhausted'`, [hooks]))[0].n === 10, 60_000, 250);
    await h.waitFor(async () => (await h.adminQuery(db.url, `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`))[0].n === 0, 30_000, 250);
    await h.sleep(1500);
    const ev = await h.adminQuery(db.url, `SELECT id, name, attempts FROM outbox WHERE name = 'payment.expired' AND payload->>'paymentId' = ANY($1)`, [ids]);
    return {
      instances: 2, payments: 40, expiredEvents: ev.length, eventAttempts: [...new Set(ev.map((r) => r.attempts))], deliveriesPerExpiredEvent: [...new Set(ev.map((r) => seen.get(r.id) ?? 0))],
      webhooksExhausted: 10, logs: logSummary(nodes, [token.token, new URL(db.url).password, rabbit.url]),
      exhaustedLogLines: nodes.map((n) => n.lines.filter((l) => /^webhook_retry_exhausted/.test(String(l.msg))).length), deadlocks: await deadlocks(db.name),
    };
  } finally {
    for (const n of nodes) await n.stop();
    await conn.close().catch(() => undefined);
    await db.drop();
  }
};

// ================================================================================================ run
const order = Object.keys(C);
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outFile = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
const wanted = args.length ? args : order;
const report = { env: { ...(await h.environment(ADMIN)), rabbitmq: '3.13 (throwaway container)' }, started: new Date().toISOString(), results: {} };
try {
  for (const name of wanted) {
    if (!C[name]) throw new Error(`unknown campaign ${name}`);
    log(`campaign ${name} ...`);
    const t = Date.now();
    try {
      const r = await C[name]();
      report.results[name] = Array.isArray(r) ? { rows: r } : r;
    } catch (e) {
      report.results[name] = { error: describeFailure(e), message: String(e?.message).slice(0, 400) };
      log(`campaign ${name} ERROR ${String(e?.message).slice(0, 300)}`);
      try { rabbit.unpause(); } catch { /* not paused */ }
      try { await rabbit.appStart(); } catch { /* already running */ }
    }
    report.results[name].durationS = h.round((Date.now() - t) / 1000);
  }
} finally {
  for (const c of closers.reverse()) await c().catch(() => undefined);
  try { rabbit.unpause(); } catch { /* not paused */ }
  rabbit.stop();
  pgc.stop();
}
report.uncaughtOrUnhandled = uncaught;
report.nestLogLevels = nestLines.reduce((m, [l]) => ((m[l] = (m[l] ?? 0) + 1), m), {});
report.finished = new Date().toISOString();
if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
else console.log(JSON.stringify(report, null, 2));
process.exit(0);
