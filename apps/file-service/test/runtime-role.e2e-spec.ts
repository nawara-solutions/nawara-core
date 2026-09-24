import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { fileMigrationsDir } from '../src/app.module.js';
import { FileRepository } from '../src/persistence/file.repository.js';
import { ticketDigest } from '../src/persistence/ticket-digest.js';
import { TicketRepository } from '../src/persistence/ticket.repository.js';
import { createTestApp, type TestApp } from './support/app.js';
import { failure, sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * ADR-0032: provisions a file database exactly as `infra/postgres/init` does (the migrator owns the schema; the runtime role gets
 * DML through default privileges), migrates AS THE MIGRATOR, then runs the real application AS THE RUNTIME ROLE: ready, and unable
 * to change the schema or to migrate. Self-contained (own roles and database), so it also runs in CI.
 */
describeWithEnv('runtime database role: ready, DML only, no DDL (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const suffix = randomBytes(4).toString('hex');
  const migrator = `fl_mig_${suffix}`;
  const appRole = `fl_app_${suffix}`;
  const dbName = `fl_file_${suffix}`;
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
    await runMigrations(urlAs(migrator, migPw), [kitMigrationsDir, fileMigrationsDir]); // the explicit step, as the schema owner
    t = await createTestApp({ databaseUrl: APP() }); // the RUNTIME role
  });

  afterAll(async () => {
    await t?.app.close();
    await sql(env.TEST_DATABASE_ADMIN_URL, 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
    await sql(env.TEST_DATABASE_ADMIN_URL, `DROP DATABASE IF EXISTS ${dbName}`);
    await sql(env.TEST_DATABASE_ADMIN_URL, `DROP ROLE IF EXISTS ${appRole}`);
    await sql(env.TEST_DATABASE_ADMIN_URL, `DROP ROLE IF EXISTS ${migrator}`);
  });

  it('the service is ready as the runtime role (database and migrations checks pass without owning anything)', async () => {
    await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' });
  });

  it('the runtime role cannot create, alter or drop tables, and cannot run the migrations', async () => {
    expect((await failure(APP(), 'CREATE TABLE file_made_by_runtime(id int)')).code).toMatch(/^(42501)$/);
    expect((await failure(APP(), 'ALTER TABLE outbox ADD COLUMN c int')).code).toMatch(/^(42501)$/);
    expect((await failure(APP(), 'DROP TABLE outbox')).code).toMatch(/^(42501)$/);
    // A pending migration (a throwaway fixture in a temporary directory, not a file-domain migration) cannot be applied as the runtime role.
    const dir = mkdtempSync(join(tmpdir(), 'file-runtime-migrate-'));
    try {
      writeFileSync(join(dir, '9999_runtime_probe.sql'), 'CREATE TABLE runtime_probe (id int);');
      await expect(runMigrations(APP(), [kitMigrationsDir, fileMigrationsDir, dir])).rejects.toThrow();
      expect(await sql(adminTo(dbName), `SELECT 1 FROM pg_tables WHERE tablename = 'runtime_probe'`)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const owner = await sql<{ o: string }>(adminTo(dbName), `SELECT tableowner AS o FROM pg_tables WHERE tablename = 'outbox'`);
    expect(owner[0].o).toBe(migrator);
  });

  it('Stage 17.3: the file schema belongs to the migrator; the runtime role uses it through the repositories (DML only)', async () => {
    const owners = await sql<{ t: string; o: string }>(adminTo(dbName), `SELECT tablename AS t, tableowner AS o FROM pg_tables WHERE tablename LIKE 'file%' ORDER BY 1`);
    expect(owners).toEqual([{ t: 'file', o: migrator }, { t: 'file_access_ticket', o: migrator }]);
    const f = await t.app.get(FileRepository).createUploading({
      scope: { ownerService: 'core-drive', organizationId: null }, storage: { provider: 'filesystem', keyPrefix: 'files' }, uploadLeaseSeconds: 600, attachment: { deadlineSeconds: 3_600 },
    });
    const d = ticketDigest(randomBytes(32).toString('base64url'))!;
    await t.app.get(TicketRepository).recordDownload({ scope: { ownerService: 'core-drive', organizationId: null }, fileId: f.id, tokenDigest: d, lifetimeSeconds: 60, singleUse: true, disposition: 'attachment' });
    expect(await t.app.get(TicketRepository).claimUse(d)).toBeDefined();
  });

  it('Stage 17.3: the runtime role cannot change the file schema, bypass its triggers, truncate it, or hard-delete a file', async () => {
    for (const ddl of ['ALTER TABLE file ADD COLUMN body bytea', 'ALTER TABLE file DISABLE TRIGGER file_no_delete', 'ALTER TABLE file_access_ticket DISABLE TRIGGER ALL',
      'DROP TRIGGER file_set_once ON file', 'ALTER TABLE file DROP CONSTRAINT file_sha256_shape', 'DROP INDEX file_idempotency_unique', 'TRUNCATE file_access_ticket',
      'CREATE OR REPLACE FUNCTION file_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$', 'SET session_replication_role = replica']) {
      expect((await failure(APP(), ddl)).code, ddl).toBe('42501');
    }
    const [row] = await sql<{ id: string }>(APP(), 'SELECT id FROM file LIMIT 1');
    expect((await failure(APP(), 'DELETE FROM file WHERE id = $1', [row!.id])).message).toMatch(/never deleted/);
  });
});
