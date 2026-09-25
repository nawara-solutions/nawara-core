import { randomUUID } from 'node:crypto';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTIONS } from '@nawara/audit-contract';
import { SAMPLE_IDS, sampleAuditPayload } from '@nawara/audit-contract/testing';
import { RabbitMqEventBus, kitMigrationsDir, replayDeadLetter, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { BrokerProxy } from '@nawara/service-kit/testing';
import { auditMigrationsDir } from '../src/app.module.js';
import { IngestionCounters } from '../src/ingestion/ingestion-counters.js';
import { IngestionService } from '../src/ingestion/ingestion.service.js';
import { AUDIT_EXCHANGE, AUDIT_QUEUE } from '../src/ingestion/ingestion.constants.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { DEAD_QUEUE, RETRY_QUEUE, auditEnvelope, deleteAuditQueues, depth, drainDead, publishRaw, type DeadLetter } from './support/broker.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Stage 18.5: audit ingestion over a REAL RabbitMQ and a REAL PostgreSQL 16, through the real module graph, as the runtime role. The kit
 * publisher emits exactly what a producer's outbox relay emits; a raw amqplib channel plays the hostile or broken publisher. The queue
 * names are the production ones, so the three audit queues are deleted before and after (a throwaway / dev broker only).
 */
describeWithEnv('audit ingestion over a real RabbitMQ (real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let d: ProvisionedDatabase;
  let conn: ChannelModel;
  let ch: Channel;
  let publisher: RabbitMqEventBus;
  const apps: TestApp[] = [];
  const notices: string[] = [];

  /** The kit bus with a short retry delay (the production default is 3 × 5 s; the pipeline suite runs that default). */
  const bus = (url = env.TEST_RABBITMQ_URL, retry = { maxRetries: 2, delayMs: 300 }) =>
    new RabbitMqEventBus({ url, exchange: AUDIT_EXCHANGE, prefetch: 5, retry, connectTimeoutMs: 1500, onNotice: (m) => void notices.push(m) });
  const start = async (over: { rabbitmqUrl?: string; retry?: { maxRetries: number; delayMs: number }; waitReady?: boolean; env?: NodeJS.ProcessEnv } = {}) => {
    const url = over.rabbitmqUrl ?? env.TEST_RABBITMQ_URL;
    const t = await createTestApp({ databaseUrl: d.appUrl, rabbitmqUrl: url, bus: bus(url, over.retry), env: over.env });
    apps.push(t);
    if (over.waitReady !== false) await ready(t);
    return t;
  };
  const ready = (t: TestApp, timeout = 20_000) =>
    vi.waitFor(async () => expect((await request(t.app.getHttpServer()).get('/ready')).body).toEqual({ status: 'ready' }), { timeout, interval: 100 });
  const until = (cond: () => Promise<boolean> | boolean, timeout = 20_000) => vi.waitFor(async () => expect(await cond()).toBe(true), { timeout, interval: 100 });
  const rows = (eventId: string) => sql<Record<string, unknown>>(d.adminUrl, `SELECT * FROM audit_record WHERE "eventId" = $1`, [eventId]);
  const rowCount = async (eventId: string) => (await rows(eventId)).length;
  const idle = async () => (await depth(ch, AUDIT_QUEUE)) === 0 && (await depth(ch, RETRY_QUEUE)) === 0;
  const publish = (e: EventEnvelope) => publisher.publish(e);
  /** Dead letters, collected until `n` arrived (and nothing more within a short settle window). */
  const deadLetters = async (n: number): Promise<DeadLetter[]> => {
    const got: DeadLetter[] = [];
    await until(async () => {
      got.push(...(await drainDead(ch)));
      return got.length >= n;
    });
    await new Promise((r) => setTimeout(r, 300));
    got.push(...(await drainDead(ch)));
    return got;
  };
  const logs = () => ALL_LOGS.map((l) => String(l.msg));

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'aing');
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

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────── topology and happy path

  it('declares the durable topology: audit-service.audit bound to audit.# only, with .retry and .dead; nothing else is routed to it', async () => {
    await start();
    const q = await ch.checkQueue(AUDIT_QUEUE);
    expect(q.consumerCount).toBe(1);
    await ch.checkQueue(RETRY_QUEUE);
    await ch.checkQueue(DEAD_QUEUE);
    // A domain event on the same exchange never reaches the audit queue (no binding), whatever it carries.
    await publishRaw(ch, { routingKey: 'payment.succeeded', type: 'payment.succeeded', messageId: randomUUID(), body: '{}', headers: { source: 'payment-service', version: 1 } });
    await publishRaw(ch, { routingKey: 'membership.revoked', type: 'membership.revoked', messageId: randomUUID(), body: '{}', headers: { source: 'auth-service', version: 1 } });
    await new Promise((r) => setTimeout(r, 500));
    expect(await depth(ch, DEAD_QUEUE)).toBe(0);
    expect(logs().some((m) => m.startsWith('audit_event_refused') && /membership\.revoked|payment\.succeeded/.test(m))).toBe(false);
  });

  it('a valid event is validated, stored with every field as sent, then acknowledged; recordedAt is the database clock; nothing dead-lettered', async () => {
    await start();
    const e = auditEnvelope('membership.revoked');
    const before = Date.now();
    await publish(e);
    await until(async () => (await rowCount(e.id)) === 1);
    await until(idle);
    const [r] = await rows(e.id);
    const p = e.payload as unknown as ReturnType<typeof sampleAuditPayload>;
    expect(r).toMatchObject({
      eventId: e.id, sourceService: 'auth-service', action: 'membership.revoked', category: 'business', schemaVersion: 1,
      actorType: 'user', actorId: p.actor.id, userKind: 'member', organizationId: p.organizationId, resourceType: 'membership',
      resourceId: p.resource.id, subjectType: 'user', subjectId: p.subject!.id, outcome: 'succeeded', changes: p.changes,
      correlationId: e.headers.correlationId, causationId: p.causationId,
    });
    expect((r!.occurredAt as Date).toISOString()).toBe(e.headers.occurredAt);
    expect((r!.recordedAt as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await depth(ch, DEAD_QUEUE)).toBe(0);
    expect(logs().some((m) => m.startsWith(`audit_event_persisted eventId=${e.id} action=membership.revoked source=auth-service`))).toBe(true);
  });

  it('events of every catalog producer are admitted when their source is the action\'s owner (all 49 bus actions); audit-service\'s own action never over the bus', async () => {
    await start();
    const events = AUDIT_ACTIONS.filter((a) => a !== 'platform_query.executed').map((a) => auditEnvelope(a));
    const self = auditEnvelope('platform_query.executed'); // source audit-service: written only by audit-service itself (18.6)
    await publish(self);
    for (const e of events) await publish(e);
    await until(async () => (await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_record WHERE "eventId" = ANY($1::uuid[])`, [events.map((e) => e.id)]))[0]!.n === events.length, 30_000);
    const bySource = await sql<{ s: string; n: number }>(d.adminUrl, `SELECT "sourceService" AS s, count(*)::int AS n FROM audit_record WHERE "eventId" = ANY($1::uuid[]) GROUP BY 1 ORDER BY 1`, [events.map((e) => e.id)]);
    expect(bySource).toEqual([
      { s: 'auth-service', n: 24 }, { s: 'billing-service', n: 11 }, { s: 'file-service', n: 2 }, { s: 'organization-service', n: 7 }, { s: 'payment-service', n: 5 },
    ]);
    const dead = await deadLetters(1);
    expect(dead.map((x) => [x.messageId, x.reason])).toEqual([[self.id, 'producer_not_admitted']]);
    expect(await rowCount(self.id)).toBe(0);
  }, 60_000);

  // ────────────────────────────────────────────────────────────────────────────────────────────── duplicates and conflicts

  it('EXACT DUPLICATE: the same event delivered again is an idempotent success: one row, acknowledged, no DLQ, no retry', async () => {
    const t = await start();
    const e = auditEnvelope('file.deleted');
    await publish(e);
    await until(async () => (await rowCount(e.id)) === 1);
    const [first] = await rows(e.id);
    await publish(e);
    await publish(e);
    await until(async () => logs().filter((m) => m.startsWith(`audit_event_duplicate eventId=${e.id}`)).length === 2);
    await until(idle);
    expect(await rows(e.id)).toEqual([first]);
    expect(await depth(ch, DEAD_QUEUE)).toBe(0);
    expect(notices.some((n) => n.startsWith('event_retry_scheduled') && n.includes(e.id))).toBe(false);
    expect(t.app.get(IngestionCounters).drain().counts).toMatchObject({ persisted: 1, duplicate: 2, refused: 0 });
  });

  describe('CONFLICT: the same (sourceService, eventId) with DIFFERENT evidence is dead-lettered `event_id_conflict`; the stored row never changes', () => {
    const p0 = () => JSON.parse(JSON.stringify(sampleAuditPayload('membership.revoked', 'complete'))) as Record<string, any>;
    const variants: Array<[string, (e: EventEnvelope) => void]> = [
      ['actor id', (e) => (e.payload.actor = { ...(e.payload.actor as object), id: SAMPLE_IDS.uuidA })],
      ['user kind', (e) => (e.payload.actor = { ...(e.payload.actor as object), userKind: 'operator' })],
      ['organization', (e) => (e.payload.organizationId = SAMPLE_IDS.uuidB)],
      ['resource id', (e) => (e.payload.resource = { type: 'membership', id: SAMPLE_IDS.uuidA })],
      ['subject id', (e) => (e.payload.subject = { type: 'user', id: SAMPLE_IDS.uuidB })],
      ['changes', (e) => (e.payload.changes = { authority: 'operator', was_admin: true })],
      ['causation', (e) => (e.payload.causationId = SAMPLE_IDS.uuidB)],
      ['no causation', (e) => delete e.payload.causationId],
      ['correlation id', (e) => (e.headers.correlationId = 'another-correlation-id')],
      ['occurredAt', (e) => (e.headers.occurredAt = '2020-01-01T00:00:00.000Z')],
      ['action (and so category)', (e) => ((e.name = 'audit.join_code.created'), (e.payload = { ...p0(), action: 'join_code.created', resource: { type: 'join_code', id: SAMPLE_IDS.resource }, changes: { authority: 'owner' } }), delete e.payload.subject)],
    ];

    it.each(variants)('%s', async (_label, mutate) => {
      await start();
      const e = auditEnvelope('membership.revoked');
      await publish(e);
      await until(async () => (await rowCount(e.id)) === 1);
      const before = await rows(e.id);
      const conflicting: EventEnvelope = JSON.parse(JSON.stringify(e));
      mutate(conflicting);
      await publish(conflicting);
      const dead = await deadLetters(1);
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({ messageId: e.id, failure: 'permanent', reason: 'event_id_conflict', retryCount: 0, consumer: AUDIT_QUEUE });
      expect(await rows(e.id)).toEqual(before); // field for field, including recordedAt: never overwritten, merged or updated
      expect(notices.some((n) => n.startsWith('event_retry_scheduled') && n.includes(e.id))).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── permanent refusals (DLQ)

  it('the DLQ matrix: every invalid event is dead-lettered ONCE with its stable reason (no retry), nothing is stored, the consumer keeps going', async () => {
    await start();
    const cases: Array<{ label: string; send: () => Promise<string>; reason: string | undefined; failure: string }> = [];
    const envelopeCase = (label: string, reason: string, e: EventEnvelope) => cases.push({ label, reason, failure: 'permanent', send: async () => (await publish(e), e.id) });
    const rawCase = (label: string, reason: string | undefined, failure: string, m: Parameters<typeof publishRaw>[1]) =>
      cases.push({ label, reason, failure, send: async () => (await publishRaw(ch, m), String(m.messageId ?? '')) });
    const base = () => auditEnvelope('membership.revoked');
    const withPayload = (f: (p: Record<string, any>) => void) => {
      const e = base();
      f(e.payload as Record<string, any>);
      return e;
    };
    const valid = base();
    const rawOf = (e: EventEnvelope, over: Partial<Parameters<typeof publishRaw>[1]> = {}) => ({
      routingKey: e.name, type: e.name, messageId: e.id, body: JSON.stringify(e.payload), headers: { ...e.headers }, ...over,
    });

    rawCase('malformed JSON', 'malformed_envelope', 'malformed', { ...rawOf(base()), body: '{"action": "membership.revoked",' });
    rawCase('not JSON at all', 'malformed_envelope', 'malformed', { ...rawOf(base()), body: Buffer.from([0xff, 0x00, 0x13, 0x37]) });
    rawCase('a JSON array body', 'malformed_envelope', 'malformed', { ...rawOf(base()), body: '[1,2,3]' });
    rawCase('missing event id', 'malformed_envelope', 'malformed', { ...rawOf(base()), messageId: undefined });
    rawCase('malformed event id (uppercase)', 'invalid_envelope', 'permanent', (() => {
      const e = base();
      const id = e.id.toUpperCase();
      return rawOf(e, { messageId: id, headers: { ...e.headers, eventId: id } });
    })());
    rawCase('event type not audit.<action> (sent straight to the queue)', 'event_type_mismatch', 'permanent', { ...rawOf(base()), toQueue: true, type: 'membership.revoked' });
    envelopeCase('event type of another action', 'event_type_mismatch', { ...base(), name: 'audit.membership.approved' });
    envelopeCase('unsupported version 2', 'unsupported_version', (() => {
      const e = base();
      e.headers.version = 2;
      return e;
    })());
    rawCase('missing source service', 'invalid_envelope', 'permanent', (() => {
      const e = base();
      const { source: _s, ...h } = e.headers;
      return rawOf(e, { headers: h });
    })());
    envelopeCase('malformed occurredAt', 'invalid_envelope', (() => {
      const e = base();
      e.headers.occurredAt = '2026-02-30T10:00:00.000Z';
      return e;
    })());
    envelopeCase('invalid correlation id', 'invalid_correlation', (() => {
      const e = base();
      e.headers.correlationId = 'has spaces in it';
      return e;
    })());
    envelopeCase('unknown action', 'unknown_action', (() => {
      const e = withPayload((p) => (p.action = 'membership.promoted'));
      e.name = 'audit.membership.promoted';
      return e;
    })());
    envelopeCase('producer mismatch (source spoofing: billing claims an auth action)', 'producer_not_admitted', (() => {
      const e = base();
      e.headers.source = 'billing-service';
      return e;
    })());
    envelopeCase('invalid actor', 'invalid_actor', withPayload((p) => (p.actor = { type: 'operator', id: SAMPLE_IDS.user })));
    envelopeCase('invalid organization', 'invalid_organization', withPayload((p) => (p.organizationId = null)));
    envelopeCase('invalid resource', 'invalid_resource', withPayload((p) => (p.resource = { type: 'invoice', id: SAMPLE_IDS.resource })));
    envelopeCase('invalid subject', 'invalid_subject', withPayload((p) => delete p.subject));
    envelopeCase('invalid outcome', 'invalid_outcome', withPayload((p) => (p.outcome = 'denied')));
    envelopeCase('invalid changes', 'invalid_changes', withPayload((p) => (p.changes = { authority: 'owner', was_admin: 'yes' })));
    envelopeCase('sensitive field', 'sensitive_field', withPayload((p) => (p.changes = { ...p.changes, password: 'SENTINEL-PW-3f9a1c' })));
    envelopeCase('secret-shaped value', 'sensitive_value', withPayload((p) => (p.note = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N')));
    envelopeCase('category on the wire', 'unknown_field', withPayload((p) => (p.category = 'commercial')));
    envelopeCase('recordedAt on the wire', 'unknown_field', withPayload((p) => (p.recordedAt = '2020-01-01T00:00:00.000Z')));
    envelopeCase('oversized (a 1 MiB value)', 'invalid_changes', withPayload((p) => (p.changes = { authority: 'x'.repeat(1024 * 1024), was_admin: true })));

    const ids: Array<[string, string, string | undefined, string]> = [];
    for (const c of cases) ids.push([c.label, await c.send(), c.reason, c.failure]);
    await publish(valid); // after every poison message: the queue is not blocked
    const dead = await deadLetters(cases.length);
    expect(dead).toHaveLength(cases.length);
    for (const [label, id, reason, failure] of ids) {
      const found = id ? dead.filter((x) => x.messageId === id || String(x.messageId).toLowerCase() === id.toLowerCase()) : dead.filter((x) => x.messageId === undefined);
      expect(found.length, label).toBeGreaterThanOrEqual(1);
      expect(found.some((x) => x.failure === failure && x.reason === reason && Number(x.retryCount) === 0), `${label}: ${JSON.stringify(found.map((f) => [f.failure, f.reason, f.retryCount]))}`).toBe(true);
    }
    await until(async () => (await rowCount(valid.id)) === 1);
    const stored = await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_record WHERE "eventId"::text = ANY($1::text[])`, [ids.map(([, id]) => id.toLowerCase()).filter(Boolean)]);
    expect(stored[0]!.n).toBe(0);
    expect(notices.filter((n) => n.startsWith('event_retry_scheduled'))).toEqual([]); // permanent: never retried
    // Nothing a refused message carried reaches a log line: not the secret, not the oversized value, not a payload.
    const text = JSON.stringify(ALL_LOGS) + notices.join('\n');
    expect(text).not.toContain('SENTINEL-PW-3f9a1c');
    expect(text).not.toContain('x'.repeat(200));
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(text).not.toMatch(/"was_admin"|"authority"|has spaces in it|amqp:\/\//);
  }, 60_000);

  it('POISON does not starve the queue: valid, invalid, valid → stored, dead-lettered, stored (in that order of arrival)', async () => {
    await start();
    const a = auditEnvelope('invoice.issued');
    const bad = auditEnvelope('invoice.issued', { headers: { source: 'payment-service' } });
    const b = auditEnvelope('invoice.paid');
    for (const e of [a, bad, b]) await publish(e);
    await until(async () => (await rowCount(a.id)) === 1 && (await rowCount(b.id)) === 1);
    const dead = await deadLetters(1);
    expect(dead.map((x) => [x.messageId, x.reason])).toEqual([[bad.id, 'producer_not_admitted']]);
    expect(await rowCount(bad.id)).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────────────────────── transient failures and retries

  it('DATABASE OUTAGE: nothing is acknowledged or written while PostgreSQL refuses connections; the kit retries; on recovery exactly one row, no DLQ', async () => {
    const t = await start({ retry: { maxRetries: 3, delayMs: 1500 } });
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS false`);
    await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND application_name = 'audit-service'`, [d.name]);
    const e = auditEnvelope('payment.succeeded');
    await publish(e);
    await until(() => notices.some((n) => n.startsWith('event_retry_scheduled') && n.includes(e.id)));
    expect(t.logs.some((l) => String(l.msg).startsWith(`audit_ingest_transient_failure eventId=${e.id}`))).toBe(true);
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS true`);
    await until(async () => (await rowCount(e.id)) === 1, 30_000);
    await until(idle);
    expect(await depth(ch, DEAD_QUEUE)).toBe(0);
    expect(await rowCount(e.id)).toBe(1);
  }, 60_000);

  it('RETRY EXHAUSTION then REPLAY: a failure that outlasts the retry budget is dead-lettered `retries_exhausted` (bounded, never lost); replayed after recovery it is stored once', async () => {
    await start({ retry: { maxRetries: 2, delayMs: 300 } });
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS false`);
    await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND application_name = 'audit-service'`, [d.name]);
    const e = auditEnvelope('price.created');
    await publish(e);
    await until(async () => (await depth(ch, DEAD_QUEUE)) === 1, 30_000);
    expect(notices.filter((n) => n.startsWith('event_retry_scheduled') && n.includes(e.id))).toHaveLength(2);
    expect(notices.some((n) => n.startsWith('event_retry_exhausted') && n.includes(e.id))).toBe(true);
    const info = await ch.get(DEAD_QUEUE, { noAck: false });
    expect(info && info.properties.headers?.['x-nawara-failure']).toBe('retries_exhausted');
    ch.nack(info as amqp.GetMessage, false, true); // back into the DLQ, untouched
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS true`);
    const r = await replayDeadLetter(conn, DEAD_QUEUE, e.id, { waitMs: 15_000 });
    expect(r.outcome).toBe('consumed');
    expect(await rowCount(e.id)).toBe(1);
    // An operator replaying the SAME event again (already stored): a duplicate, acknowledged, still one row.
    await publish(e);
    await until(() => logs().some((m) => m.startsWith(`audit_event_duplicate eventId=${e.id}`)));
    expect(await rowCount(e.id)).toBe(1);
    expect(await depth(ch, DEAD_QUEUE)).toBe(0);
  }, 60_000);

  it('REPLAY of a conflicting event is refused again (`rejected_again`) and never rewrites history', async () => {
    await start();
    const e = auditEnvelope('file.deleted');
    await publish(e);
    await until(async () => (await rowCount(e.id)) === 1);
    const before = await rows(e.id);
    await publish({ ...e, payload: { ...e.payload, organizationId: SAMPLE_IDS.uuidB } });
    await until(async () => (await depth(ch, DEAD_QUEUE)) === 1);
    const r = await replayDeadLetter(conn, DEAD_QUEUE, e.id, { waitMs: 15_000 });
    expect(r.outcome).toBe('rejected_again');
    const dead = await drainDead(ch);
    expect(dead.map((x) => x.reason)).toEqual(['event_id_conflict']);
    expect(await rows(e.id)).toEqual(before);
  }, 40_000);

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────── crash windows

  it('CRASH BEFORE INSERT: the connection dies while a delivery is being handled, before anything is written → the broker redelivers → stored once', async () => {
    const target = new URL(env.TEST_RABBITMQ_URL);
    const proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
    try {
      const t = await start({ rabbitmqUrl: proxy.url });
      const ingestion = t.app.get(IngestionService);
      const original = ingestion.ingest.bind(ingestion);
      let crashed = false;
      vi.spyOn(ingestion, 'ingest').mockImplementation(async (ev) => {
        if (!crashed) {
          crashed = true;
          await proxy.sever(); // the process's broker connection is gone: nothing below can be acknowledged
          setTimeout(() => void proxy.start(), 500);
          throw new Error('simulated crash before the insert');
        }
        return original(ev);
      });
      const e = auditEnvelope('subscription.activated');
      await publish(e);
      await until(async () => (await rowCount(e.id)) === 1, 30_000);
      await until(idle);
      expect(crashed).toBe(true);
      expect(await rowCount(e.id)).toBe(1);
      expect(await depth(ch, DEAD_QUEUE)).toBe(0);
    } finally {
      await proxy.sever();
    }
  }, 60_000);

  it('CRASH AFTER COMMIT, BEFORE ACK: the row is committed, the acknowledgement never reaches the broker → redelivered → recognized as the same evidence → acknowledged; exactly one row', async () => {
    const target = new URL(env.TEST_RABBITMQ_URL);
    const proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
    try {
      const t = await start({ rabbitmqUrl: proxy.url });
      const ingestion = t.app.get(IngestionService);
      const original = ingestion.ingest.bind(ingestion);
      let committed = false;
      vi.spyOn(ingestion, 'ingest').mockImplementation(async (ev) => {
        const outcome = await original(ev); // COMMITTED here
        if (!committed) {
          committed = true;
          await proxy.sever(); // the ACK that follows goes nowhere
          setTimeout(() => void proxy.start(), 500);
        }
        return outcome;
      });
      const e = auditEnvelope('subscription.renewed');
      await publish(e);
      await until(() => logs().some((m) => m.startsWith(`audit_event_duplicate eventId=${e.id}`)), 30_000);
      await until(idle);
      expect(await rowCount(e.id)).toBe(1);
      expect(await depth(ch, DEAD_QUEUE)).toBe(0);
      expect(logs().filter((m) => m.startsWith(`audit_event_persisted eventId=${e.id}`))).toHaveLength(1);
    } finally {
      await proxy.sever();
    }
  }, 60_000);

  it('A DATABASE FAILURE AT THE INSERT (after validation) is not acknowledged as success, leaves no partial row, and is retried to one row', async () => {
    const t = await start({ retry: { maxRetries: 3, delayMs: 300 } });
    const ingestion = t.app.get(IngestionService);
    const repo = (ingestion as unknown as { records: { insertOnce: (...a: unknown[]) => Promise<unknown> } }).records;
    const original = repo.insertOnce.bind(repo);
    let failed = false;
    vi.spyOn(repo, 'insertOnce').mockImplementation(async (...a: unknown[]) => {
      if (!failed) {
        failed = true;
        throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' });
      }
      return original(...a);
    });
    const e = auditEnvelope('invoice.discarded');
    await publish(e);
    await until(async () => (await rowCount(e.id)) === 1);
    await until(idle);
    expect(failed).toBe(true);
    expect(notices.some((n) => n.startsWith('event_retry_scheduled') && n.includes(e.id))).toBe(true);
    expect(await depth(ch, DEAD_QUEUE)).toBe(0);
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────── concurrency

  it('CONCURRENT DUPLICATES: 60 identical deliveries across two consumers → exactly one row, 59 idempotent acknowledgements, no DLQ, nothing stuck', async () => {
    await start();
    await start(); // a second instance on the same queue: real cross-process concurrency
    const e = auditEnvelope('membership.approved');
    await Promise.all(Array.from({ length: 60 }, () => publish(e)));
    await until(async () => logs().filter((m) => m.startsWith(`audit_event_duplicate eventId=${e.id}`)).length === 59, 30_000);
    await until(idle);
    expect(await rowCount(e.id)).toBe(1);
    expect(await depth(ch, DEAD_QUEUE)).toBe(0);
  }, 60_000);

  it('CONCURRENT CONFLICTS: 20 deliveries of one identity with 20 different correlation ids → one immutable winner, 19 `event_id_conflict`', async () => {
    await start();
    await start();
    const e = auditEnvelope('membership.approved');
    const variants = Array.from({ length: 20 }, (_, i) => ({ ...e, headers: { ...e.headers, correlationId: `variant-${String(i).padStart(4, '0')}` } }));
    await Promise.all(variants.map((v) => publish(v)));
    const dead = await deadLetters(19);
    expect(dead).toHaveLength(19);
    expect(dead.every((x) => x.reason === 'event_id_conflict' && x.messageId === e.id)).toBe(true);
    const stored = await rows(e.id);
    expect(stored).toHaveLength(1);
    const winner = String(stored[0]!.correlationId);
    expect(variants.map((v) => v.headers.correlationId)).toContain(winner);
    await until(idle);
  }, 60_000);

  // ────────────────────────────────────────────────────────────────────────────────────────────────── time and ordering

  it('CLOCK SKEW: a future occurredAt is stored exactly as sent and observed (log + counter), never corrected; a far-past one is normal', async () => {
    const t = await start();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = '2019-06-01T00:00:00.000Z';
    const f = auditEnvelope('file.deleted', { headers: { occurredAt: future } });
    const p = auditEnvelope('file.deleted', { headers: { occurredAt: past } });
    await publish(f);
    await publish(p);
    await until(async () => (await rowCount(f.id)) === 1 && (await rowCount(p.id)) === 1);
    expect(((await rows(f.id))[0]!.occurredAt as Date).toISOString()).toBe(future);
    expect(((await rows(p.id))[0]!.occurredAt as Date).toISOString()).toBe(past);
    expect(logs().filter((m) => m.startsWith('audit_clock_skew'))).toEqual([expect.stringMatching(new RegExp(`^audit_clock_skew eventId=${f.id} action=file\\.deleted source=file-service aheadSeconds=3[56]\\d\\d `))]);
    const snap = t.app.get(IngestionCounters).drain();
    expect(snap.counts.clock_skew_future).toBe(1);
    expect(snap.lag.maxMs).toBeGreaterThan(200_000_000); // the 2019 event: a lag, not an error
  });

  it('recordedAt cannot be supplied by an event: a header is ignored, a payload field is refused; it is always the database clock', async () => {
    await start();
    const e = auditEnvelope('file.deleted', { headers: { recordedAt: '2000-01-01T00:00:00.000Z' } });
    await publish(e);
    await until(async () => (await rowCount(e.id)) === 1);
    const [r] = await rows(e.id);
    const [{ now }] = await sql<{ now: Date }>(d.adminUrl, 'SELECT now()');
    expect(Math.abs((r!.recordedAt as Date).getTime() - now.getTime())).toBeLessThan(30_000);
  });

  it('OUT OF ORDER: events arriving in any order of occurredAt are all stored as sent', async () => {
    await start();
    const times = ['2026-09-25T10:00:03.000Z', '2026-09-25T10:00:01.000Z', '2026-09-25T10:00:02.000Z'];
    const events = times.map((occurredAt) => auditEnvelope('invoice.paid', { headers: { occurredAt } }));
    for (const e of events) await publish(e);
    await until(async () => (await Promise.all(events.map((e) => rowCount(e.id)))).every((n) => n === 1));
    for (const [i, e] of events.entries()) expect(((await rows(e.id))[0]!.occurredAt as Date).toISOString()).toBe(times[i]);
  });

  // ────────────────────────────────────────────────────────────────────────────────────── backpressure, lifecycle, broker

  it('BACKPRESSURE: while PostgreSQL is slow, at most `prefetch` (5) deliveries are in flight; the rest wait in the broker, not in memory', async () => {
    const t = await start();
    const lock = new (await import('pg')).default.Client({ connectionString: d.adminUrl });
    await lock.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE audit_record IN SHARE MODE'); // blocks INSERT, not the readiness checks
      const events = Array.from({ length: 40 }, () => auditEnvelope('payment.created'));
      for (const e of events) await publish(e);
      const counters = t.app.get(IngestionCounters);
      await until(() => counters.inFlight === 5);
      await new Promise((r) => setTimeout(r, 500));
      expect(counters.inFlight).toBe(5);
      expect(await depth(ch, AUDIT_QUEUE)).toBe(35); // ready in the broker; unacknowledged = prefetch
      await lock.query('ROLLBACK');
      await until(async () => (await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_record WHERE "eventId" = ANY($1::uuid[])`, [events.map((e) => e.id)]))[0]!.n === 40, 30_000);
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined);
      await lock.end();
    }
  }, 60_000);

  it('SHUTDOWN with a delivery stuck in the database: no new delivery taken; the consumer drain (5 s) gives up without an ACK, the pool close is bounded by the statement timeout; the event is redelivered and stored once', async () => {
    // The kit's pool close waits for a checked-out client (Stage 15.5): a query stuck on a lock holds it until DB_STATEMENT_TIMEOUT_MS
    // cancels it. That timeout is therefore the real shutdown bound for a stalled database (3 s here; 30 s by default).
    const t = await start({ env: { DB_STATEMENT_TIMEOUT_MS: '3000', DB_QUERY_TIMEOUT_MS: '8000' } });
    const pgc = new (await import('pg')).default.Client({ connectionString: d.adminUrl });
    await pgc.connect();
    const counters = t.app.get(IngestionCounters);
    const a = auditEnvelope('file.deleted');
    const b = auditEnvelope('file.deleted');
    try {
      await pgc.query('BEGIN');
      await pgc.query('LOCK TABLE audit_record IN SHARE MODE');
      await publish(a);
      await until(() => counters.inFlight === 1);
      const t0 = Date.now();
      const closing = t.app.close();
      apps.splice(apps.indexOf(t), 1);
      await new Promise((r) => setTimeout(r, 200));
      await publish(b); // arrives during the drain: must not be taken by the closing instance
      await new Promise((r) => setTimeout(r, 300));
      expect(await depth(ch, AUDIT_QUEUE)).toBe(1); // b waits in the broker: the consumer was cancelled at shutdown start
      await closing;
      expect(Date.now() - t0).toBeLessThan(12_000); // the consumer drain bound (5 s), then the statement timeout (3 s) frees the pool
    } finally {
      await pgc.query('ROLLBACK').catch(() => undefined);
      await pgc.end();
    }
    const lines = t.logs.map((l) => String(l.msg));
    expect(lines.some((m) => m.startsWith('service_shutdown_started'))).toBe(true);
    expect(lines.some((m) => m.startsWith(`audit_event_persisted eventId=${b.id}`))).toBe(false);
    await start(); // the next instance takes what was not acknowledged
    await until(async () => (await rowCount(a.id)) === 1 && (await rowCount(b.id)) === 1, 30_000);
    await until(idle);
    expect(await rowCount(a.id)).toBe(1);
  }, 60_000);

  it('the consumer is cancelled at shutdown START: an event published while a slow HTTP request is still draining is left for the next instance', async () => {
    const t = await start();
    const slow = request(t.app.getHttpServer()).get('/probe/slow').then((r) => r.status, () => 'closed'); // 1.5 s: holds the HTTP drain open
    await new Promise((r) => setTimeout(r, 100));
    const closing = t.app.close();
    apps.splice(apps.indexOf(t), 1);
    await new Promise((r) => setTimeout(r, 200));
    const b = auditEnvelope('file.deleted');
    await publish(b); // the HTTP drain is still running: a consumer that was not cancelled at shutdown start would take (and store) it
    await new Promise((r) => setTimeout(r, 500));
    expect(await depth(ch, AUDIT_QUEUE)).toBe(1);
    await closing;
    await slow;
    expect(await rowCount(b.id)).toBe(0);
    expect(t.logs.some((l) => String(l.msg).startsWith(`audit_event_persisted eventId=${b.id}`))).toBe(false);
    await start();
    await until(async () => (await rowCount(b.id)) === 1);
  }, 40_000);

  it('BROKER LOST AT RUNTIME: /ready 503 (rabbitmq, audit-ingestion), the kit reconnects by itself, /ready 200 again, consumption resumes, no restart', async () => {
    const target = new URL(env.TEST_RABBITMQ_URL);
    const proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
    try {
      const t = await start({ rabbitmqUrl: proxy.url });
      await proxy.sever();
      await vi.waitFor(async () => {
        const r = await request(t.app.getHttpServer()).get('/ready');
        expect(r.status).toBe(503);
        expect(r.body.failed).toEqual(expect.arrayContaining(['audit-ingestion', 'rabbitmq']));
      }, { timeout: 15_000, interval: 200 });
      await request(t.app.getHttpServer()).get('/health').expect(200);
      await proxy.start();
      await ready(t, 40_000);
      const e = auditEnvelope('product.created');
      await publish(e);
      await until(async () => (await rowCount(e.id)) === 1);
      expect(notices.some((n) => n.startsWith('rabbitmq_consumer_lost'))).toBe(true);
      expect(notices.some((n) => n.startsWith('rabbitmq_consumer_recovered'))).toBe(true);
    } finally {
      await proxy.sever();
    }
  }, 90_000);

  it('BROKER DOWN AT STARTUP: the process stays up, /health 200, /ready 503; ingestion starts once the broker answers (no crash loop)', async () => {
    const target = new URL(env.TEST_RABBITMQ_URL);
    const proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
    await proxy.sever();
    try {
      const t = await start({ rabbitmqUrl: proxy.url, waitReady: false });
      await new Promise((r) => setTimeout(r, 1500));
      await request(t.app.getHttpServer()).get('/health').expect(200);
      const r = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(r.body.failed).toEqual(['audit-ingestion', 'rabbitmq']);
      expect(t.logs.some((l) => String(l.msg).startsWith('audit_ingestion_waiting reason=broker_unavailable'))).toBe(true);
      await proxy.start();
      await ready(t, 30_000);
      const e = auditEnvelope('product.archived');
      await publish(e);
      await until(async () => (await rowCount(e.id)) === 1);
    } finally {
      await proxy.sever();
    }
  }, 60_000);

  it('SERVICE RESTART: events published while Audit is down wait in the durable queue and are stored once each after it starts', async () => {
    const t = await start();
    await t.app.close();
    apps.splice(apps.indexOf(t), 1);
    const events = Array.from({ length: 5 }, () => auditEnvelope('price.retired'));
    for (const e of events) await publish(e);
    expect(await depth(ch, AUDIT_QUEUE)).toBe(5);
    await start();
    await until(async () => (await Promise.all(events.map((e) => rowCount(e.id)))).every((n) => n === 1));
    await until(idle);
  }, 40_000);

  it('logs never carry payload data, change values, actor / organization / resource ids, or broker / database credentials', async () => {
    await start();
    const e = auditEnvelope('membership.revoked');
    await publish(e);
    await until(async () => (await rowCount(e.id)) === 1);
    const text = JSON.stringify(ALL_LOGS) + notices.join('\n');
    for (const id of [SAMPLE_IDS.user, SAMPLE_IDS.organization, SAMPLE_IDS.resource, SAMPLE_IDS.subject]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/"authority"|"was_admin"|amqp:\/\/|postgres:\/\//);
    for (const secret of [new URL(env.TEST_DATABASE_ADMIN_URL).password, new URL(d.appUrl).password].filter(Boolean)) expect(text).not.toContain(secret);
  });
});
