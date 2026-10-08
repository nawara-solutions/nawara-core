#!/usr/bin/env node
import pg from 'pg';
import { ConfigError, EnvReader } from '../config/config.js';
import {
  OUTBOX_RETENTION_BOUNDS, OUTBOX_RETENTION_VERIFIED_SERVICES, applyOutboxRetention, inspectOutboxRetention, isRetentionService, parseRetentionAge,
  retentionDatabaseOwner, type RetentionService,
} from '../events/outbox-retention.js';
import { describeCliFailure } from '../logging/cli-failure.js';
import { retentionDatabaseUrl } from './cli-config.js';

/**
 * V2 A3M.5 (ADR-0057 §10, Proposed; A3M record §14): manual retention of PUBLISHED outbox rows of ONE service database. Nothing
 * schedules it and no service runs it: an operator invokes it. It is a DRY RUN unless `--apply` is given, and there is no default age.
 *
 * Usage: DATABASE_URL=<url> nawara-outbox-retention --service <name> --database <name> --older-than <age> [--apply]
 *        [--batch-size N] [--max-batches N]      (or DATABASE_URL_FILE=<path>; an age is a whole number and a unit: 30d, 12h, 45m)
 *
 * - `--service` is required, dry run included, and must be one of `OUTBOX_RETENTION_VERIFIED_SERVICES`: every other service is refused
 *   before a connection is opened, and no option widens the list. The argument is an operator's statement, not an authenticated
 *   identity: what ties it to the data is the database check below.
 * - `--database` must be the name of the database the connection really opens, and that database must be OWNED by the role provisioned
 *   for the service (`<svc>_migrator`, ADR-0032): a mismatch is refused before anything is read. A database that was not provisioned
 *   that way is refused too (fail closed).
 * - Only rows that are published, older than the age and carry a RANDOM (version 4) id are eligible; unpublished rows and rows with any
 *   other id (a derived version 5 in particular) are never deleted and no option includes them (`src/events/outbox-retention.ts`).
 * - Output is counts only: never an event id, a name, a payload, an error text or a connection string.
 * - Exit codes: 0 done; 1 the run failed (nothing is retried; run it again); 2 refused arguments or configuration.
 */
interface Args {
  service: RetentionService;
  database: string;
  olderThan: string;
  olderThanMs: number;
  apply: boolean;
  batchSize: number;
  maxBatches: number;
}

const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function parseArgs(argv: string[]): Args {
  let service: string | undefined;
  let database: string | undefined;
  let olderThan: string | undefined;
  let apply = false;
  let batchSize = 500;
  let maxBatches = 20;
  const seen = new Set<string>();
  const integer = (flag: 'batchSize' | 'maxBatches', name: string, text: string | undefined): number => {
    const { min, max } = OUTBOX_RETENTION_BOUNDS[flag];
    const n = text !== undefined && /^[0-9]{1,6}$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (seen.has(a)) throw new ConfigError(`${a} is given more than once`);
    seen.add(a);
    if (a === '--apply') apply = true;
    else if (a === '--service') service = argv[++i];
    else if (a === '--database') database = argv[++i];
    else if (a === '--older-than') olderThan = argv[++i];
    else if (a === '--batch-size') batchSize = integer('batchSize', a, argv[++i]);
    else if (a === '--max-batches') maxBatches = integer('maxBatches', a, argv[++i]);
    else throw new ConfigError('unknown argument (usage: --service <name> --database <name> --older-than <age> [--apply] [--batch-size N] [--max-batches N])');
  }
  if (service === undefined) throw new ConfigError(`--service <name> is required (one of: ${OUTBOX_RETENTION_VERIFIED_SERVICES.join(', ')})`);
  if (!isRetentionService(service)) {
    throw new ConfigError(`--service is not a service verified for outbox retention (only: ${OUTBOX_RETENTION_VERIFIED_SERVICES.join(', ')}); nothing was opened`);
  }
  if (database === undefined) throw new ConfigError('--database <name> is required: name the database this run is for');
  if (!DATABASE_NAME.test(database)) throw new ConfigError('--database must be a database name (lowercase letters, digits and underscores)');
  if (olderThan === undefined) throw new ConfigError('--older-than <age> is required: there is no default retention age (for example 30d, 12h or 45m)');
  const olderThanMs = parseRetentionAge(olderThan);
  if (olderThanMs === undefined) throw new ConfigError('--older-than must be a whole number and a unit: d, h or m (for example 30d, 12h or 45m)');
  return { service, database, olderThan, olderThanMs, apply, batchSize, maxBatches };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2)); // every argument is validated before the configuration is read or a connection opened
  const url = retentionDatabaseUrl(new EnvReader(process.env));
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 60_000, query_timeout: 65_000 });
  try {
    const actual = (await pool.query<{ name: string; owner: string | null }>(
      'SELECT d.datname AS name, pg_get_userbyid(d.datdba) AS owner FROM pg_database d WHERE d.datname = current_database()',
    )).rows[0];
    if (actual?.name !== args.database) throw new ConfigError('--database does not name the database this connection opens: nothing was read or deleted');
    if (actual.owner !== retentionDatabaseOwner(args.service)) {
      throw new ConfigError('this database is not owned by the role provisioned for --service (<svc>_migrator, ADR-0032): nothing was read or deleted');
    }
    const mode = args.apply ? 'apply' : 'dry-run';
    const before = await inspectOutboxRetention(pool, args.olderThanMs);
    console.log(
      `outbox_retention mode=${mode} service=${args.service} database=${args.database} olderThan=${args.olderThan} eligible=${before.eligible} protectedDeterministic=${before.protectedDeterministic} ` +
        `retainedRecent=${before.retainedRecent} unpublished=${before.unpublished} oldestEligibleAgeSeconds=${before.oldestEligibleAgeSeconds ?? '-'}`,
    );
    if (!args.apply) {
      console.log('outbox_retention dry-run: nothing was deleted (pass --apply to delete the eligible rows)');
      return;
    }
    const result = await applyOutboxRetention(pool, { olderThanMs: args.olderThanMs, batchSize: args.batchSize, maxBatches: args.maxBatches });
    console.log(`outbox_retention applied deleted=${result.deleted} batches=${result.batches} more=${result.more}`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`outbox retention failed: ${describeCliFailure(e)}`); // never the error's own message unless it is a reviewed refusal
  process.exit(e instanceof ConfigError ? 2 : 1);
});
