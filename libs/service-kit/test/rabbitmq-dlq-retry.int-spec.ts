import { randomBytes, randomUUID } from 'node:crypto';
import amqp, { type ChannelModel } from 'amqplib';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { formatDeadLetter } from '../src/events/dlq-tools.js';
import { PermanentEventFailure, RabbitMqEventBus, inspectDeadLetters, replayDeadLetter, type EventEnvelope } from '../src/index.js';
import { requireDeadQueue } from '../src/events/dlq-tools.js';
import { describeWithEnv } from './support/env.js';

const uniq = () => randomBytes(4).toString('hex');
const CORRELATION = 'corr-m07-abcdef';
const SECRET = 'S3cretCardNumber-4111';
const envelope = (name = 'payment.cancelled'): EventEnvelope => {
  const id = randomUUID();
  return { id, name, payload: { paymentRequestId: randomUUID(), cardNote: SECRET, code: '482913' }, headers: { eventId: id, occurredAt: new Date().toISOString(), correlationId: CORRELATION, source: 'payment-service', version: 1 } };
};
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeWithEnv('RabbitMQ retry, dead-letter annotations and replay (real broker)', ['TEST_RABBITMQ_URL'], (env) => {
  const exchange = `nawara.events.m07${uniq()}`;
  const buses: RabbitMqEventBus[] = [];
  let conn: ChannelModel;
  let publisher: RabbitMqEventBus;
  let notices: string[];
  const queues: string[] = [];

  /** A consumer bus with a short retry delay so the suite is fast; the topology and code path are the production ones. */
  const consumerBus = (retry: { maxRetries?: number; delayMs?: number } = { maxRetries: 2, delayMs: 60 }) => {
    const b = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange, retry, onNotice: (m) => notices.push(m) });
    buses.push(b);
    return b;
  };
  const newQueue = () => {
    const q = `q.m07.${uniq()}`;
    queues.push(q);
    return q;
  };
  const depth = async (queue: string): Promise<number> => {
    const ch = await conn.createChannel();
    ch.on('error', () => undefined);
    try {
      return (await ch.checkQueue(queue)).messageCount;
    } catch {
      return 0;
    } finally {
      await ch.close().catch(() => undefined);
    }
  };

  beforeAll(async () => {
    publisher = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange });
    buses.push(publisher);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
  });
  afterEach(async () => {
    for (const b of buses) if (b !== publisher) await b.close();
    buses.length = 1;
  });
  afterAll(async () => {
    await publisher.close();
    const ch = await conn.createChannel();
    for (const q of queues) for (const name of [q, `${q}.retry`, `${q}.dead`]) await ch.deleteQueue(name).catch(() => undefined);
    await ch.deleteExchange(exchange).catch(() => undefined);
    await ch.deleteExchange(`${exchange}.dlx`).catch(() => undefined);
    await conn.close();
  });
  const fresh = () => {
    notices = [];
  };

  it('retries a transient failure, keeping the event id, correlation id and payload, and succeeds without touching the DLQ', async () => {
    fresh();
    const queue = newQueue();
    const seen: EventEnvelope[] = [];
    const sub = await consumerBus().subscribe({
      queue, bindings: ['payment.#'],
      handler: async (e) => {
        seen.push(e);
        if (seen.length < 3) throw new Error('database connection terminated');
      },
    });
    const ev = envelope();
    await publisher.publish(ev);
    await waitFor(() => seen.length === 3);
    await sleep(300);
    expect(seen).toHaveLength(3); // no fourth delivery
    expect(seen.map((e) => e.id)).toEqual([ev.id, ev.id, ev.id]);
    expect(seen.map((e) => e.headers.correlationId)).toEqual([CORRELATION, CORRELATION, CORRELATION]);
    expect(seen.map((e) => e.headers.retryCount)).toEqual([undefined, 1, 2]);
    expect(seen.every((e) => JSON.stringify(e.payload) === JSON.stringify(ev.payload))).toBe(true);
    expect(await depth(`${queue}.dead`)).toBe(0);
    expect(await depth(`${queue}.retry`)).toBe(0);
    expect(notices.filter((n) => n.startsWith('event_retry_scheduled'))).toHaveLength(2);
    await sub.close();
  });

  it('bounds the retries: after maxRetries it stops and dead-letters with an annotated, otherwise unchanged copy', async () => {
    fresh();
    const queue = newQueue();
    let calls = 0;
    const sub = await consumerBus().subscribe({ queue, bindings: ['payment.#'], handler: async () => { calls++; throw new TypeError(`could not save ${SECRET}`); } });
    const ev = envelope();
    await publisher.publish(ev);
    await waitFor(async () => (await depth(`${queue}.dead`)) === 1);
    await sleep(400);
    expect(calls).toBe(3); // the first attempt plus two retries, and no more
    expect(await depth(queue)).toBe(0);
    expect(await depth(`${queue}.retry`)).toBe(0);

    const { depth: d, messages } = await inspectDeadLetters(conn, `${queue}.dead`, { fields: ['paymentRequestId'] });
    expect(d).toBe(1);
    expect(messages[0]).toMatchObject({ eventId: ev.id, eventName: ev.name, correlationId: CORRELATION, failure: 'retries_exhausted', failureError: 'TypeError', retryCount: 2, replayCount: 0 });
    expect(messages[0]!.failedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(messages[0]!.fields).toEqual({ paymentRequestId: ev.payload.paymentRequestId });
    // Stage 21.C.2 (ADR-0052 decision 5): a field whose name marks a secret is shown as `redacted`, even when asked for by name.
    const { messages: asked } = await inspectDeadLetters(conn, `${queue}.dead`, { fields: ['paymentRequestId', 'cardNote', 'code', 'secretKey', 'accessToken'] });
    expect(asked[0]!.fields.paymentRequestId).toBe(ev.payload.paymentRequestId);
    expect(asked[0]!.fields.cardNote).toBe(SECRET); // not secret-named: shown as before (fields are opt-in, by name)
    expect(asked[0]!.fields.code).toBe('redacted');
    expect(formatDeadLetter(asked[0]!)).not.toContain('482913');

    expect(notices.filter((n) => n.startsWith('event_retry_scheduled'))).toHaveLength(2);
    expect(notices.some((n) => n.startsWith('event_retry_exhausted') && n.includes(`event=${ev.id}`) && n.includes(`correlationId=${CORRELATION}`))).toBe(true);
    expect(notices.some((n) => n.startsWith('event_dead_lettered') && n.includes('classification=retries_exhausted') && n.includes('retries=2'))).toBe(true);
    expect(notices.join('\n')).not.toContain(SECRET); // error MESSAGES and payloads never reach a notice
    await sub.close();
  });

  it('dead-letters a permanent failure at once, without any retry', async () => {
    fresh();
    const queue = newQueue();
    let calls = 0;
    const sub = await consumerBus().subscribe({ queue, bindings: ['payment.#'], handler: async () => { calls++; throw new PermanentEventFailure('invalid_identifier'); } });
    const ev = envelope();
    await publisher.publish(ev);
    await waitFor(async () => (await depth(`${queue}.dead`)) === 1);
    await sleep(300);
    expect(calls).toBe(1);
    const { messages } = await inspectDeadLetters(conn, `${queue}.dead`);
    expect(messages[0]).toMatchObject({ eventId: ev.id, failure: 'permanent', failureReason: 'invalid_identifier', retryCount: 0 });
    expect(notices.some((n) => n.startsWith('event_retry_scheduled'))).toBe(false);
    await sub.close();
  });

  it('dead-letters an envelope that is not an event (bad JSON, no id) without calling the handler, and keeps the body', async () => {
    fresh();
    const queue = newQueue();
    let calls = 0;
    const sub = await consumerBus().subscribe({ queue, bindings: ['payment.#'], handler: async () => { calls++; } });
    const ch = await conn.createChannel();
    ch.publish(exchange, 'payment.cancelled', Buffer.from('{not json'), { messageId: randomUUID(), type: 'payment.cancelled', persistent: true });
    ch.publish(exchange, 'payment.cancelled', Buffer.from('{"a":1}'), { persistent: true }); // no message id, no type
    await waitFor(async () => (await depth(`${queue}.dead`)) === 2);
    expect(calls).toBe(0);
    const { messages } = await inspectDeadLetters(conn, `${queue}.dead`);
    expect(messages.map((m) => m.failure)).toEqual(['malformed', 'malformed']);
    expect(messages.map((m) => m.failureReason)).toEqual(['malformed_envelope', 'malformed_envelope']);
    await ch.close();
    await sub.close();
  });

  it('maxRetries 0 dead-letters on the first failure', async () => {
    fresh();
    const queue = newQueue();
    let calls = 0;
    const sub = await consumerBus({ maxRetries: 0 }).subscribe({ queue, bindings: ['payment.#'], handler: async () => { calls++; throw new Error('boom'); } });
    await publisher.publish(envelope());
    await waitFor(async () => (await depth(`${queue}.dead`)) === 1);
    expect(calls).toBe(1);
    await sub.close();
  });

  it('inspection never consumes: depth and contents are unchanged, and only the requested payload fields are shown', async () => {
    fresh();
    const queue = newQueue();
    const sub = await consumerBus({ maxRetries: 0 }).subscribe({ queue, bindings: ['payment.#'], handler: async () => { throw new PermanentEventFailure('malformed_payload'); } });
    const [a, b] = [envelope(), envelope()];
    await publisher.publish(a);
    await publisher.publish(b);
    await waitFor(async () => (await depth(`${queue}.dead`)) === 2);
    const first = await inspectDeadLetters(conn, `${queue}.dead`);
    const second = await inspectDeadLetters(conn, `${queue}.dead`, { limit: 1 });
    expect(first.depth).toBe(2);
    expect(first.messages.map((m) => m.eventId).sort((x, y) => x!.localeCompare(y!))).toEqual([a.id, b.id].sort((x, y) => x.localeCompare(y)));
    expect(second.messages).toHaveLength(1);
    expect(await depth(`${queue}.dead`)).toBe(2);
    expect(JSON.stringify(first)).not.toContain(SECRET); // payload fields are opt-in, by name
    expect((await inspectDeadLetters(conn, `${queue}.nothing.dead`)).depth).toBeNull(); // never declared: nothing dead-lettered yet
    await sub.close();
  });

  it('replays one dead-lettered message through the normal consumer: same id, payload and correlation id; a second replay finds nothing', async () => {
    fresh();
    const queue = newQueue();
    let healthy = false;
    const seen: EventEnvelope[] = [];
    const sub = await consumerBus({ maxRetries: 0 }).subscribe({
      queue, bindings: ['payment.#'],
      handler: async (e) => {
        seen.push(e);
        if (!healthy) throw new Error('dependency down');
      },
    });
    const ev = envelope();
    await publisher.publish(ev);
    await waitFor(async () => (await depth(`${queue}.dead`)) === 1);
    healthy = true;

    const result = await replayDeadLetter(conn, `${queue}.dead`, ev.id, { waitMs: 5000, pollMs: 50 });
    expect(result).toMatchObject({ outcome: 'consumed', eventId: ev.id, target: queue, replayCount: 1 });
    const replayed = seen[seen.length - 1]!;
    expect(replayed.id).toBe(ev.id);
    expect(replayed.headers.correlationId).toBe(CORRELATION);
    expect(replayed.headers.replayCount).toBe(1);
    expect(replayed.payload).toEqual(ev.payload); // byte-for-byte the same payload
    expect(await depth(`${queue}.dead`)).toBe(0);

    const again = await replayDeadLetter(conn, `${queue}.dead`, ev.id, { waitMs: 500 });
    expect(again.outcome).toBe('not_found');
    expect(seen).toHaveLength(2); // nothing was delivered by the second replay
    await sub.close();
  });

  it('a replay the consumer rejects again lands back in the DLQ, annotated, and can be replayed again', async () => {
    fresh();
    const queue = newQueue();
    const sub = await consumerBus({ maxRetries: 0 }).subscribe({ queue, bindings: ['payment.#'], handler: async () => { throw new PermanentEventFailure('malformed_payload'); } });
    const ev = envelope();
    await publisher.publish(ev);
    await waitFor(async () => (await depth(`${queue}.dead`)) === 1);

    const first = await replayDeadLetter(conn, `${queue}.dead`, ev.id, { waitMs: 5000, pollMs: 50 });
    expect(first).toMatchObject({ outcome: 'rejected_again', replayCount: 1 });
    const after = await inspectDeadLetters(conn, `${queue}.dead`);
    expect(after.depth).toBe(1); // still recoverable
    expect(after.messages[0]).toMatchObject({ eventId: ev.id, correlationId: CORRELATION, failure: 'permanent', replayCount: 1, retryCount: 0 });

    const second = await replayDeadLetter(conn, `${queue}.dead`, ev.id, { waitMs: 5000, pollMs: 50 });
    expect(second).toMatchObject({ outcome: 'rejected_again', replayCount: 2 });
    expect((await inspectDeadLetters(conn, `${queue}.dead`)).messages[0]!.replayCount).toBe(2);
    await sub.close();
  });

  it('replays only the message asked for and leaves the others in place', async () => {
    fresh();
    const queue = newQueue();
    let healthy = false;
    const sub = await consumerBus({ maxRetries: 0 }).subscribe({ queue, bindings: ['payment.#'], handler: async () => { if (!healthy) throw new Error('down'); } });
    const [a, b, c] = [envelope(), envelope(), envelope()];
    for (const e of [a, b, c]) await publisher.publish(e);
    await waitFor(async () => (await depth(`${queue}.dead`)) === 3);
    healthy = true;
    expect((await replayDeadLetter(conn, `${queue}.dead`, b.id, { waitMs: 5000, pollMs: 50 })).outcome).toBe('consumed');
    const left = (await inspectDeadLetters(conn, `${queue}.dead`)).messages.map((m) => m.eventId);
    expect(left).toHaveLength(2);
    expect(left).toEqual(expect.arrayContaining([a.id, c.id]));
    await sub.close();
  });

  it('does not lose a dead-lettered message when the DLQ was deleted while the consumer was running: the queue is re-declared first', async () => {
    fresh();
    const queue = newQueue();
    const sub = await consumerBus({ maxRetries: 0 }).subscribe({ queue, bindings: ['payment.#'], handler: async () => { throw new PermanentEventFailure('malformed_payload'); } });
    const probe = envelope();
    await publisher.publish(probe);
    await waitFor(async () => (await depth(`${queue}.dead`)) === 1);
    const ch = await conn.createChannel();
    await ch.deleteQueue(`${queue}.dead`); // an operator (or a bad deploy) removes the DLQ under a live consumer
    await ch.close();

    const lost = envelope();
    await publisher.publish(lost);
    await waitFor(async () => (await depth(`${queue}.dead`)) === 1);
    const { messages } = await inspectDeadLetters(conn, `${queue}.dead`);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ eventId: lost.id, failure: 'permanent', correlationId: CORRELATION });
    expect(notices.some((n) => n.startsWith('event_dead_lettered') && n.includes(`event=${lost.id}`) && !n.includes('annotated=false'))).toBe(true);
    await sub.close();
  });

  it('only ever targets the work queue named by the .dead queue, and refuses anything else', () => {
    expect(requireDeadQueue('billing.payment-events.dead')).toBe('billing.payment-events');
    expect(() => requireDeadQueue('billing.payment-events')).toThrow(/dead-letter queue/);
    expect(() => requireDeadQueue('.dead')).toThrow(/dead-letter queue/);
  });

  // ─────────────────────────────────────────────────────────────── Stage 18.8: an opt-in dead-letter policy (audit-service uses it)
  const takeDead = async (queue: string) => {
    const ch = await conn.createChannel();
    try {
      const m = await ch.get(`${queue}.dead`, { noAck: true });
      if (!m) throw new Error('no dead letter');
      return { content: m.content.toString('utf8'), headers: m.properties.headers ?? {}, messageId: m.properties.messageId, type: m.properties.type };
    } finally {
      await ch.close().catch(() => undefined);
    }
  };
  const failing = async () => {
    throw new PermanentEventFailure('refused_for_test');
  };

  it('Stage 18.8: a policy that says REDACTED leaves nothing of the body and only the headers it returns; the copy is marked and never replayed', async () => {
    fresh();
    const queue = newQueue();
    const sub = await consumerBus({ maxRetries: 0 }).subscribe({
      queue, bindings: ['payment.#'], handler: failing,
      deadLetterPolicy: ({ event, failure, reason }) => {
        expect([failure, reason, event?.headers.source]).toEqual(['permanent', 'refused_for_test', 'payment-service']);
        return { body: 'redacted', headers: { source: 'payment-service', note: { nested: SECRET } as never } };
      },
    });
    const e = envelope();
    await publisher.publish(e);
    await waitFor(async () => (await depth(`${queue}.dead`)) === 1);
    const listed = (await inspectDeadLetters(conn, `${queue}.dead`)).messages[0]!;
    expect(listed).toMatchObject({ eventId: e.id, bodyRedacted: true, failureReason: 'refused_for_test' });
    expect((await replayDeadLetter(conn, `${queue}.dead`, e.id, { waitMs: 500 })).outcome).toBe('not_replayable');
    const dead = await takeDead(queue);
    expect(JSON.parse(dead.content)).toEqual({ redacted: true, failure: 'permanent', reason: 'refused_for_test', bodyBytes: Buffer.byteLength(JSON.stringify(e.payload)) });
    expect(dead.headers).toMatchObject({ source: 'payment-service', 'x-nawara-body-redacted': 'true' });
    expect(Object.keys(dead.headers).filter((k) => !k.startsWith('x-nawara-'))).toEqual(['source']); // no correlation, no non-scalar header
    expect(JSON.stringify(dead)).not.toContain(SECRET);
    expect(dead.messageId).toBe(e.id);
    await sub.close();
  });

  it('Stage 18.8: a policy that says ORIGINAL keeps the body byte for byte (replayable) but only the headers it returns', async () => {
    fresh();
    const queue = newQueue();
    let ok = false;
    const sub = await consumerBus({ maxRetries: 0 }).subscribe({
      queue, bindings: ['payment.#'], handler: async () => { if (!ok) throw new PermanentEventFailure('not_yet'); },
      deadLetterPolicy: ({ event }) => ({ body: 'original', headers: { eventId: event!.id, source: event!.headers.source, occurredAt: event!.headers.occurredAt, version: 1 } }),
    });
    const e = envelope();
    await publisher.publish(e);
    await waitFor(async () => (await depth(`${queue}.dead`)) === 1);
    const [listed] = (await inspectDeadLetters(conn, `${queue}.dead`)).messages;
    expect(listed).toMatchObject({ eventId: e.id, bodyRedacted: false, correlationId: null }); // correlation not in the allow-list: dropped
    ok = true;
    expect((await replayDeadLetter(conn, `${queue}.dead`, e.id, { waitMs: 5000, pollMs: 50 })).outcome).toBe('consumed');
    await sub.close();
  });

  it('Stage 18.8: a policy that throws redacts, with no original header (fail closed)', async () => {
    fresh();
    const queue = newQueue();
    const sub = await consumerBus({ maxRetries: 0 }).subscribe({ queue, bindings: ['payment.#'], handler: failing, deadLetterPolicy: () => { throw new Error('policy bug'); } });
    await publisher.publish(envelope());
    await waitFor(async () => (await depth(`${queue}.dead`)) === 1);
    const dead = await takeDead(queue);
    expect(JSON.parse(dead.content)).toMatchObject({ redacted: true });
    expect(Object.keys(dead.headers).every((k) => k.startsWith('x-nawara-'))).toBe(true);
    expect(JSON.stringify(dead)).not.toContain(SECRET);
    await sub.close();
  });
});

