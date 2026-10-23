import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import amqp, { type ChannelModel, type GetMessage } from 'amqplib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DbService, PgKeyedProvenanceStore, PgProvenanceStore, RabbitMqEventBus, auditCompatibilityEnforcement, strictEnforcement, type EnforcementPolicy, type EventEnvelope,
  type HandlerTrust, type KeyedProvenanceStore, type ProvenanceKeyRing, type ProvenanceStore,
} from '../src/index.js';
import { HEADER, deadQueueName } from '../src/events/dead-letter.js';
import { createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { ownedBrokerResources } from './support/broker-resources.js';
import { describeWithEnv } from './support/env.js';

/**
 * Core V2 S1e-1 (ADR-0057 §13.4, §13.5, S0-C4, S0-C6) over a REAL RabbitMQ and a REAL PostgreSQL: an ENFORCED subscription's handler runs
 * only after an acceptable, durable trust decision. The provenance tables are the consumers' own migrations (Billing's unkeyed 0017,
 * Notification's keyed 0003/0004), applied to disposable databases. Three disposable broker users (no tags; permissions limited to this
 * file's exchange and queues plus `amq.default`) are created through the management API and deleted at the end: the event owner, an
 * intruder, and the consumer. Synthetic events only.
 */
const owned = ownedBrokerResources();
const hex = (n: number) => randomBytes(n).toString('hex');
const prefix = `s1e${hex(4)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error('condition not met in time');
};
const repo = new URL('../../../', import.meta.url);
const migration = (rel: string) => readFileSync(new URL(rel, repo), 'utf8');

describeWithEnv('S1e-1 consumer trust enforcement (real RabbitMQ and PostgreSQL)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
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
  const closers: (() => Promise<unknown>)[] = [];
  let admin: ChannelModel;
  let plainDb: TestDatabase;
  let keyedDb: TestDatabase;
  let plain: DbService;
  let keyed: DbService;

  const envelope = (id = randomUUID(), payload: Record<string, unknown> = { paymentId: randomUUID(), amount: 1200, currency: 'TND' }): EventEnvelope =>
    ({ id, name: NAME, payload, headers: { eventId: id, occurredAt: '2026-10-23T08:00:00.000Z', correlationId: 'corr-s1e-0001', source: users.owner, version: 1 } });
  const publisher = (k: keyof typeof users) => {
    const b = new RabbitMqEventBus({ url: urlFor(k), exchange, connectTimeoutMs: 2000 });
    closers.push(() => b.close());
    return b;
  };
  /** One raw publish on a fresh confirm channel (to send what the kit's bus never sends: no user_id, the default exchange). */
  const raw = async (k: keyof typeof users, target: { exchange: string; key: string }, e: EventEnvelope, props: Record<string, unknown> = {}) => {
    const c = await amqp.connect(urlFor(k));
    const ch = await c.createConfirmChannel();
    ch.publish(target.exchange, target.key, Buffer.from(JSON.stringify(e.payload)), { persistent: true, messageId: e.id, type: e.name, headers: { ...e.headers }, ...props });
    await ch.waitForConfirms();
    await c.close();
  };
  const toQueue = (k: keyof typeof users, queue: string, e: EventEnvelope, props: Record<string, unknown> = {}) => raw(k, { exchange: '', key: queue }, e, props);

  /** An enforced consumer authenticated as the consumer user; every handler call is recorded with the trust it was given. */
  const consume = async (opts: { policy?: EnforcementPolicy; store: ProvenanceStore | KeyedProvenanceStore; keyedStore?: boolean; queue?: string; deadLetterPolicy?: boolean; unenforced?: boolean }) => {
    const queue = opts.queue ?? owned.queue(`${prefix}.q${hex(3)}`);
    const handled: { event: EventEnvelope; trust: HandlerTrust | undefined }[] = [];
    const notices: string[] = [];
    const bus = new RabbitMqEventBus({ url: urlFor('consumer'), exchange, retry: { maxRetries: 1, delayMs: 100 }, prefetch: 5, onNotice: (m) => notices.push(m) });
    closers.push(() => bus.close());
    const sub = await bus.subscribe({
      queue, bindings: [NAME],
      handler: async (event, trust) => void handled.push({ event, trust }),
      provenance: opts.keyedStore ? { ownerOf, keyedStore: opts.store as KeyedProvenanceStore } : { ownerOf, store: opts.store as ProvenanceStore },
      ...(opts.unenforced ? {} : { enforcement: opts.policy ?? strictEnforcement({ refusedBody: opts.deadLetterPolicy ? 'dead_letter_policy' : 'original_reviewed' }) }),
      ...(opts.deadLetterPolicy ? { deadLetterPolicy: () => ({ body: 'redacted' as const, headers: {} }) } : {}),
    });
    closers.push(() => sub.close());
    return { queue, handled, notices, close: () => sub.close() };
  };
  const dead = async (queue: string) => {
    const ch = await admin.createChannel();
    const out: GetMessage[] = [];
    for (;;) {
      const m = await ch.get(deadQueueName(queue), { noAck: true });
      if (!m) break;
      out.push(m);
    }
    await ch.close();
    return out;
  };
  /** One consumer's observations of one event (every consumer in this file binds the same name on the same exchange). */
  const rows = async (db: DbService, eventId: string, consumer: string) =>
    (await db.query(`SELECT verified, reason FROM event_provenance WHERE "eventId" = $1 AND consumer = $2 ORDER BY verified`, [eventId, consumer])).rows;

  beforeAll(async () => {
    // this file's resources, plus the Audit compatibility queue name (the phase is Audit's alone) and `amq.default`
    const mine = `${prefix}\\..*|audit-service\\.audit(\\..*)?`;
    for (const k of ['owner', 'intruder', 'consumer'] as const) {
      await api('PUT', `/users/${encodeURIComponent(users[k])}`, { password: passwords[k], tags: '' });
      await api('PUT', `/permissions/%2F/${encodeURIComponent(users[k])}`, { configure: `^(${mine})$`, write: `^(${mine}|amq\\.default)$`, read: `^(${mine})$` });
    }
    admin = await amqp.connect(env.TEST_RABBITMQ_URL);
    const ch = await admin.createChannel();
    await ch.assertExchange(exchange, 'topic', { durable: true });
    await ch.close();
    plainDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 's1e1_plain');
    keyedDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 's1e1_keyed');
    plain = new DbService({ url: plainDb.url, max: 5 });
    keyed = new DbService({ url: keyedDb.url, max: 5 });
    await plain.query(`CREATE FUNCTION billing_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only: % is refused', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514'; END $$;`);
    await plain.query(migration('apps/billing-service/db/migrations/0017_event_provenance.sql'));
    await keyed.query(migration('apps/notification-service/db/migrations/0003_event_provenance.sql'));
    await keyed.query(migration('apps/notification-service/db/migrations/0004_provenance_conflict_comparison.sql'));
  });
  afterAll(async () => {
    for (const c of closers.reverse()) await c().catch(() => undefined);
    await admin?.close().catch(() => undefined);
    await plain?.onApplicationShutdown();
    await keyed?.onApplicationShutdown();
    await plainDb?.drop();
    await keyedDb?.drop();
    for (const u of Object.values(users)) await api('DELETE', `/users/${encodeURIComponent(u)}`);
  });

  it('a verified original reaches the handler with its trusted origin; its redelivery (a duplicate) does too; one verified row', async () => {
    const c = await consume({ store: new PgProvenanceStore(plain) });
    const e = envelope();
    await publisher('owner').publish(e);
    await publisher('owner').publish(e);
    await waitFor(() => c.handled.length === 2);
    expect(c.handled.map((h) => h.trust?.basis).sort((x, y) => String(x).localeCompare(String(y)))).toStrictEqual(['verified_duplicate', 'verified_original']);
    expect(c.handled[0]!.trust).toMatchObject({ decision: 'accept', origin: { from: 'verified_delivery', producerUserId: users.owner, eventId: e.id, occurredAt: { available: true, value: e.headers.occurredAt } } });
    expect(await rows(plain, e.id, c.queue)).toStrictEqual([{ verified: true, reason: 'verified' }]);
  });

  it('strict: an unverified original (no user_id; another identity claiming the owner\'s source) is refused BEFORE the handler and dead-lettered', async () => {
    const c = await consume({ store: new PgProvenanceStore(plain) });
    const missing = envelope();
    await raw('owner', { exchange, key: NAME }, missing); // no user_id at all
    const forged = envelope();
    await publisher('intruder').publish(forged); // its own user_id, the owner's `source` header
    await waitFor(() => c.notices.filter((n) => n.startsWith('event_dead_lettered')).length === 2);
    const deadLetters = await dead(c.queue);
    expect(c.handled).toStrictEqual([]);
    const reasons = deadLetters.map((m) => [m.properties.messageId, m.properties.headers?.[HEADER.failureReason]]);
    expect(reasons).toEqual(expect.arrayContaining([[missing.id, 'untrusted_unverified_original'], [forged.id, 'untrusted_unverified_original']]));
    // the unverified observations stay as append-only evidence: nothing was claimed, nothing promoted
    expect(await rows(plain, missing.id, c.queue)).toStrictEqual([{ verified: false, reason: 'missing_user_id' }]);
    expect(await rows(plain, forged.id, c.queue)).toStrictEqual([{ verified: false, reason: 'source_mismatch' }]);
  });

  it('S0-C4: a verified original AFTER an earlier unverified observation is accepted; the unverified row stays unverified beside it', async () => {
    const c = await consume({ store: new PgProvenanceStore(plain) });
    const e = envelope();
    await raw('owner', { exchange, key: NAME }, e); // unverified first (refused)
    await sleep(300);
    await publisher('owner').publish(e); // the authenticated publication (a re-emission)
    await waitFor(() => c.handled.length === 1);
    expect(c.handled[0]!.trust).toMatchObject({ decision: 'accept', basis: 'verified_original' });
    expect(await rows(plain, e.id, c.queue)).toStrictEqual([{ verified: false, reason: 'missing_user_id' }, { verified: true, reason: 'verified' }]);
  });

  it('a verified delivery contradicting the stored verified observation is refused (never reconciled); the evidence is kept', async () => {
    const c = await consume({ store: new PgProvenanceStore(plain) });
    const e = envelope();
    await publisher('owner').publish(e);
    await waitFor(() => c.handled.length === 1);
    await publisher('owner').publish({ ...e, payload: { ...e.payload, amount: 999_999 } });
    await waitFor(() => c.notices.some((n) => n.startsWith('event_dead_lettered')));
    expect((await plain.query(`SELECT count(*)::int n FROM event_provenance_conflict WHERE "eventId" = $1 AND consumer = $2`, [e.id, c.queue])).rows[0].n).toBe(1);
    expect(c.handled).toHaveLength(1);
    expect((await dead(c.queue)).map((m) => m.properties.headers?.[HEADER.failureReason])).toStrictEqual(['untrusted_verified_conflict']);
  });

  it('default exchange: a byte-identical replay is accepted with the STORED origin; tampered headers never become trusted; injections are refused', async () => {
    const c = await consume({ store: new PgProvenanceStore(plain) });
    const e = envelope();
    await publisher('owner').publish(e);
    await waitFor(() => c.handled.length === 1);
    // a replay of the same bytes whose occurredAt header was changed: accepted, but its origin carries NO occurredAt (not stored)
    await toQueue('consumer', c.queue, { ...e, headers: { ...e.headers, occurredAt: '2030-01-01T00:00:00.000Z' } });
    await waitFor(() => c.handled.length === 2);
    const replay = c.handled[1]!;
    expect(replay.trust).toMatchObject({ decision: 'accept', basis: 'verified_replay', origin: { from: 'stored_verified_observation', producerUserId: users.owner, occurredAt: { available: false, reason: 'not_stored' } } });
    expect(replay.event.headers.occurredAt).toBe('2030-01-01T00:00:00.000Z'); // the delivery's claim, never in `trust`
    // injections: a never-seen id; a known id with other bytes
    const injected = envelope();
    await toQueue('consumer', c.queue, injected);
    await toQueue('consumer', c.queue, { ...e, payload: { ...e.payload, amount: 1 } });
    await waitFor(() => c.notices.filter((n) => n.startsWith('event_trust_refused')).length === 2);
    expect(c.handled).toHaveLength(2);
    expect(c.notices.filter((n) => n.startsWith('event_trust_refused')).map((n) => n.match(/basis=(\w+)/)![1]).sort()).toStrictEqual(['replay_mismatch', 'replay_no_provenance']);
  });

  it('concurrent deliveries of one verified event: one verified row, both handled (business idempotency stays the handler\'s)', async () => {
    const c = await consume({ store: new PgProvenanceStore(plain) });
    const e = envelope();
    const p = publisher('owner');
    await Promise.all([p.publish(e), p.publish(e), p.publish(e)]);
    await waitFor(() => c.handled.length === 3);
    expect(c.handled.filter((h) => h.trust?.basis === 'verified_original')).toHaveLength(1);
    expect(await rows(plain, e.id, c.queue)).toStrictEqual([{ verified: true, reason: 'verified' }]);
  });

  it('a store failure (original) or a lookup failure (replay) is a HOLD: the handler never runs until a decision exists', async () => {
    const real = new PgProvenanceStore(plain);
    let failAssess = 2;
    let failClassify = 2;
    const flaky: ProvenanceStore = {
      record: (q, o) => real.record(q, o),
      assess: async (q, o) => {
        if (failAssess-- > 0) throw new Error('database unavailable');
        return real.assess(q, o);
      },
      classifyReplay: async (q, r) => {
        if (failClassify-- > 0) throw new Error('database unavailable');
        return real.classifyReplay(q, r);
      },
    };
    const c = await consume({ store: flaky });
    const e = envelope();
    await publisher('owner').publish(e);
    await waitFor(() => c.handled.length === 1, 15_000);
    expect(c.notices.filter((n) => n.startsWith('event_trust_held'))).toHaveLength(2);
    expect(c.handled[0]!.trust?.basis).toBe('verified_original');
    await toQueue('consumer', c.queue, e);
    await waitFor(() => c.handled.length === 2, 15_000);
    expect(c.notices.filter((n) => n.startsWith('event_trust_held'))).toHaveLength(4);
    expect(c.handled[1]!.trust?.basis).toBe('verified_replay');
    expect(await dead(c.queue)).toStrictEqual([]); // a hold is never a refusal
  });

  it('a subscription WITHOUT a policy is unchanged: observe-only, the unverified delivery still reaches the handler', async () => {
    const c = await consume({ store: new PgProvenanceStore(plain), unenforced: true });
    const e = envelope();
    await raw('owner', { exchange, key: NAME }, e);
    await waitFor(() => c.handled.length === 1);
    expect(c.handled[0]!.trust).toBeUndefined();
  });

  it('Audit compatibility (its queue only): an unverified delivery is processed marked UNVERIFIED, nothing promoted; a contradiction is still refused', async () => {
    const c = await consume({ store: new PgProvenanceStore(plain), policy: auditCompatibilityEnforcement(), queue: owned.queue('audit-service.audit') });
    const e = envelope();
    await raw('owner', { exchange, key: NAME }, e);
    await waitFor(() => c.handled.length === 1);
    expect(c.handled[0]!.trust).toStrictEqual({ decision: 'compatibility', basis: 'unverified_original', verified: false });
    expect(await rows(plain, e.id, c.queue)).toStrictEqual([{ verified: false, reason: 'missing_user_id' }]);
    await toQueue('consumer', c.queue, { ...e, payload: { other: true } }); // differs from the stored (unverified) original: a mismatch
    await waitFor(() => c.notices.some((n) => n.includes('basis=replay_mismatch')));
    expect(c.handled).toHaveLength(1);
  });

  it('keyed (Notification-like): matched under the original key; a RETIRED key refuses (unverifiable, redacted dead letter); a MISSING key holds', async () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const queue = owned.queue(`${prefix}.keyed${hex(3)}`);
    const first: ProvenanceKeyRing = { activeKeyId: 'k1', keys: new Map([['k1', k1]]), retiredKeyIds: new Set() };
    const a = await consume({ store: new PgKeyedProvenanceStore(keyed, first), keyedStore: true, queue, deadLetterPolicy: true });
    const e = envelope(randomUUID(), { code: '123456', synthetic: true });
    await publisher('owner').publish(e);
    await waitFor(() => a.handled.length === 1);
    await toQueue('consumer', queue, e);
    await waitFor(() => a.handled.length === 2);
    expect(a.handled[1]!.trust?.basis).toBe('verified_replay');
    await a.close();
    // k1 legitimately retired: the stored commitment can never be compared again → permanent, privacy-safe refusal
    const retired = await consume({ store: new PgKeyedProvenanceStore(keyed, { activeKeyId: 'k2', keys: new Map([['k2', k2]]), retiredKeyIds: new Set(['k1']) }), keyedStore: true, queue, deadLetterPolicy: true });
    await toQueue('consumer', queue, e);
    await waitFor(() => retired.notices.some((n) => n.startsWith('event_dead_lettered')));
    const refused = await dead(queue);
    expect(refused.map((m) => m.properties.headers?.[HEADER.failureReason])).toStrictEqual(['untrusted_replay_unverifiable']);
    expect(refused[0]!.content.toString()).not.toContain('123456'); // the dead letter is redacted
    expect(retired.handled).toStrictEqual([]);
    await retired.close();
    // k1 merely unavailable (not retired): never a decision → held, never processed, never dead-lettered
    const missing = await consume({ store: new PgKeyedProvenanceStore(keyed, { activeKeyId: 'k2', keys: new Map([['k2', k2]]), retiredKeyIds: new Set() }), keyedStore: true, queue, deadLetterPolicy: true });
    await toQueue('consumer', queue, e);
    await waitFor(() => missing.notices.some((n) => n.startsWith('event_trust_held')));
    expect(missing.handled).toStrictEqual([]);
    expect(await dead(queue)).toStrictEqual([]);
    await missing.close();
  });
});
