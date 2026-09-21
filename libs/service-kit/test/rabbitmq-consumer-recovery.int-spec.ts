import { randomBytes, randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { RabbitMqEventBus, type EventEnvelope } from '../src/index.js';
import { BrokerProxy } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

const uniq = () => randomBytes(4).toString('hex');
const envelope = (name: string): EventEnvelope => {
  const id = randomUUID();
  return { id, name, payload: { paymentId: 'p1' }, headers: { eventId: id, occurredAt: new Date().toISOString(), correlationId: 'corr-abcdef12', source: 'payment-service', version: 1 } };
};
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
};

describeWithEnv('RabbitMQ consumer recovery (real broker, severed and restored connection)', ['TEST_RABBITMQ_URL'], (env) => {
  const target = new URL(env.TEST_RABBITMQ_URL);
  const exchange = `nawara.events.recovery${uniq()}`;
  const buses: RabbitMqEventBus[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => void unhandled.push(e);
  let proxy: BrokerProxy;
  let publisher: RabbitMqEventBus;
  let notices: string[];

  const consumerBus = () => {
    const b = new RabbitMqEventBus({
      url: proxy.url, exchange, connectTimeoutMs: 500,
      consumerReconnect: { baseDelayMs: 30, maxDelayMs: 150 },
      onNotice: (m) => notices.push(m),
    });
    buses.push(b);
    return b;
  };
  const state = (b: RabbitMqEventBus) => b.consumerStatus()[0]?.state;

  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandled);
    publisher = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange, connectTimeoutMs: 1500 });
    buses.push(publisher);
  });
  afterEach(async () => {
    for (const b of buses) if (b !== publisher) await b.close(); // a consumer bus never outlives its test
    await proxy?.sever();
  });
  afterAll(async () => {
    process.off('unhandledRejection', onUnhandled);
    for (const b of buses) await b.close();
    const c = await amqp.connect(env.TEST_RABBITMQ_URL);
    const ch = await c.createChannel();
    await ch.deleteExchange(exchange).catch(() => undefined);
    await ch.deleteExchange(`${exchange}.dlx`).catch(() => undefined);
    await c.close();
    expect(unhandled).toEqual([]); // no test in this file may leak an unhandled rejection
  });
  const fresh = async () => {
    notices = [];
    proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
  };

  it('startup: the consumer attaches and consumes', async () => {
    await fresh();
    const bus = consumerBus();
    const got: string[] = [];
    await bus.subscribe({ queue: `q.start.${uniq()}`, bindings: ['payment.#'], handler: async (e) => void got.push(e.id) });
    expect(bus.consumerStatus()).toEqual([expect.objectContaining({ state: 'consuming' })]);
    const ev = envelope('payment.succeeded');
    await publisher.publish(ev);
    await waitFor(() => got.includes(ev.id));
  });

  it('a lost connection is detected, the consumer is re-created when the broker is reachable again, and new events are consumed', async () => {
    await fresh();
    const bus = consumerBus();
    const got: string[] = [];
    const queue = `q.recover.${uniq()}`;
    await bus.subscribe({ queue, bindings: ['payment.#'], handler: async (e) => void got.push(e.id) });
    const before = envelope('payment.succeeded');
    await publisher.publish(before);
    await waitFor(() => got.includes(before.id));

    await proxy.sever(); // the broker "goes away"
    await waitFor(() => state(bus) === 'reconnecting');

    // an event published while the consumer is down waits in the durable queue
    const during = envelope('payment.succeeded');
    await publisher.publish(during);
    expect(got).not.toContain(during.id);

    await new Promise((r) => setTimeout(r, 200)); // several failed reconnect attempts against a refused port
    expect(state(bus)).toBe('reconnecting');

    await proxy.start(); // the broker "returns" on the same address
    await waitFor(() => state(bus) === 'consuming');
    await waitFor(() => got.includes(during.id)); // the backlog is drained
    const after = envelope('payment.failed');
    await publisher.publish(after);
    await waitFor(() => got.includes(after.id)); // and new events flow

    expect(notices.some((n) => n.startsWith('rabbitmq_consumer_lost'))).toBe(true);
    expect(notices.some((n) => n.startsWith('rabbitmq_consumer_recovered'))).toBe(true);
    expect(notices.join('\n')).not.toMatch(/guest|amqp:\/\/|127\.0\.0\.1/); // no credential or address in an operational notice
  });

  it('the broker cancelling the consumer (queue deleted while the channel stays open) is recovered too', async () => {
    await fresh();
    const bus = consumerBus();
    const got: string[] = [];
    const queue = `q.cancel.${uniq()}`;
    await bus.subscribe({ queue, bindings: ['payment.#'], handler: async (e) => void got.push(e.id) });
    const c = await amqp.connect(env.TEST_RABBITMQ_URL);
    const ch = await c.createChannel();
    await ch.deleteQueue(queue);
    await waitFor(() => notices.some((n) => n.startsWith('rabbitmq_consumer_lost')));
    await waitFor(() => state(bus) === 'consuming'); // queue and binding were declared again
    const ev = envelope('payment.succeeded');
    await publisher.publish(ev);
    await waitFor(() => got.includes(ev.id));
    await ch.close();
    await c.close();
  });

  it('a message being handled when the connection dies is not lost: settle fails harmlessly and the broker redelivers it after recovery', async () => {
    await fresh();
    const bus = consumerBus();
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ev = envelope('payment.succeeded');
    await bus.subscribe({
      queue: `q.inflight.${uniq()}`, bindings: ['payment.#'],
      handler: async (e) => {
        seen.push(e.id);
        if (seen.length === 1) await gate; // first delivery is still running when the connection is severed
      },
    });
    await publisher.publish(ev);
    await waitFor(() => seen.length === 1);
    await proxy.sever();
    await waitFor(() => state(bus) === 'reconnecting');
    release(); // the handler finishes on a dead channel: the acknowledgement cannot be sent
    await waitFor(() => notices.some((n) => n.startsWith('rabbitmq_settle_failed')));
    await proxy.start();
    await waitFor(() => seen.length === 2); // at-least-once: delivered again (consumers deduplicate)
    expect(seen).toEqual([ev.id, ev.id]);
  });

  it('shutdown: closing the bus while the consumer is reconnecting stops the reconnect loop for good', async () => {
    await fresh();
    const bus = consumerBus();
    await bus.subscribe({ queue: `q.shutdown.${uniq()}`, bindings: ['payment.#'], handler: async () => undefined });
    await proxy.sever();
    await waitFor(() => state(bus) === 'reconnecting');
    await bus.close();
    expect(bus.consumerStatus()).toEqual([]);
    await proxy.start();
    const accepted = proxy.accepted;
    await new Promise((r) => setTimeout(r, 400)); // several backoff periods
    expect(proxy.accepted).toBe(accepted); // nothing reconnected
  });

  it('shutdown while consuming cancels and closes; a later connection loss does not resurrect it', async () => {
    await fresh();
    const bus = consumerBus();
    const sub = await bus.subscribe({ queue: `q.close.${uniq()}`, bindings: ['payment.#'], handler: async () => undefined });
    await sub.close();
    expect(bus.consumerStatus()).toEqual([]);
    const accepted = proxy.accepted;
    await bus.close();
    await proxy.sever();
    await proxy.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(proxy.accepted).toBe(accepted);
  });

  it('the first subscribe fails fast when the broker is unreachable, and leaves nothing behind to retry', async () => {
    await fresh();
    const bus = consumerBus();
    await proxy.sever();
    await expect(bus.subscribe({ queue: `q.failfast.${uniq()}`, bindings: ['payment.#'], handler: async () => undefined })).rejects.toBeDefined();
    expect(bus.consumerStatus()).toEqual([]);
  });
});
