import { fileURLToPath } from 'node:url';
import { ConfigError, DbService, EnvReader } from '@nawara/service-kit';
import { inspectPaymentReemission, paymentDatabaseOwnership } from '../reemission/reemission-eligibility.js';

/**
 * `npm run reemission:dry-run -w payment-service -- --event-id <uuid> --event-name <payment.succeeded|...>` (Core V2 S1c-3 R2a): a READ-ONLY
 * inspection of whether one of Payment's own published outbox rows would pass the re-emission row checks (ADR-0057 §13.7 "S0-C4"). It
 * connects only to Payment's database (`DATABASE_URL`, read through the kit's EnvReader), in one read-only transaction, and to nothing else:
 * no broker, no Audit, no Auth. It writes nothing and publishes nothing; there is no apply mode. Prints one JSON line (identifiers, bounded
 * codes and times; never a payload); exit 0 when the inspection completed (whatever it found), 2 on a usage error, 1 on a failure.
 */
class UsageError extends Error {}

const FLAGS = new Set(['--event-id', '--event-name']);

export function parseDryRunArgs(args: readonly string[]): { eventId: string; eventName: string } {
  const seen = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    if (!FLAGS.has(flag)) {
      // fixed text: the argument itself is never echoed
      throw new UsageError(flag === '--apply' || flag.startsWith('--apply=')
        ? 'there is no --apply: this command only inspects (re-emission is not available)'
        : 'only --event-id <uuid> and --event-name <name> are accepted (no payload, source, target or execution option)');
    }
    if (seen.has(flag) || args[i + 1] === undefined) throw new UsageError('--event-id and --event-name are each required exactly once');
    seen.set(flag, args[i + 1]!);
  }
  if (seen.size !== 2) throw new UsageError('--event-id and --event-name are each required exactly once');
  return { eventId: seen.get('--event-id')!, eventName: seen.get('--event-name')! };
}

async function main(): Promise<void> {
  const target = parseDryRunArgs(process.argv.slice(2));
  const url = new EnvReader(process.env).get('DATABASE_URL');
  if (!url || !/^postgres(ql)?:\/\//.test(url)) throw new UsageError('DATABASE_URL (Payment\'s own database) is required');
  const db = new DbService({ url, applicationName: 'payment-service-reemission-dry-run', max: 1 });
  try {
    const ownership = paymentDatabaseOwnership(fileURLToPath(new URL('../../db/migrations/', import.meta.url)));
    process.stdout.write(`${JSON.stringify(await inspectPaymentReemission({ db, ownership }, target))}\n`);
  } finally {
    await db.onApplicationShutdown();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    // Fixed text of ours (a ConfigError names the variable, never its value) or an error name: never a connection string or a value.
    const usage = e instanceof UsageError || e instanceof ConfigError;
    process.stderr.write(`reemission dry run failed: ${usage ? (e as Error).message : e instanceof Error ? e.name : 'error'}\n`);
    process.exit(usage ? 2 : 1);
  });
}
