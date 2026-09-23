#!/usr/bin/env node
// Stage 15.3: RabbitMQ, outbox and consumer failure campaigns (test-only). Plan and criteria: docs/architecture/core-validation.md.
//
//   node scripts/validation/broker-campaigns.mjs [--out results.json] [campaign ...]      (default: all, in plan order)
//
// Starts its OWN throwaway RabbitMQ and PostgreSQL containers (loopback ports, names `validation-*`) and removes them at the end; it never
// touches another container, a non-loopback host or production. Needs built workspaces (kit, billing, payment).
// Kit-layer campaigns drive the real OutboxService -> OutboxRelay -> RabbitMqEventBus -> InboxService path with per-event accounting;
// app-layer campaigns drive live payment-service and billing-service processes (Payment's outbox, Billing's consumer).
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import amqp from 'amqplib';
import {
  DbService, InboxService, OutboxRelay, OutboxService, PermanentEventFailure, RabbitMqEventBus, ReadinessRegistry, describeFailure, generateServiceToken,
  kitMigrationsDir, runMigrations,
} from '../../libs/service-kit/dist/index.js';
import { BrokerProxy } from '../../libs/service-kit/dist/testing/broker-proxy.js';
import * as h from './lib/harness.mjs';
import { envelopeHeaders, kitWorlds, uniq } from './lib/kit-world.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('refusing to run with NODE_ENV=production');
const log = (...a) => process.stderr.write(`[15.3] ${a.join(' ')}\n`);
let uncaught = 0;
process.on('uncaughtException', (e) => {
  uncaught++;
  log('UNCAUGHT', describeFailure(e), String(e?.message).slice(0, 120));
});
process.on('unhandledRejection', (e) => {
  uncaught++;
  log('UNHANDLED', describeFailure(e), String(e?.message).slice(0, 120));
});
const failureOf = async (p) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return describeFailure(e);
  }
};
const closers = [];
const later = (fn) => closers.push(fn);

const rabbit = await h.throwawayRabbit();
const pgc = await h.throwawayPostgres();
const ADMIN = pgc.adminUrl;
log(`throwaway broker ${rabbit.name} :${rabbit.port}, postgres ${pgc.name} :${pgc.port}`);

// ------------------------------------------------------------------------------------------------ kit world
const kitWorld = kitWorlds({ rabbit, adminUrl: ADMIN });
const settled = (p, ms) => Promise.race([p.then(() => true, () => true), h.sleep(ms).then(() => false)]);

// ------------------------------------------------------------------------------------------------ campaigns
const C = {};

C.baselineKit = async () => {
  const w = await kitWorld();
  try {
    w.relay.start(1000);
    const t = Date.now();
    await w.enqueue(200);
    const a = await h.waitFor(async () => { const x = await w.account(); return x.lost === 0 && x.pending === 0 && x; }, 60_000, 50);
    const pubLat = await h.adminQuery(w.db.url, `SELECT EXTRACT(EPOCH FROM ("publishedAt" - "occurredAt")) * 1000 AS ms FROM outbox`);
    const endToEnd = w.received.map((r) => r.at - r.occurredAt);
    return {
      events: 200, accounting: a, totalMs: Date.now() - t, occurredToPublishedMs: h.stats(pubLat.map((r) => Number(r.ms))), occurredToHandlerMs: h.stats(endToEnd),
      relayErrors: w.relayErrors.length, notices: w.notices.length, queue: rabbit.queues().find((q) => q.name === w.queue),
    };
  } finally {
    await w.close();
  }
};

C.brokerDownBeforePublish = async () => {
  // The broker process stops (connections refused), business transactions keep committing their outbox rows, the relay keeps trying.
  const runs = [];
  for (let run = 0; run < 3; run++) {
    const w = await kitWorld();
    try {
      w.relay.start(1000);
      await w.enqueue(5);
      await h.waitFor(async () => (await w.account()).lost === 0, 20_000, 50);
      rabbit.appStop();
      const tDown = Date.now();
      const txMs = [];
      for (let i = 0; i < 100; i++) {
        const t = Date.now();
        await w.enqueue(1);
        txMs.push(Date.now() - t);
      }
      const cpu0 = process.cpuUsage();
      let maxHeld = 0, maxIdleInTx = 0;
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        maxHeld = Math.max(maxHeld, w.dbs.pool.totalCount - w.dbs.pool.idleCount);
        maxIdleInTx = Math.max(maxIdleInTx, (await h.sessions(ADMIN, w.db.name)).byState['idle in transaction'] ?? 0);
        await h.sleep(200);
      }
      const cpu = process.cpuUsage(cpu0);
      const during = await w.account();
      const attemptsRows = await h.adminQuery(w.db.url, `SELECT max(attempts)::int AS max, min("availableAt") > now() AS all_backing_off FROM outbox WHERE "publishedAt" IS NULL`);
      const errorsDown = w.relayErrors.length;
      const tUp = Date.now();
      await rabbit.appStart();
      const brokerBackMs = Date.now() - tUp;
      const tFirst = await h.waitFor(async () => (await w.account()).published > 5 && Date.now(), 120_000, 100);
      const done = await h.waitFor(async () => { const x = await w.account(); return x.pending === 0 && x.lost === 0 && Date.now(); }, 180_000, 200);
      const final = await w.account();
      runs.push({
        run, businessTxMsWhileDown: h.stats(txMs), outboxDuringOutage: { pending: during.pending, businessRows: during.businessRows, maxAttempts: attemptsRows[0].max },
        relayFailureLinesPerSec: h.round(errorsDown / ((tUp - tDown) / 1000), 2), processCpuPctDuringOutage: h.round(((cpu.user + cpu.system) / 1000 / 15_000) * 100, 2),
        maxDbClientsCheckedOut: maxHeld, maxIdleInTransactionSessions: maxIdleInTx, brokerRestartMs: brokerBackMs,
        firstPublishAfterBrokerBackMs: tFirst ? tFirst - tUp - brokerBackMs : null, drainedToZeroAfterBrokerBackMs: done ? done - tUp - brokerBackMs : null,
        consumerCount: rabbit.queues().find((q) => q.name === w.queue)?.consumers, accounting: final,
      });
      log(`brokerDownBeforePublish run ${run}: pending ${during.pending} -> drained in ${runs.at(-1).drainedToZeroAfterBrokerBackMs} ms`);
    } finally {
      await w.close();
    }
  }
  return runs;
};

