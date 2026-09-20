import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { organizationMigrationsDir } from '../src/app.module.js';
import { CompanyRepository } from '../src/companies/company.repository.js';
import { ACTIVATE_CONFIRMATION, OwnershipAdmin, OwnershipError, type OwnershipLogEvent } from '../src/ownership/ownership-admin.js';
import { activateOwnership, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { client, sql } from './support/fixtures.js';
import { ID, baseData, snapshotText } from './support/snapshot.js';

async function failsWith(url: string, text: string, params: unknown[] = []): Promise<{ code?: string; message?: string }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(text, params);
    return {};
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as Error).message };
  } finally {
    await c.end();
  }
}

describeWithEnv('ownership transition: state machine, gates, import, invariants (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const ADMIN = env.TEST_DATABASE_ADMIN_URL;
  const dbs: TestDatabase[] = [];
  const dbSvcs: DbService[] = [];

  async function migrated(prefix: string): Promise<TestDatabase> {
    const db = await createTestDatabase(ADMIN, prefix);
    dbs.push(db);
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    return db;
  }
  function adminFor(db: TestDatabase, environment = 'test', productionActivationEnabled = false) {
    const svc = new DbService({ url: db.url, max: 2 });
    dbSvcs.push(svc);
    const events: { event: OwnershipLogEvent; fields: Record<string, unknown> }[] = [];
    const a = new OwnershipAdmin(svc, { environment, correlationId: 'corr-1', log: (event, fields) => events.push({ event, fields }), productionActivationEnabled });
    return { a, events };
  }
  const state = async (db: TestDatabase) => (await sql(db.url, 'SELECT phase, environment_class, authoritative, verified_digest FROM ownership_state'))[0]!;
  const counts = async (db: TestDatabase) => (await sql(db.url, `SELECT (SELECT count(*) FROM company)::int AS c, (SELECT count(*) FROM platform)::int AS p, (SELECT count(*) FROM organization)::int AS o`))[0]!;
  const refused = async (p: Promise<unknown>): Promise<OwnershipError> => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(OwnershipError);
      return e as OwnershipError;
    }
    throw new Error('expected the operation to be refused');
  };

  afterAll(async () => {
    await Promise.all(dbSvcs.map((s) => s.onApplicationShutdown().catch(() => undefined)));
    await Promise.all(dbs.map((d) => d.drop()));
  });

  describe('the migration is inert, and deployment does not activate authority', () => {
    it('leaves a migrated database PREPARED, not authoritative, with no event and no data moved', async () => {
      const db = await migrated('own_inert');
      expect(await state(db)).toEqual({ phase: 'PREPARED', environment_class: null, authoritative: false, verified_digest: null });
      expect(await counts(db)).toEqual({ c: 0, p: 0, o: 0 });
      expect((await sql(db.url, 'SELECT count(*)::int AS n FROM ownership_event'))[0].n).toBe(0);
    });
    it('booting the application (deployment, startup, health checks, connections) leaves the state untouched', async () => {
      const db = await migrated('own_boot');
      const t: TestApp = await createTestApp({ databaseUrl: db.url, ownership: 'inactive' });
      try {
        for (let i = 0; i < 3; i++) {
          expect((await t.http().get('/health')).status).toBe(200);
          expect((await t.http().get('/ready')).status).toBe(200);
        }
        expect(await state(db)).toMatchObject({ phase: 'PREPARED', authoritative: false });
        expect((await sql(db.url, 'SELECT count(*)::int AS n FROM ownership_event'))[0].n).toBe(0);
      } finally {
        await t.app.close();
      }
    });
  });

  describe('the API by ownership state', () => {
    it('refuses every hierarchy write AND every service read with 409 not_authoritative while inactive, and accepts them once authoritative', async () => {
      const db = await migrated('own_api');
      const t = await createTestApp({ databaseUrl: db.url, ownership: 'inactive' });
      try {
        const c = client(t);
        const w = await c.post('/organization/companies', { name: 'Acme' });
        expect(w.status).toBe(409);
        expect(w.body.code).toBe('not_authoritative');
        expect((await c.post('/organization/platforms', { companyId: ID.co, name: 'P' })).status).toBe(409);
        expect((await c.post('/organization/organizations', { platformId: ID.p1, name: 'O' })).status).toBe(409);
        expect((await c.patch(`/organization/companies/${ID.co}`, { name: 'X' })).status).toBe(409);
        expect((await c.get('/organization/companies')).status).toBe(409); // service reads open once authoritative (a fresh environment excepted)
        expect((await sql(db.url, 'SELECT count(*)::int AS n FROM company'))[0].n).toBe(0);

        await activateOwnership(db.url); // the state is read per request: no restart is involved
        expect((await c.post('/organization/companies', { name: 'Acme' })).status).toBe(201);
      } finally {
        await t.app.close();
      }
    });
  });

  describe('least privilege: the runtime role cannot move ownership, write the audit, or delete', () => {
    const ROLE = 'organization_app';
    let db: TestDatabase;
    let rt: string;
    beforeAll(async () => {
      const a = new pg.Client({ connectionString: ADMIN });
      await a.connect();
      await a.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$`);
      await a.end();
      db = await createTestDatabase(ADMIN, 'own_role');
      dbs.push(db);
      // The infrastructure grants DML on every table the migrator creates; the migration then narrows it (as in production).
      await sql(db.url, `GRANT USAGE ON SCHEMA public TO ${ROLE}`);
      await sql(db.url, `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}`);
      await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
      const u = new URL(db.url);
      u.username = ROLE;
      rt = u.toString();
    });
    afterAll(async () => {
      await sql(db.url, `DROP OWNED BY ${ROLE}`).catch(() => undefined);
    });

    it('can read the ownership state but never change it, write the audit or the import record, or touch the ledger', async () => {
      expect((await sql(rt, 'SELECT phase FROM ownership_state'))[0].phase).toBe('PREPARED');
      expect((await failsWith(rt, `UPDATE ownership_state SET phase = 'VERIFIED'`)).code).toBe('42501');
      expect((await failsWith(rt, `INSERT INTO ownership_event (operation, actor, environment, outcome) VALUES ('x','y','z','succeeded')`)).code).toBe('42501');
      expect((await failsWith(rt, `INSERT INTO ownership_import_run (snapshot_digest, final, counts, inserted, skipped, actor) VALUES ('d', false, '{}', '{}', '{}', 'a')`)).code).toBe('42501');
      expect((await failsWith(rt, `INSERT INTO hierarchy_id_ledger (id, entity) VALUES (gen_random_uuid(), 'company')`)).code).toBe('42501');
    });
    it('cannot write the hierarchy while not authoritative (the database gate), and cannot delete or truncate it even afterwards', async () => {
      expect((await failsWith(rt, `INSERT INTO company (name) VALUES ('Gate')`)).code).toBe('55000');
      await activateOwnership(db.url);
      expect((await failsWith(rt, `INSERT INTO company (name) VALUES ('Gate')`)).code).toBeUndefined();
      expect((await failsWith(rt, `DELETE FROM company`)).code).toBe('42501');
      expect((await failsWith(rt, `TRUNCATE company, platform, organization`)).code).toBe('42501');
    });
  });

  describe('the state machine at the database level: the one-way door', () => {
    it('refuses every illegal transition, missing evidence, a changed environment class and a delete', async () => {
      const db = await migrated('own_sm');
      const bad = async (q: string) => (await failsWith(db.url, q)).code;
      expect(await bad(`UPDATE ownership_state SET phase = 'ACTIVE'`)).toBe('55000'); // no skipping
      expect(await bad(`UPDATE ownership_state SET phase = 'VERIFIED', verified_digest = 'd'`)).toBe('55000'); // no class declared
      await sql(db.url, `UPDATE ownership_state SET environment_class = 'existing'`);
      expect(await bad(`UPDATE ownership_state SET environment_class = 'fresh'`)).toBe('55000');
      expect(await bad(`UPDATE ownership_state SET phase = 'VERIFIED'`)).toBe('55000'); // no digest
      await sql(db.url, `UPDATE ownership_state SET phase = 'VERIFIED', verified_digest = 'd'`);
      expect(await bad(`UPDATE ownership_state SET phase = 'ACTIVATABLE', approved_by = 'a', approved_reference = 'r', approved_at = now()`)).toBe('55000'); // existing must freeze
      await sql(db.url, `UPDATE ownership_state SET phase = 'FROZEN'`);
      expect(await bad(`UPDATE ownership_state SET phase = 'ACTIVATABLE'`)).toBe('55000'); // no recorded approval
      await sql(db.url, `UPDATE ownership_state SET phase = 'ACTIVATABLE', approved_by = 'a', approved_reference = 'r', approved_at = now()`);
      expect(await bad(`UPDATE ownership_state SET phase = 'ACTIVE'`)).toBe('55000'); // no recorded activation
      await sql(db.url, `UPDATE ownership_state SET phase = 'ACTIVE', activated_by = 'a', activated_at = now()`);
      for (const back of ['PREPARED', 'VERIFIED', 'FROZEN', 'ACTIVATABLE']) expect(await bad(`UPDATE ownership_state SET phase = '${back}'`), back).toBe('55000');
      expect(await bad(`UPDATE ownership_state SET approved_by = 'other'`)).toBe('55000'); // immutable once authoritative
      expect(await bad(`DELETE FROM ownership_state`)).toBe('55000');
      expect((await state(db)).authoritative).toBe(true);
    });
    it('allows a rollback to PREPARED before activation and clears all the evidence', async () => {
      const db = await migrated('own_sm2');
      await sql(db.url, `UPDATE ownership_state SET environment_class = 'fresh'`);
      await sql(db.url, `UPDATE ownership_state SET phase = 'VERIFIED', verified_digest = 'd'`);
      await sql(db.url, `UPDATE ownership_state SET phase = 'ACTIVATABLE', approved_by = 'a', approved_reference = 'r', approved_at = now()`);
      await sql(db.url, `UPDATE ownership_state SET phase = 'PREPARED'`);
      expect(await sql(db.url, `SELECT phase, verified_digest, approved_by, approved_reference, approved_at FROM ownership_state`)).toEqual([
        { phase: 'PREPARED', verified_digest: null, approved_by: null, approved_reference: null, approved_at: null },
      ]);
    });
    it('the audit, the import record and the id ledger are append-only', async () => {
      const db = await migrated('own_append');
      await sql(db.url, `INSERT INTO ownership_event (operation, actor, environment, outcome) VALUES ('op','someone','test','succeeded')`);
      expect((await failsWith(db.url, `UPDATE ownership_event SET actor = 'x'`)).code).toBe('55000');
      expect((await failsWith(db.url, `DELETE FROM ownership_event`)).code).toBe('55000');
      expect((await failsWith(db.url, `TRUNCATE ownership_event`)).code).toBe('55000');
    });
  });

  describe('I1 and I2', () => {
    it('I1: an id is never reused: not even after the schema owner discards a prepared row, and not across tables', async () => {
      const db = await migrated('own_i1');
      await sql(db.url, `INSERT INTO company (id, name) VALUES ('${ID.co}', 'Old')`);
      await sql(db.url, `DELETE FROM company WHERE id = '${ID.co}'`); // pre-activation: a prepared copy may be discarded
      const r = await failsWith(db.url, `INSERT INTO company (id, name) VALUES ('${ID.co}', 'New')`);
      expect(r.code).toBe('23505');
      expect(r.message).toMatch(/never reused \(I1\)/);
      await sql(db.url, `INSERT INTO company (id, name) VALUES ('${ID.p1}', 'C2')`);
      expect((await failsWith(db.url, `INSERT INTO platform (id, "companyId", name) VALUES ('${ID.p1}', '${ID.p1}', 'as a platform')`)).code).toBe('23505');
    });
    it('I2(a): an existing relationship cannot be reparented or mutated', async () => {
      const db = await migrated('own_i2a');
      await sql(db.url, `INSERT INTO company (id, name) VALUES ('${ID.co}', 'A'), ('c0000000-0000-4000-8000-000000000009', 'B')`);
      await sql(db.url, `INSERT INTO platform (id, "companyId", name) VALUES ('${ID.p1}', '${ID.co}', 'P')`);
      await sql(db.url, `INSERT INTO organization (id, "platformId", name) VALUES ('${ID.o1}', '${ID.p1}', 'O')`);
      expect((await failsWith(db.url, `UPDATE platform SET "companyId" = 'c0000000-0000-4000-8000-000000000009' WHERE id = '${ID.p1}'`)).code).not.toBeUndefined();
      expect((await failsWith(db.url, `UPDATE organization SET "platformId" = '${ID.p1}', id = gen_random_uuid() WHERE id = '${ID.o1}'`)).code).not.toBeUndefined();
    });
    it('I2(b): once authoritative no role deletes or truncates a hierarchy row, and normal lifecycle beyond that is NOT decided here', async () => {
      const db = await migrated('own_i2b');
      await sql(db.url, `INSERT INTO company (id, name) VALUES ('${ID.co}', 'A')`);
      await activateOwnership(db.url);
      expect((await failsWith(db.url, `DELETE FROM company WHERE id = '${ID.co}'`)).code).toBe('55000');
      expect((await failsWith(db.url, `TRUNCATE company CASCADE`)).code).toBe('55000');
      expect((await counts(db)).c).toBe(1);
    });
  });

  describe('existing environment: prepare, import, verify, freeze, approve, activate, retire', () => {
    it('walks the whole sequence; import never activates; the switch is explicit and separately gated', async () => {
      const db = await migrated('own_existing');
      const { a, events } = adminFor(db);

      await refused(a.importSnapshot('op', snapshotText())); // no class declared yet
      await a.declareClass('op', 'existing');
      await refused(a.declareClass('op', 'fresh')); // once only

      // Prepare: an offline verification touches no database; a corrupted artifact is refused, nothing is written.
      a.verifySnapshotText('op', snapshotText());
      const corrupted = JSON.parse(snapshotText());
      corrupted.tables.company[0].name = 'Tampered';
      expect((await refused(a.importSnapshot('op', JSON.stringify(corrupted)))).code).toBe('snapshot_invalid');
      expect(await counts(db)).toEqual({ c: 0, p: 0, o: 0 });

      // Import: exact insert; the phase moves to VERIFIED; authority is NOT active.
      const first = await a.importSnapshot('op', snapshotText());
      expect(first).toMatchObject({ inserted: { company: 1, platform: 2, organization: 2 }, skipped: { company: 0, platform: 0, organization: 0 }, phase: 'VERIFIED' });
      expect(await state(db)).toMatchObject({ phase: 'VERIFIED', authoritative: false, environment_class: 'existing' });
      expect(await counts(db)).toEqual({ c: 1, p: 2, o: 2 });

      // Repeat: identical rows are skipped, nothing changes.
      const again = await a.importSnapshot('op', snapshotText());
      expect(again.inserted).toEqual({ company: 0, platform: 0, organization: 0 });
      expect(again.skipped).toEqual({ company: 1, platform: 2, organization: 2 });

      // A changed snapshot is rejected and nothing is overwritten.
      const changed = baseData();
      changed.platform[0]!.name = 'Renamed';
      expect((await refused(a.importSnapshot('op', snapshotText(changed)))).code).toBe('conflicting_row');
      expect((await sql(db.url, `SELECT name FROM platform WHERE id = '${ID.p1}'`))[0].name).toBe('Alpha');

      // A snapshot that lacks a row this service already holds is rejected: nothing is deleted or reconciled.
      const missing = baseData();
      missing.organization.pop();
      expect((await refused(a.importSnapshot('op', snapshotText(missing)))).code).toBe('extra_destination_row');
      expect((await counts(db)).o).toBe(2);

      // An additive delta (a new organization created in Auth since) is inserted; the rest is skipped.
      const more = baseData();
      more.organization.push({ id: 'b0000000-0000-4000-8000-000000000003', platformId: ID.p1, name: 'Org Three', taxCode: null, address: null, phone: null, type: null, createdAt: '2024-05-06T07:08:09.000001Z', updatedAt: '2024-05-06T07:08:09.000001Z' });
      const delta = await a.importSnapshot('op', snapshotText(more));
      expect(delta.inserted.organization).toBe(1);

      // Not approvable or activatable yet: no approval before FROZEN, no activation before ACTIVATABLE.
      expect((await refused(a.approve('op', 'rehearsal-1'))).code).toBe('not_approvable');
      expect((await refused(a.activate('op', ACTIVATE_CONFIRMATION))).code).toBe('not_activatable');

      // Freeze: only a snapshot taken under the freeze is importable; a stale one is refused.
      const final = await a.importSnapshot('op', snapshotText(more, true));
      expect(final.phase).toBe('FROZEN');
      expect((await refused(a.importSnapshot('op', snapshotText(more, false)))).code).toBe('stale_import_after_freeze');

      // Approval records who and what; it does not activate. Activation needs the phase, the confirmation and an unchanged digest.
      expect((await refused(a.approve('op', '   '))).code).toBe('reference_required');
      await a.approve('approver', 'rehearsal-2026-10-01');
      expect(await state(db)).toMatchObject({ phase: 'ACTIVATABLE', authoritative: false });
      expect((await refused(a.importSnapshot('op', snapshotText(more, true)))).code).toBe('import_after_approval');
      expect((await refused(a.activate('op', 'yes please'))).code).toBe('confirmation_required');
      expect(await state(db)).toMatchObject({ authoritative: false });

      // A change after verification blocks activation.
      await sql(db.url, `UPDATE organization SET name = 'Sneaky' WHERE id = '${ID.o1}'`);
      expect((await refused(a.activate('op', ACTIVATE_CONFIRMATION))).code).toBe('content_changed_since_verification');
      await sql(db.url, `UPDATE organization SET name = 'Org One' WHERE id = '${ID.o1}'`);

      // ACTIVATE AUTHORITY: the one explicit switch.
      await a.activate('op', ACTIVATE_CONFIRMATION);
      expect(await state(db)).toMatchObject({ phase: 'ACTIVE', authoritative: true });

      // The one-way door: no rollback, no more imports, no deletion.
      expect((await refused(a.rollback('op', 'oops'))).code).toBe('rollback_after_activation');
      expect((await refused(a.importSnapshot('op', snapshotText(more, true)))).code).toBe('import_after_approval');
      expect((await failsWith(db.url, `UPDATE ownership_state SET phase = 'PREPARED'`)).code).toBe('55000');

      // Retire: a recorded attestation; then still no rollback.
      expect((await refused(a.retire('op', ' '))).code).toBe('evidence_required');
      await a.retire('op', 'auth hierarchy_authority marker: org_authoritative');
      expect((await state(db)).phase).toBe('RETIRED');
      expect((await refused(a.rollback('op', 'again'))).code).toBe('rollback_after_activation');

      // Every attempt is auditable: actor, environment, correlation id, from/to, digest.
      const ev = await sql(db.url, `SELECT operation, outcome, actor, environment, correlation_id, from_phase, to_phase, snapshot_digest FROM ownership_event ORDER BY id`);
      expect(ev.every((e) => e.actor && e.environment === 'test' && e.correlation_id === 'corr-1')).toBe(true);
      expect(ev.filter((e) => e.operation === 'activate' && e.outcome === 'succeeded')).toHaveLength(1);
      expect(ev.find((e) => e.operation === 'activate' && e.outcome === 'succeeded')).toMatchObject({ from_phase: 'ACTIVATABLE', to_phase: 'ACTIVE' });
      expect(ev.find((e) => e.operation === 'import' && e.outcome === 'succeeded' && e.snapshot_digest)).toBeTruthy();
      expect(ev.filter((e) => e.operation === 'rollback' && e.outcome === 'rejected')).toHaveLength(2);
      expect((await sql(db.url, 'SELECT count(*)::int AS n FROM ownership_import_run'))[0].n).toBe(4); // only SUCCESSFUL imports: initial, repeat, delta, final

      // The named, observable events, and no secret in any of them.
      const names = new Set(events.map((e) => e.event));
      for (const n of ['ownership_snapshot_verified', 'ownership_import_started', 'ownership_import_succeeded', 'ownership_import_failed', 'ownership_activation_requested', 'ownership_activation_succeeded', 'ownership_activation_rejected', 'ownership_retirement_completed', 'ownership_rollback_rejected'] as const) {
        expect(names.has(n), n).toBe(true);
      }
      expect(JSON.stringify(events)).not.toMatch(/password|secret|token|bearer/i);
    });

    it('rolls back before activation: back to PREPARED with the evidence cleared, and the import can be repeated', async () => {
      const db = await migrated('own_rollback');
      const { a } = adminFor(db);
      await a.declareClass('op', 'existing');
      await a.importSnapshot('op', snapshotText(baseData(), true));
      await a.approve('op', 'ref');
      expect((await state(db)).phase).toBe('ACTIVATABLE');
      await a.rollback('op', 'rehearsal found a problem');
      expect(await state(db)).toMatchObject({ phase: 'PREPARED', verified_digest: null });
      expect((await a.importSnapshot('op', snapshotText(baseData(), true))).skipped.company).toBe(1);
    });

    it('refuses an import that would leave the hierarchy inconsistent, before any write', async () => {
      const db = await migrated('own_badimport');
      const { a } = adminFor(db);
      await a.declareClass('op', 'existing');
      const broken = baseData();
      broken.organization[0]!.platformId = ID.co; // an organization hanging off a company id
      expect((await refused(a.importSnapshot('op', snapshotText(broken)))).code).toBe('snapshot_invalid');
      const dupe = baseData();
      dupe.organization[0]!.id = ID.p1; // an id reused across tables
      expect((await refused(a.importSnapshot('op', snapshotText(dupe)))).code).toBe('snapshot_invalid');
      expect(await counts(db)).toEqual({ c: 0, p: 0, o: 0 });
    });

    it('production activation is separately gated: without the deliberate run-time gate it is refused even when ACTIVATABLE', async () => {
      const db = await migrated('own_prod');
      const closed = adminFor(db, 'production', false);
      await closed.a.declareClass('op', 'existing');
      await closed.a.importSnapshot('op', snapshotText(baseData(), true));
      await closed.a.approve('approver', 'rehearsal-ref');
      expect((await refused(closed.a.activate('op', ACTIVATE_CONFIRMATION))).code).toBe('production_gate_closed');
      expect((await state(db)).authoritative).toBe(false);
      const open = adminFor(db, 'production', true);
      await open.a.activate('op', ACTIVATE_CONFIRMATION);
      expect((await state(db)).authoritative).toBe(true);
      expect((await sql(db.url, `SELECT environment FROM ownership_event WHERE operation = 'activate' AND outcome = 'succeeded'`))[0].environment).toBe('production');
    });
  });

  describe('the artifact auth-service actually produces', () => {
    it('imports exactly, and what this service then holds has the same content digest as the artifact', async () => {
      const db = await migrated('own_golden');
      const { a } = adminFor(db);
      await a.declareClass('op', 'existing');
      const text = readFileSync(join(import.meta.dirname, 'fixtures/hierarchy-snapshot.v1.json'), 'utf8');
      const verified = a.verifySnapshotText('op', text);
      const r = await a.importSnapshot('op', text);
      expect(r.inserted).toEqual({ company: 1, platform: 2, organization: 2 });
      expect(await a.contentDigestNow()).toBe(verified.content);
      expect((await state(db)).verified_digest).toBe(verified.content);
    });
  });

  describe('fresh environment: bootstrap, verify, approve, activate (nothing to import or freeze)', () => {
    it('allows only the first-Company bootstrap while inactive, and activates only through the same explicit gates', async () => {
      const db = await migrated('own_fresh');
      const t = await createTestApp({ databaseUrl: db.url, ownership: 'inactive' });
      const { a } = adminFor(db);
      try {
        const companies = t.app.get(CompanyRepository);
        // Before the class is declared, nothing can bootstrap.
        await expect(companies.create('provisioning', 'key-000001', { name: 'First' }, { bootstrap: true })).rejects.toMatchObject({ status: 409 });
        await a.declareClass('op', 'fresh');
        expect((await refused(a.importSnapshot('op', snapshotText())))).toMatchObject({ code: 'import_not_applicable' }); // a fresh environment imports nothing
        await expect(companies.create('provisioning', 'key-000002', { name: 'Second' })).rejects.toMatchObject({ status: 409 }); // not the bootstrap path
        expect((await refused(a.verifyContent('op', 'x'.repeat(64)))).code).toBe('verification_mismatch');
        expect((await refused(a.verifyContent('op', await a.contentDigestNow()))).code).toBe('nothing_to_verify'); // no Company yet

        const first = await companies.create('provisioning', 'key-000003', { name: 'First Company' }, { bootstrap: true });
        expect(first.replayed).toBe(false);
        expect(await state(db)).toMatchObject({ phase: 'PREPARED', authoritative: false }); // the bootstrap does not activate

        const v = await a.verifyContent('op', await a.contentDigestNow());
        expect(v.phase).toBe('VERIFIED');
        // Once verified, no further bootstrap.
        await expect(companies.create('provisioning', 'key-000004', { name: 'Another' }, { bootstrap: true })).rejects.toMatchObject({ status: 409 });

        await a.approve('approver', 'fresh-rehearsal-1');
        expect((await state(db)).phase).toBe('ACTIVATABLE'); // no FROZEN phase: there is no legacy authority to freeze
        expect((await refused(a.activate('op', ''))).code).toBe('confirmation_required');
        await a.activate('op', ACTIVATE_CONFIRMATION);
        expect((await state(db)).authoritative).toBe(true);
        expect((await refused(a.rollback('op', 'no'))).code).toBe('rollback_after_activation');
        expect((await client(t).post('/organization/companies', { name: 'After' })).status).toBe(201);
      } finally {
        await t.app.close();
      }
    });
  });

  describe('an existing-state database upgrades without moving any authority', () => {
    it('keeps every row and id, records their ids in the ledger, starts PREPARED, and refuses to reuse an id', async () => {
      const db = await createTestDatabase(ADMIN, 'own_upgrade');
      dbs.push(db);
      const old = mkdtempSync(join(tmpdir(), 'org-mig-'));
      for (const f of readdirSync(organizationMigrationsDir).filter((f) => /^000[123]_/.test(f))) copyFileSync(join(organizationMigrationsDir, f), join(old, f));
      const before = await runMigrations(db.url, [kitMigrationsDir, old]);
      expect(before.applied.filter((f) => f.startsWith('0')).at(-1)).toBe('0003_platform_key.sql');
      await sql(db.url, `INSERT INTO company (id, name) VALUES ('${ID.co}', 'Legacy')`);
      await sql(db.url, `INSERT INTO platform (id, "companyId", name, key) VALUES ('${ID.p1}', '${ID.co}', 'Legacy P', 'legacy')`);
      await sql(db.url, `INSERT INTO organization (id, "platformId", name) VALUES ('${ID.o1}', '${ID.p1}', 'Legacy O')`);

      const after = await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
      expect(after.applied).toEqual(['0004_ownership_transition.sql']);
      expect(await counts(db)).toEqual({ c: 1, p: 1, o: 1 });
      expect(await state(db)).toMatchObject({ phase: 'PREPARED', authoritative: false });
      expect((await sql(db.url, 'SELECT count(*)::int AS n FROM hierarchy_id_ledger'))[0].n).toBe(3);
      await sql(db.url, `DELETE FROM organization WHERE id = '${ID.o1}'`); // pre-activation, by the schema owner
      expect((await failsWith(db.url, `INSERT INTO organization (id, "platformId", name) VALUES ('${ID.o1}', '${ID.p1}', 'again')`)).code).toBe('23505');
    });
  });
});
