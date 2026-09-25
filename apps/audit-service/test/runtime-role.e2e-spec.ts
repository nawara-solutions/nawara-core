import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { failure, sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * ADR-0032 / ADR-0049 (A23, A25): provisions an audit database exactly as `infra/postgres/init` does (the migrator owns the schema; the
 * runtime role gets DML through default privileges), migrates AS THE MIGRATOR, then runs the real application AS THE RUNTIME ROLE:
 * ready, and unable to change the schema, bypass triggers or migrate. Self-contained (own roles and database), so it also runs in CI.
 * The append-only privileges of `audit_record` itself (INSERT / SELECT only) are Stage 18.3.
 */
describeWithEnv('runtime database role: ready, DML only, no DDL (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  const suffix = randomBytes(4).toString('hex');
  const migrator = `au_mig_${suffix}`;
  const appRole = `au_app_${suffix}`;
  const dbName = `au_audit_${suffix}`;
  const migPw = randomBytes(12).toString('hex');
  const appPw = randomBytes(12).toString('hex');
  const urlAs = (user: string, pw: string) => {
    const u = new URL(env.TEST_DATABASE_ADMIN_URL);
    u.username = user;
    u.password = pw;
    u.pathname = `/${dbName}`;
    return u.toString();
  };
  const adminTo = (name: string) => {
    const u = new URL(env.TEST_DATABASE_ADMIN_URL);
    u.pathname = `/${name}`;
    return u.toString();
  };
  const APP = () => urlAs(appRole, appPw);
  const MIG = () => urlAs(migrator, migPw);
  let t: TestApp;

  beforeAll(async () => {
    await sql(env.TEST_DATABASE_ADMIN_URL, `CREATE ROLE ${migrator} LOGIN PASSWORD '${migPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await sql(env.TEST_DATABASE_ADMIN_URL, `CREATE ROLE ${appRole} LOGIN PASSWORD '${appPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await sql(env.TEST_DATABASE_ADMIN_URL, `CREATE DATABASE ${dbName} OWNER ${migrator}`);
    await sql(env.TEST_DATABASE_ADMIN_URL, `REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
    await sql(env.TEST_DATABASE_ADMIN_URL, `GRANT CONNECT ON DATABASE ${dbName} TO ${appRole}`);
    const scoped = new pg.Client({ connectionString: adminTo(dbName) });
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
    const first = await runMigrations(MIG(), [kitMigrationsDir, auditMigrationsDir]); // the explicit step, as the schema owner
    expect(first.applied.length).toBeGreaterThan(0);
    expect((await runMigrations(MIG(), [kitMigrationsDir, auditMigrationsDir])).applied).toEqual([]); // re-run: nothing new
    t = await createTestApp({ databaseUrl: APP(), rabbitmqUrl: env.TEST_RABBITMQ_URL }); // the RUNTIME role
  });

  afterAll(async () => {
    await t?.app.close();
    await sql(env.TEST_DATABASE_ADMIN_URL, 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
    await sql(env.TEST_DATABASE_ADMIN_URL, `DROP DATABASE IF EXISTS ${dbName}`);
    await sql(env.TEST_DATABASE_ADMIN_URL, `DROP ROLE IF EXISTS ${appRole}`);
    await sql(env.TEST_DATABASE_ADMIN_URL, `DROP ROLE IF EXISTS ${migrator}`);
  });

  it('the service is ready as the runtime role (database and migrations checks pass without owning anything)', async () => {
    await vi.waitFor(async () => expect((await request(t.app.getHttpServer()).get('/ready')).body).toEqual({ status: 'ready' }), { timeout: 15_000, interval: 100 });
  });

  it('every schema object belongs to the migrator; the runtime role owns nothing and has no role attribute', async () => {
    const owned = await sql<{ n: number }>(adminTo(dbName), `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = $1`, [appRole]);
    expect(owned[0]!.n).toBe(0);
    const tables = await sql<{ o: string }>(adminTo(dbName), `SELECT DISTINCT tableowner AS o FROM pg_tables WHERE schemaname = 'public'`);
    expect(tables.map((r) => r.o)).toEqual([migrator]);
    const [role] = await sql<Record<string, boolean>>(env.TEST_DATABASE_ADMIN_URL, `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [appRole]);
    expect(Object.values(role!).every((v) => v === false)).toBe(true);
  });

  it.each([
    ['create a table', 'CREATE TABLE audit_made_by_runtime(id int)'],
    ['alter a table', 'ALTER TABLE outbox ADD COLUMN c int'],
    ['drop a table', 'DROP TABLE outbox'],
    ['truncate a table', 'TRUNCATE outbox'],
    ['disable a trigger', 'ALTER TABLE outbox DISABLE TRIGGER outbox_immutable'],
    ['drop a trigger', 'DROP TRIGGER outbox_immutable ON outbox'],
    ['create a trigger', 'CREATE TRIGGER t BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION outbox_immutable()'],
    ['drop a constraint', 'ALTER TABLE outbox DROP CONSTRAINT outbox_name_shape'],
    ['replace a trigger function', `CREATE OR REPLACE FUNCTION outbox_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$`],
    ['create a function', `CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1'`],
    ['bypass triggers (session_replication_role)', 'SET session_replication_role = replica'],
    ['take ownership of a table', 'ALTER TABLE outbox OWNER TO CURRENT_USER'],
    ['change the schema owner', 'ALTER SCHEMA public OWNER TO CURRENT_USER'],
    ['create a schema', 'CREATE SCHEMA evil'],
    ['create a role', 'CREATE ROLE evil'],
    ['read a server file', `SELECT pg_read_file('/etc/hostname')`],
  ])('the runtime role cannot %s', async (_label, statement) => {
    const e = await failure(APP(), statement);
    expect(e.code).toMatch(/^(42501|42939)$/); // insufficient privilege / reserved (never a success, never a syntax slip)
  });

  it('the runtime role cannot run the migrations (a pending one stays pending)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-runtime-migrate-'));
    try {
      writeFileSync(join(dir, '9999_runtime_probe.sql'), 'CREATE TABLE runtime_probe (id int);'); // a throwaway fixture, not an audit migration
      await expect(runMigrations(APP(), [kitMigrationsDir, auditMigrationsDir, dir])).rejects.toThrow();
      expect(await sql(adminTo(dbName), `SELECT 1 FROM pg_tables WHERE tablename = 'runtime_probe'`)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