C.outageCycles = async () => {
  // Continuous traffic through five broker stop/start cycles; after each recovery the topology must converge (one consumer, no leaks).
  const w = await kitWorld();
  const rows = [];
  let generating = true;
  const gen = (async () => {
    while (generating) {
      await w.enqueue(1).catch(() => undefined);
      await h.sleep(100);
    }
  })();
  try {
    w.relay.start(1000);
    await h.sleep(3000);
    const mem0 = process.memoryUsage().rss / 2 ** 20;
    for (let c = 0; c < 5; c++) {
      rabbit.appStop();
      const tDown = Date.now();
      await h.sleep(8000);
      await rabbit.appStart();
      const tUp = Date.now();
      const back = await h.waitFor(() => w.buses.every((b) => b.consumerStatus().every((s) => s.state === 'consuming')) && Date.now(), 60_000, 50);
      await h.sleep(3000);
      const q = rabbit.queues().find((x) => x.name === w.queue);
      rows.push({
        cycle: c, downMs: tUp - tDown, consumerReattachedMs: back ? back - tUp : null, queueConsumers: Number(q?.consumers), brokerConnections: rabbit.connections().length,
        brokerChannels: rabbit.channels().length, rssMb: h.round(process.memoryUsage().rss / 2 ** 20),
      });
      log(`outageCycles ${c}: consumers=${q?.consumers} conns=${rows.at(-1).brokerConnections} chans=${rows.at(-1).brokerChannels}`);
    }
    generating = false;
    await gen;
    const final = await w.drainAll(120_000);
    return { cycles: rows, rssMbStart: h.round(mem0), accounting: final ?? (await w.account()) };
  } finally {
    generating = false;
    await w.close();
  }
};

C.confirmTimeout = async () => {
  // publish -> the broker receives it but its confirm never comes back (proxy freezes broker->client) -> bounded failure, channel discarded.
  const proxy = new BrokerProxy({ host: '127.0.0.1', port: rabbit.port });
  await proxy.start();
  later(async () => { proxy.thaw(); await proxy.sever(); });
  const exchange = `validation.x.${uniq()}`;
  const timing = [];
  for (let i = 0; i < 3; i++) {
    const bus = new RabbitMqEventBus({ url: proxy.url, exchange }); // default confirmTimeoutMs (5000)
    const id0 = randomUUID();
    await bus.publish({ id: id0, name: 'validation.warm', payload: {}, headers: envelopeHeaders(id0, 'validation.warm') });
    proxy.freeze();
    const id = randomUUID();
    const t = Date.now();
    const f = await failureOf(bus.publish({ id, name: 'validation.stalled', payload: {}, headers: envelopeHeaders(id, 'validation.stalled') }));
    const ms = Date.now() - t;
    proxy.thaw();
    const id2 = randomUUID();
    const after = await failureOf(bus.publish({ id: id2, name: 'validation.after', payload: {}, headers: envelopeHeaders(id2, 'validation.after') }));
    timing.push({ f, ms, after });
    await bus.close();
  }
  // Channel disposition (test bound 500 ms, 20 iterations): the timed-out channel is never reused and its late confirm cannot resolve a later publish.
  const bus = new RabbitMqEventBus({ url: proxy.url, exchange, confirmTimeoutMs: 500 });
  const disp = [];
  for (let i = 0; i < 20; i++) {
    const a = randomUUID();
    await bus.publish({ id: a, name: 'validation.warm', payload: {}, headers: envelopeHeaders(a, 'validation.warm') });
    const chBefore = bus.publisher;
    proxy.freeze();
    const b = randomUUID();
    const fb = await failureOf(bus.publish({ id: b, name: 'validation.stalled', payload: {}, headers: envelopeHeaders(b, 'validation.stalled') }));
    proxy.thaw();
    const c = randomUUID();
    const t = Date.now();
    const fc = await failureOf(bus.publish({ id: c, name: 'validation.after', payload: {}, headers: envelopeHeaders(c, 'validation.after') }));
    disp.push({ fb, fc, cMs: Date.now() - t, newChannel: bus.publisher !== chBefore && bus.publisher !== undefined });
  }
  await bus.close();
  return {
    defaultBound: { runs: 3, kinds: [...new Set(timing.map((x) => x.f))], failMs: h.stats(timing.map((x) => x.ms)), laterPublishOk: timing.every((x) => x.after === 'ok') },
    disposition: { runs: 20, stalledKinds: [...new Set(disp.map((x) => x.fb))], laterPublishAllOk: disp.every((x) => x.fc === 'ok'), freshChannelEveryTime: disp.every((x) => x.newChannel), laterPublishMs: h.stats(disp.map((x) => x.cMs)) },
  };
};

C.lostConfirm = async () => {
  // The dangerous ambiguity: the broker stored the message, the confirm is lost, the relay retries -> duplicate delivery -> ONE effect.
  const proxy = new BrokerProxy({ host: '127.0.0.1', port: rabbit.port });
  await proxy.start();
  later(async () => { proxy.thaw(); await proxy.sever(); });
  const w = await kitWorld({ publisherUrl: proxy.url, confirmTimeoutMs: 500 });
  const iters = [];
  try {
    for (let i = 0; i < 20; i++) {
      await w.enqueue(1);
      const id = w.ids.at(-1);
      await w.pub.publish({ id: randomUUID(), name: 'warm.up', payload: {}, headers: envelopeHeaders(randomUUID(), 'warm.up') }); // an established confirm channel (unbound key: dropped)
      proxy.freeze();
      let heldDuring = 0, idleInTx = 0;
      const pass = w.relay.drainOnce();
      await h.sleep(250);
      heldDuring = w.dbs.pool.totalCount - w.dbs.pool.idleCount;
      idleInTx = (await h.sessions(ADMIN, w.db.name)).byState['idle in transaction'] ?? 0;
      const t = Date.now();
      const r1 = await pass;
      const passMs = Date.now() - t + 250;
      proxy.thaw();
      await h.waitFor(() => (w.deliveries.get(id) ?? 0) >= 1, 10_000, 20); // the original DID reach the broker and the consumer
      const [row] = await h.adminQuery(w.db.url, 'SELECT "publishedAt" IS NOT NULL AS published, attempts, "lastError" FROM outbox WHERE id = $1', [id]);
      await h.adminQuery(w.db.url, `UPDATE outbox SET "availableAt" = now() WHERE id = $1`, [id]); // skip the backoff wait (test only)
      const r2 = await w.relay.drainOnce();
      await h.waitFor(() => (w.deliveries.get(id) ?? 0) >= 2, 10_000, 20);
      await h.sleep(200);
      iters.push({ firstPass: r1, passMs, stateAfterTimeout: row, dbClientHeldDuringStall: heldDuring, idleInTransactionDuringStall: idleInTx, secondPass: r2, deliveries: w.deliveries.get(id) });
    }
    const acc = await w.account();
    return {
      iterations: 20, firstPassAllFailed: iters.every((x) => x.firstPass.failed === 1), rowStayedPendingEveryTime: iters.every((x) => !x.stateAfterTimeout.published),
      lastErrorRecorded: iters[0].stateAfterTimeout.lastError, relayPassMs: h.stats(iters.map((x) => x.passMs)), dbClientsHeldDuringStall: [...new Set(iters.map((x) => x.dbClientHeldDuringStall))],
      idleInTxDuringStall: [...new Set(iters.map((x) => x.idleInTransactionDuringStall))], deliveriesPerEvent: [...new Set(iters.map((x) => x.deliveries))], accounting: acc,
      confirmTimeoutNotice: w.notices.find(([, m]) => m.startsWith('rabbitmq_confirm_timeout'))?.[1]?.split(' —')[0],
    };
  } finally {
    await w.close();
  }
};