/**
 * Stage 18.9 (18.8 deferred O1): the dead-letter copy of a policy-protected subscription cannot be confirmed because the BROKER refuses
 * publishes to the DLQ (a real queue policy, `max-length: 0` + `reject-publish`, set through the management API). The delivery is
 * held for the retry delay before each requeue (never a tight loop), never dead-lettered raw, and a closing consumer ends the hold at once.
 */
describeWithEnv('RabbitMQ dead-letter copy refused by the broker (real broker, management API)', ['TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
  const exchange = `nawara.events.m18${uniq()}`;
  const queue = `q.m18.${uniq()}`;
  const notices: string[] = [];
  let conn: ChannelModel;
  const mgmt = async (method: string, path: string, body?: unknown) => {
    const u = new URL(env.TEST_RABBITMQ_MGMT_URL);
    const r = await fetch(`${u.origin}/api${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Basic ${Buffer.from(`${u.username}:${u.password}`).toString('base64')}`, 'content-type': 'application/json' },
    });
    if (!r.ok && r.status !== 404) throw new Error(`management ${method} ${path}: ${r.status}`);
    return method === 'GET' && r.ok ? ((await r.json()) as Record<string, unknown>) : undefined;
  };
  const depth = async (q: string) => {
    const ch = await conn.createChannel();
    ch.on('error', () => undefined);
    try {
      return (await ch.checkQueue(q)).messageCount;
    } finally {
      await ch.close().catch(() => undefined);
    }
  };

  beforeAll(async () => {
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
  });
  afterAll(async () => {
    await mgmt('DELETE', '/policies/%2F/m18-reject');
    const ch = await conn.createChannel();
    for (const q of [queue, `${queue}.retry`, `${queue}.dead`]) await ch.deleteQueue(q).catch(() => undefined);
    await ch.close().catch(() => undefined);
    await conn.close().catch(() => undefined);
  });

  it('held for the retry delay before each requeue (bounded rate), never dead-lettered raw; close() ends the hold at once and the message stays queued', async () => {
    const bus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange, retry: { maxRetries: 0, delayMs: 500 }, onNotice: (m) => notices.push(m) });
    const publisher = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange });
    const sub = await bus.subscribe({
      queue, bindings: ['payment.#'], handler: async () => { throw new PermanentEventFailure('refused_for_test'); },
      deadLetterPolicy: () => ({ body: 'redacted', headers: {} }),
    });
    await mgmt('PUT', '/policies/%2F/m18-reject', { pattern: `^${queue.replace(/\./g, '\\.')}\\.dead$`, definition: { 'max-length': 0, overflow: 'reject-publish' }, 'apply-to': 'queues', priority: 100 });
    // In force when the BROKER refuses a probe (authoritative), never when the sampled management statistics say so (Stage 18.10).
    for (let i = 0; ; i++) {
      const probe = await conn.createConfirmChannel();
      probe.on('error', () => undefined);
      const refused = await (async () => {
        try {
          probe.sendToQueue(`${queue}.dead`, Buffer.from('{}'));
          await probe.waitForConfirms();
          await probe.purgeQueue(`${queue}.dead`);
          return false;
        } catch {
          return true;
        } finally {
          await probe.close().catch(() => undefined);
        }
      })();
      if (refused) break;
      if (i > 300) throw new Error('the broker never refused publishes to the DLQ');
      await sleep(100);
    }
    await publisher.publish(envelope());
    await waitFor(() => notices.filter((n) => n.startsWith('event_dead_letter_deferred')).length >= 1);
    const before = notices.filter((n) => n.startsWith('event_dead_letter_deferred')).length;
    await sleep(3000);
    const deferrals = notices.filter((n) => n.startsWith('event_dead_letter_deferred')).length - before;
    expect(deferrals).toBeGreaterThanOrEqual(2);
    expect(deferrals).toBeLessThanOrEqual(8); // 500 ms holds: ~6 in 3 s (a tight loop would be hundreds)
    expect(await depth(`${queue}.dead`)).toBe(0);
    await sub.close();
    await bus.close();
    expect(await depth(queue)).toBe(1);
    expect(await depth(`${queue}.dead`)).toBe(0);

    // A LONG hold (4 s) — a closing consumer must cut it short, not wait it out (bounded shutdown under the fault).
    const slow = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange, retry: { maxRetries: 0, delayMs: 4000 }, onNotice: (m) => notices.push(m) });
    const seen = notices.length;
    const held = await slow.subscribe({
      queue, bindings: ['payment.#'], handler: async () => { throw new PermanentEventFailure('refused_for_test'); },
      deadLetterPolicy: () => ({ body: 'redacted', headers: {} }),
    });
    await waitFor(() => notices.slice(seen).some((n) => n.startsWith('event_dead_letter_deferred')));
    const began = Date.now();
    await held.close();
    expect(Date.now() - began).toBeLessThan(1000);
    await slow.close();
    await publisher.close();
    expect(await depth(queue)).toBe(1);
    expect(await depth(`${queue}.dead`)).toBe(0);
  }, 30_000);
});
