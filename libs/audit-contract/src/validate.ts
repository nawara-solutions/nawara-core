import { catalogEntry, type CatalogEntry, type ChangeSpec } from './catalog.js';
import { AUDIT_OUTCOMES, USER_KINDS, type AuditActor, type AuditPayload, type AuditReference, type ChangeScalar, type ChangeValue } from './contract.js';
import { refuse } from './errors.js';
import {
  CHANGE_KEY, CODE_VALUE, EVENT_NAME, MAX_ACTION_LENGTH, MAX_CHANGE_INTEGER, MAX_CHANGE_KEYS, MAX_CHANGES_JSONB_BYTES, MAX_PAYLOAD_BYTES,
  SERVICE_NAME, TIMESTAMP, TYPE_CODE, UUID, isExactUtcTimestamp,
} from './grammar.js';
import { isSecretShaped, isSensitiveKey } from './sensitive.js';

type Rec = Record<string, unknown>;

export const TOP_LEVEL = new Set(['action', 'actor', 'organizationId', 'resource', 'subject', 'outcome', 'changes', 'causationId']);
/**
 * No level of a valid payload has more than 8 keys. The layer-2 scan inspects up to twice that (so a credential-named key added to a
 * complete payload is still reported as `sensitive_field`); a wider object is refused before any per-key work.
 */
const MAX_KEYS_PER_OBJECT = 16;
const MAX_DEPTH = 3;

/**
 * A plain JSON object: an ordinary or null prototype, only enumerable own data properties, no symbols. A class instance, a Map, an
 * object whose prototype was replaced (`{ __proto__: … }` in a literal) or one with a getter (which could answer differently on each
 * read) is not data and is refused.
 */
export function plainRecord(v: unknown): Rec | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return null;
  if (Object.getOwnPropertySymbols(v).length > 0) return null;
  for (const d of Object.values(Object.getOwnPropertyDescriptors(v))) {
    if (!('value' in d) || !d.enumerable) return null;
  }
  return v as Rec;
}

function has(o: Rec, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/**
 * Layer 2 before any structural rule: every key at every level is checked against the sensitive-concept list, every string leaf against
 * the secret shapes, and every leaf against what JSON can carry. Depth and width are bounded first (no recursion or iteration bomb).
 */
export function scan(v: unknown, depth: number): void {
  switch (typeof v) {
    case 'string':
      if (isSecretShaped(v)) refuse('sensitive_value');
      return;
    case 'number':
      if (!Number.isFinite(v)) refuse('invalid_payload');
      return;
    case 'boolean':
      return;
    case 'object': {
      if (v === null) return;
      if (Array.isArray(v)) {
        if (v.length > MAX_KEYS_PER_OBJECT || depth >= MAX_DEPTH) refuse('invalid_payload');
        for (const item of v) scan(item, depth + 1);
        return;
      }
      const o = plainRecord(v);
      if (!o) refuse('invalid_payload');
      const keys = Object.keys(o);
      if (keys.length > MAX_KEYS_PER_OBJECT) refuse('unknown_field');
      for (const k of keys) if (isSensitiveKey(k)) refuse('sensitive_field');
      if (depth >= MAX_DEPTH && keys.length > 0) refuse('invalid_payload');
      for (const k of keys) scan(o[k], depth + 1);
      return;
    }
    default:
      // undefined, function, bigint, symbol: not JSON.
      refuse('invalid_payload');
  }
}

function onlyKeys(o: Rec, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) refuse('unknown_field');
}

function actorOf(v: unknown, entry: Readonly<CatalogEntry>): AuditActor {
  const a = plainRecord(v);
  if (!a) refuse('invalid_actor');
  const type = a.type;
  if (type === 'user') {
    onlyKeys(a, ['type', 'id', 'userKind']);
    const kinds = entry.actors.user;
    if (!kinds) refuse('invalid_actor');
    if (typeof a.id !== 'string' || !UUID.test(a.id)) refuse('invalid_actor');
    const kind = a.userKind;
    if (typeof kind !== 'string' || !(USER_KINDS as readonly string[]).includes(kind) || !(kinds as readonly string[]).includes(kind)) refuse('invalid_actor');
    return { type: 'user', id: a.id, userKind: kind as (typeof USER_KINDS)[number] };
  }
  if (type === 'service') {
    onlyKeys(a, ['type', 'id']);
    if (entry.actors.service !== true) refuse('invalid_actor');
    if (typeof a.id !== 'string' || !SERVICE_NAME.test(a.id)) refuse('invalid_actor');
    return { type: 'service', id: a.id };
  }
  if (type === 'system') {
    onlyKeys(a, ['type', 'id']);
    const processes = entry.actors.system;
    if (!processes || typeof a.id !== 'string' || !TYPE_CODE.test(a.id) || !processes.includes(a.id)) refuse('invalid_actor');
    return { type: 'system', id: a.id };
  }
  refuse('invalid_actor');
}

