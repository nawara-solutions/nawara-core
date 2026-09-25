import { Inject, Injectable } from '@nestjs/common';
import { DbService, canonicalJson, type Queryable } from '@nawara/service-kit';
import { AuditPersistenceError } from './persistence-error.js';
import type { AuthorizedAuditQuery } from '../query/query-model.js';
import type { AuditRecordRow, InsertOutcome, NewAuditRecord, PagedAuditRow } from './audit-record.types.js';

const COLUMNS = `id, "eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "userKind", "organizationId",
  "resourceType", "resourceId", "subjectType", "subjectId", outcome, changes, "correlationId", "causationId", "occurredAt", "recordedAt"`;

/** SQLSTATEs of a record the schema refuses: check / not-null violation, malformed uuid / timestamp / json, out-of-range number. */
const REFUSED = new Set(['23514', '23502', '22P02', '22007', '22008', '22003', '22023', '22P05', '2201X', '22021']);

/**
 * The ONLY reader and writer of `audit_record` (Stage 18.3). Append-only by construction: it can add a record once and read it back; it
 * has no update, delete, save, patch or upsert, and the database refuses them anyway (grants + triggers, migration 0001). Every
 * statement is parameterized; `id` and `recordedAt` are never taken from the caller. Every method accepts the caller's transaction
 * client, so the ingestion of Stage 18.5 can store a record in the same transaction as its own bookkeeping.
 *
 * Stage 18.6 adds ONE read primitive, `findPage`, which takes only an `AuthorizedAuditQuery` (scope and policy built by the server).
 */
