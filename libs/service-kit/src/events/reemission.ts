import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/db.service.js';
import { MIGRATIONS_TABLE } from '../db/migrations.js';
import { outboxEnvelope, SERIALIZATION_PIPELINE_VERSION, type OutboxEnvelopeRow } from './serialization.js';
import { EVENT_NAME, type EventEnvelope } from './types.js';

/**
 * Core V2 S1c-3 R1 (ADR-0057 §13.7 "S0-C4"): the restricted foundation for a producer to re-emit ONE of its own published, immutable
 * outbox rows. It is a library behind a producer's own entry point, never a publisher: it accepts no event content, no source, no
 * exchange, routing key or `user_id`, and it publishes only after every check below has passed and the producer has durably recorded the
 * attempt. Nothing in the kit supplies a producer's authorizer, ownership evidence, pipeline evidence or attempt store, so the kit alone
 * cannot re-emit anything: a producer integration (R2 for payment-service) is a separately authorized change.
 *
 * Order of `ProducerReemission.reemit` (each step refuses with a `ReemissionRefused` code and publishes nothing):
 *   1. the request is exactly `{ eventId, eventName, reason }` (any other field is refused: no payload, source or identity);
 *   2. the event name is in the producer's policy, which the kit holds to the S0-C4 approvals, and is never code-bearing;
 *   3. the producer's authorizer returns VERIFIED claims bound to this producer, event, reason, environment and operation;
 *   4. in one read-only transaction on the producer's own database: the database is confirmed as the producer's, the row exists, carries
 *      the expected name, is published, has an allowed version, and the producer's publication evidence establishes that pipeline v1
 *      published it; the envelope is then built from the row by the relay's own `outboxEnvelope`;
 *   5. the producer commits the intent, the attempt and its own audit intent, and returns a durable receipt; then the `publishing` state;
 *   6. only then the bus publishes, on a confirm channel of its own broker connection, with `mandatory`; the outcome is appended.
 */

/** The only operation an authorization for this foundation may name. */
export const REEMISSION_OPERATION = 'event.reemit';

/**
 * ADR-0057 §13.7 "S0-C4" (OD-15 resolved for Payment-first only): every (producer, event name, version) any producer may re-emit. No
 * wildcard and no other producer; widening it is an architecture decision first (`npm run check:repo` holds this list to that decision
 * and each entry to its producer's event contract).
 */
export const REEMISSION_APPROVALS: Readonly<Record<string, readonly Readonly<ReemittableEvent>[]>> = Object.freeze({
  'payment-service': Object.freeze([
    Object.freeze({ name: 'payment.succeeded', version: 1 }),
    Object.freeze({ name: 'payment.failed', version: 1 }),
    Object.freeze({ name: 'payment.cancelled', version: 1 }),
    Object.freeze({ name: 'payment.expired', version: 1 }),
  ]),
});

/**
 * ADR-0052 decision 5 and S0-C4: code-bearing events are never re-emitted, for any producer, with no override. `npm run check:repo` fails
 * when an event contract marks a produced event `codeBearing` that this list does not name.
 */
export const CODE_BEARING_EVENTS: readonly string[] = Object.freeze([
  'member.contact_verification_requested',
  'admin.operator_code_issued',
  'admin.operator_confirmation_code_issued',
]);

export interface ReemittableEvent {
  name: string;
  version: number;
}

/** A producer's own allowlist: a subset of its S0-C4 approvals. Build it with `reemissionPolicy`. */
export interface ReemissionPolicy {
  readonly producer: string;
  readonly events: readonly Readonly<ReemittableEvent>[];
}

export type ReemissionRefusalCode =
  | 'policy_invalid'
  | 'request_invalid'
  | 'event_not_allowed'
  | 'code_bearing_event'
  | 'authorization_invalid'
  | 'database_ownership_unconfirmed'
  | 'lookup_failed'
  | 'row_missing'
  | 'row_name_mismatch'
  | 'row_unpublished'
  | 'version_not_allowed'
  | 'pipeline_unknown'
  | 'pipeline_incompatible'
  | 'intent_not_durable'
  | 'attempt_state_not_durable';