function referenceOf(v: unknown, types: readonly string[], code: 'invalid_resource' | 'invalid_subject'): AuditReference {
  const r = plainRecord(v);
  if (!r) refuse(code);
  onlyKeys(r, ['type', 'id']);
  if (typeof r.type !== 'string' || !TYPE_CODE.test(r.type) || !types.includes(r.type)) refuse(code);
  if (typeof r.id !== 'string' || !UUID.test(r.id)) refuse(code);
  return { type: r.type, id: r.id };
}

function organizationOf(o: Rec, entry: Readonly<CatalogEntry>, resource: AuditReference): string | null {
  // Present on purpose, even when null: platform scope is never the accidental result of a forgotten field.
  if (!has(o, 'organizationId')) refuse('invalid_organization');
  const org = o.organizationId;
  if (org !== null && (typeof org !== 'string' || !UUID.test(org))) refuse('invalid_organization');
  switch (entry.organization) {
    case 'required':
      if (org === null) refuse('invalid_organization');
      break;
    case 'none':
      if (org !== null) refuse('invalid_organization');
      break;
    case 'optional':
      break;
    case 'self':
      if (org !== resource.id) refuse('invalid_organization');
      break;
    case 'resource':
      if (org !== (resource.type === 'organization' ? resource.id : null)) refuse('invalid_organization');
      break;
  }
  return org;
}

function scalarOf(v: unknown, spec: ChangeSpec): ChangeScalar {
  switch (spec.type) {
    case 'code':
      if (typeof v !== 'string' || !CODE_VALUE.test(v) || !spec.values.includes(v)) refuse('invalid_changes');
      return v;
    case 'uuid':
      if (typeof v !== 'string' || !UUID.test(v)) refuse('invalid_changes');
      return v;
    case 'boolean':
      if (typeof v !== 'boolean') refuse('invalid_changes');
      return v;
    case 'integer':
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || Math.abs(v) > MAX_CHANGE_INTEGER || v < spec.min || v > spec.max) refuse('invalid_changes');
      return v;
    case 'timestamp':
      if (typeof v !== 'string' || !isExactUtcTimestamp(v, TIMESTAMP)) refuse('invalid_changes');
      return v;
  }
}

/**
 * The byte length PostgreSQL gives `changes::text` for this value (jsonb prints `{"k": v, "k2": v2}`: a space after each `:` and `,`).
 * Every string here is plain ASCII from the grammars, so nothing is escaped and characters are bytes. `audit_changes_valid` bounds this
 * length at 1 024; the contract applies the same bound so the database can never be the first to refuse.
 */
export function jsonbTextLength(v: unknown): number {
  if (typeof v === 'string') return v.length + 2;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).length;
  if (v === null) return 4;
  const entries = Object.entries(v as Rec);
  if (entries.length === 0) return 2;
  return 2 + entries.reduce((n, [k, x]) => n + k.length + 2 + 2 + jsonbTextLength(x), 0) + 2 * (entries.length - 1);
}

