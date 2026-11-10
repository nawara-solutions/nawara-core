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
 * Core V2 DO-74 D14 (migration level): a database built through 0053 with historical cases, an acknowledged discrepancy of a refund attempt and
 * S0-C15B / DO-73 cases, then migrated to 0054. 0054 is expand-only: it writes, rewrites and deletes no row; the earlier acknowledgement stands; the
 * observation rule applies only to what is stated after, and leaves S0-C15B's and DO-73's rules as they were.
 * LABELLED FIXTURE: one refund case and its relay are inserted with triggers and foreign keys off (session_replication_role), since a real relay needs a
 * paid payment request; the rows obey every CHECK. Every case, evidence and resolution after that goes through the real guards.
 */
describeWithEnv('Core V2 DO-74: 0054 over historical cases — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let admin: pg.Pool;
  let before0054 = '';

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingdo74hist');
    before0054 = mkdtempSync(join(tmpdir(), 'billing-0053-'));
    for (const f of readdirSync(billingMigrationsDir).filter((n) => n.endsWith('.sql') && n < '0054')) copyFileSync(join(billingMigrationsDir, f), join(before0054, f));
    await runMigrations(db.url, [kitMigrationsDir, before0054]);
    admin = new pg.Pool({ connectionString: db.url, max: 4 });
  });
  afterAll(async () => {
    await admin?.end();
    await db?.drop();
    if (before0054) rmSync(before0054, { recursive: true, force: true });
  });

  it('historical cases and their acknowledgements are byte-identical after 0054; an observation case then opens beside them; the old acknowledgement stands while a new one is refused', async () => {
    expect((await admin.query(`SELECT to_regclass('reconciliation_observation_evidence') AS t`)).rows[0].t).toBeNull();
    const company = randomUUID();
    const paymentId = randomUUID();
    const owner = randomUUID();
    const capture = randomUUID();
    const caseId = randomUUID();
    const attempt = randomUUID();
    const cl = await admin.connect();
    try {
      await cl.query('BEGIN');
      await cl.query(`SET LOCAL session_replication_role = replica`);
      await cl.query(`INSERT INTO refund_case (id, "paymentId", "paymentRequestId", "invoiceId", eligibility, "companyId", "platformId", amount, currency, reason, "openedBy", "captureFactId", "captureBasis")
        VALUES ($1, $2, $3, $4, 'capture_specific', $5, $6, 4200, 'TND', 'customer_request', $7, $8, 'duplicate_capture')`, [caseId, paymentId, randomUUID(), randomUUID(), company, randomUUID(), owner, capture]);
      await cl.query(`INSERT INTO refund_authorization_relay (id, "refundCaseId", "paymentId", "requestedBy", "idempotencyKey", "requestHash") VALUES ($1, $2, $3, $4, 'k-do74-hist-1', repeat('a', 64))`,
        [attempt, caseId, paymentId, owner]);
      await cl.query('COMMIT');
    } finally {
      cl.release();
    }
    // history: the attempt's discrepancy acknowledged as a duplicate (the R1 outcome before DO-74), a partial chargeback left open, a dispute conflict case
    const disc = (await admin.query(`INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId", "paymentId", amount, currency) VALUES ('refund_discrepancy', $1, $2, $3, 4200, 'TND') RETURNING id`,
      [attempt, company, paymentId])).rows[0].id as string;
    await admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, 'acknowledged', $2, 'duplicate_evidence_reviewed')`, [disc, owner]);
    const open = (await admin.query(`INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId", "paymentId", "captureFactId", amount, currency, detail)
      VALUES ('partial_chargeback', $1, $2, $3, $4, 700, 'TND', 'provider_partial_chargeback') RETURNING id`, [randomUUID(), company, paymentId, capture])).rows[0].id as string;
    await admin.query(`INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId", "paymentId") VALUES ('dispute_conflict_observed', $1, $2, $3)`, [randomUUID(), company, randomUUID()]);
    const snapshot = async () => ({
      cases: (await admin.query(`SELECT * FROM reconciliation_case ORDER BY id`)).rows,
      resolutions: (await admin.query(`SELECT * FROM reconciliation_case_resolution ORDER BY "caseId"`)).rows,
      relays: (await admin.query(`SELECT * FROM refund_authorization_relay ORDER BY id`)).rows,
      refundCases: (await admin.query(`SELECT * FROM refund_case ORDER BY id`)).rows,
    });
    const history = await snapshot();

    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '0054_do74_refund_observation_conflict.sql'`)).rows[0].n).toBe(1);
    expect(await snapshot()).toEqual(history); // no row written, rewritten or deleted by the migration
    expect((await admin.query(`SELECT count(*)::int AS n FROM reconciliation_observation_evidence`)).rows[0].n).toBe(0); // no backfill

    // the worker's later discovery: the attempt's observation of a fact not its payment's opens beside the history
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      const id = (await c.query(`INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId", "paymentId", "captureFactId") VALUES ('refund_observation_conflict', $1, $2, $3, $4) RETURNING id`,
        [attempt, company, paymentId, capture])).rows[0].id as string;
      await c.query(`INSERT INTO reconciliation_observation_evidence ("caseId", "paymentId", "refundAttemptId", "observationId") VALUES ($1, $2, $3, $4)`, [id, paymentId, attempt, randomUUID()]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const after = await snapshot();
    expect(after.resolutions).toEqual(history.resolutions); // the earlier duplicate acknowledgement stands, unchanged
    expect(after.cases.filter((x) => x.caseType !== 'refund_observation_conflict')).toEqual(history.cases);
    await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, 'acknowledged', $2, 'reviewed_no_financial_effect')`, [open, owner]))
      .rejects.toMatchObject({ constraint: 'reconciliation_case_contest_acknowledgement' }); // a NEW claim on the contested movement is refused
    await admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, 'acknowledged', $2, 'provider_statement_reviewed')`, [open, owner]);
  });
});
