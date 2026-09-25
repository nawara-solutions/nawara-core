import type { Queryable } from '@nawara/service-kit';
import { isStorageError } from '../storage/storage-error.js';
import type { StoragePort } from '../storage/storage.port.js';

export type ReconcileFinding =
  /** AVAILABLE, but the store has no object: an integrity incident (never a deletion): reported, the row untouched. */
  | 'object_missing'
  /** AVAILABLE, but the stored size contradicts the record: reported, the row untouched. */
  | 'size_mismatch'
  /** FAILED / REJECTED / DELETED, yet an object exists (a best-effort cleanup that did not happen): reported; removed with --repair. */
  | 'orphan_object'
  | 'orphan_object_removed'
  /** The store could not answer for this row (outage, permission): nothing decided. */
  | 'storage_unavailable';

export interface ReconcileOptions {
  repair: boolean;
  /** Rows examined at most in this run (bounded; resume with `after`). */
  limit: number;
  /** Resume after this file id (the previous run's `next_after`). */
  after?: string;
  batchSize?: number;
}

export interface ReconcileSummary {
  scanned: number;
  findings: Record<ReconcileFinding, number>;
  /** The id to resume from, or null when the end was reached. */
  next_after: string | null;
}

/**
 * Stage 17.7: the operator reconciliation tool of SDD §12 ("not a continuous scanner in V1"): one bounded, resumable pass over the rows
 * whose storage state is decided (AVAILABLE must have its object; FAILED / REJECTED / DELETED must not). UPLOADING and DELETING rows
 * belong to the workers. It never changes a row: a missing object is surfaced, never reclassified as a deletion. With `repair`, it only
 * deletes objects that must not exist, by their recorded key (no listing, no prefix, no bucket-wide operation).
 */
export async function reconcile(db: Queryable, storage: StoragePort, opts: ReconcileOptions, report: (line: Record<string, unknown>) => void): Promise<ReconcileSummary> {
  const findings: Record<ReconcileFinding, number> = { object_missing: 0, size_mismatch: 0, orphan_object: 0, orphan_object_removed: 0, storage_unavailable: 0 };
  const batch = Math.min(opts.batchSize ?? 200, opts.limit);
  let after = opts.after ?? '00000000-0000-0000-0000-000000000000';
  let scanned = 0;
  const note = (fileId: string, status: string, finding: ReconcileFinding) => {
    findings[finding] += 1;
    report({ fileId, status, finding }); // ids and states only: never a key, path, bucket or name
  };
  while (scanned < opts.limit) {
    const { rows } = await db.query<{ id: string; status: string; storageKey: string; sizeBytes: string | null }>(
      `SELECT id, status, "storageKey", "sizeBytes" FROM file
       WHERE id > $1 AND status IN ('AVAILABLE', 'FAILED', 'REJECTED', 'DELETED') ORDER BY id LIMIT $2`,
      [after, Math.min(batch, opts.limit - scanned)],
    );
    if (rows.length === 0) return { scanned, findings, next_after: null };
    for (const row of rows) {
      scanned += 1;
      after = row.id;
      let head: { sizeBytes: number } | undefined;
      try {
        head = await storage.head(row.storageKey, { signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        if (isStorageError(e)) note(row.id, row.status, 'storage_unavailable');
        else throw e;
        continue;
      }
      if (row.status === 'AVAILABLE') {
        if (!head) note(row.id, row.status, 'object_missing');
        else if (head.sizeBytes !== Number(row.sizeBytes)) note(row.id, row.status, 'size_mismatch');
      } else if (head) {
        if (!opts.repair) note(row.id, row.status, 'orphan_object');
        else {
          await storage.delete(row.storageKey, { signal: AbortSignal.timeout(30_000) });
          note(row.id, row.status, 'orphan_object_removed');
        }
      }
    }
  }
  return { scanned, findings, next_after: after };
}
