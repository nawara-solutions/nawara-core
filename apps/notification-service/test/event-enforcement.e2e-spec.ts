import { randomBytes, randomUUID } from 'node:crypto';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus, RabbitMqEventBus, kitMigrationsDir, replayDeadLetter, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { CODE_BEARING_EVENTS, INTAKE_QUEUE } from '../src/intake/event-map.js';
import { createAuthIdentity, type AuthIdentity } from './support/auth-identity.js';
import { TEST_PROVENANCE_KEYS, createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * Core V2 S1e-4 (ADR-0057 §13.5, "S0-C6" Notification; ADR-0052 decision 5) certification of Notification's STRICT intake over a REAL
 * RabbitMQ and a REAL PostgreSQL, through the real module graph:
 * - only a verified Auth original (the generated, least-privilege `auth-service` broker identity), its verified duplicate or a replay
 *   matching the stored verified keyed commitment reaches the intake; every other delivery (no `user_id`, another identity, a forged
 *   `source`, a default-exchange injection, a mismatched body, a match against unverified evidence only, a contradiction, a retired key)
 *   is refused BEFORE the intake: no intent, no delivery, no first-writer slot;
 * - a provenance or key failure is HELD (requeued, the intake never running) and later succeeds;
 * - every dead-letter copy the consumer writes goes through `notificationDeadLetterPolicy`: a code-bearing body is redacted, and the
 *   DLQ bytes are inspected for the synthetic code and destinations;
 * - the BROKER-driven paths (the shared `nawara.events.dlx` fanout and per-message expiry) are exercised too: they bypass any application
 *   redactor, so what they can carry is pinned (only what a publisher itself sent; never a genuine Auth publication, which carries no
 *   expiry onto a queue without TTL), and a replay of such a copy is still refused before the intake.
 * The intake queue is the production name, so its queues are deleted before and after (a disposable / dev broker only). Every code,
 * destination and key here is SYNTHETIC.
 */
const EXCHANGE = 'nawara.events';
const DLX = `${EXCHANGE}.dlx`;
const DEAD = `${INTAKE_QUEUE}.dead`;
const CODE = '481203';
const EMAIL = 's1e4-member@example.test';
const PHONE = '+21620004812';
const hex = (n: number) => randomBytes(n).toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const future = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const bytes = (e: EventEnvelope) => Buffer.from(JSON.stringify(e.payload)); // exactly what the kit publisher writes

describeWithEnv('S1e-4 Notification strict provenance enforcement (real RabbitMQ, real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
  const INTRUDER = `s1e4${hex(4)}-intruder`;
  const intruderPassword = hex(24);
  const mgmt = new URL(env.TEST_RABBITMQ_MGMT_URL);
  const mgmtAuth = `Basic ${Buffer.from(`${decodeURIComponent(mgmt.username)}:${decodeURIComponent(mgmt.password)}`).toString('base64')}`;
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${mgmt.origin}/api${path}`, { method, headers: { authorization: mgmtAuth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const intruderUrl = () => {
    const u = new URL(env.TEST_RABBITMQ_URL);
    u.username = encodeURIComponent(INTRUDER);
    u.password = encodeURIComponent(intruderPassword);
    return u.toString();
  };
  const P2 = randomBytes(32);
  const notices: string[] = [];
  const allLogs: Array<Record<string, unknown>> = [];
  let identity: AuthIdentity;
  let intruderCreated = false;
  let db: TestDatabase;
  let conn: ChannelModel;
  let ch: Channel;
  let t: TestApp | undefined;
  let owner: RabbitMqEventBus;
  let intruder: RabbitMqEventBus;

  const until = (cond: () => Promise<boolean> | boolean, timeout = 20_000) => vi.waitFor(async () => expect(await cond()).toBe(true), { timeout, interval: 100 });
  const deleteQueues = async () => {
    for (const q of [INTAKE_QUEUE, `${INTAKE_QUEUE}.retry`, DEAD]) await ch.deleteQueue(q).catch(() => undefined);
  };
  const depth = async (q: string) => (await ch.checkQueue(q)).messageCount;
  const payloadFor = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => {
    const dest = { userId: `user-${randomUUID().slice(0, 8)}`, channel: 'email', destination: EMAIL };
    if (name === 'member.contact_verification_requested') return { ...dest, code: CODE, expiresAt: future(600), ...over };
    if (CODE_BEARING_EVENTS.has(name)) return { ...dest, code: CODE, expiresAt: future(3600), timestamp: new Date().toISOString(), ...over };
    return { ...dest, organizationId: randomUUID(), timestamp: new Date().toISOString(), ...over };
  };
  const envelope = (name: string, payload = payloadFor(name), id: string = randomUUID(), headers: Record<string, unknown> = {}): EventEnvelope => ({
    id, name, payload, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'auth-service', version: 1, correlationId: `corr-${id.slice(0, 8)}`, ...headers } as EventEnvelope['headers'],
  });
  const intents = async (id: string) => (await sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM notification WHERE "sourceEventId" = $1`, [id]))[0]!.n;
  const deliveries = async (id: string) =>
    (await sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM notification_delivery d JOIN notification n ON n.id = d."notificationId" WHERE n."sourceEventId" = $1`, [id]))[0]!.n;
  const provenance = (id: string) =>
    sql<Record<string, unknown>>(db.url, `SELECT "producerUserId", verified, reason, "bodyMacKeyId" FROM event_provenance WHERE "eventId" = $1 AND consumer = $2 ORDER BY "firstSeenAt"`, [id, INTAKE_QUEUE]);
  const logged = (prefixText: string, extra = '') => t!.logs.some((l) => String(l.msg).startsWith(prefixText) && String(l.msg).includes(extra));
  const notice = (start: string, id: string, extra = '') => notices.some((m) => m.startsWith(start) && m.includes(`event=${id}`) && m.includes(extra));
  /** The dead-letter copy of message `id` (removed from the DLQ, with every other copy seen meanwhile), once it arrived. */
  const takeDead = async (id: string) => {
    const seen: amqp.GetMessage[] = [];
    let found: amqp.GetMessage | undefined;
    await until(async () => {
      for (;;) {
        const m = await ch.get(DEAD, { noAck: true });
        if (!m) break;
        seen.push(m);
      }
      found = seen.find((m) => m.properties.messageId === id);
      return found !== undefined;
    });
    const h = found!.properties.headers ?? {};
    return { reason: h['x-nawara-failure-reason'], failure: h['x-nawara-failure'], redacted: h['x-nawara-body-redacted'] === 'true', headers: h, content: found!.content, raw: found! };
  };
  /** A redacted copy is exactly the kit's document: no byte of the original body (code, destination) survives. */
  const expectSanitized = (dead: Awaited<ReturnType<typeof takeDead>>, original: Buffer) => {
    expect(dead.redacted).toBe(true);
    const doc = JSON.parse(dead.content.toString('utf8')) as Record<string, unknown>;
    expect(doc).toEqual({ redacted: true, failure: dead.failure, reason: dead.reason, bodyBytes: original.length });
    const text = `${dead.content.toString('latin1')} ${JSON.stringify(dead.headers)}`;
    for (const secret of [CODE, EMAIL, PHONE]) expect(text).not.toContain(secret);
  };
  /** Straight into the intake queue through the default exchange, as the intruder: a forged replay. */
  const inject = async (body: Buffer, e: EventEnvelope) => {
    const c = await amqp.connect(intruderUrl());
    const cc = await c.createConfirmChannel();
    cc.sendToQueue(INTAKE_QUEUE, body, { persistent: true, contentType: 'application/json', messageId: e.id, type: e.name, userId: INTRUDER, headers: e.headers });
    await cc.waitForConfirms();
    await c.close();
  };
  /** To the event exchange on the admin connection: no `user_id` at all. */
  const publishAnonymous = async (e: EventEnvelope, extra: Record<string, unknown> = {}) => {
    const cc = await conn.createConfirmChannel();
    cc.publish(EXCHANGE, e.name, bytes(e), { persistent: true, contentType: 'application/json', messageId: e.id, type: e.name, headers: e.headers, ...extra });
    await cc.waitForConfirms();
    await cc.close();
  };
  /** (Re)starts the application on its own RabbitMQ bus (short lookup bound, captured notices) with the given provenance ring. */
  const startApp = async (over: NodeJS.ProcessEnv = {}) => {
    if (t) {
      allLogs.push(...t.logs);
      await t.app.close();
    }
    const bus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, retry: { maxRetries: 1, delayMs: 300 }, replayLookupTimeoutMs: 500, onNotice: (m) => void notices.push(m) });
    t = await createTestApp({ databaseUrl: db.url, bus, env: over });
    await vi.waitFor(async () => expect((await request(t!.app.getHttpServer()).get('/ready')).status).toBe(200), { timeout: 20_000, interval: 100 });
    return t;
  };

  beforeAll(async () => {
    identity = await createAuthIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
    const r = await api('PUT', `/users/${encodeURIComponent(INTRUDER)}`, { password: intruderPassword, tags: '' });
    if (!r.ok) throw new Error(`management API: ${r.status}`);
    intruderCreated = true;
    // the OD-BRK residual S1d-3 demonstrated: an identity that can write the event exchange, the default exchange and the shared DLX
    await api('PUT', `/permissions/%2F/${encodeURIComponent(INTRUDER)}`, { configure: '^nawara\\.events$', write: `^(nawara\\.events|nawara\\.events\\.dlx|amq\\.default)$`, read: '^$' });
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifs1e4');
    await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    ch = await conn.createChannel();
    ch.on('error', () => undefined);
    await deleteQueues();
    owner = new RabbitMqEventBus({ url: identity.url(env.TEST_RABBITMQ_URL) });
    intruder = new RabbitMqEventBus({ url: intruderUrl() });
    await startApp();
  });
  afterAll(async () => {
    if (t) {
      allLogs.push(...t.logs);
      await t.app.close();
    }
    await owner?.close();
    await intruder?.close();
    if (ch) await deleteQueues();
    await conn?.close().catch(() => undefined);
    await identity?.remove();
    if (intruderCreated) await api('DELETE', `/users/${encodeURIComponent(INTRUDER)}`);
    await db?.drop();
  });

  it('subscribes strictly, with the redacting dead-letter policy', () => {
    expect(logged(`event_intake_started queue=${INTAKE_QUEUE}`, 'enforcement=strict')).toBe(true);
    expect([...CODE_BEARING_EVENTS].sort()).toEqual(['admin.operator_code_issued', 'admin.operator_confirmation_code_issued', 'member.contact_verification_requested']);
  });

  describe('accepted: verified originals, their duplicates and matching replays', () => {
    it('an authenticated Auth original (the generated least-privilege identity) is taken once; its verified duplicate and a matching replay are de-duplicated', async () => {
      const e = envelope('admin.operator_code_issued');
      await owner.publish(e);
      await until(async () => (await intents(e.id)) === 1);
      expect(await deliveries(e.id)).toBe(1);
      expect(await provenance(e.id)).toEqual([{ producerUserId: 'auth-service', verified: true, reason: 'verified', bodyMacKeyId: 'p1' }]);
      await owner.publish(e); // the identical original again (a producer re-send or a broker redelivery: the same exchange and `user_id`)
      await until(() => t!.logs.filter((l) => String(l.msg).startsWith('notification_duplicate') && l.eventId === e.id).length === 1);
      await inject(bytes(e), e); // the same bytes through the default exchange: matches the stored verified commitment
      await until(() => t!.logs.filter((l) => String(l.msg).startsWith('notification_duplicate') && l.eventId === e.id).length === 2);
      expect(await intents(e.id)).toBe(1);
      expect(await deliveries(e.id)).toBe(1);
      expect(await depth(DEAD)).toBe(0);
    });
  });

  describe('refused before the intake: no intent, no delivery, a sanitized dead letter', () => {
    it('no `user_id` at all', async () => {
      const e = envelope('member.contact_verification_requested');
      await publishAnonymous(e);
      const dead = await takeDead(e.id);
      expect(dead).toMatchObject({ failure: 'permanent', reason: 'untrusted_unverified_original' });
      expectSanitized(dead, bytes(e));
      expect(await intents(e.id)).toBe(0);
      expect(await provenance(e.id)).toEqual([expect.objectContaining({ producerUserId: null, verified: false })]); // append-only evidence
    });

    it('another broker identity claiming auth-service', async () => {
      const e = envelope('admin.operator_confirmation_code_issued');
      await intruder.publish(e);
      const dead = await takeDead(e.id);
      expect(dead.reason).toBe('untrusted_unverified_original');
      expectSanitized(dead, bytes(e));
      expect(await intents(e.id)).toBe(0);
    });

    it('a forged `source` header from the genuine Auth identity (a name it does not own under that source)', async () => {
      const e = envelope('member.contact_verification_requested', undefined, undefined, { source: 'billing-service' });
      await owner.publish(e);
      const dead = await takeDead(e.id);
      expect(dead.reason).toBe('untrusted_unverified_original');
      expectSanitized(dead, bytes(e));
      expect(await intents(e.id)).toBe(0);
    });

    it('FIRST-WRITER PRE-EMPTION: a forger publishing the genuine id first claims nothing; the later Auth original is taken with ITS content', async () => {
      const genuine = envelope('admin.operator_code_issued');
      const forged = envelope('admin.operator_code_issued', payloadFor('admin.operator_code_issued', { userId: 'attacker', destination: 'attacker@example.test' }), genuine.id);
      await intruder.publish(forged);
      expectSanitized(await takeDead(genuine.id), bytes(forged));
      expect(await intents(genuine.id)).toBe(0);
      await owner.publish(genuine);
      await until(async () => (await intents(genuine.id)) === 1);
      const [row] = await sql<{ recipientId: string }>(db.url, `SELECT "recipientId" FROM notification WHERE "sourceEventId" = $1`, [genuine.id]);
      expect(row!.recipientId).toBe(genuine.payload.userId);
      expect(await provenance(genuine.id)).toEqual([
        expect.objectContaining({ producerUserId: INTRUDER, verified: false }), // kept as evidence, never promoted or rewritten
        expect.objectContaining({ producerUserId: 'auth-service', verified: true }),
      ]);
      expect(logged('notification_accepted')).toBe(true);
      expect(await depth(DEAD)).toBe(0); // the genuine event was never refused
    });

    it('a default-exchange injection with no stored original', async () => {
      const e = envelope('admin.operator_code_issued');
      await inject(bytes(e), e);
      const dead = await takeDead(e.id);
      expect(dead.reason).toBe('untrusted_replay_no_provenance');
      expectSanitized(dead, bytes(e));
      expect(await intents(e.id)).toBe(0);
      expect(await provenance(e.id)).toEqual([]);
    });

    it('a replay whose bytes differ from the stored verified original (a changed code)', async () => {
      const e = envelope('member.contact_verification_requested');
      await owner.publish(e);
      await until(async () => (await intents(e.id)) === 1);
      const changed = envelope(e.name, { ...e.payload, code: '000417' }, e.id);
      await inject(bytes(changed), changed);
      const dead = await takeDead(e.id);
      expect(dead.reason).toBe('untrusted_replay_mismatch');
      expectSanitized(dead, bytes(changed));
      expect(dead.content.toString('latin1')).not.toContain('000417');
      expect(await intents(e.id)).toBe(1);
    });

    it('a replay matching only UNVERIFIED evidence', async () => {
      const e = envelope('admin.operator_confirmation_code_issued');
      await intruder.publish(e);
      expect((await takeDead(e.id)).reason).toBe('untrusted_unverified_original');
      await inject(bytes(e), e);
      const dead = await takeDead(e.id);
      expect(dead.reason).toBe('untrusted_unverified_replay');
      expectSanitized(dead, bytes(e));
      expect(await intents(e.id)).toBe(0);
    });

    it('a verified original that CONTRADICTS the stored verified one (the same id, another code)', async () => {
      const e = envelope('admin.operator_code_issued');
      await owner.publish(e);
      await until(async () => (await intents(e.id)) === 1);
      const changed = envelope(e.name, { ...e.payload, code: '000903' }, e.id);
      await owner.publish(changed);
      const dead = await takeDead(e.id);
      expect(dead.reason).toBe('untrusted_verified_conflict');
      expectSanitized(dead, bytes(changed));
      expect(dead.content.toString('latin1')).not.toContain('000903');
      expect(await intents(e.id)).toBe(1);
    });

    it('a non-code refusal keeps its (canonical, code-free) body for an operator, and only the validated headers', async () => {
      const e = envelope('membership.approved', undefined, undefined, { 'x-contact': PHONE });
      await intruder.publish(e);
      const dead = await takeDead(e.id);
      expect(dead).toMatchObject({ reason: 'untrusted_unverified_original', redacted: false });
      expect(dead.content.equals(bytes(e))).toBe(true);
      expect(dead.headers['x-contact']).toBeUndefined();
      expect(JSON.stringify(dead.headers)).not.toContain(PHONE);
    });
  });

  describe('holds: a provenance or key failure never decides', () => {
    it('a replay lookup that cannot complete (the provenance table locked past the bound) is held, never refused, then accepted', async () => {
      const e = envelope('member.contact_verification_requested');
      await owner.publish(e);
      await until(async () => (await intents(e.id)) === 1);
      const lock = new pg.Client({ connectionString: db.url });
      await lock.connect();
      try {
        await lock.query('BEGIN');
        await lock.query('LOCK TABLE event_provenance IN ACCESS EXCLUSIVE MODE');
        await inject(bytes(e), e);
        await until(() => notice('event_replay_classified', e.id, 'outcome=replay_lookup_failure'));
        await until(() => notice('event_trust_held', e.id, 'basis=provenance_unavailable'));
        expect(await depth(DEAD)).toBe(0);
        expect(await depth(`${INTAKE_QUEUE}.retry`)).toBe(0);
      } finally {
        await lock.query('ROLLBACK').catch(() => undefined);
        await lock.end();
      }
      await until(() => t!.logs.some((l) => String(l.msg).startsWith('notification_duplicate') && l.eventId === e.id), 30_000);
      expect(await intents(e.id)).toBe(1);
      expect(await depth(DEAD)).toBe(0);
    }, 60_000);

    it('a RETIRED key cannot establish trust: a permanent, sanitized refusal (never a hold, never verified); an UNAVAILABLE one is held', async () => {
      const e = envelope('admin.operator_code_issued');
      await owner.publish(e); // stored under p1
      await until(async () => (await intents(e.id)) === 1);
      // p1 deliberately retired: its rows are unverifiable
      await startApp({ NOTIFICATION_PROVENANCE_KEYS: `p2:${P2.toString('base64')}`, NOTIFICATION_PROVENANCE_ACTIVE_KEY_ID: 'p2', NOTIFICATION_PROVENANCE_RETIRED_KEY_IDS: 'p1' });
      await owner.publish(e);
      const original = await takeDead(e.id);
      expect(original.reason).toBe('untrusted_verified_unverifiable');
      expectSanitized(original, bytes(e));
      await inject(bytes(e), e);
      const replay = await takeDead(e.id);
      expect(replay.reason).toBe('untrusted_replay_unverifiable');
      expectSanitized(replay, bytes(e));
      // p1 neither in the ring nor retired: temporarily unavailable, so held (no refusal, no intake) until it is restored
      await startApp({ NOTIFICATION_PROVENANCE_KEYS: `p2:${P2.toString('base64')}`, NOTIFICATION_PROVENANCE_ACTIVE_KEY_ID: 'p2' });
      await owner.publish(e);
      await until(() => notice('event_trust_held', e.id, 'basis=provenance_unavailable'));
      expect(await depth(DEAD)).toBe(0);
      await startApp({ NOTIFICATION_PROVENANCE_KEYS: TEST_PROVENANCE_KEYS, NOTIFICATION_PROVENANCE_ACTIVE_KEY_ID: 'p1' });
      await until(() => t!.logs.some((l) => String(l.msg).startsWith('notification_duplicate') && l.eventId === e.id), 30_000);
      expect(await intents(e.id)).toBe(1);
      expect(await depth(DEAD)).toBe(0);
    }, 90_000);
  });

  describe('broker-driven dead-lettering (Core V2 OD-BRK-2a: no broker route, so nothing is ever copied raw)', () => {
    /** Live depth of every queue in the vhost (names from the management API, counts from a passive declaration: never read). */
    const vhostTotal = async () => {
      let n = 0;
      for (const { name } of (await (await api('GET', '/queues/%2F')).json()) as Array<{ name: string }>) {
        const c = await conn.createChannel();
        c.on('error', () => undefined);
        n += await c.checkQueue(name).then((x) => x.messageCount, () => 0);
        await c.close().catch(() => undefined);
      }
      return n;
    };
    const stopApp = async () => {
      allLogs.push(...t!.logs);
      await t!.app.close();
      t = undefined;
    };

    it('the work queue has NO broker dead-letter exchange, its `.dead` queue no fanout binding; the retry queue keeps its return routing', async () => {
      const q = (await (await api('GET', `/queues/%2F/${encodeURIComponent(INTAKE_QUEUE)}`)).json()) as { arguments: Record<string, unknown>; policy?: unknown };
      expect(q.arguments).toEqual({});
      expect(q.policy ?? null).toBeNull();
      const retry = (await (await api('GET', `/queues/%2F/${encodeURIComponent(`${INTAKE_QUEUE}.retry`)}`)).json()) as { arguments: Record<string, unknown> };
      expect(retry.arguments).toEqual({ 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': INTAKE_QUEUE });
      const bindings = (await (await api('GET', `/queues/%2F/${encodeURIComponent(DEAD)}/bindings`)).json()) as Array<{ source: string }>;
      expect(bindings.map((b) => b.source)).toEqual(['']); // the default exchange only: never `nawara.events.dlx`
    });

    it('the shared DLX: an injection never reaches Notification\'s dead letters (no binding), and creates no intent', async () => {
      const e = envelope('admin.operator_code_issued', payloadFor('admin.operator_code_issued', { code: '000771' }));
      // Notification no longer declares the shared fanout at all; in production the other consumers (Audit) still do: stand in for them
      await ch.assertExchange(DLX, 'fanout', { durable: true });
      const c = await amqp.connect(intruderUrl());
      const cc = await c.createConfirmChannel();
      cc.publish(DLX, '', bytes(e), { persistent: true, contentType: 'application/json', messageId: e.id, type: e.name, userId: INTRUDER, headers: e.headers });
      await cc.waitForConfirms();
      await c.close();
      await sleep(800);
      expect(await depth(DEAD)).toBe(0);
      expect(await intents(e.id)).toBe(0);
    });

    it('a broker reject WITHOUT requeue of a GENUINE code event discards it: no copy in any queue (raw bytes nowhere), no intent', async () => {
      await stopApp(); // nothing consumes the work queue for a moment: the broker alone decides
      try {
        const e = envelope('admin.operator_code_issued', payloadFor('admin.operator_code_issued', { code: '000773' }));
        await owner.publish(e); // authenticated Auth (synthetic code)
        let m: amqp.GetMessage | false = false;
        await until(async () => !!(m = await ch.get(INTAKE_QUEUE, { noAck: false })));
        expect((m as unknown as amqp.GetMessage).properties.messageId).toBe(e.id);
        const before = await vhostTotal(); // the message is unacknowledged here: not counted
        ch.reject(m as unknown as amqp.GetMessage, false);
        await sleep(800);
        expect(await vhostTotal()).toBe(before); // discarded: it is in no queue at all
        expect(await depth(DEAD)).toBe(0);
        expect(await intents(e.id)).toBe(0);
      } finally {
        await startApp();
      }
    });

    it('a publisher-set expiry discards a code event too (no copy anywhere); a genuine Auth publication carries no expiry at all', async () => {
      const tapQ = (await ch.assertQueue('', { exclusive: true, autoDelete: true })).queue;
      await ch.bindQueue(tapQ, EXCHANGE, 'member.#');
      const genuine = envelope('member.contact_verification_requested');
      await owner.publish(genuine);
      await until(async () => (await intents(genuine.id)) === 1);
      const tapped = await ch.get(tapQ, { noAck: true });
      expect(tapped && tapped.properties.messageId).toBe(genuine.id);
      expect(tapped && tapped.properties.expiration).toBeUndefined();
      await ch.deleteQueue(tapQ);
      await stopApp();
      try {
        const e = envelope('admin.operator_code_issued', payloadFor('admin.operator_code_issued', { code: '000772' }));
        const before = await vhostTotal();
        await publishAnonymous(e, { expiration: '50' });
        await sleep(800);
        expect(await vhostTotal()).toBe(before);
        expect(await depth(DEAD)).toBe(0);
      } finally {
        await startApp();
      }
    });
  });

  it('a bus that cannot enforce never runs the intake in another mode: not ready, `enforcement_unavailable`', async () => {
    const other = await createTestApp({ databaseUrl: db.url, bus: new InMemoryEventBus() });
    try {
      await until(() => other.logs.some((l) => String(l.msg).startsWith('event_intake_waiting reason=enforcement_unavailable')));
      const ready = await request(other.app.getHttpServer()).get('/ready');
      expect(ready.status).toBe(503);
      expect(other.logs.some((l) => String(l.msg).startsWith('event_intake_started'))).toBe(false);
    } finally {
      allLogs.push(...other.logs);
      await other.app.close();
    }
  });

  it('no log line, notice or metric of the suite carries a code, a destination or key material', async () => {
    const text = `${JSON.stringify([...allLogs, ...(t?.logs ?? [])])}\n${notices.join('\n')}\n${(await request(t!.app.getHttpServer()).get('/metrics')).text ?? ''}`;
    for (const secret of [CODE, '000417', '000903', '000771', '000772', EMAIL, PHONE, P2.toString('base64'), TEST_PROVENANCE_KEYS.split(':')[1]!]) expect(text).not.toContain(secret);
    expect(await depth(DEAD)).toBe(0);
  });
});
