import { randomBytes, randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PublisherConfirmTimeoutError, RabbitMqEventBus, describeFailure, type EventEnvelope } from '../src/index.js';
import { BrokerProxy } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 15.3, invariant I9, against a REAL RabbitMQ: when an established broker connection goes silent (the proxy's `freeze()` stops the
 * broker-to-client direction: no replies, no heartbeats), every wait must end within a bound Core configures, not the broker. The
 * confirm wait was already bounded (`confirmTimeoutMs`); channel open, declare, consume, cancel and close were bounded only by the
 * heartbeat the BROKER proposed (60 s by default, none when the broker turns heartbeats off). The bus now requests its own heartbeat
 * (`heartbeatS`, 1 s in these tests) and bounds its closes. Every assertion is made while the broker is still frozen.
 */
const uniq = () => randomBytes(4).toString('hex');
const envelope = (name: string): EventEnvelope => {
  const id = randomUUID();
  return { id, name, payload: { n: 1 }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'test', version: 1 } };
};
const within = async <T>(p: Promise<T>, ms: number): Promise<{ settled: boolean; ms: number; failure?: string }> => {
  const t = Date.now();
  return Promise.race([
    p.then(
      () => ({ settled: true, ms: Date.now() - t }),
      (e: unknown) => ({ settled: true, ms: Date.now() - t, failure: describeFailure(e) }),
    ),
    new Promise<{ settled: boolean; ms: number }>((r) => setTimeout(() => r({ settled: false, ms: Date.now() - t }), ms)),
  ]);
};
const waitFor = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const internals = (b: RabbitMqEventBus) => b as unknown as { connection?: { connection: { heartbeat: number } }; publisher?: unknown };

describeWithEnv('RabbitMQ bus on a silent broker (real RabbitMQ, frozen connection)', ['TEST_RABBITMQ_URL'], (env) => {
  const target = new URL(env.TEST_RABBITMQ_URL);
  let proxy: BrokerProxy;
  const closers: (() => Promise<unknown>)[] = [];
  const bus = (o: Partial<ConstructorParameters<typeof RabbitMqEventBus>[0]> = {}) => {
    const b = new RabbitMqEventBus({ url: proxy.url, exchange: `nawara.events.silent${uniq()}`, connectTimeoutMs: 1500, ...o });
    closers.push(() => b.close());
    return b;
  };

  beforeAll(async () => {
    proxy = new BrokerProxy({ host: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
  });
  afterAll(async () => {
    proxy.thaw();
    for (const c of closers.reverse()) await c().catch(() => undefined);
    await proxy.sever();
  });

  it('negative control: with no client heartbeat, a publish that needs a new channel waits for as long as the broker is silent', async () => {
    const b = bus({ heartbeatS: 0, confirmTimeoutMs: 300 }); // 0: the old behaviour (the compose broker may still propose 60 s)
    await b.publish(envelope('probe.warm'));
    proxy.freeze();
    await expect(b.publish(envelope('probe.stalled'))).rejects.toBeInstanceOf(PublisherConfirmTimeoutError); // the confirm was bounded already
    const next = b.publish(envelope('probe.next')); // the timed-out channel was discarded: this one must open a new channel
    expect((await within(next, 4000)).settled).toBe(false); // nothing Core owns ends it
    proxy.thaw();
    await next.catch(() => undefined);
  });

  it('with the heartbeat, the same publish fails within ~3 heartbeats while the broker is STILL frozen, and the next one uses a fresh connection', async () => {
    const b = bus({ heartbeatS: 1, confirmTimeoutMs: 300 });
    await b.publish(envelope('probe.warm'));
    const before = internals(b).connection;
    proxy.freeze();
    await expect(b.publish(envelope('probe.stalled'))).rejects.toBeInstanceOf(PublisherConfirmTimeoutError);
    const r = await within(b.publish(envelope('probe.next')), 6000);
    expect(r.settled).toBe(true);
    expect(r.ms).toBeLessThan(4000);
    expect(r.failure).toMatch(/kind=broker_connection_lost/);
    proxy.thaw();
    await b.publish(envelope('probe.after'));
    expect(internals(b).connection).toBeDefined();
    expect(internals(b).connection).not.toBe(before); // the torn-down connection is never reused
  });

  it('a consumer on a frozen broker is detected as lost within ~3 heartbeats, re-attaches once the broker answers, and exactly one consumer remains', async () => {
    const queue = `test.silent.${uniq()}`;
    const b = bus({ heartbeatS: 1, consumerReconnect: { baseDelayMs: 100, maxDelayMs: 500 } });
    const got: string[] = [];
    await b.subscribe({ queue, bindings: ['probe.#'], handler: async (e) => void got.push(e.id) });
    proxy.freeze();
    const t = Date.now();
    await waitFor(() => b.consumerStatus().every((s) => s.state === 'reconnecting'), 6000);
    expect(Date.now() - t).toBeLessThan(4000);
    proxy.thaw();
    await waitFor(() => b.consumerStatus().every((s) => s.state === 'consuming'), 15_000);
    const direct = await amqp.connect(env.TEST_RABBITMQ_URL);
    const ch = await direct.createChannel();
    expect((await ch.checkQueue(queue)).consumerCount).toBe(1);
    const e = envelope('probe.after');
    const pub = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: (b as unknown as { exchange: string }).exchange });
    await pub.publish(e);
    await waitFor(() => got.includes(e.id), 10_000);
    await pub.close();
    await ch.deleteQueue(queue).catch(() => undefined);
    await direct.close();
  });

  it('closing on a frozen broker is bounded: a publisher-only bus (Payment) and a publisher + consumer bus (Billing)', async () => {
    const publisherOnly = bus({ heartbeatS: 1 });
    await publisherOnly.publish(envelope('probe.warm'));
    const both = bus({ heartbeatS: 1 });
    await both.publish(envelope('probe.warm'));
    await both.subscribe({ queue: `test.silent.${uniq()}`, bindings: ['probe.#'], handler: async () => undefined });
    proxy.freeze();
    const [a, b] = await Promise.all([within(publisherOnly.close(), 12_000), within(both.close(), 12_000)]);
    proxy.thaw();
    expect(a.settled).toBe(true); // before: a close waiting for its close-ok never settled, even after the heartbeat tore the connection down
    expect(b.settled).toBe(true);
    expect(a.ms).toBeLessThan(8000);
    expect(b.ms).toBeLessThan(8000);
  });

  it('a directly constructed bus requests the kit default heartbeat (10 s), which the broker accepts (the smaller value wins)', async () => {
    const b = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: `nawara.events.silent${uniq()}` });
    closers.push(() => b.close());
    await b.publish(envelope('probe.warm'));
    expect(internals(b).connection?.connection.heartbeat).toBe(10);
  });
});
