import { Inject, Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import type {
  DiagnosticPosition, NewCoverageFact, NewDeadLetterTransition, StoredCoverageFact, StoredDeadLetterTransition, TransitionWriteOutcome,
} from './dead-letter-observation.types.js';

/** SQLSTATEs of a row the schema refuses (a contradictory outcome, a re-labelled attempt, a malformed value): counted, never retried. */
const REFUSED = new Set(['23505', '23514', '23502', '22P02', '22007', '22008', '22003', '22023', '2202E']);

const TRANSITION_COLUMNS = `id, "attemptId", transition, "instanceId", consumer, "eventId", "eventName", source, failure, reason, "errorClass",
  "retryCount", "replayCount", redelivered, "observedAt", "recordedAt", (extract(epoch FROM "recordedAt") * 1000000)::bigint::text AS "recordedAtUs"`;
const COVERAGE_COLUMNS = `id, "instanceId", kind, seq::int AS seq, consumers, "observedTotal"::float8 AS "observedTotal", "persistedTotal"::float8 AS "persistedTotal",
  "droppedOverflow"::float8 AS "droppedOverflow", "droppedSink"::float8 AS "droppedSink", "rejectedTotal"::float8 AS "rejectedTotal", buffered,
  "observedAt", "recordedAt", (extract(epoch FROM "recordedAt") * 1000000)::bigint::text AS "recordedAtUs"`;

/**
 * Core V2 DO-43a (DEVELOPMENT AND SIMULATION DIAGNOSTICS ONLY): the only reader and writer of migration 0009's two append-only tables. It
 * can add a row and read rows back; it has no update or delete, and the database refuses them for every role anyway.
 *
 * Writes are best effort by design (D43-1): the caller is the background flusher, never the delivery path. A batch is written in one
 * transaction, each row under its own savepoint, so one refused row (a second outcome for an attempt, a re-labelled attempt) is counted
 * and the others are kept; a repeated identical row is idempotent. Any other error (the database unavailable) rejects the whole batch and
 * the caller counts it as lost.
 */
@Injectable()
export class DeadLetterObservationRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async insertTransitions(rows: readonly NewDeadLetterTransition[]): Promise<TransitionWriteOutcome> {
    const out: TransitionWriteOutcome = { stored: 0, duplicate: 0, rejected: 0 };
    if (rows.length === 0) return out;
    await this.db.tx(async (q) => {
      for (const r of rows) {
        await q.query('SAVEPOINT dead_letter_row');
        try {
          const res = await q.query(
            `INSERT INTO audit_dead_letter_transition ("attemptId", transition, "instanceId", consumer, "eventId", "eventName", source, failure, reason,
               "errorClass", "retryCount", "replayCount", redelivered, "observedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT ("attemptId", transition) DO NOTHING RETURNING id`,
            [r.attemptId, r.transition, r.instanceId, r.consumer, r.eventId, r.eventName, r.source, r.failure, r.reason, r.errorClass, r.retryCount,
              r.replayCount, r.redelivered, r.observedAt]);
          await q.query('RELEASE SAVEPOINT dead_letter_row');
          if ((res as { rowCount?: number | null }).rowCount === 1) out.stored++;
          else out.duplicate++;
        } catch (e) {
          await q.query('ROLLBACK TO SAVEPOINT dead_letter_row');
          if (!REFUSED.has((e as { code?: string }).code ?? '')) throw e;
          out.rejected++;
        }
      }
    });
    return out;
  }

  async insertCoverage(f: NewCoverageFact, q: Queryable = this.db): Promise<void> {
    await q.query(
      `INSERT INTO audit_dead_letter_coverage ("instanceId", kind, seq, consumers, "observedTotal", "persistedTotal", "droppedOverflow", "droppedSink",
         "rejectedTotal", buffered, "observedAt")
       VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9, $10, $11)`,
      [f.instanceId, f.kind, f.seq, [...f.consumers], f.observedTotal, f.persistedTotal, f.droppedOverflow, f.droppedSink, f.rejectedTotal, f.buffered, f.observedAt]);
  }

  /** Transitions recorded in [from, to), oldest first, keyset after `after`, at most `limit + 1` rows (the caller pages). */
  async transitions(o: { from: Date; to: Date; limit: number; after?: DiagnosticPosition; consumer?: string; eventId?: string; attemptId?: string }): Promise<StoredDeadLetterTransition[]> {
    const params: unknown[] = [o.from, o.to];
    const where = [`"recordedAt" >= $1`, `"recordedAt" < $2`];
    const bind = (v: unknown) => `$${params.push(v)}`;
    if (o.consumer !== undefined) where.push(`consumer = ${bind(o.consumer)}`);
    if (o.eventId !== undefined) where.push(`"eventId" = ${bind(o.eventId)}`);
    if (o.attemptId !== undefined) where.push(`"attemptId" = ${bind(o.attemptId)}::uuid`);
    if (o.after) where.push(`("recordedAt", id) > ('epoch'::timestamptz + ${bind(o.after.recordedAtUs)}::bigint * interval '1 microsecond', ${bind(o.after.id)}::uuid)`);
    const sql = `SELECT ${TRANSITION_COLUMNS} FROM audit_dead_letter_transition WHERE ${where.join(' AND ')} ORDER BY "recordedAt", id LIMIT ${bind(o.limit + 1)}`;
    return ((await this.db.query(sql, params)) as { rows: StoredDeadLetterTransition[] }).rows;
  }

  /** Coverage facts recorded in [from, to), oldest first, keyset after `after`, at most `limit + 1` rows. */
  async coverage(o: { from: Date; to: Date; limit: number; after?: DiagnosticPosition; instanceId?: string }): Promise<StoredCoverageFact[]> {
    const params: unknown[] = [o.from, o.to];
    const where = [`"recordedAt" >= $1`, `"recordedAt" < $2`];
    const bind = (v: unknown) => `$${params.push(v)}`;
    if (o.instanceId !== undefined) where.push(`"instanceId" = ${bind(o.instanceId)}::uuid`);
    if (o.after) where.push(`("recordedAt", id) > ('epoch'::timestamptz + ${bind(o.after.recordedAtUs)}::bigint * interval '1 microsecond', ${bind(o.after.id)}::uuid)`);
    const sql = `SELECT ${COVERAGE_COLUMNS} FROM audit_dead_letter_coverage WHERE ${where.join(' AND ')} ORDER BY "recordedAt", id LIMIT ${bind(o.limit + 1)}`;
    return ((await this.db.query(sql, params)) as { rows: StoredCoverageFact[] }).rows;
  }
}
