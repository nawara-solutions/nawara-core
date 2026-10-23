import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import amqp, { type Channel, type ChannelModel, type GetMessage } from 'amqplib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DbService, OutboxRelay, OutboxService, ProducerReemission, kitMigrationsDir, listMigrationFiles, migrationOwnership, reemissionPolicy, runMigrations,
  RabbitMqEventBus, type ProducerReemissionOptions, type ReemissionIntent, type ReemissionTransition,
} from '../src/index.js';
import { BrokerProxy, createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { ownedBrokerResources } from './support/broker-resources.js';
import { describeWithEnv } from './support/env.js';

/**
 * Core V2 S1c-3 R1 (ADR-0057 §13.7 "S0-C4") against a REAL PostgreSQL and a REAL RabbitMQ. Everything is synthetic and disposable: a
 * database created for this file, a producer migration written to a temporary directory, this file's own exchange and queues, and one
 * broker user created for this file and deleted at the end (its password is random and never printed). The broker user must be named
 * like the approved producer (`user_id` = `source` = producer, ADR-0057 §13.2), so the suite refuses to run if such a user already exists
 * on the broker: it never changes a user it did not create. No real event is re-emitted, and nothing connects to production.
 */
const owned = ownedBrokerResources();
const hex = (n: number) => randomBytes(n).toString('hex');
const prefix = `r1${hex(4)}`;
const PRODUCER = 'payment-service';
const waitFor = async <T>(probe: () => Promise<T | false | undefined>, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await probe();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
};

describeWithEnv('S1c-3 R1 producer re-emission (real PostgreSQL and RabbitMQ)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
  const password = hex(24);
  const mgmt = new URL(env.TEST_RABBITMQ_MGMT_URL);
  const mgmtAuth = `Basic ${Buffer.from(`${decodeURIComponent(mgmt.username)}:${decodeURIComponent(mgmt.password)}`).toString('base64')}`;
  const api = async (method: string, path: string, body?: unknown) =>
    fetch(`${mgmt.origin}/api${path}`, { method, headers: { authorization: mgmtAuth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const target = new URL(env.TEST_RABBITMQ_URL);
  const urlFor = (base: string) => {
    const u = new URL(base);
    u.username = encodeURIComponent(PRODUCER);
    u.password = encodeURIComponent(password);
    return u.toString();
  };
  const exchange = owned.exchange(`${prefix}.events`);
  const tapQueue = owned.queue(`${prefix}.tap`);
  let createdUser = false;
  let testDb: TestDatabase;
  let foreignDb: TestDatabase;
  let db: DbService;
  let foreign: DbService;
  let observer: ChannelModel;
  let proxy: BrokerProxy;
  let migrationsDir: string;
  const buses: RabbitMqEventBus[] = [];
  const notices: string[] = [];
  const bus = (url = urlFor(env.TEST_RABBITMQ_URL), extra: Partial<ConstructorParameters<typeof RabbitMqEventBus>[0]> = {}) => {
    const b = new RabbitMqEventBus({ url, exchange, connectTimeoutMs: 2000, confirmTimeoutMs: 2000, onNotice: (m) => notices.push(m), ...extra });
    buses.push(b);
    return b;
  };
  const outbox = new OutboxService();
  /** Rows the producer's (synthetic) publication history establishes as published by pipeline v1. */
  const evidenced = new Set<string>();
  const intents: ReemissionIntent[] = [];
  const transitions: ReemissionTransition[] = [];
  let ownership: ProducerReemissionOptions['ownership'];

  const reemission = (over: Partial<ProducerReemissionOptions> = {}) => new ProducerReemission({
    policy: reemissionPolicy(PRODUCER, [{ name: 'payment.succeeded', version: 1 }, { name: 'payment.failed', version: 1 }, { name: 'payment.cancelled', version: 1 }]),
    environment: 'test',
    db,
    ownership,
    evidence: { pipelineVersionOf: async (_q, row) => (evidenced.has(row.id) ? 1 : undefined) },
    authorizer: { verify: async (req, ctx) => ({ ...req, ...ctx, approvalRef: `test-approval-${prefix}` }) },
    attempts: {
      commitIntent: async (i) => (intents.push(i), { attemptId: i.attemptId, intentCommitted: true, auditIntentRecorded: true }),
      appendTransition: async (t) => void transitions.push(t),
    },
    publisher: bus(),
    ...over,
  });
  let reader: Channel;
  const take = () => waitFor(async () => ((await reader.get(tapQueue, { noAck: true })) as GetMessage | false) || undefined);
  const drain = async () => {
    const ch = await observer.createChannel();
    await ch.purgeQueue(tapQueue);
    await ch.close();
  };
  const published = async (name: string, payload: Record<string, unknown>) => {
    const id = await db.tx((q) => outbox.enqueue(q, { name, payload, correlationId: `corr-${prefix}` }));
    return id;
  };
  const row = async (id: string) => (await db.query(`SELECT payload::text AS text, "publishedAt", attempts, "lastError" FROM outbox WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    const existing = await api('GET', `/users/${PRODUCER}`);
    if (existing.status !== 404) throw new Error(`the broker already has a ${PRODUCER} user: this suite never changes a user it did not create`);
    const own = `^${prefix}\\..*$`;
    expect((await api('PUT', `/users/${PRODUCER}`, { password, tags: '' })).ok).toBe(true);
    createdUser = true;
    expect((await api('PUT', `/permissions/%2F/${PRODUCER}`, { configure: own, write: own, read: own })).ok).toBe(true);
    // topic authorization, as §13.1 grants per family: payment.failed is NOT writable, so its publish is refused by the broker
    expect((await api('PUT', `/topic-permissions/%2F/${PRODUCER}`, { exchange, write: '^payment\\.(succeeded|cancelled)$', read: '.*' })).ok).toBe(true);

    testDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'reemission');
    foreignDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'reemission_foreign');
    migrationsDir = mkdtempSync(join(tmpdir(), `${prefix}-migrations-`));
    writeFileSync(join(migrationsDir, '0001_synthetic_producer.sql'), `-- synthetic producer schema for ${prefix}\nCREATE TABLE synthetic_marker (id int PRIMARY KEY);\n`);
    await runMigrations(testDb.url, [kitMigrationsDir, migrationsDir]);
    await runMigrations(foreignDb.url, [kitMigrationsDir]);
    ownership = migrationOwnership(listMigrationFiles([migrationsDir]).map((f) => ({ name: f.name, checksum: f.checksum })));
    db = new DbService({ url: testDb.url, max: 5 });
    foreign = new DbService({ url: foreignDb.url, max: 2 });

    observer = await amqp.connect(env.TEST_RABBITMQ_URL);
    const ch = await observer.createChannel();
    await ch.assertExchange(exchange, 'topic', { durable: true });
    await ch.assertQueue(tapQueue, { durable: true });
    for (const key of ['payment.succeeded', 'payment.failed']) await ch.bindQueue(tapQueue, exchange, key); // payment.cancelled: no binding
    await ch.close();
    reader = await observer.createChannel();
    proxy = new BrokerProxy({ host: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
  });
  afterAll(async () => {
    proxy?.thaw();
    for (const b of buses) await b.close().catch(() => undefined);
    await proxy?.sever().catch(() => undefined);
    await observer?.close().catch(() => undefined);
    await db?.onApplicationShutdown();
    await foreign?.onApplicationShutdown();
    await testDb?.drop();
    await foreignDb?.drop();
    if (migrationsDir) rmSync(migrationsDir, { recursive: true, force: true });
    if (createdUser) await api('DELETE', `/users/${PRODUCER}`);
  });

  it('pipeline v1 over real jsonb: the relay\'s delivery and the re-emission are byte-identical, and match the fixture', async () => {
    await drain();
    // written in an order and form PostgreSQL normalizes: what goes out is the serialization of what jsonb returns
    const id = await published('payment.succeeded', {
      zeta: 1, a: 2, mid: 3, nested: { b: [1, { d: null, c: true }], a: [] }, gone: undefined, nil: null,
      n: { i: 42, f: 0.1 + 0.2, big: 1e21, tiny: 1e-7, neg: -0 }, s: 'say "hi"\\ é€😀 \n\u0001', at: '2026-10-23T08:15:30.123456Z',
    });
    evidenced.add(id);
    const relay = new OutboxRelay(db, bus(), { source: PRODUCER });
    expect(await relay.drainOnce()).toStrictEqual({ published: 1, failed: 0 });
    const original = await take();
    const before = await row(id);

    const r = await reemission().reemit({ eventId: id, eventName: 'payment.succeeded', reason: 'consumer_outage' });
    expect(r.publish).toStrictEqual({ outcome: 'confirmed' });
    const again = await take();

    const expected = '{"a":2,"n":{"f":0.30000000000000004,"i":42,"big":1e+21,"neg":0,"tiny":1e-7},"s":"say \\"hi\\"\\\\ é€😀 \\n\\u0001","at":"2026-10-23T08:15:30.123456Z","mid":3,"nil":null,"zeta":1,"nested":{"a":[],"b":[1,{"c":true,"d":null}]}}';
    expect(original.content.toString('utf8')).toBe(expected);
    expect(again.content.equals(original.content)).toBe(true);
    expect(again.fields.exchange).toBe(exchange);
    expect(again.fields.routingKey).toBe(original.fields.routingKey);
    expect(again.properties).toStrictEqual(original.properties); // message id, type, user_id, timestamp, headers, persistence
    expect(again.properties.userId).toBe(PRODUCER);
    expect(again.properties.headers).toMatchObject({ eventId: id, source: PRODUCER, version: 1, correlationId: `corr-${prefix}` });
    expect(await row(id)).toStrictEqual(before); // the outbox row is untouched: same payload, publication stamp and attempts
  });

  it('repeated re-emission never creates a new event id, and the published row stays immutable', async () => {
    await drain();
    const id = await published('payment.succeeded', { k: 'v' });
    evidenced.add(id);
    await new OutboxRelay(db, bus(), { source: PRODUCER }).drainOnce();
    await take();
    const re = reemission();
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await re.reemit({ eventId: id, eventName: 'payment.succeeded', reason: 'consumer_outage' }));
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await take()).properties.messageId);
    expect(ids).toStrictEqual([id, id, id]);
    expect(new Set(results.map((x) => x.attemptId)).size).toBe(3);
    await expect(db.query(`UPDATE outbox SET payload = '{"k":"forged"}' WHERE id = $1`, [id])).rejects.toThrow('outbox events are immutable');
    await expect(db.query(`UPDATE outbox SET "publishedAt" = NULL WHERE id = $1`, [id])).rejects.toThrow('cannot be republished or unpublished');
  });

  it('an unpublished row is refused and stays the relay\'s; a row without publication evidence is refused', async () => {
    await drain();
    const pending = await published('payment.succeeded', { p: 1 });
    evidenced.add(pending);
    await expect(reemission().reemit({ eventId: pending, eventName: 'payment.succeeded', reason: 'consumer_outage' })).rejects.toThrow('row_unpublished');
    expect((await row(pending)).publishedAt).toBeNull();
    await new OutboxRelay(db, bus(), { source: PRODUCER }).drainOnce();
    expect((await take()).properties.messageId).toBe(pending);
    const unevidenced = await published('payment.succeeded', { p: 2 });
    await new OutboxRelay(db, bus(), { source: PRODUCER }).drainOnce();
    await take();
    await expect(reemission().reemit({ eventId: unevidenced, eventName: 'payment.succeeded', reason: 'consumer_outage' })).rejects.toThrow('pipeline_unknown');
    await expect(reemission().reemit({ eventId: randomUUID(), eventName: 'payment.succeeded', reason: 'consumer_outage' })).rejects.toThrow('row_missing');
    await expect(reemission().reemit({ eventId: pending, eventName: 'payment.failed', reason: 'consumer_outage' })).rejects.toThrow('row_name_mismatch');
  });

  it('another database (kit tables only, no producer migration) is refused before any row is read', async () => {
    await expect(reemission({ db: foreign }).reemit({ eventId: randomUUID(), eventName: 'payment.succeeded', reason: 'consumer_outage' })).rejects.toThrow('database_ownership_unconfirmed');
  });

  it('a routing key no queue is bound to is reported unroutable (mandatory), not confirmed', async () => {
    const id = await published('payment.cancelled', { c: 1 });
    evidenced.add(id);
    await new OutboxRelay(db, bus(), { source: PRODUCER }).drainOnce(); // the ordinary publish of it is silently dropped, as before
    const r = await reemission().reemit({ eventId: id, eventName: 'payment.cancelled', reason: 'consumer_outage' });
    expect(r.publish).toStrictEqual({ outcome: 'unroutable' });
    expect(transitions.at(-1)).toMatchObject({ attemptId: r.attemptId, from: 'publishing', to: 'unroutable' });
  });

  it('a publish the broker refuses (no topic permission for the family) is a definite failure, and nothing is routed', async () => {
    await drain();
    const id = await published('payment.failed', { f: 1 });
    await db.query(`UPDATE outbox SET "publishedAt" = now() WHERE id = $1`, [id]); // as if published (the relay could not: no permission)
    evidenced.add(id);
    const r = await reemission().reemit({ eventId: id, eventName: 'payment.failed', reason: 'consumer_outage' });
    expect(r.publish).toStrictEqual({ outcome: 'failed', stage: 'refused' });
    await new Promise((res) => setTimeout(res, 300));
    const ch = await observer.createChannel();
    expect((await ch.checkQueue(tapQueue)).messageCount).toBe(0);
    await ch.close();
  });

  it('a confirmation lost on a silent broker is uncertain, never failed: the broker did take the message', async () => {
    await drain();
    const id = await published('payment.succeeded', { u: 1 });
    evidenced.add(id);
    await new OutboxRelay(db, bus(), { source: PRODUCER }).drainOnce();
    await take();
    const frozenBus = bus(urlFor(proxy.url), { confirmTimeoutMs: 500, heartbeatS: 5 });
    const re = reemission({ publisher: frozenBus });
    // the broker goes silent exactly between the re-emission channel's setup and its publish (test-side hook on the real channel)
    type Conn = { createConfirmChannel(): Promise<{ assertExchange(...a: unknown[]): Promise<unknown> }> };
    const conn = await (frozenBus as unknown as { connect(): Promise<Conn> }).connect();
    const open = conn.createConfirmChannel.bind(conn);
    conn.createConfirmChannel = async () => {
      const ch = await open();
      const assertExchange = ch.assertExchange.bind(ch);
      ch.assertExchange = async (...a: unknown[]) => {
        const done = await assertExchange(...a);
        proxy.freeze();
        return done;
      };
      return ch;
    };
    const r = await re.reemit({ eventId: id, eventName: 'payment.succeeded', reason: 'consumer_outage' });
    expect(r.publish).toStrictEqual({ outcome: 'uncertain', stage: 'confirm_timeout' });
    expect(transitions.at(-1)).toMatchObject({ attemptId: r.attemptId, to: 'uncertain', stage: 'confirm_timeout' });
    proxy.thaw();
    expect((await take()).properties.messageId).toBe(id); // the broker had it all along
  });

  it('operational notices name the event and the outcome only: never the body, a credential or a URL', () => {
    const text = notices.join('\n');
    expect(text).toContain('event_reemission_publish');
    expect(text).not.toContain(password);
    expect(text).not.toMatch(/amqp:\/\/|zeta|nested|say|"k"/);
  });
});
