import { createHash, randomBytes, randomUUID } from 'node:crypto';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DbService, PermanentEventFailure, PgKeyedProvenanceStore, RabbitMqEventBus, bodyMac, kitMigrationsDir, replayDeadLetter, runMigrations, type EventBus, type EventEnvelope,
  type KeyedProvenanceObservation, type ProvenanceKeyRing,
} from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { intakeEventOwner } from '../src/intake/event-consumer.js';
import { EVENT_MAP, INTAKE_QUEUE } from '../src/intake/event-map.js';
import { IntakeService } from '../src/intake/intake.service.js';
import { TEST_PROVENANCE_KEY, TEST_PROVENANCE_KEYS, createTestApp, type TestApp } from './support/app.js';
import { failure, sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * Core V2 S1b-3 (ADR-0057 §13.2 with its S0-C2 revision, §13.3, §13.4; observe-only) for the Notification intake, over a REAL RabbitMQ
 * and a REAL PostgreSQL (migration 0003): every delivery's provenance is committed before the intake runs, and its body is stored ONLY as
 * a keyed commitment (HMAC-SHA-256 under the provenance ring). Auth's events are published by a disposable broker user named
 * `auth-service` (the `EVENT_MAP` owner; refused if such a user already exists, never overwritten) and by an intruder. The intake queue
 * is the production name, so its queues are deleted before and after (a disposable / dev broker only). Every code here is SYNTHETIC.
 */
const EXCHANGE = 'nawara.events';
const CODE = '730591';
const EMAIL = 'member@example.test';
const PHONE = '+21620000009';
const IP = '203.0.113.7';
const ORG = '7e9c8a6b-5d4f-4e3a-9b2c-1d0e9f8a7b6c';
const hex = (n: number) => randomBytes(n).toString('hex');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const future = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const bytes = (e: EventEnvelope) => Buffer.from(JSON.stringify(e.payload)); // exactly what the kit publisher writes

/** A valid payload for every mapped event (Auth's exact shapes, as in `intake.e2e-spec.ts`). */
function payloadFor(name: string, code = CODE): Record<string, unknown> {
  const dest = { userId: `user-${randomUUID().slice(0, 8)}`, channel: 'email', destination: EMAIL };
  const at = new Date().toISOString();
  switch (name) {
    case 'member.contact_verification_requested':
      return { ...dest, code, expiresAt: future(600) };
    case 'admin.operator_code_issued':
    case 'admin.operator_confirmation_code_issued':
      return { ...dest, code, expiresAt: future(3600), timestamp: at };
    case 'admin.owner_recovery_requested':
      return { ...dest, availableAt: future(86400), ipAddress: IP, timestamp: at };
    case 'admin.owner_recovery_completed':
    case 'admin.owner_login_from_new_device':
      return { ...dest, ipAddress: IP, timestamp: at };
    default:
      return { ...dest, organizationId: ORG, timestamp: at };
  }
}

describeWithEnv('S1b-3 keyed event provenance in Notification (real RabbitMQ, real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
  const OWNER = 'auth-service';
  const prefix = `s1b3${hex(4)}`;
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
  // Synthetic rotation keys, random per run (p1 is the test app's default ring).
  const P2 = randomBytes(32);
  const P3 = randomBytes(32);
  const ring = (entries: Array<[string, Buffer]>) => entries.map(([id, k]) => `${id}:${k.toString('base64')}`).join(',');

  const created: string[] = [];
  const closers: Array<() => Promise<unknown>> = [];
  const allLogs: Array<Record<string, unknown>> = [];
  let db: TestDatabase;
  let conn: ChannelModel;
  let ch: Channel;
  let t: TestApp | undefined;
  let owner: RabbitMqEventBus;
  let intruder: RabbitMqEventBus;

  const until = (cond: () => Promise<boolean> | boolean, timeout = 20_000) => vi.waitFor(async () => expect(await cond()).toBe(true), { timeout, interval: 100 });
  const deleteQueues = async () => {
    for (const q of [INTAKE_QUEUE, `${INTAKE_QUEUE}.retry`, `${INTAKE_QUEUE}.dead`]) await ch.deleteQueue(q).catch(() => undefined);
  };
  const depth = async (q: string) => (await ch.checkQueue(q)).messageCount;
  const envelope = (name: string, payload = payloadFor(name), id: string = randomUUID()): EventEnvelope => ({
    id, name, payload, headers: { eventId: id, occurredAt: new Date().toISOString(), source: OWNER, version: 1, correlationId: `corr-${id.slice(0, 8)}` },
  });
  const intents = async (id: string) => (await sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM notification WHERE "sourceEventId" = $1`, [id]))[0]!.n;
  const provenance = (id: string, consumer = INTAKE_QUEUE) =>
    sql<Record<string, unknown>>(db.url, `SELECT consumer, source, name, "routingKey", exchange, "bodyCommitmentVersion", "bodyMacKeyId", "bodyMac", "producerUserId", verified, reason
      FROM event_provenance WHERE "eventId" = $1 AND consumer = $2 ORDER BY "firstSeenAt"`, [id, consumer]);
  const conflicts = (id: string) =>
    sql<Record<string, unknown>>(db.url, `SELECT "producerUserId", verified, reason, "bodyMacKeyId", "bodyMac", comparison FROM event_provenance_conflict WHERE "eventId" = $1 ORDER BY "observedAt"`, [id]);
  /** (Re)starts the application with the given provenance ring (default: the test app's p1). */
  const startApp = async (over: NodeJS.ProcessEnv = {}) => {
    if (t) await t.app.close();
    t = await createTestApp({ databaseUrl: db.url, bus: 'rabbitmq', env: over });
    const logs = t.logs;
    closers.push(async () => void allLogs.push(...logs));
    await vi.waitFor(async () => expect((await request(t!.app.getHttpServer()).get('/ready')).status).toBe(200), { timeout: 20_000, interval: 100 });
    return t;
  };
  const logged = (prefixText: string) => t!.logs.some((l) => String(l.msg).startsWith(prefixText));
  /**
   * Core V2 S1e-4: the dead-letter copy of message `id` (removed from the DLQ, with every other copy seen meanwhile), once it arrived. A
   * strict refusal is a permanent dead letter, so each test takes its own copies (the later depth assertions stay exact).
   */
  const takeDead = async (id: string) => {
    const seen: amqp.GetMessage[] = [];
    let found: amqp.GetMessage | undefined;
    await until(async () => {
      for (;;) {
        const m = await ch.get(`${INTAKE_QUEUE}.dead`, { noAck: true });
        if (!m) break;
        seen.push(m);
      }
      found = seen.find((m) => m.properties.messageId === id);
      return found !== undefined;
    });
    const h = found!.properties.headers ?? {};
    return { reason: h['x-nawara-failure-reason'], redacted: h['x-nawara-body-redacted'] === 'true', content: found!.content, headers: h };
  };

  beforeAll(async () => {
    const existing = await api('GET', `/users/${OWNER}`);
    if (existing.status !== 404) throw new Error(`a broker user named ${OWNER} already exists on TEST_RABBITMQ_URL's broker; refusing to overwrite it`);
    for (const user of [OWNER, INTRUDER]) {
      const r = await api('PUT', `/users/${encodeURIComponent(user)}`, { password: passwords[user], tags: '' });
      if (!r.ok) throw new Error(`management API: ${r.status}`);
      created.push(user);
      await api('PUT', `/permissions/%2F/${encodeURIComponent(user)}`, { configure: `^(nawara\\.events|${prefix}\\..*)$`, write: `^(nawara\\.events|${prefix}\\..*|amq\\.default)$`, read: '^$' });
    }
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifs1b3');
    await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    ch = await conn.createChannel();
    ch.on('error', () => undefined);
    await deleteQueues();
    owner = new RabbitMqEventBus({ url: urlFor(OWNER) });
    intruder = new RabbitMqEventBus({ url: urlFor(INTRUDER) });
    await startApp();
  });
  afterAll(async () => {
    if (t) {
      allLogs.push(...t.logs);
      await t.app.close();
    }
    for (const close of closers) await close().catch(() => undefined);
    await owner?.close();
    await intruder?.close();
    if (ch) await deleteQueues();
    await conn?.close().catch(() => undefined);
    for (const user of created) await api('DELETE', `/users/${encodeURIComponent(user)}`);
    await db?.drop();
  });

  describe('original deliveries: keyed, verified from the broker, committed before the intake', () => {
    it('the owner resolver is EVENT_MAP itself: every intake name is owned by its mapped source (auth-service), anything else by nobody', () => {
      expect(EVENT_MAP.map((m) => m.name).sort()).toEqual([
        'admin.operator_code_issued', 'admin.operator_confirmation_code_issued', 'admin.owner_login_from_new_device', 'admin.owner_recovery_completed',
        'admin.owner_recovery_requested', 'member.contact_verification_requested', 'membership.approved', 'membership.rejected', 'membership.revoked',
      ]);
      for (const m of EVENT_MAP) expect(intakeEventOwner(m.name)).toBe('auth-service');
      for (const name of ['user.registered', 'payment.succeeded', 'audit.login_succeeded']) expect(intakeEventOwner(name)).toBeUndefined();
    });

    it('all nine events, published by Auth itself, are VERIFIED with an HMAC of the raw body under the active key, committed BEFORE the intent', async () => {
      // Test-only proof of the ORDER: an intent can be written only once a COMMITTED provenance row of its event exists.
      await sql(db.url, `CREATE FUNCTION test_s1b3_requires_provenance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW."sourceEventId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM event_provenance WHERE "eventId" = NEW."sourceEventId"::text) THEN
            RAISE EXCEPTION 'intent written before its provenance'; END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER notification_00_test_requires_provenance BEFORE INSERT ON notification FOR EACH ROW EXECUTE FUNCTION test_s1b3_requires_provenance()`);
      try {
        for (const m of EVENT_MAP) {
          const e = envelope(m.name);
          await owner.publish(e);
          await until(async () => (await intents(e.id)) === 1);
          expect(await provenance(e.id), m.name).toEqual([{
            consumer: INTAKE_QUEUE, source: OWNER, name: m.name, routingKey: m.name, exchange: EXCHANGE, bodyCommitmentVersion: 1, bodyMacKeyId: 'p1',
            bodyMac: bodyMac(TEST_PROVENANCE_KEY, bytes(e)), producerUserId: OWNER, verified: true, reason: 'verified',
          }]);
        }
      } finally {
        await sql(db.url, `DROP TRIGGER notification_00_test_requires_provenance ON notification; DROP FUNCTION test_s1b3_requires_provenance()`);
      }
    });

    it('CONFIDENTIALITY: without the key, trying all 10^6 codes never matches the stored commitment; no unkeyed digest, code, destination or key is stored', async () => {
      const e = envelope('member.contact_verification_requested');
      await owner.publish(e);
      await until(async () => (await intents(e.id)) === 1);
      const [row] = await provenance(e.id);
      const stored = String(row!.bodyMac);
      // the database-only attacker: knows every field but the code (they are all in this database) and tries every code with an unkeyed
      // digest. Against an unkeyed SHA-256 this finds the code; against the keyed commitment it finds nothing.
      const before = JSON.stringify(e.payload).split(`"code":"${CODE}"`);
      expect(before).toHaveLength(2);
      let unkeyedHits = 0;
      let wouldHaveLeaked = false;
      for (let c = 0; c < 1_000_000; c++) {
        const guess = String(c).padStart(6, '0');
        const digest = sha(`${before[0]}"code":"${guess}"${before[1]}`);
        if (digest === stored) unkeyedHits += 1;
        if (guess === CODE && digest === sha(bytes(e))) wouldHaveLeaked = true;
      }
      expect(unkeyedHits).toBe(0);
      expect(wouldHaveLeaked).toBe(true); // the same search WOULD recover the code from an unkeyed digest (the S0-C2 reason)
      // integrity, with the key (which the attacker does not have): only the true code verifies
      expect(bodyMac(TEST_PROVENANCE_KEY, bytes(e))).toBe(stored);
      expect(bodyMac(TEST_PROVENANCE_KEY, Buffer.from(`${before[0]}"code":"000000"${before[1]}`))).not.toBe(stored);
      // the schema has no unkeyed body digest; no row holds the code, the destination, the user id or any key material
      const columns = await sql<{ c: string }>(db.url, `SELECT column_name AS c FROM information_schema.columns WHERE table_name IN ('event_provenance', 'event_provenance_conflict')`);
      expect(columns.map((x) => x.c).filter((c) => /sha256|digest|hash/i.test(c))).toEqual([]);
      const dump = JSON.stringify(await sql(db.url, `SELECT * FROM event_provenance`)) + JSON.stringify(await sql(db.url, `SELECT * FROM event_provenance_conflict`));
      for (const secret of [CODE, EMAIL, PHONE, String(e.payload.userId), TEST_PROVENANCE_KEY.toString('base64'), TEST_PROVENANCE_KEY.toString('hex'), sha(bytes(e))]) {
        expect(dump).not.toContain(secret);
      }
    }, 120_000);

    it('a forged source (another broker user) is UNVERIFIED and refused BEFORE the intake (S1e-4), its copy redacted; the genuine event later is verified and taken, the difference kept as evidence', async () => {
      const e = envelope('admin.operator_code_issued');
      await intruder.publish(e);
      const dead = await takeDead(e.id);
      expect(dead).toMatchObject({ reason: 'untrusted_unverified_original', redacted: true });
      expect(dead.content.toString('latin1')).not.toContain(CODE);
      expect(await intents(e.id)).toBe(0); // the forger claimed no first-writer slot
      expect(await provenance(e.id)).toEqual([expect.objectContaining({ source: OWNER, producerUserId: INTRUDER, verified: false, reason: 'source_mismatch' })]);
      await owner.publish(e);
      await until(async () => (await intents(e.id)) === 1);
      await until(async () => (await provenance(e.id)).length === 2);
      expect((await provenance(e.id))[1]).toMatchObject({ producerUserId: OWNER, verified: true });
      expect(await intents(e.id)).toBe(1);
      expect(await conflicts(e.id)).toEqual([{ producerUserId: OWNER, verified: true, reason: 'verified', bodyMacKeyId: 'p1', bodyMac: bodyMac(TEST_PROVENANCE_KEY, bytes(e)), comparison: 'differs' }]);
    });

    it('the same delivery again is a duplicate (one row, no evidence); a CHANGED CODE under the same id is a conflict, the first row untouched', async () => {
      const e = envelope('member.contact_verification_requested');
      await owner.publish(e);
      await owner.publish(e);
      await until(async () => (await intents(e.id)) === 1);
      await until(() => t!.logs.filter((l) => String(l.msg).startsWith('notification_duplicate')).length > 0);
      expect(await provenance(e.id)).toHaveLength(1);
      expect(await conflicts(e.id)).toEqual([]);
      const changed = envelope('member.contact_verification_requested', { ...e.payload, code: '000001' }, e.id);
      await owner.publish(changed);
      // S1e-4: it contradicts the stored verified observation: refused before the intake, its code never in the dead letter
      const dead = await takeDead(e.id);
      expect(dead).toMatchObject({ reason: 'untrusted_verified_conflict', redacted: true });
      expect(dead.content.toString('latin1')).not.toContain('000001');
      await until(async () => (await conflicts(e.id)).length === 1);
      expect((await provenance(e.id))[0]).toMatchObject({ bodyMac: bodyMac(TEST_PROVENANCE_KEY, bytes(e)) });
      expect((await conflicts(e.id))[0]).toMatchObject({ verified: true, bodyMacKeyId: 'p1', bodyMac: bodyMac(TEST_PROVENANCE_KEY, bytes(changed)), comparison: 'differs' });
      expect(await intents(e.id)).toBe(1); // the intake de-duplicates exactly as before
    });
  });

  describe('key rotation and historical keys (compared under the STORED key)', () => {
    const genuine = envelope('admin.operator_confirmation_code_issued');
    const other = envelope('membership.approved');

    it('after a rotation (p1 → p2) an identical redelivery of a p1 row is a duplicate, never a false conflict; new and changed observations use p2', async () => {
      await owner.publish(genuine);
      await owner.publish(other);
      await until(async () => (await intents(genuine.id)) === 1 && (await intents(other.id)) === 1);
      expect((await provenance(genuine.id))[0]).toMatchObject({ bodyMacKeyId: 'p1' });
      await startApp({ NOTIFICATION_PROVENANCE_KEYS: `${TEST_PROVENANCE_KEYS},${ring([['p2', P2]])}`, NOTIFICATION_PROVENANCE_ACTIVE_KEY_ID: 'p2' });
      await owner.publish(genuine);
      await until(() => t!.logs.some((l) => String(l.msg).startsWith('notification_duplicate')));
      expect(await provenance(genuine.id)).toHaveLength(1);
      expect(await conflicts(genuine.id)).toEqual([]); // MACs under different keys were never compared
      const changed = envelope(genuine.name, { ...genuine.payload, code: '000002' }, genuine.id);
      await owner.publish(changed);
      expect(await takeDead(genuine.id)).toMatchObject({ reason: 'untrusted_verified_conflict', redacted: true }); // S1e-4
      await until(async () => (await conflicts(genuine.id)).length === 1);
      expect((await conflicts(genuine.id))[0]).toMatchObject({ bodyMacKeyId: 'p2', bodyMac: bodyMac(P2, bytes(changed)), comparison: 'differs' }); // compared under p1
      const fresh = envelope('membership.revoked');
      await owner.publish(fresh);
      await until(async () => (await intents(fresh.id)) === 1);
      expect((await provenance(fresh.id))[0]).toMatchObject({ bodyMacKeyId: 'p2', bodyMac: bodyMac(P2, bytes(fresh)) });
    });

    it('a stored key that is UNAVAILABLE (not in the ring, not retired) fails closed: held and requeued, no intake, no evidence; restored, it is a duplicate', async () => {
      await startApp({ NOTIFICATION_PROVENANCE_KEYS: ring([['p3', P3]]), NOTIFICATION_PROVENANCE_ACTIVE_KEY_ID: 'p3' });
      const evidenceBefore = (await conflicts(other.id)).length;
      await owner.publish(other); // its stored row is under p1, which this ring neither holds nor retired
      await until(() => logged('event_trust_held'), 20_000); // S1e-4: the enforced subscription holds it (basis provenance_unavailable)
      expect(t!.logs.some((l) => String(l.msg).startsWith('event_trust_held') && String(l.msg).includes('basis=provenance_unavailable'))).toBe(true);
      expect(logged('notification_duplicate')).toBe(false); // the intake never ran
      expect((await conflicts(other.id)).length).toBe(evidenceBefore);
      expect(await provenance(other.id)).toHaveLength(1);
      expect(await depth(`${INTAKE_QUEUE}.retry`)).toBe(0);
      expect(await depth(`${INTAKE_QUEUE}.dead`)).toBe(0);
      expect(t!.logs.map((l) => JSON.stringify(l)).join('\n')).not.toMatch(new RegExp(`${P3.toString('base64').slice(0, 16).replace(/[+/]/g, '.')}|${CODE}`));
      await startApp(); // the key is restored (p1): the held delivery is finally a duplicate, recorded nowhere twice
      await until(() => logged('notification_duplicate'), 20_000);
      expect(await provenance(other.id)).toHaveLength(1);
      expect((await conflicts(other.id)).length).toBe(evidenceBefore);
    });

    it('a stored key that was deliberately RETIRED makes its row unverifiable: never a duplicate, appended once as `unverifiable` evidence, never `differs` (S1c-1); S1e-4: a permanent refusal, never verified, never processed', async () => {
      await startApp({ NOTIFICATION_PROVENANCE_KEYS: ring([['p2', P2]]), NOTIFICATION_PROVENANCE_ACTIVE_KEY_ID: 'p2', NOTIFICATION_PROVENANCE_RETIRED_KEY_IDS: 'p1' });
      await owner.publish(other); // identical to its p1 row, which can no longer be verified
      await until(async () => (await conflicts(other.id)).some((c) => c.bodyMacKeyId === 'p2'));
      const evidence = (await conflicts(other.id)).filter((c) => c.bodyMacKeyId === 'p2');
      expect(evidence).toEqual([{ producerUserId: OWNER, verified: true, reason: 'verified', bodyMacKeyId: 'p2', bodyMac: bodyMac(P2, bytes(other)), comparison: 'unverifiable' }]);
      // S1e-4: a retired key cannot establish trust: refused (a distinct reason, not a hold, not a proven difference), the intake never running
      expect(await takeDead(other.id)).toMatchObject({ reason: 'untrusted_verified_unverifiable' });
      expect(t!.logs.some((l) => String(l.msg).startsWith('event_trust_refused') && String(l.msg).includes('basis=verified_unverifiable'))).toBe(true);
      expect(logged('event_provenance_conflict')).toBe(false); // a retired key is never reported as a proven difference
      await owner.publish(other); // again: the same evidence, compared under its own key (p2), is not appended twice
      expect(await takeDead(other.id)).toMatchObject({ reason: 'untrusted_verified_unverifiable' });
      expect(logged('notification_duplicate')).toBe(false);
      expect((await conflicts(other.id)).filter((c) => c.bodyMacKeyId === 'p2')).toHaveLength(1);
      expect(await provenance(other.id)).toHaveLength(1); // the p1 row is never changed
      expect(await intents(other.id)).toBe(1);
      await startApp(); // back to the default ring (p1) for the rest of the suite
    });
  });

  describe('retries, dead letters and the default exchange', () => {
    it('a transient intake failure after the provenance commit is retried by the kit (default exchange): the retry records nothing', async () => {
      await sql(db.url, `CREATE FUNCTION test_s1b3_intake_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = '57P03'; END $$;
        CREATE TRIGGER notification_00_test_fault BEFORE INSERT ON notification FOR EACH ROW EXECUTE FUNCTION test_s1b3_intake_fault()`);
      const e = envelope('membership.rejected');
      try {
        await owner.publish(e);
        await until(() => logged('event_retry_scheduled'));
        expect(await provenance(e.id)).toHaveLength(1);
      } finally {
        await sql(db.url, `DROP TRIGGER notification_00_test_fault ON notification; DROP FUNCTION test_s1b3_intake_fault()`);
      }
      await until(async () => (await intents(e.id)) === 1, 30_000);
      expect(await provenance(e.id)).toHaveLength(1);
      expect(await conflicts(e.id)).toEqual([]);
    }, 60_000);

    it('a permanently refused event is dead-lettered exactly as before, after its keyed provenance was recorded', async () => {
      const e = envelope('admin.owner_recovery_completed', { userId: 'u-1', channel: 'email', destination: EMAIL, timestamp: new Date().toISOString() }); // no ipAddress
      await owner.publish(e);
      await until(async () => (await depth(`${INTAKE_QUEUE}.dead`)) === 1);
      const m = await ch.get(`${INTAKE_QUEUE}.dead`, { noAck: true });
      expect(m && m.properties.headers?.['x-nawara-failure-reason']).toBe('malformed_payload');
      expect(await provenance(e.id)).toEqual([expect.objectContaining({ bodyMacKeyId: 'p1', bodyMac: bodyMac(TEST_PROVENANCE_KEY, bytes(e)) })]);
      expect(await intents(e.id)).toBe(0);
    });

    it('an injection through the default exchange is refused before the intake (S1e-4: `replay_no_provenance`) and no provenance is invented for it', async () => {
      const e = envelope('membership.approved');
      const c = await amqp.connect(urlFor(INTRUDER));
      const cc = await c.createConfirmChannel();
      cc.sendToQueue(INTAKE_QUEUE, bytes(e), { persistent: true, messageId: e.id, type: e.name, userId: INTRUDER, headers: e.headers });
      await cc.waitForConfirms();
      await c.close();
      expect(await takeDead(e.id)).toMatchObject({ reason: 'untrusted_replay_no_provenance' });
      expect(await intents(e.id)).toBe(0);
      expect(await provenance(e.id)).toEqual([]);
    });
  });

  describe('crash windows (the consumer dies before acknowledging; the broker redelivers to a new consumer)', () => {
    let crashOwner: RabbitMqEventBus;
    const keys = () => ({ activeKeyId: 'p1', keys: new Map([['p1', TEST_PROVENANCE_KEY]]), retiredKeyIds: new Set<string>() });
    /** A consumer wired exactly like `EventConsumer` (keyed provenance, the real intake), on its own exchange and queue. */
    const consumer = async (queue: string, before?: (e: EventEnvelope, intake: () => Promise<void>, bus: EventBus) => Promise<void>) => {
      const intake = t!.app.get(IntakeService);
      const bus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: CRASH_EXCHANGE, drainTimeoutMs: 200, retry: { maxRetries: 1, delayMs: 200 } });
      const outcomes: string[] = [];
      bus.setObserver((o) => void (o.type === 'provenance' && outcomes.push(o.outcome)));
      closers.push(() => bus.close());
      const run = (e: EventEnvelope) => async () => void (await intake.handle(e));
      await bus.subscribe({
        queue, bindings: EVENT_MAP.map((m) => m.name),
        handler: (e) => (before ? before(e, run(e), bus) : run(e)()),
        provenance: { ownerOf: intakeEventOwner, keyedStore: new PgKeyedProvenanceStore(t!.app.get(DbService), keys()) },
      });
      return { outcomes };
    };
    beforeAll(() => {
      crashOwner = new RabbitMqEventBus({ url: urlFor(OWNER), exchange: CRASH_EXCHANGE });
      closers.push(() => crashOwner.close());
    });
    afterAll(async () => {
      for (const q of [`${prefix}.crash-a`, `${prefix}.crash-b`]) for (const s of ['', '.retry', '.dead']) await ch.deleteQueue(`${q}${s}`).catch(() => undefined);
      await ch.deleteExchange(CRASH_EXCHANGE).catch(() => undefined);
    });
    const crashThenRecover = async (queue: string, intakeBeforeCrash: boolean) => {
      let first = true;
      await consumer(queue, async (_e, intake, bus) => {
        if (!first) return intake();
        first = false;
        if (intakeBeforeCrash) await intake();
        void bus.close(); // the process dies: the in-flight delivery is never acknowledged
        await sleep(600);
      });
      const e = envelope('member.contact_verification_requested');
      await crashOwner.publish(e);
      await until(() => !first);
      await sleep(900);
      const second = await consumer(queue);
      await until(async () => (await intents(e.id)) === 1 && second.outcomes.length >= 1);
      return { e, second };
    };

    it('after the provenance commit and before the intake: the redelivery is a provenance duplicate and one intent is written', async () => {
      const queue = `${prefix}.crash-a`;
      const { e, second } = await crashThenRecover(queue, false);
      expect(second.outcomes).toEqual(['duplicate']);
      expect(await provenance(e.id, queue)).toEqual([expect.objectContaining({ verified: true, bodyMacKeyId: 'p1' })]);
      expect(await intents(e.id)).toBe(1);
    });

    it('after the intake and before the acknowledgement: the redelivery is a provenance duplicate and an intake duplicate (one intent)', async () => {
      const queue = `${prefix}.crash-b`;
      const { e, second } = await crashThenRecover(queue, true);
      expect(second.outcomes).toEqual(['duplicate']);
      expect(await provenance(e.id, queue)).toEqual([expect.objectContaining({ verified: true })]);
      expect(await intents(e.id)).toBe(1);
    });
  });

  describe('replay classification (S1c-1, OBSERVE-ONLY): default-exchange deliveries against the stored originals', () => {
    const RX = `${prefix}.replay`;
    let rxOwner: RabbitMqEventBus;
    let rxIntruder: RabbitMqEventBus;
    const queues: string[] = [];
    const keyRing = (entries: Array<[string, Buffer]>, activeKeyId: string, retired: string[] = []): ProvenanceKeyRing => ({ activeKeyId, keys: new Map(entries), retiredKeyIds: new Set(retired) });
    const P1 = keyRing([['p1', TEST_PROVENANCE_KEY]], 'p1');
    /** A consumer wired exactly like `EventConsumer` (keyed provenance, the real intake) on its own exchange, observing replay outcomes. */
    const replayConsumer = async (queue: string, keys: ProvenanceKeyRing, before?: (e: EventEnvelope, intake: () => Promise<void>, bus: EventBus) => Promise<void>) => {
      if (!queues.includes(queue)) queues.push(queue);
      const intake = t!.app.get(IntakeService);
      const bus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: RX, drainTimeoutMs: 200, retry: { maxRetries: 2, delayMs: 150 }, replayLookupTimeoutMs: 1500 });
      const replays: string[] = [];
      const provenanceOutcomes: string[] = [];
      bus.setObserver((o) => {
        if (o.type === 'replay') replays.push(`${o.outcome}/${o.original}`);
        if (o.type === 'provenance') provenanceOutcomes.push(o.outcome);
      });
      closers.push(() => bus.close());
      const run = (e: EventEnvelope) => async () => void (await intake.handle(e));
      const sub = await bus.subscribe({
        queue, bindings: EVENT_MAP.map((m) => m.name),
        handler: (e) => (before ? before(e, run(e), bus) : run(e)()),
        provenance: { ownerOf: intakeEventOwner, keyedStore: new PgKeyedProvenanceStore(t!.app.get(DbService), keys) },
      });
      return { replays, provenanceOutcomes, close: () => sub.close(), bus };
    };
    /** A default-exchange injection straight into `queue`, published by the intruder (its own `user_id`). */
    const inject = async (queue: string, e: EventEnvelope, body = bytes(e)) => {
      const c = await amqp.connect(urlFor(INTRUDER));
      const cc = await c.createConfirmChannel();
      cc.sendToQueue(queue, body, { persistent: true, messageId: e.id, type: e.name, userId: INTRUDER, headers: e.headers });
      await cc.waitForConfirms();
      await c.close();
    };
    const duplicates = () => t!.logs.filter((l) => String(l.msg).startsWith('notification_duplicate')).length;
    beforeAll(async () => {
      rxOwner = new RabbitMqEventBus({ url: urlFor(OWNER), exchange: RX });
      rxIntruder = new RabbitMqEventBus({ url: urlFor(INTRUDER), exchange: RX });
      closers.push(() => rxOwner.close(), () => rxIntruder.close());
    });
    afterAll(async () => {
      for (const q of queues) for (const sfx of ['', '.retry', '.dead']) await ch.deleteQueue(`${q}${sfx}`).catch(() => undefined);
      await ch.deleteExchange(RX).catch(() => undefined);
    });

    it('a consumer RETRY (default exchange, the consumer\'s own user_id) matches the verified original; handled exactly as before', async () => {
      let calls = 0;
      const c = await replayConsumer(`${prefix}.rq-retry`, P1, async (_e, intake) => {
        if (++calls === 1) throw new Error('transient'); // the first attempt fails: the kit republishes a retry copy
        return intake();
      });
      const e = envelope('membership.approved');
      await rxOwner.publish(e);
      await until(async () => (await intents(e.id)) === 1);
      expect(c.provenanceOutcomes).toEqual(['recorded_verified', 'not_original']);
      expect(c.replays).toEqual(['replay_matched_verified/verified']);
      expect(await provenance(e.id, `${prefix}.rq-retry`)).toHaveLength(1); // the retry recorded nothing
      await c.close();
    });

    it('a BROKER REDELIVERY (requeued unacknowledged delivery) keeps its original exchange: an original, never classified as a replay', async () => {
      const queue = `${prefix}.rq-redeliver`;
      let first = true;
      await replayConsumer(queue, P1, async (_e, intake, bus) => {
        if (!first) return intake();
        first = false;
        void bus.close(); // dies before acknowledging: the broker redelivers to the next consumer
        await sleep(600);
      });
      const e = envelope('membership.revoked');
      await rxOwner.publish(e);
      await until(() => !first);
      await sleep(900);
      const second = await replayConsumer(queue, P1);
      await until(async () => (await intents(e.id)) === 1 && second.provenanceOutcomes.length >= 1);
      expect(second.provenanceOutcomes).toEqual(['duplicate']); // the original delivery again, through the event exchange
      expect(second.replays).toEqual([]);
      await second.close();
    });

    it('an OPERATOR REPLAY of a dead letter matches the verified original; handled as before', async () => {
      const queue = `${prefix}.rq-dlq`;
      let refuse = true;
      const c = await replayConsumer(queue, P1, async (_e, intake) => {
        if (refuse) throw new PermanentEventFailure('refused_for_test');
        return intake();
      });
      const e = envelope('admin.owner_recovery_completed');
      await rxOwner.publish(e);
      await until(async () => (await depth(`${queue}.dead`)) === 1);
      refuse = false;
      expect((await replayDeadLetter(conn, `${queue}.dead`, e.id, { waitMs: 10_000 })).outcome).toBe('consumed');
      await until(async () => (await intents(e.id)) === 1);
      expect(c.replays).toEqual(['replay_matched_verified/verified']);
      await c.close();
    });

    it('a FORGED INJECTION with a changed code is a mismatch against the verified original; one with no original is no_provenance; both handled as before', async () => {
      const queue = `${prefix}.rq-forged`;
      const c = await replayConsumer(queue, P1);
      const e = envelope('member.contact_verification_requested');
      await rxOwner.publish(e);
      await until(async () => (await intents(e.id)) === 1);
      const changed = envelope(e.name, { ...e.payload, code: '000003' }, e.id);
      const dupBefore = duplicates();
      await inject(queue, changed);
      await until(() => c.replays.length === 1);
      expect(c.replays).toEqual(['replay_mismatch/verified']);
      await until(() => duplicates() > dupBefore); // the intake de-duplicates exactly as before
      expect(await intents(e.id)).toBe(1);
      const unknown = envelope('membership.rejected');
      await inject(queue, unknown);
      await until(() => c.replays.length === 2);
      expect(c.replays[1]).toBe('replay_no_provenance/none');
      await until(async () => (await intents(unknown.id)) === 1); // observe-only: no new refusal
      expect(await provenance(unknown.id, queue)).toEqual([]); // nothing invented for it
      expect(t!.logs.map((l) => JSON.stringify(l)).join('\n')).not.toMatch(/000003|730591|member@example/);
      await c.close();
    });

    it('a replay of an UNVERIFIED original stays unverified', async () => {
      const queue = `${prefix}.rq-unverified`;
      const c = await replayConsumer(queue, P1);
      const e = envelope('membership.approved');
      await rxIntruder.publish(e); // the header claims auth-service; the broker says the intruder
      await until(async () => (await provenance(e.id, queue)).length === 1);
      await inject(queue, e);
      await until(() => c.replays.length === 1);
      expect(c.replays).toEqual(['replay_matched_unverified/unverified']);
      await c.close();
    });

    it('historical keys: after a ROTATION it matches under the stored key; RETIRED is unverifiable; UNAVAILABLE is a lookup failure; all handled as before', async () => {
      const queue = `${prefix}.rq-keys`;
      const a = await replayConsumer(queue, P1);
      const e = envelope('admin.operator_code_issued');
      await rxOwner.publish(e);
      await until(async () => (await intents(e.id)) === 1);
      await a.close();
      const cases: Array<[ProvenanceKeyRing, string]> = [
        [keyRing([['p1', TEST_PROVENANCE_KEY], ['p2', P2]], 'p2'), 'replay_matched_verified/verified'],
        [keyRing([['p2', P2]], 'p2', ['p1']), 'replay_unverifiable/verified'],
        [keyRing([['p3', P3]], 'p3'), 'replay_lookup_failure/none'],
      ];
      for (const [keys, expected] of cases) {
        const c = await replayConsumer(queue, keys);
        const dupBefore = duplicates();
        await inject(queue, e);
        await until(() => c.replays.length === 1);
        expect(c.replays, expected).toEqual([expected]);
        await until(() => duplicates() > dupBefore); // handled as before (the intake de-duplicates it), whatever the classification
        await c.close();
      }
      expect(await intents(e.id)).toBe(1);
      expect(await provenance(e.id, queue)).toHaveLength(1);
      expect(await sql(db.url, `SELECT 1 FROM event_provenance_conflict WHERE "eventId" = $1 AND consumer = $2`, [e.id, queue])).toEqual([]); // a lookup writes nothing
    });

    it('the database lost during the lookup: lookup failure, then the ordinary retry path as before; recovered, it matches', async () => {
      const queue = `${prefix}.rq-outage`;
      const c = await replayConsumer(queue, P1);
      const e = envelope('membership.revoked');
      await rxOwner.publish(e);
      await until(async () => (await intents(e.id)) === 1);
      const name = new URL(db.url).pathname.slice(1);
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS false`);
      await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
      try {
        await inject(queue, e);
        await until(() => c.replays.includes('replay_lookup_failure/none'));
      } finally {
        await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS true`);
      }
      await until(() => c.replays.includes('replay_matched_verified/verified'), 30_000); // a later retry of the same injection
      expect(c.replays.some((r) => r.startsWith('replay_matched') && c.replays.indexOf(r) < c.replays.indexOf('replay_lookup_failure/none'))).toBe(false);
      expect(await intents(e.id)).toBe(1);
      await c.close();
    }, 60_000);

    it('a CONCURRENT original and identical replay: one provenance row, one intent; the replay is never classified as a match without a stored original', async () => {
      const queue = `${prefix}.rq-concurrent`;
      const c = await replayConsumer(queue, P1);
      const e = envelope('membership.approved');
      await Promise.all([rxOwner.publish(e), inject(queue, e)]);
      await until(async () => (await intents(e.id)) === 1 && c.replays.length === 1);
      expect(['replay_no_provenance/none', 'replay_matched_verified/verified']).toContain(c.replays[0]);
      expect(await provenance(e.id, queue)).toHaveLength(1);
      await c.close();
    });
  });

  describe('the store and the schema (PostgreSQL, migration 0003)', () => {
    const observation = (eventId: string, body = Buffer.from(`{"code":"${CODE}"}`)): KeyedProvenanceObservation => ({
      source: OWNER, eventId, name: 'member.contact_verification_requested', routingKey: 'member.contact_verification_requested', exchange: EXCHANGE,
      producerUserId: OWNER, verified: true, reason: 'verified', body,
    });

    it('uniqueness holds under concurrency: 20 identical observations → one row; concurrent differing bodies are all kept as evidence', async () => {
      const store = new PgKeyedProvenanceStore(t!.app.get(DbService), { activeKeyId: 'p1', keys: new Map([['p1', TEST_PROVENANCE_KEY]]), retiredKeyIds: new Set() });
      const id = randomUUID();
      const same = await Promise.all(Array.from({ length: 20 }, () => store.record('q.concurrency', observation(id))));
      expect(same.filter((r) => r === 'recorded')).toHaveLength(1);
      expect(same.filter((r) => r === 'duplicate')).toHaveLength(19);
      const id2 = randomUUID();
      const bodies = Array.from({ length: 8 }, (_, i) => Buffer.from(`{"code":"00000${i}"}`));
      await Promise.all([store.record('q.concurrency', observation(id2)), ...bodies.map((b) => store.record('q.concurrency', observation(id2, b)))]);
      const evidence = new Set((await sql<{ m: string }>(db.url, `SELECT "bodyMac" AS m FROM event_provenance WHERE "eventId" = $1 UNION ALL SELECT "bodyMac" FROM event_provenance_conflict WHERE "eventId" = $1`, [id2])).map((r) => r.m));
      for (const b of [Buffer.from(`{"code":"${CODE}"}`), ...bodies]) expect(evidence.has(bodyMac(TEST_PROVENANCE_KEY, b))).toBe(true);
    });

    it('the database refuses a malformed commitment and a VERIFIED row that does not meet §13.2', async () => {
      const insert = (over: Record<string, unknown>) => {
        const v = { source: OWNER, eventId: randomUUID(), name: 'membership.approved', routingKey: 'membership.approved', version: 1, keyId: 'p1', mac: 'a'.repeat(64), producer: OWNER, verified: true, reason: 'verified', ...over };
        return failure(db.url, `INSERT INTO event_provenance (consumer, source, "eventId", name, "routingKey", exchange, "bodyCommitmentVersion", "bodyMacKeyId", "bodyMac", "producerUserId", verified, reason)
          VALUES ('q.shape', $1, $2, $3, $4, 'nawara.events', $5, $6, $7, $8, $9, $10)`, [v.source, v.eventId, v.name, v.routingKey, v.version, v.keyId, v.mac, v.producer, v.verified, v.reason]);
      };
      for (const bad of [{ version: 2 }, { keyId: 'not a key id!' }, { mac: 'z'.repeat(64) }, { mac: 'a'.repeat(63) }, { producer: null }, { producer: INTRUDER }, { routingKey: 'membership.rejected' }, { eventId: 'nope' }]) {
        expect((await insert(bad)).code, JSON.stringify(bad)).toBe('23514');
      }
    });

    it('S1c-1 (migration 0004): conflict evidence records `differs` or `unverifiable` only; earlier rows keep NULL (never rewritten)', async () => {
      const store = new PgKeyedProvenanceStore(t!.app.get(DbService), { activeKeyId: 'p1', keys: new Map([['p1', TEST_PROVENANCE_KEY]]), retiredKeyIds: new Set() });
      const id = randomUUID();
      await store.record('q.comparison', observation(id));
      await store.record('q.comparison', observation(id, Buffer.from('{"code":"000009"}')));
      const [evidence] = await sql<{ id: string; provenanceId: string; comparison: string }>(db.url, `SELECT id, "provenanceId", comparison FROM event_provenance_conflict WHERE "eventId" = $1`, [id]);
      expect(evidence!.comparison).toBe('differs');
      const insert = (comparison: string | null) => failure(db.url, `INSERT INTO event_provenance_conflict ("provenanceId", consumer, source, "eventId", name, "routingKey", exchange, "bodyCommitmentVersion", "bodyMacKeyId", "bodyMac", "producerUserId", verified, reason, comparison)
        SELECT "provenanceId", consumer, source, "eventId", name, "routingKey", exchange, 1, 'p1', $2, "producerUserId", verified, reason, $3 FROM event_provenance_conflict WHERE id = $1`, [evidence!.id, 'b'.repeat(64), comparison]);
      expect((await insert('proven_equal')).code).toBe('23514');
      expect((await insert('')).code).toBe('23514');
      expect((await failure(db.url, `UPDATE event_provenance_conflict SET comparison = 'unverifiable' WHERE id = $1`, [evidence!.id])).code).toBe('23514'); // append-only
    });

    it('both tables are append-only, even for the owner', async () => {
      for (const table of ['event_provenance', 'event_provenance_conflict']) {
        for (const statement of [`UPDATE ${table} SET verified = verified`, `DELETE FROM ${table}`, `TRUNCATE ${table} CASCADE`]) {
          expect((await failure(db.url, statement)).code, statement).toBe('23514');
        }
      }
    });

    it('no log line of the whole suite carries a code, a destination or key material', () => {
      const text = [...allLogs, ...(t?.logs ?? [])].map((l) => JSON.stringify(l)).join('\n');
      expect(text.length).toBeGreaterThan(0);
      for (const secret of [CODE, '000001', '000002', EMAIL, PHONE, TEST_PROVENANCE_KEY.toString('base64'), P2.toString('base64'), P3.toString('base64')]) {
        expect(text).not.toContain(secret);
      }
    });
  });
});
