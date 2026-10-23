import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BODY_COMMITMENT_VERSION, PgKeyedProvenanceStore, ProvenanceCommitmentVersionError, ProvenanceKeyUnavailableError, RabbitMqEventBus, assertProvenanceKeyRing, bodyMac,
  type EventBusObservation, type EventSubscription, type KeyedProvenanceObservation, type ProvenanceKeyRing, type ProvenanceRecordResult,
} from '../src/index.js';
import type { Queryable } from '../src/db/db.service.js';

/**
 * Core V2 S1b-3 (ADR-0057 §13.2 "S0-C2"): the keyed body commitment. The MAC covers every byte of the raw body under the ring's key; the
 * keyed path never computes an unkeyed digest; a keyed store compares under the STORED row's key (a rotation never creates a false
 * conflict), treats a retired key as unverifiable and fails closed on an unavailable key or an unknown construction. All keys are
 * synthetic and random per run.
 */
const K1 = randomBytes(32);
const K2 = randomBytes(32);
const ring = (over: Partial<ProvenanceKeyRing> = {}): ProvenanceKeyRing => ({ activeKeyId: 'p1', keys: new Map([['p1', K1]]), retiredKeyIds: new Set(), ...over });
const BODY = Buffer.from('{"userId":"u-1","channel":"email","destination":"member@example.test","code":"730591","expiresAt":"2026-10-23T12:00:00.000Z"}');

describe('bodyMac (HMAC-SHA-256 of the raw body bytes)', () => {
  it('is the standard HMAC-SHA-256 under the key, over every byte, and never the unkeyed digest', () => {
    expect(bodyMac(K1, BODY)).toBe(createHmac('sha256', K1).update(BODY).digest('hex'));
    expect(bodyMac(K1, BODY)).not.toBe(createHash('sha256').update(BODY).digest('hex'));
    expect(bodyMac(K2, BODY)).not.toBe(bodyMac(K1, BODY)); // another key, another commitment
    for (let i = 0; i < BODY.length; i++) {
      const changed = Buffer.from(BODY);
      changed[i] ^= 0x01;
      expect(bodyMac(K1, changed), `byte ${i}`).not.toBe(bodyMac(K1, BODY));
    }
    expect(bodyMac(K1, Buffer.from(BODY.toString().replace('730591', '730592')))).not.toBe(bodyMac(K1, BODY)); // a changed code
    expect(BODY_COMMITMENT_VERSION).toBe(1);
  });
});

describe('assertProvenanceKeyRing', () => {
  it('refuses a missing active key, a short key, a bad id and a retired id still in the ring, never echoing key material', () => {
    const bad: ProvenanceKeyRing[] = [
      ring({ activeKeyId: 'p9' }),
      ring({ keys: new Map([['p1', K1.subarray(0, 16)]]) }),
      ring({ keys: new Map([['p1', K1], ['bad id!', K2]]) }),
      ring({ retiredKeyIds: new Set(['p1']) }),
      ring({ retiredKeyIds: new Set(['bad id!']) }),
    ];
    for (const r of bad) {
      let message = '';
      try {
        assertProvenanceKeyRing(r);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe('');
      for (const k of [K1, K2]) expect(message).not.toContain(k.toString('base64'));
      expect(() => new PgKeyedProvenanceStore({ tx: async () => undefined as never }, r)).toThrow();
    }
    expect(() => assertProvenanceKeyRing(ring({ keys: new Map([['p1', K1], ['p0', K2]]), retiredKeyIds: new Set(['p-old']) }))).not.toThrow();
  });
});

/** A scripted `tx`: answers the store's statements from the rows given, and records what it inserted. */
function fakeDb(stored: Array<Record<string, unknown>>, evidence: Array<Record<string, unknown>> = [], ownInserted = false) {
  const inserts: Array<{ table: string; params: unknown[] }> = [];
  const q: Queryable = {
    query: (async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('INSERT INTO event_provenance (')) {
        inserts.push({ table: 'event_provenance', params });
        return { rows: ownInserted ? [{ id: 'own' }] : [] };
      }
      if (sql.includes('INSERT INTO event_provenance_conflict')) {
        inserts.push({ table: 'event_provenance_conflict', params });
        return { rows: [] };
      }
      if (sql.includes('FROM event_provenance_conflict')) return { rows: evidence };
      if (sql.includes('FROM event_provenance')) return { rows: ownInserted ? [{ id: 'own' }, ...stored] : stored };
      throw new Error(`unexpected statement ${sql}`);
    }) as Queryable['query'],
  };
  return { db: { tx: <T>(fn: (q: Queryable) => Promise<T>) => fn(q) }, inserts };
}
const observation = (body = BODY): KeyedProvenanceObservation => ({
  source: 'auth-service', eventId: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', name: 'member.contact_verification_requested', routingKey: 'member.contact_verification_requested',
  exchange: 'nawara.events', producerUserId: 'auth-service', verified: true, reason: 'verified', body,
});
const row = (keyId: string, key: Buffer | undefined, body = BODY, over: Record<string, unknown> = {}) => ({
  id: 'r1', name: 'member.contact_verification_requested', routingKey: 'member.contact_verification_requested', exchange: 'nawara.events', bodyCommitmentVersion: 1,
  bodyMacKeyId: keyId, bodyMac: key ? bodyMac(key, body) : 'a'.repeat(64), producerUserId: 'auth-service', verified: true, reason: 'verified', ...over,
});

