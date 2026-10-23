import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../db/db.service.js';
import { EVENT_NAME } from './types.js';

/**
 * Core V2 S1b (ADR-0057 §13.2, §13.3; observe-only): durable provenance of the events a consumer receives, recorded in the consumer's OWN
 * database, in a transaction of its own, BEFORE its handler runs. Technical infrastructure only: which service owns which event comes from
 * the consuming service (its trusted catalog), never from here.
 *
 * Observe-only: a delivery that fails verification, or that differs from what was stored, is recorded and reported, and the handler runs
 * exactly as before. What blocks the handler is only a failure to RECORD (the delivery is then held and requeued with its original broker
 * metadata, never sent to `<queue>.retry` or dead-lettered). Enforcement (§13.4, §13.5) is a later, separately authorized stage.
 */

/** Why an observation is or is not verified: a closed set, the FIRST failed §13.2 criterion in the order below. */
export const PROVENANCE_REASONS = [
  'verified',
  'missing_user_id',
  'source_mismatch',
  'unknown_event',
  'not_family_owner',
  'routing_key_mismatch',
  'invalid_event_id',
] as const;
export type ProvenanceReason = (typeof PROVENANCE_REASONS)[number];

/**
 * What a consumer opts into: its trusted event-owner resolver and its durable store. The store keeps an unkeyed SHA-256 of each raw body
 * (§13.2), so it must never be enabled for a queue that can receive a low-entropy secret (a code-bearing event): the digest would let
 * anyone who can read the table recover the secret offline.
 */
export interface ProvenanceOptions {
  /**
   * The service that owns an event name (the family owner of ADR-0057 §13.1), from the consumer's trusted, server-side catalog; undefined
   * for a name it does not know. Never derived from a message.
   */
  ownerOf(name: string): string | undefined;
  store: ProvenanceStore;
  keyedStore?: never;
}

/**
 * Core V2 S1b-3 (ADR-0057 §13.2 "S0-C2"): what a consumer whose bodies may carry a low-entropy secret opts into instead: the body is
 * committed with a KEYED MAC by its `keyedStore`, which alone sees the raw bytes; no unkeyed digest of the body is ever computed on this
 * path. `store` cannot be given beside it, so a consumer cannot fall back to (or mix in) the unkeyed digest.
 */
export interface KeyedProvenanceOptions {
  ownerOf(name: string): string | undefined;
  keyedStore: KeyedProvenanceStore;
  store?: never;
}

export interface ProvenanceStore {
  /** Commits `observation` (and any conflict it reveals) before resolving; rejects if it could not be committed. */
  record(consumer: string, observation: ProvenanceObservation): Promise<ProvenanceRecordResult>;
}

/** Core V2 S1b-3: a keyed store, given the verified facts and the raw body bytes (it commits the body itself, under its own key). */
export interface KeyedProvenanceStore {
  /** Commits the observation (and any conflict it reveals) before resolving; rejects if it could not be committed (or compared). */
  record(consumer: string, observation: KeyedProvenanceObservation): Promise<ProvenanceRecordResult>;
}

/** The facts of one original delivery plus its raw body bytes, for a keyed store only (never logged, never stored as such). */
export interface KeyedProvenanceObservation extends ProvenanceFacts {
  body: Buffer;
}

/** `recorded`: a new observation; `duplicate`: identical to what was stored; `conflict`: it differs from a stored observation of the same id. */
export type ProvenanceRecordResult = 'recorded' | 'duplicate' | 'conflict';

/** The broker-delivered facts provenance is computed from: AMQP fields and properties as RabbitMQ delivered them, and the raw body. */
export interface ProvenanceDelivery {
  exchange: string;
  routingKey: string;
  userId: unknown;
  messageId: unknown;
  type: unknown;
  headers: Record<string, unknown>;
  body: Buffer;
}

/**
 * What §13.2 verifies of one original delivery, before any body commitment. Every string is a validated token (or empty), so a hostile
 * value can neither break nor reach a log.
 */
export interface ProvenanceFacts {
  source: string;
  eventId: string;
  name: string;
  routingKey: string;
  exchange: string;
  /** The AMQP `user_id` the broker delivered (validated by the broker against the publishing connection); null when absent. */
  producerUserId: string | null;
  verified: boolean;
  reason: ProvenanceReason;
}

/** One original delivery, as an UNKEYED store records it. */
export interface ProvenanceObservation extends ProvenanceFacts {
  /** SHA-256 of the raw delivered body bytes, lowercase hex. */
  bodySha256: string;
}

/**
 * `original`: delivered through the configured event exchange, evaluated and recorded. `not_original`: anything else (the default exchange a
 * retry, an operator replay or an injection arrives through, or any other exchange): never evaluated as an original publication and never
 * recorded, so no provenance is ever manufactured for it (§13.4, §13.6).
 */