/**
 * Why nothing was published. The message is the stable code only: never a payload, a request value, a credential or another component's
 * error text (no `cause` is attached, so a producer's own error cannot leak through it).
 */
export class ReemissionRefused extends Error {
  constructor(readonly code: ReemissionRefusalCode) {
    super(`event re-emission refused: ${code}`);
    this.name = 'ReemissionRefused';
  }
}

const SERVICE = /^[a-z][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const TOKEN = /^[A-Za-z0-9._:/-]{1,128}$/;
const CHECKSUM = /^[0-9a-f]{64}$/;

export const isCodeBearingEvent = (name: string): boolean => CODE_BEARING_EVENTS.includes(name);

/**
 * Builds a producer's allowlist, refusing (`policy_invalid`) a producer or an entry the S0-C4 approvals do not name, a pattern, a duplicate,
 * an empty list and any code-bearing event.
 */
export function reemissionPolicy(producer: string, events: readonly ReemittableEvent[]): ReemissionPolicy {
  const approved = SERVICE.test(producer) && Object.hasOwn(REEMISSION_APPROVALS, producer) ? REEMISSION_APPROVALS[producer]! : undefined;
  const seen = new Set<string>();
  const ok = approved !== undefined && Array.isArray(events) && events.length > 0 && events.every((e) => {
    const valid = typeof e?.name === 'string' && EVENT_NAME.test(e.name) && Number.isInteger(e.version) && e.version >= 1 && !isCodeBearingEvent(e.name)
      && !seen.has(e.name) && approved.some((a) => a.name === e.name && a.version === e.version);
    seen.add(e?.name);
    return valid;
  });
  if (!ok) throw new ReemissionRefused('policy_invalid');
  return Object.freeze({ producer, events: Object.freeze(events.map((e) => Object.freeze({ name: e.name, version: e.version }))) });
}

/** What a producer's entry point may ask for: an existing event by id and expected name, and a reason code. Nothing else is accepted. */
export interface ReemissionRequest {
  eventId: string;
  eventName: string;
  /** A short reason CODE (`[a-z][a-z0-9_]*`), never free text. */
  reason: string;
}
const REQUEST_FIELDS = ['eventId', 'eventName', 'reason'];

/** The request as a fresh object of exactly its three fields, or `request_invalid` (an extra field such as a payload or a source included). */
export function reemissionRequest(input: unknown): ReemissionRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new ReemissionRefused('request_invalid');
  const keys = Reflect.ownKeys(input);
  const r = input as Record<string, unknown>;
  if (keys.length !== REQUEST_FIELDS.length || !REQUEST_FIELDS.every((k) => Object.hasOwn(r, k) && typeof r[k] === 'string')) throw new ReemissionRefused('request_invalid');
  const req = { eventId: r.eventId as string, eventName: r.eventName as string, reason: r.reason as string };
  if (!UUID.test(req.eventId) || !EVENT_NAME.test(req.eventName) || !REASON.test(req.reason)) throw new ReemissionRefused('request_invalid');
  return req;
}

/**
 * What the producer's authorizer VERIFIED (the Owner approval through the protected execution gate, S0-C4 "Authority"). The kit holds every
 * bound field to the request and the producer's own context; an approval reference alone is never authorization.
 */
export interface ReemissionAuthorizationClaims {
  producer: string;
  eventId: string;
  eventName: string;
  reason: string;
  approvalRef: string;
  environment: string;
  operation: string;
}

/**
 * Producer-owned. Verifies the Owner's approval from evidence it obtains through its own trusted channel (never from the request, which
 * carries none) and returns the claims it verified, or throws. The kit supplies no implementation.
 */