C.connectionCutDuringPublish = async () => {
  const proxy = new BrokerProxy({ host: '127.0.0.1', port: rabbit.port });
  await proxy.start();
  later(async () => { proxy.thaw(); await proxy.sever(); });
  const w = await kitWorld({ publisherUrl: proxy.url });
  const iters = [];
  try {
    for (let i = 0; i < 20; i++) {
      await w.enqueue(1);
      const id = w.ids.at(-1);
      await w.pub.publish({ id: randomUUID(), name: 'warm.up', payload: {}, headers: envelopeHeaders(randomUUID(), 'warm.up') }); // an established confirm channel (unbound key: dropped)
      proxy.freeze(); // the publish is on the wire, its confirm pending...
      const pass = w.relay.drainOnce();
      await h.sleep(200);
      const t = Date.now();
      await proxy.sever(); // ...and the connection is cut under it
      const r1 = await pass;
      const failMs = Date.now() - t;
      proxy.thaw();
      await proxy.start();
      await h.adminQuery(w.db.url, `UPDATE outbox SET "availableAt" = now() WHERE id = $1`, [id]);
      const r2 = await w.relay.drainOnce();
      await h.waitFor(() => (w.deliveries.get(id) ?? 0) >= 1, 10_000, 20);
      await h.sleep(150);
      iters.push({ r1, failMs, r2, deliveries: w.deliveries.get(id) });
    }
    const acc = await w.account();
    return {
      iterations: 20, cutPassFailed: iters.every((x) => x.r1.failed === 1), failAfterCutMs: h.stats(iters.map((x) => x.failMs)), retryPublished: iters.every((x) => x.r2.published >= 1),
      deliveriesPerEvent: [...new Set(iters.map((x) => x.deliveries))], accounting: acc, relayErrorSample: w.relayErrors[0]?.split(' —')[0],
    };
  } finally {
    await w.close();
  }
};

C.brokerFreeze = async () => {
  // I9 audit: the broker process frozen (docker pause), its TCP still accepted by the kernel. What is bounded, and by what?
  const w = await kitWorld();
  const reg = new ReadinessRegistry(2000, () => undefined);
  reg.register('rabbitmq', async () => {
    const c = await amqp.connect(rabbit.url, { timeout: 2000 });
    await c.close();
  });
  reg.register('rabbitmq-consumer', async () => {
    if (w.buses.some((b) => b.consumerStatus().some((s) => s.state !== 'consuming'))) throw new Error('consumer not attached');
  });
  const CAP = 200_000;
  const out = {};
  let paused = false;
  try {
    await w.enqueue(3);
    await w.drainAll(20_000);
    rabbit.pause();
    paused = true;
    const tFreeze = Date.now();
    // 1. a publish on the warm confirm channel: bounded by RABBITMQ_CONFIRM_TIMEOUT_MS?
    await w.enqueue(1);
    let t = Date.now();
    const p1 = await w.relay.drainOnce();
    out.publishWarmChannel = { result: p1, ms: Date.now() - t, relayError: w.relayErrors.at(-1)?.split(' —')[0] };
    // 2. the next publish needs a NEW channel (the timed-out one was discarded): channel.open + exchange declare on a frozen broker
    await h.adminQuery(w.db.url, `UPDATE outbox SET "availableAt" = now() WHERE "publishedAt" IS NULL`);
    t = Date.now();
    const tNewChannel = t;
    const p2 = failureOf(w.relay.drainOnce()).then((r) => ({ r, ms: Date.now() - t }));
    // 3. readiness during the freeze
    const r = await reg.run();
    out.readinessDuringFreeze = { failed: r.failed, ms: Date.now() - t };
    // 4. what the consumer believes
    out.consumerStatusDuringFreeze = w.buses.flatMap((b) => b.consumerStatus().map((s) => s.state));
    const p2res = await Promise.race([p2, h.sleep(CAP).then(() => undefined)]);
    out.publishNeedingNewChannel = p2res ? { passResult: p2res.r, passEndedAfterMs: p2res.ms, relayError: w.relayErrors.at(-1)?.split(' —')[0] } : { result: `still pending after ${CAP} ms` };
    const lost = w.notices.find(([, m]) => m.startsWith('rabbitmq_consumer_lost'));
    out.consumerLossDetectedAfterFreezeMs = lost ? lost[2] - tFreeze : null; // amqplib heartbeat (negotiated 60 s): missed twice
    out.relayDbSessionStateAfterPass = (await h.sessions(ADMIN, w.db.name)).byState;
    void tNewChannel;
    out.consumerStatusAfterWait = w.buses.flatMap((b) => b.consumerStatus().map((s) => s.state));
    out.noticesDuringFreeze = w.notices.filter(([, m]) => !m.startsWith('event_')).map(([l, m]) => `${l} ${m.split(' —')[0]}`).slice(0, 8);
    // 5. closing the consumer while the broker is frozen (what a SIGTERM does)
    t = Date.now();
    const closeP = w.subs[0].close().then(() => Date.now() - t);
    const closeMs = await Promise.race([closeP, h.sleep(60_000).then(() => undefined)]);
    out.consumerCloseDuringFreeze = closeMs !== undefined ? { ms: closeMs } : { result: 'still pending after 60000 ms' };
    out.frozenForMs = Date.now() - tFreeze;
    rabbit.unpause();
    paused = false;
    await h.sleep(3000);
    await w.makeConsumer();
    const fin = await w.drainAll(60_000);
    out.afterUnpause = fin ?? (await w.account());
    return out;
  } finally {
    if (paused) rabbit.unpause();
    await w.close();
  }
};

C.brokerFreezeHeartbeatDisabled = async () => {
  // The same freeze against a broker configured with `heartbeat = 0` (a legal RabbitMQ setting). Core sets no client heartbeat and
  // accepts the broker's proposal, so nothing is left to end a channel operation on a silent broker. Observed for up to 240 s.
  const nohb = await h.throwawayRabbit({ heartbeatS: 0 });
  later(async () => { try { nohb.unpause(); } catch { /* not paused */ } nohb.stop(); });
  const exchange = `validation.x.${uniq()}`;
  const pub = new RabbitMqEventBus({ url: nohb.url, exchange });
  const lostAt = [];
  const cons = new RabbitMqEventBus({ url: nohb.url, exchange, onNotice: (m) => m.startsWith('rabbitmq_consumer_lost') && lostAt.push(Date.now()) });
  const sub = await cons.subscribe({ queue: `validation.q.${uniq()}`, bindings: ['validation.#'], handler: async () => undefined });
  const id0 = randomUUID();
  await pub.publish({ id: id0, name: 'validation.warm', payload: {}, headers: envelopeHeaders(id0, 'validation.warm') });
  const negotiated = pub.connection?.connection?.heartbeat;
  nohb.pause();
  const tFreeze = Date.now();
  const CAP = 240_000;
  const out = { negotiatedHeartbeatS: negotiated };
  try {
    let t = Date.now();
    const id1 = randomUUID();
    out.publishWarmChannel = { result: await failureOf(pub.publish({ id: id1, name: 'validation.x', payload: {}, headers: envelopeHeaders(id1, 'validation.x') })), ms: Date.now() - t };
    t = Date.now();
    const id2 = randomUUID();
    const p2 = failureOf(pub.publish({ id: id2, name: 'validation.x', payload: {}, headers: envelopeHeaders(id2, 'validation.x') })).then((r) => ({ r, ms: Date.now() - t }));
    const c = sub.close().then(() => ({ r: 'closed', ms: Date.now() - t }));
    const [r2, rc] = await Promise.all([Promise.race([p2, h.sleep(CAP).then(() => undefined)]), Promise.race([c, h.sleep(CAP).then(() => undefined)])]);
    out.publishNeedingNewChannel = r2 ?? { result: `still pending after ${CAP} ms` };
    out.consumerClose = rc ?? { result: `still pending after ${CAP} ms` };
    out.consumerStatusAfter = cons.consumerStatus().map((s) => s.state);
    out.consumerLossDetectedAfterFreezeMs = lostAt[0] ? lostAt[0] - tFreeze : null;
    return out;
  } finally {
    nohb.unpause();
    await pub.close().catch(() => undefined);
    await cons.close().catch(() => undefined);
  }
};

