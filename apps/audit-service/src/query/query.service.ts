import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { catalogEntry } from '@nawara/audit-contract';
import { validateAuditEvent } from '@nawara/audit-contract/consumer';
import { DbService, RateLimitService, getRequestContext, type Queryable } from '@nawara/service-kit';
import { AUDIT_CONFIG } from '../config/audit-config.token.js';
import { SERVICE_NAME, type AuditConfig } from '../config/audit-config.js';
import { toNewAuditRecord } from '../persistence/audit-record.mapper.js';
import { AuditRecordRepository } from '../persistence/audit-record.repository.js';
import type { PagedAuditRow } from '../persistence/audit-record.types.js';
import type { CallerPolicy } from '../policy/caller-policy.js';
import { QueryCounters, type QueryScopeLabel } from './query-counters.js';
import type { AuthorizedAuditQuery, QueryScope } from './query-model.js';
import { decodeCursor, encodeCursor, parseOrganizationPath, parseQuery, queryFingerprint, type ParsedQuery } from './query-params.js';

/** One record as a reader receives it: evidence identifiers and codes only (no internal id, no display name, no enrichment). */
export interface AuditRecordView {
  eventId: string;
  occurredAt: string;
  recordedAt: string;
  action: string;
  category: string;
  sourceService: string;
  actor: { type: string; id: string; userKind?: string };
  organizationId: string | null;
  resource: { type: string; id: string };
  subject: { type: string; id: string } | null;
  outcome: string;
  changes: Record<string, unknown> | null;
  correlationId: string | null;
  causationId: string | null;
}

export interface AuditPage {
  items: AuditRecordView[];
  /** Opaque; bound to this exact query; null when there is no further page. */
  nextCursor: string | null;
}

/** The fixed rate-limit window (A66). */
export const QUERY_WINDOW_SECONDS = 60;
export const QUERY_LIMITER_BUCKETS = ['audit_query_org_caller', 'audit_query_org_pair', 'audit_query_platform_caller'] as const;
const PLATFORM_QUERY_ACTION = 'platform_query.executed';
const CORRELATION = /^[A-Za-z0-9._:-]{8,128}$/;
const DAY_MS = 86_400_000;

const forbidden = (code: string, message: string) => new HttpException({ message, code }, 403);

function view(r: PagedAuditRow): AuditRecordView {
  return {
    eventId: r.eventId,
    occurredAt: r.occurredAt.toISOString(),
    recordedAt: r.recordedAt.toISOString(),
    action: r.action,
    category: r.category,
    sourceService: r.sourceService,
    actor: r.actorType === 'user' ? { type: 'user', id: r.actorId, userKind: r.userKind ?? undefined } : { type: r.actorType, id: r.actorId },
    organizationId: r.organizationId,
    resource: { type: r.resourceType, id: r.resourceId },
    subject: r.subjectType !== null && r.subjectId !== null ? { type: r.subjectType, id: r.subjectId } : null,
    outcome: r.outcome,
    changes: r.changes as Record<string, unknown> | null,
    correlationId: r.correlationId,
    causationId: r.causationId,
  };
}

/**
 * Audit reads (Stage 18.6, ADR-0049 A35–A40, A57, A66). The order of every request is fixed:
 *
 *   authenticate (the kit guard, before this class) → authorize the operation (caller policy, deny by default) → rate limit (per caller;
 *   per caller and organization) → validate the scope, the filters, the window, the page size and the cursor → check the filters against
 *   the caller policy → build the `AuthorizedAuditQuery` (scope and policy from the server) → ONE parameterized query.
 *
 * Nothing reads `audit_record` before the caller is authorized and the request is valid.
 *
 * Organization scope: exactly the path's organization, never platform-level records. Platform scope (`read_platform` only; A38): every
 * organization and platform-level records, optionally narrowed to one organization or to platform-level records; each successful page is
 * RECORDED as `platform_query.executed` in the same transaction as the read (A57), and not returned if it cannot be recorded (fail
 * closed: `503 accountability_unavailable`). Capabilities are explicit, never hierarchical: `read_platform` does not imply
 * `read_organization` or the reverse.
 */
