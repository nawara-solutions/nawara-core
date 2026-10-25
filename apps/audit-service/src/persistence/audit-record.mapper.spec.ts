import { AUDIT_ACTIONS, AUDIT_CATALOG } from '@nawara/audit-contract';
import { validateAuditEvent } from '@nawara/audit-contract/consumer';
import { sampleAuditPayload } from '@nawara/audit-contract/testing';
import { toNewAuditRecord } from './audit-record.mapper.js';

const EVENT_ID = '0e8f6a4b-2c1d-4e3f-9a8b-7c6d5e4f3a21';

const envelopeOf = (action: (typeof AUDIT_ACTIONS)[number], variant: 'minimal' | 'complete') => ({
  id: EVENT_ID,
  name: `audit.${action}`,
  payload: JSON.parse(JSON.stringify(sampleAuditPayload(action, variant))),
  headers: { eventId: EVENT_ID, occurredAt: '2026-09-25T10:00:00.123Z', correlationId: 'corr-0001-abcd', source: AUDIT_CATALOG.get(action)!.producer, version: AUDIT_CATALOG.get(action)!.since },
});

describe('toNewAuditRecord (contract → persistence, the one mapping)', () => {
  it.each(AUDIT_ACTIONS.flatMap((a) => [[a, 'minimal'], [a, 'complete']] as const))('%s (%s) maps field for field, deriving nothing', (action, variant) => {
    const v = validateAuditEvent(envelopeOf(action, variant));
    const r = toNewAuditRecord(v);
    const p = v.payload;
    expect(r).toEqual({
      eventId: EVENT_ID,
      sourceService: AUDIT_CATALOG.get(action)!.producer,
      action,
      category: AUDIT_CATALOG.get(action)!.category,
      schemaVersion: AUDIT_CATALOG.get(action)!.since, // S2-Audit.2: 2 for the authorization receipts
      actor: p.actor,
      organizationId: p.organizationId,
      resource: p.resource,
      subject: p.subject ?? null,
      outcome: p.outcome,
      changes: p.changes ?? null,
      correlationId: 'corr-0001-abcd',
      causationId: p.causationId ?? null,
      occurredAt: '2026-09-25T10:00:00.123Z',
      // Core V2 S2-Audit.1/.2: the version-2 facts exactly as validated (none for a version-1 action); no trust decision, no assessment
      companyId: p.companyId ?? null, platformId: p.platformId ?? null, liveMode: null, delivery: null,
      approvedBy: p.approvedBy ? { id: p.approvedBy.id, userKind: p.approvedBy.userKind } : null,
    });
    expect(Object.keys(r)).not.toContain('recordedAt');
  });

  it('S2-Audit.1: a version-2 event maps liveMode as sent, and the delivery assessment exactly as given (never derived here)', () => {
    const e = envelopeOf('membership.revoked', 'complete');
    const v = validateAuditEvent({ ...e, headers: { ...(e.headers as object), version: 2 }, payload: { ...(e.payload as object), liveMode: false } });
    expect(toNewAuditRecord(v, { producerIdentityVerified: true, replayed: true })).toMatchObject({
      schemaVersion: 2, liveMode: false, companyId: null, platformId: null, delivery: { producerIdentityVerified: true, replayed: true },
    });
  });

  it('keeps a user actor\'s kind and never invents one for a service or system actor', () => {
    const user = toNewAuditRecord(validateAuditEvent(envelopeOf('membership.admin_granted', 'minimal')));
    expect(user.actor).toEqual({ type: 'user', id: expect.any(String), userKind: 'owner' });
    const system = toNewAuditRecord(validateAuditEvent(envelopeOf('payment.expired', 'minimal')));
    expect(system.actor).toEqual({ type: 'system', id: 'payment_expiry_sweep' });
    expect('userKind' in system.actor).toBe(false);
  });
});
