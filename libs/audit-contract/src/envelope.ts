import { catalogEntry } from './catalog.js';
import { SUPPORTED_AUDIT_VERSIONS, type AuditCategory, type AuditPayload } from './contract.js';
import { refuse } from './errors.js';
import { CORRELATION_ID, EVENT_TYPE_PREFIX, OCCURRED_AT, SERVICE_NAME, UUID, isExactUtcTimestamp } from './grammar.js';
import { validateAuditPayload } from './validate.js';

/** The kit `EventEnvelope` as a consumer receives it (typed loosely: everything in it is untrusted runtime data). */
export interface AuditEnvelopeInput {
  id: unknown;
  name: unknown;
  payload: unknown;
  headers: unknown;
}

/**
 * A received audit event that passed every contract rule, with everything audit-service stores: envelope facts (identity, source, time,
 * correlation, version), the catalog's category and the canonical payload. It is the only input of the 18.5 persistence mapping.
 */
export interface ValidatedAuditEvent {
  eventId: string;
  eventType: string;
  sourceService: string;
  category: AuditCategory;
  schemaVersion: number;
  /** The producer's business-transaction time, exactly as sent (ISO 8601 UTC). Never replaced by the receipt time. */
  occurredAt: string;
  correlationId: string | null;
  payload: AuditPayload;
}

/**
 * Consumer-side validation of one kit envelope carrying an audit event (the function 18.5's consumer calls; a refusal becomes a
 * `PermanentEventFailure` whose reason is the error code). The kit envelope itself is not redefined: its consumer-set headers
 * (`retryCount`, `replayCount`) are ignored; only the fields audit evidence depends on are checked, strictly.
 *
 * - `id` must be the lowercase UUID the producer's outbox assigned, and equal `headers.eventId`;
 * - `headers.source` is the emitting service (asserted until per-service broker identity, P-A1) and must own the action;
 * - `headers.version` must be a supported contract version (an unknown one is refused, never read as version 1);
 * - `name` must be exactly `audit.` + `payload.action`.
 */
export function validateAuditEvent(event: AuditEnvelopeInput): ValidatedAuditEvent {
  if (typeof event !== 'object' || event === null) refuse('invalid_envelope');
  const h = event.headers;
  if (typeof h !== 'object' || h === null || Array.isArray(h)) refuse('invalid_envelope');
  const headers = h as Record<string, unknown>;

  const id = event.id;
  if (typeof id !== 'string' || !UUID.test(id) || headers.eventId !== id) refuse('invalid_envelope');
  const source = headers.source;
  if (typeof source !== 'string' || !SERVICE_NAME.test(source)) refuse('invalid_envelope');
  const occurredAt = headers.occurredAt;
  if (typeof occurredAt !== 'string' || !isExactUtcTimestamp(occurredAt, OCCURRED_AT)) refuse('invalid_envelope');
  const version = headers.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || !SUPPORTED_AUDIT_VERSIONS.includes(version)) refuse('unsupported_version');
  const correlation = headers.correlationId;
  if (correlation !== undefined && correlation !== null && (typeof correlation !== 'string' || !CORRELATION_ID.test(correlation))) {
    refuse('invalid_correlation');
  }

  const name = event.name;
  if (typeof name !== 'string' || !name.startsWith(EVENT_TYPE_PREFIX)) refuse('event_type_mismatch');
  const payload = validateAuditPayload(event.payload, source);
  if (name !== `${EVENT_TYPE_PREFIX}${payload.action}`) refuse('event_type_mismatch');
  if (payload.causationId === id) refuse('invalid_causation');

  const entry = catalogEntry(payload.action)!;
  if (entry.since > version) refuse('unsupported_version');
  return Object.freeze({
    eventId: id,
    eventType: name,
    sourceService: source,
    category: entry.category,
    schemaVersion: version,
    occurredAt,
    correlationId: typeof correlation === 'string' ? correlation : null,
    payload,
  });
}
