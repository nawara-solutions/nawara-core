import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  ACTOR_TYPES, AUDIT_CATEGORIES, AUDIT_OUTCOMES, CORE_PRODUCERS, catalogEntry, type AuditCategory, type AuditOutcome,
} from '@nawara/audit-contract';
import { canonicalJson, httpError, type MessageParams, type MessageTexts } from '@nawara/service-kit';
import { DEFAULT_LIMIT, MAX_LIMIT, MAX_WINDOW_MS, type CursorPosition, type QueryFilters, type QueryScope } from './query-model.js';
import { AUDIT_MESSAGES } from '../messages.js';

/** A 400 with a stable code; the message never echoes a request value. */
export function badRequest(code: string, message: string | MessageTexts, params?: MessageParams): HttpException {
  return httpError(400, code, message, params);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVICE_NAME = /^[a-z][a-z0-9-]{1,62}$/;
const TYPE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const CORRELATION = /^[A-Za-z0-9._:-]{8,128}$/;
/** UTC only, with an explicit `Z`, to the millisecond at most: no offset, no local time, no `infinity`, no `now`. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const LIMIT = /^[1-9]\d{0,2}$/;
const MAX_VALUE_LENGTH = 256;

const COMMON = ['from', 'to', 'limit', 'cursor', 'action', 'category', 'actorType', 'actorId', 'resourceType', 'resourceId', 'subjectType', 'subjectId',
  'sourceService', 'outcome', 'correlationId'] as const;
const PLATFORM_ONLY = ['organizationId', 'platform'] as const;

export interface ParsedQuery {
  filters: QueryFilters;
  window: { from: Date; to: Date };
  limit: number;
  cursor?: string;
  /** Platform route only: the narrowing the caller asked for. */
  target?: QueryScope & { kind: 'platform' };
}

function instant(value: string, name: string): Date {
  const d = new Date(value);
  if (!INSTANT.test(value) || Number.isNaN(d.getTime())) throw badRequest('invalid_query', AUDIT_MESSAGES.invalidInstant, { name });
  const normalized = value.length === 20 ? `${value.slice(0, 19)}.000Z` : value;
  if (d.toISOString() !== normalized) throw badRequest('invalid_query', AUDIT_MESSAGES.notRealInstant, { name }); // 2026-02-30 is refused, not rolled over
  return d;
}

function pair(raw: Record<string, string>, typeKey: string, idKey: string, typeOk: (t: string) => boolean, idOk: (t: string, id: string) => boolean): { type: string; id: string } | undefined {
  const t = raw[typeKey];
  const id = raw[idKey];
  if (t === undefined && id === undefined) return undefined;
  if (t === undefined || id === undefined) throw badRequest('invalid_query', AUDIT_MESSAGES.pairTogether, { typeKey, idKey });
  if (!typeOk(t) || !idOk(t, id)) throw badRequest('invalid_query', AUDIT_MESSAGES.pairInvalid, { typeKey, idKey });
  return { type: t, id };
}

/**
 * Parses the query string of an audit read, strictly. Every parameter is a closed grammar; an unknown parameter, a repeated one (an
 * array), an empty value or an over-long one is a 400 — nothing is coerced, trimmed, clamped or ignored. `from` and `to` are required
 * (A66): the half-open window `[from, to)` on `occurredAt`, at most 92 days (organization) or 31 days (platform, and the Stage 19.3 owner read).
 */
