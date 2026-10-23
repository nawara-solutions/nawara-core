import { createHash, randomBytes, randomUUID } from 'node:crypto';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SAMPLE_IDS } from '@nawara/audit-contract/testing';
import {
  DbService, PgProvenanceStore, RabbitMqEventBus, kitMigrationsDir, runMigrations, type EventBus, type EventEnvelope, type ProvenanceObservation,
} from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { auditEventOwner } from '../src/ingestion/admission.js';
import { auditDeadLetterPolicy } from '../src/ingestion/dead-letter-policy.js';
import { IngestionService } from '../src/ingestion/ingestion.service.js';
import { AUDIT_EXCHANGE, AUDIT_QUEUE } from '../src/ingestion/ingestion.constants.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { DEAD_QUEUE, auditEnvelope, deleteAuditQueues, depth } from './support/broker.js';
import { failure, sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Core V2 S1b-2 (ADR-0057 §13.2 with its "Audit admission" clarification S0-C1, §13.3, §13.4; observe-only) over a REAL RabbitMQ and a
 * REAL PostgreSQL 16, through the real module graph, as the runtime role:
 * - every delivery, on any exchange, is ADMITTED first (canonical bytes, the Stage 18.8 screen, the full contract); a refused one never
 *   reaches provenance or ingestion, leaves no row and no body digest, and is dead-lettered under the Stage 18.8 policy;
 * - an admitted original delivery's provenance is committed BEFORE ingestion, verified only from the broker `user_id` + the catalog owner;
 *   ingestion (de-duplication, `event_id_conflict`) is unchanged.
 * Broker users: `payment-service` (the catalog producer of the `payment.*` actions; refused if such a user already exists, never
 * overwritten) and an intruder, created through the management API and deleted at the end. The audit queues are the production names,
 * so they are deleted before and after (a disposable / dev broker only).
 */
const PHONE = '+21620000009';
const hex = (n: number) => randomBytes(n).toString('hex');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeWithEnv('S1b-2 Audit event provenance (real RabbitMQ, real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
  const OWNER = 'payment-service';
  const prefix = `s1b2${hex(4)}`;
  const INTRUDER = `${prefix}-intruder`;
  const CRASH_EXCHANGE = `${prefix}.events`;
  const passwords: Record<string, string> = { [OWNER]: hex(24), [INTRUDER]: hex(24) };
  const mgmt = new URL(env.TEST_RABBITMQ_MGMT_URL);
  const mgmtAuth = `Basic ${Buffer.from(`${decodeURIComponent(mgmt.username)}:${decodeURIComponent(mgmt.password)}`).toString('base64')}`;
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${mgmt.origin}/api${path}`, { method, headers: { authorization: mgmtAuth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const urlFor = (user: string) => {
    const u = new URL(env.TEST_RABBITMQ_URL);
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(passwords[user]!);
    return u.toString();
  };
  const created: string[] = [];
  const closers: Array<() => Promise<unknown>> = [];
  let d: ProvisionedDatabase;
  let conn: ChannelModel;
  let ch: Channel;
  let t: TestApp;
  let owner: RabbitMqEventBus;
  let intruder: RabbitMqEventBus;

  const until = (cond: () => Promise<boolean> | boolean, timeout = 20_000) => vi.waitFor(async () => expect(await cond()).toBe(true), { timeout, interval: 100 });
  const records = async (id: string) => (await sql(d.adminUrl, `SELECT 1 FROM audit_record WHERE "eventId" = $1`, [id])).length;
  const provenance = (id: string, consumer = AUDIT_QUEUE) =>
    sql<Record<string, unknown>>(d.adminUrl, `SELECT consumer, source, name, "routingKey", exchange, "bodySha256", "producerUserId", verified, reason FROM event_provenance WHERE "eventId" = $1 AND consumer = $2 ORDER BY "firstSeenAt"`, [id, consumer]);
  const conflicts = (id: string) => sql<Record<string, unknown>>(d.adminUrl, `SELECT "producerUserId", verified, reason, "bodySha256" FROM event_provenance_conflict WHERE "eventId" = $1`, [id]);
  /** Is `digest` stored ANYWHERE in the provenance tables? */
  const digestStored = async (digest: string) =>
    (await sql(d.adminUrl, `SELECT 1 FROM event_provenance WHERE "bodySha256" = $1 UNION ALL SELECT 1 FROM event_provenance_conflict WHERE "bodySha256" = $1`, [digest])).length > 0;
  /** The dead-letter copy of message `id` (removed from the DLQ), once it arrived. */
  const deadCopy = async (id: string) => {
    let found: amqp.GetMessage | undefined;
    const seen: amqp.GetMessage[] = [];
    await until(async () => {
      for (;;) {
        const m = await ch.get(DEAD_QUEUE, { noAck: true });
        if (!m) break;
        seen.push(m);
      }
      found = seen.find((m) => m.properties.messageId === id);
      return found !== undefined;
    });
    const h = found!.properties.headers ?? {};
    return { failure: h['x-nawara-failure'], reason: h['x-nawara-failure-reason'], redacted: h['x-nawara-body-redacted'] === 'true', content: found!.content };
  };
  /** Publishes raw bytes to the event exchange as the ADMIN user (no `user_id`): were it admitted, it would leave an unverified row. */
  const publishRaw = async (body: Buffer, id: string, type: string, headers: Record<string, unknown> = {}) => {
    const c = await conn.createConfirmChannel();
    c.publish(AUDIT_EXCHANGE, type, body, { persistent: true, contentType: 'application/json', messageId: id, type, headers: { eventId: id, source: OWNER, occurredAt: new Date().toISOString(), version: 1, correlationId: `corr-${id.slice(0, 8)}`, ...headers } });
    await c.waitForConfirms();
    await c.close();
  };

  beforeAll(async () => {
    const existing = await api('GET', `/users/${OWNER}`);
    if (existing.status !== 404) throw new Error(`a broker user named ${OWNER} already exists on TEST_RABBITMQ_URL's broker; refusing to overwrite it`);
    const resources = `^(nawara\\.events|${prefix}\\..*)$`;
    for (const user of [OWNER, INTRUDER]) {
      const r = await api('PUT', `/users/${encodeURIComponent(user)}`, { password: passwords[user], tags: '' });
      if (!r.ok) throw new Error(`management API: ${r.status}`);
      created.push(user);
      await api('PUT', `/permissions/%2F/${encodeURIComponent(user)}`, { configure: resources, write: `^(nawara\\.events|${prefix}\\..*|amq\\.default)$`, read: '^$' });
    }
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'aprov');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    ch = await conn.createChannel();
    ch.on('error', () => undefined);
    await deleteAuditQueues(ch);
    owner = new RabbitMqEventBus({ url: urlFor(OWNER), exchange: AUDIT_EXCHANGE });
    intruder = new RabbitMqEventBus({ url: urlFor(INTRUDER), exchange: AUDIT_EXCHANGE });
    const bus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: AUDIT_EXCHANGE, prefetch: 5, retry: { maxRetries: 1, delayMs: 300 } });
    t = await createTestApp({ databaseUrl: d.appUrl, rabbitmqUrl: env.TEST_RABBITMQ_URL, bus });
    await vi.waitFor(async () => expect((await request(t.app.getHttpServer()).get('/ready')).body).toEqual({ status: 'ready' }), { timeout: 20_000, interval: 100 });
  });
  afterAll(async () => {
    for (const close of closers) await close().catch(() => undefined);
    await t?.app.close();
    await owner?.close();
    await intruder?.close();
    if (ch) await deleteAuditQueues(ch).catch(() => undefined);
    await conn?.close().catch(() => undefined);
    for (const user of created) await api('DELETE', `/users/${encodeURIComponent(user)}`);
    await d?.drop();
  });

  describe('admitted original deliveries: provenance before ingestion (observe-only)', () => {
    it('a genuine event is recorded VERIFIED, committed BEFORE its audit record is written; the provenance holds no payload value', async () => {
      // Test-only proof of the ORDER: the record's insert (inside ingestion) is refused unless a COMMITTED provenance row of its event exists.
      await sql(d.adminUrl, `CREATE FUNCTION test_requires_provenance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM event_provenance WHERE "eventId" = NEW."eventId"::text) THEN RAISE EXCEPTION 'record before provenance' USING ERRCODE = '23514'; END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER audit_record_00_test_requires_provenance BEFORE INSERT ON audit_record FOR EACH ROW EXECUTE FUNCTION test_requires_provenance()`);
      try {
        const e = auditEnvelope('payment.succeeded');
        await owner.publish(e);
        await until(async () => (await records(e.id)) === 1);
        expect(await provenance(e.id)).toEqual([{
          consumer: AUDIT_QUEUE, source: OWNER, name: e.name, routingKey: e.name, exchange: AUDIT_EXCHANGE, bodySha256: sha(JSON.stringify(e.payload)), producerUserId: OWNER, verified: true, reason: 'verified',
        }]);
      } finally {
        await sql(d.adminUrl, `DROP TRIGGER audit_record_00_test_requires_provenance ON audit_record; DROP FUNCTION test_requires_provenance()`);
      }
      const dump = JSON.stringify(await sql(d.adminUrl, `SELECT * FROM event_provenance UNION ALL SELECT id, consumer, source, "eventId", name, "routingKey", exchange, "bodySha256", "producerUserId", verified, reason, "observedAt" FROM event_provenance_conflict`));
      for (const v of Object.values(SAMPLE_IDS)) expect(dump).not.toContain(v);
    });

    it('a forged source header (another broker user) is UNVERIFIED and ingested as before (F2 is S2-Audit); the genuine event later gets its own verified row and conflict evidence', async () => {
      const e = auditEnvelope('payment.succeeded');
      await intruder.publish(e); // the header still says payment-service; the broker says the intruder
      await until(async () => (await records(e.id)) === 1);
      expect(await provenance(e.id)).toEqual([expect.objectContaining({ source: OWNER, producerUserId: INTRUDER, verified: false, reason: 'source_mismatch' })]);
      await owner.publish(e);
      await until(async () => (await provenance(e.id)).length === 2);
      expect((await provenance(e.id))[1]).toMatchObject({ producerUserId: OWNER, verified: true });
      await until(() => ALL_LOGS.some((l) => String(l.msg).startsWith(`audit_event_duplicate eventId=${e.id}`)));
      expect(await records(e.id)).toBe(1);
      expect(await conflicts(e.id)).toEqual([{ producerUserId: OWNER, verified: true, reason: 'verified', bodySha256: sha(JSON.stringify(e.payload)) }]);
    });

    it('changed content under the same event id is kept as provenance conflict evidence AND refused `event_id_conflict` exactly as before; the stored record is untouched', async () => {
      const e = auditEnvelope('payment.succeeded');
      await owner.publish(e);
      await until(async () => (await records(e.id)) === 1);
      const before = await sql(d.adminUrl, `SELECT * FROM audit_record WHERE "eventId" = $1`, [e.id]);
      const changed = auditEnvelope('payment.succeeded', { id: e.id, variant: 'minimal' });
      expect(JSON.stringify(changed.payload)).not.toBe(JSON.stringify(e.payload));
      await owner.publish(changed);
      const dead = await deadCopy(e.id);
      expect(dead).toMatchObject({ failure: 'permanent', reason: 'event_id_conflict', redacted: false });
      expect(await sql(d.adminUrl, `SELECT * FROM audit_record WHERE "eventId" = $1`, [e.id])).toEqual(before);
      expect(await provenance(e.id)).toEqual([expect.objectContaining({ verified: true, bodySha256: sha(JSON.stringify(e.payload)) })]);
      expect(await conflicts(e.id)).toEqual([{ producerUserId: OWNER, verified: true, reason: 'verified', bodySha256: sha(JSON.stringify(changed.payload)) }]);
    });
  });

  describe('refused at admission: no provenance row, no body digest, no record; Stage 18.8 dead-lettering', () => {
    const valid = () => auditEnvelope('payment.succeeded');
    const canonical = (e: EventEnvelope) => Buffer.from(JSON.stringify(e.payload));
    const cases: Array<{ name: string; make: () => { e: EventEnvelope; body: Buffer }; reason: string; failure?: string; redacted: boolean; secret?: string }> = [
      { name: 'non-canonical JSON (whitespace)', make: () => { const e = valid(); return { e, body: Buffer.from(JSON.stringify(e.payload, null, 1)) }; }, reason: 'noncanonical_body', redacted: true },
      { name: 'a duplicate key hiding a phone number', make: () => { const e = valid(); return { e, body: Buffer.from(`{"action":"${PHONE}",${JSON.stringify(e.payload).slice(1)}`) }; }, reason: 'noncanonical_body', redacted: true, secret: PHONE },
      { name: 'invalid UTF-8', make: () => { const e = valid(); const c = JSON.stringify(e.payload); return { e, body: Buffer.concat([Buffer.from(c.slice(0, -1)), Buffer.from(',"x":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]) }; }, reason: 'noncanonical_body', redacted: true },
      { name: 'malformed JSON', make: () => ({ e: valid(), body: Buffer.from(`{"action":"payment.succeeded","phone":"${PHONE}"`) }), reason: 'malformed_envelope', failure: 'malformed', redacted: true, secret: PHONE },
      { name: 'a confidential field', make: () => { const e = valid(); e.payload = { ...e.payload, phone: PHONE }; return { e, body: canonical(e) }; }, reason: 'sensitive_field', redacted: true, secret: PHONE },
      // a low-entropy number under a key the catalog does not allow: the screen passes it (token-only), the full contract refuses it
      { name: 'a low-entropy number under an unknown change key', make: () => { const e = valid(); e.payload = { ...e.payload, changes: { verification: 730591 } }; return { e, body: canonical(e) }; }, reason: 'invalid_changes', redacted: false },
      { name: 'an unknown action (catalog lag, A50: kept replayable)', make: () => { const e = valid(); e.payload = { ...e.payload, action: 'payment.teleported' }; e.name = 'audit.payment.teleported'; return { e, body: canonical(e) }; }, reason: 'unknown_action', redacted: false },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const { e, body } = c.make();
        await publishRaw(body, e.id, e.name);
        const dead = await deadCopy(e.id);
        expect(dead).toMatchObject({ failure: c.failure ?? 'permanent', reason: c.reason, redacted: c.redacted });
        if (c.secret) expect(dead.content.toString('latin1')).not.toContain(c.secret);
        expect(await provenance(e.id)).toEqual([]);
        expect(await digestStored(sha(body))).toBe(false);
        expect(await records(e.id)).toBe(0);
      });
    }

    it('a delivery claiming audit-service itself is refused before provenance (`producer_not_admitted`)', async () => {
      const e = auditEnvelope('payment.succeeded', { headers: { source: 'audit-service' } });
      await publishRaw(Buffer.from(JSON.stringify(e.payload)), e.id, e.name, { source: 'audit-service' });
      expect(await deadCopy(e.id)).toMatchObject({ failure: 'permanent', reason: 'producer_not_admitted' });
      expect(await provenance(e.id)).toEqual([]);
      expect(await records(e.id)).toBe(0);
    });
  });

  describe('the default exchange (a retry, a replay, an injection)', () => {
    const inject = async (body: Buffer, e: EventEnvelope) => {
      const c = await amqp.connect(urlFor(INTRUDER));
      const cc = await c.createConfirmChannel();
      cc.sendToQueue(AUDIT_QUEUE, body, { persistent: true, messageId: e.id, type: e.name, userId: INTRUDER, headers: e.headers });
      await cc.waitForConfirms();
      await c.close();
    };

    it('an injected confidential body is refused at admission too: redacted, never ingested, no provenance', async () => {
      const e = auditEnvelope('payment.succeeded');
      e.payload = { ...e.payload, phone: PHONE };
      const body = Buffer.from(JSON.stringify(e.payload));
      await inject(body, e);
      const dead = await deadCopy(e.id);
      expect(dead).toMatchObject({ failure: 'permanent', reason: 'sensitive_field', redacted: true });
      expect(dead.content.toString()).not.toContain(PHONE);
      expect(await records(e.id)).toBe(0);
      expect(await digestStored(sha(body))).toBe(false);
    });

    it('an injected admitted event is ingested as before (observe-only) and no provenance is invented for it', async () => {
      const e = auditEnvelope('payment.succeeded');
      await inject(Buffer.from(JSON.stringify(e.payload)), e);
      await until(async () => (await records(e.id)) === 1);
      expect(await provenance(e.id)).toEqual([]);
    });
  });

  describe('crash windows (the consumer dies before acknowledging; the broker redelivers to a new consumer)', () => {
    let crashOwner: RabbitMqEventBus;
    /** A consumer wired exactly like `AuditConsumer` (admission, provenance, policy, ingestion), on its own exchange and queue. */
    const consumer = async (queue: string, before?: (e: EventEnvelope, ingest: () => Promise<void>, bus: EventBus) => Promise<void>) => {
      const ingestion = t.app.get(IngestionService);
      const bus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: CRASH_EXCHANGE, drainTimeoutMs: 200, retry: { maxRetries: 1, delayMs: 200 } });
      const outcomes: string[] = [];
      bus.setObserver((o) => void (o.type === 'provenance' && outcomes.push(o.outcome)));
      closers.push(() => bus.close());
      const ingest = (e: EventEnvelope) => async () => void (await ingestion.ingest(e));
      await bus.subscribe({
        queue, bindings: ['audit.#'],
        handler: (e) => (before ? before(e, ingest(e), bus) : ingest(e)()),
        admission: (e, body) => ingestion.admit(e, body),
        deadLetterPolicy: auditDeadLetterPolicy,
        provenance: { ownerOf: auditEventOwner, store: new PgProvenanceStore(t.app.get(DbService)) },
      });
      return { bus, outcomes };
    };
    beforeAll(() => {
      crashOwner = new RabbitMqEventBus({ url: urlFor(OWNER), exchange: CRASH_EXCHANGE });
      closers.push(() => crashOwner.close());
    });
    afterAll(async () => {
      for (const q of [`${prefix}.crash-a`, `${prefix}.crash-b`]) for (const s of ['', '.retry', '.dead']) await ch.deleteQueue(`${q}${s}`).catch(() => undefined);
      await ch.deleteExchange(CRASH_EXCHANGE).catch(() => undefined);
    });

    const crashThenRecover = async (queue: string, ingestBeforeCrash: boolean) => {
      let first = true;
      await consumer(queue, async (e, ingest, bus) => {
        if (!first) return ingest();
        first = false;
        if (ingestBeforeCrash) await ingest();
        void bus.close(); // the process dies: the in-flight delivery is never acknowledged
        await sleep(600);
      });
      const e = auditEnvelope('payment.succeeded');
      await crashOwner.publish(e);
      await until(() => !first);
      await sleep(900);
      const second = await consumer(queue);
      await until(async () => (await records(e.id)) === 1 && second.outcomes.length >= 1);
      return { e, second };
    };

    it('after the provenance commit and before ingestion: the redelivery is a provenance duplicate and is stored once', async () => {
      const queue = `${prefix}.crash-a`;
      const { e, second } = await crashThenRecover(queue, false);
      expect(second.outcomes).toEqual(['duplicate']);
      expect(await provenance(e.id, queue)).toEqual([expect.objectContaining({ verified: true })]);
      expect(await records(e.id)).toBe(1);
    });

    it('after ingestion and before the acknowledgement: the redelivery is a provenance duplicate and an ingestion duplicate (no second record)', async () => {
      const queue = `${prefix}.crash-b`;
      const { e, second } = await crashThenRecover(queue, true);
      expect(second.outcomes).toEqual(['duplicate']);
      await until(() => ALL_LOGS.some((l) => String(l.msg).startsWith(`audit_event_duplicate eventId=${e.id}`)));
      expect(await provenance(e.id, queue)).toEqual([expect.objectContaining({ verified: true })]);
      expect(await records(e.id)).toBe(1);
    });
  });

  describe('the store and the schema (PostgreSQL, migration 0005)', () => {
    const observation = (eventId: string, over: Partial<ProvenanceObservation> = {}): ProvenanceObservation => ({
      source: OWNER, eventId, name: 'audit.payment.succeeded', routingKey: 'audit.payment.succeeded', exchange: AUDIT_EXCHANGE, bodySha256: 'a'.repeat(64), producerUserId: OWNER, verified: true, reason: 'verified', ...over,
    });

    it('uniqueness holds under concurrency, as the runtime role: 20 identical observations → one row; concurrent differing ones are all kept as evidence', async () => {
      const store = new PgProvenanceStore(t.app.get(DbService));
      const id = randomUUID();
      const same = await Promise.all(Array.from({ length: 20 }, () => store.record('q.concurrency', observation(id))));
      expect(same.filter((r) => r === 'recorded')).toHaveLength(1);
      expect(same.filter((r) => r === 'duplicate')).toHaveLength(19);
      const id2 = randomUUID();
      const bodies = Array.from({ length: 8 }, (_, i) => String(i).repeat(64));
      await Promise.all([store.record('q.concurrency', observation(id2)), ...bodies.map((b) => store.record('q.concurrency', observation(id2, { bodySha256: b, producerUserId: INTRUDER, verified: false, reason: 'source_mismatch' })))]);
      const rows = await sql<{ bodySha256: string; verified: boolean }>(d.adminUrl, `SELECT "bodySha256", verified FROM event_provenance WHERE "eventId" = $1`, [id2]);
      expect(rows.map((r) => r.verified).sort((a, b) => Number(a) - Number(b))).toEqual([false, true]);
      const evidence = new Set([...rows.map((r) => r.bodySha256), ...(await conflicts(id2)).map((r) => String(r.bodySha256))]);
      expect(evidence).toEqual(new Set(['a'.repeat(64), ...bodies]));
    });

    it('append-only for every role: the owner is refused by the triggers, the runtime and the retention role hold no mutating privilege', async () => {
      await sql(d.migratorUrl, `SELECT audit_grant_retention($1::regrole)`, [d.retention]); // the retention grant covers audit_record only
      for (const table of ['event_provenance', 'event_provenance_conflict']) {
        for (const statement of [`UPDATE ${table} SET verified = verified`, `DELETE FROM ${table}`, `TRUNCATE ${table} CASCADE`]) {
          for (const url of [d.migratorUrl, d.appUrl, d.retentionUrl]) expect((await failure(url, statement)).code, `${statement} as ${url.split('@')[0]!.split(':')[1]}`).toBe('42501');
        }
      }
      expect((await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM event_provenance`))[0]!.n).toBeGreaterThan(0);
    });

    it('the database refuses a VERIFIED row that does not meet §13.2 (an unverified observation can never be stored as authority)', async () => {
      const insert = (o: Partial<ProvenanceObservation>) => {
        const v = observation(randomUUID(), o);
        return failure(d.appUrl, `INSERT INTO event_provenance (consumer, source, "eventId", name, "routingKey", exchange, "bodySha256", "producerUserId", verified, reason) VALUES ('q.shape', $1, $2, $3, $4, $5, $6, $7, true, 'verified')`,
          [v.source, v.eventId, v.name, v.routingKey, v.exchange, v.bodySha256, v.producerUserId]);
      };
      for (const bad of [{ producerUserId: null }, { producerUserId: INTRUDER }, { routingKey: 'audit.other' }, { eventId: 'not-a-uuid' }, { name: '' }]) {
        expect((await insert(bad as Partial<ProvenanceObservation>)).code, JSON.stringify(bad)).toBe('23514');
      }
    });

    it('the dead-letter queue still holds nothing it should not (nothing left over by the suite)', async () => {
      expect(await depth(ch, DEAD_QUEUE)).toBe(0);
    });
  });
});
