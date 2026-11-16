import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const APPROVER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';

/**
 * Core V2 DO-76 S2 (the Owner's D-76-3; migration 0031): an attempt that holds Auth's consumption (`receiptId`) has its `refund_authorization` row at
 * COMMIT, and the migration refuses history that already violates it (it never backfills). The application's own path (`commitAuthorized`, one
 * transaction: the attempt, then its row) is exercised by every refund suite; this one proves the database boundary directly.
 *
 * Fixture rows are written by the superuser with `session_replication_role = replica` (no trigger, no foreign key): the only way to create what no
 * Payment code path writes. That bypass is itself the recorded limit of S2: a superuser can always defeat a trigger; the runtime role cannot.
 */
describeWithEnv('Core V2 DO-76 S2: authorization-row integrity (0031) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let admin: pg.Pool;
  let before0031 = '';

  /** A refund attempt row as the superuser writes it with triggers and foreign keys off: `authorized` (with a consumption) or `authorization_pending`. */
  const seedAttempt = async (status: 'authorized' | 'authorization_pending', withAuthorizationRow: boolean) => {
    const id = randomUUID();
    const paymentId = randomUUID();
    const receiptId = status === 'authorized' ? randomUUID() : null;
    const c = await admin.connect();
    try {
      await c.query(`SET session_replication_role = replica`);
      await c.query(
        `INSERT INTO refund_attempt (id, "paymentId", producer, "refundCaseId", "companyId", amount, currency, reason, "legalOverride", "captureFactId", "capturedAttemptId",
           provider, "liveMode", "receiptDigest", status, "receiptId", "approvedByUserId", "consumedAt", "authorizedAt")
         VALUES ($1, $2, 'billing-service', $3, $4, 9000, 'TND', 'customer_request', false, $5, $6, 'simulation', false, $7, $8, $9, $10, $11, $11)`,
        [id, paymentId, randomUUID(), randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64), status, receiptId, receiptId ? APPROVER : null, receiptId ? new Date() : null],
      );
      if (withAuthorizationRow) await insertAuthorization(c, id);
    } finally {
      await c.query(`SET session_replication_role = origin`);
      c.release();
    }
    return { id, paymentId };
  };
  const insertAuthorization = (q: pg.PoolClient, attemptId: string) => q.query(
    `INSERT INTO refund_authorization ("refundAttemptId", "paymentId", "refundCaseId", producer, "receiptId", "approvedByUserId", "approvedAmount", currency, "captureFactId")
     SELECT id, "paymentId", "refundCaseId", producer, "receiptId", "approvedByUserId", amount, currency, "captureFactId" FROM refund_attempt WHERE id = $1`, [attemptId]);
  const authorize = (q: pg.PoolClient, attemptId: string) => q.query(
    `UPDATE refund_attempt SET status = 'authorized', "receiptId" = gen_random_uuid(), "approvedByUserId" = $2, "consumedAt" = now(), "authorizedAt" = now() WHERE id = $1`,
    [attemptId, APPROVER]);
  const statusOf = async (id: string) => (await admin.query(`SELECT status FROM refund_attempt WHERE id = $1`, [id])).rows[0].status;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentdo76s2');
    before0031 = mkdtempSync(join(tmpdir(), 'payment-0030-'));
    for (const f of readdirSync(paymentMigrationsDir).filter((n) => n.endsWith('.sql') && n < '0031')) copyFileSync(join(paymentMigrationsDir, f), join(before0031, f));
    await runMigrations(db.url, [kitMigrationsDir, before0031]);
    admin = new pg.Pool({ connectionString: db.url, max: 4 });
  });
  afterAll(async () => {
    await admin?.end();
    await db?.drop();
    if (before0031) rmSync(before0031, { recursive: true, force: true });
  });

  it('M1: 0031 refuses history holding a consumption without its authorization row (no backfill), then applies once the row exists', async () => {
    await seedAttempt('authorized', true); // consistent history: never a reason to refuse
    const broken = await seedAttempt('authorized', false);
    // the runner wraps the database's refusal (23514, refund_attempt_authorization_row) and rolls the file back
    await expect(runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir])).rejects.toThrow(/0031_refund_authorization_row_integrity\.sql failed and was rolled back.*23514/);
    // nothing of 0031 was applied, and no authorization was invented
    expect((await admin.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'refund_attempt_authorization_row_check'`)).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM refund_authorization WHERE "refundAttemptId" = $1`, [broken.id])).rows[0].n).toBe(0);
    // an operator reconciles the row (here: the superuser fixture), and the migration then applies
    const c = await admin.connect();
    try {
      await c.query(`SET session_replication_role = replica`);
      await insertAuthorization(c, broken.id);
    } finally {
      await c.query(`SET session_replication_role = origin`);
      c.release();
    }
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('refund_attempt_20_authorization_row_on_insert', 'refund_attempt_21_authorization_row')`)).rows[0].n).toBe(2);
  });

  it('S2: `authorized` without its authorization row is refused at COMMIT; the same transaction with the row commits (the application\'s order)', async () => {
    const lone = await seedAttempt('authorization_pending', false);
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await authorize(c, lone.id); // accepted by every immediate guard (shape, transition): the rule is deferred to the commit
      await expect(c.query('COMMIT')).rejects.toMatchObject({ code: '23514', constraint: 'refund_attempt_authorization_row' });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect(await statusOf(lone.id)).toBe('authorization_pending');

    const paired = await seedAttempt('authorization_pending', false);
    const d = await admin.connect();
    try {
      await d.query('BEGIN');
      await authorize(d, paired.id);
      await insertAuthorization(d, paired.id);
      await d.query('COMMIT');
    } finally {
      d.release();
    }
    expect(await statusOf(paired.id)).toBe('authorized');
  });

  it('S2: SET CONSTRAINTS IMMEDIATE only moves the check earlier (the write itself is refused); a row of another receipt does not satisfy it', async () => {
    const early = await seedAttempt('authorization_pending', false);
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await expect(authorize(c, early.id)).rejects.toMatchObject({ code: '23514', constraint: 'refund_attempt_authorization_row' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect(await statusOf(early.id)).toBe('authorization_pending');
    // an authorization row of the attempt but naming ANOTHER receipt cannot exist (0018/0022 `refund_authorization_from_attempt`), so the pairing is exact
    const other = await seedAttempt('authorization_pending', false);
    const d = await admin.connect();
    try {
      await d.query('BEGIN');
      await authorize(d, other.id);
      await expect(d.query(
        `INSERT INTO refund_authorization ("refundAttemptId", "paymentId", "refundCaseId", producer, "receiptId", "approvedByUserId", "approvedAmount", currency, "captureFactId")
         SELECT id, "paymentId", "refundCaseId", producer, gen_random_uuid(), "approvedByUserId", amount, currency, "captureFactId" FROM refund_attempt WHERE id = $1`, [other.id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'refund_authorization_from_attempt' });
    } finally {
      await d.query('ROLLBACK');
      d.release();
    }
    expect(await statusOf(other.id)).toBe('authorization_pending');
  });

  it('LIMITATION (recorded): a superuser with `session_replication_role = replica` bypasses the rule, as every trigger; the runtime role cannot (runtime-role spec)', async () => {
    const seeded = await seedAttempt('authorized', false);
    expect(await statusOf(seeded.id)).toBe('authorized');
    expect((await admin.query(`SELECT count(*)::int AS n FROM refund_authorization WHERE "refundAttemptId" = $1`, [seeded.id])).rows[0].n).toBe(0);
  });
});