describe('PgKeyedProvenanceStore (comparisons under the STORED key)', () => {
  it('records under the ACTIVE key: version, key id and MAC; never an unkeyed digest', async () => {
    const { db, inserts } = fakeDb([], [], true);
    expect(await new PgKeyedProvenanceStore(db, ring()).record('q', observation())).toBe('recorded');
    const params = inserts[0]!.params;
    expect(params.slice(6, 9)).toEqual([1, 'p1', bodyMac(K1, BODY)]);
    expect(params).not.toContain(createHash('sha256').update(BODY).digest('hex'));
    expect(params.some((p) => Buffer.isBuffer(p))).toBe(false); // the body itself is never a parameter
  });

  it('after a rotation, an identical delivery of a row made under the OLD key is a duplicate (no false conflict)', async () => {
    const { db, inserts } = fakeDb([row('p1', K1)]);
    const rotated = ring({ activeKeyId: 'p2', keys: new Map([['p1', K1], ['p2', K2]]) });
    expect(await new PgKeyedProvenanceStore(db, rotated).record('q', observation())).toBe('duplicate');
    expect(inserts.filter((i) => i.table === 'event_provenance_conflict')).toEqual([]);
  });

  it('a changed body (a changed code) under the stored key is a conflict, recorded under the active key', async () => {
    const { db, inserts } = fakeDb([row('p1', K1)]);
    const changed = Buffer.from(BODY.toString().replace('730591', '000001'));
    const rotated = ring({ activeKeyId: 'p2', keys: new Map([['p1', K1], ['p2', K2]]) });
    expect(await new PgKeyedProvenanceStore(db, rotated).record('q', observation(changed))).toBe('conflict');
    const conflict = inserts.find((i) => i.table === 'event_provenance_conflict')!.params;
    expect(conflict.slice(7, 10)).toEqual([1, 'p2', bodyMac(K2, changed)]);
  });

  it('a RETIRED stored key: unverifiable, never a duplicate; appended as evidence once (later compared under the evidence key)', async () => {
    const retired = ring({ activeKeyId: 'p2', keys: new Map([['p2', K2]]), retiredKeyIds: new Set(['p1']) });
    const first = fakeDb([row('p1', undefined)]);
    expect(await new PgKeyedProvenanceStore(first.db, retired).record('q', observation())).toBe('conflict');
    expect(first.inserts.filter((i) => i.table === 'event_provenance_conflict')).toHaveLength(1);
    const again = fakeDb([row('p1', undefined)], [row('p2', K2, BODY, { id: 'e1' })]);
    expect(await new PgKeyedProvenanceStore(again.db, retired).record('q', observation())).toBe('conflict');
    expect(again.inserts.filter((i) => i.table === 'event_provenance_conflict')).toEqual([]); // the same evidence is kept once
  });

  it('an UNAVAILABLE stored key (neither in the ring nor retired) fails closed: the commit rejects, nothing is decided or inserted as evidence', async () => {
    const { db, inserts } = fakeDb([row('p1', undefined)]);
    const unavailable = ring({ activeKeyId: 'p3', keys: new Map([['p3', K2]]) });
    await expect(new PgKeyedProvenanceStore(db, unavailable).record('q', observation())).rejects.toBeInstanceOf(ProvenanceKeyUnavailableError);
    expect(inserts.filter((i) => i.table === 'event_provenance_conflict')).toEqual([]);
  });

  it('an unknown commitment version is never compared or assumed equal: the commit rejects', async () => {
    const { db } = fakeDb([row('p1', K1, BODY, { bodyCommitmentVersion: 2 })]);
    await expect(new PgKeyedProvenanceStore(db, ring()).record('q', observation())).rejects.toBeInstanceOf(ProvenanceCommitmentVersionError);
  });
});

