import { ACTOR_TYPES, AUDIT_OUTCOMES, USER_KINDS } from './contract.js';
import type { AuditEnvelopeInput } from './envelope.js';
import {
  CHANGE_KEY, CODE_VALUE, CORRELATION_ID, EVENT_NAME, EVENT_TYPE_PREFIX, MAX_ACTION_LENGTH, MAX_CHANGE_INTEGER, MAX_CHANGE_KEYS,
  MAX_PAYLOAD_BYTES, OCCURRED_AT, SERVICE_NAME, TIMESTAMP, TYPE_CODE, UUID,
} from './grammar.js';
import { TOP_LEVEL, plainRecord, scan } from './validate.js';

type Rec = Record<string, unknown>;

/** A contract version any future audit-service could conceivably accept (a header, not a payload; bounded so it stays a small token). */
const MAX_VERSION = 1000;

/**
 * Stage 18.8 (ADR-0049 A30 / A32, 18.5 finding F3): may a REFUSED audit event keep its body in the dead-letter queue?
 *
 * A refusal must not make audit-service a store of whatever an untrusted publisher sent. But a refusal that depends only on catalog
 * knowledge — an action or version this audit-service does not know yet, an actor or organization rule a catalog correction will widen
 * (A50: audit-service deploys first; a mis-ordered rollout is dead-lettered, then replayed) — must stay replayable, so its body is kept.
 *
 * This screen is CATALOG-INDEPENDENT and at least as strict as the validator on everything it looks at: the same sensitive-key and
 * secret-shape scan, the same depth and width bounds, only the canonical top-level fields, and every value a grammar token (UUID, code,
 * service name, timestamp, boolean, bounded integer). Such a body cannot carry free text, contact data, a secret or a nested blob,
 * whatever catalog later judges it. Anything else — a sensitive field or value, an unknown field, free text in an id, an array, a
 * malformed or non-JSON body — is not kept. It answers `true` for every event the validator accepts (a stored duplicate, a conflict, a
 * transient failure keep their evidence) and never throws.
 */
export function mayRetainRefusedAuditBody(event: AuditEnvelopeInput | undefined): boolean {
  try {
    return event !== undefined && envelopeIsTokens(event) && payloadIsTokens(event.payload);
  } catch {
    return false;
  }
}

function envelopeIsTokens(event: AuditEnvelopeInput): boolean {
  const h = plainRecord(event.headers);
  if (!h) return false;
  if (typeof event.id !== 'string' || !UUID.test(event.id) || h.eventId !== event.id) return false;
  if (typeof h.source !== 'string' || !SERVICE_NAME.test(h.source)) return false;
  if (typeof h.occurredAt !== 'string' || !OCCURRED_AT.test(h.occurredAt)) return false;
  if (!Number.isInteger(h.version) || (h.version as number) < 1 || (h.version as number) > MAX_VERSION) return false;
  const c = h.correlationId;
  if (c !== undefined && c !== null && (typeof c !== 'string' || !CORRELATION_ID.test(c))) return false;
  const name = event.name;
  return typeof name === 'string' && name.startsWith(EVENT_TYPE_PREFIX) && EVENT_NAME.test(name) && name.length <= EVENT_TYPE_PREFIX.length + MAX_ACTION_LENGTH;
}

const isUuid = (v: unknown): boolean => typeof v === 'string' && UUID.test(v);
const onlyKeys = (o: Rec, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));

function reference(v: unknown): boolean {
  const r = plainRecord(v);
  return !!r && onlyKeys(r, ['type', 'id']) && typeof r.type === 'string' && TYPE_CODE.test(r.type) && isUuid(r.id);
}

function actor(v: unknown): boolean {
  const a = plainRecord(v);
  if (!a || !onlyKeys(a, ['type', 'id', 'userKind'])) return false;
  if (typeof a.type !== 'string' || !(ACTOR_TYPES as readonly string[]).includes(a.type)) return false;
  if (typeof a.id !== 'string' || !(UUID.test(a.id) || SERVICE_NAME.test(a.id) || TYPE_CODE.test(a.id))) return false;
  return a.userKind === undefined || (typeof a.userKind === 'string' && (USER_KINDS as readonly string[]).includes(a.userKind));
}

function scalar(v: unknown): boolean {
  if (typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isSafeInteger(v) && Math.abs(v) <= MAX_CHANGE_INTEGER;
  return typeof v === 'string' && (CODE_VALUE.test(v) || UUID.test(v) || TIMESTAMP.test(v));
}

function changes(v: unknown): boolean {
  const c = plainRecord(v);
  if (!c) return false;
  const keys = Object.keys(c);
  if (keys.length === 0 || keys.length > MAX_CHANGE_KEYS) return false;
  return keys.every((k) => {
    if (!CHANGE_KEY.test(k)) return false;
    const t = plainRecord(c[k]);
    if (!t) return scalar(c[k]);
    return onlyKeys(t, ['from', 'to']) && Object.keys(t).length === 2 && scalar(t.from) && scalar(t.to);
  });
}

function payloadIsTokens(payload: unknown): boolean {
  const o = plainRecord(payload);
  if (!o) return false;
  scan(o, 0); // the validator's own sensitive-key / secret-shape / bound checks: a refusal throws, caught above as "not retained"
  if (!onlyKeys(o, [...TOP_LEVEL])) return false;
  if (typeof o.action !== 'string' || o.action.length > MAX_ACTION_LENGTH || !EVENT_NAME.test(o.action)) return false;
  if ('actor' in o && !actor(o.actor)) return false;
  if ('organizationId' in o && o.organizationId !== null && !isUuid(o.organizationId)) return false;
  if ('resource' in o && !reference(o.resource)) return false;
  if ('subject' in o && !reference(o.subject)) return false;
  if ('outcome' in o && !(typeof o.outcome === 'string' && (AUDIT_OUTCOMES as readonly string[]).includes(o.outcome))) return false;
  if ('changes' in o && !changes(o.changes)) return false;
  if ('causationId' in o && !isUuid(o.causationId)) return false;
  return JSON.stringify(o).length <= MAX_PAYLOAD_BYTES;
}