C.billingSigtermFreeze = async () => {
  // SIGTERM to a live billing-service while its broker is frozen: 3 runs against a default broker, 3 against one with heartbeats off.
  const out = {};
  for (const [label, hb] of [['brokerDefaultHeartbeat', undefined], ['brokerHeartbeatDisabled', 0]]) {
    const r = hb === undefined ? rabbit : await h.throwawayRabbit({ heartbeatS: hb });
    const runs = [];
    try {
      for (let i = 0; i < 3; i++) {
        const db = await h.throwawayDatabase(ADMIN, 'billing-service');
        const svc = h.launch('billing-service', h.serviceEnv('billing-service', { databaseUrl: db.url, brokerUrl: r.url, port: 5900 + Math.floor(Math.random() * 90) }));
        let paused = false;
        try {
          await h.waitFor(async () => (await svc.status('/ready', 2000)).status === 200, 30_000, 100);
          await h.sleep(1500);
          r.pause();
          paused = true;
          await h.sleep(500);
          const tS = h.now();
          svc.child.kill('SIGTERM');
          const ex = await Promise.race([svc.exited, h.sleep(240_000).then(() => undefined)]);
          runs.push(ex
            ? { exitedAfterMs: h.round(ex.t - tS), exit: ex.code ?? ex.signal, phases: svc.since(tS, (l) => /shutdown|drain|rabbitmq_|_failure/.test(String(l.msg))).map((l) => `${h.round(l.t - tS)}ms ${String(l.msg).split(' —')[0]}`).slice(0, 10) }
            : { exitedAfterMs: null, result: 'still running after 240000 ms' });
        } finally {
          if (paused) r.unpause();
          if (svc.alive()) svc.child.kill('SIGKILL');
          await db.drop();
        }
        log(`billingSigtermFreeze ${label} run ${i}: ${runs.at(-1).exitedAfterMs} ms`);
      }
    } finally {
      if (r !== rabbit) r.stop();
    }
    const ms = runs.map((x) => x.exitedAfterMs).filter((x) => x !== null);
    out[label] = { runs, exitedAll: ms.length === runs.length, sigtermToExitMs: ms.length ? h.stats(ms) : null };
  }
  return out;
};

C.consumerFailures = async () => {
  // Default retry policy (3 retries, 5000 ms apart, then dead-letter; a PermanentEventFailure dead-letters at once).
  const w = await kitWorld({ subscribe: false });
  const plan = new Map(); // eventId -> 'transient-then-ok' | 'always-transient' | 'permanent'
  const failCount = new Map();
  w.handlerHooks.before = async (event) => {
    const kind = plan.get(event.id);
    if (!kind) return;
    const n = (failCount.get(event.id) ?? 0) + 1;
    failCount.set(event.id, n);
    if (kind === 'permanent') throw new PermanentEventFailure('invalid_payload');
    if (kind === 'always-transient') throw new Error('simulated transient failure');
    if (kind === 'transient-then-ok' && n <= 2) throw new Error('simulated transient failure');
  };
  await w.makeConsumer();
  const publish = async (kind) => {
    const id = randomUUID();
    if (kind) plan.set(id, kind);
    await w.pub.publish({ id, name: 'validation.happened', payload: { id }, headers: envelopeHeaders(id, 'validation.happened') });
    w.ids.push(id);
    return id;
  };
  try {
    const tT = Date.now();
    const transient = await publish('transient-then-ok');
    const poison = await publish('always-transient');
    const tGood = Date.now();
    const goodA = await publish(undefined);
    const goodB = await publish(undefined);
    const perm = await publish('permanent');
    await h.waitFor(async () => (await h.adminQuery(w.db.url, 'SELECT count(*)::int AS n FROM effect WHERE event_id = ANY($1)', [[goodA, goodB]]))[0].n === 2, 10_000, 20);
    const goodLatencyMs = Date.now() - tGood;
    await h.waitFor(async () => (await h.adminQuery(w.db.url, 'SELECT count(*)::int AS n FROM effect WHERE event_id = $1', [transient]))[0].n === 1, 60_000, 50);
    const transientMs = Date.now() - tT;
    await h.waitFor(() => Number(rabbit.queues().find((q) => q.name === `${w.queue}.dead`)?.messages_ready ?? 0) >= 2, 60_000, 200);
    const poisonMs = Date.now() - tT;
    const deadCh = await (await amqp.connect(rabbit.url)).createChannel();
    const dead = [];
    const held = [];
    for (let i = 0; i < 2; i++) {
      const m = await deadCh.get(`${w.queue}.dead`, { noAck: false }); // held unacknowledged until the end, so the next get returns the next message
      if (m) {
        held.push(m);
        dead.push({ id: m.properties.messageId, type: m.properties.type, correlationId: m.properties.headers.correlationId, failure: m.properties.headers['x-nawara-failure'], reason: m.properties.headers['x-nawara-failure-reason'], retries: m.properties.headers['x-nawara-retry-count'], error: m.properties.headers['x-nawara-failure-error'] });
      }
    }
    for (const m of held) deadCh.nack(m, false, true);
    await deadCh.close();
    const acc = await w.account();
    const eff = Object.fromEntries((await h.adminQuery(w.db.url, 'SELECT event_id, count(*)::int AS n FROM effect GROUP BY 1')).map((r) => [r.event_id, r.n]));
    return {
      transientThenOk: { deliveries: w.deliveries.get(transient), effects: eff[transient] ?? 0, processedAfterMs: transientMs },
      poisonAlwaysTransient: { deliveries: w.deliveries.get(poison), effects: eff[poison] ?? 0, deadLetteredAfterMs: poisonMs },
      permanent: { deliveries: w.deliveries.get(perm), effects: eff[perm] ?? 0 },
      goodMessagesBehindPoison: { effects: [eff[goodA] ?? 0, eff[goodB] ?? 0], processedWithinMs: goodLatencyMs },
      deadLetterQueue: dead, accounting: acc,
      notices: [...new Set(w.notices.map(([l, m]) => `${l} ${m.split(' ')[0]}`))],
    };
  } finally {
    await w.close();
  }
};