/** The bus's real `deliver` against a recording channel and a scripted KEYED store. */
function harness(record: (o: KeyedProvenanceObservation) => Promise<ProvenanceRecordResult>) {
  const steps: string[] = [];
  const notices: string[] = [];
  const observations: EventBusObservation[] = [];
  const seen: KeyedProvenanceObservation[] = [];
  const bus = new RabbitMqEventBus({ url: 'amqp://127.0.0.1:1', exchange: 'nawara.events', retry: { maxRetries: 2, delayMs: 20 }, onNotice: (m) => notices.push(m) });
  bus.setObserver((o) => observations.push(o));
  const internal = bus as unknown as { republish: (q: string) => Promise<void>; ensureDeadQueue: () => Promise<void>; deliver: (ch: unknown, msg: unknown, sub: EventSubscription) => Promise<void> };
  internal.ensureDeadQueue = async () => undefined;
  internal.republish = async (q: string) => void steps.push(`republish:${q.endsWith('.retry') ? 'retry' : 'dead'}`);
  const ch = { ack: () => steps.push('ack'), nack: (_m: unknown, _a: boolean, requeue: boolean) => steps.push(`nack:requeue=${requeue}`) };
  const sub: EventSubscription = {
    queue: 'notification.events', bindings: ['member.contact_verification_requested'],
    handler: async () => void steps.push('handler'),
    provenance: {
      ownerOf: () => 'auth-service',
      keyedStore: {
        record: async (_consumer, o) => {
          seen.push(o);
          steps.push('record');
          return record(o);
        },
      },
    },
  };
  const id = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
  const deliver = () => internal.deliver(ch, {
    content: BODY,
    fields: { exchange: 'nawara.events', routingKey: 'member.contact_verification_requested', redelivered: false },
    properties: { messageId: id, type: 'member.contact_verification_requested', userId: 'auth-service', headers: { eventId: id, source: 'auth-service', occurredAt: '2026-10-23T00:00:00.000Z', version: 1 } },
  }, sub);
  return { steps, notices, observations, seen, deliver };
}

describe('RabbitMqEventBus keyed provenance (Core V2 S1b-3)', () => {
  it('gives the keyed store the verified facts and the raw bytes only: no unkeyed digest on this path; the handler runs after the commit', async () => {
    const h = harness(async () => 'recorded');
    await h.deliver();
    expect(h.steps).toEqual(['record', 'handler', 'ack']);
    expect(h.seen[0]).toMatchObject({ source: 'auth-service', producerUserId: 'auth-service', verified: true, reason: 'verified' });
    expect(h.seen[0]!.body.equals(BODY)).toBe(true);
    expect(Object.keys(h.seen[0]!)).not.toContain('bodySha256');
  });

  it('a store that cannot compare (an unavailable key) fails closed: no handler, no retry, no dead letter; held and requeued, nothing secret logged', async () => {
    const h = harness(async () => {
      throw new ProvenanceKeyUnavailableError();
    });
    await h.deliver();
    expect(h.steps).toEqual(['record', 'nack:requeue=true']);
    expect(h.notices.join('\n')).toMatch(/event_provenance_deferred .* error=ProvenanceKeyUnavailableError/);
    expect(h.notices.join('\n')).not.toMatch(/730591|member@example|[A-Za-z0-9+/]{40,}={0,2}/);
  });

  it('a subscription cannot give both an unkeyed and a keyed store (compile-time)', () => {
    const keyedStore = { record: async () => 'recorded' as const };
    const store = { record: async () => 'recorded' as const };
    // @ts-expect-error: `store` and `keyedStore` are mutually exclusive
    const both: EventSubscription['provenance'] = { ownerOf: () => undefined, store, keyedStore };
    expect(both).toBeDefined();
  });
});