@Injectable()
export class AuditQueryService {
  private readonly log = new Logger('AuditQuery');

  constructor(
    @Inject(AuditRecordRepository) private readonly records: AuditRecordRepository,
    @Inject(DbService) private readonly db: DbService,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(QueryCounters) private readonly counters: QueryCounters,
    @Inject(AUDIT_CONFIG) private readonly config: AuditConfig,
  ) {}

  organization(caller: string, organizationParam: unknown, rawQuery: unknown): Promise<AuditPage> {
    return this.measured('organization', caller, async () => {
      const policy = this.authorize(caller, 'read_organization');
      const organizationId = parseOrganizationPath(organizationParam);
      await this.limit(caller, 'organization', organizationId);
      const parsed = parseQuery(rawQuery, 'organization');
      const query = this.authorized(caller, policy, { kind: 'organization', organizationId }, parsed);
      const rows = await this.records.findPage(query);
      return this.page(rows, query, caller);
    });
  }

  platform(caller: string, rawQuery: unknown): Promise<AuditPage> {
    return this.measured('platform', caller, async () => {
      const policy = this.authorize(caller, 'read_platform');
      await this.limit(caller, 'platform');
      const parsed = parseQuery(rawQuery, 'platform');
      const query = this.authorized(caller, policy, parsed.target!, parsed);
      // The read and its accountability record commit together; the response is built only after the commit (never across it).
      const rows = await this.db.tx(async (q) => {
        const found = await this.records.findPage(query, q);
        await this.recordPlatformQuery(q, caller, query, Math.min(found.length, query.limit), parsed.cursor !== undefined);
        return found;
      }).catch((e: unknown) => {
        if (e instanceof HttpException) throw e;
        this.log.error(`audit_platform_query_unrecorded caller=${caller} error=${e instanceof Error ? e.name : 'Error'} — no evidence returned (fail closed)`);
        throw new HttpException({ message: 'The query could not be recorded; no evidence is returned.', code: 'accountability_unavailable' }, 503);
      });
      return this.page(rows, query, caller);
    });
  }

  private authorize(caller: string, operation: 'read_organization' | 'read_platform'): CallerPolicy {
    const policy = this.config.callerPolicy.of(caller);
    if (!policy || !policy.operations.has(operation)) throw forbidden('operation_not_allowed', 'Operation not allowed for this caller.');
    return policy;
  }

  /** Per caller for each scope, and per (caller, organization) for the organization scope. Keys are hashed by the kit. */
  private async limit(caller: string, scope: QueryScopeLabel, organizationId?: string): Promise<void> {
    const r = this.config.queryRates;
    const hits = scope === 'platform'
      ? [this.limiter.hit('audit_query_platform_caller', caller, { limit: r.platformPerCaller, windowSec: QUERY_WINDOW_SECONDS })]
      : [
          this.limiter.hit('audit_query_org_caller', caller, { limit: r.perCaller, windowSec: QUERY_WINDOW_SECONDS }),
          this.limiter.hit('audit_query_org_pair', `${caller}|${organizationId}`, { limit: r.perOrganization, windowSec: QUERY_WINDOW_SECONDS }),
        ];
    const results = await Promise.all(hits);
    if (results.some((x) => !x.allowed)) throw new HttpException({ message: 'Too many requests.', code: 'rate_limited' }, 429);
  }