C.duplicateDelivery = async () => {
  // Same event id delivered more than once: sequentially to one consumer, and concurrently to two competing consumers (20 iterations).
  const w = await kitWorld({ consumers: 2 });
  const direct = await (await amqp.connect(rabbit.url)).createConfirmChannel();
  const send = (id) => direct.publish(w.exchange, 'validation.dup', Buffer.from(JSON.stringify({ id })), { persistent: true, messageId: id, type: 'validation.dup', headers: envelopeHeaders(id, 'validation.dup') });
  try {
    const seq = [];
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      w.ids.push(id);
      for (let k = 0; k < 3; k++) {
        send(id);
        await direct.waitForConfirms();
        await h.waitFor(() => (w.deliveries.get(id) ?? 0) >= k + 1, 10_000, 10);
      }
      seq.push(id);
    }
    const conc = [];
    for (let i = 0; i < 20; i++) {
      const batch = Array.from({ length: 10 }, () => randomUUID());
      w.ids.push(...batch);
      for (const id of batch) for (let k = 0; k < 4; k++) send(id); // 4 copies of each, interleaved, to two competing consumers
      await direct.waitForConfirms();
      await h.waitFor(() => batch.every((id) => (w.deliveries.get(id) ?? 0) >= 4), 20_000, 10);
      conc.push(batch);
    }
    await h.sleep(500);
    const acc = await w.account();
    const eff = Object.fromEntries((await h.adminQuery(w.db.url, 'SELECT event_id, count(*)::int AS n FROM effect GROUP BY 1')).map((r) => [r.event_id, r.n]));
    const all = conc.flat();
    return {
      sequential: { events: seq.length, deliveriesEach: [...new Set(seq.map((id) => w.deliveries.get(id)))], effectsEach: [...new Set(seq.map((id) => eff[id]))] },
      concurrent: { iterations: 20, events: all.length, physicalDeliveries: all.reduce((a, id) => a + w.deliveries.get(id), 0), effectsEach: [...new Set(all.map((id) => eff[id] ?? 0))] },
      accounting: acc,
    };
  } finally {
    await direct.close().catch(() => undefined);
    await w.close();
  }
};

C.crashWindows = async () => {
  // SIGKILL of a consumer process at three points (A before the transaction, B inside it, C after COMMIT before the ack), 20 times each.
  const w = await kitWorld({ subscribe: false });
  // Declare the queue once (a consumer attaches and leaves) so published events wait in it for the child.
  const decl = new RabbitMqEventBus({ url: rabbit.url, exchange: w.exchange });
  await (await decl.subscribe({ queue: w.queue, bindings: ['validation.#'], handler: async () => undefined })).close();
  await decl.close();
  const child = (window) => {
    const p = spawn(process.execPath, [`${h.root}scripts/validation/lib/crash-consumer.mjs`], {
      env: { PATH: process.env.PATH, DATABASE_URL: w.db.url, RABBITMQ_URL: rabbit.url, EXCHANGE: w.exchange, QUEUE: w.queue, ...(window ? { CRASH_WINDOW: window } : {}) },
    });
    const lines = [];
    p.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
    const exited = new Promise((r) => p.on('exit', (code, signal) => r({ code, signal })));
    return { p, lines, exited, ready: () => h.waitFor(() => lines.includes('ready'), 15_000, 20) };
  };
  const out = {};
  try {
    for (const window of ['A', 'B', 'C']) {
      const rows = [];
      for (let i = 0; i < 20; i++) {
        const id = randomUUID();
        w.ids.push(id);
        const crasher = child(window);
        await crasher.ready();
        await w.pub.publish({ id, name: 'validation.happened', payload: { id }, headers: envelopeHeaders(id, 'validation.happened') });
        const how = await Promise.race([crasher.exited, h.sleep(15_000).then(() => ({ signal: 'did not crash' }))]);
        const [{ n: effectsAfterCrash }] = await h.adminQuery(w.db.url, 'SELECT count(*)::int AS n FROM effect WHERE event_id = $1', [id]);
        const [{ n: inboxAfterCrash }] = await h.adminQuery(w.db.url, 'SELECT count(*)::int AS n FROM inbox WHERE "eventId" = $1', [id]);
        const normal = child(undefined);
        await normal.ready();
        await h.waitFor(() => normal.lines.includes(`delivery ${id}`), 15_000, 20); // the broker redelivers the unacknowledged message
        await h.sleep(300);
        normal.p.kill('SIGTERM');
        await normal.exited;
        const [{ n: effects }] = await h.adminQuery(w.db.url, 'SELECT count(*)::int AS n FROM effect WHERE event_id = $1', [id]);
        rows.push({ crashedBy: how.signal, effectsAfterCrash, inboxAfterCrash, redelivered: normal.lines.includes(`delivery ${id}`), effects });
      }
      out[window] = {
        iterations: 20, allKilled: rows.every((r) => r.crashedBy === 'SIGKILL'), effectsAfterCrash: [...new Set(rows.map((r) => r.effectsAfterCrash))],
        redeliveredEveryTime: rows.every((r) => r.redelivered), finalEffectsEach: [...new Set(rows.map((r) => r.effects))],
      };
      log(`crashWindows ${window}: ${JSON.stringify(out[window])}`);
    }
    out.accounting = await w.account();
    return out;
  } finally {
    await w.close();
  }
};

C.prefetch = async () => {
  // One consumer, a handler that never finishes: how many deliveries does it hold, and do they return when the consumer dies?
  const proxy = new BrokerProxy({ host: '127.0.0.1', port: rabbit.port });
  await proxy.start();
  later(async () => { proxy.thaw(); await proxy.sever(); });
  const runs = [];
  for (let run = 0; run < 3; run++) {
    const exchange = `validation.x.${uniq()}`;
    const queue = `validation.q.${uniq()}`;
    const bus = new RabbitMqEventBus({ url: proxy.url, exchange });
    let started = 0;
    await bus.subscribe({ queue, bindings: ['validation.#'], handler: () => { started++; return new Promise(() => undefined); } });
    const pub = new RabbitMqEventBus({ url: rabbit.url, exchange });
    for (let i = 0; i < 25; i++) {
      const id = randomUUID();
      await pub.publish({ id, name: 'validation.held', payload: {}, headers: envelopeHeaders(id, 'validation.held') });
    }
    await h.sleep(1500);
    const held = rabbit.queues().find((q) => q.name === queue);
    await proxy.sever(); // the consumer's connection dies with 10 unacknowledged deliveries
    await h.sleep(1500);
    const afterDeath = rabbit.queues().find((q) => q.name === queue);
    runs.push({ handlerStarted: started, queueWhileHeld: held, queueAfterConsumerDied: afterDeath });
    await proxy.start();
    await pub.close();
    bus.close().catch(() => undefined);
    const c = await (await amqp.connect(rabbit.url)).createChannel();
    for (const q of [queue, `${queue}.retry`, `${queue}.dead`]) await c.deleteQueue(q).catch(() => undefined);
    await c.close();
  }
  return runs;
};

