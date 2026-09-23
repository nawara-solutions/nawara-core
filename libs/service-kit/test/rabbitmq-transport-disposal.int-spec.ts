import { randomUUID } from 'node:crypto';
import type { ChannelModel } from 'amqplib';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { RabbitMqEventBus, type EventEnvelope } from '../src/index.js';
import { BrokerProxy } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 15.5 (F-H), against a REAL RabbitMQ behind a proxy that can go silent (`freeze()`: the broker hears the client, the client hears
 * nothing) or vanish (`sever()`). Invariant: once the bus gives up on a connection (bounded close abandoned, heartbeat timeout, socket
 * error), the connection is never reused AND its socket is destroyed. amqplib only half-closes (`stream.end()`); against a silent peer
 * the socket then stays in FIN_WAIT2 as a live handle, which kept a containerised service (Node = PID 1) from ever exiting.
 */
const envelope = (name: string): EventEnvelope => {
  const id = randomUUID();
  return { id, name, payload: { n: 1 }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'test', version: 1 } };
};
type Socketish = { destroyed: boolean; readyState: string };
const internals = (b: RabbitMqEventBus) => b as unknown as { connection?: ChannelModel & { connection: { stream: Socketish } } };
const timed = async (p: Promise<unknown>) => {
  const t = Date.now();
  await p;
  return Date.now() - t;
};
const waitFor = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
};

describeWithEnv('RabbitMQ transport disposal (Stage 15.5, F-H; real RabbitMQ)', ['TEST_RABBITMQ_URL'], (env) => {
  const target = new URL(env.TEST_RABBITMQ_URL);
  let proxy: BrokerProxy;
  const notices: string[] = [];
  const bus = (heartbeatS: number) =>
    new RabbitMqEventBus({ url: proxy.url, exchange: `nawara.events.dispose${randomUUID().slice(0, 8)}`, heartbeatS, connectTimeoutMs: 1500, confirmTimeoutMs: 300, onNotice: (m) => void notices.push(m) });

  beforeAll(async () => {
    proxy = new BrokerProxy({ host: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
  });
  afterAll(async () => {
    proxy.thaw();
    await proxy.sever();
  });
  afterEach(() => proxy.thaw()); // a failed assertion must not leave the next test behind a frozen broker

  it('silent broker: close() is bounded, the abandoned connection is not reused and its socket is destroyed (no live handle left)', async () => {
    const b = bus(1);
    await b.publish(envelope('probe.warm'));
    const conn = internals(b).connection!;
    const socket = conn.connection.stream;
    proxy.freeze();
    const ms = await timed(b.close());
    expect(ms).toBeLessThan(4000); // 3 x heartbeat
    expect(socket.destroyed).toBe(true); // before the fix: false, readyState 'readOnly' (FIN sent, the peer's never comes)
    expect(internals(b).connection).toBeUndefined();
    proxy.thaw();
    await b.publish(envelope('probe.after'));
    expect(internals(b).connection).toBeDefined();
    expect(internals(b).connection).not.toBe(conn);
    await b.close();
  });

  it('a heartbeat timeout alone (no close() call) destroys the dead connection’s socket', async () => {
    const b = bus(1);
    await b.publish(envelope('probe.warm'));
    const socket = internals(b).connection!.connection.stream;
    proxy.freeze();
    expect(await waitFor(() => internals(b).connection === undefined, 6000)).toBe(true); // torn down by the heartbeat
    expect(await waitFor(() => socket.destroyed, 1000)).toBe(true);
    proxy.thaw();
    await b.close();
  });

  it('a close the broker never answers is abandoned at the bound and its transport destroyed, even with no client heartbeat', async () => {
    const b = bus(0); // no heartbeat requested: only the bounded close (3 x the default heartbeat = 30 s) ends the wait
    await b.publish(envelope('probe.warm'));
    const socket = internals(b).connection!.connection.stream;
    proxy.freeze();
    notices.length = 0;
    try {
      const ms = await timed(b.close());
      expect(ms).toBeGreaterThanOrEqual(29_000);
      expect(ms).toBeLessThan(33_000); // ONE bound for the publisher channel and the connection together
      expect(socket.destroyed).toBe(true);
      expect(notices.some((n) => n.startsWith('rabbitmq_connection_abandoned'))).toBe(true);
    } finally {
      proxy.thaw();
    }
  }, 60_000);

  it('healthy broker: close is graceful (close-ok, then the broker closes its side); nothing is abandoned or forced', async () => {
    const b = bus(10);
    await b.publish(envelope('probe.warm'));
    const socket = internals(b).connection!.connection.stream;
    notices.length = 0;
    const ms = await timed(b.close());
    expect(ms).toBeLessThan(1000);
    expect(notices.filter((n) => n.startsWith('rabbitmq_connection_abandoned'))).toEqual([]);
    expect(await waitFor(() => socket.destroyed, 2000)).toBe(true); // closed by the peer's FIN, not by us
  });

  it('broker vanishes during the close: close() returns at once (it does not wait for the bound) and the socket is destroyed', async () => {
    const b = bus(10);
    await b.publish(envelope('probe.warm'));
    const socket = internals(b).connection!.connection.stream;
    proxy.freeze(); // the close is sent and never answered...
    const closing = timed(b.close());
    await new Promise((r) => setTimeout(r, 300));
    await proxy.sever(); // ...then the broker disappears
    await proxy.start();
    expect(await closing).toBeLessThan(3000);
    expect(socket.destroyed).toBe(true);
    proxy.thaw();
  });
});
