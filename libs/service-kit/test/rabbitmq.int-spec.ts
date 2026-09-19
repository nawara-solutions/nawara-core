import { randomBytes, randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService, InboxService, OutboxRelay, OutboxService, RabbitMqEventBus, kitMigrationsDir, runMigrations, type EventEnvelope } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

const uniq = () => randomBytes(4).toString('hex');
const envelope = (name: string, extra: Partial<EventEnvelope> = {}): EventEnvelope => {
  const id = randomUUID();
  return { id, name, payload: { paymentId: 'p1' }, headers: { eventId: id, occurredAt: new Date().toISOString(), correlationId: 'corr-abcdef12', source: 'payment-service', version: 1 }, ...extra };
};
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
};

describeWithEnv('RabbitMQ event bus (real broker)', ['TEST_RABBITMQ_URL', 'TEST_DATABASE_ADMIN_URL'], (env) => {
  let exchange: string;
  let bus: RabbitMqEventBus;
  const buses: RabbitMqEventBus[] = [];
  const make = (url = env.TEST_RABBITMQ_URL) => {
    const b = new RabbitMqEventBus({ url, exchange, connectTimeoutMs: 1500 });
    buses.push(b);
    return b;
  };
  beforeAll(() => {
    exchange = `nawara.events.test${uniq()}`;
    bus = make();
  });
  afterAll(async () => {
    for (const b of buses) await b.close();
    const c = await amqp.connect(env.TEST_RABBITMQ_URL);
    const ch = await c.createChannel();
    await ch.deleteExchange(exchange).catch(() => undefined);
    await ch.deleteExchange(`${exchange}.dlx`).catch(() => undefined);
    await c.close();
  });

  it('delivers a published event to a bound consumer with payload and headers intact', async () => {
    const queue = `q.deliver.${uniq()}`;
    const got: EventEnvelope[] = [];
    const sub = await bus.subscribe({ queue, bindings: ['payment.*'], handler: async (e) => void got.push(e) });
    const ev = envelope('payment.succeeded');
    await bus.publish(ev);
    await bus.publish(envelope('invoice.created')); // not bound: must not arrive
    await waitFor(() => got.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: ev.id, name: 'payment.succeeded', payload: { paymentId: 'p1' } });
    expect(got[0].headers).toMatchObject({ eventId: ev.id, source: 'payment-service', correlationId: 'corr-abcdef12', version: 1 });
    await sub.close();
  });

  it('dead-letters an event whose consumer fails, instead of dropping it or looping on it', async () => {
    const queue = `q.dead.${uniq()}`;
    let calls = 0;
    const sub = await bus.subscribe({ queue, bindings: ['payment.#'], handler: async () => { calls++; throw new Error('cannot process'); } });
    const ev = envelope('payment.failed');
    await bus.publish(ev);
    const c = await amqp.connect(env.TEST_RABBITMQ_URL);
    const ch = await c.createChannel();
    let dead: amqp.GetMessage | false = false;
    await waitFor(async () => {
      dead = await ch.get(`${queue}.dead`, { noAck: true });
      return dead !== false;
    });
    expect((dead as unknown as amqp.GetMessage).properties.messageId).toBe(ev.id);
    expect(calls).toBe(1); // tried once, not redelivered in a loop
    await sub.close();
    await ch.close();
    await c.close();
  });

  it('publishes persistent messages that a durable queue holds until a consumer arrives', async () => {
    const queue = `q.durable.${uniq()}`;
    const sub = await bus.subscribe({ queue, bindings: ['audit.#'], handler: async () => undefined });
    await sub.close(); // cancelled but the queue remains bound
    await bus.publish(envelope('audit.event'));
    const c = await amqp.connect(env.TEST_RABBITMQ_URL);
    const ch = await c.createChannel();
    await waitFor(async () => (await ch.checkQueue(queue)).messageCount === 1);
    const msg = await ch.get(queue, { noAck: true });
    expect(msg && msg.properties.deliveryMode).toBe(2); // persistent
    await ch.close();
    await c.close();
  });

  describe('end to end: outbox -> RabbitMQ -> inbox', () => {
    let testDb: TestDatabase;
    let db: DbService;
    beforeAll(async () => {
      testDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2e_events');
      await runMigrations(testDb.url, [kitMigrationsDir]);
      db = new DbService({ url: testDb.url });
      await db.query('CREATE TABLE effects(n int)');
    });
    afterAll(async () => {
      await db.onApplicationShutdown();
      await testDb.drop();
    });

    it('a business change reaches the consumer exactly once in effect, even when the broker delivers it twice', async () => {
      const inbox = new InboxService();
      const outbox = new OutboxService();
      const queue = `q.e2e.${uniq()}`;
      const sub = await bus.subscribe({ queue, bindings: ['payment.succeeded'], handler: (e) => inbox.handle(db, e, (q) => q.query('INSERT INTO effects VALUES (1)') as Promise<any>).then(() => undefined) });

      await db.tx((q) => outbox.enqueue(q, { name: 'payment.succeeded', payload: { paymentId: 'p-e2e' } }));
      const relay = new OutboxRelay(db, bus, { source: 'payment-service' });
      await relay.drainOnce();
      await waitFor(async () => Number((await db.query('SELECT count(*) n FROM effects')).rows[0].n) === 1);

      // the same event delivered AGAIN (a relay crash between publish and stamp, or a broker redelivery)
      const { rows } = await db.query('SELECT id, name, payload, "occurredAt" FROM outbox');
      const again: EventEnvelope = { id: rows[0].id, name: rows[0].name, payload: rows[0].payload, headers: { eventId: rows[0].id, occurredAt: rows[0].occurredAt.toISOString(), source: 'payment-service', version: 1 } };
      await bus.publish(again);
      await bus.publish(again);
      await new Promise((r) => setTimeout(r, 300));
      expect(Number((await db.query('SELECT count(*) n FROM effects')).rows[0].n)).toBe(1);
      await sub.close();
    });

    it('with the broker unreachable, publishing fails, the relay records it, and delivery succeeds once the broker is back', async () => {
      const outbox = new OutboxService();
      await db.query('DELETE FROM outbox');
      await db.tx((q) => outbox.enqueue(q, { name: 'invoice.created', payload: { invoiceId: 'i-outage' } }));
      const down = make('amqp://guest:guest@127.0.0.1:1');
      const relayDown = new OutboxRelay(db, down, { source: 'billing-service', baseBackoffMs: 1 });
      expect(await relayDown.drainOnce()).toEqual({ published: 0, failed: 1 });
      const row = (await db.query('SELECT attempts, "lastError", "publishedAt" FROM outbox')).rows[0];
      expect(row.attempts).toBe(1);
      expect(row.publishedAt).toBeNull();
      expect(row.lastError).not.toContain('guest'); // no credential in the recorded error
      await new Promise((r) => setTimeout(r, 20));
      const relayUp = new OutboxRelay(db, bus, { source: 'billing-service' });
      expect(await relayUp.drainOnce()).toEqual({ published: 1, failed: 0 });
    });
  });
});
