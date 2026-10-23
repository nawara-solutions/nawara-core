import { describe, expect, it } from 'vitest';
import {
  COMPATIBILITY_QUEUES, InMemoryEventBus, PgKeyedProvenanceStore, PgProvenanceStore, TRUST_BASES, assertEnforceable, auditCompatibilityEnforcement, decideOriginal,
  decideReplayTrust, refusalReason, strictEnforcement, type ProvenanceAssessment, type ProvenanceFacts, type ReplayClassification,
} from '../src/index.js';
import { REASON_CODE } from '../src/events/dead-letter.js';

/**
 * Core V2 S1e-1 (ADR-0057 §13.4, §13.5, S0-C4, S0-C6): the trust decision itself, as pure functions, and the policy contract. The bus wiring
 * and the stores are proven against real RabbitMQ and PostgreSQL in rabbitmq-trust-enforcement.int-spec.ts.
 */
const STRICT = strictEnforcement({ refusedBody: 'original_reviewed' });
const COMPAT = auditCompatibilityEnforcement();
const EVENT_ID = '7d1c4f0a-2b3e-4c5d-8e6f-0a1b2c3d4e5f';
const facts = (over: Partial<ProvenanceFacts> = {}): ProvenanceFacts => ({
  source: 'payment-service', eventId: EVENT_ID, name: 'payment.succeeded', routingKey: 'payment.succeeded', exchange: 'nawara.events',
  producerUserId: 'payment-service', verified: true, reason: 'verified', ...over,
});
const unverifiedFacts = (reason: ProvenanceFacts['reason'], over: Partial<ProvenanceFacts> = {}) => facts({ verified: false, reason, ...over });
const assessed = (verified: ProvenanceAssessment['verified'], result: ProvenanceAssessment['result'] = 'recorded'): ProvenanceAssessment => ({ result, verified });
const HEADERS = { occurredAt: '2026-10-23T08:00:00.000Z', version: 1, correlationId: 'corr-abcdef12', source: 'payment-service' };
const matched = (verified: boolean): ReplayClassification => ({
  outcome: verified ? 'replay_matched_verified' : 'replay_matched_unverified', original: verified ? 'verified' : 'unverified',
  matched: { source: 'payment-service', eventId: EVENT_ID, name: 'payment.succeeded', routingKey: 'payment.succeeded', producerUserId: verified ? 'payment-service' : null },
});

