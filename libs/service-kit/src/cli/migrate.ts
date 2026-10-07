#!/usr/bin/env node
import { resolve } from 'node:path';
import { kitMigrationsDir } from '../db/paths.js';
import { runMigrations } from '../db/migrations.js';
import { ConfigError, EnvReader } from '../config/config.js';
import { migrationDatabaseUrl } from './cli-config.js';
import { describeCliFailure } from '../logging/cli-failure.js';

/**
 * Explicit migration step:  nawara-migrate --dir <path> [--dir <path>...] [--no-kit]
 * Connects with MIGRATION_DATABASE_URL (the schema-owner role), falling back to DATABASE_URL; each may be given as NAME_FILE instead
 * (V2 A15.1: read through the kit's EnvReader; the fallback is read only when the first is unset). The kit's own migrations
 * (outbox, inbox) run first unless --no-kit. Nothing here runs at service start. The connection string is never printed.
 */
async function main() {
  const args = process.argv.slice(2);
  const dirs: string[] = [];
  let withKit = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) dirs.push(resolve(args[++i]));
    else if (args[i] === '--no-kit') withKit = false;
    else throw new ConfigError(`unknown argument: ${args[i]}`);
  }
  const url = migrationDatabaseUrl(new EnvReader(process.env));
  const result = await runMigrations(url, [...(withKit ? [kitMigrationsDir] : []), ...dirs], { onLockWait });
  for (const n of result.alreadyApplied) console.log(`  = ${n} (already applied)`);
  for (const n of result.adopted) console.log(`  ~ ${n} (checksum recorded)`);
  for (const n of result.applied) console.log(`  > ${n}`);
  console.log(`migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already applied`);
}

function onLockWait(): void {
  console.log('migration lock is held by another runner: waiting for it to finish (nothing has been changed yet)');
}

main().catch((e: unknown) => {
  console.error(`migration failed: ${describeCliFailure(e)}`); // V2 A12.4.3: never the error's own message
  process.exit(1);
});
