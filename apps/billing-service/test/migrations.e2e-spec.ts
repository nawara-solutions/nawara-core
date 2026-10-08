import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  '0010_product_producer.sql', '0011_payment_request_correlation_id.sql', '0012_payment_request_reconcile_index.sql', '0013_subscription.sql',
  '0014_drop_duplicate_transition_index.sql', // Stage 15.8: index only, no table
  '0015_subscription_billing_anchor.sql', // ADR-0044 B-025: a column, a function and a guard, no table
  '0016_payment_event_receipt_applied_claim.sql', // V2 A3M.3 (G11): indexes only, no table
];
/** The Stage 2/3 schema plus Stage 12.2's `subscription` (SDD 28 and 34.1; migrations 0010/0011/0015 add a column, 0012 an index, 0014 drops one and 0016 replaces one, not a table). The exact-set assertions are the tripwire against a table for a DEFERRED concept. */
const STAGE_2_TABLES = [
  'billing_transition', 'currency', 'inbox', 'invoice', 'invoice_line', 'invoice_number_sequence', 'kit_rate_limit', 'outbox',
  'payment_event_receipt', 'payment_request', 'platform_currency', 'price', 'product', 'schema_migrations', 'subscription',
];

/** Migration infrastructure and the Stage 2 schema (SDD section 28), against a real PostgreSQL. */
describeWithEnv('migration infrastructure (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingmig');
  });
  afterAll(() => db.drop());

  it('applies the kit migrations and the fifteen Billing migrations from an empty database, in order, and creates exactly the Stage 2/3 + 12.2 tables', async () => {
    const first = await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    expect(first.applied).toEqual([...KIT_MIGRATIONS, ...BILLING_MIGRATIONS]);
    expect(await tables(db.url)).toEqual(STAGE_2_TABLES);
  });

  it('creates NO table for a deferred concept: no credit note, billing profile, template, document, recurring definition, entitlement, plan or user/organization copy', async () => {
    const present = await tables(db.url);
    for (const deferred of [
      'credit_note', 'billing_profile', 'invoice_template', 'invoice_template_version', 'invoice_document', 'template', 'document',
      'recurring_definition', 'entitlement', 'plan', 'subscription_plan', 'plan_tier', 'organization_license', 'user_subscription', 'user', 'organization', 'membership', 'company', 'platform',
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

  it('the service migrations folder holds exactly the fifteen Stage 2/3 + 12.2 + 15.8 + B-025 migrations, and none is edited in place afterwards (checksums)', async () => {
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

  // 0015 backfills `billingAnchorAt` on rows that already exist, with four subscription triggers disabled for that one
  // statement. Every test above migrates an EMPTY database; this one stops at 0014, writes real subscriptions through the
  // real triggers, and then applies 0015 through the real runner (the files below are byte-identical copies, so the
  // checksums recorded for 0001-0014 match the real folder's).
  describe('0015 on a database that already holds subscriptions', () => {
    const SEED = `
      CREATE FUNCTION pg_temp.sub(unit text, org uuid) RETURNS uuid LANGUAGE plpgsql AS $$
      DECLARE pid uuid; prid uuid; sid uuid;
      BEGIN
        INSERT INTO product (producer, "sellerType", "sellerId", code, name) VALUES ('test-producer', 'organization', gen_random_uuid(), 'mig-' || unit, 'Plan') RETURNING id INTO pid;
        INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES (pid, 'p', 'TND', 1000, 'recurring', unit, 1) RETURNING id INTO prid;
        INSERT INTO subscription ("organizationId", "productId", "priceId") VALUES (org, pid, prid) RETURNING id INTO sid;
        INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "causeType") VALUES ('subscription', sid, NULL, 'pending', 0, 'system', 'request');
        RETURN sid;
      END $$;
      CREATE FUNCTION pg_temp.move(sid uuid, from_s text, to_s text) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE r int;
      BEGIN
        SELECT revision INTO r FROM subscription WHERE id = sid;
        INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "causeType") VALUES ('subscription', sid, from_s, to_s, r, 'system', 'request');
      END $$;
      DO $$
      DECLARE s uuid;
      BEGIN
        -- active monthly, with the precomputed grace boundary the repository writes
        s := pg_temp.sub('month', '00000000-0000-4000-8000-00000000a001');
        UPDATE subscription SET status = 'active', "currentPeriodStart" = '2026-01-31T10:00:00Z', "currentPeriodEnd" = '2026-02-28T10:00:00Z', "graceUntil" = '2026-03-07T10:00:00Z' WHERE id = s;
        PERFORM pg_temp.move(s, 'pending', 'active');
        -- in grace, monthly
        s := pg_temp.sub('month', '00000000-0000-4000-8000-00000000a002');
        UPDATE subscription SET status = 'active', "currentPeriodStart" = '2026-01-10T10:00:00Z', "currentPeriodEnd" = '2026-02-10T10:00:00Z', "graceUntil" = '2026-02-17T10:00:00Z' WHERE id = s;
        PERFORM pg_temp.move(s, 'pending', 'active');
        UPDATE subscription SET status = 'grace' WHERE id = s;
        PERFORM pg_temp.move(s, 'active', 'grace');
        -- expired (terminated), yearly from a Feb 29
        s := pg_temp.sub('year', '00000000-0000-4000-8000-00000000a003');
        UPDATE subscription SET status = 'active', "currentPeriodStart" = '2024-02-29T10:00:00Z', "currentPeriodEnd" = '2025-02-28T10:00:00Z' WHERE id = s;
        PERFORM pg_temp.move(s, 'pending', 'active');
        UPDATE subscription SET status = 'expired', "effectiveTerminationAt" = '2025-01-01T00:00:00Z' WHERE id = s;
        PERFORM pg_temp.move(s, 'active', 'expired');
        -- pending, monthly
        PERFORM pg_temp.sub('month', '00000000-0000-4000-8000-00000000a004');
        -- active weekly and active daily
        s := pg_temp.sub('week', '00000000-0000-4000-8000-00000000a005');
        UPDATE subscription SET status = 'active', "currentPeriodStart" = '2026-01-01T10:00:00Z', "currentPeriodEnd" = '2026-01-08T10:00:00Z' WHERE id = s;
        PERFORM pg_temp.move(s, 'pending', 'active');
        s := pg_temp.sub('day', '00000000-0000-4000-8000-00000000a006');
        UPDATE subscription SET status = 'active', "currentPeriodStart" = '2026-01-01T10:00:00Z', "currentPeriodEnd" = '2026-01-11T10:00:00Z' WHERE id = s;
        PERFORM pg_temp.move(s, 'pending', 'active');
      END $$;`;
    // one row per organization: status, unit and the state 0015 must leave untouched
    const SNAPSHOT = `
      SELECT s."organizationId" AS org, s.status, p."intervalUnit" AS unit, s.revision, s."updatedAt", s."graceUntil", s."currentPeriodStart", s."currentPeriodEnd",
             (SELECT count(*)::int FROM billing_transition t WHERE t."entityType" = 'subscription' AND t."entityId" = s.id) AS history
        FROM subscription s JOIN price p ON p.id = s."priceId" ORDER BY s."organizationId"`;
    const SUBSCRIPTION_TRIGGERS = `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'subscription'::regclass AND NOT tgisinternal ORDER BY tgname`;

    let mig: TestDatabase;
    let upTo0014: string;
    let c: pg.Client;
    beforeAll(async () => {
      mig = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingmig15');
      upTo0014 = mkdtempSync(join(tmpdir(), 'billing-upto-0014-'));
      for (const name of BILLING_MIGRATIONS.filter((n) => n < '0015')) copyFileSync(join(billingMigrationsDir, name), join(upTo0014, name));
      await runMigrations(mig.url, [kitMigrationsDir, upTo0014]);
      c = new pg.Client({ connectionString: mig.url });
      await c.connect();
      await c.query('BEGIN');
      await c.query(SEED);
      await c.query('COMMIT'); // the deferred BI-19 history triggers check every seeded write here
    });
    afterAll(async () => {
      await c.end();
      rmSync(upTo0014, { recursive: true, force: true });
      await mig.drop();
    });

    it('a failure inside 0015 (while the four triggers are disabled) rolls everything back: no column, no record, every trigger enabled, no row touched', async () => {
      const before = (await c.query(SNAPSHOT)).rows;
      const triggersBefore = (await c.query(SUBSCRIPTION_TRIGGERS)).rows;
      // a test-database-only trigger that makes 0015's backfill UPDATE itself fail; 0015 does not disable it
      await c.query(`CREATE FUNCTION test_injected_backfill_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected backfill failure'; END $$`);
      await c.query(`CREATE TRIGGER subscription_99_injected_failure BEFORE UPDATE ON subscription FOR EACH ROW EXECUTE FUNCTION test_injected_backfill_failure()`);
      try {
        // V2 A12.4.3: the runner reports the failure's facts, never PostgreSQL's text (which can quote row values).
        const failure = await runMigrations(mig.url, [kitMigrationsDir, billingMigrationsDir]).catch((e: unknown) => e);
        expect((failure as Error).message).toMatch(/^0015_subscription_billing_anchor\.sql failed and was rolled back: error=\S+ code=P0001$/);
        expect((failure as Error).message).not.toContain('injected backfill failure');
      } finally {
        await c.query(`DROP TRIGGER subscription_99_injected_failure ON subscription`);
        await c.query(`DROP FUNCTION test_injected_backfill_failure()`);
      }
      expect((await c.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '0015_subscription_billing_anchor.sql'`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'subscription' AND column_name = 'billingAnchorAt'`)).rows[0].n).toBe(0);
      expect((await c.query(SUBSCRIPTION_TRIGGERS)).rows).toEqual(triggersBefore);
      expect(triggersBefore.every((t) => t.tgenabled === 'O')).toBe(true);
      expect((await c.query(SNAPSHOT)).rows).toEqual(before);
    });

    it('backfills month/year anchors from currentPeriodStart and leaves pending, day and week NULL, with no revision, updatedAt, graceUntil or history change', async () => {
      const before = (await c.query(SNAPSHOT)).rows;
      expect(before.map((r) => `${r.status}/${r.unit}`)).toEqual(['active/month', 'grace/month', 'expired/year', 'pending/month', 'active/week', 'active/day']);

      const result = await runMigrations(mig.url, [kitMigrationsDir, billingMigrationsDir]);
      expect(result.applied).toEqual(['0015_subscription_billing_anchor.sql', '0016_payment_event_receipt_applied_claim.sql']); // V2 A3M.3: 0016 (indexes only) follows

      expect((await c.query(SNAPSHOT)).rows).toEqual(before); // revision, updatedAt, graceUntil, period and history count: all unchanged
      const anchors = (await c.query(`SELECT "billingAnchorAt" FROM subscription ORDER BY "organizationId"`)).rows.map((r) => r.billingAnchorAt);
      expect(anchors).toEqual([before[0].currentPeriodStart, before[1].currentPeriodStart, before[2].currentPeriodStart, null, null, null]);
      expect(anchors[2]).toEqual(new Date('2024-02-29T10:00:00Z'));

      // every subscription trigger is enabled again, 0015's new anchor guard included
      const triggers = (await c.query(SUBSCRIPTION_TRIGGERS)).rows;
      expect(triggers.map((t) => t.tgname)).toContain('subscription_25_billing_anchor');
      expect(triggers.every((t) => t.tgenabled === 'O')).toBe(true);
      // ...and enforcing: a backfilled monthly row can no longer lose, or arbitrarily move, its anchor
      await expect(c.query(`UPDATE subscription SET "billingAnchorAt" = NULL WHERE "organizationId" = '00000000-0000-4000-8000-00000000a001'`)).rejects.toMatchObject({ code: '23514' });
      await expect(c.query(`UPDATE subscription SET "billingAnchorAt" = '2026-01-01T00:00:00Z' WHERE "organizationId" = '00000000-0000-4000-8000-00000000a001'`)).rejects.toMatchObject({ code: '23514' });
    });
  });
});
