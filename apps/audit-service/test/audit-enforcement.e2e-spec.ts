import { createHash, randomBytes } from 'node:crypto';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SAMPLE_IDS } from '@nawara/audit-contract/testing';
import { InMemoryEventBus, RabbitMqEventBus, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { AUDIT_EXCHANGE, AUDIT_QUEUE } from '../src/ingestion/ingestion.constants.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { DEAD_QUEUE, RETRY_QUEUE, auditEnvelope, deleteAuditQueues, depth } from './support/broker.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Core V2 S1e-3 (ADR-0057 §13.5, "S0-C6" Audit) certification of Audit's STRICT mode (`AUDIT_PROVENANCE_ENFORCEMENT=strict`) over a REAL
 * RabbitMQ and a REAL PostgreSQL 16, through the real module graph, as the runtime role:
 * - only a verified original, its verified redelivery or a replay matching the stored verified observation is ingested; every unverified
 *   delivery (another identity, a forged `source`, no `user_id`, a default-exchange injection) is refused BEFORE ingestion, so a forger can
 *   never claim an event id's first-writer record, and a later verified original of that id is still ingested;
 * - admission (canonical bytes, the Stage 18.8 screen, the full contract) runs FIRST: a sensitive delivery leaves no provenance row and no
 *   digest, and its dead letter is redacted; a trust refusal goes through the same Stage 18.8 policy (only the validated headers survive);
 * - a provenance or replay-lookup failure is HELD (requeued, the handler never running, nothing in `.retry` or `.dead`);
 * - a bus that cannot enforce never runs ingestion in any other mode.
 * The compatibility phase (the default) is `event-provenance.e2e-spec.ts`. Broker users: `payment-service` (the catalog producer of the
 * `payment.*` actions; refused if such a user already exists, never overwritten) and an intruder, deleted at the end. The audit queues are
 * the production names, so they are deleted before and after (a disposable / dev broker only).
 */
const PHONE = '+21620000009';
const hex = (n: number) => randomBytes(n).toString('hex');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeWithEnv('S1e-3 Audit strict provenance enforcement (real RabbitMQ, real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
  const OWNER = 'payment-service';
  const prefix = `s1e3${hex(4)}`;
  const INTRUDER = `${prefix}-intruder`;
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
  const busNotices: string[] = [];
  let d: ProvisionedDatabase;
  let conn: ChannelModel;
  let ch: Channel;
  let t: TestApp;
  let owner: RabbitMqEventBus;
  let intruder: RabbitMqEventBus;

  const until = (cond: () => Promise<boolean> | boolean, timeout = 20_000) => vi.waitFor(async () => expect(await cond()).toBe(true), { timeout, interval: 100 });
  const records = async (id: string) => (await sql(d.adminUrl, `SELECT 1 FROM audit_record WHERE "eventId" = $1`, [id])).length;
  const record = async (id: string) => (await sql<Record<string, unknown>>(d.adminUrl, `SELECT * FROM audit_record WHERE "eventId" = $1`, [id]))[0];
  const provenance = (id: string) =>
    sql<Record<string, unknown>>(d.adminUrl, `SELECT "producerUserId", verified, reason, "bodySha256" FROM event_provenance WHERE "eventId" = $1 AND consumer = $2 ORDER BY "firstSeenAt", id`, [id, AUDIT_QUEUE]);
  const digestStored = async (digest: string) =>
    (await sql(d.adminUrl, `SELECT 1 FROM event_provenance WHERE "bodySha256" = $1 UNION ALL SELECT 1 FROM event_provenance_conflict WHERE "bodySha256" = $1`, [digest])).length > 0;
  const logged = (prefixText: string) => ALL_LOGS.some((l) => String(l.msg).startsWith(prefixText));
  const notice = (start: string, id: string, extra = '') => busNotices.some((m) => m.startsWith(start) && m.includes(`event=${id}`) && m.includes(extra));
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
    return { failure: h['x-nawara-failure'], reason: h['x-nawara-failure-reason'], redacted: h['x-nawara-body-redacted'] === 'true', headers: h, content: found!.content };
  };
  /** Raw bytes to the event exchange on the admin connection (no `user_id`), with the catalog owner claimed as `source`. */
  const publishRaw = async (body: Buffer, e: EventEnvelope, headers: Record<string, unknown> = {}) => {
    const c = await conn.createConfirmChannel();
    c.publish(AUDIT_EXCHANGE, e.name, body, { persistent: true, contentType: 'application/json', messageId: e.id, type: e.name, headers: { ...e.headers, ...headers } });
    await c.waitForConfirms();
    await c.close();
  };
  /** Straight into Audit's queue through the default exchange, as `user` (or the admin): a retry, a replay or an injection. */
  const inject = async (body: Buffer, e: EventEnvelope, user?: string) => {
    const c = user ? await amqp.connect(urlFor(user)) : conn;
    const cc = await c.createConfirmChannel();
    cc.sendToQueue(AUDIT_QUEUE, body, { persistent: true, contentType: 'application/json', messageId: e.id, type: e.name, ...(user ? { userId: user } : {}), headers: e.headers });
    await cc.waitForConfirms();
    await cc.close();
    if (user) await c.close();
  };
  const bytes = (e: EventEnvelope) => Buffer.from(JSON.stringify(e.payload));

  beforeAll(async () => {
    const existing = await api('GET', `/users/${OWNER}`);
    if (existing.status !== 404) throw new Error(`a broker user named ${OWNER} already exists on TEST_RABBITMQ_URL's broker; refusing to overwrite it`);
    for (const user of [OWNER, INTRUDER]) {
      const r = await api('PUT', `/users/${encodeURIComponent(user)}`, { password: passwords[user], tags: '' });
      if (!r.ok) throw new Error(`management API: ${r.status}`);
      created.push(user);
      await api('PUT', `/permissions/%2F/${encodeURIComponent(user)}`, { configure: '^nawara\\.events$', write: '^(nawara\\.events|amq\\.default)$', read: '^$' });
    }
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'astrict');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    ch = await conn.createChannel();
    ch.on('error', () => undefined);
    await deleteAuditQueues(ch);
    owner = new RabbitMqEventBus({ url: urlFor(OWNER), exchange: AUDIT_EXCHANGE });
    intruder = new RabbitMqEventBus({ url: urlFor(INTRUDER), exchange: AUDIT_EXCHANGE });
    const bus = new RabbitMqEventBus({
      url: env.TEST_RABBITMQ_URL, exchange: AUDIT_EXCHANGE, prefetch: 5, retry: { maxRetries: 1, delayMs: 300 }, replayLookupTimeoutMs: 500, onNotice: (m) => void busNotices.push(m),
    });
    t = await createTestApp({ databaseUrl: d.appUrl, rabbitmqUrl: env.TEST_RABBITMQ_URL, bus, env: { AUDIT_PROVENANCE_ENFORCEMENT: 'strict' } });
    await vi.waitFor(async () => expect((await request(t.app.getHttpServer()).get('/ready')).body).toEqual({ status: 'ready' }), { timeout: 20_000, interval: 100 });
  });
  afterAll(async () => {
    await t?.app.close();
    await owner?.close();
    await intruder?.close();
    if (ch) await deleteAuditQueues(ch).catch(() => undefined);
    await conn?.close().catch(() => undefined);
    for (const user of created) await api('DELETE', `/users/${encodeURIComponent(user)}`);
    await d?.drop();
  });

  it('runs in strict mode, as configured', () => {
    expect(t.config.provenanceEnforcement).toBe('strict');
    expect(logged(`audit_ingestion_started queue=${AUDIT_QUEUE} bindings=audit.# enforcement=strict`)).toBe(true);
  });

  describe('verified-only acceptance', () => {
    it('a verified original (the catalog owner\'s broker identity) is ingested, after its verified provenance', async () => {
      const e = auditEnvelope('payment.succeeded');
      await owner.publish(e);
      await until(async () => (await records(e.id)) === 1);
      expect(await provenance(e.id)).toEqual([{ producerUserId: OWNER, verified: true, reason: 'verified', bodySha256: sha(bytes(e)) }]);
    });

    it('its verified redelivery and a replay of the same bytes (the default exchange) are accepted and de-duplicated: one record', async () => {
      const e = auditEnvelope('payment.succeeded');
      await owner.publish(e);
      await until(async () => (await records(e.id)) === 1);
      await owner.publish(e); // a producer re-send of the identical event: a verified duplicate
      await until(() => ALL_LOGS.filter((l) => String(l.msg).startsWith(`audit_event_duplicate eventId=${e.id}`)).length === 1);
      await inject(bytes(e), e); // a retry / operator replay of the same bytes: matches the stored verified observation
      await until(() => ALL_LOGS.filter((l) => String(l.msg).startsWith(`audit_event_duplicate eventId=${e.id}`)).length === 2);
      expect(await records(e.id)).toBe(1);
      expect(notice('event_trust_refused', e.id)).toBe(false);
    });
  });

  describe('unverified deliveries are refused before ingestion (no record, no first-writer slot)', () => {
    it('no `user_id` (the admin connection) → `untrusted_unverified_original`; the observation stays as unverified evidence', async () => {
      const e = auditEnvelope('payment.succeeded');
      await publishRaw(bytes(e), e);
      expect(await deadCopy(e.id)).toMatchObject({ failure: 'permanent', reason: 'untrusted_unverified_original' });
      expect(await records(e.id)).toBe(0);
      expect(await provenance(e.id)).toEqual([expect.objectContaining({ producerUserId: null, verified: false })]);
    });

    it('another broker identity claiming the owner\'s `source` → `untrusted_unverified_original`', async () => {
      const e = auditEnvelope('payment.succeeded');
      await intruder.publish(e);
      expect(await deadCopy(e.id)).toMatchObject({ failure: 'permanent', reason: 'untrusted_unverified_original' });
      expect(await records(e.id)).toBe(0);
      expect(await provenance(e.id)).toEqual([expect.objectContaining({ producerUserId: INTRUDER, verified: false, reason: 'source_mismatch' })]);
    });

    it('FIRST-WRITER PRE-EMPTION: a forger publishing the genuine id first (with forged content) claims nothing; the later verified original is ingested with ITS content', async () => {
      const genuine = auditEnvelope('payment.succeeded');
      const forged: EventEnvelope = { ...genuine, payload: { ...genuine.payload, organizationId: SAMPLE_IDS.uuidB } };
      expect(forged.payload.organizationId).not.toBe(genuine.payload.organizationId);
      await intruder.publish(forged);
      expect(await deadCopy(genuine.id)).toMatchObject({ reason: 'untrusted_unverified_original' });
      expect(await records(genuine.id)).toBe(0);
      // S0-C4 / S0-C6: an earlier unverified observation never invalidates a later verified original of the same id
      await owner.publish(genuine);
      await until(async () => (await records(genuine.id)) === 1);
      expect((await record(genuine.id))!.organizationId).toBe(genuine.payload.organizationId);
      expect(logged(`audit_event_persisted eventId=${genuine.id}`)).toBe(true);
      expect(await provenance(genuine.id)).toEqual([
        expect.objectContaining({ producerUserId: INTRUDER, verified: false, bodySha256: sha(bytes(forged)) }),
        expect.objectContaining({ producerUserId: OWNER, verified: true, bodySha256: sha(bytes(genuine)) }),
      ]);
      expect(await depth(ch, DEAD_QUEUE)).toBe(0); // the genuine event was never refused (no `event_id_conflict`)
    });

    it('a verified delivery that CONTRADICTS the stored verified observation → `untrusted_verified_conflict`; the record is untouched', async () => {
      const e = auditEnvelope('payment.succeeded');
      await owner.publish(e);
      await until(async () => (await records(e.id)) === 1);
      const before = await record(e.id);
      await owner.publish(auditEnvelope('payment.succeeded', { id: e.id, variant: 'minimal' }));
      expect(await deadCopy(e.id)).toMatchObject({ failure: 'permanent', reason: 'untrusted_verified_conflict' });
      expect(await record(e.id)).toEqual(before);
    });
  });

  describe('default-exchange forgery (an injection, never an original publication)', () => {
    it('with no stored observation → `untrusted_replay_no_provenance`; nothing is ingested or invented', async () => {
      const e = auditEnvelope('payment.succeeded');
      await inject(bytes(e), e, INTRUDER);
      expect(await deadCopy(e.id)).toMatchObject({ failure: 'permanent', reason: 'untrusted_replay_no_provenance' });
      expect(await records(e.id)).toBe(0);
      expect(await provenance(e.id)).toEqual([]);
    });

    it('matching only an unverified observation → `untrusted_unverified_replay` (an unverified original is never laundered by a replay)', async () => {
      const e = auditEnvelope('payment.succeeded');
      await intruder.publish(e);
      expect(await deadCopy(e.id)).toMatchObject({ reason: 'untrusted_unverified_original' });
      await inject(bytes(e), e, INTRUDER);
      expect(await deadCopy(e.id)).toMatchObject({ reason: 'untrusted_unverified_replay' });
      expect(await records(e.id)).toBe(0);
    });

    it('changing a verified original\'s body under its id → `untrusted_replay_mismatch`; the record is untouched', async () => {
      const e = auditEnvelope('payment.succeeded');
      await owner.publish(e);
      await until(async () => (await records(e.id)) === 1);
      const before = await record(e.id);
      const changed = auditEnvelope('payment.succeeded', { id: e.id, variant: 'minimal' });
      await inject(bytes(changed), changed, INTRUDER);
      expect(await deadCopy(e.id)).toMatchObject({ failure: 'permanent', reason: 'untrusted_replay_mismatch' });
      expect(await record(e.id)).toEqual(before);
    });
  });

  describe('privacy: admission before provenance; refusals through the Stage 18.8 policy', () => {
    it('a sensitive event from the VERIFIED owner is refused at admission first: redacted, no provenance row, no digest, no trust decision, no record', async () => {
      const e = auditEnvelope('payment.succeeded');
      e.payload = { ...e.payload, phone: PHONE };
      await owner.publish(e);
      const dead = await deadCopy(e.id);
      expect(dead).toMatchObject({ failure: 'permanent', reason: 'sensitive_field', redacted: true });
      expect(dead.content.toString('latin1')).not.toContain(PHONE);
      expect(await provenance(e.id)).toEqual([]);
      expect(await digestStored(sha(bytes(e)))).toBe(false);
      expect(busNotices.some((m) => m.startsWith('event_trust_') && m.includes(`event=${e.id}`))).toBe(false); // never reached the decision
      expect(await records(e.id)).toBe(0);
    });

    it('a sensitive default-exchange injection is refused at admission too (before any replay lookup)', async () => {
      const e = auditEnvelope('payment.succeeded');
      e.payload = { ...e.payload, phone: PHONE };
      await inject(bytes(e), e, INTRUDER);
      const dead = await deadCopy(e.id);
      expect(dead).toMatchObject({ reason: 'sensitive_field', redacted: true });
      expect(dead.content.toString('latin1')).not.toContain(PHONE);
      expect(busNotices.some((m) => /^event_(replay_classified|trust_)/.test(m) && m.includes(`event=${e.id}`))).toBe(false); // neither classified nor decided
      expect(await digestStored(sha(bytes(e)))).toBe(false);
    });

    it('a trust refusal keeps only the validated headers: a header a forger attached never reaches the dead letters', async () => {
      const e = auditEnvelope('payment.succeeded');
      await publishRaw(bytes(e), e, { 'x-contact': PHONE });
      const dead = await deadCopy(e.id);
      expect(dead).toMatchObject({ reason: 'untrusted_unverified_original', redacted: false }); // an admitted (token-only) body: replayable evidence
      expect(dead.headers['x-contact']).toBeUndefined();
      expect(JSON.stringify(dead.headers)).not.toContain(PHONE);
      expect(dead.content.equals(bytes(e))).toBe(true);
    });
  });

  describe('a provenance failure is held, never decided', () => {
    it('the database refuses connections: the original delivery is held and requeued (no handler, nothing in .retry or .dead); on recovery one record', async () => {
      const e = auditEnvelope('payment.succeeded');
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS false`);
      await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND application_name = 'audit-service'`, [d.name]);
      try {
        await owner.publish(e);
        await until(() => notice('event_trust_held', e.id, 'basis=provenance_unavailable'));
        await sleep(700); // at least one more hold
        expect(logged(`audit_ingest_transient_failure eventId=${e.id}`)).toBe(false);
        expect(await depth(ch, RETRY_QUEUE)).toBe(0);
        expect(await depth(ch, DEAD_QUEUE)).toBe(0);
      } finally {
        await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS true`);
      }
      await until(async () => (await records(e.id)) === 1, 30_000);
      expect(await depth(ch, DEAD_QUEUE)).toBe(0);
    }, 60_000);

    it('a replay lookup that cannot complete (the provenance table locked past the lookup bound) is held, then accepted once it can', async () => {
      const e = auditEnvelope('payment.succeeded');
      await owner.publish(e);
      await until(async () => (await records(e.id)) === 1);
      const lock = new pg.Client({ connectionString: d.adminUrl });
      await lock.connect();
      try {
        await lock.query('BEGIN');
        await lock.query('LOCK TABLE event_provenance IN ACCESS EXCLUSIVE MODE');
        await inject(bytes(e), e);
        await until(() => notice('event_replay_classified', e.id, 'outcome=replay_lookup_failure'));
        await until(() => notice('event_trust_held', e.id, 'basis=provenance_unavailable'));
        expect(await depth(ch, DEAD_QUEUE)).toBe(0);
        expect(logged(`audit_event_duplicate eventId=${e.id}`)).toBe(false);
      } finally {
        await lock.query('ROLLBACK').catch(() => undefined);
        await lock.end();
      }
      await until(() => logged(`audit_event_duplicate eventId=${e.id}`), 30_000); // held, then matched against the verified original
      expect(await records(e.id)).toBe(1);
      expect(await depth(ch, DEAD_QUEUE)).toBe(0);
    }, 60_000);
  });

  it('a bus that cannot enforce never runs ingestion in another mode: not ready, `enforcement_unavailable`, nothing consumed', async () => {
    const other = await createTestApp({ databaseUrl: d.appUrl, rabbitmqUrl: env.TEST_RABBITMQ_URL, bus: new InMemoryEventBus(), env: { AUDIT_PROVENANCE_ENFORCEMENT: 'strict' } });
    try {
      await until(() => other.logs.some((l) => String(l.msg).startsWith('audit_ingestion_waiting reason=enforcement_unavailable')));
      const ready = await request(other.app.getHttpServer()).get('/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.failed).toContain('audit-ingestion');
      expect(other.logs.some((l) => String(l.msg).startsWith('audit_ingestion_started'))).toBe(false);
    } finally {
      await other.app.close();
    }
  });

  it('the dead-letter queue holds nothing left over by the suite', async () => {
    expect(await depth(ch, DEAD_QUEUE)).toBe(0);
  });
});
