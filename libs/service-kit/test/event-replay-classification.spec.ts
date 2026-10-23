import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PgKeyedProvenanceStore, PgProvenanceStore, ProvenanceCommitmentVersionError, ProvenanceKeyUnavailableError, RabbitMqEventBus, bodyMac,
  type EventBusObservation, type EventSubscription, type ProvenanceKeyRing, type ReplayClassification,
} from '../src/index.js';
import { BoundedMetrics } from '../src/metrics/metrics.js';
import { messagingMetrics } from '../src/metrics/messaging-metrics.js';
import type { Queryable } from '../src/db/db.service.js';

/**
 * Core V2 S1c-1 (ADR-0057 §13.4 with S0-C3; OBSERVE-ONLY): a default-exchange delivery is classified against the consumer's stored ORIGINAL
 * observations, looked up by its `source` header and message id (lookup keys only) and compared on name and body; conflict evidence is never
 * consulted, nothing is written, and the delivery is handled exactly as before whatever the outcome. Keys are synthetic, random per run.
 */
const ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const NAME = 'member.contact_verification_requested';
const BODY = Buffer.from('{"userId":"u-1","channel":"email","destination":"member@example.test","code":"730591"}');
const CHANGED = Buffer.from(BODY.toString().replace('730591', '000001'));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const K1 = randomBytes(32);
const K2 = randomBytes(32);
const candidate = { source: 'auth-service', eventId: ID, name: NAME };

/** A scripted read: answers the originals query; any other statement (a write, a conflict-evidence read) fails the test. */
function readOnlyDb(rows: Array<Record<string, unknown>>) {
  const statements: string[] = [];
  const q: Queryable = {
    query: (async (sql: string) => {
      statements.push(sql);
      if (/^\s*SELECT .* FROM event_provenance\s+WHERE/s.test(sql) && !sql.includes('event_provenance_conflict')) return { rows };
      throw new Error(`unexpected statement in a read-only replay lookup: ${sql.slice(0, 60)}`);
    }) as Queryable['query'],
  };
  return { db: { tx: <T>(fn: (q: Queryable) => Promise<T>) => fn(q) }, statements };
}
const plain = (verified: boolean, body = BODY, over: Record<string, unknown> = {}) => ({ id: verified ? 'v' : 'u', name: NAME, routingKey: NAME, bodySha256: sha(body), producerUserId: verified ? 'auth-service' : 'intruder', verified, ...over });
const keyed = (verified: boolean, keyId: string, key: Buffer | undefined, body = BODY, over: Record<string, unknown> = {}) => ({
  id: verified ? 'v' : 'u', name: NAME, routingKey: NAME, bodyCommitmentVersion: 1, bodyMacKeyId: keyId, bodyMac: key ? bodyMac(key, body) : 'a'.repeat(64),
  producerUserId: verified ? 'auth-service' : 'intruder', verified, ...over,
});
const ring = (over: Partial<ProvenanceKeyRing> = {}): ProvenanceKeyRing => ({ activeKeyId: 'p1', keys: new Map([['p1', K1]]), retiredKeyIds: new Set(), ...over });

describe('PgProvenanceStore.classifyReplay (unkeyed: Billing, Audit)', () => {
  const classify = async (rows: Array<Record<string, unknown>>, body = BODY, name = NAME) => {
    const { db, statements } = readOnlyDb(rows);
    const r = await new PgProvenanceStore(db).classifyReplay('q', { ...candidate, name, bodySha256: sha(body) });
    expect(statements).toHaveLength(1); // one read of the originals, no write, never the conflict evidence
    return r;
  };
  it('matches the verified original; an unverified one stays unverified; none, a changed name or body are told apart', async () => {
    expect(await classify([plain(true)])).toEqual({ outcome: 'replay_matched_verified', original: 'verified' });
    expect(await classify([plain(false)])).toEqual({ outcome: 'replay_matched_unverified', original: 'unverified' });
    expect(await classify([])).toEqual({ outcome: 'replay_no_provenance', original: 'none' });
    expect(await classify([plain(true)], CHANGED)).toEqual({ outcome: 'replay_mismatch', original: 'verified' });
    expect(await classify([plain(false)], CHANGED)).toEqual({ outcome: 'replay_mismatch', original: 'unverified' });
    expect(await classify([plain(true)], BODY, 'member.other_event')).toEqual({ outcome: 'replay_mismatch', original: 'verified' });
  });
  it('a verified original stays valid beside a different (forged) unverified one; matching only the forged content is never verified', async () => {
    const rows = [plain(false, CHANGED), plain(true)];
    expect(await classify(rows)).toEqual({ outcome: 'replay_matched_verified', original: 'verified' });
    expect(await classify(rows, CHANGED)).toEqual({ outcome: 'replay_matched_unverified', original: 'unverified' });
  });
});