export function parseQuery(input: unknown, route: 'organization' | 'platform' | 'owner'): ParsedQuery {
  if (typeof input !== 'object' || input === null) throw badRequest('invalid_query', AUDIT_MESSAGES.invalidQueryString);
  const allowed = new Set<string>(route === 'platform' ? [...COMMON, ...PLATFORM_ONLY] : COMMON);
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!allowed.has(k)) throw badRequest('invalid_query', AUDIT_MESSAGES.unknownParameter);
    if (typeof v !== 'string') throw badRequest('invalid_query', AUDIT_MESSAGES.givenOnce, { name: k });
    if (v === '' || v.length > (k === 'cursor' ? 512 : MAX_VALUE_LENGTH)) throw badRequest('invalid_query', AUDIT_MESSAGES.emptyOrTooLong, { name: k });
    raw[k] = v;
  }

  if (raw.from === undefined || raw.to === undefined) throw badRequest('invalid_query', AUDIT_MESSAGES.fromToRequired);
  const from = instant(raw.from, 'from');
  const to = instant(raw.to, 'to');
  if (to.getTime() <= from.getTime()) throw badRequest('invalid_query', AUDIT_MESSAGES.toAfterFrom);
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS[route]) {
    throw badRequest('window_too_large', AUDIT_MESSAGES.windowTooLarge, { days: MAX_WINDOW_MS[route] / 86_400_000 });
  }

  let limit = DEFAULT_LIMIT;
  if (raw.limit !== undefined) {
    if (!LIMIT.test(raw.limit) || Number(raw.limit) > MAX_LIMIT) throw badRequest('invalid_query', AUDIT_MESSAGES.limitRange, { max: MAX_LIMIT });
    limit = Number(raw.limit);
  }

  const filters: QueryFilters = {};
  if (raw.action !== undefined) {
    if (!catalogEntry(raw.action)) throw badRequest('invalid_query', AUDIT_MESSAGES.actionNotCataloged);
    filters.action = raw.action;
  }
  if (raw.category !== undefined) {
    if (!(AUDIT_CATEGORIES as readonly string[]).includes(raw.category)) throw badRequest('invalid_query', AUDIT_MESSAGES.categoryInvalid);
    filters.category = raw.category as AuditCategory;
  }
  if (raw.outcome !== undefined) {
    if (!(AUDIT_OUTCOMES as readonly string[]).includes(raw.outcome)) throw badRequest('invalid_query', AUDIT_MESSAGES.outcomeInvalid);
    filters.outcome = raw.outcome as AuditOutcome;
  }
  if (raw.sourceService !== undefined) {
    if (!(CORE_PRODUCERS as readonly string[]).includes(raw.sourceService)) throw badRequest('invalid_query', AUDIT_MESSAGES.sourceNotCataloged);
    filters.sourceService = raw.sourceService;
  }
  if (raw.correlationId !== undefined) {
    if (!CORRELATION.test(raw.correlationId)) throw badRequest('invalid_query', AUDIT_MESSAGES.correlationInvalid);
    filters.correlationId = raw.correlationId;
  }
  const actor = pair(raw, 'actorType', 'actorId', (t) => (ACTOR_TYPES as readonly string[]).includes(t), (t, id) =>
    t === 'user' ? UUID.test(id) : t === 'service' ? SERVICE_NAME.test(id) : TYPE_CODE.test(id));
  if (actor) filters.actor = actor;
  const resource = pair(raw, 'resourceType', 'resourceId', (t) => TYPE_CODE.test(t), (_t, id) => UUID.test(id));
  if (resource) filters.resource = resource;
  const subject = pair(raw, 'subjectType', 'subjectId', (t) => TYPE_CODE.test(t), (_t, id) => UUID.test(id));
  if (subject) filters.subject = subject;

  const parsed: ParsedQuery = { filters, window: { from, to }, limit, ...(raw.cursor !== undefined ? { cursor: raw.cursor } : {}) };
  if (route === 'platform') {
    if (raw.organizationId !== undefined && raw.platform !== undefined) throw badRequest('invalid_query', AUDIT_MESSAGES.organizationPlatformExclusive);
    if (raw.platform !== undefined && raw.platform !== 'true') throw badRequest('invalid_query', AUDIT_MESSAGES.platformMustBeTrue);
    if (raw.organizationId !== undefined && !UUID.test(raw.organizationId)) throw badRequest('invalid_query', AUDIT_MESSAGES.organizationIdInvalid);
    parsed.target = raw.organizationId !== undefined ? { kind: 'platform', target: 'organization', organizationId: raw.organizationId }
      : raw.platform !== undefined ? { kind: 'platform', target: 'platform' } : { kind: 'platform', target: 'all' };
  }
  return parsed;
}

/** The organization of an organization-scope path, strictly (lowercase UUID; not a filter: the scope). */
export function parseOrganizationPath(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw badRequest('invalid_scope', AUDIT_MESSAGES.organizationIdInvalid);
  return value;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── cursor

const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const DIGITS = /^-?\d{1,20}$/;
const ID = /^[1-9]\d{0,18}$/;
const FINGERPRINT = /^[0-9a-f]{24}$/;

/**
 * The cursor binds a keyset position to the exact query it came from: `q` is a digest of the caller, the scope (with its organization),
 * every filter and the window. A cursor presented with any other caller, scope, organization, filter or window is refused
 * (`invalid_cursor`) — deterministic, not merely harmless. It is not signed: it carries no authority (the scope and the policy are
 * re-applied from the request's authorization on every page, A36), so tampering can at most move the position inside the caller's own
 * authorized result set.
 */
export function queryFingerprint(caller: string, scope: QueryScope, filters: QueryFilters, window: { from: Date; to: Date }): string {
  const shape = canonicalJson({ caller, scope, filters, from: window.from.toISOString(), to: window.to.toISOString() });
  return createHash('sha256').update(shape).digest('hex').slice(0, 24);
}

export function encodeCursor(position: CursorPosition, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ v: 1, t: position.occurredAtUs, i: position.id, q: fingerprint }), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string, fingerprint: string): CursorPosition {
  const bad = () => badRequest('invalid_cursor', AUDIT_MESSAGES.cursorInvalid);
  if (!CURSOR.test(raw)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw bad();
  const c = parsed as Record<string, unknown>;
  if (Object.keys(c).sort().join(',') !== 'i,q,t,v' || c.v !== 1) throw bad();
  if (typeof c.t !== 'string' || !DIGITS.test(c.t) || typeof c.i !== 'string' || !ID.test(c.i) || typeof c.q !== 'string' || !FINGERPRINT.test(c.q)) throw bad();
  if (c.q !== fingerprint) throw bad();
  return { occurredAtUs: c.t, id: c.i };
}
