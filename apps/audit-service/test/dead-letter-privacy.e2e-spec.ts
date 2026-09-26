import { randomUUID } from 'node:crypto';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { RabbitMqEventBus, kitMigrationsDir, replayDeadLetter, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { AUDIT_EXCHANGE, AUDIT_QUEUE } from '../src/ingestion/ingestion.constants.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { DEAD_QUEUE, RETRY_QUEUE, auditEnvelope, deleteAuditQueues, depth, publishRaw } from './support/broker.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/** Synthetic markers only (never a real credential or person). */
const SECRET = 'STAGE18_SECRET_MARKER';
const TOKEN = 'STAGE18_TOKEN_MARKER';
const EMAIL = 'privacy-marker@example.invalid';
const PHONE = '+99912345678';
const MARKERS = [SECRET, TOKEN, EMAIL, PHONE];
/** Headers a hostile publisher attaches to any message. */
const HOSTILE_HEADERS = { 'x-debug': SECRET, authorization: `Bearer ${TOKEN}`, 'x-user-email': EMAIL };

interface Dead {
  messageId: unknown;
  type: unknown;
  headers: Record<string, unknown>;
  content: string;
}

/**
 * Stage 18.8 (18.5 finding F3): a refused audit message must not survive verbatim in `audit-service.audit.dead`. Real RabbitMQ 3.13 and
 * PostgreSQL 16; every marker is then searched in the audit table, every dead-letter body AND header, and every captured log line.
 */
describeWithEnv('dead-letter privacy (real RabbitMQ, real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let d: ProvisionedDatabase;
  let conn: ChannelModel;
  let ch: Channel;
  let publisher: RabbitMqEventBus;
  const apps: TestApp[] = [];

  const start = async (retry = { maxRetries: 1, delayMs: 200 }) => {
    const bus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: AUDIT_EXCHANGE, prefetch: 5, retry, connectTimeoutMs: 1500 });
    const t = await createTestApp({ databaseUrl: d.appUrl, rabbitmqUrl: env.TEST_RABBITMQ_URL, bus });
    apps.push(t);
    await vi.waitFor(async () => expect((await request(t.app.getHttpServer()).get('/ready')).body).toEqual({ status: 'ready' }), { timeout: 20_000, interval: 100 });
    return t;
  };
  const until = (cond: () => Promise<boolean> | boolean, timeout = 20_000) => vi.waitFor(async () => expect(await cond()).toBe(true), { timeout, interval: 100 });
  /** Publishes a kit envelope as the relay does, plus hostile extra headers. */
  const publish = async (e: EventEnvelope, extra: Record<string, unknown> = HOSTILE_HEADERS) =>
    publishRaw(ch, { routingKey: e.name, type: e.name, messageId: e.id, body: JSON.stringify(e.payload), headers: { ...e.headers, ...extra } });
  const drain = async (n: number): Promise<Dead[]> => {
    const got: Dead[] = [];
    await until(async () => {
      for (;;) {
        const m = await ch.get(DEAD_QUEUE, { noAck: true });
        if (!m) break;
        got.push({ messageId: m.properties.messageId, type: m.properties.type, headers: m.properties.headers ?? {}, content: m.content.toString('latin1') });
      }
      return got.length >= n;
    });
    return got;
  };
  const everywhere = async (dead: Dead[]) => {
    const stored = JSON.stringify(await sql(d.adminUrl, 'SELECT * FROM audit_record'));
    const logs = ALL_LOGS.map((l) => JSON.stringify(l)).join('\n');
    for (const m of MARKERS) {
      expect(stored, `audit_record ${m}`).not.toContain(m);
      expect(logs, `logs ${m}`).not.toContain(m);
      for (const x of dead) {
        expect(x.content, `DLQ body ${m}`).not.toContain(m);
        expect(JSON.stringify(x.headers), `DLQ headers ${m}`).not.toContain(m);
        expect(String(x.messageId), `DLQ message id ${m}`).not.toContain(m);
        expect(String(x.type), `DLQ type ${m}`).not.toContain(m);
      }
    }
  };

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'adlq');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    ch = await conn.createChannel();
    ch.on('error', () => undefined);
    await deleteAuditQueues(ch);
    publisher = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: AUDIT_EXCHANGE });
  });
  afterEach(async () => {
    for (const t of apps.splice(0)) await t.app.close();
    for (const q of [AUDIT_QUEUE, RETRY_QUEUE, DEAD_QUEUE]) await ch.purgeQueue(q).catch(() => undefined);
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS true`).catch(() => undefined);
  });
  afterAll(async () => {
    await publisher?.close();
    await deleteAuditQueues(ch).catch(() => undefined);
    await conn?.close().catch(() => undefined);
    await d?.drop();
  });

  const p = () => JSON.parse(JSON.stringify(auditEnvelope('membership.revoked').payload)) as Record<string, any>;
  const REFUSED: Array<[string, (x: Record<string, any>) => Record<string, any>, string]> = [
    ['a credential-named field', (x) => ({ ...x, changes: { ...x.changes, password: SECRET } }), 'sensitive_field'],
    ['a nested credential field', (x) => ({ ...x, actor: { ...x.actor, token: TOKEN } }), 'sensitive_field'],
    ['a secret-shaped value', (x) => ({ ...x, changes: { authority: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${TOKEN}` } }), 'sensitive_value'],
    ['an email as the actor id', (x) => ({ ...x, actor: { type: 'user', id: EMAIL, userKind: 'member' } }), 'invalid_actor'],
    ['a phone number as a change value', (x) => ({ ...x, changes: { authority: PHONE, was_admin: false } }), 'invalid_changes'],
    ['free text in a resource id', (x) => ({ ...x, resource: { type: 'membership', id: `Ahmed ${SECRET}` } }), 'invalid_resource'],
    ['an unknown top-level field', (x) => ({ ...x, note: SECRET }), 'unknown_field'],
    ['a nested blob', (x) => ({ ...x, changes: { authority: { a: { b: SECRET } } } }), 'invalid_payload'],
    ['an array', (x) => ({ ...x, changes: { authority: [SECRET, EMAIL] } }), 'invalid_changes'],
    ['a huge value', (x) => ({ ...x, changes: { authority: SECRET.repeat(400) } }), 'sensitive_value'], // a long token-like string is secret-shaped before it is oversize
  ];

  it('every refused event (sensitive field / value, contact data, free text, blobs, arrays, oversize) is dead-lettered REDACTED: no marker in the DLQ body, headers, ids, the table or the logs', async () => {
    await start();
    const events = REFUSED.map(([, mutate]) => auditEnvelope('membership.revoked', { payload: mutate(p()) }));
    for (const e of events) await publish(e);
    const dead = await drain(events.length);
    expect(dead).toHaveLength(events.length);
    for (const x of dead) {
      expect(x.headers['x-nawara-body-redacted']).toBe('true');
      expect(x.headers['x-nawara-failure']).toBe('permanent');
      const doc = JSON.parse(x.content);
      expect(Object.keys(doc).sort()).toEqual(['bodyBytes', 'failure', 'reason', 'redacted']);
      expect(doc).toMatchObject({ redacted: true, failure: 'permanent' });
      // Forensics still available: which (validated) event, claimed source, correlation, when, why.
      expect(x.headers).toMatchObject({ source: 'auth-service', 'x-nawara-consumer': AUDIT_QUEUE });
      expect(typeof x.headers['x-nawara-failed-at']).toBe('string');
      expect(Object.keys(x.headers).filter((k) => !k.startsWith('x-nawara-')).sort()).toEqual(['correlationId', 'eventId', 'occurredAt', 'source', 'version']);
    }
    expect(dead.map((x) => x.headers['x-nawara-failure-reason']).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(REFUSED.map(([, , r]) => r).sort((a, b) => a.localeCompare(b)));
    await everywhere(dead);
  });

  it('MALFORMED input (binary, non-JSON, a hostile message id / type) is dead-lettered redacted; an unsafe id or type is not echoed', async () => {
    await start();
    await publishRaw(ch, { toQueue: true, messageId: `id ${SECRET}`, type: 'audit.membership.revoked', body: Buffer.from([0xff, 0x00, ...Buffer.from(EMAIL), 0xfe]), headers: HOSTILE_HEADERS });
    await publishRaw(ch, { toQueue: true, messageId: randomUUID(), type: `audit ${TOKEN}`, body: `not json ${SECRET}`, headers: HOSTILE_HEADERS });
    await publishRaw(ch, { toQueue: true, messageId: randomUUID(), type: 'audit.membership.revoked', body: `["${PHONE}"]`, headers: { ...HOSTILE_HEADERS, source: SECRET } });
    const dead = await drain(3);
    for (const x of dead) {
      expect(x.headers['x-nawara-body-redacted']).toBe('true');
      expect(JSON.parse(x.content)).toMatchObject({ redacted: true });
    }
    expect(dead.map((x) => x.headers['x-nawara-failure'])).toEqual(['malformed', 'malformed', 'malformed']);
    await everywhere(dead);
  });

  it('a refusal a catalog upgrade can reverse (an unknown action) keeps its body byte-for-byte for replay, but NOT the hostile headers', async () => {
    await start();
    const payload = { ...p(), action: 'membership.future_thing' };
    const e = auditEnvelope('membership.revoked', { payload, name: 'audit.membership.future_thing' });
    await publish(e);
    const [x] = await drain(1);
    expect(x!.headers['x-nawara-failure-reason']).toBe('unknown_action');
    expect(x!.headers['x-nawara-body-redacted']).toBeUndefined();
    expect(JSON.parse(x!.content)).toEqual(payload);
    expect(x!.messageId).toBe(e.id);
    expect(Object.keys(x!.headers).filter((k) => !k.startsWith('x-nawara-')).sort()).toEqual(['correlationId', 'eventId', 'occurredAt', 'source', 'version']);
    await everywhere([x!]);
  });

  it('an EVENT-ID CONFLICT keeps the (validated) conflicting evidence for investigation, never overwrites the stored record, and drops hostile headers', async () => {
    await start();
    const e = auditEnvelope('file.deleted');
    await publisher.publish(e);
    await until(async () => (await sql(d.adminUrl, `SELECT 1 FROM audit_record WHERE "eventId" = $1`, [e.id])).length === 1);
    const before = await sql(d.adminUrl, `SELECT * FROM audit_record WHERE "eventId" = $1`, [e.id]);
    await publish({ ...e, payload: { ...e.payload, organizationId: randomUUID() } });
    const [x] = await drain(1);
    expect(x!.headers['x-nawara-failure-reason']).toBe('event_id_conflict');
    expect(x!.headers['x-nawara-body-redacted']).toBeUndefined();
    expect(await sql(d.adminUrl, `SELECT * FROM audit_record WHERE "eventId" = $1`, [e.id])).toEqual(before);
    await everywhere([x!]);
  });

  it('RETRIES EXHAUSTED (database refusing) keeps the valid body for replay, hostile headers stripped; the replay stores it once', async () => {
    await start({ maxRetries: 1, delayMs: 200 });
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS false`);
    await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [d.name]);
    const e = auditEnvelope('membership.revoked');
    await publish(e);
    await until(async () => (await depth(ch, DEAD_QUEUE)) === 1, 30_000);
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS true`);
    const m = await ch.get(DEAD_QUEUE, { noAck: false });
    if (!m) throw new Error('no dead letter');
    expect(m.properties.headers?.['x-nawara-failure']).toBe('retries_exhausted');
    expect(JSON.stringify(m.properties.headers)).not.toMatch(/STAGE18|privacy-marker|authorization/i);
    expect(JSON.parse(m.content.toString())).toEqual(e.payload);
    ch.nack(m, false, true);
    await until(async () => (await replayDeadLetter(conn, DEAD_QUEUE, e.id, { waitMs: 10_000 })).outcome === 'consumed', 30_000);
    await until(async () => (await sql(d.adminUrl, `SELECT 1 FROM audit_record WHERE "eventId" = $1`, [e.id])).length === 1);
  }, 60_000);

  it('a REDACTED dead letter is never replayed (`not_replayable`): it stays in the DLQ unchanged and nothing reaches the table', async () => {
    await start();
    const e = auditEnvelope('membership.revoked', { payload: { ...p(), note: SECRET } });
    await publish(e);
    await until(async () => (await depth(ch, DEAD_QUEUE)) === 1);
    const r = await replayDeadLetter(conn, DEAD_QUEUE, e.id, { waitMs: 2_000 });
    expect(r.outcome).toBe('not_replayable');
    expect(await depth(ch, DEAD_QUEUE)).toBe(1);
    expect(await sql(d.adminUrl, `SELECT 1 FROM audit_record WHERE "eventId" = $1`, [e.id])).toHaveLength(0);
  });
});