describe('PgKeyedProvenanceStore.classifyReplay (Notification, under each stored row\'s own key)', () => {
  const classify = (rows: Array<Record<string, unknown>>, r: ProvenanceKeyRing, body = BODY) => {
    const { db } = readOnlyDb(rows);
    return new PgKeyedProvenanceStore(db, r).classifyReplay('q', { ...candidate, body });
  };
  it('matches under the original key, also after a rotation; a changed code is a mismatch; an unverified original stays unverified', async () => {
    expect(await classify([keyed(true, 'p1', K1)], ring())).toEqual({ outcome: 'replay_matched_verified', original: 'verified' });
    const rotated = ring({ activeKeyId: 'p2', keys: new Map([['p1', K1], ['p2', K2]]) });
    expect(await classify([keyed(true, 'p1', K1)], rotated)).toEqual({ outcome: 'replay_matched_verified', original: 'verified' });
    expect(await classify([keyed(true, 'p1', K1)], rotated, CHANGED)).toEqual({ outcome: 'replay_mismatch', original: 'verified' });
    expect(await classify([keyed(false, 'p1', K1)], ring())).toEqual({ outcome: 'replay_matched_unverified', original: 'unverified' });
  });
  it('a RETIRED key is unverifiable (never a match, never a mismatch); an UNAVAILABLE key or an unknown version rejects (lookup failure)', async () => {
    const retired = ring({ activeKeyId: 'p2', keys: new Map([['p2', K2]]), retiredKeyIds: new Set(['p1']) });
    expect(await classify([keyed(true, 'p1', undefined)], retired)).toEqual({ outcome: 'replay_unverifiable', original: 'verified' });
    expect(await classify([keyed(true, 'p1', undefined, BODY, { name: 'other.event' })], retired)).toEqual({ outcome: 'replay_mismatch', original: 'verified' }); // a different name is definitive
    const unavailable = ring({ activeKeyId: 'p3', keys: new Map([['p3', K2]]) });
    await expect(classify([keyed(true, 'p1', undefined)], unavailable)).rejects.toBeInstanceOf(ProvenanceKeyUnavailableError);
    await expect(classify([keyed(true, 'p1', K1, BODY, { bodyCommitmentVersion: 2 })], ring())).rejects.toBeInstanceOf(ProvenanceCommitmentVersionError);
  });
});

/** The bus's real `deliver` against a recording channel and a scripted store (keyed or not). */
function harness(classifyReplay: ((c: unknown) => Promise<ReplayClassification>) | undefined, opts: { keyed?: boolean; handlerFails?: boolean; timeoutMs?: number } = {}) {
  const steps: string[] = [];
  const notices: string[] = [];
  const observations: EventBusObservation[] = [];
  const seen: unknown[] = [];
  const bus = new RabbitMqEventBus({ url: 'amqp://127.0.0.1:1', exchange: 'nawara.events', retry: { maxRetries: 2, delayMs: 20 }, replayLookupTimeoutMs: opts.timeoutMs ?? 2000, onNotice: (m) => notices.push(m) });
  bus.setObserver((o) => observations.push(o));
  const internal = bus as unknown as { republish: (q: string) => Promise<void>; ensureDeadQueue: () => Promise<void>; deliver: (ch: unknown, msg: unknown, sub: EventSubscription) => Promise<void> };
  internal.ensureDeadQueue = async () => undefined;
  internal.republish = async (q: string) => void steps.push(`republish:${q.endsWith('.retry') ? 'retry' : 'dead'}`);
  const ch = { ack: () => steps.push('ack'), nack: (_m: unknown, _a: boolean, requeue: boolean) => steps.push(`nack:requeue=${requeue}`) };
  const store = {
    record: async () => {
      steps.push('record');
      return 'recorded' as const;
    },
    ...(classifyReplay ? {
      classifyReplay: async (_consumer: string, c: unknown) => {
        steps.push('classify');
        seen.push(c);
        return classifyReplay(c);
      },
    } : {}),
  };
  const sub: EventSubscription = {
    queue: 'notification.events', bindings: [NAME],
    handler: async () => {
      steps.push('handler');
      if (opts.handlerFails) throw new Error('transient');
    },
    provenance: opts.keyed ? { ownerOf: () => 'auth-service', keyedStore: store } : { ownerOf: () => 'auth-service', store },
  };
  const deliver = (exchange = '', userId = 'notification-service') => internal.deliver(ch, {
    content: BODY,
    fields: { exchange, routingKey: exchange === '' ? 'notification.events' : NAME, redelivered: false },
    properties: { messageId: ID, type: NAME, userId, headers: { eventId: ID, source: 'auth-service', occurredAt: '2026-10-23T00:00:00.000Z', version: 1, 'x-nawara-retry-count': 1 } },
  }, sub);
  const replays = () => observations.flatMap((o) => (o.type === 'replay' ? [`${o.outcome}/${o.original}`] : []));
  return { steps, notices, observations, seen, deliver, replays };
}