export interface ReemissionAuthorizer {
  verify(request: Readonly<ReemissionRequest>, context: Readonly<{ producer: string; environment: string; operation: string }>): Promise<ReemissionAuthorizationClaims>;
}

/** Producer-owned evidence that the database the foundation reads is the producer's own. Never a name the caller supplies. */
export interface DatabaseOwnership {
  confirm(q: Queryable): Promise<boolean>;
}

/**
 * Ownership evidence from the migration bookkeeping: every listed migration of the PRODUCER's own (non-kit) files is recorded with
 * exactly its checksum (`listMigrationFiles` over the producer's migration directory gives them). Kit migrations are applied to every
 * service database, so they prove nothing and are refused, as are an empty list and a malformed checksum; a row recorded without a
 * checksum never confirms.
 */
export function migrationOwnership(expected: readonly { name: string; checksum: string }[]): DatabaseOwnership {
  const own = expected.map((m) => ({ name: m.name, checksum: m.checksum }));
  if (own.length === 0 || own.some((m) => typeof m.name !== 'string' || m.name.startsWith('kit_') || !m.name.endsWith('.sql') || typeof m.checksum !== 'string' || !CHECKSUM.test(m.checksum))) {
    throw new ReemissionRefused('policy_invalid');
  }
  return {
    async confirm(q) {
      const { rows } = await q.query<{ name: string; checksum: string | null }>(`SELECT name, checksum FROM ${MIGRATIONS_TABLE} WHERE name = ANY($1::text[])`, [own.map((m) => m.name)]);
      const recorded = new Map(rows.map((r) => [r.name, r.checksum]));
      return own.every((m) => recorded.get(m.name) === m.checksum);
    },
  };
}

/** A published outbox row, as the foundation reads it. */
export interface PublishedOutboxRow extends OutboxEnvelopeRow {
  publishedAt: Date;
}

/** The row facts a producer's publication evidence is given (never the payload). */
export type PublicationFacts = Readonly<Pick<PublishedOutboxRow, 'id' | 'name' | 'eventVersion' | 'occurredAt' | 'publishedAt'>>;

/**
 * Producer-owned: the serialization pipeline version that VERIFIABLY published this row, from the producer's verified publication history
 * (deployed releases and when each published), or undefined when that cannot be established. It is never "the version running now": a
 * row published before the evidence covers it is unknown, and unknown is ineligible. The kit supplies no implementation.
 */
export interface PublicationEvidence {
  pipelineVersionOf(q: Queryable, row: PublicationFacts): Promise<number | undefined>;
}

/** The pipelines whose published bytes the current pipeline reproduces exactly: only itself (a new pipeline adds a reviewed entry). */
export const REEMISSION_COMPATIBLE_PIPELINES: readonly number[] = Object.freeze([SERIALIZATION_PIPELINE_VERSION]);

/** What the producer commits, in ONE transaction of its own, before anything is published. Never the body. */
export interface ReemissionIntent {
  attemptId: string;
  producer: string;
  eventId: string;
  eventName: string;
  eventVersion: number;
  reason: string;
  approvalRef: string;
  environment: string;
  operation: string;
  pipelineVersion: number;
  requestedAt: string;
}

/**
 * The producer's confirmation that the intent, the attempt and its audit intent (through its own outbox) are COMMITTED. The foundation
 * publishes only with a receipt for exactly this attempt; anything else is `intent_not_durable`.
 */
export interface DurableIntentReceipt {
  attemptId: string;
  intentCommitted: true;
  auditIntentRecorded: true;
}

