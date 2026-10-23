import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertEnforceable, auditCompatibilityEnforcement, type EventEnvelope, type HandlerTrust } from '@nawara/service-kit';
import { BrokerNotices } from './broker-notices.js';
import { auditDeadLetterPolicy } from './dead-letter-policy.js';
import { AUDIT_QUEUE } from './ingestion.constants.js';
import { INGESTION_REFUSALS } from './ingestion-counters.js';
import { AUDIT_ENFORCEMENT_MODES, TRUST_REFUSALS, auditEnforcement, untrustedReason, type AuditEnforcementMode } from './trust-policy.js';

/** Core V2 S1e-3 (ADR-0057 "S0-C6" Audit): the two modes, the kit's gate on the compatibility phase, and the handler's own trust check. */
const store = { record: async () => 'recorded' as const, assess: async () => ({ result: 'recorded' as const, verified: 'first' as const }), classifyReplay: async () => ({ outcome: 'replay_no_provenance' as const, original: 'none' as const }) };
const spec = (queue: string, mode: AuditEnforcementMode, over: Record<string, unknown> = {}) => ({
  queue, deadLetterPolicy: auditDeadLetterPolicy, provenance: { ownerOf: () => 'payment-service', store }, enforcement: auditEnforcement(mode), ...over,
});

const event = (): EventEnvelope => {
  const id = randomUUID();
  return { id, name: 'audit.payment.succeeded', payload: {}, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } };
};
const field = { available: false, reason: 'not_stored' } as const;
const accepted = (e: EventEnvelope, over: Partial<{ eventId: string; source: string; name: string }> = {}): HandlerTrust => ({
  decision: 'accept', basis: 'verified_original',
  origin: { from: 'verified_delivery', source: e.headers.source, eventId: e.id, name: e.name, routingKey: e.name, producerUserId: e.headers.source, occurredAt: field, version: field, correlationId: field, ...over },
});
const compatibility: HandlerTrust = { decision: 'compatibility', basis: 'unverified_original', verified: false };

describe('Audit enforcement modes (S1e-3)', () => {
  it('two modes only: strict (redacting dead-letter policy) and the compatibility phase; each a new frozen kit policy; anything else throws', () => {
    expect(AUDIT_ENFORCEMENT_MODES).toEqual(['compatibility', 'strict']);
    const strict = auditEnforcement('strict');
    expect(strict).toEqual({ mode: 'strict', refusedBody: 'dead_letter_policy' });
    expect(Object.isFrozen(strict)).toBe(true);
    expect(auditEnforcement('compatibility')).toEqual({ mode: 'audit_compatibility' });
    expect(auditEnforcement('strict')).not.toBe(strict);
    for (const bad of ['observe', 'off', 'none', '', 'Strict', undefined]) expect(() => auditEnforcement(bad as AuditEnforcementMode), String(bad)).toThrow(/compatibility or strict/);
  });

  it('the kit accepts both on Audit\'s queue, with Audit\'s dead-letter policy', () => {
    expect(() => assertEnforceable(spec(AUDIT_QUEUE, 'strict'))).not.toThrow();
    expect(() => assertEnforceable(spec(AUDIT_QUEUE, 'compatibility'))).not.toThrow();
  });

  it('the compatibility phase is never available to Billing or Notification (or any queue but Audit\'s)', () => {
    for (const queue of ['billing.payment-events', 'notification.events', `${AUDIT_QUEUE}.retry`, 'audit-service.audit-copy']) {
      expect(() => assertEnforceable(spec(queue, 'compatibility')), queue).toThrow(/Audit's alone/);
      expect(() => assertEnforceable({ ...spec(queue, 'strict'), enforcement: auditCompatibilityEnforcement() }), queue).toThrow(/Audit's alone/);
    }
  });

  it('strict without the redacting policy, or without a store that can decide, is refused (the consumer never starts unprotected)', () => {
    expect(() => assertEnforceable(spec(AUDIT_QUEUE, 'strict', { deadLetterPolicy: undefined }))).toThrow(/deadLetterPolicy/);
    expect(() => assertEnforceable(spec(AUDIT_QUEUE, 'strict', { provenance: { ownerOf: () => undefined, store: { record: store.record } } }))).toThrow(/assess/);
    expect(() => assertEnforceable(spec(AUDIT_QUEUE, 'strict', { enforcement: { mode: 'strict', refusedBody: 'dead_letter_policy' } }))).toThrow(/only a policy created by/);
  });
});

describe('the handler\'s trust check (defence in depth behind the kit)', () => {
  it('strict: only an accepted decision for THIS event reaches ingestion', () => {
    const e = event();
    expect(untrustedReason('strict', e, accepted(e))).toBeUndefined();
    expect(untrustedReason('strict', e, { ...accepted(e), basis: 'verified_replay' } as HandlerTrust)).toBeUndefined();
    expect(untrustedReason('strict', e, undefined)).toBe('untrusted_no_decision');
    expect(untrustedReason('strict', e, compatibility)).toBe('untrusted_no_decision');
    expect(untrustedReason('strict', e, { decision: 'refuse', basis: 'unknown_path' } as unknown as HandlerTrust)).toBe('untrusted_no_decision');
    expect(untrustedReason('strict', e, accepted(e, { eventId: randomUUID() }))).toBe('untrusted_origin_mismatch');
    expect(untrustedReason('strict', e, accepted(e, { source: 'auth-service' }))).toBe('untrusted_origin_mismatch');
    expect(untrustedReason('strict', e, accepted(e, { name: 'audit.payment.failed' }))).toBe('untrusted_origin_mismatch');
  });

  it('compatibility: an accepted or an unverified (compatibility) decision is ingested; no decision never is', () => {
    const e = event();
    expect(untrustedReason('compatibility', e, accepted(e))).toBeUndefined();
    expect(untrustedReason('compatibility', e, compatibility)).toBeUndefined();
    expect(untrustedReason('compatibility', e, undefined)).toBe('untrusted_no_decision');
    expect(untrustedReason('compatibility', e, { decision: 'hold', basis: 'provenance_unavailable' } as unknown as HandlerTrust)).toBe('untrusted_no_decision');
    expect(untrustedReason('compatibility', e, accepted(e, { eventId: randomUUID() }))).toBe('untrusted_origin_mismatch');
  });

  it('its refusals are closed-set ingestion refusal labels', () => {
    for (const r of TRUST_REFUSALS) expect(INGESTION_REFUSALS).toContain(r);
  });
});

describe('BrokerNotices (the operational signal of trust decisions)', () => {
  it('counts holds, refusals and compatibility acceptances by their stable names, never by a value', () => {
    const notices = new BrokerNotices(0);
    notices.observe('event_trust_held queue=audit-service.audit event=a basis=provenance_unavailable delayMs=5000 — held', 'error');
    notices.observe('event_trust_refused queue=audit-service.audit event=b basis=unverified_original — refused before the handler (permanent)', 'error');
    notices.observe('event_trust_refused queue=audit-service.audit event=c basis=replay_mismatch — refused before the handler (permanent)', 'error');
    notices.observe('event_trust_compatibility queue=audit-service.audit event=d basis=unverified_original — accepted UNVERIFIED (compatibility phase)', 'info');
    const counts = notices.drain().counts;
    expect(counts).toMatchObject({ trust_held: 1, trust_refused: 2, trust_compatibility: 1 });
    expect(Object.keys(counts).some((k) => /unverified|replay|provenance_unavailable/.test(k))).toBe(false);
  });
});
