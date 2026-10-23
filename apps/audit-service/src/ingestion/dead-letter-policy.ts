import { mayRetainRefusedAuditBody } from '@nawara/audit-contract/consumer';
import { isCanonicalJsonBody, type DeadLetterDecision, type DeadLetterInput, type EventEnvelope } from '@nawara/service-kit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVICE = /^[a-z][a-z0-9-]{1,62}$/;
const OCCURRED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const CORRELATION = /^[A-Za-z0-9._:-]{8,128}$/;

/** The kit headers an audit message is replayed with, each kept ONLY when it is a valid token (never a value that was not checked). */
function safeHeaders(event: EventEnvelope | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!event) return out;
  const h = event.headers;
  if (typeof event.id === 'string' && UUID.test(event.id)) out.eventId = event.id;
  if (typeof h?.source === 'string' && SERVICE.test(h.source)) out.source = h.source;
  if (typeof h?.occurredAt === 'string' && OCCURRED_AT.test(h.occurredAt)) out.occurredAt = h.occurredAt;
  if (Number.isInteger(h?.version) && h.version >= 1 && h.version <= 1000) out.version = h.version;
  if (typeof h?.correlationId === 'string' && CORRELATION.test(h.correlationId)) out.correlationId = h.correlationId;
  return out;
}

/**
 * Stage 18.8 (18.5 finding F3): what `audit-service.audit.dead` may keep of a failed delivery. The dead-letter queue must not become a
 * store of whatever an untrusted publisher sent — a message refused BECAUSE it carried a credential, contact data or free text must not
 * survive there verbatim — while evidence that a later audit-service could accept (a valid event whose insert failed, a conflict kept for
 * investigation, a refusal a catalog upgrade will reverse, ADR-0049 A50) stays replayable, byte for byte.
 *
 * - `original` when the contract's catalog-independent screen passes (every value a grammar token): the body is kept; only the replay
 *   headers above survive (any other header the publisher attached is dropped).
 * - `redacted` otherwise (malformed, non-JSON, a sensitive field or value, an unknown field, free text): the kit replaces the body with a
 *   `{"redacted":true,"failure":…,"reason":…,"bodyBytes":n}` document; the safe headers still say which claimed source, event id and
 *   correlation failed, when, and why (the kit annotations). No digest of the body is kept: an unkeyed hash of a short body (a phone
 *   number alone) could be reversed by trying the candidates.
 * - Core V2 S1b-2: `original` also needs the raw bytes to be canonical JSON (`isCanonicalJsonBody`), since the screen judges the PARSED
 *   value and a non-canonical body can carry bytes that value never shows (a duplicate key's dropped value, an invalid UTF-8 sequence).
 *   Without the bytes (a caller that does not pass them) the copy is redacted.
 */
export function auditDeadLetterPolicy({ event, body }: DeadLetterInput): DeadLetterDecision {
  const keep = body !== undefined && isCanonicalJsonBody(body) && mayRetainRefusedAuditBody(event);
  return { body: keep ? 'original' : 'redacted', headers: safeHeaders(event) };
}
