import { DbService } from '@nawara/service-kit';
import { RETENTION_CATEGORIES, runRetention, type RetentionCategory } from './retention-core.js';

/**
 * `npm run retention -w audit-service -- [--dry-run] [--category <c>] [--batch-size N] [--max-batches N]` (Stage 18.8, ADR-0049 A41):
 * the operator / scheduler retention run. It connects ONLY through `RETENTION_DATABASE_URL` (the separate retention role; never the
 * runtime's `DATABASE_URL`) and refuses a role that can write audit records. Durations come only from `audit_retention_policy`; with no
 * policy row nothing is ever purged. Prints one JSON line per batch and a final summary (categories, counts: never a record's content);
 * exit 0 on success, 1 on any refusal or failure (committed batches stay done and ledgered; a rerun continues).
 */
/** A usage / configuration problem: fixed text of ours (never a value from the environment), safe to print. */
class UsageError extends Error {}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const int = (flag: string, dflt: number, max: number) => {
    const n = Number(value(flag) ?? dflt);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new UsageError(`${flag} must be an integer between 1 and ${max}`);
    return n;
  };
  const category = value('--category');
  if (category !== undefined && !(RETENTION_CATEGORIES as readonly string[]).includes(category)) throw new UsageError(`--category must be one of ${RETENTION_CATEGORIES.join(', ')}`);
  const url = process.env.RETENTION_DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) throw new UsageError('RETENTION_DATABASE_URL (the retention role) is required');
  const db = new DbService({ url, applicationName: 'audit-service-retention', max: 1, statementTimeoutMs: 60_000 });
  try {
    const summary = await runRetention(
      db,
      { dryRun: args.includes('--dry-run'), category: category as RetentionCategory | undefined, batchSize: int('--batch-size', 1000, 10_000), maxBatches: int('--max-batches', 100, 100_000) },
      (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
    );
    process.stdout.write(`${JSON.stringify({ summary })}\n`);
  } finally {
    await db.onApplicationShutdown();
  }
}

main().catch((e: unknown) => {
  // The message is ours (fixed text) or a database error name: never a connection string.
  const ours = e instanceof UsageError || (e instanceof Error && e.message.startsWith('retention refused'));
  process.stderr.write(`retention failed: ${ours ? (e as Error).message : e instanceof Error ? e.name : 'error'}\n`);
  process.exit(1);
});