C.multiRelay = async () => {
  // Three relays on one outbox (three instances): each row is claimed by exactly one of them (FOR UPDATE SKIP LOCKED).
  const w = await kitWorld();
  const relays = Array.from({ length: 3 }, (_, i) => ({ i, relay: new OutboxRelay(new DbService({ url: w.db.url, applicationName: `validation-relay-${i}` }), w.pub, { source: 'validation' }), published: 0 }));
  try {
    await w.enqueue(500);
    const t = Date.now();
    await Promise.all(relays.map(async (r) => {
      for (;;) {
        const res = await r.relay.drainOnce();
        r.published += res.published;
        if (res.published === 0) break;
      }
    }));
    const drainMs = Date.now() - t;
    await h.waitFor(async () => (await w.account()).lost === 0, 30_000, 50);
    const acc1 = await w.account();
    // SKIP LOCKED: relay A holds a claimed batch (its broker stalls 3 s); relay B must not wait behind it.
    await w.enqueue(120);
    const slowBus = { publish: () => h.sleep(3000), subscribe: async () => ({ close: async () => undefined }), close: async () => undefined };
    const a = new OutboxRelay(new DbService({ url: w.db.url, applicationName: 'validation-relay-slow' }), slowBus, { source: 'validation', batchSize: 50 });
    const aPass = a.drainOnce();
    await h.sleep(300);
    const tB = Date.now();
    const bRes = await relays[0].relay.drainOnce();
    const bMs = Date.now() - tB;
    const lockWaits = (await h.adminQuery(ADMIN, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [w.db.name]))[0].n;
    await aPass.catch(() => undefined);
    return { rows: 500, perRelay: relays.map((r) => r.published), drainMs, accounting: acc1, skipLocked: { relayBPublishedWhileAHeldItsBatch: bRes.published, relayBPassMs: bMs, lockWaitSessions: lockWaits } };
  } finally {
    await w.close();
  }
};

C.outboxBackoff = async () => {
  // A broker that refuses every publish: the per-row delay doubles from 1 s and is capped at 60 s (defaults), and the relay does not spin.
  const failing = { publish: async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }); }, subscribe: async () => ({ close: async () => undefined }), close: async () => undefined };
  const db = await h.throwawayDatabase(ADMIN, null);
  await runMigrations(db.url, [kitMigrationsDir]);
  const dbs = new DbService({ url: db.url });
  const outbox = new OutboxService();
  try {
    const id = randomUUID();
    await dbs.tx((q) => outbox.enqueue(q, { id, name: 'validation.backoff', payload: {} }));
    const relay = new OutboxRelay(dbs, failing, { source: 'validation' });
    const delays = [];
    const cpu0 = process.cpuUsage();
    const t0 = Date.now();
    relay.start(200); // poll often: only the row's own backoff may space the attempts
    let seen = 0;
    while (delays.length < 5 && Date.now() - t0 < 60_000) {
      const [r] = await h.adminQuery(db.url, `SELECT attempts, EXTRACT(EPOCH FROM ("availableAt" - now())) * 1000 AS wait FROM outbox WHERE id = $1`, [id]);
      if (r.attempts > seen) {
        seen = r.attempts;
        delays.push({ attempt: r.attempts, nextDelayMs: Math.round(Number(r.wait)) });
      }
      await h.sleep(50);
    }
    const cpu = process.cpuUsage(cpu0);
    await relay.stop();
    // The cap, without waiting minutes: the same formula at attempt 10 (60 s cap) — set the counter, run one failing pass.
    await h.adminQuery(db.url, `UPDATE outbox SET attempts = 10, "availableAt" = now() WHERE id = $1`, [id]);
    await relay.drainOnce();
    const [capped] = await h.adminQuery(db.url, `SELECT attempts, EXTRACT(EPOCH FROM ("availableAt" - now())) * 1000 AS wait FROM outbox WHERE id = $1`, [id]);
    return { observedDelays: delays, cpuPctOverObservation: h.round(((cpu.user + cpu.system) / 1000 / (Date.now() - t0)) * 100, 2), atAttempt11NextDelayMs: Math.round(Number(capped.wait)) };
  } finally {
    await dbs.onApplicationShutdown();
    await db.drop();
  }
};

C.outboxDurabilityAcrossRestart = async () => {
  // Retry state lives in the row: a new relay process (new pool, new bus) resumes it without loss or reset.
  const db = await h.throwawayDatabase(ADMIN, null);
  await runMigrations(db.url, [kitMigrationsDir]);
  const failing = { publish: async () => { throw new Error('broker down'); }, subscribe: async () => ({ close: async () => undefined }), close: async () => undefined };
  const d1 = new DbService({ url: db.url });
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const id = randomUUID();
    await d1.tx((q) => new OutboxService().enqueue(q, { id, name: 'validation.durable', payload: { i } }));
    ids.push(id);
  }
  const r1 = new OutboxRelay(d1, failing, { source: 'validation' });
  await r1.drainOnce();
  await h.adminQuery(db.url, `UPDATE outbox SET "availableAt" = now()`);
  await r1.drainOnce();
  const before = await h.adminQuery(db.url, `SELECT id, attempts, "lastError" IS NOT NULL AS err, payload FROM outbox ORDER BY "occurredAt", id`);
  await d1.onApplicationShutdown(); // the "process" is gone
  const d2 = new DbService({ url: db.url });
  const exchange = `validation.x.${uniq()}`;
  const pub = new RabbitMqEventBus({ url: rabbit.url, exchange });
  const got = new Set();
  const cons = new RabbitMqEventBus({ url: rabbit.url, exchange });
  await cons.subscribe({ queue: `validation.q.${uniq()}`, bindings: ['validation.#'], handler: async (e) => void got.add(e.id) });
  await h.adminQuery(db.url, `UPDATE outbox SET "availableAt" = now()`);
  const r2 = new OutboxRelay(d2, pub, { source: 'validation' });
  for (let i = 0; i < 20 && got.size < ids.length; i++) {
    await r2.drainOnce();
    await h.sleep(200);
  }
  const after = await h.adminQuery(db.url, `SELECT id, attempts, "publishedAt" IS NOT NULL AS published FROM outbox`);
  await pub.close();
  await cons.close();
  await d2.onApplicationShutdown();
  await db.drop();
  return {
    rows: ids.length, attemptsBeforeRestart: [...new Set(before.map((r) => r.attempts))], errorsRecorded: before.every((r) => r.err), payloadIntact: before.every((r, i) => r.payload.i === i),
    publishedAfterRestart: after.filter((r) => r.published).length, attemptsAfter: [...new Set(after.map((r) => r.attempts))], consumedLogicalEvents: got.size,
  };
};