/** The facts a producer's audit record of a re-emission may carry: never the body, a code, a credential or a digest. */
export type ReemissionAuditFacts = Readonly<Pick<ReemissionIntent, 'attemptId' | 'producer' | 'eventId' | 'eventName' | 'reason' | 'approvalRef' | 'environment' | 'requestedAt'>>;
export const reemissionAuditFacts = (i: ReemissionIntent): ReemissionAuditFacts =>
  Object.freeze({ attemptId: i.attemptId, producer: i.producer, eventId: i.eventId, eventName: i.eventName, reason: i.reason, approvalRef: i.approvalRef, environment: i.environment, requestedAt: i.requestedAt });

/** The attempt's states. `confirmed`, `unroutable`, `failed` and `uncertain` are final: nothing replaces them, `uncertain` included. */
export type ReemissionAttemptState = 'requested' | 'publishing' | 'confirmed' | 'unroutable' | 'failed' | 'uncertain';
const NEXT: Readonly<Record<ReemissionAttemptState, readonly ReemissionAttemptState[]>> = Object.freeze({
  requested: ['publishing'],
  publishing: ['confirmed', 'unroutable', 'failed', 'uncertain'],
  confirmed: [],
  unroutable: [],
  failed: [],
  uncertain: [],
});

/** One appended fact of an attempt (the attempt's history is append-only; a transition never rewrites an earlier one). */
export interface ReemissionTransition {
  attemptId: string;
  from: ReemissionAttemptState;
  to: ReemissionAttemptState;
  /** For a failed or uncertain outcome: where it ended (`ReemissionPublishOutcome.stage`). */
  stage?: string;
  at: string;
}

/** Producer-owned, append-only persistence of attempts (R2 creates its tables). */
export interface ReemissionAttemptStore {
  /** Commits the intent, the attempt (`requested`) and the producer's audit intent in ONE transaction, then returns the receipt. */
  commitIntent(intent: Readonly<ReemissionIntent>): Promise<DurableIntentReceipt>;
  /** Appends one transition, durably; resolves only once it is committed. */
  appendTransition(transition: Readonly<ReemissionTransition>): Promise<void>;
}

export const mayTransition = (from: ReemissionAttemptState, to: ReemissionAttemptState): boolean => NEXT[from]?.includes(to) ?? false;

/**
 * What an attempt's recorded history says. A history ending in `requested` was never handed to the broker (`not_published`); one ending
 * in `publishing` may or may not have reached it (a crash or a lost outcome record): `uncertain`, never `failed`. Throws on a history the
 * transitions do not allow.
 */
export function reemissionAttemptOutcome(history: readonly ReemissionAttemptState[]): 'not_published' | 'confirmed' | 'unroutable' | 'failed' | 'uncertain' {
  if (history[0] !== 'requested') throw new Error('a re-emission attempt history starts at requested');
  for (let i = 1; i < history.length; i++) if (!mayTransition(history[i - 1]!, history[i]!)) throw new Error('a re-emission attempt history has a transition that is not allowed');
  const last = history[history.length - 1]!;
  if (last === 'requested') return 'not_published';
  if (last === 'publishing') return 'uncertain';
  return last;
}

/**
 * What the broker answered for a re-emission publish. `confirmed` means the broker accepted responsibility for the message AND routed it
 * (it was not returned); it never means a consumer received or processed it. `failed`: `not_sent` (refused before anything reached the
 * broker), `nacked` (the broker refused responsibility; a copy may still sit in some queue) or `refused` (the broker closed the channel on
 * the publish: access or precondition). `uncertain`: the broker may or may not have it (no confirmation in time, or the channel closed
 * otherwise); a lost confirmation is never reported as a failure.
 */
export type ReemissionPublishOutcome =
  | { outcome: 'confirmed' }
  | { outcome: 'unroutable' }
  | { outcome: 'failed'; stage: 'not_sent' | 'nacked' | 'refused' }
  | { outcome: 'uncertain'; stage: 'confirm_timeout' | 'channel_closed' };

/** An issued, single-use publication plan: the envelope as built from the row, frozen. Only `ProducerReemission` issues one. */
export interface ReemissionPlan {
  readonly attemptId: string;
  readonly event: Readonly<EventEnvelope>;
}

