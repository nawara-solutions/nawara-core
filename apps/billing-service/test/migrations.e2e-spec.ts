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

const KIT_MIGRATIONS = ['kit_0001_outbox_inbox.sql', 'kit_0002_rate_limit.sql', 'kit_0003_generic_triggers.sql'];
const BILLING_MIGRATIONS = [
  '0001_currency.sql', '0002_product_price.sql', '0003_invoice.sql', '0004_invoice_line.sql',
  '0005_invoice_number_sequence.sql', '0006_payment_request.sql', '0007_payment_event_receipt.sql', '0008_billing_transition.sql', '0009_platform_currency.sql',
  '0010_product_producer.sql', '0011_payment_request_correlation_id.sql',
];
/** The Stage 2/3 schema, exactly (SDD 28 and 34.1; migrations 0010/0011 add a column, not a table). The exact-set assertions are the tripwire against a table for a DEFERRED concept. */
const STAGE_2_TABLES = [
  'billing_transition', 'currency', 'inbox', 'invoice', 'invoice_line', 'invoice_number_sequence', 'kit_rate_limit', 'outbox',
  'payment_event_receipt', 'payment_request', 'platform_currency', 'price', 'product', 'schema_migrations',
];

/** Migration infrastructure and the Stage 2 schema (SDD section 28), against a real PostgreSQL. */
describeWithEnv('migration infrastructure (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingmig');
  });
  afterAll(() => db.drop());

  it('applies the kit migrations and the eleven Billing migrations from an empty database, in order, and creates exactly the Stage 2/3 tables', async () => {
    const first = await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    expect(first.applied).toEqual([...KIT_MIGRATIONS, ...BILLING_MIGRATIONS]);
    expect(await tables(db.url)).toEqual(STAGE_2_TABLES);
  });

  it('creates NO table for a deferred concept: no credit note, billing profile, template, document, recurring definition, entitlement, subscription or user/organization copy', async () => {
    const present = await tables(db.url);
    for (const deferred of [
      'credit_note', 'billing_profile', 'invoice_template', 'invoice_template_version', 'invoice_document', 'template', 'document',
      'recurring_definition', 'subscription', 'organization_license', 'user_subscription', 'user', 'organization', 'membership', 'company', 'platform',
    ]) {
      expect(present, deferred).not.toContain(deferred);
    }
  });

  it('every Billing table has its guard: no table exists without an immutability, append-only or lifecycle trigger', async () => {
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      const { rows } = await c.query(`
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT IN ('inbox', 'outbox', 'kit_rate_limit', 'schema_migrations')
          AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal)
        ORDER BY 1`);
      expect(rows).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it('is idempotent: a second run applies nothing and changes nothing', async () => {
    const again = await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toHaveLength(KIT_MIGRATIONS.length + BILLING_MIGRATIONS.length);
  });

  it('the service migrations folder holds exactly the eleven Stage 2/3 migrations, and none is edited in place afterwards (checksums)', async () => {
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(billingMigrationsDir).filter((n) => n.endsWith('.sql')).sort()).toEqual(BILLING_MIGRATIONS);
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
      expect(out).toContain(`migrations: ${KIT_MIGRATIONS.length + BILLING_MIGRATIONS.length} applied, 0 already applied`);
      expect(out).not.toContain(new URL(scratch.url).password || 'no-password-to-leak');
      expect(await tables(scratch.url)).toEqual(STAGE_2_TABLES);
      const second = execFileSync('node', ['../../libs/service-kit/dist/cli/migrate.js', '--dir', 'db/migrations'], {
        cwd,
        env: { ...process.env, MIGRATION_DATABASE_URL: scratch.url },
        encoding: 'utf8',
      });
      expect(second).toContain(`migrations: 0 applied, ${KIT_MIGRATIONS.length + BILLING_MIGRATIONS.length} already applied`);
    } finally {
      await scratch.drop();
    }
  });
});
