import type { ProvenanceAssessment, ProvenanceFacts, ReplayClassification } from './provenance.js';

/**
 * Core V2 S1e-1 (ADR-0057 §13.4, §13.5 and "S0-C6"): the consumer TRUST DECISION and the per-subscription enforcement policy. A
 * subscription with an `enforcement` policy has its business handler called only after an acceptable trust decision is durable; without one
 * the bus behaves exactly as before (observe-only provenance, S1b/S1c), so no existing consumer changes until it adopts a policy (S1e-2 to
 * S1e-4).
 *
 * Trust comes only from what the broker delivered and what the consumer stored: the broker-checked `user_id` of an ORIGINAL delivery
 * through the event exchange (§13.2), or, for a default-exchange delivery, a match with a stored VERIFIED original observation (§13.4). The
 * stored verified observation is authoritative (S0-C4): an earlier unverified observation never invalidates a verified delivery, and a
 * verified delivery that contradicts the stored verified one is refused. Headers such as `source` are lookup keys, never identity.
 */

/** Strict: only verified deliveries reach the handler. The ONLY policy a financial or notification consumer can have (S0-C6). */
export interface StrictEnforcement {
  readonly mode: 'strict';
  /**
   * How a refused delivery's dead-letter copy is protected. `dead_letter_policy`: the subscription must have a `deadLetterPolicy` (it
   * redacts what must not be kept, e.g. a code-bearing body). `original_reviewed`: the consumer's events were reviewed as carrying no
   * secret, so the original body may be kept (never for a consumer of code-bearing events; `npm run check:repo` enforces it).
   */
  readonly refusedBody: 'dead_letter_policy' | 'original_reviewed';
}

/**
 * Audit's TEMPORARY compatibility phase (S0-C6 H1): an admitted delivery that is merely unverified (no verified evidence for it, and no
 * evidence against it) still reaches the handler, marked unverified; nothing is promoted. Everything strict refuses for a POSITIVE reason
 * (a contradiction, a different body, a retired key) is still refused, and a lookup failure is still held. Only the queues in
 * `COMPATIBILITY_QUEUES` may use it, and only one created by `auditCompatibilityEnforcement()`.
 */
export interface AuditCompatibilityEnforcement {
  readonly mode: 'audit_compatibility';
}

export type EnforcementPolicy = StrictEnforcement | AuditCompatibilityEnforcement;

/** S0-C6: Audit alone may run the compatibility phase. */
export const COMPATIBILITY_QUEUES: readonly string[] = Object.freeze(['audit-service.audit']);

const issued = new WeakSet<object>();
const REFUSED_BODY = ['dead_letter_policy', 'original_reviewed'] as const;

/** A strict policy. No option makes it weaker later: it is frozen, and there is no switch between modes. */
export function strictEnforcement(options: { refusedBody: StrictEnforcement['refusedBody'] }): StrictEnforcement {
  if (!REFUSED_BODY.includes(options?.refusedBody)) throw new Error('strictEnforcement needs refusedBody: dead_letter_policy or original_reviewed');
  const policy = Object.freeze({ mode: 'strict' as const, refusedBody: options.refusedBody });
  issued.add(policy);
  return policy;
}

/** Audit's compatibility phase (S0-C6 H1). The subscription's queue must be on `COMPATIBILITY_QUEUES`. */
export function auditCompatibilityEnforcement(): AuditCompatibilityEnforcement {
  const policy = Object.freeze({ mode: 'audit_compatibility' as const });
  issued.add(policy);
  return policy;
}

/**
 * Refuses (throws) a subscription whose policy could not be enforced as declared: a policy object the kit did not issue, compatibility on
 * any other queue, no provenance or a store that cannot assess or classify, or a strict policy that relies on a dead-letter policy the
 * subscription does not have. A consumer then fails to start instead of running unprotected.
 */
export function assertEnforceable(sub: {
  queue: string;
  enforcement?: unknown;
  deadLetterPolicy?: unknown;
  provenance?: { store?: object; keyedStore?: object };
}): void {
  const p = sub.enforcement;
  if (p === undefined) return;
  if (typeof p !== 'object' || p === null || !issued.has(p)) throw new Error(`enforcement for ${sub.queue}: only a policy created by strictEnforcement() or auditCompatibilityEnforcement() is accepted`);
  const policy = p as EnforcementPolicy;
  if (policy.mode === 'audit_compatibility' && !COMPATIBILITY_QUEUES.includes(sub.queue)) throw new Error(`enforcement for ${sub.queue}: the compatibility phase is Audit's alone`);
  const store = sub.provenance?.keyedStore ?? sub.provenance?.store;
  if (!store || typeof (store as { assess?: unknown }).assess !== 'function' || typeof (store as { classifyReplay?: unknown }).classifyReplay !== 'function') {
    throw new Error(`enforcement for ${sub.queue}: needs provenance with a store that can assess deliveries and classify replays`);
  }
  if (policy.mode === 'strict' && policy.refusedBody === 'dead_letter_policy' && typeof sub.deadLetterPolicy !== 'function') {
    throw new Error(`enforcement for ${sub.queue}: refusedBody dead_letter_policy needs the subscription's deadLetterPolicy`);
  }
}

/** A value of the original publication, with where it came from; or why there is none (never a guess, never a replay's header). */
export type TrustedField<T> = { available: true; value: T; from: 'verified_delivery' } | { available: false; reason: 'not_stored' | 'absent' };