describe('original deliveries: the stored VERIFIED observation decides (S0-C4)', () => {
  it('a verified original (first verified observation) is accepted, with its broker-checked identity and the authenticated metadata', () => {
    const d = decideOriginal(facts(), assessed('first'), STRICT, HEADERS);
    expect(d).toStrictEqual({
      decision: 'accept', basis: 'verified_original',
      origin: {
        from: 'verified_delivery', source: 'payment-service', eventId: EVENT_ID, name: 'payment.succeeded', routingKey: 'payment.succeeded', producerUserId: 'payment-service',
        occurredAt: { available: true, value: '2026-10-23T08:00:00.000Z', from: 'verified_delivery' },
        version: { available: true, value: 1, from: 'verified_delivery' },
        correlationId: { available: true, value: 'corr-abcdef12', from: 'verified_delivery' },
      },
    });
  });

  it('a verified duplicate (broker redelivery) is accepted for business idempotency', () => {
    expect(decideOriginal(facts(), assessed('matches', 'duplicate'), STRICT, HEADERS)).toMatchObject({ decision: 'accept', basis: 'verified_duplicate' });
  });

  it('a verified original AFTER an earlier unverified observation is accepted, though the aggregate record result is `conflict`', () => {
    expect(decideOriginal(facts(), assessed('first', 'conflict'), STRICT, HEADERS)).toMatchObject({ decision: 'accept', basis: 'verified_original' });
  });

  it('a verified original contradicting the stored verified observation is refused, whatever the aggregate result', () => {
    for (const result of ['conflict', 'duplicate', 'recorded'] as const) {
      expect(decideOriginal(facts(), assessed('contradicts', result), STRICT, HEADERS)).toStrictEqual({ decision: 'refuse', basis: 'verified_conflict' });
      expect(decideOriginal(facts(), assessed('contradicts', result), COMPAT, HEADERS)).toStrictEqual({ decision: 'refuse', basis: 'verified_conflict' });
    }
  });

  it('a stored verified observation under a retired key is never a match: refused', () => {
    expect(decideOriginal(facts(), assessed('unverifiable', 'unverifiable'), STRICT, HEADERS)).toStrictEqual({ decision: 'refuse', basis: 'verified_unverifiable' });
  });

  it.each([
    ['no user_id', unverifiedFacts('missing_user_id', { producerUserId: null })],
    ['another broker identity', unverifiedFacts('source_mismatch', { producerUserId: 'billing-service' })],
    ['a source header that is not the identity', unverifiedFacts('source_mismatch', { source: 'payment-service', producerUserId: 'notification-service' })],
    ['an event without a known owner', unverifiedFacts('unknown_event')],
    ['an identity that does not own the family', unverifiedFacts('not_family_owner')],
    ['a routing key that is not the name', unverifiedFacts('routing_key_mismatch')],
    ['an invalid event id', unverifiedFacts('invalid_event_id')],
  ])('an unverified original (%s) is refused under strict, accepted UNVERIFIED under Audit compatibility', (_t, f) => {
    expect(decideOriginal(f, assessed('not_applicable'), STRICT, HEADERS)).toStrictEqual({ decision: 'refuse', basis: 'unverified_original' });
    expect(decideOriginal(f, assessed('not_applicable'), COMPAT, HEADERS)).toStrictEqual({ decision: 'compatibility', basis: 'unverified_original', verified: false });
  });

  it('metadata absent from the verified delivery is reported absent, never invented', () => {
    const d = decideOriginal(facts(), assessed('first'), STRICT, { source: 'payment-service' });
    expect(d).toMatchObject({ origin: { occurredAt: { available: false, reason: 'absent' }, version: { available: false, reason: 'absent' }, correlationId: { available: false, reason: 'absent' } } });
  });
});

describe('default-exchange deliveries: only a match with the stored VERIFIED original is trusted (§13.4)', () => {
  it('a replay matching the stored verified original is accepted; its origin is the STORED row, and the envelope metadata is not_stored', () => {
    const d = decideReplayTrust(matched(true), STRICT);
    expect(d).toStrictEqual({
      decision: 'accept', basis: 'verified_replay',
      origin: {
        from: 'stored_verified_observation', source: 'payment-service', eventId: EVENT_ID, name: 'payment.succeeded', routingKey: 'payment.succeeded', producerUserId: 'payment-service',
        occurredAt: { available: false, reason: 'not_stored' }, version: { available: false, reason: 'not_stored' }, correlationId: { available: false, reason: 'not_stored' },
      },
    });
  });

  it.each([
    ['matching only an unverified original', matched(false), 'unverified_replay'],
    ['with no stored original', { outcome: 'replay_no_provenance', original: 'none' } as ReplayClassification, 'replay_no_provenance'],
  ] as const)('a replay %s is refused under strict; accepted UNVERIFIED under compatibility', (_t, c, basis) => {
    expect(decideReplayTrust(c, STRICT)).toStrictEqual({ decision: 'refuse', basis });
    expect(decideReplayTrust(c, COMPAT)).toStrictEqual({ decision: 'compatibility', basis, verified: false });
  });

  it.each([
    ['a different name or body', { outcome: 'replay_mismatch', original: 'verified' } as ReplayClassification, 'replay_mismatch'],
    ['under a retired key', { outcome: 'replay_unverifiable', original: 'verified' } as ReplayClassification, 'replay_unverifiable'],
    ['matched-verified without a stored identity', { ...matched(true), matched: { ...matched(true).matched!, producerUserId: null } }, 'replay_mismatch'],
    ['matched-verified without the matched row', { outcome: 'replay_matched_verified', original: 'verified' } as ReplayClassification, 'replay_mismatch'],
  ] as const)('a replay %s is refused under BOTH policies (a positive reason)', (_t, c, basis) => {
    expect(decideReplayTrust(c, STRICT)).toStrictEqual({ decision: 'refuse', basis });
    expect(decideReplayTrust(c, COMPAT)).toStrictEqual({ decision: 'refuse', basis });
  });

  it('a lookup failure or timeout is a hold under both policies, never a decision', () => {
    for (const c of [undefined, { outcome: 'replay_lookup_failure', original: 'none' } as ReplayClassification]) {
      expect(decideReplayTrust(c, STRICT)).toStrictEqual({ decision: 'hold', basis: 'provenance_unavailable' });
      expect(decideReplayTrust(c, COMPAT)).toStrictEqual({ decision: 'hold', basis: 'provenance_unavailable' });
    }
  });
});