function changesOf(v: unknown, entry: Readonly<CatalogEntry>): Record<string, ChangeValue> | undefined {
  const specs = entry.changes;
  const declared = Object.keys(specs);
  if (v === undefined) {
    if (declared.some((k) => specs[k]!.required)) refuse('invalid_changes');
    return undefined;
  }
  const c = plainRecord(v);
  if (!c) refuse('invalid_changes');
  const keys = Object.keys(c);
  // Absent, never empty: `{}` carries nothing and the table refuses it.
  if (keys.length === 0 || keys.length > MAX_CHANGE_KEYS) refuse('invalid_changes');
  for (const k of keys) if (!CHANGE_KEY.test(k) || !declared.includes(k)) refuse('invalid_changes');
  const out: Record<string, ChangeValue> = {};
  for (const k of declared) {
    const spec = specs[k]!;
    if (!has(c, k)) {
      if (spec.required) refuse('invalid_changes');
      continue;
    }
    const raw = c[k];
    if (spec.shape === 'value') {
      out[k] = scalarOf(raw, spec);
      continue;
    }
    const t = plainRecord(raw);
    if (!t) refuse('invalid_changes');
    const tk = Object.keys(t);
    if (tk.length !== 2 || !has(t, 'from') || !has(t, 'to')) refuse('invalid_changes');
    const from = scalarOf(t.from, spec);
    const to = scalarOf(t.to, spec);
    if (from === to) refuse('invalid_changes'); // a transition that changes nothing is not a fact
    out[k] = { from, to };
  }
  if (jsonbTextLength(out) > MAX_CHANGES_JSONB_BYTES) refuse('invalid_changes');
  return out;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/**
 * THE audit validator (the single authority, A51 / this stage's §27): the producer helper calls it before writing the outbox row and
 * audit-service's ingestion calls it (through `validateAuditEvent`) before storing. It never repairs, trims, lowercases or coerces:
 * anything that is not exactly valid is refused with a stable code. On success it returns a NEW, deep-frozen canonical payload built
 * only from validated primitives (never the caller's object), in the canonical key order.
 *
 * `sourceService` is the emitting service as the caller's TRUSTED context knows it (the producer's configuration; the envelope `source`
 * on the consumer side), never a payload field.
 *
 * What it cannot prove (the producer's responsibility, ADR-0049 T2–T4): that the action really happened, that the actor was really
 * authorized, that `organizationId` really is the one recorded on the resource.
 */
export function validateAuditPayload(input: unknown, sourceService: string): AuditPayload {
  const o = plainRecord(input);
  if (!o) refuse('invalid_payload');
  scan(o, 0);
  for (const k of Object.keys(o)) if (!TOP_LEVEL.has(k)) refuse('unknown_field');

  const action = o.action;
  if (typeof action !== 'string' || action.length > MAX_ACTION_LENGTH || !EVENT_NAME.test(action)) refuse('unknown_action');
  const entry = catalogEntry(action);
  if (!entry) refuse('unknown_action');
  if (typeof sourceService !== 'string' || !SERVICE_NAME.test(sourceService) || entry.producer !== sourceService) refuse('producer_not_admitted');

  const actor = actorOf(o.actor, entry);
  const resource = referenceOf(o.resource, entry.resource, 'invalid_resource');
  const organizationId = organizationOf(o, entry, resource);

  let subject: AuditReference | undefined;
  if (has(o, 'subject')) {
    if (entry.subject.rule === 'forbidden') refuse('invalid_subject');
    subject = referenceOf(o.subject, [entry.subject.type], 'invalid_subject');
  } else if (entry.subject.rule === 'required') {
    refuse('invalid_subject');
  }

  const outcome = o.outcome;
  if (typeof outcome !== 'string' || !(AUDIT_OUTCOMES as readonly string[]).includes(outcome) || !(entry.outcomes as readonly string[]).includes(outcome)) {
    refuse('invalid_outcome');
  }

  const changes = has(o, 'changes') ? changesOf(o.changes ?? null, entry) : changesOf(undefined, entry);

  let causationId: string | undefined;
  if (has(o, 'causationId')) {
    if (typeof o.causationId !== 'string' || !UUID.test(o.causationId)) refuse('invalid_causation');
    causationId = o.causationId;
  }

  const payload: AuditPayload = {
    action,
    actor,
    organizationId,
    resource,
    ...(subject ? { subject } : {}),
    outcome: outcome as AuditPayload['outcome'],
    ...(changes ? { changes } : {}),
    ...(causationId ? { causationId } : {}),
  };
  // Every string in the canonical payload is ASCII (the grammars above), so its JSON length is its byte length.
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) refuse('payload_too_large');
  return deepFreeze(payload);
}
