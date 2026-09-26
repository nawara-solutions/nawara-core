import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { AuditRecordRepository, sameEvidence } from '../src/persistence/audit-record.repository.js';
import type { NewAuditRecord } from '../src/persistence/audit-record.types.js';
import { AuditPersistenceError } from '../src/persistence/persistence-error.js';
import { createTestApp, type TestApp } from './support/app.js';
import { failure, sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Stage 18.3: the append-only `audit_record` on real PostgreSQL, provisioned as `infra/postgres/init` does (the migrator owns the schema;
 * the runtime role starts with the Core default grants SELECT, INSERT, UPDATE, DELETE). Proves: the schema's invariants, the runtime role
 * can only INSERT and SELECT, the triggers as a second layer and their exact limit (the owner and a superuser), the database clock,
 * idempotency under concurrency, the repository API, and index use at a realistic size.
 */
const USER = '3b9d6c1e-8f2a-4c3d-9e1f-0a1b2c3d4e5f';
const ORG = '7c1e2d3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5';
const MEMBERSHIP = '9d2f3a4b-5c6d-4e7f-8a9b-c0d1e2f3a4b5';

const valid = (over: Partial<NewAuditRecord> = {}): NewAuditRecord => ({
  eventId: randomUUID(),
  sourceService: 'organization-service',
  action: 'membership.revoked',
  category: 'business',
  schemaVersion: 1,
  actor: { type: 'user', id: USER, userKind: 'owner' },
  organizationId: ORG,
  resource: { type: 'membership', id: MEMBERSHIP },
  subject: { type: 'user', id: USER },
  outcome: 'succeeded',
  changes: { status: { from: 'active', to: 'revoked' } },
  correlationId: 'corr-0001-abcdef',
  causationId: null,
  occurredAt: new Date('2026-09-25T10:00:00.000Z'),
  ...over,
});

describeWithEnv('audit_record: append-only persistence (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  let repo: AuditRecordRepository;
  let app: pg.Client;
  const count = async () => Number((await sql<{ n: string }>(d.adminUrl, 'SELECT count(*) AS n FROM audit_record'))[0]!.n);

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'aup');
    const first = await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    expect(first.applied).toContain('0001_audit_record.sql');
    expect((await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir])).applied).toEqual([]); // re-run: nothing
    t = await createTestApp({ databaseUrl: d.appUrl }); // the RUNTIME role, through the real module graph
    repo = t.app.get(AuditRecordRepository);
    app = new pg.Client({ connectionString: d.appUrl });
    await app.connect();
  });
  afterAll(async () => {
    await app?.end();
    await t?.app.close();
    await d?.drop();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────── migrations and the catalog

  it('an 18.2 foundation database upgrades to the current schema (0001, 18.6\'s 0002 index, 18.8\'s 0003 retention), then re-runs as a no-op', async () => {
    const up = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'auu');
    try {
      const foundation = await runMigrations(up.migratorUrl, [kitMigrationsDir]); // the 18.2 state: the kit baseline, no audit migration
      expect(foundation.applied.every((n) => n.startsWith('kit_'))).toBe(true);
      const upgrade = await runMigrations(up.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
      expect(upgrade.applied).toEqual(['0001_audit_record.sql', '0002_audit_record_time_idx.sql', '0003_retention.sql']);
      expect((await runMigrations(up.migratorUrl, [kitMigrationsDir, auditMigrationsDir])).applied).toEqual([]);
      const grants = await sql<{ p: string }>(up.adminUrl, `SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE table_name = 'audit_record' AND grantee = $1 ORDER BY 1`, [up.app]);
      expect(grants.map((g) => g.p)).toEqual(['INSERT', 'SELECT']);
    } finally {
      await up.drop();
    }
  });

  it('one table, the frozen columns only: identifiers and codes, no name, contact, address, token, payload or snapshot column; no foreign key', async () => {
    const cols = await sql<{ c: string; t: string; n: string }>(d.adminUrl,
      `SELECT column_name AS c, data_type AS t, is_nullable AS n FROM information_schema.columns WHERE table_name = 'audit_record' ORDER BY ordinal_position`);
    expect(cols.map((c) => c.c)).toEqual(['id', 'eventId', 'sourceService', 'action', 'category', 'schemaVersion', 'actorType', 'actorId', 'userKind',
      'organizationId', 'resourceType', 'resourceId', 'subjectType', 'subjectId', 'outcome', 'changes', 'correlationId', 'causationId', 'occurredAt', 'recordedAt']);
    expect(Object.fromEntries(cols.map((c) => [c.c, c.n])) as Record<string, string>).toMatchObject({
      eventId: 'NO', sourceService: 'NO', action: 'NO', category: 'NO', actorType: 'NO', actorId: 'NO', resourceType: 'NO', resourceId: 'NO', occurredAt: 'NO', recordedAt: 'NO',
      organizationId: 'YES', userKind: 'YES', subjectType: 'YES', changes: 'YES', correlationId: 'YES', causationId: 'YES',
    });
    for (const c of cols) expect(c.c).not.toMatch(/email|phone|name|ip|agent|password|token|secret|payload|snapshot|metadata|updated/i);
    expect(await sql(d.adminUrl, `SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid = 'audit_record'::regclass`)).toEqual([]);
    const tables = await sql<{ t: string }>(d.adminUrl, `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('outbox', 'inbox', 'kit_rate_limit', 'schema_migrations')`);
    // Stage 18.8: plus the retention policy and its ledger (owner-only / retention-only: never the runtime's).
    expect(tables.map((r) => r.t).sort()).toEqual(['audit_record', 'audit_retention_policy', 'audit_retention_run']);
    const [owner] = await sql<{ o: string }>(d.adminUrl, `SELECT tableowner AS o FROM pg_tables WHERE tablename = 'audit_record'`);
    expect(owner!.o).toBe(d.migrator);
  });

  it('the runtime role holds exactly INSERT and SELECT on audit_record (the Core default UPDATE / DELETE taken back); no other role may mutate it', async () => {
    const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    const held = [];
    for (const p of privileges) {
      const [r] = await sql<{ ok: boolean }>(d.adminUrl, `SELECT has_table_privilege($1, 'audit_record', $2) AS ok`, [d.app, p]);
      if (r!.ok) held.push(p);
    }
    expect(held).toEqual(['SELECT', 'INSERT']);
    const mutators = await sql(d.adminUrl, `SELECT a.grantee::regrole::text AS role, a.privilege_type AS p FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = 'audit_record'::regclass AND a.grantee <> c.relowner AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')`);
    expect(mutators).toEqual([]);
  });

  it('a future append-only table follows the same convention: default privileges would grant UPDATE / DELETE, audit_restrict_to_append_only takes them back', async () => {
    const mig = new pg.Client({ connectionString: d.migratorUrl });
    await mig.connect();
    try {
      await mig.query('BEGIN');
      await mig.query('CREATE TABLE audit_future_probe (id int)');
      const before = await mig.query(`SELECT has_table_privilege($1, 'audit_future_probe', 'DELETE') AS ok`, [d.app]);
      expect(before.rows[0].ok).toBe(true); // the Core default grant: a new table is mutable by the runtime unless its migration says otherwise
      await mig.query(`SELECT audit_restrict_to_append_only('audit_future_probe')`);
      const after = await mig.query(`SELECT has_table_privilege($1, 'audit_future_probe', 'DELETE') AS d, has_table_privilege($1, 'audit_future_probe', 'UPDATE') AS u, has_table_privilege($1, 'audit_future_probe', 'INSERT') AS i`, [d.app]);
      expect(after.rows[0]).toEqual({ d: false, u: false, i: true });
    } finally {
      await mig.query('ROLLBACK');
      await mig.end();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────────────── append-only: runtime, owner, superuser

  it('as the runtime role: INSERT and SELECT work; UPDATE, DELETE and TRUNCATE are refused by privilege (42501), whatever the row', async () => {
    const r = valid();
    expect((await repo.insertOnce(r)).kind).toBe('inserted');
    expect((await app.query(`SELECT count(*)::int AS n FROM audit_record WHERE "eventId" = $1`, [r.eventId])).rows[0].n).toBe(1);
    for (const statement of [
      `UPDATE audit_record SET action = 'membership.approved' WHERE "eventId" = '${r.eventId}'`,
      `UPDATE audit_record SET "recordedAt" = now() - interval '1 year'`,
      `DELETE FROM audit_record WHERE "eventId" = '${r.eventId}'`,
      'DELETE FROM audit_record',
      'TRUNCATE audit_record',
      `INSERT INTO audit_record ("eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "userKind", "resourceType", "resourceId", outcome, "occurredAt")
        SELECT "eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "userKind", "resourceType", "resourceId", outcome, "occurredAt" FROM audit_record
        ON CONFLICT ("sourceService", "eventId") DO UPDATE SET action = 'x.y'`, // an upsert is an UPDATE: it needs the UPDATE privilege
    ]) {
      expect((await failure(d.appUrl, statement)).code, statement).toBe('42501');
    }
    const [stored] = await sql<{ action: string }>(d.adminUrl, `SELECT action FROM audit_record WHERE "eventId" = $1`, [r.eventId]);
    expect(stored!.action).toBe('membership.revoked');
  });

  it('the runtime role cannot give itself back the authority: no GRANT, no trigger or table change, no replication role, no ownership', async () => {
    for (const statement of [
      'ALTER TABLE audit_record DISABLE TRIGGER audit_record_no_update_delete',
      'DROP TRIGGER audit_record_no_update_delete ON audit_record',
      'ALTER TABLE audit_record DROP CONSTRAINT audit_record_changes_valid',
      'ALTER TABLE audit_record OWNER TO CURRENT_USER',
      `CREATE OR REPLACE FUNCTION audit_record_append_only() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$`,
      'SET session_replication_role = replica',
      `SELECT audit_restrict_to_append_only('audit_record')`, // callable only as the owner: it REVOKEs on a table the runtime does not own
    ]) {
      const e = await failure(d.appUrl, statement);
      expect(e.code, statement).toMatch(/^(42501|42883)$/);
    }
    // A GRANT by a non-owner is not an error in PostgreSQL but a warning that grants nothing: prove the privilege is still absent.
    await sql(d.appUrl, 'GRANT UPDATE, DELETE ON audit_record TO CURRENT_USER');
    const [r] = await sql<{ ok: boolean }>(d.adminUrl, `SELECT has_table_privilege($1, 'audit_record', 'UPDATE') AS ok`, [d.app]);
    expect(r!.ok).toBe(false);
  });

  it('the migration-ledger weakness (Stage 21) does not reach audit_record: after deleting a ledger row the runtime still cannot update or delete a record', async () => {
    const r = valid();
    await repo.insertOnce(r);
    await app.query('BEGIN');
    try {
      const del = await app.query(`DELETE FROM schema_migrations WHERE name = '0001_audit_record.sql'`); // the inherited Core weakness
      expect(del.rowCount).toBe(1);
      await expect(app.query(`UPDATE audit_record SET action = 'x.y' WHERE "eventId" = $1`, [r.eventId])).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.query('ROLLBACK');
    }
    expect((await sql(d.adminUrl, `SELECT 1 FROM schema_migrations WHERE name = '0001_audit_record.sql'`)).length).toBe(1);
  });

  it('defense in depth: even the owner (the migrator) and a superuser are refused UPDATE / DELETE / TRUNCATE while the triggers are enabled', async () => {
    const r = valid();
    await repo.insertOnce(r);
    for (const url of [d.migratorUrl, d.adminUrl]) {
      for (const statement of [`UPDATE audit_record SET outcome = 'denied' WHERE "eventId" = '${r.eventId}'`, `DELETE FROM audit_record WHERE "eventId" = '${r.eventId}'`, 'TRUNCATE audit_record']) {
        const e = await failure(url, statement);
        expect([e.code, e.message.includes('append-only')], statement).toEqual(['42501', true]);
      }
    }
  });

  it('the stated limit: the owner or a superuser CAN disable the triggers and rewrite a record — outside the V1 guarantee (A45)', async () => {
    const r = valid();
    await repo.insertOnce(r);
    const admin = new pg.Client({ connectionString: d.adminUrl });
    await admin.connect();
    try {
      await admin.query('BEGIN');
      await admin.query('ALTER TABLE audit_record DISABLE TRIGGER audit_record_no_update_delete');
      const u = await admin.query(`UPDATE audit_record SET outcome = 'denied' WHERE "eventId" = $1`, [r.eventId]);
      expect(u.rowCount).toBe(1); // a database administrator is outside the model: documented, not claimed otherwise
      await admin.query('ROLLBACK');
    } finally {
      await admin.end();
    }
    const [stored] = await sql<{ outcome: string }>(d.adminUrl, `SELECT outcome FROM audit_record WHERE "eventId" = $1`, [r.eventId]);
    expect(stored!.outcome).toBe('succeeded');
    const [enabled] = await sql<{ e: string }>(d.adminUrl, `SELECT tgenabled AS e FROM pg_trigger WHERE tgname = 'audit_record_no_update_delete'`);
    expect(enabled!.e).toBe('O');
  });

  // ─────────────────────────────────────────────────────────────────────────────────────── identifiers and the database clock

  it('recordedAt and id are Audit\'s: a supplied recordedAt is replaced by the database clock, and an id cannot be supplied at all', async () => {
    const e1 = randomUUID();
    await app.query(`INSERT INTO audit_record ("eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "resourceType", "resourceId", outcome, "occurredAt", "recordedAt")
      VALUES ($1, 'billing-service', 'invoice.issued', 'commercial', 1, 'service', 'billing-service', 'invoice', $2, 'succeeded', now(), '2000-01-01T00:00:00Z')`, [e1, randomUUID()]);
    const [row] = await sql<{ late: boolean }>(d.adminUrl, `SELECT abs(extract(epoch FROM now() - "recordedAt")) < 60 AS late FROM audit_record WHERE "eventId" = $1`, [e1]);
    expect(row!.late).toBe(true);
    const id = await failure(d.appUrl, `INSERT INTO audit_record (id, "eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "resourceType", "resourceId", outcome, "occurredAt")
      VALUES (1, $1, 'billing-service', 'invoice.issued', 'commercial', 1, 'service', 'billing-service', 'invoice', 'x', 'succeeded', now())`, [randomUUID()]);
    expect(id.code).toBe('428C9'); // GENERATED ALWAYS: never caller-chosen
  });

  it('occurredAt is stored as sent: a future and a far-past producer time are both kept (A22: observed in 18.5, never discarded here)', async () => {
    for (const occurredAt of ['2099-01-01T00:00:00.000Z', '2001-01-01T00:00:00.000Z']) {
      const r = valid({ occurredAt });
      expect((await repo.insertOnce(r)).kind).toBe('inserted');
      expect((await repo.findBySourceAndEventId(r.sourceService, r.eventId))!.occurredAt.toISOString()).toBe(occurredAt);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────── the constraint matrix

  const refusals: [string, Partial<NewAuditRecord> | ((r: NewAuditRecord) => NewAuditRecord), string | string[] | null][] = [
    // identity
    ['a malformed eventId', { eventId: 'not-a-uuid' }, null],
    ['an upper-case / spaced source service', { sourceService: 'Organization Service' }, 'audit_record_source_shape'],
    ['a one-character source service', { sourceService: 'a' }, 'audit_record_source_shape'],
    ['a 64-character source service', { sourceService: 'a'.repeat(64) }, 'audit_record_source_shape'],
    // action
    ['an action without a dot', { action: 'revoked' }, 'audit_record_action_shape'],
    ['an action in capitals', { action: 'Membership.Revoked' }, 'audit_record_action_shape'],
    ['an action as prose', { action: 'Le rôle a été modifié' }, 'audit_record_action_shape'],
    ['an action with a bidi control', { action: 'membership.revoked\u202e' }, 'audit_record_action_shape'],
    ['an action with a newline', { action: 'membership.revoked\nx.y' }, 'audit_record_action_shape'],
    ['an action over 100 characters', { action: `a.${'b'.repeat(99)}` }, 'audit_record_action_shape'],
    ['an action ending with a dot', { action: 'membership.' }, 'audit_record_action_shape'],
    // category, version, outcome
    ['an unknown category', { category: 'severity' as never }, 'audit_record_category_valid'],
    ['a category in capitals', { category: 'SECURITY' as never }, 'audit_record_category_valid'],
    ['schema version 0', { schemaVersion: 0 }, 'audit_record_schema_version_bounded'],
    ['schema version 1001', { schemaVersion: 1001 }, 'audit_record_schema_version_bounded'],
    ['an unknown outcome', { outcome: 'failed' as never }, 'audit_record_outcome_valid'],
    // actor
    ['an unknown actor type (operator is a user kind, not an actor type)', { actor: { type: 'operator' as never, id: USER } }, ['audit_record_actor_type_valid', 'audit_record_actor_consistent']],
    ['a user actor without a kind', { actor: { type: 'service', id: USER } }, 'audit_record_actor_consistent'], // a uuid is not a service name
    ['a user actor whose id is not a uuid', { actor: { type: 'user', id: 'someone', userKind: 'member' } }, 'audit_record_actor_consistent'],
    ['a user actor with an upper-case uuid', { actor: { type: 'user', id: USER.toUpperCase(), userKind: 'member' } }, 'audit_record_actor_consistent'],
    ['a user actor with an unknown kind', { actor: { type: 'user', id: USER, userKind: 'admin' as never } }, 'audit_record_actor_consistent'],
    ['a user actor with an email as id', { actor: { type: 'user', id: 'person@example.com', userKind: 'member' } }, 'audit_record_actor_consistent'],
    ['a service actor that is not a service name', { actor: { type: 'service', id: 'Billing Service' } }, 'audit_record_actor_consistent'],
    ['a system actor with an empty id', { actor: { type: 'system', id: '' } }, 'audit_record_actor_consistent'],
    ['a system actor with a free-text id', { actor: { type: 'system', id: 'the nightly job' } }, 'audit_record_actor_consistent'],
    // organization, resource, subject
    ['a malformed organization id', { organizationId: 'all' }, null],
    ['an organization wildcard', { organizationId: '*' }, null],
    ['a resource type in capitals', { resource: { type: 'Membership', id: MEMBERSHIP } }, 'audit_record_resource_shape'],
    ['an empty resource id', { resource: { type: 'membership', id: '' } }, 'audit_record_resource_shape'],
    ['a 129-character resource id', { resource: { type: 'membership', id: 'x'.repeat(129) } }, 'audit_record_resource_shape'],
    ['an SQL-looking resource id', { resource: { type: 'membership', id: "x'; DROP TABLE audit_record;--" } }, 'audit_record_resource_shape'],
    ['a resource id with a newline (log injection)', { resource: { type: 'membership', id: 'a\n{"level":"error"}' } }, 'audit_record_resource_shape'],
    ['a subject type without an id', (r) => ({ ...r, subject: { type: 'user', id: null as never } }), 'audit_record_subject_shape'],
    ['a subject id without a type', (r) => ({ ...r, subject: { type: null as never, id: USER } }), 'audit_record_subject_shape'],
    ['a subject with a bidi control', { subject: { type: 'user', id: `${USER}\u200f` } }, 'audit_record_subject_shape'],
    // correlation, causation, time
    ['a correlation id with a space', { correlationId: 'corr id 0001' }, 'audit_record_correlation_shape'],
    ['a 7-character correlation id', { correlationId: 'abc1234' }, 'audit_record_correlation_shape'],
    ['a 129-character correlation id', { correlationId: 'c'.repeat(129) }, 'audit_record_correlation_shape'],
    ['a malformed causation id', { causationId: 'cause' }, null],
    ['a record that causes itself', (r) => ({ ...r, causationId: r.eventId }), 'audit_record_causation_not_self'],
    ['an unparseable occurredAt', { occurredAt: 'not-a-date' }, null],
    ['a PostgreSQL special literal as occurredAt', { occurredAt: 'yesterday' }, null],
    ['an infinite occurredAt', { occurredAt: 'infinity' }, null],
  ];

  it.each(refusals)('refuses %s: a typed invalid_record, nothing stored, no row data in the error', async (_label, over, constraint) => {
    const r = typeof over === 'function' ? over(valid()) : valid(over);
    const before = await count();
    const e = await repo.insertOnce(r).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(AuditPersistenceError);
    expect((e as AuditPersistenceError).code).toBe('invalid_record');
    if (constraint) expect([constraint].flat()).toContain((e as AuditPersistenceError).constraint);
    expect((e as Error).message).toBe('invalid_record'); // never the refused value
    expect(await count()).toBe(before);
  });

  it('the schema refuses what the typed repository cannot even express: a user actor without a kind, a kind on a service actor, a half subject, an infinite time', async () => {
    const base = `INSERT INTO audit_record ("eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "userKind", "resourceType", "resourceId", "subjectType", "subjectId", outcome, "occurredAt")`;
    for (const [values, constraint] of [
      [`'user', '${USER}', NULL, 'membership', 'm-1', NULL, NULL, 'succeeded', now()`, 'audit_record_actor_consistent'],
      [`'service', 'billing-service', 'owner', 'membership', 'm-1', NULL, NULL, 'succeeded', now()`, 'audit_record_actor_consistent'],
      [`'system', 'expiry_sweep', 'member', 'membership', 'm-1', NULL, NULL, 'succeeded', now()`, 'audit_record_actor_consistent'],
      [`'service', 'billing-service', NULL, 'membership', 'm-1', 'user', NULL, 'succeeded', now()`, 'audit_record_subject_shape'],
      [`'service', 'billing-service', NULL, 'membership', 'm-1', NULL, '${USER}', 'succeeded', now()`, 'audit_record_subject_shape'],
      [`'service', 'billing-service', NULL, 'membership', 'm-1', NULL, NULL, 'succeeded', 'infinity'`, 'audit_record_occurred_finite'],
      [`'service', 'billing-service', NULL, 'membership', 'm-1', NULL, NULL, 'succeeded', '-infinity'`, 'audit_record_occurred_finite'],
    ] as const) {
      const e = await failure(d.appUrl, `${base} VALUES ('${randomUUID()}', 'billing-service', 'invoice.issued', 'commercial', 1, ${values})`);
      expect([e.code, e.constraint], values).toEqual(['23514', constraint]);
    }
  });

  it('missing required fields are refused by the schema (NOT NULL), not only by the TypeScript types', async () => {
    for (const col of ['"eventId"', '"sourceService"', 'action', 'category', '"schemaVersion"', '"actorType"', '"actorId"', '"resourceType"', '"resourceId"', 'outcome', '"occurredAt"']) {
      const cols = ['"eventId"', '"sourceService"', 'action', 'category', '"schemaVersion"', '"actorType"', '"actorId"', '"resourceType"', '"resourceId"', 'outcome', '"occurredAt"'];
      const vals = [`'${randomUUID()}'`, `'billing-service'`, `'invoice.issued'`, `'commercial'`, '1', `'service'`, `'billing-service'`, `'invoice'`, `'i-1'`, `'succeeded'`, 'now()'];
      const i = cols.indexOf(col);
      const e = await failure(d.appUrl, `INSERT INTO audit_record (${cols.filter((_, j) => j !== i).join(', ')}) VALUES (${vals.filter((_, j) => j !== i).join(', ')})`);
      expect(e.code, col).toBe('23502');
    }
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────── bounded changes (A27, A28)

  it.each([
    ['a scalar string', { role: 'admin' }],
    ['an integer, a boolean and null', { attempts: 3, first: true, previous: null }],
    ['the largest exact integer', { n: 9007199254740991 }],
    ['a negative integer', { delta: -42 }],
    ['from / to pairs of scalars', { role: { from: 'member', to: 'admin' }, status: { from: null, to: 'active' } }],
    ['an ISO date and a uuid', { until: '2026-12-31T23:59:59Z', invoice: 'a8f5f167-f44f-4964-a6f3-2c3e1d4b5a6c' }],
    ['exactly 8 keys', Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, i]))],
    ['no changes at all', null],
  ])('accepts %s', async (_label, changes) => {
    expect((await repo.insertOnce(valid({ changes: changes as never }))).kind).toBe('inserted');
  });

  it.each([
    ['9 keys', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]))],
    ['an empty object', {}],
    ['a nested object', { role: { name: 'admin' } }],
    ['a deeper nesting', { role: { from: { a: 1 }, to: 'admin' } }],
    ['a from / to with an extra key', { role: { from: 'a', to: 'b', by: 'c' } }],
    ['a from without a to', { role: { from: 'a' } }],
    ['an array value', { roles: ['admin', 'member'] }],
    ['an array inside from / to', { role: { from: ['a'], to: 'b' } }],
    ['a fraction', { ratio: 1.5 }],
    ['an integer beyond 2^53 − 1', { n: 9007199254740992 }],
    ['1e308', { n: 1e308 }],
    ['a 65-character string', { code: 'x'.repeat(65) }],
    ['an empty string', { code: '' }],
    ['a string with a space', { note: 'free text' }],
    ['a string with a newline', { note: 'a\nb' }],
    ['a string with a bidi control', { note: `abc\u202edef` }],
    ['a string with an accent (prose, not a code)', { note: 'modifié' }],
    ['an upper-case key', { Role: 'admin' }],
    ['a 33-character key', { [`k${'x'.repeat(32)}`]: 1 }],
    ['a key with a dash', { 'previous-role': 'admin' }],
    ['a top-level array', ['a'] as never],
    ['a top-level string', 'role' as never],
  ])('refuses changes with %s', async (_label, changes) => {
    const e = await repo.insertOnce(valid({ changes: changes as never })).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(AuditPersistenceError);
    expect((e as AuditPersistenceError).constraint).toBe('audit_record_changes_valid');
  });

  it('the size bound is exactly 1 024 bytes of canonical jsonb text (changes::text, UTF-8): 1 024 accepted, 1 025 refused', async () => {
    const pair = (i: number) => [`key_${i}`, { from: 'f'.repeat(64), to: 't'.repeat(64) }] as const;
    const base = Object.fromEntries([0, 1, 2, 3, 4, 5].map(pair));
    const size = async (c: unknown) => Number((await sql<{ n: number }>(d.adminUrl, 'SELECT octet_length($1::jsonb::text) AS n', [JSON.stringify(c)]))[0]!.n);
    let exact: Record<string, unknown> | undefined;
    let over: Record<string, unknown> | undefined;
    for (let len = 1; len <= 64 && !exact; len++) {
      const c = { ...base, key_6: 'x'.repeat(len) };
      if ((await size(c)) === 1024) {
        exact = c;
        over = { ...base, key_6: 'x'.repeat(len + 1) };
      }
    }
    expect(exact, 'a 1 024-byte value exists within the key and length bounds').toBeDefined();
    expect(await size(over)).toBe(1025);
    expect((await repo.insertOnce(valid({ changes: exact as never }))).kind).toBe('inserted');
    const e = await repo.insertOnce(valid({ changes: over as never })).then(() => undefined, (x: unknown) => x);
    expect((e as AuditPersistenceError).constraint).toBe('audit_record_changes_valid');
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────── repository and idempotency

  it('insertOnce: the first occurrence is stored; the same event again returns the stored record, unchanged, and sameEvidence tells exact from conflicting', async () => {
    const r = valid({ changes: { role: { from: 'member', to: 'admin' }, attempts: 2 } });
    const first = await repo.insertOnce(r);
    expect(first.kind).toBe('inserted');
    if (first.kind !== 'inserted') throw new Error('unreachable');
    expect(first.record).toMatchObject({ eventId: r.eventId, actorType: 'user', actorId: USER, userKind: 'owner', organizationId: ORG, subjectType: 'user', category: 'business' });
    expect(typeof first.record.id).toBe('string');
    // The same event, fields in another order: an exact duplicate.
    const again = await repo.insertOnce({ ...r, changes: { attempts: 2, role: { to: 'admin', from: 'member' } } });
    expect(again.kind).toBe('duplicate');
    if (again.kind !== 'duplicate') throw new Error('unreachable');
    expect(again.existing).toEqual(first.record);
    expect(sameEvidence(again.existing, r)).toBe(true);
    // The same (sourceService, eventId) with other content: a conflicting duplicate; the stored record is never overwritten.
    const conflicting = { ...r, action: 'membership.approved', changes: { role: 'member' } };
    const clash = await repo.insertOnce(conflicting);
    expect(clash.kind).toBe('duplicate');
    if (clash.kind !== 'duplicate') throw new Error('unreachable');
    expect(sameEvidence(clash.existing, conflicting)).toBe(false);
    expect((await repo.findBySourceAndEventId(r.sourceService, r.eventId))).toEqual(first.record);
    // The same eventId from ANOTHER source is another event (uniqueness is per source, A15).
    expect((await repo.insertOnce({ ...r, sourceService: 'billing-service' })).kind).toBe('inserted');
  });

  it('sameEvidence notices every caller-supplied field (and ignores Audit\'s own id and recordedAt)', async () => {
    const r = valid({ causationId: randomUUID() });
    const out = await repo.insertOnce(r);
    if (out.kind !== 'inserted') throw new Error('unreachable');
    const stored = out.record;
    expect(sameEvidence({ ...stored, id: '999', recordedAt: new Date(0) }, r)).toBe(true);
    const variants: Partial<NewAuditRecord>[] = [
      { action: 'membership.approved' }, { category: 'security' }, { schemaVersion: 2 }, { actor: { type: 'user', id: USER, userKind: 'operator' } },
      { actor: { type: 'service', id: 'organization-service' } }, { organizationId: null }, { resource: { type: 'membership', id: 'other' } },
      { subject: null }, { outcome: 'denied' }, { changes: null }, { correlationId: null }, { causationId: null }, { occurredAt: new Date('2026-09-25T10:00:00.001Z') },
    ];
    for (const v of variants) expect(sameEvidence(stored, { ...r, ...v }), JSON.stringify(v)).toBe(false);
  });

  it('works inside the caller\'s transaction: a rollback leaves nothing; a refused record inside a transaction aborts only that transaction', async () => {
    const db = t.app.get(DbService);
    const r = valid();
    await expect(db.tx(async (q) => {
      expect((await repo.insertOnce(r, q)).kind).toBe('inserted');
      throw new Error('the caller\'s own step failed');
    })).rejects.toThrow('own step failed');
    expect(await repo.findBySourceAndEventId(r.sourceService, r.eventId)).toBeUndefined();
    await db.tx(async (q) => {
      expect((await repo.insertOnce(r, q)).kind).toBe('inserted');
    });
    expect(await repo.findBySourceAndEventId(r.sourceService, r.eventId)).toBeDefined();
  });

  it('20 concurrent deliveries of one event (through the pool): exactly one row; every other call resolves as a duplicate of it', async () => {
    const r = valid();
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => repo.insertOnce(r)));
    expect(outcomes.filter((o) => o.kind === 'inserted')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'duplicate')).toHaveLength(19);
    const [n] = await sql<{ n: string }>(d.adminUrl, `SELECT count(*) AS n FROM audit_record WHERE "sourceService" = $1 AND "eventId" = $2`, [r.sourceService, r.eventId]);
    expect(Number(n!.n)).toBe(1);
  });

  it('20 concurrent CONFLICTING deliveries (same identity, different content): one row, stored once, never overwritten by a later one', async () => {
    const eventId = randomUUID();
    const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => repo.insertOnce(valid({ eventId, changes: { attempt: i } }))));
    const winner = outcomes.find((o) => o.kind === 'inserted');
    expect(outcomes.filter((o) => o.kind === 'inserted')).toHaveLength(1);
    if (winner?.kind !== 'inserted') throw new Error('unreachable');
    const stored = await repo.findBySourceAndEventId('organization-service', eventId);
    expect(stored).toEqual(winner.record);
  });

  it('a malformed lookup key is a typed refusal, not a database error leak', async () => {
    const e = await repo.findBySourceAndEventId('organization-service', 'not-a-uuid').then(() => undefined, (x: unknown) => x);
    expect((e as AuditPersistenceError).code).toBe('invalid_record');
  });

  // ────────────────────────────────────────────────────────────────────────────────────────── indexes at a realistic size

  describe('query shapes at a realistic size', () => {
    beforeAll(async () => {
      // 60 000 rows: 200 organizations (+ platform-level), 2 000 users, 4 source services, the shapes of §4.1 (as the owner: the
      // runtime path is the repository, proven above; this is bulk fixture data).
      await sql(d.adminUrl, `INSERT INTO audit_record ("eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "userKind",
          "organizationId", "resourceType", "resourceId", "subjectType", "subjectId", outcome, changes, "correlationId", "occurredAt")
        SELECT gen_random_uuid(), (ARRAY['organization-service','billing-service','payment-service','file-service'])[1 + g % 4],
          (ARRAY['membership.revoked','invoice.issued','payment.succeeded','file.deleted'])[1 + g % 4],
          (ARRAY['business','commercial','commercial','business'])[1 + g % 4], 1,
          CASE WHEN g % 3 = 0 THEN 'user' ELSE 'service' END,
          CASE WHEN g % 3 = 0 THEN md5('u' || (g % 2000))::uuid::text ELSE (ARRAY['organization-service','billing-service','payment-service','file-service'])[1 + g % 4] END,
          CASE WHEN g % 3 = 0 THEN 'member' END,
          CASE WHEN g % 50 = 0 THEN NULL ELSE md5('o' || (g % 200))::uuid END,
          (ARRAY['membership','invoice','payment','file'])[1 + g % 4], md5('r' || g)::uuid::text,
          CASE WHEN g % 4 = 0 THEN 'user' END, CASE WHEN g % 4 = 0 THEN md5('u' || (g % 2000))::uuid::text END,
          'succeeded', CASE WHEN g % 2 = 0 THEN '{"status": {"from": "active", "to": "revoked"}}'::jsonb END,
          'corr-' || lpad((g % 20000)::text, 8, '0'), now() - (g || ' minutes')::interval
        FROM generate_series(1, 60000) g`);
      await sql(d.adminUrl, 'ANALYZE audit_record');
    }, 120_000);

    const plan = async (query: string, params: unknown[]) =>
      (await sql<{ 'QUERY PLAN': string }>(d.adminUrl, `EXPLAIN (COSTS OFF) ${query}`, params)).map((r) => r['QUERY PLAN']).join('\n');
    const ORG_ = "md5('o7')::uuid";
    const USER_ = "md5('u9')::uuid::text";

    it.each([
      ['organization scope, newest first (keyset page)', `SELECT * FROM audit_record WHERE "organizationId" = ${ORG_} AND "occurredAt" >= now() - interval '92 days'
        AND ("occurredAt", id) < (now(), 9223372036854775807) ORDER BY "occurredAt" DESC, id DESC LIMIT 50`, 'audit_record_org_time_idx'],
      ['platform-level records (organizationId IS NULL)', `SELECT * FROM audit_record WHERE "organizationId" IS NULL AND "occurredAt" >= now() - interval '31 days'
        ORDER BY "occurredAt" DESC, id DESC LIMIT 50`, 'audit_record_(org_)?time_idx'], // either serves it; 18.6's time index is the tighter
      ['every organization, newest first (18.6 platform scope)', `SELECT * FROM audit_record WHERE "occurredAt" >= now() - interval '31 days'
        ORDER BY "occurredAt" DESC, id DESC LIMIT 50`, 'audit_record_time_idx'],
      ['an actor\'s actions', `SELECT * FROM audit_record WHERE "actorType" = 'user' AND "actorId" = ${USER_} ORDER BY "occurredAt" DESC, id DESC LIMIT 50`, 'audit_record_actor_time_idx'],
      ['a resource\'s history', `SELECT * FROM audit_record WHERE "resourceType" = 'membership' AND "resourceId" = md5('r4')::uuid::text ORDER BY "occurredAt" DESC, id DESC LIMIT 50`, 'audit_record_resource_time_idx'],
      ['a subject\'s history', `SELECT * FROM audit_record WHERE "subjectType" = 'user' AND "subjectId" = ${USER_} ORDER BY "occurredAt" DESC, id DESC LIMIT 50`, 'audit_record_subject_time_idx'],
      ['an action inside an organization', `SELECT * FROM audit_record WHERE "organizationId" = ${ORG_} AND action = 'membership.revoked' ORDER BY "occurredAt" DESC, id DESC LIMIT 50`, 'audit_record_org_time_idx'],
      ['a correlation id', `SELECT * FROM audit_record WHERE "correlationId" = 'corr-00000042'`, 'audit_record_correlation_idx'],
      ['idempotent lookup', `SELECT * FROM audit_record WHERE "sourceService" = 'billing-service' AND "eventId" = '0b8e4c1a-2f3d-4e5f-9a6b-7c8d9e0f1a2b'`, 'audit_record_source_event_unique'],
      ['retention scan by storage time', `SELECT id FROM audit_record WHERE "recordedAt" < now() - interval '1 day' LIMIT 500`, 'audit_record_recorded_idx'],
    ])('%s uses its index (no sequential scan)', async (_label, query, index) => {
      const p = await plan(query, []);
      expect(p, p).toMatch(new RegExp(index));
      expect(p, p).not.toMatch(/Seq Scan on audit_record/);
    });

    it('storage footprint of representative records stays around the 18.1 estimate (≈ 1 KiB per record, heap + indexes)', async () => {
      const [f] = await sql<{ rows: string; heap: string; idx: string }>(d.adminUrl,
        `SELECT count(*) AS rows, pg_table_size('audit_record') AS heap, pg_indexes_size('audit_record') AS idx FROM audit_record`);
      const perRow = (Number(f!.heap) + Number(f!.idx)) / Number(f!.rows);
      expect(perRow).toBeGreaterThan(200);
      expect(perRow).toBeLessThan(2048);
    });
  });
});
