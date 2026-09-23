#!/usr/bin/env node
// Stage 15.3 I9 investigation (test-only): how the INSTALLED amqplib behaves when an established broker connection goes silent.
//   node scripts/validation/amqp-semantics.mjs [--out results.json]
// Uses its own throwaway RabbitMQ configured with `heartbeat = 0` (the broker proposes none), freezes it with `docker pause`, and for
// each channel-level operation measures how it ends: (1) with no client heartbeat (what the kit did), (2) with a client-requested
// heartbeat (`?heartbeat=N`), (3) with a promise deadline that destroys the socket. It also checks what late frames do after teardown.
import { writeFileSync } from 'node:fs';
import amqp from 'amqplib';
import * as h from './lib/harness.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('refusing to run with NODE_ENV=production');
const log = (...a) => process.stderr.write(`[amqp] ${a.join(' ')}\n`);
let uncaught = [];
process.on('uncaughtException', (e) => {
  uncaught.push(`${e?.name}: ${String(e?.message).slice(0, 100)}`);
  log('UNCAUGHT', e?.stack?.split('\n').slice(0, 3).join(' | '));
});
process.on('unhandledRejection', (e) => {
  uncaught.push(`unhandled ${e?.name}: ${String(e?.message).slice(0, 100)}`);
  log('UNHANDLED', e?.stack?.split('\n').slice(0, 3).join(' | '));
});

const rabbit = await h.throwawayRabbit({ heartbeatS: 0 });
const CAP = 20_000;
const HB = 2; // seconds: short, test-only
const withHb = (url, s) => {
  const u = new URL(url);
  u.searchParams.set('heartbeat', String(s));
  return u.toString();
};
const outcome = async (p, cap = CAP) => {
  const t = Date.now();
  const r = await Promise.race([p.then(() => 'resolved', (e) => `rejected: ${e?.message?.slice(0, 60)}`), h.sleep(cap).then(() => undefined)]);
  return r ? { result: r, ms: Date.now() - t } : { result: `pending after ${cap} ms` };
};

// Each operation gets its own connection (and whatever channel/queue state it needs) before the freeze.
const OPS = {
  createChannel: async (c) => () => c.createChannel(),
  createConfirmChannelAndDeclare: async (c) => async () => {
    const ch = await c.createConfirmChannel();
    await ch.assertExchange(`validation.sem.${Math.random().toString(16).slice(2)}`, 'topic', { durable: true });
  },
  assertQueue: async (c) => {
    const ch = await c.createChannel();
    ch.on('error', () => undefined);
    return () => ch.assertQueue(`validation.sem.q.${Math.random().toString(16).slice(2)}`, { durable: false, autoDelete: true });
  },
  consume: async (c) => {
    const ch = await c.createChannel();
    ch.on('error', () => undefined);
    const q = (await ch.assertQueue('', { exclusive: true })).queue;
    return () => ch.consume(q, () => undefined);
  },
  cancel: async (c) => {
    const ch = await c.createChannel();
    ch.on('error', () => undefined);
    const q = (await ch.assertQueue('', { exclusive: true })).queue;
    const { consumerTag } = await ch.consume(q, () => undefined);
    return () => ch.cancel(consumerTag);
  },
  channelClose: async (c) => {
    const ch = await c.createChannel();
    ch.on('error', () => undefined);
    return () => ch.close();
  },
  connectionClose: async (c) => () => c.close(),
};

async function trial(mode, opName) {
  const url = mode === 'noClientHeartbeat' ? rabbit.url : withHb(rabbit.url, HB);
  const c = await amqp.connect(url);
  const events = [];
  c.on('error', (e) => events.push(`error:${e.message}`));
  c.on('close', () => events.push('close'));
  const negotiated = c.connection.heartbeat;
  const op = await OPS[opName](c);
  rabbit.pause();
  let res;
  try {
    if (mode === 'deadlineDestroy') {
      const t = Date.now();
      const p = op();
      const r = await Promise.race([p.then(() => 'resolved', (e) => `rejected: ${e?.message?.slice(0, 60)}`), h.sleep(1500).then(() => undefined)]);
      if (r) res = { result: r, ms: Date.now() - t };
      else {
        c.connection.stream.destroy(); // the transport, not a protocol close (which would itself wait for the silent broker)
        const after = await outcome(p, 5000);
        res = { result: `deadline 1500 ms, socket destroyed -> ${after.result}`, ms: Date.now() - t };
      }
    } else {
      res = await outcome(op());
    }
  } finally {
    rabbit.unpause();
  }
  await h.sleep(1500); // late frames from the unfrozen broker reach a torn-down connection
  const reusable = await outcome(c.createChannel().then((ch) => ch.close()), 3000);
  try {
    await c.close();
  } catch {
    /* already closed */
  }
  return { negotiatedHeartbeatS: negotiated, ...res, events, reuseAfterUnfreeze: reusable.result };
}

const report = { env: { brokerHeartbeatConfig: 0, clientHeartbeatS: HB }, results: {} };
try {
  report.env.amqplib = JSON.parse((await import('node:fs')).readFileSync(`${h.root}node_modules/amqplib/package.json`, 'utf8')).version;
  for (const mode of ['noClientHeartbeat', 'clientHeartbeat', 'deadlineDestroy']) {
    report.results[mode] = {};
    for (const op of Object.keys(OPS)) {
      const before = uncaught.length;
      report.results[mode][op] = { ...(await trial(mode, op)), uncaughtDuringTrial: uncaught.slice(before) };
      log(mode, op, JSON.stringify(report.results[mode][op]));
    }
  }
  // Negotiation: client request vs broker proposal (a broker with the default 60 s).
  const r60 = await h.throwawayRabbit();
  try {
    const n = {};
    for (const s of [undefined, 0, 5, 10, 120]) {
      const c = await amqp.connect(s === undefined ? r60.url : withHb(r60.url, s));
      n[s === undefined ? 'none' : String(s)] = c.connection.heartbeat;
      await c.close();
    }
    const c0 = await amqp.connect(withHb(rabbit.url, 10));
    report.negotiation = { brokerDefault60: n, broker0Client10: c0.connection.heartbeat };
    await c0.close();
  } finally {
    r60.stop();
  }
} finally {
  try { rabbit.unpause(); } catch { /* not paused */ }
  rabbit.stop();
}
report.uncaught = uncaught;
const outAt = process.argv.indexOf('--out');
const text = JSON.stringify(report, null, 2) + '\n';
if (outAt > 0) writeFileSync(process.argv[outAt + 1], text);
else process.stdout.write(text);
process.exit(0);
