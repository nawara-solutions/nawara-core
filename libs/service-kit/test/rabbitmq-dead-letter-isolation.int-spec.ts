import { randomBytes, randomUUID } from 'node:crypto';
import amqp, { type ChannelModel } from 'amqplib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PermanentEventFailure, RabbitMqEventBus, type EventEnvelope, type EventSubscription } from '../src/index.js';
import { describeWithEnv } from './support/env.js';

/**
 * V2 A3M.4, finding G7 (ADR-0057 §8, A3M record §7): every `<queue>.dead` is bound to ONE fanout exchange, `<exchange>.dlx`, and every
 * work queue dead-letters into it. Before A3M.4, when a consumer WITHOUT a dead-letter policy could not get its annotated copy
 * confirmed, the bus nacked the original without requeue and the broker dead-lettered it through that fanout: reproduced locally, the
 * raw original reached another consumer's (redacting) dead-letter queue and left its own consumer. The bus now holds and requeues it
 * (R1). These tests are the regression guard for the SAFE behaviour: a failed delivery stays with its own consumer, and no other
 * consumer's dead-letter queue ever receives it. The fault is the Stage 18.9 technique: a management policy (`max-length: 0`,
 * `reject-publish`) on the consumer's own `.dead` queue, in force once the broker refuses a probe.
 */
const uniq = () => randomBytes(4).toString('hex');
const SECRET = 'S3cretCardNumber-4111';
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const envelope = (marker: string): EventEnvelope => {
  const id = randomUUID();
  return { id, name: 'payment.cancelled', payload: { paymentRequestId: randomUUID(), cardNote: SECRET, marker }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } };
};

interface Seen {
  messageId: unknown;
  bodyHasSecret: boolean;
  bodyHasMarker: boolean;
  bodyRedacted: boolean;
  consumerHeader: unknown;
  failureHeader: unknown;
  deathQueue: unknown;
  deathReason: unknown;
}

