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

/**
 * Core V2 R3 (migration level): notifications stored before 0028 keep every original column byte-identical; each is `pending` (never "no evidence") until
 * the backfill indexes it once; nothing is attributed or indexed by the migration itself.
 */
describeWithEnv('Core V2 R3: 0028 over historical notifications — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let admin: pg.Pool;
  let before0028 = '';

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentr3hist');
    before0028 = mkdtempSync(join(tmpdir(), 'payment-0027-'));
    for (const f of readdirSync(paymentMigrationsDir).filter((n) => n.endsWith('.sql') && n < '0028')) copyFileSync(join(paymentMigrationsDir, f), join(before0028, f));
    await runMigrations(db.url, [kitMigrationsDir, before0028]);
    admin = new pg.Pool({ connectionString: db.url, max: 2 });
  });
  afterAll(async () => {
    await admin?.end();
    await db?.drop();
    if (before0028) rmSync(before0028, { recursive: true, force: true });
  });

  it('historical notifications are unchanged, all `pending`, none indexed; the index is then written once', async () => {
    const body = Buffer.from(JSON.stringify({ eventId: 'h1', type: 'refund.succeeded', reference: randomUUID(), providerTransactionId: 'simr_x', amount: 100, currency: 'TND' }));
    await admin.query(`INSERT INTO webhook_event (provider, "providerEventId", "eventType", "rawBody") VALUES ('simulation', $1, 'refund.succeeded', $2), ('simulation', $3, 'payment.succeeded', $4)`,
      [`h_${randomUUID()}`, body, `h_${randomUUID()}`, Buffer.from('{}')]);
    const original = (await admin.query(`SELECT id, provider, "providerEventId", "eventType", "rawBody", "receivedAt", state, outcome, attempts FROM webhook_event ORDER BY id`)).rows;
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    expect((await admin.query(`SELECT id, provider, "providerEventId", "eventType", "rawBody", "receivedAt", state, outcome, attempts FROM webhook_event ORDER BY id`)).rows).toEqual(original);
    expect((await admin.query(`SELECT DISTINCT "evidenceIndex", "providerTransactionId" FROM webhook_event`)).rows).toEqual([{ evidenceIndex: 'pending', providerTransactionId: null }]);
    const id = original.find((r) => r.eventType === 'refund.succeeded')!.id;
    await admin.query(`UPDATE webhook_event SET "evidenceIndex" = 'reference', "providerTransactionId" = 'simr_x' WHERE id = $1`, [id]);
    await expect(admin.query(`UPDATE webhook_event SET "evidenceIndex" = 'none' WHERE id = $1`, [id])).rejects.toThrow();
    await expect(admin.query(`UPDATE webhook_event SET "providerTransactionId" = 'other' WHERE id = $1`, [id])).rejects.toMatchObject({ constraint: 'webhook_event_evidence_index_once' });
  });
});