C.brokerRestartPersistence = async () => {
  // Durable exchange + durable queue + persistent messages: what survives a broker restart (the whole container restarted).
  const w = await kitWorld({ subscribe: false });
  const decl = new RabbitMqEventBus({ url: rabbit.url, exchange: w.exchange });
  await (await decl.subscribe({ queue: w.queue, bindings: ['validation.#'], handler: async () => undefined })).close();
  await decl.close();
  try {
    await w.enqueue(100);
    await w.drainAll(5_000).catch(() => undefined);
    for (let i = 0; i < 5; i++) await w.relay.drainOnce();
    const before = rabbit.queues().find((q) => q.name === w.queue);
    const t = Date.now();
    await rabbit.restart();
    const restartMs = Date.now() - t;
    const after = rabbit.queues().find((q) => q.name === w.queue);
    await w.makeConsumer();
    const acc = await h.waitFor(async () => { const a = await w.account(); return a.lost === 0 && a; }, 60_000, 100);
    // backlog while a consumer is attached: the consumer must reconnect by itself and finish
    w.handlerHooks.before = () => h.sleep(20);
    await w.enqueue(200);
    for (let i = 0; i < 6; i++) await w.relay.drainOnce();
    await h.sleep(500);
    const t2 = Date.now();
    await rabbit.restart();
    const reattached = await h.waitFor(() => w.buses.every((b) => b.consumerStatus().every((s) => s.state === 'consuming')) && Date.now(), 90_000, 100);
    const fin = await h.waitFor(async () => { await w.relay.drainOnce().catch(() => undefined); const a = await w.account(); return a.lost === 0 && a.pending === 0 && a; }, 120_000, 200);
    return {
      queueBeforeRestart: before, brokerRestartMs: restartMs, queueAfterRestart: after, accountingAfterConsume: acc,
      withConsumerAttached: { consumerReattachedMsAfterRestartStarted: reattached ? reattached - t2 : null, queueConsumers: rabbit.queues().find((q) => q.name === w.queue)?.consumers, accounting: fin ?? (await w.account()) },
    };
  } finally {
    await w.close();
  }
};

// ------------------------------------------------------------------------------------------------ app layer (live Payment + Billing)
async function appWorld() {
  const billingDb = await h.throwawayDatabase(ADMIN, 'billing-service');
  const paymentDb = await h.throwawayDatabase(ADMIN, 'payment-service');
  const producer = generateServiceToken();
  const billingToPayment = generateServiceToken();
  const pPort = 5100 + Math.floor(Math.random() * 400);
  const bPort = pPort + 500;
  const startPayment = () => h.launch('payment-service', h.serviceEnv('payment-service', {
    databaseUrl: paymentDb.url, brokerUrl: rabbit.url, port: pPort, extra: { NODE_ENV: 'test', SERVICE_TOKENS: `billing-service:${billingToPayment.digest}` },
  }));
  const startBilling = () => h.launch('billing-service', h.serviceEnv('billing-service', {
    databaseUrl: billingDb.url, brokerUrl: rabbit.url, port: bPort, extra: {
      NODE_ENV: 'test', SERVICE_TOKENS: `test-producer:${producer.digest}`, PAYMENT_SERVICE_URL: `http://127.0.0.1:${pPort}`, PAYMENT_SERVICE_TOKEN: billingToPayment.token,
      BILLING_DISPATCH_INTERVAL_MS: '300', BILLING_RECONCILE_INTERVAL_MS: '3600000',
      // Seeding only: the harness creates ~100 payment requests from one producer; the create rate limits are not under test here.
      BILLING_RATE_LIMIT_PAYMENT_REQUEST_CREATE_PER_MINUTE: '100000', BILLING_RATE_LIMIT_INVOICE_CREATE_PER_MINUTE: '100000',
    },
  }));
  const svc = { payment: startPayment(), billing: startBilling() };
  for (const s of Object.values(svc)) if (!(await h.waitFor(async () => (await s.status('/ready', 2000)).status === 200, 30_000, 100))) throw new Error(`${s.service} not ready`);
  const api = async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${bPort}${path}`, { method, headers: { authorization: `Bearer ${producer.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const sellerId = randomUUID();
  const product = await api('POST', '/billing/products', { seller: { type: 'organization', id: sellerId }, code: `p-${uniq()}`, name: 'Validation product' });
  const price = await api('POST', '/billing/prices', { productId: product.json.id, clientReference: `r-${uniq()}`, currency: 'TND', unitAmount: 1000, interval: 'one_time', effectiveFrom: new Date().toISOString() });
  /** N payment requests that reached `requested` (the real dispatcher called the real Payment API). */
  const requested = async (n) => {
    const ids = [];
    for (let i = 0; i < n; i++) {
      const inv = await api('POST', '/billing/invoices', {
        invoiceRequestId: randomUUID(), seller: { type: 'organization', id: sellerId }, payer: { type: 'user', id: `payer-${uniq()}` }, sourceType: 'contract', sourceId: `src-${uniq()}`,
        issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: price.json.id, quantity: 1 }],
      });
      const iss = await api('POST', `/billing/invoices/${inv.json?.id}/issue`);
      const pr = await api('POST', `/billing/invoices/${inv.json?.id}/payment-requests`);
      if (inv.status !== 201 || iss.status !== 200 || pr.status !== 201) throw new Error(`seeding failed: invoice ${inv.status} issue ${iss.status} payment-request ${pr.status}`);
      ids.push(pr.json.id);
    }
    const ok = await h.waitFor(async () => (await h.adminQuery(billingDb.url, `SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1) AND status = 'requested'`, [ids]))[0].n === n, 60_000, 200);
    if (!ok) {
      const st = await h.adminQuery(billingDb.url, `SELECT status, count(*)::int AS n FROM payment_request WHERE id = ANY($1) GROUP BY 1`, [ids]);
      const lines = [...svc.billing.lines, ...svc.payment.lines].filter((l) => l.level === 'warn' || l.level === 'error').map((l) => String(l.msg).slice(0, 160)).slice(-5);
      throw new Error(`payment requests did not reach requested: ${JSON.stringify(st)} ${JSON.stringify(lines)}`);
    }
    return ids;
  };
  const cancel = async (ids) => {
    const codes = [];
    for (const id of ids) codes.push((await api('POST', `/billing/payment-requests/${id}/cancel`)).status);
    return codes;
  };
  const account = async (ids) => {
    const [p] = await h.adminQuery(paymentDb.url, `SELECT count(*) FILTER (WHERE name = 'payment.cancelled')::int AS cancelled_events,
      count(*) FILTER (WHERE name = 'payment.cancelled' AND "publishedAt" IS NULL)::int AS cancelled_pending, count(*) FILTER (WHERE "publishedAt" IS NULL)::int AS all_pending FROM outbox`);
    const [r] = await h.adminQuery(billingDb.url, `SELECT count(*)::int AS receipts, count(DISTINCT "eventId")::int AS distinct_events FROM payment_event_receipt WHERE "paymentRequestId" = ANY($1) AND "eventName" = 'payment.cancelled'`, [ids]);
    const [s] = await h.adminQuery(billingDb.url, `SELECT count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled FROM payment_request WHERE id = ANY($1)`, [ids]);
    return { requests: ids.length, paymentCancelledOutboxRows: p.cancelled_events, paymentOutboxPending: p.all_pending, billingReceipts: r.receipts, distinctEventsReceipted: r.distinct_events, requestsCancelled: s.cancelled };
  };
  const close = async () => {
    for (const s of Object.values(svc)) await s.stop();
    await billingDb.drop();
    await paymentDb.drop();
  };
  return { svc, api, requested, cancel, account, close, billingDb, paymentDb, startPayment, startBilling };
}

