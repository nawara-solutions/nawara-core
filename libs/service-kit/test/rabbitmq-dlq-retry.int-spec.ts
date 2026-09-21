import { randomBytes, randomUUID } from 'node:crypto';
import amqp, { type ChannelModel } from 'amqplib';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { PermanentEventFailure, RabbitMqEventBus, inspectDeadLetters, replayDeadLetter, type EventEnvelope } from '../src/index.js';
import { requireDeadQueue } from '../src/events/dlq-tools.js';
import { describeWithEnv } from './support/env.js';

const uniq = () => randomBytes(4).toString('hex');
const CORRELATION = 'corr-m07-abcdef';
const SECRET = 'S3cretCardNumber-4111';
const envelope = (name = 'payment.cancelled'): EventEnvelope => {
  const id = randomUUID();
  return { id, name, payload: { paymentRequestId: randomUUID(), cardNote: SECRET }, headers: { eventId: id, occurredAt: new Date().toISOString(), correlationId: CORRELATION, source: 'payment-service', version: 1 } };
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
});