/** The bus side: `RabbitMqEventBus.publishReemission`. It publishes only a plan issued here, once. */
export interface ReemissionPublisher {
  publishReemission(plan: ReemissionPlan): Promise<ReemissionPublishOutcome>;
}

const issued = new WeakSet<ReemissionPlan>();
const deepFreeze = <T>(v: T): T => {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Reflect.ownKeys(v)) deepFreeze((v as Record<PropertyKey, unknown>)[k]);
  }
  return v;
};

/** Internal (not exported by the package): the bus consumes a plan exactly once, and only one this module issued. */
export function consumeIssuedReemissionPlan(plan: unknown): plan is ReemissionPlan {
  return typeof plan === 'object' && plan !== null && issued.delete(plan as ReemissionPlan);
}

export interface ProducerReemissionOptions {
  policy: ReemissionPolicy;
  /** The execution environment, from the producer's own trusted configuration. */
  environment: string;
  db: { tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> };
  ownership: DatabaseOwnership;
  evidence: PublicationEvidence;
  authorizer: ReemissionAuthorizer;
  attempts: ReemissionAttemptStore;
  publisher: ReemissionPublisher;
}

export interface ReemissionResult {
  attemptId: string;
  publish: ReemissionPublishOutcome;
  /** False when the outcome could not be appended: the attempt then stays `publishing`, which reads as `uncertain`. */
  outcomeRecorded: boolean;
}

const OUTCOME_STATE = { confirmed: 'confirmed', unroutable: 'unroutable', failed: 'failed', uncertain: 'uncertain' } as const;

/** The foundation a producer's own entry point wraps (see the module comment for the order of checks). */
export class ProducerReemission {
  private readonly opts: ProducerReemissionOptions;

  constructor(opts: ProducerReemissionOptions) {
    if (!opts?.policy || typeof opts.environment !== 'string' || !TOKEN.test(opts.environment)) throw new ReemissionRefused('policy_invalid');
    if (!opts.db || !opts.ownership || !opts.evidence || !opts.authorizer || !opts.attempts || !opts.publisher) throw new ReemissionRefused('policy_invalid');
    // re-validated here, so a hand-built policy object gets no further than one built by `reemissionPolicy`
    this.opts = { ...opts, policy: reemissionPolicy(opts.policy.producer, opts.policy.events) };
  }

