import { createHash, randomBytes, randomUUID } from 'node:crypto';
import amqp, { type ChannelModel } from 'amqplib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PermanentEventFailure, RabbitMqEventBus, type EventBusObservation, type EventEnvelope, type ProvenanceObservation, type ProvenanceRecordResult } from '../src/index.js';
import { deadQueueName, retryQueueName } from '../src/events/dead-letter.js';
import { ownedBrokerResources } from './support/broker-resources.js';
import { describeWithEnv } from './support/env.js';

/**
 * Core V2 S1b (ADR-0057 §13.2, §13.3; observe-only) over a REAL RabbitMQ: what the consumer records comes from what the broker delivered.
 * Three disposable broker users (random names and passwords, no tags; permissions limited to this file's exchange and queues, plus
 * `amq.default`) are created through the management API and deleted at the end: the event owner, an intruder, and the consumer itself.
 * The store here is an in-memory recorder (the PostgreSQL store is proven in the Billing suite).
 */
const owned = ownedBrokerResources();
const hex = (n: number) => randomBytes(n).toString('hex');
const prefix = `s1b${hex(4)}`;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error('condition not met in time');
};

describeWithEnv('S1b event provenance (real RabbitMQ: broker-delivered metadata)', ['TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
  const users = { owner: `${prefix}-owner`, intruder: `${prefix}-intruder`, consumer: `${prefix}-consumer` };
  const passwords = { owner: hex(24), intruder: hex(24), consumer: hex(24) };
  const mgmt = new URL(env.TEST_RABBITMQ_MGMT_URL);
  const mgmtAuth = `Basic ${Buffer.from(`${decodeURIComponent(mgmt.username)}:${decodeURIComponent(mgmt.password)}`).toString('base64')}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${mgmt.origin}/api${path}`, { method, headers: { authorization: mgmtAuth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok && !(method === 'DELETE' && r.status === 404)) throw new Error(`management API ${method} ${path}: ${r.status}`);
  };
  const urlFor = (k: keyof typeof users) => {
    const u = new URL(env.TEST_RABBITMQ_URL);
    u.username = encodeURIComponent(users[k]);
    u.password = encodeURIComponent(passwords[k]);
    return u.toString();
  };
  const exchange = owned.exchange(`${prefix}.events`);
  const NAME = 'payment.succeeded';
  const ownerOf = (name: string) => (name === NAME ? users.owner : undefined);
  const buses: RabbitMqEventBus[] = [];
  let admin: ChannelModel;

  const envelope = (source: string): EventEnvelope => {
    const id = randomUUID();
    return { id, name: NAME, payload: { paymentId: randomUUID(), amount: 1200, currency: 'TND' }, headers: { eventId: id, occurredAt: new Date().toISOString(), correlationId: 'corr-s1b-0001', source, version: 1 } };
  };
  /** A consumer authenticated as the consumer user, with a scripted store that records what it was asked to commit. */
  const consume = async (opts: { store?: (o: ProvenanceObservation, n: number) => Promise<ProvenanceRecordResult>; handler?: (e: EventEnvelope, n: number) => Promise<void> } = {}) => {
    const queue = owned.queue(`${prefix}.q${hex(3)}`);
    const records: ProvenanceObservation[] = [];
    const handled: EventEnvelope[] = [];
    const observations: EventBusObservation[] = [];
    const notices: string[] = [];
    let attempts = 0;
    const bus = new RabbitMqEventBus({ url: urlFor('consumer'), exchange, retry: { maxRetries: 2, delayMs: 80 }, onNotice: (m) => notices.push(m) });
    bus.setObserver((o) => observations.push(o));
    buses.push(bus);
    await bus.subscribe({
      queue, bindings: [NAME],
      handler: async (e) => {
        handled.push(e);
        await opts.handler?.(e, handled.length);
      },
      provenance: {
        ownerOf,
        store: {
          record: async (consumer, o) => {
            expect(consumer).toBe(queue);
            attempts += 1;
            const r = opts.store ? await opts.store(o, attempts) : 'recorded';
            records.push(o);
            return r;
          },
        },
      },
    });
    const provenance = () => observations.flatMap((o) => (o.type === 'provenance' ? [o.outcome] : []));
    return { queue, records, handled, observations, notices, provenance, attempts: () => attempts };
  };
  const publisher = (k: keyof typeof users) => {
    const b = new RabbitMqEventBus({ url: urlFor(k), exchange, connectTimeoutMs: 2000 });
    buses.push(b);
    return b;
  };
  const depth = async (queue: string) => {
    const ch = await admin.createChannel();
    try {
      return (await ch.checkQueue(queue)).messageCount;
    } finally {
      await ch.close().catch(() => undefined);
    }
  };

  beforeAll(async () => {
    const own = `^${prefix}\\..*$`;
    const write = `^(${prefix}\\..*|amq\\.default)$`;
    for (const k of Object.keys(users) as Array<keyof typeof users>) {
      await api('PUT', `/users/${encodeURIComponent(users[k])}`, { password: passwords[k], tags: '' });
      await api('PUT', `/permissions/%2F/${encodeURIComponent(users[k])}`, { configure: own, write, read: own });
    }
    admin = await amqp.connect(env.TEST_RABBITMQ_URL);
  });
  afterAll(async () => {
    for (const b of buses) await b.close();
    await admin?.close().catch(() => undefined);
    for (const u of Object.values(users)) await api('DELETE', `/users/${encodeURIComponent(u)}`);
  });

  it('the owner, publishing as itself, is accepted and its delivery is recorded VERIFIED from the broker-delivered metadata, before the handler', async () => {
    const c = await consume({ handler: async () => expect(c.records).toHaveLength(1) });
    const e = envelope(users.owner);
    await publisher('owner').publish(e);
    await waitFor(() => c.handled.length === 1);
    expect(c.records).toEqual([{
      source: users.owner, eventId: e.id, name: NAME, routingKey: NAME, exchange, bodySha256: sha(JSON.stringify(e.payload)), producerUserId: users.owner, verified: true, reason: 'verified',
    }]);
    expect(c.handled[0]).toMatchObject({ id: e.id, name: NAME, payload: e.payload, headers: { source: users.owner, correlationId: 'corr-s1b-0001' } });
    expect(c.provenance()).toEqual(['recorded_verified']);
  });

  it('a forged user_id is refused by the broker: nothing is delivered, nothing is recorded', async () => {
    const c = await consume();
    const conn = await amqp.connect(urlFor('intruder'));
    const ch = await conn.createConfirmChannel();
    const closed = new Promise<string>((resolve) => ch.on('error', (err: Error) => resolve(err.message)));
    const e = envelope(users.owner);
    ch.publish(exchange, NAME, Buffer.from(JSON.stringify(e.payload)), { messageId: e.id, type: NAME, userId: users.owner, headers: e.headers });
    expect(await closed).toMatch(/PRECONDITION_FAILED/);
    await conn.close().catch(() => undefined);
    await sleep(300);
    expect(c.records).toEqual([]);
    expect(c.handled).toEqual([]);
  });

  it('a forged source header from another broker user is delivered and recorded UNVERIFIED (observe-only: the handler still runs)', async () => {
    const c = await consume();
    const e = envelope(users.owner); // the header claims the owner; the broker user is the intruder
    await publisher('intruder').publish(e);
    await waitFor(() => c.handled.length === 1);
    expect(c.records).toEqual([expect.objectContaining({ source: users.owner, producerUserId: users.intruder, exchange, routingKey: NAME, verified: false, reason: 'source_mismatch' })]);
    expect(c.provenance()).toEqual(['recorded_unverified']);
  });

  it('a copy injected through the default exchange is NOT an original delivery: nothing recorded, no provenance invented', async () => {
    const c = await consume();
    const conn = await amqp.connect(urlFor('intruder'));
    const ch = await conn.createConfirmChannel();
    const e = envelope(users.owner);
    ch.sendToQueue(c.queue, Buffer.from(JSON.stringify(e.payload)), { messageId: e.id, type: NAME, userId: users.intruder, headers: e.headers });
    await ch.waitForConfirms();
    await conn.close();
    await waitFor(() => c.handled.length === 1);
    expect(c.records).toEqual([]);
    expect(c.provenance()).toEqual(['not_original']);
  });

  it('a store failure holds and REQUEUES the original: the redelivery keeps its exchange, routing key and user_id; no retry or dead-letter copy', async () => {
    const c = await consume({
      store: async (_o, n) => {
        if (n === 1) throw new Error('database unavailable');
        return 'recorded';
      },
    });
    const e = envelope(users.owner);
    await publisher('owner').publish(e);
    await waitFor(() => c.handled.length === 1);
    expect(c.attempts()).toBe(2);
    expect(c.records).toHaveLength(1); // the first attempt never resolved
    expect(c.records[0]).toMatchObject({ exchange, routingKey: NAME, producerUserId: users.owner, verified: true });
    expect(c.handled).toHaveLength(1); // never ran before the record was committed
    expect(c.observations.filter((o) => o.type === 'consume').map((o) => (o.type === 'consume' ? `${o.outcome}:${o.redelivered}` : ''))).toEqual(['provenance_deferred:false', 'processed:true']);
    expect(await depth(retryQueueName(c.queue))).toBe(0);
    expect(await depth(deadQueueName(c.queue))).toBe(0);
    expect(c.notices.some((n) => n.startsWith('event_provenance_deferred'))).toBe(true);
  });

  it('a retry republished by the consumer is NOT re-recorded as an original: it carries the consumer identity through the default exchange', async () => {
    const c = await consume({
      handler: async (_e, n) => {
        if (n === 1) throw new Error('transient');
      },
    });
    const e = envelope(users.owner);
    await publisher('owner').publish(e);
    await waitFor(() => c.handled.length === 2);
    expect(c.records).toHaveLength(1);
    expect(c.records[0]).toMatchObject({ producerUserId: users.owner, verified: true });
    expect(c.provenance()).toEqual(['recorded_verified', 'not_original']);
    expect(c.handled[1]).toMatchObject({ id: e.id, headers: { retryCount: 1, source: users.owner } }); // retry behaviour unchanged
  });

  it('a permanent failure is dead-lettered exactly as before, after its provenance was recorded once', async () => {
    const c = await consume({
      handler: async () => {
        throw new PermanentEventFailure('malformed_payload');
      },
    });
    const e = envelope(users.owner);
    await publisher('owner').publish(e);
    await waitFor(async () => (await depth(deadQueueName(c.queue))) === 1);
    expect(c.records).toHaveLength(1);
    expect(c.handled).toHaveLength(1);
    expect(c.observations.filter((o) => o.type === 'consume').map((o) => (o.type === 'consume' ? o.outcome : ''))).toEqual(['dead_lettered_permanent']);
  });
});
