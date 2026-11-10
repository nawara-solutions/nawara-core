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
 * Core V2 R3 (migration level): a database built through 0054 with a verified loss, a FAILED relay of its movement and a historical direct write-off, then
 * migrated to 0055. 0055 is expand-only: it writes, rewrites and deletes no row, backfills no marker or attestation, and the historical write-off stands. After
 * it, a new effect needs its own transaction's attestation.
 * LABELLED FIXTURE: the refund case, relay, loss and write-off are inserted with triggers and foreign keys off (session_replication_role) on the pre-0055 schema;
 * the rows obey every CHECK.
 */
describeWithEnv('Core V2 R3: 0055 over historical effects — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let admin: pg.Pool;
  let before0055 = '';

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingr3hist');
    before0055 = mkdtempSync(join(tmpdir(), 'billing-0054-'));
    for (const f of readdirSync(billingMigrationsDir).filter((n) => n.endsWith('.sql') && n < '0055')) copyFileSync(join(billingMigrationsDir, f), join(before0055, f));
    await runMigrations(db.url, [kitMigrationsDir, before0055]);
    admin = new pg.Pool({ connectionString: db.url, max: 4 });
  });
  afterAll(async () => {
    await admin?.end();
    await db?.drop();
    if (before0055) rmSync(before0055, { recursive: true, force: true });
  });

  it('historical losses, relays and write-offs are byte-identical after 0055; nothing is backfilled; a new effect then needs this transaction\'s attestation', async () => {
    expect((await admin.query(`SELECT to_regclass('refund_relay_failure_evidence') AS t`)).rows[0].t).toBeNull();
    const pay = randomUUID();
    const caseId = randomUUID();
    const relay = randomUUID();
    const disputeId = randomUUID();
    const cl = await admin.connect();
    try {
      await cl.query('BEGIN');
      await cl.query(`SET LOCAL session_replication_role = replica`);
      await cl.query(`INSERT INTO refund_case (id, "paymentId", "paymentRequestId", "invoiceId", eligibility, "companyId", "platformId", amount, currency, reason, "openedBy", "receiptId")
        VALUES ($1, $2, $3, $4, 'non_entitlement', $5, $6, 100, 'TND', 'customer_request', $7, $8)`, [caseId, pay, randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]);
      await cl.query(`INSERT INTO refund_authorization_relay (id, "refundCaseId", "paymentId", "requestedBy", "idempotencyKey", "requestHash", "attemptStatus", "statusAt")
        VALUES ($1, $2, $3, $4, 'k-r3-hist-1', repeat('a', 64), 'failed', now())`, [relay, caseId, pay, randomUUID()]);
      await cl.query(`INSERT INTO payment_dispute_loss ("disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency, "chargebackFactId", "chargebackAmount", "chargebackCurrency", "lostAt", source, "captureBasis")
        VALUES ($1, $2, $3, 100, 'TND', $4, 100, 'TND', now(), 'reconciliation', 'settling_capture')`, [disputeId, pay, randomUUID(), randomUUID()]);
      await cl.query(`INSERT INTO financial_loss (kind, "evidenceKey", "companyId", "paymentId", "disputeId", amount, currency) VALUES ('direct_chargeback_write_off', $1, $2, $3, $4, 100, 'TND')`,
        [randomUUID(), randomUUID(), pay, disputeId]);
      await cl.query('COMMIT');
    } finally {
      cl.release();
    }
    const snapshot = async () => ({
      relays: (await admin.query(`SELECT * FROM refund_authorization_relay ORDER BY id`)).rows,
      losses: (await admin.query(`SELECT * FROM payment_dispute_loss ORDER BY "disputeId"`)).rows,
      financial: (await admin.query(`SELECT * FROM financial_loss ORDER BY id`)).rows,
      obligations: (await admin.query(`SELECT * FROM recovery_obligation ORDER BY id`)).rows,
      cases: (await admin.query(`SELECT * FROM reconciliation_case ORDER BY id`)).rows,
    });
    const history = await snapshot();
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '0055_r3_failure_evidence_attestation.sql'`)).rows[0].n).toBe(1);
    expect(await snapshot()).toEqual(history); // no row written, rewritten or deleted
    expect((await admin.query(`SELECT (SELECT count(*) FROM refund_relay_failure_evidence) + (SELECT count(*) FROM loss_effect_attestation) AS n`)).rows[0].n).toBe('0'); // no backfill
    // the historical write-off stands; a NEW write-off of the same loss would need this transaction's attestation (refused without one, under the existing name)
    await expect(admin.query(`SELECT billing_loss_effect_refusal($1, 'direct_chargeback_write_off') AS why`, [disputeId]).then((r) => r.rows[0].why)).resolves.toBe('effect_not_attested');
    // the first marker after 0055 (from Payment's current answer) opens the exposure of the historical loss: detection only
    await admin.query(`INSERT INTO refund_relay_failure_evidence ("relayId", "paymentId", "firstState") VALUES ($1, $2, 'unmatched_fact')`, [relay, pay]);
    expect((await admin.query(`SELECT billing_loss_unresolved_exposure($1) AS e`, [disputeId])).rows[0].e).toBe(true);
    expect((await snapshot()).financial).toEqual(history.financial);
  });
});