  async reemit(input: unknown): Promise<ReemissionResult> {
    const { policy, environment } = this.opts;
    const request = reemissionRequest(input);
    if (isCodeBearingEvent(request.eventName)) throw new ReemissionRefused('code_bearing_event');
    const allowed = policy.events.find((e) => e.name === request.eventName);
    if (!allowed) throw new ReemissionRefused('event_not_allowed');

    const context = Object.freeze({ producer: policy.producer, environment, operation: REEMISSION_OPERATION });
    let claims: ReemissionAuthorizationClaims;
    try {
      claims = await this.opts.authorizer.verify(Object.freeze({ ...request }), context);
    } catch {
      throw new ReemissionRefused('authorization_invalid');
    }
    if (!claims || claims.producer !== policy.producer || claims.eventId !== request.eventId || claims.eventName !== request.eventName || claims.reason !== request.reason
      || claims.environment !== environment || claims.operation !== REEMISSION_OPERATION || typeof claims.approvalRef !== 'string' || !TOKEN.test(claims.approvalRef)) {
      throw new ReemissionRefused('authorization_invalid');
    }

    const { row, pipelineVersion } = await this.selectRow(request, allowed.version);
    const event = outboxEnvelope(row, policy.producer); // the relay's own envelope (serialization pipeline v1)

    const intent: ReemissionIntent = Object.freeze({
      attemptId: randomUUID(), producer: policy.producer, eventId: row.id, eventName: row.name, eventVersion: row.eventVersion, reason: request.reason,
      approvalRef: claims.approvalRef, environment, operation: REEMISSION_OPERATION, pipelineVersion, requestedAt: new Date().toISOString(),
    });
    let receipt: DurableIntentReceipt;
    try {
      receipt = await this.opts.attempts.commitIntent(intent);
    } catch {
      throw new ReemissionRefused('intent_not_durable');
    }
    if (!receipt || receipt.attemptId !== intent.attemptId || receipt.intentCommitted !== true || receipt.auditIntentRecorded !== true) throw new ReemissionRefused('intent_not_durable');
    try {
      await this.opts.attempts.appendTransition({ attemptId: intent.attemptId, from: 'requested', to: 'publishing', at: new Date().toISOString() });
    } catch {
      throw new ReemissionRefused('attempt_state_not_durable');
    }

    const plan: ReemissionPlan = deepFreeze({ attemptId: intent.attemptId, event }); // frozen: nothing can change it once issued
    issued.add(plan);
    let publish: ReemissionPublishOutcome;
    try {
      publish = await this.opts.publisher.publishReemission(plan);
    } catch {
      publish = { outcome: 'uncertain', stage: 'channel_closed' }; // a publisher that throws said nothing definite
    } finally {
      issued.delete(plan);
    }
    let outcomeRecorded = true;
    try {
      await this.opts.attempts.appendTransition({ attemptId: intent.attemptId, from: 'publishing', to: OUTCOME_STATE[publish.outcome], ...('stage' in publish ? { stage: publish.stage } : {}), at: new Date().toISOString() });
    } catch {
      outcomeRecorded = false;
    }
    return { attemptId: intent.attemptId, publish, outcomeRecorded };
  }

  /** Step 4: one read-only transaction on the producer's own database (shared with `inspectReemissionEligibility`). */
  private async selectRow(request: ReemissionRequest, allowedVersion: number): Promise<{ row: PublishedOutboxRow; pipelineVersion: number }> {
    return selectPublishedRow(this.opts, request, allowedVersion);
  }
}

/**
 * Step 4 of `reemit`, and the whole of `inspectReemissionEligibility`: in one READ-ONLY transaction on the producer's own database, the
 * database is confirmed as the producer's, the row exists, carries the expected name, is published, has the allowed version, and the
 * producer's publication evidence establishes a compatible pipeline. Refuses with the first failing code.
 */
async function selectPublishedRow(
  opts: Pick<ProducerReemissionOptions, 'db' | 'ownership' | 'evidence'>,
  request: Pick<ReemissionRequest, 'eventId' | 'eventName'>,
  allowedVersion: number,
): Promise<{ row: PublishedOutboxRow; pipelineVersion: number }> {
  let found: { row?: PublishedOutboxRow; owned: boolean; pipelineVersion?: number };
  try {
    found = await opts.db.tx(async (q) => {
      await q.query('SET TRANSACTION READ ONLY');
      if (!(await opts.ownership.confirm(q))) return { owned: false };
      const { rows } = await q.query<PublishedOutboxRow>(
        `SELECT id, name, payload, "correlationId", "eventVersion", "occurredAt", "publishedAt" FROM outbox WHERE id = $1`,
        [request.eventId],
      );
      const row = rows[0];
      if (!row || row.name !== request.eventName || row.publishedAt === null || row.eventVersion !== allowedVersion) return { owned: true, row };
      const facts: PublicationFacts = Object.freeze({ id: row.id, name: row.name, eventVersion: row.eventVersion, occurredAt: row.occurredAt, publishedAt: row.publishedAt });
      return { owned: true, row, pipelineVersion: await opts.evidence.pipelineVersionOf(q, facts) };
    });
  } catch {
    throw new ReemissionRefused('lookup_failed');
  }
  if (!found.owned) throw new ReemissionRefused('database_ownership_unconfirmed');
  const row = found.row;
  if (!row) throw new ReemissionRefused('row_missing');
  if (row.name !== request.eventName) throw new ReemissionRefused('row_name_mismatch');
  if (row.publishedAt === null) throw new ReemissionRefused('row_unpublished'); // the relay's own responsibility
  if (row.eventVersion !== allowedVersion) throw new ReemissionRefused('version_not_allowed');
  const v = found.pipelineVersion;
  if (v === undefined || !Number.isInteger(v) || v < 1) throw new ReemissionRefused('pipeline_unknown');
  if (!REEMISSION_COMPATIBLE_PIPELINES.includes(v)) throw new ReemissionRefused('pipeline_incompatible');
  return { row, pipelineVersion: v };
}

