import { randomBytes, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DbModule, DbService, EventsModule, OutboxRelay, OutboxRelayService, OutboxService, PublisherConfirmTimeoutError, RabbitMqEventBus, kitMigrationsDir,
  runMigrations, type EventBus, type EventEnvelope,
} from '../src/index.js';
import { BrokerProxy, createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 14.6 (F4, F6), against a REAL RabbitMQ and PostgreSQL. The broker is reached through a TCP proxy that can freeze the
 * broker-to-client direction: a publish still reaches the broker but no confirm comes back — a genuinely stalled broker.
 */
const uniq = () => randomBytes(4).toString('hex');
const envelope = (name: string): EventEnvelope => {
  const id = randomUUID();
  return { id, name, payload: { n: 1 }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'test', version: 1 } };
};
const latch = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
};
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describeWithEnv('async runtime limits (real RabbitMQ + PostgreSQL)', ['TEST_RABBITMQ_URL', 'TEST_DATABASE_ADMIN_URL'], (env) => {
  const target = new URL(env.TEST_RABBITMQ_URL);
  let proxy: BrokerProxy;
  let testDb: TestDatabase;
  const closers: (() => Promise<unknown>)[] = [];

  beforeAll(async () => {
    proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
    testDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'asyncres');
    await runMigrations(testDb.url, [kitMigrationsDir]);
  });
  afterAll(async () => {
    proxy.thaw();
    for (const c of closers.reverse()) await c().catch(() => undefined);
    await proxy.sever();
    await testDb.drop();
  });

  it('F4: a publish whose confirm never arrives fails within confirmTimeoutMs; after the broker recovers, publishing works again', async () => {
    const bus = new RabbitMqEventBus({ url: proxy.url, exchange: `nawara.events.cto${uniq()}`, confirmTimeoutMs: 500, connectTimeoutMs: 1500 });
    closers.push(() => bus.close());
    await bus.publish(envelope('probe.warmup')); // normal confirm
    proxy.freeze();
    const start = Date.now();
    await expect(bus.publish(envelope('probe.stalled'))).rejects.toBeInstanceOf(PublisherConfirmTimeoutError);
    expect(Date.now() - start).toBeLessThan(5_000); // bounded (unprotected, this waited for as long as the broker stalled)
    proxy.thaw();
    await bus.publish(envelope('probe.after')); // a fresh confirm channel: the timed-out one was discarded
  });

  it('F4: the outbox relay keeps the event PENDING on a confirm timeout, releases its transaction, and delivers it after recovery (at least once)', async () => {
    const exchange = `nawara.events.relay${uniq()}`;
    const bus = new RabbitMqEventBus({ url: proxy.url, exchange, confirmTimeoutMs: 500, connectTimeoutMs: 1500 });
    const consumerBus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange });
    const db = new DbService({ url: testDb.url, max: 4 });
    closers.push(() => bus.close(), () => consumerBus.close(), () => db.onApplicationShutdown());
    const received: string[] = [];
    await consumerBus.subscribe({ queue: `q.relay.${uniq()}`, bindings: ['order.placed'], handler: async (e) => void received.push(e.id) });
    await bus.publish(envelope('order.warmup')); // open the publisher channel through the proxy

    const id = await db.tx((q) => new OutboxService().enqueue(q, { name: 'order.placed', payload: { orderId: 'o-1' } }));
    const relay = new OutboxRelay(db, bus, { source: 'test', baseBackoffMs: 200 });
    proxy.freeze();
    const r = await relay.drainOnce();
    expect(r).toEqual({ published: 0, failed: 1 });
    const row = (await db.query('SELECT "publishedAt", attempts, "lastError" FROM outbox WHERE id = $1', [id])).rows[0];
    expect(row.publishedAt).toBeNull(); // NOT marked delivered on a timeout
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/PublisherConfirmTimeoutError/);
    const idleInTx = await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`);
    expect(idleInTx.rows[0].n).toBe(0); // the relay's transaction ended: no connection is left holding row locks

    proxy.thaw();
    await waitFor(async () => (await relay.drainOnce()).published === 1); // after its backoff, the event is relayed again
    await waitFor(() => received.includes(id)); // delivered; a duplicate of the stalled copy is possible and consumers deduplicate
  });

  it('F6: closing a consumer lets the delivery being handled finish and be acknowledged before the channel closes', async () => {
    const exchange = `nawara.events.drain${uniq()}`;
    const bus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange, drainTimeoutMs: 10_000 });
    closers.push(() => bus.close());
    const gate = latch();
    const entered = latch();
    let handled = 0;
    const queue = `q.drain.${uniq()}`;
    const sub = await bus.subscribe({ queue, bindings: ['job.run'], handler: async () => {
      entered.open();
      await gate.opened;
      handled++;
    } });
    await bus.publish(envelope('job.run'));
    await entered.opened;
    let closed = false;
    const closing = sub.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 150));
    expect(closed).toBe(false); // waiting for the handler in flight
    gate.open();
    await closing;
    expect(handled).toBe(1);
    // It was acknowledged before the channel closed: a new consumer on the same queue receives nothing.
    let redelivered = 0;
    const again = await bus.subscribe({ queue, bindings: ['job.run'], handler: async () => void redelivered++ });
    await new Promise((r) => setTimeout(r, 500));
    await again.close();
    expect(redelivered).toBe(0);
  });

  it('F6: the consumer drain is bounded; an unfinished delivery is redelivered afterwards (at least once)', async () => {
    const exchange = `nawara.events.drainto${uniq()}`;
    const bus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange, drainTimeoutMs: 300 });
    closers.push(() => bus.close());
    const entered = latch();
    const queue = `q.drainto.${uniq()}`;
    const sub = await bus.subscribe({ queue, bindings: ['job.slow'], handler: async () => {
      entered.open();
      await new Promise(() => undefined); // never finishes
    } });
    await bus.publish(envelope('job.slow'));
    await entered.opened;
    const start = Date.now();
    await sub.close();
    expect(Date.now() - start).toBeLessThan(3_000);
    let redelivered = 0;
    const again = await bus.subscribe({ queue, bindings: ['job.slow'], handler: async () => void redelivered++ });
    await waitFor(() => redelivered === 1);
    await again.close();
  });

  it('F6: on Nest shutdown the relay drains in beforeApplicationShutdown, while the database pool is still open', async () => {
    const gate = latch();
    const publishing = latch();
    const published: string[] = [];
    const slowBus: EventBus = {
      publish: async (e) => {
        publishing.open();
        await gate.opened;
        published.push(e.id);
      },
      subscribe: async () => ({ close: async () => undefined }),
      close: async () => undefined,
    };
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule.forRoot({ url: testDb.url, max: 2 }), EventsModule.forRoot({ source: 'test', bus: slowBus, relay: { intervalMs: 20 } })],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    const db = app.get(DbService);
    const id = await db.tx((q) => new OutboxService().enqueue(q, { name: 'shutdown.probe', payload: {} }));
    await publishing.opened; // the relay's batch is in flight, inside its transaction
    let closed = false;
    const closing = app.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 150));
    expect(closed).toBe(false); // shutdown waits for the in-flight batch
    gate.open();
    await closing;
    expect(published).toContain(id);
    // The batch could stamp its row AFTER shutdown began: the pool was still open during the drain.
    const check = new DbService({ url: testDb.url });
    closers.push(() => check.onApplicationShutdown());
    expect((await check.query('SELECT "publishedAt" FROM outbox WHERE id = $1', [id])).rows[0].publishedAt).not.toBeNull();
    expect(app.get(OutboxRelayService)).toBeDefined();
  });
});
