import { randomBytes, randomUUID } from 'node:crypto';
import amqp, { type ChannelModel, type GetMessage } from 'amqplib';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import {
  DEAD_LETTER_HEADER, PermanentEventFailure, RabbitMqEventBus, replayDeadLetter, type DeadLetterObservation, type DeadLetterObserver, type EventEnvelope,
} from '../src/index.js';
import { BrokerProxy } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

/**
 * Core V2 DO-43b over a REAL RabbitMQ (safety requirements 5, 8, 9): each PHYSICAL dead-letter transfer gets its own attempt id, stamped on
 * the copy, for a replay, a duplicated publication and a crash between the broker's confirm and the original's acknowledgement; the
 * diagnostic header is stripped on replay; and a subscription without an observer is exactly as before (no header, same copy, same
 * settlement).
 */
const uniq = () => randomBytes(4).toString('hex');
const envelope = (): EventEnvelope => {
  const id = randomUUID();
  return { id, name: 'payment.cancelled', payload: { paymentRequestId: randomUUID() }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } };
};
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
};
const permanent = async () => { throw new PermanentEventFailure('invalid_record'); };

describeWithEnv('DO-43b dead-letter transfer attempts (real broker)', ['TEST_RABBITMQ_URL'], (env) => {
  const exchange = `nawara.events.do43b${uniq()}`;
  const buses: RabbitMqEventBus[] = [];
  const queues: string[] = [];
  let conn: ChannelModel;
  let publisher: RabbitMqEventBus;

  const newQueue = () => {
    const q = `q.do43b.${uniq()}`;
    queues.push(q);
    return q;
  };
  const consumer = (url = env.TEST_RABBITMQ_URL) => {
    const b = new RabbitMqEventBus({ url, exchange, retry: { maxRetries: 0, delayMs: 50 } });
    buses.push(b);
    return b;
  };
  const recorder = () => {
    const seen: DeadLetterObservation[] = [];
    const observer: DeadLetterObserver = { observe: (o) => { seen.push(o); } };
    return { seen, observer };
  };
  const depth = async (queue: string) => {
    const ch = await conn.createChannel();
    ch.on('error', () => undefined);
    try {
      return (await ch.checkQueue(queue)).messageCount;
    } finally {
      await ch.close().catch(() => undefined);
    }
  };
  /** Takes every copy out of `<queue>.dead` (this suite's own disposable queues). */
  const drainDead = async (queue: string): Promise<GetMessage[]> => {
    const ch = await conn.createChannel();
    const out: GetMessage[] = [];
    try {
      for (;;) {
        const m = await ch.get(`${queue}.dead`, { noAck: true });
        if (!m) return out;
        out.push(m);
      }
    } finally {
      await ch.close().catch(() => undefined);
    }
  };
  const confirmed = (seen: DeadLetterObservation[], eventId: string) => seen.filter((o) => o.eventId === eventId && o.transition === 'transfer_confirmed');

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

  it('an opted-in transfer: attempted → transfer_confirmed, the copy carries exactly that attempt id, the original is acknowledged', async () => {
    const queue = newQueue();
    const r = recorder();
    await consumer().subscribe({ queue, bindings: ['payment.#'], handler: permanent, deadLetterObserver: r.observer });
    const ev = envelope();
    await publisher.publish(ev);
    await waitFor(() => confirmed(r.seen, ev.id).length === 1);
    await waitFor(async () => (await depth(`${queue}.dead`)) === 1 && (await depth(queue)) === 0);
    const [copy] = await drainDead(queue);
    expect(r.seen.filter((o) => o.eventId === ev.id).map((o) => o.transition)).toEqual(['attempted', 'transfer_confirmed']);
    expect(copy!.properties.headers?.[DEAD_LETTER_HEADER.deadLetterAttempt]).toBe(r.seen[0]!.attemptId);
    expect(r.seen[0]).toMatchObject({ queue, eventId: ev.id, eventName: 'payment.cancelled', source: 'payment-service', failure: 'permanent', reason: 'invalid_record' });
  });

  it('a subscription WITHOUT an observer is exactly as before: the same copy and annotations, no attempt header, the same settlement', async () => {
    const run = async (observe: boolean) => {
      const queue = newQueue();
      const r = recorder();
      await consumer().subscribe({ queue, bindings: ['payment.#'], handler: permanent, ...(observe ? { deadLetterObserver: r.observer } : {}) });
      const ev = envelope();
      await publisher.publish(ev);
      await waitFor(async () => (await depth(`${queue}.dead`)) === 1 && (await depth(queue)) === 0);
      const [copy] = await drainDead(queue);
      // per-run values (the event's own id and time, this run's queue name, the failure time) are set aside; everything else must be identical
      const { [DEAD_LETTER_HEADER.failedAt]: _t, [DEAD_LETTER_HEADER.deadLetterAttempt]: attempt, [DEAD_LETTER_HEADER.consumer]: consumerQueue, eventId: _e, occurredAt: _o, ...headers } = copy!.properties.headers ?? {};
      expect(consumerQueue).toBe(queue);
      return { attempt, headers, body: copy!.content.toString('utf8'), messageId: copy!.properties.messageId === ev.id, workLeft: await depth(queue), seen: r.seen.length };
    };
    const without = await run(false);
    const withObserver = await run(true);
    expect(without.attempt).toBeUndefined();
    expect(withObserver.attempt).toEqual(expect.any(String));
    expect(withObserver.headers).toEqual(without.headers);
    expect(JSON.parse(withObserver.body).paymentRequestId).toEqual(expect.any(String));
    expect([without.messageId, without.workLeft, without.seen]).toEqual([true, 0, 0]);
    expect([withObserver.messageId, withObserver.workLeft, withObserver.seen]).toEqual([true, 0, 2]);
  });

  it('a REPLAY is a new physical transfer: the replayed message carries no attempt header, and its next transfer gets a new id', async () => {
    const queue = newQueue();
    const r = recorder();
    const bus = consumer();
    await bus.subscribe({ queue, bindings: ['payment.#'], handler: permanent, deadLetterObserver: r.observer });
    const ev = envelope();
    await publisher.publish(ev);
    await waitFor(async () => confirmed(r.seen, ev.id).length === 1 && (await depth(`${queue}.dead`)) === 1);
    await bus.close(); // nothing consumes the work queue while we look at the replayed message
    const result = await replayDeadLetter(conn, `${queue}.dead`, ev.id, { waitMs: 200, pollMs: 50 });
    expect([result.outcome, result.replayCount]).toEqual(['pending', 1]); // replayed into the work queue, which nothing consumes yet
    const ch = await conn.createChannel();
    const replayed = await ch.get(queue, { noAck: false });
    expect(replayed).not.toBe(false);
    const h = (replayed as GetMessage).properties.headers ?? {};
    expect(DEAD_LETTER_HEADER.deadLetterAttempt in h).toBe(false);
    expect(h[DEAD_LETTER_HEADER.replayCount]).toBe(1);
    ch.nack(replayed as GetMessage, false, true); // back to the work queue, untouched
    await ch.close();
    await consumer().subscribe({ queue, bindings: ['payment.#'], handler: permanent, deadLetterObserver: r.observer });
    await waitFor(() => confirmed(r.seen, ev.id).length === 2);
    const ids = confirmed(r.seen, ev.id).map((o) => o.attemptId);
    expect(new Set(ids).size).toBe(2);
    expect(confirmed(r.seen, ev.id).map((o) => o.replayCount)).toEqual([0, 1]);
    const copies = await drainDead(queue);
    expect(copies.map((c) => c.properties.headers?.[DEAD_LETTER_HEADER.deadLetterAttempt])).toEqual([ids[1]]);
  });

  it('a DUPLICATED publication of the same event is two physical transfers with two attempt ids (never collapsed by event id)', async () => {
    const queue = newQueue();
    const r = recorder();
    await consumer().subscribe({ queue, bindings: ['payment.#'], handler: permanent, deadLetterObserver: r.observer });
    const ev = envelope();
    await publisher.publish(ev);
    await publisher.publish(ev);
    await waitFor(async () => confirmed(r.seen, ev.id).length === 2 && (await depth(`${queue}.dead`)) === 2);
    const ids = confirmed(r.seen, ev.id).map((o) => o.attemptId);
    expect(new Set(ids).size).toBe(2);
    const copies = await drainDead(queue);
    expect(new Set(copies.map((c) => c.properties.headers?.[DEAD_LETTER_HEADER.deadLetterAttempt]))).toEqual(new Set(ids));
  });

  it('a CRASH after the broker confirmed the copy and before the original was acknowledged: redelivered, transferred again, a NEW attempt id', async () => {
    const target = new URL(env.TEST_RABBITMQ_URL);
    const proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
    try {
      const queue = newQueue();
      const seen: DeadLetterObservation[] = [];
      let crashed = false;
      // the observer is only the test's trigger for a process-level crash at exactly this point: the connection dies before the ack
      const observer: DeadLetterObserver = {
        observe: (o) => {
          seen.push(o);
          if (o.transition === 'transfer_confirmed' && !crashed) {
            crashed = true;
            void proxy.sever();
            setTimeout(() => void proxy.start(), 300);
          }
        },
      };
      await consumer(proxy.url).subscribe({ queue, bindings: ['payment.#'], handler: permanent, deadLetterObserver: observer });
      const ev = envelope();
      await publisher.publish(ev);
      await waitFor(() => confirmed(seen, ev.id).length === 2, 30_000);
      await waitFor(async () => (await depth(queue)) === 0 && (await depth(`${queue}.dead`)) === 2, 30_000);
      const ids = confirmed(seen, ev.id).map((o) => o.attemptId);
      expect(new Set(ids).size).toBe(2);
      expect(confirmed(seen, ev.id)[1]!.redelivered).toBe(true);
      const copies = await drainDead(queue);
      expect(new Set(copies.map((c) => c.properties.headers?.[DEAD_LETTER_HEADER.deadLetterAttempt]))).toEqual(new Set(ids));
    } finally {
      await proxy.sever();
    }
  });
});
