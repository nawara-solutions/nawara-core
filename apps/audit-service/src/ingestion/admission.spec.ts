import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_CATALOG, type AuditAction } from '@nawara/audit-contract';
import { sampleAuditPayload } from '@nawara/audit-contract/testing';
import type { EventEnvelope } from '@nawara/service-kit';
import { auditAdmission, auditEventOwner } from './admission.js';
import { BrokerNotices } from './broker-notices.js';
import { auditDeadLetterPolicy } from './dead-letter-policy.js';
import { IngestionCounters } from './ingestion-counters.js';
import { IngestionService } from './ingestion.service.js';

/** Core V2 S1b-2 (ADR-0057 §13.2 "Audit admission"): what may reach provenance and ingestion, and the trusted owner of each action. */
const envelope = (action: AuditAction, over: { payload?: Record<string, unknown>; source?: string; name?: string } = {}): EventEnvelope => {
  const id = randomUUID();
  return {
    id,
    name: over.name ?? `audit.${action}`,
    payload: over.payload ?? JSON.parse(JSON.stringify(sampleAuditPayload(action, 'complete'))),
    headers: { eventId: id, occurredAt: new Date().toISOString(), correlationId: `corr-${id.slice(0, 8)}`, source: over.source ?? AUDIT_CATALOG.get(action)!.producer, version: 1 },
  };
};
/** The bytes the kit publisher writes for an envelope's payload (canonical by construction). */
const bytes = (e: EventEnvelope) => Buffer.from(JSON.stringify(e.payload));
const PHONE = '+21620000009';

describe('auditEventOwner (trusted, from the audit catalog; never from a message)', () => {
  it('every cataloged action is owned by its catalog producer; audit-service\'s own action, unknown actions and other names by nobody', () => {
    for (const action of AUDIT_ACTIONS) {
      const producer = AUDIT_CATALOG.get(action)!.producer;
      expect(auditEventOwner(`audit.${action}`), action).toBe(producer === 'audit-service' ? undefined : producer);
    }
    expect(AUDIT_ACTIONS.some((a) => AUDIT_CATALOG.get(a)!.producer === 'audit-service')).toBe(true); // the exclusion is exercised
    for (const name of ['audit.payment.teleported', 'audit.', 'payment.succeeded', 'audit.constructor', 'audit.__proto__', 'audit.toString']) {
      expect(auditEventOwner(name), name).toBeUndefined();
    }
  });
});

describe('auditAdmission (canonical bytes → Stage 18.8 screen → full contract)', () => {
  it('admits every cataloged action as its producer publishes it', () => {
    for (const action of AUDIT_ACTIONS.filter((a) => AUDIT_CATALOG.get(a)!.producer !== 'audit-service')) {
      const e = envelope(action);
      expect(auditAdmission(e, bytes(e)), action).toEqual({ admitted: true });
    }
  });

  it('refuses non-canonical bytes first, whatever their parsed value: whitespace, a hidden duplicate key, invalid UTF-8, another spelling', () => {
    const e = envelope('payment.succeeded');
    const canonical = JSON.stringify(e.payload);
    const cases = [
      Buffer.from(JSON.stringify(e.payload, null, 2)),
      Buffer.from(`{"action":"${PHONE}",${canonical.slice(1)}`), // JSON.parse keeps the last `action`: the parsed value is valid, the bytes are not
      Buffer.concat([Buffer.from(canonical.slice(0, -1)), Buffer.from(',"x":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]),
      Buffer.from(canonical.replace('"action"', '"\\u0061ction"')),
    ];
    for (const body of cases) expect(auditAdmission(e, body)).toEqual({ admitted: false, reason: 'noncanonical_body' });
  });

  it('refuses what the Stage 18.8 screen refuses, with the contract\'s own reason (a contact field, a secret-shaped value, free text)', () => {
    const base = envelope('payment.succeeded').payload;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, phone: PHONE }, 'sensitive_field'],
      [{ ...base, changes: { verification_code: 730591 } }, 'sensitive_value'],
      [{ ...base, note: 'free text here' }, 'unknown_field'],
    ];
    for (const [payload, reason] of cases) {
      const e = envelope('payment.succeeded', { payload });
      const d = auditAdmission(e, bytes(e));
      expect(d.admitted).toBe(false);
      if (reason !== 'sensitive_value') expect(d).toEqual({ admitted: false, reason });
    }
  });

  it('refuses what only the full contract knows: a low-entropy value under an unknown change key, an unknown action, an asserted wrong producer, audit-service itself', () => {
    const base = envelope('payment.succeeded').payload;
    const lowEntropy = envelope('payment.succeeded', { payload: { ...base, changes: { pin_hint: 7305 } } });
    expect(auditAdmission(lowEntropy, bytes(lowEntropy)).admitted).toBe(false);
    const numeric = envelope('payment.succeeded', { payload: { ...base, changes: { verification: 730591 } } });
    expect(auditAdmission(numeric, bytes(numeric))).toEqual({ admitted: false, reason: 'invalid_changes' }); // passes the screen; only the contract refuses
    const unknown = envelope('payment.succeeded', { payload: { ...base, action: 'payment.teleported' }, name: 'audit.payment.teleported' });
    expect(auditAdmission(unknown, bytes(unknown))).toEqual({ admitted: false, reason: 'unknown_action' });
    const wrongProducer = envelope('payment.succeeded', { source: 'billing-service' });
    expect(auditAdmission(wrongProducer, bytes(wrongProducer))).toEqual({ admitted: false, reason: 'producer_not_admitted' });
    const self = AUDIT_ACTIONS.find((a) => AUDIT_CATALOG.get(a)!.producer === 'audit-service')!;
    const own = envelope(self);
    expect(auditAdmission(own, bytes(own))).toEqual({ admitted: false, reason: 'producer_not_admitted' });
  });
});

