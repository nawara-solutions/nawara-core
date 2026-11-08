import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import { describeWithEnv } from './support/env.js';

/**
 * Core V2 S0-C15B T20 (migration level): a database built through 0051 with historical reconciliation cases and an acknowledgement, then migrated to 0052.
 * 0052 is expand-only: it writes, rewrites and deletes no row; the earlier acknowledgement stands; the contest rule applies only to what is stated after.
 */
describeWithEnv('Core V2 S0-C15B: 0052 over historical cases — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let admin: pg.Pool;
  let before0052 = '';

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings0c15bhist');
    before0052 = mkdtempSync(join(tmpdir(), 'billing-0051-'));
    for (const f of readdirSync(billingMigrationsDir).filter((n) => n.endsWith('.sql') && n < '0052')) copyFileSync(join(billingMigrationsDir, f), join(before0052, f));
    await runMigrations(db.url, [kitMigrationsDir, before0052]);
    admin = new pg.Pool({ connectionString: db.url, max: 4 });
  });
  afterAll(async () => {
    await admin?.end();
    await db?.drop();
    if (before0052) rmSync(before0052, { recursive: true, force: true });
  });

  it('historical cases and their acknowledgement are byte-identical after 0052; new contest cases then open beside them; the old acknowledgement stands while a new one is refused', async () => {
    expect((await admin.query(`SELECT to_regclass('reconciliation_contest_evidence') AS t`)).rows[0].t).toBeNull();
    const company = randomUUID();
    const paymentId = randomUUID();
    const owner = randomUUID();
    const acked = (await admin.query(`INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId", "paymentId", amount, currency) VALUES ('refund_discrepancy', $1, $2, $3, 4200, 'TND') RETURNING id`,
      [randomUUID(), company, paymentId])).rows[0].id as string;
    await admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, 'acknowledged', $2, 'reviewed_no_financial_effect')`, [acked, owner]);
    const open = (await admin.query(`INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId", "paymentId", amount, currency, detail)
      VALUES ('partial_chargeback', $1, $2, $3, 700, 'TND', 'provider_partial_chargeback') RETURNING id`, [randomUUID(), company, paymentId])).rows[0].id as string;
    const snapshot = async () => ({
      cases: (await admin.query(`SELECT * FROM reconciliation_case ORDER BY id`)).rows,
      resolutions: (await admin.query(`SELECT * FROM reconciliation_case_resolution ORDER BY "caseId"`)).rows,
    });
    const history = await snapshot();

    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '0052_s0c15b_contested_evidence.sql'`)).rows[0].n).toBe(1);
    expect(await snapshot()).toEqual(history); // no row written, rewritten or deleted by the migration

    // the worker's later discovery: a redacted dispute conflict of the same payment opens beside the history
    await admin.query(`INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId", "paymentId") VALUES ('dispute_conflict_observed', $1, $2, $3)`, [randomUUID(), company, paymentId]);
    const after = await snapshot();
    expect(after.resolutions).toEqual(history.resolutions); // the earlier acknowledgement stands, unchanged
    expect(after.cases.filter((c) => c.caseType !== 'dispute_conflict_observed')).toEqual(history.cases);
    await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, 'acknowledged', $2, 'reviewed_no_financial_effect')`, [open, owner]))
      .rejects.toMatchObject({ constraint: 'reconciliation_case_contest_acknowledgement' }); // a NEW claim on the contested movement is refused
    await admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, 'acknowledged', $2, 'provider_statement_reviewed')`, [open, owner]);
  });
});