  /** The request's filters, checked against the caller policy, and the server-built scope and policy bounds. */
  private authorized(caller: string, policy: CallerPolicy, scope: QueryScope, parsed: ParsedQuery): AuthorizedAuditQuery {
    const f = parsed.filters;
    const categories = [...policy.categories];
    if (f.category !== undefined && !policy.categories.has(f.category)) throw forbidden('category_not_allowed', 'This caller may not read that category.');
    if (f.action !== undefined && !policy.categories.has(catalogEntry(f.action)!.category)) throw forbidden('category_not_allowed', 'This caller may not read that category.');
    const sources = policy.sourceServices ? [...policy.sourceServices] : undefined;
    if (f.sourceService !== undefined && sources && !sources.includes(f.sourceService)) throw forbidden('source_not_allowed', 'This caller may not read that source service.');
    const fingerprint = queryFingerprint(caller, scope, f, parsed.window);
    return {
      scope,
      policy: { categories, ...(sources ? { sourceServices: sources } : {}) },
      filters: f,
      window: parsed.window,
      limit: parsed.limit,
      ...(parsed.cursor !== undefined ? { after: decodeCursor(parsed.cursor, fingerprint) } : {}),
    };
  }

  private page(rows: PagedAuditRow[], query: AuthorizedAuditQuery, caller: string): AuditPage {
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > query.limit && last
      ? encodeCursor({ occurredAtUs: last.occurredAtUs, id: last.id }, queryFingerprint(caller, query.scope, query.filters, query.window))
      : null;
    return { items: items.map(view), nextCursor };
  }

  /**
   * `platform_query.executed` (A57): built as a canonical event and passed through the SAME shared validator and mapping as every ingested
   * event, then inserted directly (never over the bus, so there is no recursion and no dependency on the broker). Bounded facts only: which
   * target, how wide the window, how many records, which page, whether filters narrowed it — never a filter value or a returned record.
   */
  private async recordPlatformQuery(q: Queryable, caller: string, query: AuthorizedAuditQuery, count: number, nextPage: boolean): Promise<void> {
    const eventId = randomUUID();
    const { rows } = await q.query<{ now: Date }>('SELECT now()');
    const correlation = getRequestContext()?.correlationId;
    const target = query.scope.kind === 'platform' ? query.scope.target : 'organization';
    const filtered = Object.keys(query.filters).length > 0;
    const event = validateAuditEvent({
      id: eventId,
      name: `audit.${PLATFORM_QUERY_ACTION}`,
      payload: {
        action: PLATFORM_QUERY_ACTION,
        actor: { type: 'service', id: caller },
        organizationId: null,
        resource: { type: 'platform_query', id: eventId },
        outcome: 'succeeded',
        changes: {
          target,
          window_days: Math.min(31, Math.max(1, Math.ceil((query.window.to.getTime() - query.window.from.getTime()) / DAY_MS))),
          result_count: count,
          page: nextPage ? 'next' : 'first',
          filtered,
        },
      },
      headers: {
        eventId,
        occurredAt: rows[0]!.now.toISOString(),
        source: SERVICE_NAME,
        version: 1,
        ...(correlation && CORRELATION.test(correlation) ? { correlationId: correlation } : {}),
      },
    });
    const out = await this.records.insertOnce(toNewAuditRecord(event), q);
    if (out.kind !== 'inserted') throw new Error('platform query record not inserted'); // a fresh UUID: unreachable
  }

  private async measured(scope: QueryScopeLabel, caller: string, fn: () => Promise<AuditPage>): Promise<AuditPage> {
    const t0 = performance.now();
    try {
      const page = await fn();
      const ms = performance.now() - t0;
      this.counters.count(scope, 'ok');
      this.counters.success(page.items.length, ms);
      this.log.log(`audit_query scope=${scope} caller=${caller} outcome=ok items=${page.items.length} more=${page.nextCursor !== null} ms=${Math.round(ms)}`);
      return page;
    } catch (e) {
      const status = e instanceof HttpException ? e.getStatus() : 500;
      const outcome = status === 403 ? 'denied' : status === 400 ? 'invalid' : status === 429 ? 'rate_limited' : status === 503 ? 'unavailable' : 'error';
      this.counters.count(scope, outcome);
      const body = e instanceof HttpException ? (e.getResponse() as { code?: unknown }) : undefined;
      const code = typeof body?.code === 'string' ? body.code : body ? String(status) : 'unexpected';
      this.log.warn(`audit_query scope=${scope} caller=${caller} outcome=${outcome} code=${code} ms=${Math.round(performance.now() - t0)}`);
      throw e;
    }
  }
}

