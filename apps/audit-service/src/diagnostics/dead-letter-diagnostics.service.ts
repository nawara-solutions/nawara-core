import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RateLimitService, canonicalJson, httpError } from '@nawara/service-kit';
import { AUDIT_CONFIG } from '../config/audit-config.token.js';
import type { AuditConfig } from '../config/audit-config.js';
import { AUDIT_MESSAGES } from '../messages.js';
import { badRequest, instant } from '../query/query-params.js';
import { QUERY_WINDOW_SECONDS } from '../query/query.service.js';
import { DeadLetterObservationRepository } from './dead-letter-observation.repository.js';
import type { DiagnosticPosition, StoredCoverageFact, StoredDeadLetterTransition } from './dead-letter-observation.types.js';

/** D43-4: at most 24 hours per request, at most 100 rows per page (default 50). */
export const DIAGNOSTIC_MAX_WINDOW_MS = 24 * 3_600_000;
export const DIAGNOSTIC_MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9._:-]{1,200}$/;
const LIMIT = /^[1-9]\d{0,2}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

type Resource = 'transitions' | 'coverage';
const FILTERS: Record<Resource, readonly string[]> = { transitions: ['consumer', 'eventId', 'attemptId'], coverage: ['instanceId'] };

export interface TransitionView {
  attemptId: string; transition: string; instanceId: string; consumer: string; eventId: string; eventName: string; source: string;
  failure: string; reason: string | null; errorClass: string; retryCount: number; replayCount: number; redelivered: boolean;
  observedAt: string; recordedAt: string;
}
export interface CoverageView {
  instanceId: string; kind: string; seq: number; consumers: string[]; observedTotal: number; persistedTotal: number; droppedOverflow: number;
  droppedSink: number; rejectedTotal: number; buffered: number; observedAt: string; recordedAt: string;
}
export interface DiagnosticPage<T> {
  items: T[];
  nextCursor: string | null;
  /** Always present: these rows are best-effort development diagnostics; an empty page never proves that no dead letter exists (D43-7). */
  notice: 'best_effort_development_diagnostics';
}

/**
 * Core V2 DO-43a (the Owner's D43-4; DEVELOPMENT AND SIMULATION DIAGNOSTICS ONLY): the header-only dead-letter observation read. A service
 * token (the kit guard, before this class), then `read_dead_letter_diagnostics` in `AUDIT_SERVICE_POLICY` (deny by default), then the
 * caller's rate limit. Oldest first, a 24-hour window at most, 100 rows per page at most, a cursor bound to the exact query. It returns
 * identifiers, codes, counters and times only: no audit record, payload, body, actor or tenant identifier exists in these tables to return.
 */
@Injectable()
export class DeadLetterDiagnosticsService {
  constructor(
    @Inject(DeadLetterObservationRepository) private readonly repo: DeadLetterObservationRepository,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(AUDIT_CONFIG) private readonly config: AuditConfig,
  ) {}

  async transitions(caller: string, rawQuery: unknown): Promise<DiagnosticPage<TransitionView>> {
    const q = await this.prepare(caller, 'transitions', rawQuery);
    const rows = await this.repo.transitions({
      from: q.from, to: q.to, limit: q.limit, after: q.after,
      ...(q.filters.consumer ? { consumer: q.filters.consumer } : {}), ...(q.filters.eventId ? { eventId: q.filters.eventId } : {}),
      ...(q.filters.attemptId ? { attemptId: q.filters.attemptId } : {}),
    });
    return this.page(rows, q, transitionView);
  }

  async coverage(caller: string, rawQuery: unknown): Promise<DiagnosticPage<CoverageView>> {
    const q = await this.prepare(caller, 'coverage', rawQuery);
    const rows = await this.repo.coverage({ from: q.from, to: q.to, limit: q.limit, after: q.after, ...(q.filters.instanceId ? { instanceId: q.filters.instanceId } : {}) });
    return this.page(rows, q, coverageView);
  }

  private async prepare(caller: string, resource: Resource, rawQuery: unknown) {
    if (!this.config.callerPolicy.allows(caller, 'read_dead_letter_diagnostics')) throw httpError(403, 'operation_not_allowed', AUDIT_MESSAGES.operationNotAllowed);
    const r = await this.limiter.hit('audit_query_dead_letter', caller, { limit: this.config.queryRates.platformPerCaller, windowSec: QUERY_WINDOW_SECONDS });
    if (!r.allowed) throw httpError(429, 'rate_limited', AUDIT_MESSAGES.tooManyRequests);
    return parseDiagnosticQuery(caller, resource, rawQuery);
  }

  private page<R extends { id: string; recordedAtUs: string }, V>(rows: R[], q: ParsedDiagnosticQuery, view: (r: R) => V): DiagnosticPage<V> {
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > q.limit && last ? encode({ recordedAtUs: last.recordedAtUs, id: last.id }, q.fingerprint) : null;
    return { items: items.map(view), nextCursor, notice: 'best_effort_development_diagnostics' };
  }
}

