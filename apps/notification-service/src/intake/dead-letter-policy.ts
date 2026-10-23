import { isCanonicalJsonBody, type DeadLetterDecision, type DeadLetterInput, type EventEnvelope } from '@nawara/service-kit';
import { CODE_BEARING_EVENTS, mappingFor } from './event-map.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVICE = /^[a-z][a-z0-9-]{1,62}$/;
const OCCURRED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const CORRELATION = /^[A-Za-z0-9._:-]{8,128}$/;

/** The kit headers a Notification message is replayed with, each kept ONLY when it is a valid token (never a value that was not checked). */
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

/** Whether a member named `code` occurs anywhere in a parsed value (any depth, any container). */
function carriesCode(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(carriesCode);
  if (typeof v !== 'object' || v === null) return false;
  return Object.entries(v).some(([k, x]) => k === 'code' || carriesCode(x));
}

/**
 * Core V2 S1e-4 (ADR-0057 "S0-C6" Notification, ADR-0052 decision 5): what `notification.events.dead` may keep of a failed delivery.
 * Every path the kit dead-letters through applies it: a trust refusal (`untrusted_<basis>`), an intake refusal, a malformed message and
 * an exhausted retry. A one-time code (`member.contact_verification_requested`, `admin.operator_code_issued`,
 * `admin.operator_confirmation_code_issued`: the `code(...)` mappings of `EVENT_MAP`, which are exactly the Auth contract's `codeBearing`
 * events Notification consumes) never survives there, and neither does anything that could hide one:
 * - `original` only for a delivery of a MAPPED event that is not code-bearing, whose raw bytes are canonical JSON (so the parsed value
 *   shows every byte: no duplicate key, escape or invalid sequence can hide a value) and carry no member named `code` at any depth;
 *   such a copy stays replayable (`nawara-dlq replay`, through the strict consumer again);
 * - `redacted` otherwise: a code-bearing event, an unmapped or unknown name (whatever it claims to be), a malformed or non-canonical body,
 *   a missing body. The kit replaces the body with `{"redacted":true,"failure":…,"reason":…,"bodyBytes":n}` and marks the copy
 *   `x-nawara-body-redacted`; it is never replayed. No digest of the body is kept (a code is six digits: any hash of it is reversible).
 * Either way only the validated replay headers above survive; any other header a publisher attached is dropped.
 */
export function notificationDeadLetterPolicy({ event, body }: DeadLetterInput): DeadLetterDecision {
  return { body: mayKeepOriginal(event, body) ? 'original' : 'redacted', headers: safeHeaders(event) };
}

function mayKeepOriginal(event: EventEnvelope | undefined, body: Buffer | undefined): boolean {
  if (event === undefined || body === undefined || !isCanonicalJsonBody(body)) return false;
  const m = mappingFor(event.headers?.source, event.name);
  if (m === undefined || CODE_BEARING_EVENTS.has(m.name)) return false;
  // judged on the BYTES that would be kept (canonical, so their parsed value shows every byte), never on what a caller parsed
  return !carriesCode(JSON.parse(body.toString('utf8')));
}
