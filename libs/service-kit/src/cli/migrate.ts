#!/usr/bin/env node
import { resolve } from 'node:path';
import { kitMigrationsDir } from '../db/paths.js';
import { runMigrations } from '../db/migrations.js';

/**
 * Explicit migration step:  nawara-migrate --dir <path> [--dir <path>...] [--no-kit]
 * Connects with MIGRATION_DATABASE_URL (the schema-owner role), falling back to DATABASE_URL. The kit's own migrations
 * (outbox, inbox) run first unless --no-kit. Nothing here runs at service start. The connection string is never printed.
 */
async function main() {
  const args = process.argv.slice(2);
  const dirs: string[] = [];
  let withKit = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) dirs.push(resolve(args[++i]));
    else if (args[i] === '--no-kit') withKit = false;
    else throw new Error(`unknown argument: ${args[i]}`);
  }
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL (or DATABASE_URL) is required');
  const result = await runMigrations(url, [...(withKit ? [kitMigrationsDir] : []), ...dirs]);
  for (const n of result.alreadyApplied) console.log(`  = ${n} (already applied)`);
  for (const n of result.applied) console.log(`  > ${n}`);
  console.log(`migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already applied`);
}

main().catch((e: unknown) => {
  console.error(`migration failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  process.exit(1);
});
