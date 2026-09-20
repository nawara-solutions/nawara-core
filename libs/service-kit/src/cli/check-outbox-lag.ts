#!/usr/bin/env node
import pg from 'pg';

/**
 * Operational outbox-lag check (Stage 5 hardening, completion pass): reports how many outbox rows are still
 * unpublished and how old the oldest one is, without touching outbox semantics — no retry, no delete, no republish.
 * A plain read against the same `outbox` table `OutboxRelay` already claims from (`WHERE "publishedAt" IS NULL`),
 * deliberately NOT a metrics platform, mirroring `nawara-check-dlq`'s shape: a runbook/cron-friendly read that exits
 * non-zero only when unpublished rows are older than the given threshold (a fresh, in-flight row is normal and must
 * not trip the check; only an accumulating, aging backlog should).
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

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query<{ pending: string; oldest_pending_seconds: number | null }>(
      `SELECT count(*)::bigint AS pending, EXTRACT(EPOCH FROM (now() - min("occurredAt")))::int AS oldest_pending_seconds
         FROM outbox WHERE "publishedAt" IS NULL`,
    );
    const pending = Number(rows[0]?.pending ?? 0);
    const oldestPendingSeconds = rows[0]?.oldest_pending_seconds ?? 0;
    console.log(`pending: ${pending}`);
    console.log(`oldest pending age: ${oldestPendingSeconds}s`);
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
