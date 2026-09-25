import { ConfigError, type EnvReader } from '@nawara/service-kit';

/** Stage 17.7: the bounded cleanup workers (SDD §12). Technical correctness only: no legal retention period is chosen here (F23). */
export interface CleanupConfig {
  /** `FILE_CLEANUP_ENABLED` (default true): the workers run in this process (every replica may run them; claims are exclusive). */
  enabled: boolean;
  /** `FILE_CLEANUP_INTERVAL_MS` (default 30 s): the pause between two passes. */
  intervalMs: number;
  /** `FILE_CLEANUP_BATCH_SIZE` (default 20): rows claimed per BATCH of a storage-touching task (deletes, expiry, the lease sweep). */
  batchSize: number;
  /**
   * Stage 17.9: `FILE_CLEANUP_MAX_BATCHES_PER_PASS` (default 10, 1–100): a task repeats its batch while batches come back FULL, up to
   * this many per pass (drain mode, the Notification 16.9 rule). One batch per pass capped every task at batchSize / interval (measured:
   * 40 rows a minute at the defaults), below what issuance and deletes can produce, so backlogs could only grow.
   */
  maxBatchesPerPass: number;
  /** Stage 17.9: `FILE_CLEANUP_PURGE_BATCH_SIZE` (default 500, 1–5 000): rows per batch of the SQL-only purges (expired tickets, limiter windows). */
  purgeBatchSize: number;
  /** `FILE_DELETE_CONCURRENCY` (default 4): storage deletes running at once within a pass. */
  deleteConcurrency: number;
  /** `FILE_DELETE_LEASE_SECONDS` (default 300): how long a claimed deletion is reserved before another worker may take it over. */
  deleteLeaseSeconds: number;
  /** `FILE_DELETE_RETRY_BASE_SECONDS` / `_MAX_SECONDS` (30 s / 1 h): exponential backoff of a failed storage delete. */
  deleteRetryBaseSeconds: number;
  deleteRetryMaxSeconds: number;
  /** `FILE_TICKET_RETENTION_SECONDS` (default 24 h): expired ticket rows are removed this long after they expired. */
  ticketRetentionSeconds: number;
}

export function loadCleanupConfig(reader: EnvReader, storage: { requestTimeoutMs: number; maxAttempts?: number }): CleanupConfig {
  const c: CleanupConfig = {
    enabled: reader.bool('FILE_CLEANUP_ENABLED', true),
    intervalMs: reader.int('FILE_CLEANUP_INTERVAL_MS', { default: 30_000, min: 1_000, max: 3_600_000 }),
    batchSize: reader.int('FILE_CLEANUP_BATCH_SIZE', { default: 20, min: 1, max: 500 }),
    maxBatchesPerPass: reader.int('FILE_CLEANUP_MAX_BATCHES_PER_PASS', { default: 10, min: 1, max: 100 }),
    purgeBatchSize: reader.int('FILE_CLEANUP_PURGE_BATCH_SIZE', { default: 500, min: 1, max: 5_000 }),
    deleteConcurrency: reader.int('FILE_DELETE_CONCURRENCY', { default: 4, min: 1, max: 16 }),
    deleteLeaseSeconds: reader.int('FILE_DELETE_LEASE_SECONDS', { default: 300, min: 30, max: 3_600 }),
    deleteRetryBaseSeconds: reader.int('FILE_DELETE_RETRY_BASE_SECONDS', { default: 30, min: 1, max: 3_600 }),
    deleteRetryMaxSeconds: reader.int('FILE_DELETE_RETRY_MAX_SECONDS', { default: 3_600, min: 1, max: 86_400 }),
    ticketRetentionSeconds: reader.int('FILE_TICKET_RETENTION_SECONDS', { default: 86_400, min: 3_600, max: 2_592_000 }),
  };
  if (c.deleteRetryMaxSeconds < c.deleteRetryBaseSeconds) throw new ConfigError('FILE_DELETE_RETRY_MAX_SECONDS must be at least FILE_DELETE_RETRY_BASE_SECONDS');
  // A lease must outlast the batch it covers (every delete bounded by the storage request deadline and its attempts); otherwise a slow
  // but healthy pass would lose its claims to another replica. The fence would keep that harmless, but it is wasted work.
  const rounds = Math.ceil(c.batchSize / c.deleteConcurrency);
  const worstMs = rounds * storage.requestTimeoutMs * (storage.maxAttempts ?? 1);
  if (c.deleteLeaseSeconds * 1000 <= worstMs) {
    throw new ConfigError(`FILE_DELETE_LEASE_SECONDS must exceed one pass's worst case (${Math.ceil(worstMs / 1000)} s for this batch size, concurrency and storage deadline)`);
  }
  return c;
}

/** The delay before attempt `attempt + 1` of a failed storage delete: base × 2^(attempt-1), capped. Deterministic (no jitter needed:
 *  rows are rescheduled independently, and the claim spreads them by `deleteNextAttemptAt`). */
export function deleteRetryDelaySeconds(attempt: number, baseSeconds: number, maxSeconds: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  return Math.min(maxSeconds, baseSeconds * 2 ** exponent);
}