/**
 * Core V2 S1c-3 R2a: what a read-only eligibility inspection needs. No authorizer, attempt store or publisher: it can neither authorize
 * nor record nor publish anything.
 */
export type ReemissionEligibilityOptions = Pick<ProducerReemissionOptions, 'policy' | 'db' | 'ownership' | 'evidence'>;

/** The codes an inspection can answer with (a subset of `ReemissionRefusalCode`). */
export type ReemissionEligibilityRefusal = Extract<ReemissionRefusalCode,
  'request_invalid' | 'code_bearing_event' | 'event_not_allowed' | 'database_ownership_unconfirmed' | 'lookup_failed' | 'row_missing'
  | 'row_name_mismatch' | 'row_unpublished' | 'version_not_allowed' | 'pipeline_unknown' | 'pipeline_incompatible'>;

/**
 * The ROW's eligibility only: never an authorization, never a statement about consumers' provenance, never permission to publish. No
 * payload or correlation id is returned.
 */
export type ReemissionEligibility =
  | { rowEligible: false; reason: ReemissionEligibilityRefusal }
  | { rowEligible: true; eventId: string; eventName: string; eventVersion: number; pipelineVersion: number; occurredAt: string; publishedAt: string };

const INSPECTION_FIELDS = ['eventId', 'eventName'];

/**
 * Core V2 S1c-3 R2a: a read-only inspection of whether ONE outbox row would pass `reemit`'s own row checks (its steps 1, 2 and 4, through
 * the same `selectPublishedRow`). It takes exactly `{ eventId, eventName }`, issues no plan, writes nothing and reaches no broker.
 */
export async function inspectReemissionEligibility(opts: ReemissionEligibilityOptions, input: unknown): Promise<ReemissionEligibility> {
  const policy = reemissionPolicy(opts.policy.producer, opts.policy.events);
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return { rowEligible: false, reason: 'request_invalid' };
  const r = input as Record<string, unknown>;
  if (Reflect.ownKeys(r).length !== INSPECTION_FIELDS.length || !INSPECTION_FIELDS.every((k) => Object.hasOwn(r, k) && typeof r[k] === 'string')) return { rowEligible: false, reason: 'request_invalid' };
  const request = { eventId: r.eventId as string, eventName: r.eventName as string };
  if (!UUID.test(request.eventId) || !EVENT_NAME.test(request.eventName)) return { rowEligible: false, reason: 'request_invalid' };
  if (isCodeBearingEvent(request.eventName)) return { rowEligible: false, reason: 'code_bearing_event' };
  const allowed = policy.events.find((e) => e.name === request.eventName);
  if (!allowed) return { rowEligible: false, reason: 'event_not_allowed' };
  try {
    const { row, pipelineVersion } = await selectPublishedRow(opts, request, allowed.version);
    return { rowEligible: true, eventId: row.id, eventName: row.name, eventVersion: row.eventVersion, pipelineVersion, occurredAt: row.occurredAt.toISOString(), publishedAt: row.publishedAt.toISOString() };
  } catch (e) {
    if (e instanceof ReemissionRefused) return { rowEligible: false, reason: e.code as ReemissionEligibilityRefusal };
    throw e;
  }
}
