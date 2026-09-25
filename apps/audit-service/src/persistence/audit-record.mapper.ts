import type { ValidatedAuditEvent } from '@nawara/audit-contract/consumer';
import type { NewAuditRecord } from './audit-record.types.js';

/**
 * THE one mapping from a validated audit event (the shared contract's `validateAuditEvent` output) to the repository's input (Stage 18.4;
 * 18.5's consumer calls `validateAuditEvent`, then this, then `AuditRecordRepository.insertOnce`). Pure and field-for-field: nothing is
 * derived, defaulted or rewritten here. Envelope facts (identity, source, version, time, correlation) come from the envelope; `category`
 * from the catalog; everything else from the canonical payload. `recordedAt` is not mapped: the database sets it.
 */
export function toNewAuditRecord(event: ValidatedAuditEvent): NewAuditRecord {
  const p = event.payload;
  return {
    eventId: event.eventId,
    sourceService: event.sourceService,
    action: p.action,
    category: event.category,
    schemaVersion: event.schemaVersion,
    actor: p.actor.type === 'user' ? { type: 'user', id: p.actor.id, userKind: p.actor.userKind } : { type: p.actor.type, id: p.actor.id },
    organizationId: p.organizationId,
    resource: { type: p.resource.type, id: p.resource.id },
    subject: p.subject ? { type: p.subject.type, id: p.subject.id } : null,
    outcome: p.outcome,
    changes: p.changes ? { ...p.changes } : null,
    correlationId: event.correlationId,
    causationId: p.causationId ?? null,
    occurredAt: event.occurredAt,
  };
}