@Injectable()
export class AuditRecordRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /**
   * Stores the record unless (sourceService, eventId) is already stored. One statement: `INSERT … ON CONFLICT DO NOTHING`, decided by
   * the unique constraint, so concurrent deliveries of one event produce exactly one row (no read-then-insert window). A duplicate
   * returns the stored record, unchanged. A record the schema refuses throws `AuditPersistenceError('invalid_record')` and stores
   * nothing.
   */
  async insertOnce(r: NewAuditRecord, q: Queryable = this.db): Promise<InsertOutcome> {
    // A Date, never a string handed to PostgreSQL: its timestamp input also accepts 'now', 'today', 'yesterday', 'epoch', 'infinity'.
    const occurredAt = new Date(r.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) throw new AuditPersistenceError('invalid_record');
    let rows: AuditRecordRow[];
    try {
      ({ rows } = await q.query<AuditRecordRow>(
        `INSERT INTO audit_record ("eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "userKind",
           "organizationId", "resourceType", "resourceId", "subjectType", "subjectId", outcome, changes, "correlationId", "causationId", "occurredAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18)
         ON CONFLICT ("sourceService", "eventId") DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          r.eventId, r.sourceService, r.action, r.category, r.schemaVersion, r.actor.type, r.actor.id,
          r.actor.type === 'user' ? r.actor.userKind : null, r.organizationId, r.resource.type, r.resource.id,
          r.subject?.type ?? null, r.subject?.id ?? null, r.outcome, r.changes == null ? null : JSON.stringify(r.changes),
          r.correlationId ?? null, r.causationId ?? null, occurredAt,
        ],
      ));
    } catch (e) {
      throw refused(e);
    }
    if (rows[0]) return { kind: 'inserted', record: rows[0] };
    const existing = await this.findBySourceAndEventId(r.sourceService, r.eventId, q);
    if (!existing) throw new Error('audit_record conflict without a stored row'); // unreachable: the conflict names an existing row
    return { kind: 'duplicate', existing };
  }

  /**
   * One keyset page (Stage 18.6), newest first: `ORDER BY "occurredAt" DESC, id DESC`, `LIMIT limit + 1` (one extra row = "there is a
   * next page"). Every predicate is a fixed SQL fragment with a bound parameter, and they are only ever joined with AND: the scope
   * (organization, or the platform target), the caller policy (categories, source services) and the time window are always present, so
   * a filter or a cursor can only narrow. `id` (internal) and the position in microseconds are returned for the cursor, never as evidence.
   */
  async findPage(query: AuthorizedAuditQuery, q: Queryable = this.db): Promise<PagedAuditRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const bind = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const s = query.scope;
    if (s.kind === 'organization' || s.target === 'organization') where.push(`"organizationId" = ${bind(s.organizationId)}::uuid`);
    else if (s.target === 'platform') where.push(`"organizationId" IS NULL`);
    where.push(`category = ANY(${bind(query.policy.categories)}::text[])`);
    if (query.policy.sourceServices) where.push(`"sourceService" = ANY(${bind(query.policy.sourceServices)}::text[])`);
    where.push(`"occurredAt" >= ${bind(query.window.from)}`, `"occurredAt" < ${bind(query.window.to)}`);
    const f = query.filters;
    if (f.action !== undefined) where.push(`action = ${bind(f.action)}`);
    if (f.category !== undefined) where.push(`category = ${bind(f.category)}`);
    if (f.sourceService !== undefined) where.push(`"sourceService" = ${bind(f.sourceService)}`);
    if (f.outcome !== undefined) where.push(`outcome = ${bind(f.outcome)}`);
    if (f.correlationId !== undefined) where.push(`"correlationId" = ${bind(f.correlationId)}`);
    if (f.actor) where.push(`"actorType" = ${bind(f.actor.type)}`, `"actorId" = ${bind(f.actor.id)}`);
    if (f.resource) where.push(`"resourceType" = ${bind(f.resource.type)}`, `"resourceId" = ${bind(f.resource.id)}`);
    if (f.subject) where.push(`"subjectType" = ${bind(f.subject.type)}`, `"subjectId" = ${bind(f.subject.id)}`);
    if (query.after) {
      where.push(`("occurredAt", id) < ('epoch'::timestamptz + ${bind(query.after.occurredAtUs)}::bigint * interval '1 microsecond', ${bind(query.after.id)}::bigint)`);
    }
    const sql = `SELECT ${COLUMNS}, (extract(epoch FROM "occurredAt") * 1000000)::bigint::text AS "occurredAtUs"
                   FROM audit_record WHERE ${where.join(' AND ')}
                  ORDER BY "occurredAt" DESC, id DESC LIMIT ${bind(query.limit + 1)}`;
    const { rows } = await q.query<PagedAuditRow>(sql, params);
    return rows;
  }

  /** The stored record of (sourceService, eventId), or undefined. Uses the unique constraint's index. */
  async findBySourceAndEventId(sourceService: string, eventId: string, q: Queryable = this.db): Promise<AuditRecordRow | undefined> {
    try {
      const { rows } = await q.query<AuditRecordRow>(`SELECT ${COLUMNS} FROM audit_record WHERE "sourceService" = $1 AND "eventId" = $2`, [sourceService, eventId]);
      return rows[0];
    } catch (e) {
      throw refused(e); // a malformed eventId is not a lookup key
    }
  }
}

/**
 * Whether a stored record carries exactly the evidence of `candidate` (the exact-vs-conflicting duplicate distinction of A15, for
 * Stage 18.5). Compares every caller-supplied field; `id` and `recordedAt` are Audit's own. Changes are compared canonically (key order
 * does not matter; jsonb already normalizes it).
 */
export function sameEvidence(stored: AuditRecordRow, candidate: NewAuditRecord): boolean {
  const userKind = candidate.actor.type === 'user' ? candidate.actor.userKind : null;
  return stored.eventId === candidate.eventId
    && stored.sourceService === candidate.sourceService
    && stored.action === candidate.action
    && stored.category === candidate.category
    && stored.schemaVersion === candidate.schemaVersion
    && stored.actorType === candidate.actor.type
    && stored.actorId === candidate.actor.id
    && stored.userKind === userKind
    && stored.organizationId === candidate.organizationId
    && stored.resourceType === candidate.resource.type
    && stored.resourceId === candidate.resource.id
    && stored.subjectType === (candidate.subject?.type ?? null)
    && stored.subjectId === (candidate.subject?.id ?? null)
    && stored.outcome === candidate.outcome
    && canonicalJson(stored.changes ?? null) === canonicalJson(candidate.changes ?? null)
    && stored.correlationId === (candidate.correlationId ?? null)
    && stored.causationId === (candidate.causationId ?? null)
    && stored.occurredAt.getTime() === new Date(candidate.occurredAt).getTime();
}

function refused(e: unknown): Error {
  const err = e as { code?: string; constraint?: string };
  if (typeof err?.code === 'string' && REFUSED.has(err.code)) return new AuditPersistenceError('invalid_record', err.constraint);
  return e instanceof Error ? e : new Error('audit_record statement failed');
}