C.appFlow = async () => {
  const a = await appWorld();
  const out = {};
  try {
    // Healthy baseline through the real application path.
    const base = await a.requested(20);
    let t = Date.now();
    await a.cancel(base);
    await h.waitFor(async () => (await a.account(base)).requestsCancelled === 20, 60_000, 100);
    out.baseline = { cancelToAllApplied20Ms: Date.now() - t, accounting: await a.account(base) };
    const lat = await h.adminQuery(a.paymentDb.url, `SELECT EXTRACT(EPOCH FROM ("publishedAt" - "occurredAt")) * 1000 AS ms FROM outbox WHERE name = 'payment.cancelled'`);
    out.baseline.outboxToPublishedMs = h.stats(lat.map((r) => Number(r.ms)));
    // Broker down while real cancellations happen: Payment's outbox accumulates, Billing's consumer is lost; then the broker returns.
    const down = await a.requested(30);
    const p0 = h.processSample(a.svc.payment.child.pid);
    rabbit.appStop();
    const tDown = Date.now();
    const tDownP = h.now(); // log lines carry performance.now() timestamps
    await h.sleep(1000);
    const codes = await a.cancel(down);
    const ready = {};
    for (const [k, s] of Object.entries(a.svc)) ready[k] = { ready: (await s.status('/ready', 5000)).status, health: (await s.status('/health', 5000)).status };
    await h.sleep(10_000);
    const p1 = h.processSample(a.svc.payment.child.pid);
    const mid = await a.account(down);
    const downLines = { payment: a.svc.payment.since(tDownP, (l) => l.level === 'warn' || l.level === 'error'), billing: a.svc.billing.since(tDownP, (l) => l.level === 'warn' || l.level === 'error') };
    const secs = (Date.now() - tDown) / 1000;
    t = Date.now();
    await rabbit.appStart();
    const back = Date.now();
    const drained = await h.waitFor(async () => { const x = await a.account(down); return x.requestsCancelled === 30 && x.paymentOutboxPending === 0 && Date.now(); }, 180_000, 200);
    out.brokerDown = {
      cancelHttpStatuses: [...new Set(codes)], readinessWhileDown: ready, duringOutage: mid,
      logsPerSec: Object.fromEntries(Object.entries(downLines).map(([k, ls]) => [k, { warnOrError: h.round(ls.length / secs, 2), dominant: [...new Set(ls.map((l) => String(l.msg).split(' ')[0]))].slice(0, 5) }])),
      paymentCpuPctDuringOutage: h.cpuPercent(p0, p1), paymentRssMb: [h.round(p0.rssMb), h.round(p1.rssMb)],
      brokerRestartMs: back - t, drainedAfterBrokerBackMs: drained ? drained - back : null, accounting: await a.account(down),
      billingConsumers: rabbit.queues().find((q) => q.name === 'billing.payment-events')?.consumers,
    };
    log(`appFlow brokerDown: ${JSON.stringify(out.brokerDown.accounting)} drained ${out.brokerDown.drainedAfterBrokerBackMs} ms`);
    // Service restart with a pending outbox backlog: broker down, cancellations, Payment restarted, broker back.
    const rs = await a.requested(20);
    rabbit.appStop();
    await a.cancel(rs);
    await h.sleep(2000);
    const pendingBeforeRestart = (await a.account(rs)).paymentOutboxPending;
    await a.svc.payment.stop();
    a.svc.payment = a.startPayment();
    await h.waitFor(async () => (await a.svc.payment.status('/health', 2000)).status === 200, 30_000, 100);
    const pendingAfterRestart = (await a.account(rs)).paymentOutboxPending;
    await rabbit.appStart();
    const rsDone = await h.waitFor(async () => { const x = await a.account(rs); return x.requestsCancelled === 20 && x.paymentOutboxPending === 0 && x; }, 180_000, 200);
    out.serviceRestartWithBacklog = { pendingBeforeRestart, pendingAfterRestart, accounting: rsDone ?? (await a.account(rs)) };
    // Repeated broker outages with live services: Billing must end with exactly one consumer on its queue.
    const cyc = [];
    for (let c = 0; c < 3; c++) {
      const ids = await a.requested(5);
      rabbit.appStop();
      await a.cancel(ids);
      await h.sleep(5000);
      await rabbit.appStart();
      const ok = await h.waitFor(async () => (await a.account(ids)).requestsCancelled === 5, 120_000, 200);
      await h.sleep(2000);
      cyc.push({ cycle: c, applied: Boolean(ok), accounting: await a.account(ids), billingQueueConsumers: rabbit.queues().find((q) => q.name === 'billing.payment-events')?.consumers, brokerConnections: rabbit.connections().length, brokerChannels: rabbit.channels().length });
    }
    out.appOutageCycles = cyc;
    // SIGTERM while the broker is frozen (a 15.5 observation).
    rabbit.pause();
    const tS = h.now();
    a.svc.billing.child.kill('SIGTERM');
    const ex = await Promise.race([a.svc.billing.exited, h.sleep(200_000).then(() => undefined)]);
    out.billingSigtermDuringBrokerFreeze = ex
      ? { exitedAfterMs: h.round(ex.t - tS), exit: ex.code ?? ex.signal, phases: a.svc.billing.since(tS, (l) => /shutdown|drain|rabbitmq_|_failure/.test(String(l.msg))).map((l) => `${h.round(l.t - tS)}ms ${String(l.msg).split(' —')[0]}`).slice(0, 12) }
      : { result: 'still running after 200000 ms' };
    rabbit.unpause();
    if (a.svc.billing.alive()) a.svc.billing.child.kill('SIGKILL');
    out.credentialsInLogs = [...a.svc.payment.lines, ...a.svc.billing.lines].filter((l) => /guest:guest|amqp:\/\/[^ ]*@|postgres(ql)?:\/\/[^ ]*:[^ ]*@/.test(l.raw)).length;
    return out;
  } finally {
    await a.close();
  }
};

// ------------------------------------------------------------------------------------------------ run
const order = ['baselineKit', 'brokerDownBeforePublish', 'outageCycles', 'confirmTimeout', 'lostConfirm', 'connectionCutDuringPublish', 'consumerFailures', 'duplicateDelivery', 'crashWindows', 'prefetch', 'multiRelay', 'outboxBackoff', 'outboxDurabilityAcrossRestart', 'brokerRestartPersistence', 'appFlow', 'brokerFreeze', 'brokerFreezeHeartbeatDisabled', 'billingSigtermFreeze'];
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outFile = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
const wanted = args.length ? args : order;
const report = { env: { ...(await h.environment(ADMIN)), rabbitmq: '3.13 (throwaway container)', heartbeatNegotiatedS: 60 }, started: new Date().toISOString(), results: {} };
try {
  for (const name of wanted) {
    if (!C[name]) throw new Error(`unknown campaign ${name}`);
    log(`campaign ${name} ...`);
    const t = Date.now();
    try {
      const r = await C[name]();
      report.results[name] = Array.isArray(r) ? { rows: r } : r;
    } catch (e) {
      report.results[name] = { error: describeFailure(e), message: String(e?.message).slice(0, 300) };
      log(`campaign ${name} ERROR ${String(e?.message).slice(0, 200)}`);
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
report.finished = new Date().toISOString();
if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
else console.log(JSON.stringify(report, null, 2));
process.exit(0);
