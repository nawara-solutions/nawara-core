#!/usr/bin/env node
import { EnvReader, MigrationError, describeCliFailure, runMigrations } from '@nawara/service-kit';
import { AUTH_MIGRATION_OPTIONS, AUTH_MIGRATIONS_DIR } from '../db/migrations.js';

/**
 * Explicit migration step for auth-service (Stage 14.5):  node dist/cli/migrate.js
 * Connects with MIGRATION_DATABASE_URL: the schema OWNER (the production deploy's `auth`, the local `auth_migrator`), never the
 * least-privilege runtime role. Nothing here runs at service start. Holds the migration advisory lock for the whole run, refuses a
 * modified, unknown or out-of-order history, and records each migration in the same transaction as its effect. The connection
 * string is never printed. Exit code 0 on success, 1 on any refusal or failure.
 *
 * V2 A4.3: read through the kit's `EnvReader`: `MIGRATION_DATABASE_URL` or `MIGRATION_DATABASE_URL_FILE` (both together refused), trimmed,
 * blank means unset. Deliberately NOT the kit migrator's `DATABASE_URL` fallback: Auth's `DATABASE_URL` is the runtime role, so a missing
 * migration URL is refused, with the message the restore drill classifies (infra/backup/restore-drill.sh), as before. The summary line is
 * the drill's contract too.
 */
async function main() {
  const url = new EnvReader(process.env).get('MIGRATION_DATABASE_URL');
  if (url === undefined) throw new MigrationError('MIGRATION_DATABASE_URL is required (the schema owner, not the runtime role)');
  const r = await runMigrations(url, [AUTH_MIGRATIONS_DIR], { ...AUTH_MIGRATION_OPTIONS, onLockWait });
  for (const n of r.alreadyApplied) console.log(`  = ${n} (already applied)`);
  for (const n of r.adopted) console.log(`  ~ ${n} (checksum recorded: applied before checksums were kept)`);
  for (const n of r.applied) console.log(`  > ${n}`);
  console.log(`migrations: ${r.applied.length} applied, ${r.alreadyApplied.length} already applied, ${r.adopted.length} checksum(s) recorded`);
}

function onLockWait(): void {
  console.log('migration lock is held by another runner: waiting for it to finish (nothing has been changed yet)');
}

main().catch((e: unknown) => {
  console.error(`migration failed: ${describeCliFailure(e)}`); // V2 A12.4.3: never the error's own message
  process.exit(1);
});
