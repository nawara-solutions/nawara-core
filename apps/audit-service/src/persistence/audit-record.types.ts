import type { AuditCategory } from '../policy/categories.js';

/**
 * INTERNAL persistence types of audit-service (Stage 18.3). They mirror the `audit_record` columns and are NOT the producer-facing
 * audit contract: the canonical payload, its validation and the catalog are Stage 18.4 (a separate contract), and ingestion maps a
 * validated event onto `NewAuditRecord` (18.5). Nothing here is exported to another service.
 */
export type ActorType = 'user' | 'service' | 'system';
export type UserKind = 'member' | 'owner' | 'operator';
export type AuditOutcome = 'succeeded' | 'denied';

/** A change value: a string (1–64 safe characters), an integer within ±(2^53 − 1), a boolean, or null (never an object or array). */
export type ChangeScalar = string | number | boolean | null;
/** At most 8 keys; each a scalar or exactly `{ from, to }` of scalars; ≤ 1 024 bytes of canonical jsonb text (enforced by the schema). */
export type AuditChanges = Record<string, ChangeScalar | { from: ChangeScalar; to: ChangeScalar }>;

/** Everything a record holds that the caller supplies. `id` and `recordedAt` are Audit's own and cannot be supplied. */
export interface NewAuditRecord {
  eventId: string;
  sourceService: string;
  action: string;
  category: AuditCategory;
  schemaVersion: number;
  actor: { type: 'user'; id: string; userKind: UserKind } | { type: 'service' | 'system'; id: string };
  organizationId: string | null;
  resource: { type: string; id: string };
  subject?: { type: string; id: string } | null;
  outcome: AuditOutcome;
  changes?: AuditChanges | null;
  correlationId?: string | null;
  causationId?: string | null;
  /** The producer's time (ISO 8601 or a Date); stored as given, never compared with recordedAt here. */
  occurredAt: Date | string;
}

/** A stored record (every column; `id` is internal and never an external identity). */
export interface AuditRecordRow {
  id: string; // bigint: pg returns a string
  eventId: string;
  sourceService: string;
  action: string;
  category: AuditCategory;
  schemaVersion: number;
  actorType: ActorType;
  actorId: string;
  userKind: UserKind | null;
  organizationId: string | null;
  resourceType: string;
  resourceId: string;
  subjectType: string | null;
  subjectId: string | null;
  outcome: AuditOutcome;
  changes: AuditChanges | null;
  correlationId: string | null;
  causationId: string | null;
  occurredAt: Date;
  recordedAt: Date;
}

/**
 * The outcome of an idempotent insert (A15, A48): the first occurrence of (sourceService, eventId) is stored; a later one returns the
 * record already stored, unchanged, for the caller (18.5) to classify as an exact or a conflicting duplicate (`sameEvidence`).
 */
export type InsertOutcome = { kind: 'inserted'; record: AuditRecordRow } | { kind: 'duplicate'; existing: AuditRecordRow };