describe('the policy contract', () => {
  const store = new PgProvenanceStore({ tx: async () => undefined as never });
  const sub = (over: Record<string, unknown> = {}) => ({ queue: 'billing.payment-events', provenance: { ownerOf: () => undefined, store }, enforcement: STRICT, ...over });

  it('only policies the kit issued are accepted; they are frozen (no fallback from strict)', () => {
    expect(() => assertEnforceable(sub())).not.toThrow();
    expect(() => assertEnforceable(sub({ enforcement: { mode: 'strict', refusedBody: 'original_reviewed' } }))).toThrow(/only a policy created by/);
    expect(() => assertEnforceable(sub({ enforcement: { mode: 'audit_compatibility' } }))).toThrow(/only a policy created by/);
    expect(Object.isFrozen(STRICT) && Object.isFrozen(COMPAT)).toBe(true);
    expect(() => strictEnforcement({ refusedBody: 'anything' as never })).toThrow();
  });

  it('compatibility is Audit\'s alone: any other queue (Billing\'s in particular) refuses it at subscribe', () => {
    expect(COMPATIBILITY_QUEUES).toStrictEqual(['audit-service.audit']);
    expect(() => assertEnforceable(sub({ enforcement: auditCompatibilityEnforcement() }))).toThrow(/compatibility phase is Audit's alone/);
    expect(() => assertEnforceable(sub({ queue: 'notification.events', enforcement: auditCompatibilityEnforcement() }))).toThrow(/Audit's alone/);
    expect(() => assertEnforceable(sub({ queue: 'audit-service.audit', enforcement: auditCompatibilityEnforcement() }))).not.toThrow();
  });

  it('enforcement needs provenance with an assessing, classifying store; a refusal relying on a dead-letter policy needs one', () => {
    expect(() => assertEnforceable(sub({ provenance: undefined }))).toThrow(/needs provenance/);
    expect(() => assertEnforceable(sub({ provenance: { ownerOf: () => undefined, store: { record: async () => 'recorded' } } }))).toThrow(/needs provenance/);
    const keyed = new PgKeyedProvenanceStore({ tx: async () => undefined as never }, { activeKeyId: 'k1', keys: new Map([['k1', Buffer.alloc(32, 1)]]), retiredKeyIds: new Set() });
    const redacting = strictEnforcement({ refusedBody: 'dead_letter_policy' });
    expect(() => assertEnforceable(sub({ queue: 'notification.events', provenance: { ownerOf: () => undefined, keyedStore: keyed }, enforcement: redacting }))).toThrow(/needs the subscription's deadLetterPolicy/);
    expect(() => assertEnforceable(sub({ queue: 'notification.events', provenance: { ownerOf: () => undefined, keyedStore: keyed }, enforcement: redacting, deadLetterPolicy: () => ({ body: 'redacted', headers: {} }) }))).not.toThrow();
  });

  it('a subscription without a policy is unchanged (nothing to assert)', () => {
    expect(() => assertEnforceable({ queue: 'audit-service.audit', provenance: { store: {} } })).not.toThrow();
  });

  it('the in-memory bus refuses an enforced subscription instead of running it unprotected', async () => {
    await expect(new InMemoryEventBus().subscribe({ queue: 'q', bindings: ['a.b'], handler: async () => undefined, enforcement: STRICT })).rejects.toThrow(/needs the RabbitMQ bus/);
  });

  it('every refusal reason is a valid, payload-free dead-letter code', () => {
    for (const b of TRUST_BASES) expect(refusalReason(b)).toMatch(REASON_CODE);
  });
});