describe('RabbitMqEventBus replay classification (OBSERVE-ONLY)', () => {
  const outcomes: ReplayClassification[] = [
    { outcome: 'replay_matched_verified', original: 'verified' }, { outcome: 'replay_matched_unverified', original: 'unverified' },
    { outcome: 'replay_no_provenance', original: 'none' }, { outcome: 'replay_mismatch', original: 'verified' },
    { outcome: 'replay_mismatch', original: 'unverified' }, { outcome: 'replay_unverifiable', original: 'verified' },
  ];

  it('every outcome is observed and the delivery is handled EXACTLY as before (handler, then ack): no refusal, no record, no hold', async () => {
    for (const r of outcomes) {
      const h = harness(async () => r);
      await h.deliver();
      expect(h.steps, r.outcome).toEqual(['classify', 'handler', 'ack']);
      expect(h.replays()).toEqual([`${r.outcome}/${r.original}`]);
      if (r.outcome === 'replay_matched_verified') expect(h.notices).toEqual([]);
      else expect(h.notices).toEqual([`event_replay_classified queue=notification.events event=${ID} outcome=${r.outcome} original=${r.original} — observe-only (S1c); the delivery is handled as before`]);
    }
  });

  it('the lookup uses the source header and message id only as lookup keys; a keyed store gets the raw bytes, an unkeyed one the digest', async () => {
    const keyedH = harness(async () => outcomes[0]!, { keyed: true });
    await keyedH.deliver();
    expect(keyedH.seen[0]).toEqual({ source: 'auth-service', eventId: ID, name: NAME, body: BODY });
    const plainH = harness(async () => outcomes[0]!);
    await plainH.deliver();
    expect(plainH.seen[0]).toEqual({ source: 'auth-service', eventId: ID, name: NAME, bodySha256: sha(BODY) });
  });

  it('a lookup that fails (database, unavailable key, unknown version) or times out is `replay_lookup_failure`, never a verification; handled as before', async () => {
    for (const error of [new Error('connect ECONNREFUSED postgres://u:pw@db/x'), new ProvenanceKeyUnavailableError(), new ProvenanceCommitmentVersionError()]) {
      const h = harness(async () => {
        throw error;
      }, { keyed: true });
      await h.deliver();
      expect(h.steps).toEqual(['classify', 'handler', 'ack']);
      expect(h.replays()).toEqual(['replay_lookup_failure/none']);
      expect(h.notices[0]).toMatch(new RegExp(`outcome=replay_lookup_failure original=none error=${error.name} `));
      expect(h.notices.join('\n')).not.toMatch(/postgres:|pw@|730591|member@example/);
    }
    const slow = harness(() => new Promise(() => undefined), { timeoutMs: 30 });
    const started = Date.now();
    await slow.deliver();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.steps).toEqual(['classify', 'handler', 'ack']);
    expect(slow.replays()).toEqual(['replay_lookup_failure/none']);
  });

  it('a retry whose handler fails again follows the ordinary retry path; the classification changes nothing', async () => {
    const h = harness(async () => ({ outcome: 'replay_mismatch', original: 'verified' }), { handlerFails: true });
    await h.deliver();
    expect(h.steps).toEqual(['classify', 'handler', 'republish:retry', 'ack']);
  });

  it('an original delivery is unchanged (recorded before the handler, not classified); another exchange and a store without classification are not classified', async () => {
    const original = harness(async () => outcomes[0]!);
    await original.deliver('nawara.events', 'auth-service');
    expect(original.steps).toEqual(['record', 'handler', 'ack']);
    expect(original.replays()).toEqual([]);
    const other = harness(async () => outcomes[0]!);
    await other.deliver('another.exchange');
    expect(other.steps).toEqual(['handler', 'ack']);
    const none = harness(undefined);
    await none.deliver();
    expect(none.steps).toEqual(['handler', 'ack']);
    expect(none.replays()).toEqual([]);
  });
});

describe('the replay metric (bounded)', () => {
  it('counts by queue, closed outcome and kind of original; hostile values fold', async () => {
    const m = new BoundedMetrics();
    const observe = messagingMetrics(m);
    observe({ type: 'replay', queue: 'notification.events', outcome: 'replay_mismatch', original: 'verified' });
    observe({ type: 'replay', queue: 'notification.events', outcome: 'replay_mismatch', original: 'unverified' });
    observe({ type: 'replay', queue: 'notification.events', outcome: `evil-${ID}` as never, original: '730591' as never });
    const text = (await m.render()).body;
    expect(text).toContain('nawara_event_replay_total{queue="notification.events",outcome="replay_mismatch",kind="verified"} 1');
    expect(text).toContain('nawara_event_replay_total{queue="notification.events",outcome="replay_mismatch",kind="unverified"} 1');
    expect(text).not.toMatch(new RegExp(`${ID}|730591`));
  });
});