/**
 * The original publication a handler may rely on (S0-C6 H6). Identity fields come from the broker-checked delivery (an original) or from
 * the stored verified observation (a replay). The envelope metadata (`occurredAt`, `version`, `correlationId`) is not part of the stored
 * observation today: for a replay it is `not_stored`, and a consumer that needs it must refuse (Billing's stored tuple is S1e-2).
 */
export interface TrustedOrigin {
  from: 'verified_delivery' | 'stored_verified_observation';
  source: string;
  eventId: string;
  name: string;
  routingKey: string;
  producerUserId: string;
  occurredAt: TrustedField<string>;
  version: TrustedField<number>;
  correlationId: TrustedField<string>;
}

export const TRUST_BASES = [
  'verified_original',
  'verified_duplicate',
  'verified_replay',
  'unverified_original',
  'unverified_replay',
  'replay_no_provenance',
  'verified_conflict',
  'verified_unverifiable',
  'replay_mismatch',
  'replay_unverifiable',
  'unknown_path',
  'provenance_unavailable',
] as const;
export type TrustBasis = (typeof TRUST_BASES)[number];
export const TRUST_DECISIONS = ['accept', 'compatibility', 'refuse', 'hold'] as const;

export type TrustDecision =
  | { decision: 'accept'; basis: 'verified_original' | 'verified_duplicate' | 'verified_replay'; origin: TrustedOrigin }
  | { decision: 'compatibility'; basis: 'unverified_original' | 'unverified_replay' | 'replay_no_provenance'; verified: false }
  | { decision: 'refuse'; basis: Exclude<TrustBasis, 'verified_original' | 'verified_duplicate' | 'verified_replay' | 'provenance_unavailable'> }
  | { decision: 'hold'; basis: 'provenance_unavailable' };

/** What the handler of an enforced subscription is given: always one of these, never a refusal or a hold. */
export type HandlerTrust = Extract<TrustDecision, { decision: 'accept' | 'compatibility' }>;

const refuse = (basis: Extract<TrustDecision, { decision: 'refuse' }>['basis']): TrustDecision => ({ decision: 'refuse', basis });
const unverified = (policy: EnforcementPolicy, basis: 'unverified_original' | 'unverified_replay' | 'replay_no_provenance'): TrustDecision =>
  policy.mode === 'audit_compatibility' ? { decision: 'compatibility', basis, verified: false } : refuse(basis);

const field = <T>(value: T | undefined): TrustedField<T> => (value === undefined ? { available: false, reason: 'absent' } : { available: true, value, from: 'verified_delivery' });

/** The decision for an ORIGINAL delivery (through the event exchange), from its §13.2 facts and the store's assessment. */
export function decideOriginal(
  facts: ProvenanceFacts,
  assessment: ProvenanceAssessment,
  policy: EnforcementPolicy,
  headers: Record<string, unknown>,
): TrustDecision {
  if (!facts.verified) return unverified(policy, 'unverified_original');
  switch (assessment.verified) {
    case 'first':
    case 'matches': {
      const version = Number(headers.version);
      return {
        decision: 'accept',
        basis: assessment.verified === 'first' ? 'verified_original' : 'verified_duplicate',
        origin: {
          from: 'verified_delivery',
          source: facts.source,
          eventId: facts.eventId,
          name: facts.name,
          routingKey: facts.routingKey,
          producerUserId: facts.producerUserId!,
          occurredAt: field(typeof headers.occurredAt === 'string' ? headers.occurredAt : undefined),
          version: field(headers.version !== undefined && Number.isSafeInteger(version) ? version : undefined),
          correlationId: field(typeof headers.correlationId === 'string' ? headers.correlationId : undefined),
        },
      };
    }
    case 'contradicts':
      return refuse('verified_conflict');
    case 'unverifiable':
      return refuse('verified_unverifiable');
    default:
      return refuse('verified_conflict'); // a verified delivery always has verified evidence: anything else is not trusted
  }
}

/** The decision for a DEFAULT-EXCHANGE delivery, from its replay classification (`undefined` = the lookup failed or timed out). */
export function decideReplayTrust(classification: ReplayClassification | undefined, policy: EnforcementPolicy): TrustDecision {
  if (classification === undefined || classification.outcome === 'replay_lookup_failure') return { decision: 'hold', basis: 'provenance_unavailable' };
  switch (classification.outcome) {
    case 'replay_matched_verified': {
      const m = classification.matched;
      if (!m || m.producerUserId === null) return refuse('replay_mismatch'); // no stored identity to rely on: never trusted
      const notStored = { available: false, reason: 'not_stored' } as const;
      return {
        decision: 'accept',
        basis: 'verified_replay',
        origin: { from: 'stored_verified_observation', source: m.source, eventId: m.eventId, name: m.name, routingKey: m.routingKey, producerUserId: m.producerUserId, occurredAt: notStored, version: notStored, correlationId: notStored },
      };
    }
    case 'replay_matched_unverified':
      return unverified(policy, 'unverified_replay');
    case 'replay_no_provenance':
      return unverified(policy, 'replay_no_provenance');
    case 'replay_mismatch':
      return refuse('replay_mismatch');
    case 'replay_unverifiable':
      return refuse('replay_unverifiable');
    default:
      return refuse('replay_mismatch');
  }
}

/** The dead-letter reason of a refusal: `untrusted_<basis>` (a closed, payload-free code). */
export const refusalReason = (basis: TrustBasis): string => `untrusted_${basis}`;