export type ProvenanceEvaluation = { origin: 'original'; observation: ProvenanceObservation } | { origin: 'not_original' };
/** The same classification without any body commitment (the keyed path commits the body in its store). */
export type ProvenanceFactsEvaluation = { origin: 'original'; facts: ProvenanceFacts } | { origin: 'not_original' };

// The forms an event id takes in Core: the outbox row id, a canonical lowercase uuid (random v4, or a producer's deterministic v5).
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Stored tokens. Anything else is stored empty: a value that the database might refuse would hold the delivery forever.
const SERVICE = /^[a-z][a-z0-9-]{0,62}$/;
const BROKER_USER = /^[A-Za-z0-9._-]{1,64}$/;
const ID_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;
const token = (value: unknown, pattern: RegExp): string => (typeof value === 'string' && pattern.test(value) ? value : '');
const eventName = (value: unknown): string => (typeof value === 'string' && value.length <= 255 && EVENT_NAME.test(value) ? value : '');

export const bodySha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

/**
 * ADR-0057 §13.2. A delivery through `exchange` is verified only if: the broker `user_id` is present, it equals `headers.source`, it is the
 * owner the consumer's catalog names for the event, the routing key equals the message type (the envelope name), and the event id is a
 * canonical uuid carried identically in `messageId` and `headers.eventId`. Headers, payload, correlation ids and routing keys are evidence
 * to compare, never identity on their own.
 */
export function evaluateProvenance(d: ProvenanceDelivery, exchange: string, ownerOf: (name: string) => string | undefined): ProvenanceEvaluation {
  const e = evaluateProvenanceFacts(d, exchange, ownerOf);
  return e.origin === 'original' ? { origin: 'original', observation: { ...e.facts, bodySha256: bodySha256(d.body) } } : e;
}

/** `evaluateProvenance` without the unkeyed body digest: the §13.2 classification only (Core V2 S1b-3, the keyed path). */
export function evaluateProvenanceFacts(d: Omit<ProvenanceDelivery, 'body'>, exchange: string, ownerOf: (name: string) => string | undefined): ProvenanceFactsEvaluation {
  if (d.exchange !== exchange) return { origin: 'not_original' };
  const name = eventName(d.type);
  const producerUserId = token(d.userId, BROKER_USER) || null;
  const source = token(d.headers.source, SERVICE);
  const routingKey = eventName(d.routingKey);
  const eventId = token(d.messageId, ID_TOKEN);
  let owner: string | undefined;
  try {
    owner = name ? ownerOf(name) : undefined;
  } catch {
    owner = undefined; // a resolver that throws knows no owner: unverified, never a failure of the delivery
  }
  let reason: ProvenanceReason = 'verified';
  if (producerUserId === null) reason = 'missing_user_id';
  else if (source !== producerUserId) reason = 'source_mismatch';
  else if (owner === undefined) reason = 'unknown_event';
  else if (owner !== producerUserId) reason = 'not_family_owner';
  else if (name === '' || routingKey !== name) reason = 'routing_key_mismatch';
  else if (!EVENT_ID.test(eventId) || d.headers.eventId !== eventId) reason = 'invalid_event_id';
  return { origin: 'original', facts: { source, eventId, name, routingKey, exchange: d.exchange, producerUserId, verified: reason === 'verified', reason } };
}

interface StoredRow {
  id: string;
  name: string;
  routingKey: string;
  bodySha256: string;
  producerUserId: string | null;
  verified: boolean;
}
const differs = (r: StoredRow, o: ProvenanceObservation): boolean =>
  r.name !== o.name || r.routingKey !== o.routingKey || r.bodySha256 !== o.bodySha256 || r.producerUserId !== o.producerUserId || r.verified !== o.verified;

/**
 * The PostgreSQL store, over the consuming service's `event_provenance` and `event_provenance_conflict` tables (created by that service's own
 * migration; both append-only there).
 *
 * At most ONE verified and ONE unverified observation per (consumer, source, eventId): the verified row is the authoritative provenance and
 * only a delivery meeting every §13.2 criterion can create it, so an unverified first arrival never occupies, blocks or discredits it. Every
 * later observation that differs from a stored one (body, name, routing key, producer, verification) is appended to the conflict table with
 * a reference to the row it differs from; the stored row is never changed. Observations of one id are serialized by a transaction-scoped
 * advisory lock, so two concurrent, different deliveries always see each other.
 */
export class PgProvenanceStore implements ProvenanceStore {
  constructor(private readonly db: { tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> }) {}