describe('IngestionService.admit (counted; fails closed)', () => {
  const service = () => {
    const counters = new IngestionCounters();
    return { counters, ingestion: new IngestionService({} as never, counters) };
  };

  it('counts a refusal like an ingestion refusal (received + refused, by reason) and an admission not at all', () => {
    const { counters, ingestion } = service();
    const ok = envelope('payment.succeeded');
    expect(ingestion.admit(ok, bytes(ok))).toEqual({ admitted: true });
    const bad = envelope('payment.succeeded', { payload: { ...ok.payload, phone: PHONE } });
    expect(ingestion.admit(bad, bytes(bad))).toEqual({ admitted: false, reason: 'sensitive_field' });
    const s = counters.drain();
    expect(s.counts).toMatchObject({ received: 1, refused: 1 });
    expect(s.refused).toEqual({ sensitive_field: 1 });
  });

  it('an exception inside the checks is a refusal, `admission_error` (never an admission, never a retry)', () => {
    const { counters, ingestion } = service();
    const e = envelope('payment.succeeded');
    const hostile = { ...e, headers: undefined } as unknown as EventEnvelope; // reading the headers throws inside the checks
    Object.defineProperty(hostile, 'headers', { get: () => { throw new TypeError('boom'); } });
    expect(ingestion.admit(hostile, bytes(e))).toEqual({ admitted: false, reason: 'admission_error' });
    expect(counters.drain().refused).toEqual({ admission_error: 1 });
  });
});

describe('auditDeadLetterPolicy (Stage 18.8, now judged on the raw bytes too)', () => {
  it('keeps the original only for canonical bytes that pass the screen; redacts a non-canonical body or one it is not given', () => {
    const e = envelope('payment.succeeded');
    expect(auditDeadLetterPolicy({ event: e, failure: 'retries_exhausted', body: bytes(e) }).body).toBe('original');
    expect(auditDeadLetterPolicy({ event: e, failure: 'permanent', reason: 'noncanonical_body', body: Buffer.from(`{"action":"${PHONE}",${JSON.stringify(e.payload).slice(1)}`) }).body).toBe('redacted');
    expect(auditDeadLetterPolicy({ event: e, failure: 'permanent', reason: 'admission_error' }).body).toBe('redacted');
    const sensitive = envelope('payment.succeeded', { payload: { ...e.payload, phone: PHONE } });
    expect(auditDeadLetterPolicy({ event: sensitive, failure: 'permanent', reason: 'sensitive_field', body: bytes(sensitive) }).body).toBe('redacted');
  });
});

describe('BrokerNotices (the operational signal of provenance)', () => {
  it('counts a provenance deferral (a held and requeued delivery) and conflict evidence by their stable names', () => {
    const notices = new BrokerNotices(0);
    notices.observe('event_provenance_deferred queue=audit-service.audit event=x delayMs=5000 error=Error — provenance could not be recorded', 'error');
    notices.observe('event_provenance_deferred queue=audit-service.audit event=y delayMs=5000 error=Error — provenance could not be recorded', 'error');
    notices.observe('event_provenance_conflict queue=audit-service.audit event=z verified=true reason=verified — differs', 'warn');
    expect(notices.drain().counts).toMatchObject({ provenance_deferred: 2, provenance_conflict: 1 });
  });
});