export interface ParsedDiagnosticQuery {
  from: Date; to: Date; limit: number; after?: DiagnosticPosition; filters: Record<string, string>; fingerprint: string;
}

/** Strict: unknown or repeated parameters, a malformed value, a window over 24 hours or a foreign cursor are a 400; nothing is echoed. */
export function parseDiagnosticQuery(caller: string, resource: Resource, input: unknown): ParsedDiagnosticQuery {
  if (typeof input !== 'object' || input === null) throw badRequest('invalid_query', AUDIT_MESSAGES.invalidQueryString);
  const allowed = new Set(['from', 'to', 'limit', 'cursor', ...FILTERS[resource]]);
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!allowed.has(k)) throw badRequest('invalid_query', AUDIT_MESSAGES.unknownParameter);
    if (typeof v !== 'string') throw badRequest('invalid_query', AUDIT_MESSAGES.givenOnce, { name: k });
    if (v === '' || v.length > 512) throw badRequest('invalid_query', AUDIT_MESSAGES.emptyOrTooLong, { name: k });
    raw[k] = v;
  }
  if (raw.from === undefined || raw.to === undefined) throw badRequest('invalid_query', AUDIT_MESSAGES.fromToRequired);
  const from = instant(raw.from, 'from');
  const to = instant(raw.to, 'to');
  if (to.getTime() <= from.getTime()) throw badRequest('invalid_query', AUDIT_MESSAGES.toAfterFrom);
  if (to.getTime() - from.getTime() > DIAGNOSTIC_MAX_WINDOW_MS) throw badRequest('window_too_large', AUDIT_MESSAGES.windowTooLargeHours, { hours: 24 });
  let limit = DEFAULT_LIMIT;
  if (raw.limit !== undefined) {
    if (!LIMIT.test(raw.limit) || Number(raw.limit) > DIAGNOSTIC_MAX_LIMIT) throw badRequest('invalid_query', AUDIT_MESSAGES.limitRange, { max: DIAGNOSTIC_MAX_LIMIT });
    limit = Number(raw.limit);
  }
  const filters: Record<string, string> = {};
  for (const name of FILTERS[resource]) {
    const v = raw[name];
    if (v === undefined) continue;
    const ok = name === 'attemptId' || name === 'instanceId' ? UUID.test(v) : TOKEN.test(v);
    if (!ok) throw badRequest('invalid_query', AUDIT_MESSAGES.diagnosticFilterInvalid, { name });
    filters[name] = v;
  }
  const fingerprint = createHash('sha256').update(canonicalJson({ caller, resource, from: from.toISOString(), to: to.toISOString(), limit, filters })).digest('hex').slice(0, 24);
  return { from, to, limit, filters, fingerprint, ...(raw.cursor !== undefined ? { after: decode(raw.cursor, fingerprint) } : {}) };
}

/** Not a secret and not a security boundary (every row in the window is readable by this caller): it only binds a page to its query. */
function encode(p: DiagnosticPosition, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ f: fingerprint, t: p.recordedAtUs, i: p.id })).toString('base64url');
}

function decode(raw: string, fingerprint: string): DiagnosticPosition {
  const bad = () => badRequest('invalid_cursor', AUDIT_MESSAGES.cursorInvalid);
  if (!CURSOR.test(raw)) throw bad();
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  const o = v as { f?: unknown; t?: unknown; i?: unknown };
  if (typeof v !== 'object' || v === null || Object.keys(v).length !== 3 || o.f !== fingerprint || typeof o.t !== 'string' || !/^\d{1,20}$/.test(o.t)
    || typeof o.i !== 'string' || !UUID.test(o.i)) throw bad();
  return { recordedAtUs: o.t, id: o.i };
}

const iso = (d: Date) => new Date(d).toISOString();

function transitionView(r: StoredDeadLetterTransition): TransitionView {
  return {
    attemptId: r.attemptId, transition: r.transition, instanceId: r.instanceId, consumer: r.consumer, eventId: r.eventId, eventName: r.eventName,
    source: r.source, failure: r.failure, reason: r.reason, errorClass: r.errorClass, retryCount: r.retryCount, replayCount: r.replayCount,
    redelivered: r.redelivered, observedAt: iso(r.observedAt), recordedAt: iso(r.recordedAt),
  };
}

function coverageView(r: StoredCoverageFact): CoverageView {
  return {
    instanceId: r.instanceId, kind: r.kind, seq: r.seq, consumers: [...r.consumers], observedTotal: r.observedTotal, persistedTotal: r.persistedTotal,
    droppedOverflow: r.droppedOverflow, droppedSink: r.droppedSink, rejectedTotal: r.rejectedTotal, buffered: r.buffered,
    observedAt: iso(r.observedAt), recordedAt: iso(r.recordedAt),
  };
}
