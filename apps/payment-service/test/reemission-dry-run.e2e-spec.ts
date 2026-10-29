import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, OutboxService, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { inspectPaymentReemission, paymentDatabaseOwnership } from '../src/reemission/reemission-eligibility.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const appDir = fileURLToPath(new URL('../', import.meta.url));

/**
 * Core V2 S1c-3 R2a against a REAL PostgreSQL: migration 0009 (append-only attempt evidence, database-enforced, runtime INSERT/SELECT only)
 * and the read-only dry run (the built CLI included). Synthetic rows in disposable databases and roles only; nothing is published.
 */
describeWithEnv('Payment re-emission preparation (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const outbox = new OutboxService();
  const ownership = paymentDatabaseOwnership(paymentMigrationsDir);
  let testDb: TestDatabase;
  let foreignDb: TestDatabase;
  let db: DbService;
  let foreign: DbService;
  const enqueue = (name: string, extra: { version?: number; published?: boolean } = {}) =>
    db.tx(async (q) => {
      const id = await outbox.enqueue(q, { name, payload: { paymentId: randomUUID(), amount: 1200, currency: 'TND', note: 'synthetic' }, correlationId: 'corr-r2a-test', version: extra.version });
      if (extra.published !== false) await q.query(`UPDATE outbox SET "publishedAt" = now(), attempts = 1 WHERE id = $1`, [id]);
      return id;
    });
  const snapshot = async () => ({
    outbox: (await db.query(`SELECT id, name, payload::text, "publishedAt", attempts, "lastError" FROM outbox ORDER BY id`)).rows,
    attempts: Number((await db.query(`SELECT count(*) n FROM payment_reemission_attempt`)).rows[0].n),
    transitions: Number((await db.query(`SELECT count(*) n FROM payment_reemission_attempt_transition`)).rows[0].n),
  });

  beforeAll(async () => {
    testDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'payment_r2a');
    foreignDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'payment_r2a_foreign');
    await runMigrations(testDb.url, [kitMigrationsDir, paymentMigrationsDir]);
    await runMigrations(foreignDb.url, [kitMigrationsDir]);
    db = new DbService({ url: testDb.url, max: 3 });
    foreign = new DbService({ url: foreignDb.url, max: 1 });
  });
  afterAll(async () => {
    await db?.onApplicationShutdown();
    await foreign?.onApplicationShutdown();
    await testDb?.drop();
    await foreignDb?.drop();
  });

  it('0009 applies on the existing chain and adds exactly two tables with no body, payload, header or credential column', async () => {
    const { rows } = await db.query(`SELECT name FROM schema_migrations WHERE name LIKE '0%' ORDER BY name`);
    expect(rows.map((r) => r.name)).toStrictEqual([
      '0001_currency.sql', '0002_payment.sql', '0003_payment_attempt.sql', '0004_idempotency_key.sql', '0005_webhook_event.sql',
      '0006_phase1_acceptance_hardening.sql', '0007_payment_expiry_open_index.sql', '0008_attempt_resolver_lease.sql', '0009_reemission_attempt.sql',
      '0010_payment_purpose_live_mode.sql', // Core V2 S4a: columns, CHECKs and triggers on payment / payment_attempt, no table
      '0011_no_company_cash_settlement.sql', // Core V2 S4b: DB-16, one CHECK on payment, no table
      '0012_payment_closing_finality.sql', // Core V2 S4c: closing, uncertainty guards, payment_late_success
      '0013_provider_transaction_fact.sql', // Core V2 S4d: provider_transaction_fact (+ conflicts), late success -> fact
      '0014_class_m_idempotency_retention.sql', // Core V2 S4g: 90-day class-M retention, set and kept by the database
      '0015_simulation_provider.sql', // Core V2 S4f: the simulation provider's own append-only records (non-production only)
      '0016_organization_payer_scope.sql', // Core V2 S4e: an Organization payer is the payment's Organization (insert guard)
      '0017_refund_attempt.sql', // Core V2 S6b: refund_attempt, refund_attempt_refusal, refund facts, the simulated provider's refund records
      '0018_refund_allocation.sql', // Core V2 S6c: refund_authorization, refund_allocation, blocked facts, the allocation lease
      '0019_payment_dispute.sql', // Core V2 S6e-D: disputes, observations, evidence, decisions, chargeback facts, the dispute harness
      '0020_recovery_refunds.sql', // Core V2 S6f (R6F-5 Path A): the recovery_surplus refund reason; a recovery settlement is refundable
    ]);
    const cols = await db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name LIKE 'payment_reemission%' ORDER BY table_name, ordinal_position`);
    expect(cols.rows.map((r) => `${r.table_name}.${r.column_name}`)).toStrictEqual([
      'payment_reemission_attempt.id', 'payment_reemission_attempt.eventId', 'payment_reemission_attempt.eventName', 'payment_reemission_attempt.eventVersion',
      'payment_reemission_attempt.reason', 'payment_reemission_attempt.approvalRef', 'payment_reemission_attempt.environment', 'payment_reemission_attempt.operation',
      'payment_reemission_attempt.pipelineVersion', 'payment_reemission_attempt.requestedAt', 'payment_reemission_attempt.recordedAt',
      'payment_reemission_attempt_transition.id', 'payment_reemission_attempt_transition.attemptId', 'payment_reemission_attempt_transition.fromState',
      'payment_reemission_attempt_transition.toState', 'payment_reemission_attempt_transition.stage', 'payment_reemission_attempt_transition.at',
      'payment_reemission_attempt_transition.recordedAt',
    ]);
    const fk = await db.query(`SELECT confrelid::regclass::text AS target FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text LIKE 'payment_reemission%'`);
    expect(fk.rows.map((r) => r.target)).toStrictEqual(['payment_reemission_attempt']); // the transition → its attempt; never the outbox
  });

  it('dry run: a published Payment row is pipeline_unknown, unattested and not executable; nothing is written', async () => {
    const id = await enqueue('payment.succeeded');
    const before = await snapshot();
    const r = await inspectPaymentReemission({ db, ownership }, { eventId: id, eventName: 'payment.succeeded' });
    expect(r).toStrictEqual({
      mode: 'dry_run', row: { rowEligible: false, reason: 'pipeline_unknown' }, conflictEvidence: 'conflict_evidence_unattested', executable: false,
      blockers: ['owner_authorization_unavailable', 'conflict_evidence_unattested', 'publication_not_available'],
    });
    expect(await snapshot()).toStrictEqual(before);
    expect(before.attempts + before.transitions).toBe(0);
  });

  it('dry run: the same R1 row checks over real rows (evidence a test supplies, to reach the later checks)', async () => {
    const evidence = { pipelineVersionOf: async () => 1 };
    const inspect = (eventId: string, eventName: string, deps = { db, ownership, evidence }) => inspectPaymentReemission(deps, { eventId, eventName }).then((r) => r.row);
    const ok = await enqueue('payment.failed');
    expect(await inspect(ok, 'payment.failed')).toMatchObject({ rowEligible: true, eventId: ok, eventName: 'payment.failed', eventVersion: 1, pipelineVersion: 1 });
    expect(await inspect(await enqueue('payment.cancelled', { published: false }), 'payment.cancelled')).toStrictEqual({ rowEligible: false, reason: 'row_unpublished' });
    expect(await inspect(randomUUID(), 'payment.expired')).toStrictEqual({ rowEligible: false, reason: 'row_missing' });
    expect(await inspect(ok, 'payment.succeeded')).toStrictEqual({ rowEligible: false, reason: 'row_name_mismatch' });
    expect(await inspect(await enqueue('payment.expired', { version: 2 }), 'payment.expired')).toStrictEqual({ rowEligible: false, reason: 'version_not_allowed' });
    expect(await inspect(await enqueue('payment.created'), 'payment.created')).toStrictEqual({ rowEligible: false, reason: 'event_not_allowed' });
    expect(await inspect(ok, 'payment.failed', { db, ownership, evidence: { pipelineVersionOf: async () => 2 } })).toStrictEqual({ rowEligible: false, reason: 'pipeline_incompatible' });
    expect((await snapshot()).attempts).toBe(0);
  });

  it('ownership: another database, or a Payment database whose migration record differs or is incomplete, is refused', async () => {
    const id = await enqueue('payment.succeeded');
    const evidence = { pipelineVersionOf: async () => 1 };
    expect((await inspectPaymentReemission({ db: foreign, ownership, evidence }, { eventId: id, eventName: 'payment.succeeded' })).row)
      .toStrictEqual({ rowEligible: false, reason: 'database_ownership_unconfirmed' });
    // a database whose record of 0009 has another checksum, then none at all (both on a throwaway copy of the bookkeeping only)
    const scratch = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'payment_r2a_owner');
    try {
      await runMigrations(scratch.url, [kitMigrationsDir, paymentMigrationsDir]);
      const s = new DbService({ url: scratch.url, max: 1 });
      try {
        const sid = await s.tx((q) => outbox.enqueue(q, { name: 'payment.succeeded', payload: { a: 1 } }));
        await s.query(`UPDATE outbox SET "publishedAt" = now() WHERE id = $1`, [sid]);
        const check = async () => (await inspectPaymentReemission({ db: s, ownership, evidence }, { eventId: sid, eventName: 'payment.succeeded' })).row;
        expect(await check()).toMatchObject({ rowEligible: true });
        await s.query(`UPDATE schema_migrations SET checksum = $1 WHERE name = '0009_reemission_attempt.sql'`, ['0'.repeat(64)]);
        expect(await check()).toStrictEqual({ rowEligible: false, reason: 'database_ownership_unconfirmed' });
        await s.query(`DELETE FROM schema_migrations WHERE name = '0009_reemission_attempt.sql'`);
        expect(await check()).toStrictEqual({ rowEligible: false, reason: 'database_ownership_unconfirmed' });
      } finally {
        await s.onApplicationShutdown();
      }
    } finally {
      await scratch.drop();
    }
  });

  it('the built CLI: one JSON line, read-only, no broker connection, no secret echoed; --apply refused (exit 2)', async () => {
    const id = await enqueue('payment.expired');
    const before = await snapshot();
    const broker: { server?: Server; connections: number } = { connections: 0 };
    broker.server = createServer((s) => {
      broker.connections++;
      s.destroy();
    });
    await new Promise<void>((r) => broker.server!.listen(0, '127.0.0.1', r));
    const port = (broker.server.address() as { port: number }).port;
    const run = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, ['dist/cli/reemission-dry-run.js', ...args], {
        cwd: appDir,
        env: { PATH: process.env.PATH, DATABASE_URL: testDb.url, RABBITMQ_URL: `amqp://payment-service:pw@127.0.0.1:${port}` },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => resolve({ code, out, err }));
    });
    try {
      const ok = await run(['--event-id', id, '--event-name', 'payment.expired']);
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.out)).toStrictEqual({
        mode: 'dry_run', row: { rowEligible: false, reason: 'pipeline_unknown' }, conflictEvidence: 'conflict_evidence_unattested', executable: false,
        blockers: ['owner_authorization_unavailable', 'conflict_evidence_unattested', 'publication_not_available'],
      });
      const apply = await run(['--event-id', id, '--event-name', 'payment.expired', '--apply']);
      expect(apply.code).toBe(2);
      expect(apply.err).toContain('there is no --apply');
      const payload = await run(['--event-id', id, '--event-name', 'payment.expired', '--payload', '{"forged":true}']);
      expect(payload.code).toBe(2);
      const password = new URL(testDb.url).password;
      for (const r of [ok, apply, payload]) expect(`${r.out}${r.err}`).not.toMatch(new RegExp(`${password}|forged|TND|synthetic`));
      expect(broker.connections).toBe(0);
      expect(await snapshot()).toStrictEqual(before);
    } finally {
      broker.server.close();
    }
  });

  describeWithEnv('0009 is append-only and the runtime role holds INSERT and SELECT only', ['TEST_DATABASE_ADMIN_URL'], () => {
    const suffix = randomBytes(4).toString('hex');
    const migrator = `r2a_mig_${suffix}`;
    const appRole = `r2a_app_${suffix}`;
    const dbName = `r2a_payment_${suffix}`;
    const migPw = randomBytes(12).toString('hex');
    const appPw = randomBytes(12).toString('hex');
    const urlFor = (user?: string, pw?: string) => {
      const u = new URL(env.TEST_DATABASE_ADMIN_URL);
      if (user) {
        u.username = user;
        u.password = pw!;
      }
      u.pathname = `/${dbName}`;
      return u.toString();
    };
    let app: pg.Client;
    let owner: pg.Client;

    beforeAll(async () => {
      // the provisioning of infra/postgres/init, as runtime-role.e2e-spec.ts reproduces it: the migrator owns, the runtime gets DML by default
      const admin = new pg.Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
      await admin.connect();
      try {
        await admin.query(`CREATE ROLE ${migrator} LOGIN PASSWORD '${migPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
        await admin.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${appPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
        await admin.query(`CREATE DATABASE ${dbName} OWNER ${migrator}`);
        await admin.query(`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
        await admin.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${appRole}`);
      } finally {
        await admin.end();
      }
      const scoped = new pg.Client({ connectionString: urlFor() });
      await scoped.connect();
      try {
        await scoped.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
        await scoped.query(`ALTER SCHEMA public OWNER TO ${migrator}`);
        await scoped.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
        await scoped.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`);
        await scoped.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${appRole}`);
      } finally {
        await scoped.end();
      }
      await runMigrations(urlFor(migrator, migPw), [kitMigrationsDir, paymentMigrationsDir]);
      app = new pg.Client({ connectionString: urlFor(appRole, appPw) });
      owner = new pg.Client({ connectionString: urlFor(migrator, migPw) });
      await app.connect();
      await owner.connect();
    });
    afterAll(async () => {
      await app?.end().catch(() => undefined);
      await owner?.end().catch(() => undefined);
      const admin = new pg.Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
      await admin.connect();
      try {
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
        await admin.query(`DROP ROLE IF EXISTS ${appRole}`);
        await admin.query(`DROP ROLE IF EXISTS ${migrator}`);
      } finally {
        await admin.end();
      }
    });

    const attempt = (extra: Record<string, unknown> = {}): [string, unknown[], string] => {
      const a = { id: randomUUID(), eventId: randomUUID(), eventName: 'payment.succeeded', eventVersion: 1, reason: 'consumer_outage', approvalRef: 'test-approval-1', environment: 'test', operation: 'event.reemit', pipelineVersion: 1, ...extra };
      return [`INSERT INTO payment_reemission_attempt (id, "eventId", "eventName", "eventVersion", reason, "approvalRef", environment, operation, "pipelineVersion", "requestedAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`, [a.id, a.eventId, a.eventName, a.eventVersion, a.reason, a.approvalRef, a.environment, a.operation, a.pipelineVersion], a.id];
    };
    const transition = (attemptId: string, from: string, to: string, stage: string | null = null): [string, unknown[]] =>
      [`INSERT INTO payment_reemission_attempt_transition ("attemptId", "fromState", "toState", stage, "at") VALUES ($1, $2, $3, $4, now())`, [attemptId, from, to, stage]];

    it('the runtime role can INSERT and SELECT a full attempt history', async () => {
      const [sql, params, id] = attempt();
      await app.query(sql, params);
      await app.query(...transition(id, 'requested', 'publishing'));
      await app.query(...transition(id, 'publishing', 'uncertain', 'confirm_timeout'));
      const { rows } = await app.query(`SELECT "toState" FROM payment_reemission_attempt_transition WHERE "attemptId" = $1 ORDER BY "recordedAt", "toState" DESC`, [id]);
      expect(rows.map((r) => r.toState)).toStrictEqual(['publishing', 'uncertain']);
      const grants = await owner.query(`SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name LIKE 'payment_reemission%' ORDER BY 1, 2`, [appRole]);
      expect(grants.rows.map((r) => `${r.table_name}:${r.privilege_type}`)).toStrictEqual([
        'payment_reemission_attempt:INSERT', 'payment_reemission_attempt:SELECT', 'payment_reemission_attempt_transition:INSERT', 'payment_reemission_attempt_transition:SELECT',
      ]);
    });

    it('UPDATE, DELETE and TRUNCATE are refused: by privilege for the runtime, by trigger even for the owner', async () => {
      const [sql, params, id] = attempt();
      await app.query(sql, params);
      await app.query(...transition(id, 'requested', 'publishing'));
      await app.query(...transition(id, 'publishing', 'uncertain', 'channel_closed'));
      for (const table of ['payment_reemission_attempt', 'payment_reemission_attempt_transition']) {
        const key = table === 'payment_reemission_attempt' ? 'id' : '"attemptId"';
        await expect(app.query(`UPDATE ${table} SET "recordedAt" = now() WHERE ${key} = $1`, [id])).rejects.toThrow(/permission denied/);
        await expect(app.query(`DELETE FROM ${table} WHERE ${key} = $1`, [id])).rejects.toThrow(/permission denied/);
        await expect(app.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/permission denied/);
        await expect(owner.query(`UPDATE ${table} SET "recordedAt" = now() WHERE ${key} = $1`, [id])).rejects.toThrow(/append-only: UPDATE is refused/);
        await expect(owner.query(`DELETE FROM ${table} WHERE ${key} = $1`, [id])).rejects.toThrow(/append-only: DELETE is refused/);
      }
      await expect(owner.query(`TRUNCATE payment_reemission_attempt_transition`)).rejects.toThrow(/append-only: TRUNCATE is refused/);
      await expect(owner.query(`TRUNCATE payment_reemission_attempt CASCADE`)).rejects.toThrow(/append-only: TRUNCATE is refused/);
    });

    it('an outcome is recorded once, from a reached state, and never replaced (uncertain included)', async () => {
      const [sql, params, id] = attempt();
      await app.query(sql, params);
      await expect(app.query(...transition(id, 'requested', 'confirmed'))).rejects.toThrow(/payment_reemission_transition_allowed/);
      await expect(app.query(...transition(id, 'publishing', 'confirmed'))).rejects.toThrow(/publishing was never reached/);
      await app.query(...transition(id, 'requested', 'publishing'));
      await app.query(...transition(id, 'publishing', 'uncertain', 'confirm_timeout'));
      await expect(app.query(...transition(id, 'publishing', 'confirmed'))).rejects.toThrow(/payment_reemission_transition_once/);
      await expect(app.query(...transition(id, 'uncertain', 'confirmed'))).rejects.toThrow(/payment_reemission_transition_allowed/);
      await expect(app.query(...transition(randomUUID(), 'requested', 'publishing'))).rejects.toThrow(/foreign key/);
    });

    it.each([
      ['another event', { eventName: 'payment.created' }, 'payment_reemission_attempt_event'],
      ['a pattern', { eventName: 'payment.*' }, 'payment_reemission_attempt_event'],
      ['a code-bearing Auth event', { eventName: 'member.contact_verification_requested' }, 'payment_reemission_attempt_event'],
      ['version 2', { eventVersion: 2 }, 'payment_reemission_attempt_event'],
      ['another pipeline', { pipelineVersion: 2 }, 'payment_reemission_attempt_pipeline'],
      ['another operation', { operation: 'event.publish' }, 'payment_reemission_attempt_operation'],
      ['free-text reason', { reason: 'the Owner said so' }, 'payment_reemission_attempt_reason'],
      ['an unbounded approval reference', { approvalRef: 'x'.repeat(129) }, 'payment_reemission_attempt_approval_ref'],
    ])('refuses an attempt with %s', async (_t, extra, constraint) => {
      const [sql, params] = attempt(extra);
      await expect(app.query(sql, params)).rejects.toThrow(new RegExp(constraint));
    });

    it.each([
      ['a failure without its stage', 'failed', null],
      ['an uncertain outcome with a failure stage', 'uncertain', 'nacked'],
      ['a confirmed outcome with a stage', 'confirmed', 'confirm_timeout'],
      ['free text as stage', 'failed', 'broker said: access refused for payment-service'],
    ])('refuses %s', async (_t, to, stage) => {
      const [sql, params, id] = attempt();
      await app.query(sql, params);
      await app.query(...transition(id, 'requested', 'publishing'));
      await expect(app.query(...transition(id, 'publishing', to, stage))).rejects.toThrow(/payment_reemission_transition_allowed/);
    });
  });
});
