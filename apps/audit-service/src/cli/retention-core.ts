import type { Queryable } from '@nawara/service-kit';

export const RETENTION_CATEGORIES = ['security', 'business', 'commercial', 'administrative'] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

export interface RetentionOptions {
  dryRun: boolean;
  /** Only this category (default: every category that has a policy). */
  category?: RetentionCategory;
  /** Rows per DELETE (one transaction each). */
  batchSize: number;
  /** Batches per category in this run (bounded; the next run continues). */
  maxBatches: number;
}

export interface CategoryReport {
  category: RetentionCategory;
  retainDays: number;
  /** dry run: rows past the horizon now; real run: rows deleted by this run. */
  rows: number;
  batches: number;
  /** true when this run stopped at maxBatches with rows possibly left (the next run continues). */
  truncated: boolean;
}

export interface RetentionReport {
  dryRun: boolean;
  /** Categories with NO policy are never purged (ADR-0049 A41 default until the owner decides, P-A2). */
  neverPurged: RetentionCategory[];
  categories: CategoryReport[];
}

/** A connection that can run the purge: a transaction for each batch (the kit's DbService). */
export interface RetentionDb extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

/**
 * Stage 18.8 (ADR-0049 A41): one bounded, resumable retention run, as the RETENTION role. Durations come only from
 * `audit_retention_policy` (owner-written; empty = never purge). Each batch is ONE transaction: `DELETE` of at most `batchSize` rows of
 * one category whose `recordedAt` is older than `now() − retainDays`, oldest first, plus its `audit_retention_run` ledger row; the
 * append-only trigger re-checks every row against the same policy (a policy tightened or removed meanwhile refuses the batch, which rolls
 * back whole). Rows inserted while it runs are newer than any cutoff and are never candidates. A crash leaves committed batches done and
 * ledgered; a rerun continues. A dry run only counts.
 */
export async function runRetention(db: RetentionDb, opts: RetentionOptions, report: (line: Record<string, unknown>) => void = () => undefined): Promise<RetentionReport> {
  await assertRetentionRole(db);
  const { rows: policies } = await db.query<{ category: RetentionCategory; retainDays: number }>(
    `SELECT category, "retainDays" FROM audit_retention_policy ORDER BY category`,
  );
  const withPolicy = new Set(policies.map((p) => p.category));
  const out: RetentionReport = { dryRun: opts.dryRun, neverPurged: RETENTION_CATEGORIES.filter((c) => !withPolicy.has(c)), categories: [] };
  for (const p of policies) {
    if (opts.category && p.category !== opts.category) continue;
    const r: CategoryReport = { category: p.category, retainDays: p.retainDays, rows: 0, batches: 0, truncated: false };
    if (opts.dryRun) {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_record WHERE category = $1 AND "recordedAt" < now() - make_interval(days => $2)`,
        [p.category, p.retainDays],
      );
      r.rows = Number(rows[0]!.n);
    } else {
      for (;;) {
        if (r.batches >= opts.maxBatches) {
          r.truncated = true;
          break;
        }
        const n = await db.tx(async (q) => {
          const del = await q.query(
            `WITH doomed AS MATERIALIZED (
               SELECT id FROM audit_record
                WHERE category = $1 AND "recordedAt" < now() - make_interval(days => $2)
                ORDER BY "recordedAt", id LIMIT $3)
             DELETE FROM audit_record a USING doomed WHERE a.id = doomed.id`,
            [p.category, p.retainDays, opts.batchSize],
          );
          const deleted = del.rowCount ?? 0;
          if (deleted > 0) {
            await q.query(
              `INSERT INTO audit_retention_run(category, "retainDays", cutoff, deleted) VALUES ($1, $2, now() - make_interval(days => $2), $3)`,
              [p.category, p.retainDays, deleted],
            );
          }
          return deleted;
        });
        if (n === 0) break;
        r.rows += n;
        r.batches += 1;
        report({ event: 'audit_retention_batch', category: p.category, deleted: n });
        if (n < opts.batchSize) break;
      }
    }
    out.categories.push(r);
  }
  return out;
}

/**
 * The retention path must never run with runtime authority: a role that can INSERT or UPDATE audit records is refused (the runtime, the
 * owner). Checked from the database's own privilege catalog, not from a role name.
 */
export async function assertRetentionRole(db: Queryable): Promise<void> {
  const { rows } = await db.query<{ writes: boolean; owns: boolean; deletes: boolean }>(
    `SELECT has_table_privilege(current_user, 'audit_record', 'INSERT') OR has_table_privilege(current_user, 'audit_record', 'UPDATE') AS writes,
            pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'audit_record'::regclass), 'USAGE') AS owns,
            has_table_privilege(current_user, 'audit_record', 'DELETE') AS deletes`,
  );
  const r = rows[0]!;
  if (r.writes || r.owns) throw new Error('retention refused: this database role can write audit records (use the separate retention role)');
  if (!r.deletes) throw new Error('retention refused: this database role holds no retention grant (audit_grant_retention)');
}
