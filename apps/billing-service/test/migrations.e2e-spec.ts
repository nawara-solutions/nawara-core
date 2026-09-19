import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import { describeWithEnv } from './support/env.js';

const tables = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).rows.map((r) => r.table_name as string);
  } finally {
    await c.end();
  }
};

/**
 * Stage 1 proves the migration INFRASTRUCTURE without any Billing table (SDD 34.1: "No table, endpoint or domain type from
 * this SDD is created"). The exact-set assertion below is also the tripwire that fails when a domain table appears before Stage 2.
 */
describeWithEnv('migration infrastructure (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingmig');
  });
  afterAll(() => db.drop());

  it('applies the kit migrations from an empty database and creates ONLY infrastructure tables (no Billing domain table)', async () => {
    const first = await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    expect(first.applied).toEqual(['kit_0001_outbox_inbox.sql', 'kit_0002_rate_limit.sql', 'kit_0003_generic_triggers.sql']);
    expect(await tables(db.url)).toEqual(['inbox', 'kit_rate_limit', 'outbox', 'schema_migrations']);
  });

  it('is idempotent: a second run applies nothing and changes nothing', async () => {
    const again = await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toHaveLength(3);
  });

  it('the service migrations folder exists and holds no SQL yet (Stage 2 adds the schema)', async () => {
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(billingMigrationsDir).filter((n) => n.endsWith('.sql'))).toEqual([]);
  });

  it('the explicit `npm run migrate` step works end to end as the schema owner and never prints a connection string', async () => {
    const scratch = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingcli');
    try {
      const cwd = fileURLToPath(new URL('..', import.meta.url));
      const out = execFileSync('node', ['../../libs/service-kit/dist/cli/migrate.js', '--dir', 'db/migrations'], {
        cwd,
        env: { ...process.env, MIGRATION_DATABASE_URL: scratch.url },
        encoding: 'utf8',
      });
      expect(out).toContain('migrations: 3 applied, 0 already applied');
      expect(out).not.toContain(new URL(scratch.url).password || 'no-password-to-leak');
      expect(await tables(scratch.url)).toEqual(['inbox', 'kit_rate_limit', 'outbox', 'schema_migrations']);
      const second = execFileSync('node', ['../../libs/service-kit/dist/cli/migrate.js', '--dir', 'db/migrations'], {
        cwd,
        env: { ...process.env, MIGRATION_DATABASE_URL: scratch.url },
        encoding: 'utf8',
      });
      expect(second).toContain('migrations: 0 applied, 3 already applied');
    } finally {
      await scratch.drop();
    }
  });
});