  record(consumer: string, o: ProvenanceObservation): Promise<ProvenanceRecordResult> {
    return this.db.tx(async (q) => {
      await q.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`event_provenance:${consumer}:${o.source}:${o.eventId}`]);
      const inserted = await q.query<{ id: string }>(
        `INSERT INTO event_provenance (consumer, source, "eventId", name, "routingKey", exchange, "bodySha256", "producerUserId", verified, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (consumer, source, "eventId", verified) DO NOTHING RETURNING id`,
        [consumer, o.source, o.eventId, o.name, o.routingKey, o.exchange, o.bodySha256, o.producerUserId, o.verified, o.reason],
      );
      const own = inserted.rows[0]?.id;
      const stored = await q.query<StoredRow>(
        `SELECT id, name, "routingKey", "bodySha256", "producerUserId", verified FROM event_provenance
          WHERE consumer = $1 AND source = $2 AND "eventId" = $3 ORDER BY "firstSeenAt", id`,
        [consumer, o.source, o.eventId],
      );
      let conflict = false;
      for (const r of stored.rows) {
        if (r.id === own || !differs(r, o)) continue;
        conflict = true;
        await q.query(
          `INSERT INTO event_provenance_conflict ("provenanceId", consumer, source, "eventId", name, "routingKey", exchange, "bodySha256", "producerUserId", verified, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
          [r.id, consumer, o.source, o.eventId, o.name, o.routingKey, o.exchange, o.bodySha256, o.producerUserId, o.verified, o.reason],
        );
      }
      return conflict ? 'conflict' : own ? 'recorded' : 'duplicate';
    });
  }
}

// ─────────────────────────────────────────────────────────────── Core V2 S1b-3: the keyed body commitment (ADR-0057 §13.2 "S0-C2")

/** The body-commitment construction this kit writes: version 1 = HMAC-SHA-256 of the raw delivered body bytes, lowercase hex. */
export const BODY_COMMITMENT_VERSION = 1;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAC_HEX = /^[0-9a-f]{64}$/;

/**
 * A consumer's provenance key ring: its keys by non-secret id, the id new commitments use, and the ids deliberately RETIRED (their key
 * material removed under a reviewed procedure: their rows are unverifiable). A stored key id that is in neither is UNAVAILABLE (a
 * configuration fault): comparing under it fails closed until it is restored. Keys come from the service's configuration, never from the
 * database, and are never generated here.
 */
export interface ProvenanceKeyRing {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly retiredKeyIds: ReadonlySet<string>;
}

/** HMAC-SHA-256 of the complete raw body bytes under `key` (version 1), lowercase hex. */
export function bodyMac(key: Buffer, body: Buffer): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

/** A stored commitment could not be compared because its key is not in the ring and was not retired: the observation is not committed. */
export class ProvenanceKeyUnavailableError extends Error {
  constructor() {
    super('provenance_key_unavailable');
    this.name = 'ProvenanceKeyUnavailableError';
  }
}

/** A stored commitment of a version this kit does not know: never compared, never assumed equal. */
export class ProvenanceCommitmentVersionError extends Error {
  constructor() {
    super('provenance_commitment_version_unknown');
    this.name = 'ProvenanceCommitmentVersionError';
  }
}

/** Checks a ring's shape (ids, a present active key, keys of at least 32 bytes, retired ids that are no longer in the ring). Never echoes key material. */
export function assertProvenanceKeyRing(ring: ProvenanceKeyRing): void {
  if (!KEY_ID.test(ring.activeKeyId) || !ring.keys.has(ring.activeKeyId)) throw new Error('the active provenance key is not in the key ring');
  for (const [id, key] of ring.keys) {
    if (!KEY_ID.test(id)) throw new Error('a provenance key id is not 1 to 32 letters, digits, _ or -');
    if (!Buffer.isBuffer(key) || key.length < 32) throw new Error('a provenance key is shorter than 32 bytes');
    if (ring.retiredKeyIds.has(id)) throw new Error('a provenance key id is both in the ring and retired');
  }
  for (const id of ring.retiredKeyIds) if (!KEY_ID.test(id)) throw new Error('a retired provenance key id is not 1 to 32 letters, digits, _ or -');
}

interface KeyedRow {
  id: string;
  name: string;
  routingKey: string;
  exchange?: string;
  bodyCommitmentVersion: number;
  bodyMacKeyId: string;
  bodyMac: string;
  producerUserId: string | null;
  verified: boolean;
  reason?: string;
}

/**
 * The PostgreSQL store of a KEYED consumer (Core V2 S1b-3, ADR-0057 §13.2 "S0-C2"): the same tables' roles, uniqueness, advisory lock,
 * unverified-first rule and append-only conflict evidence as `PgProvenanceStore`, but the body is recorded only as `bodyMac`, an
 * HMAC-SHA-256 of the raw bytes under the ring's ACTIVE key, with `bodyMacKeyId` and `bodyCommitmentVersion`. No unkeyed digest of a body is
 * computed or stored here.
 *
 * Comparisons (duplicate, conflict, conflict-evidence de-duplication) recompute the delivery's MAC under the STORED row's key and compare in
 * constant time: two MACs made under different keys are never compared, so a rotation never creates a false conflict. A stored row whose
 * key was retired is UNVERIFIABLE: never a duplicate, so the delivery is appended as conflict evidence (observe-only). A stored row whose key
 * is merely unavailable, or whose commitment version is unknown, makes the commit fail (the bus holds and requeues the delivery, §13.3):
 * nothing is decided, nothing is assumed equal, nothing is changed.
 */
export class PgKeyedProvenanceStore implements KeyedProvenanceStore {
  constructor(
    private readonly db: { tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> },
    private readonly ring: ProvenanceKeyRing,
  ) {
    assertProvenanceKeyRing(ring);
  }

  record(consumer: string, o: KeyedProvenanceObservation): Promise<ProvenanceRecordResult> {
    const macs = new Map<string, string>(); // the delivery's MAC per key id, computed at most once
    const macUnder = (keyId: string): string | undefined => {
      const key = this.ring.keys.get(keyId);
      if (!key) return undefined;
      let mac = macs.get(keyId);
      if (mac === undefined) macs.set(keyId, (mac = bodyMac(key, o.body)));
      return mac;
    };
    /** 'same' / 'different' under the stored row's own key, 'unverifiable' for a retired key; throws when it cannot be decided. */
    const bodyOf = (r: KeyedRow): 'same' | 'different' | 'unverifiable' => {
      if (r.bodyCommitmentVersion !== BODY_COMMITMENT_VERSION) throw new ProvenanceCommitmentVersionError();
      const mine = macUnder(r.bodyMacKeyId);
      if (mine === undefined) {
        if (this.ring.retiredKeyIds.has(r.bodyMacKeyId)) return 'unverifiable';
        throw new ProvenanceKeyUnavailableError();
      }
      if (!MAC_HEX.test(r.bodyMac)) return 'different';
      return timingSafeEqual(Buffer.from(mine, 'hex'), Buffer.from(r.bodyMac, 'hex')) ? 'same' : 'different';
    };
    const sameFacts = (r: KeyedRow): boolean =>
      r.name === o.name && r.routingKey === o.routingKey && r.producerUserId === o.producerUserId && r.verified === o.verified;
    const activeKeyId = this.ring.activeKeyId;
    const mac = macUnder(activeKeyId)!;

    return this.db.tx(async (q) => {
      await q.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`event_provenance:${consumer}:${o.source}:${o.eventId}`]);
      const inserted = await q.query<{ id: string }>(
        `INSERT INTO event_provenance (consumer, source, "eventId", name, "routingKey", exchange, "bodyCommitmentVersion", "bodyMacKeyId", "bodyMac", "producerUserId", verified, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (consumer, source, "eventId", verified) DO NOTHING RETURNING id`,
        [consumer, o.source, o.eventId, o.name, o.routingKey, o.exchange, BODY_COMMITMENT_VERSION, activeKeyId, mac, o.producerUserId, o.verified, o.reason],
      );
      const own = inserted.rows[0]?.id;
      const stored = await q.query<KeyedRow>(
        `SELECT id, name, "routingKey", "bodyCommitmentVersion", "bodyMacKeyId", "bodyMac", "producerUserId", verified FROM event_provenance
          WHERE consumer = $1 AND source = $2 AND "eventId" = $3 ORDER BY "firstSeenAt", id`,
        [consumer, o.source, o.eventId],
      );
      let conflict = false;
      for (const r of stored.rows) {
        if (r.id === own || (sameFacts(r) && bodyOf(r) === 'same')) continue;
        conflict = true;
        // the same differing evidence against this row is kept once: compared under each evidence row's own key, like the row itself
        const evidence = await q.query<KeyedRow>(
          `SELECT id, name, "routingKey", exchange, "bodyCommitmentVersion", "bodyMacKeyId", "bodyMac", "producerUserId", verified, reason
             FROM event_provenance_conflict WHERE "provenanceId" = $1`,
          [r.id],
        );
        const known = evidence.rows.some((e) => sameFacts(e) && e.exchange === o.exchange && e.reason === o.reason && bodyOf(e) === 'same');
        if (known) continue;
        await q.query(
          `INSERT INTO event_provenance_conflict ("provenanceId", consumer, source, "eventId", name, "routingKey", exchange, "bodyCommitmentVersion", "bodyMacKeyId", "bodyMac",
             "producerUserId", verified, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT DO NOTHING`,
          [r.id, consumer, o.source, o.eventId, o.name, o.routingKey, o.exchange, BODY_COMMITMENT_VERSION, activeKeyId, mac, o.producerUserId, o.verified, o.reason],
        );
      }
      return conflict ? 'conflict' : own ? 'recorded' : 'duplicate';
    });
  }
}
