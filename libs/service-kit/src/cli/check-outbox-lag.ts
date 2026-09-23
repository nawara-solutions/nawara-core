#!/usr/bin/env node
import pg from 'pg';
import { redactString } from '../logging/redact.js';

/**
 * Operational outbox-lag check (Stage 5 hardening, completion pass): reports how many outbox rows are still
 * unpublished and how old the oldest one is, without touching outbox semantics — no retry, no delete, no republish.
 * A plain read against the same `outbox` table `OutboxRelay` already claims from (`WHERE "publishedAt" IS NULL`),
 * deliberately NOT a metrics platform, mirroring `nawara-check-dlq`'s shape: a runbook/cron-friendly read that exits
 * non-zero only when unpublished rows are older than the given threshold (a fresh, in-flight row is normal and must
 * not trip the check; only an accumulating, aging backlog should).
 *
 * Stage 14.7: retries are unlimited (bounded backoff), so it also says whether the backlog is RETRYING: how many pending rows have
 * already failed a publish, the highest attempt count, and the oldest pending row's identity and last recorded error (the relay
 * stores only the error class and a redacted, truncated message there; never a payload). Exit codes are unchanged:
 * 0 = no pending row older than the threshold, 1 = threshold exceeded or the check itself failed.
 *
 * Usage: nawara-check-outbox-lag --database-url <url> [--max-age-seconds 60]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let url: string | undefined = process.env.DATABASE_URL;
  let maxAgeSeconds = 60;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--database-url' && args[i + 1]) url = args[++i];
    else if (args[i] === '--max-age-seconds' && args[i + 1]) maxAgeSeconds = Number(args[++i]);
    else throw new Error(`unknown argument: ${args[i]}`);
  }
  if (!url) throw new Error('--database-url (or DATABASE_URL) is required');
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) throw new Error('--max-age-seconds must be a non-negative number');

  // Bounded, so an unreachable or silent database fails the check (exit 1) instead of hanging a cron or runbook step (the client-side
  // query_timeout covers a server that accepts the query and then stops answering, Stage 15.2).
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 30_000, query_timeout: 35_000 });
  try {
    const { rows } = await pool.query<{ pending: string; oldest_pending_seconds: number | null; retrying: string; max_attempts: number | null }>(
      `SELECT count(*)::bigint AS pending, EXTRACT(EPOCH FROM (now() - min("occurredAt")))::int AS oldest_pending_seconds,
              count(*) FILTER (WHERE attempts > 0)::bigint AS retrying, max(attempts) AS max_attempts
         FROM outbox WHERE "publishedAt" IS NULL`,
    );
    const pending = Number(rows[0]?.pending ?? 0);
    const oldestPendingSeconds = rows[0]?.oldest_pending_seconds ?? 0;
    console.log(`pending: ${pending}`);
    console.log(`oldest pending age: ${oldestPendingSeconds}s`);
    console.log(`retrying: ${Number(rows[0]?.retrying ?? 0)}`);
    console.log(`max attempts: ${rows[0]?.max_attempts ?? 0}`);
    if (pending > 0) {
      const { rows: oldest } = await pool.query<{ id: string; name: string; attempts: number; lastError: string | null; availableAt: Date }>(
        `SELECT id, name, attempts, "lastError", "availableAt" FROM outbox WHERE "publishedAt" IS NULL ORDER BY "occurredAt", id LIMIT 1`,
      );
      const o = oldest[0];
      if (o) {
        console.log(`oldest pending event: id=${o.id} name=${o.name} attempts=${o.attempts} nextAttemptAt=${o.availableAt.toISOString()}`);
        console.log(`oldest pending last error: ${o.lastError ? redactString(o.lastError) : 'none (never attempted or no failure recorded)'}`);
      }
    }
    if (pending > 0 && oldestPendingSeconds > maxAgeSeconds) {
      console.error(`oldest pending outbox row is ${oldestPendingSeconds}s old (> ${maxAgeSeconds}s) — needs manual review`);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`outbox lag check failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  process.exit(1);
});
