import { randomBytes, randomUUID } from 'node:crypto';
import amqp, { type ChannelModel, type GetMessage } from 'amqplib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PublisherIdentityUnavailableError, RabbitMqEventBus, type EventEnvelope } from '../src/index.js';
import { deadQueueName } from '../src/events/dead-letter.js';
import { ownedBrokerResources } from './support/broker-resources.js';
import { describeWithEnv } from './support/env.js';

/**
 * Core V2 S1a (ADR-0057 §13.1; S0 §8 and §9): the kit's publisher sets the AMQP `user_id` to the broker user it authenticated as, and a
 * REAL RabbitMQ refuses any other `user_id`. Two disposable broker users are created through the management API for this file only
 * (random names and passwords, no tags, so no `impersonator`; permissions limited to this file's own exchange and queues) and deleted
 * at the end. Their passwords are never printed. Without the broker and its management API the suite does not run (and fails in CI).
 */
const owned = ownedBrokerResources();
const hex = (n: number) => randomBytes(n).toString('hex');
const run = hex(4);
const prefix = `s1a${run}`;

const envelope = (name: string, extra: { headers?: Record<string, unknown>; payload?: Record<string, unknown> } = {}): EventEnvelope => {
  const id = randomUUID();
  return {
    id,
    name,
    payload: { paymentId: 'p1', amount: 1200, currency: 'TND', ...extra.payload },
    headers: { eventId: id, occurredAt: new Date().toISOString(), correlationId: 'corr-abcdef12', source: 'payment-service', version: 1, ...extra.headers },
  } as EventEnvelope;
};
const waitFor = async <T>(probe: () => Promise<T | false | undefined>, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await probe();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
};