describeWithEnv('G7: a failed delivery stays with its own consumer (real broker, management API)', ['TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
  const exchange = `nawara.events.g7${uniq()}`;
  const dlx = `${exchange}.dlx`;
  const vhostPath = new URL(env.TEST_RABBITMQ_URL).pathname.slice(1);
  const vhost = encodeURIComponent(vhostPath === '' ? '/' : decodeURIComponent(vhostPath));
  const queues: string[] = [];
  const policies: string[] = [];
  let conn: ChannelModel;
  const messageIdMarker = new Map<string, string>();

  const mgmt = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const u = new URL(env.TEST_RABBITMQ_MGMT_URL);
    const r = await fetch(`${u.origin}/api${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`, 'content-type': 'application/json' },
    });
    if (!r.ok && r.status !== 404) throw new Error(`management ${method} ${path}: ${r.status}`);
    return method === 'GET' && r.ok ? r.json() : undefined;
  };
  const depth = async (q: string): Promise<number> => {
    const ch = await conn.createChannel();
    ch.on('error', () => undefined);
    try {
      return (await ch.checkQueue(q)).messageCount;
    } finally {
      await ch.close().catch(() => undefined);
    }
  };
  /** Reads (and removes) every message of `q` for up to `ms`, returning what was seen of the one with `messageId`. Never consumes `q`. */
  const take = async (q: string, messageId: string, ms: number): Promise<{ match?: Seen; others: number }> => {
    const ch = await conn.createChannel();
    ch.on('error', () => undefined);
    let others = 0;
    try {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const msg = await ch.get(q, { noAck: false });
        if (msg === false) {
          await sleep(50);
          continue;
        }
        ch.ack(msg);
        if (msg.properties.messageId !== messageId) {
          others++;
          continue;
        }
        const h = (msg.properties.headers ?? {}) as Record<string, unknown>;
        const death = Array.isArray(h['x-death']) ? (h['x-death'][0] as Record<string, unknown>) : undefined;
        const text = msg.content.toString('utf8');
        return {
          match: {
            messageId: msg.properties.messageId,
            bodyHasSecret: text.includes(SECRET),
            bodyHasMarker: text.includes(messageIdMarker.get(messageId) ?? '\u0000'),
            bodyRedacted: h['x-nawara-body-redacted'] === 'true',
            consumerHeader: h['x-nawara-consumer'],
            failureHeader: h['x-nawara-failure'],
            deathQueue: death?.queue,
            deathReason: death?.reason,
          },
          others,
        };
      }
      return { others };
    } finally {
      await ch.close().catch(() => undefined);
    }
  };
  /** A policy refusing every publish to `q`, in force only once the BROKER refuses a probe (Stage 18.10: never trust sampled stats). */
  const refuseDeadLetters = async (q: string): Promise<string> => {
    const name = `g7-reject-${uniq()}`;
    policies.push(name);
    await mgmt('PUT', `/policies/${vhost}/${name}`, { pattern: `^${q.replace(/\./g, '\\.')}$`, definition: { 'max-length': 0, overflow: 'reject-publish' }, 'apply-to': 'queues', priority: 100 });
    for (let i = 0; ; i++) {
      const probe = await conn.createConfirmChannel();
      probe.on('error', () => undefined);
      const refused = await (async () => {
        try {
          probe.sendToQueue(q, Buffer.from('{}'));
          await probe.waitForConfirms();
          await probe.purgeQueue(q);
          return false;
        } catch {
          return true;
        } finally {
          await probe.close().catch(() => undefined);
        }
      })();
      if (refused) return name;
      if (i > 300) throw new Error('the broker never refused publishes to the dead-letter queue');
      await sleep(100);
    }
  };

  /** Consumer A (the failing one) and bystander B (Audit-like: redacting dead-letter policy, binds nothing A's traffic matches). */
  const pair = async (opts: { aPolicy: boolean }) => {
    const id = uniq();
    const a = `q.g7a.${id}`;
    const b = `q.g7b.${id}`;
    queues.push(a, b);
    const notices: string[] = [];
    let bCalls = 0;
    const busA = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange, retry: { maxRetries: 0, delayMs: 300 }, onNotice: (m) => notices.push(m) });
    const busB = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange, retry: { maxRetries: 0, delayMs: 300 } });
    const publisher = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange });
    const subA: EventSubscription = {
      queue: a, bindings: ['payment.#'], handler: async () => { throw new PermanentEventFailure('g7_test'); },
      ...(opts.aPolicy ? { deadLetterPolicy: () => ({ body: 'redacted' as const, headers: {} }) } : {}),
    };
    const handleA = await busA.subscribe(subA);
    const handleB = await busB.subscribe({
      queue: b, bindings: ['g7none.#'], handler: async () => { bCalls++; },
      deadLetterPolicy: () => ({ body: 'redacted', headers: {} }),
    });
    const close = async () => {
      await handleA.close().catch(() => undefined);
      await handleB.close().catch(() => undefined);
      for (const bus of [busA, busB, publisher]) await bus.close().catch(() => undefined);
    };
    return { a, b, notices, bCalls: () => bCalls, publisher, closeA: () => handleA.close(), close };
  };
  const publishMarked = async (publisher: RabbitMqEventBus): Promise<EventEnvelope> => {
    const marker = `g7-marker-${randomUUID()}`;
    const ev = envelope(marker);
    messageIdMarker.set(ev.id, marker);
    await publisher.publish(ev);
    return ev;
  };

  beforeAll(async () => {
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
  });
  afterAll(async () => {
    for (const p of policies) await mgmt('DELETE', `/policies/${vhost}/${p}`).catch(() => undefined);
    const ch = await conn.createChannel();
    ch.on('error', () => undefined);
    for (const q of queues) for (const name of [q, `${q}.retry`, `${q}.dead`]) await ch.deleteQueue(name).catch(() => undefined);
    await ch.deleteExchange(exchange).catch(() => undefined);
    await ch.deleteExchange(dlx).catch(() => undefined);
    await ch.close().catch(() => undefined);
    await conn.close().catch(() => undefined);
  });

  it('1. a consumer without a policy whose dead-letter copy is refused keeps the message; no other consumer dead-letter queue receives it', async () => {
    const p = await pair({ aPolicy: false });
    let policy: string | undefined;
    try {
      // The premise: both dead-letter queues are bound to the one fanout dead-letter exchange.
      const bindings = (await mgmt('GET', `/exchanges/${vhost}/${encodeURIComponent(dlx)}/bindings/source`)) as Array<{ destination: string }>;
      expect(bindings.map((x) => x.destination).sort()).toEqual([`${p.a}.dead`, `${p.b}.dead`].sort());
      expect(await depth(`${p.a}.dead`)).toBe(0);
      expect(await depth(`${p.b}.dead`)).toBe(0);

      policy = await refuseDeadLetters(`${p.a}.dead`);
      const ev = await publishMarked(p.publisher);
      const mine = (n: string) => n.includes(`event=${ev.id}`);
      await waitFor(() => p.notices.some((n) => mine(n) && (n.includes('annotated=false') || n.startsWith('event_dead_letter_deferred'))));
      const unannotated = p.notices.filter((n) => mine(n) && n.includes('annotated=false')).length;
      if (unannotated === 0) await waitFor(() => p.notices.filter((n) => mine(n) && n.startsWith('event_dead_letter_deferred')).length >= 2);
      const deferrals = p.notices.filter((n) => mine(n) && n.startsWith('event_dead_letter_deferred')).length;

      const inB = await take(`${p.b}.dead`, ev.id, 3000);
      await p.closeA();
      const evidence = {
        unannotatedNotices: unannotated,
        deferralNotices: deferrals,
        bystanderDeadLetter: inB.match ?? null,
        bystanderOtherMessages: inB.others,
        bystanderHandlerCalls: p.bCalls(),
        ownWorkQueueDepthAfterClose: await depth(p.a),
        ownDeadQueueDepth: await depth(`${p.a}.dead`),
      };
      console.log(`G7_EVIDENCE ${JSON.stringify(evidence)}`);

      expect(inB.match, 'G7: the original reached the bystander dead-letter queue').toBeUndefined();
      expect(p.bCalls()).toBe(0);
      expect(evidence.ownWorkQueueDepthAfterClose, 'the failed delivery must stay with its own consumer').toBe(1);
    } finally {
      if (policy) await mgmt('DELETE', `/policies/${vhost}/${policy}`).catch(() => undefined);
      await p.close();
    }
  }, 60_000);

  it('2. without a fault, the annotated copy goes to the consumer\'s own dead-letter queue and nowhere else', async () => {
    const p = await pair({ aPolicy: false });
    try {
      const ev = await publishMarked(p.publisher);
      const mine = (n: string) => n.includes(`event=${ev.id}`);
      await waitFor(() => p.notices.some((n) => mine(n) && n.startsWith('event_dead_lettered')));
      expect(p.notices.some((n) => mine(n) && n.includes('annotated=false'))).toBe(false);
      const inA = await take(`${p.a}.dead`, ev.id, 3000);
      const inB = await take(`${p.b}.dead`, ev.id, 1000);
      console.log(`G7_NORMAL_PATH ${JSON.stringify({ own: inA.match ?? null, bystander: inB.match ?? null })}`);
      expect(inA.match).toMatchObject({ consumerHeader: p.a, failureHeader: 'permanent', bodyHasMarker: true });
      expect(inB.match).toBeUndefined();
      expect(p.bCalls()).toBe(0);
    } finally {
      await p.close();
    }
  }, 60_000);

  it('3. control: a consumer WITH a policy under the same fault defers and keeps the message; no other dead-letter queue receives it', async () => {
    const p = await pair({ aPolicy: true });
    let policy: string | undefined;
    try {
      policy = await refuseDeadLetters(`${p.a}.dead`);
      const ev = await publishMarked(p.publisher);
      const mine = (n: string) => n.includes(`event=${ev.id}`);
      await waitFor(() => p.notices.filter((n) => mine(n) && n.startsWith('event_dead_letter_deferred')).length >= 2);
      expect(p.notices.some((n) => mine(n) && n.includes('annotated=false'))).toBe(false);
      const inB = await take(`${p.b}.dead`, ev.id, 1500);
      await p.closeA();
      const evidence = { deferralNotices: p.notices.filter((n) => mine(n) && n.startsWith('event_dead_letter_deferred')).length, bystander: inB.match ?? null, ownWorkQueueDepthAfterClose: await depth(p.a), ownDeadQueueDepth: await depth(`${p.a}.dead`) };
      console.log(`G7_POLICY_CONTROL ${JSON.stringify(evidence)}`);
      expect(inB.match).toBeUndefined();
      expect(p.bCalls()).toBe(0);
      expect(evidence.ownWorkQueueDepthAfterClose).toBe(1);
      expect(evidence.ownDeadQueueDepth).toBe(0);
    } finally {
      if (policy) await mgmt('DELETE', `/policies/${vhost}/${policy}`).catch(() => undefined);
      await p.close();
    }
  }, 60_000);
});
