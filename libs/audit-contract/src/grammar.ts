/**
 * The value grammars of the audit contract. Each one is at least as strict as the Stage 18.3 `audit_record` CHECK it feeds, so a
 * payload this contract accepts can never be refused by the database (the persistence compatibility suite proves it per action).
 * All of them are ASCII: no Unicode confusable, bidirectional control or line break can pass.
 */

/** The kit event-name grammar (`libs/service-kit/src/events/types.ts` `EVENT_NAME`); a test proves the two stay identical. */
export const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** `audit_record.action` is at most 100 characters. */
export const MAX_ACTION_LENGTH = 100;
/** Every audit event type is `audit.<action>` (ADR-0049 A14). */
export const EVENT_TYPE_PREFIX = 'audit.';

/**
 * Canonical lowercase UUID. PostgreSQL's `uuid` type would silently lowercase an uppercase id; requiring the canonical form means the
 * stored value is exactly the value sent (the round trip never alters an identifier).
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A Core service name: the kit's `SERVICE_NAME` / service-token caller grammar, and `audit_record_source_shape`. */
export const SERVICE_NAME = /^[a-z][a-z0-9-]{1,62}$/;
/** A resource / subject type and a system-actor process code (`audit_record_resource_shape`, `audit_record_actor_consistent`). */
export const TYPE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** A change key (`audit_changes_valid`). */
export const CHANGE_KEY = /^[a-z][a-z0-9_]{0,31}$/;
/** A `code` change value: an enum-like lowercase identifier; `audit_change_scalar_valid` allows `[A-Za-z0-9._:+-]{1,64}`. */
export const CODE_VALUE = /^[a-z][a-z0-9_.]{0,63}$/;
/** A `timestamp` change value, UTC with millisecond precision (what `Date.prototype.toISOString` produces). */
export const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The kit correlation-id grammar (`request-context.ts` `SAFE_ID`) and `audit_record_correlation_shape`. */
export const CORRELATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;
/** An envelope `occurredAt` (the relay sends `toISOString()`; the fraction is optional for tolerance). */
export const OCCURRED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** `audit_change_scalar_valid`: integers within ±(2^53 − 1). */
export const MAX_CHANGE_INTEGER = Number.MAX_SAFE_INTEGER;
/** `audit_changes_valid`: at most 8 keys and 1 024 bytes of jsonb text. */
export const MAX_CHANGE_KEYS = 8;
export const MAX_CHANGES_JSONB_BYTES = 1024;
/** ADR-0049 A27: the whole canonical payload is at most 4 KiB (the kit outbox allows 64 KiB). */
export const MAX_PAYLOAD_BYTES = 4096;

/** A timestamp string that is also a real instant (`2026-02-30T…` is refused, not rolled over). */
export function isExactUtcTimestamp(value: string, grammar: RegExp): boolean {
  if (!grammar.test(value)) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  const normalized = value.length === 20 ? `${value.slice(0, 19)}.000Z` : value;
  return d.toISOString() === normalized;
}