describeWithEnv('S1a publisher identity (real RabbitMQ: broker-enforced user_id)', ['TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
  const users = { a: `${prefix}-producer-a`, b: `${prefix}-producer-b` };
  const passwords = { a: hex(24), b: hex(24) };
  const mgmt = new URL(env.TEST_RABBITMQ_MGMT_URL);
  const mgmtAuth = `Basic ${Buffer.from(`${decodeURIComponent(mgmt.username)}:${decodeURIComponent(mgmt.password)}`).toString('base64')}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${mgmt.origin}/api${path}`, { method, headers: { authorization: mgmtAuth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok && !(method === 'DELETE' && r.status === 404)) throw new Error(`management API ${method} ${path}: ${r.status}`);
    return r.status === 204 || method !== 'GET' ? undefined : ((await r.json()) as Record<string, unknown>);
  };
  /** A broker URL authenticating as `user` (the vhost and host of TEST_RABBITMQ_URL). Never logged. */
  const urlFor = (user: string, password: string) => {
    const u = new URL(env.TEST_RABBITMQ_URL);
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(password);
    return u.toString();
  };
  const exchange = owned.exchange(`${prefix}.events`);
  const buses: RabbitMqEventBus[] = [];
  const bus = (url: string, extra: Partial<ConstructorParameters<typeof RabbitMqEventBus>[0]> = {}) => {
    const b = new RabbitMqEventBus({ url, exchange, connectTimeoutMs: 2000, ...extra });
    buses.push(b);
    return b;
  };
  let observer: ChannelModel; // TEST_RABBITMQ_URL's user: declares queues and reads what arrived, never the publisher under test

  beforeAll(async () => {
    // Only this file's exchange and queues; `write` also on `amq.default`, the default exchange the bus's retry and dead-letter copies use.
    const own = `^${prefix}\\..*$`;
    const write = `^(${prefix}\\..*|amq\\.default)$`;
    for (const k of ['a', 'b'] as const) {
      await api('PUT', `/users/${encodeURIComponent(users[k])}`, { password: passwords[k], tags: '' });
      await api('PUT', `/permissions/%2F/${encodeURIComponent(users[k])}`, { configure: own, write, read: own });
    }
    observer = await amqp.connect(env.TEST_RABBITMQ_URL);
    const ch = await observer.createChannel();
    await ch.assertExchange(exchange, 'topic', { durable: true });
    await ch.close();
  });
  afterAll(async () => {
    for (const b of buses) await b.close();
    await observer?.close().catch(() => undefined);
    for (const k of ['a', 'b'] as const) await api('DELETE', `/users/${encodeURIComponent(users[k])}`);
  });

  /** A fresh queue bound to `pattern` on the test exchange, declared by the observer. */
  const tap = async (pattern: string) => {
    const queue = owned.queue(`${prefix}.tap.${hex(3)}`);
    const ch = await observer.createChannel();
    await ch.assertQueue(queue, { durable: true });
    await ch.bindQueue(queue, exchange, pattern);
    return {
      next: () => waitFor(async () => ((await ch.get(queue, { noAck: true })) as GetMessage | false) || undefined),
      /** Nothing arrived within `ms` (an absence, checked after the publish has failed). */
      empty: async (ms = 300) => {
        await new Promise((r) => setTimeout(r, ms));
        return (await ch.checkQueue(queue)).messageCount === 0;
      },
      close: () => ch.close(),
    };
  };

  it('the disposable producers are ordinary users: no tags, so no impersonator', async () => {
    for (const k of ['a', 'b'] as const) {
      const u = await api('GET', `/users/${encodeURIComponent(users[k])}`);
      expect(u?.tags).toEqual([]); // RabbitMQ 3.13 reports tags as a list; `impersonator` would be one of them
    }
  });

  it('A: a publish carries the authenticated broker user as user_id, and the broker accepts it', async () => {
    const t = await tap('payment.#');
    const ev = envelope('payment.succeeded');
    await bus(urlFor(users.a, passwords.a)).publish(ev);
    const msg = await t.next();
    expect(msg.properties.userId).toBe(users.a);
    expect(msg.properties.messageId).toBe(ev.id);
    await t.close();
  });

  it('A: nothing in the event can choose the identity: user_id fields in headers and payload are ignored', async () => {
    const t = await tap('payment.#');
    const forged = { userId: users.b, user_id: users.b, 'x-user-id': users.b };
    await bus(urlFor(users.a, passwords.a)).publish(envelope('payment.failed', { headers: forged, payload: forged }));
    const msg = await t.next();
    expect(msg.properties.userId).toBe(users.a);
    await t.close();
  });

  it('B: the broker refuses a user_id of another producer on an authenticated connection (406), and nothing is routed', async () => {
    const t = await tap('payment.#');
    const conn = await amqp.connect(urlFor(users.a, passwords.a));
    const ch = await conn.createConfirmChannel();
    const closed = new Promise<unknown>((resolve) => ch.on('error', resolve));
    ch.publish(exchange, 'payment.succeeded', Buffer.from('{}'), { persistent: true, messageId: randomUUID(), type: 'payment.succeeded', userId: users.b });
    await expect(ch.waitForConfirms()).rejects.toBeDefined();
    const err = (await closed) as { code?: number; message?: string };
    expect(err.code).toBe(406); // PRECONDITION_FAILED: user_id property set to another user than the authenticated one
    expect(err.message).toContain('user_id');
    expect(await t.empty()).toBe(true);
    await conn.close().catch(() => undefined);
    await t.close();
  });

  it('B: the same refusal for the broker administrator\'s name, and the other producer still publishes as itself', async () => {
    const admin = decodeURIComponent(new URL(env.TEST_RABBITMQ_URL).username);
    const t = await tap('invoice.#');
    const conn = await amqp.connect(urlFor(users.b, passwords.b));
    const ch = await conn.createConfirmChannel();
    const closed = new Promise<unknown>((resolve) => ch.on('error', resolve));
    ch.publish(exchange, 'invoice.created', Buffer.from('{}'), { userId: admin });
    await expect(ch.waitForConfirms()).rejects.toBeDefined();
    expect(((await closed) as { code?: number }).code).toBe(406);
    expect(await t.empty()).toBe(true);
    await conn.close().catch(() => undefined);
    await bus(urlFor(users.b, passwords.b)).publish(envelope('invoice.created'));
    expect((await t.next()).properties.userId).toBe(users.b);
    await t.close();
  });

  it('C: a bus whose URL names no broker user publishes nothing (no implicit identity)', async () => {
    const t = await tap('payment.#');
    const anonymous = new URL(env.TEST_RABBITMQ_URL);
    anonymous.username = '';
    anonymous.password = '';
    await expect(bus(anonymous.toString()).publish(envelope('payment.succeeded'))).rejects.toBeInstanceOf(PublisherIdentityUnavailableError);
    expect(await t.empty()).toBe(true);
    await t.close();
  });

  it('C: a producer name with the wrong password cannot connect, so cannot publish under that name', async () => {
    const t = await tap('payment.#');
    const err = await bus(urlFor(users.a, `${passwords.a}x`)).publish(envelope('payment.succeeded')).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain(passwords.a);
    expect(await t.empty()).toBe(true);
    await t.close();
  });

  it('C: a raw publish WITHOUT user_id is not refused by the broker but carries no identity (attributable to nobody)', async () => {
    const t = await tap('payment.#');
    const conn = await amqp.connect(urlFor(users.a, passwords.a));
    const ch = await conn.createConfirmChannel();
    ch.publish(exchange, 'payment.succeeded', Buffer.from('{}'), { messageId: randomUUID(), type: 'payment.succeeded' });
    await ch.waitForConfirms();
    expect((await t.next()).properties.userId).toBeUndefined();
    await conn.close();
    await t.close();
  });

  it('D: a retry or dead-letter copy is published with the identity of the bus that copies it', async () => {
    const queue = owned.queue(`${prefix}.consumer.${hex(3)}`);
    const consumer = bus(urlFor(users.b, passwords.b), { retry: { maxRetries: 1, delayMs: 50 } });
    let calls = 0;
    const sub = await consumer.subscribe({ queue, bindings: ['payment.#'], handler: async () => { calls++; throw new Error('transient'); } });
    const ev = envelope('payment.expired');
    await bus(urlFor(users.a, passwords.a)).publish(ev);
    const ch = await observer.createChannel();
    const dead = await waitFor(async () => ((await ch.get(deadQueueName(queue), { noAck: true })) as GetMessage | false) || undefined, 10000);
    expect(calls).toBe(2); // the first delivery and one retry
    expect(dead.properties.messageId).toBe(ev.id);
    expect(dead.properties.userId).toBe(users.b); // the copy's publisher, never the original's name re-asserted
    await sub.close();
    await ch.close();
  });

  it('D/E: payment.* and invoice.created keep their routing key, properties, headers and body; only user_id is added', async () => {
    const t = await tap('#');
    const received: EventEnvelope[] = [];
    const queue = owned.queue(`${prefix}.compat.${hex(3)}`);
    const consumer = bus(env.TEST_RABBITMQ_URL);
    const sub = await consumer.subscribe({ queue, bindings: ['payment.*', 'invoice.created'], handler: async (e) => void received.push(e) });
    const names = ['payment.created', 'payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired', 'invoice.created'];
    const sent = names.map((n) => envelope(n));
    const producer = bus(urlFor(users.a, passwords.a));
    for (const ev of sent) await producer.publish(ev);
    for (const ev of sent) {
      const msg = await t.next();
      expect(msg.fields.routingKey).toBe(ev.name);
      expect(msg.properties).toMatchObject({ messageId: ev.id, type: ev.name, contentType: 'application/json', deliveryMode: 2, userId: users.a });
      expect(msg.properties.timestamp).toBe(Math.floor(new Date(ev.headers.occurredAt).getTime() / 1000));
      expect(msg.properties.headers).toEqual(ev.headers);
      expect(JSON.parse(msg.content.toString())).toEqual(ev.payload);
    }
    await waitFor(async () => received.length === sent.length);
    expect(received.map((e) => ({ id: e.id, name: e.name, payload: e.payload, headers: e.headers }))).toEqual(
      sent.map((e) => ({ id: e.id, name: e.name, payload: e.payload, headers: e.headers })),
    );
    await sub.close();
    await t.close();
  });
});
