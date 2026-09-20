import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { organizationMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { client } from './support/fixtures.js';

/**
 * ADR-0032: the service runs as a least-privilege role that OWNS nothing. This provisions roles the way `infra/postgres/init`
 * does (migrator owns the schema; the runtime role gets DML through default privileges), migrates as the migrator, and runs the
 * real application as the runtime role. Self-contained: it creates and drops its own roles, so it also runs in CI.
 */
describeWithEnv('runtime database role: the service runs as a non-owner, DML-only role', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const suffix = randomBytes(4).toString('hex');
  const migrator = `og_mig_${suffix}`;
  const appRole = `og_app_${suffix}`;
  const dbName = `og_organization_${suffix}`;
  const migPw = randomBytes(12).toString('hex');
  const appPw = randomBytes(12).toString('hex');
  const urlFor = (user: string, pw: string) => {
    const u = new URL(env.TEST_DATABASE_ADMIN_URL);
    u.username = user;
    u.password = pw;
    u.pathname = `/${dbName}`;
    return u.toString();
  };
  const adminUrlTo = (name: string) => {
    const u = new URL(env.TEST_DATABASE_ADMIN_URL);
    u.pathname = `/${name}`;
    return u.toString();
  };
  let t: TestApp;

  beforeAll(async () => {
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
    const scoped = new pg.Client({ connectionString: adminUrlTo(dbName) });
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
    await runMigrations(urlFor(migrator, migPw), [kitMigrationsDir, organizationMigrationsDir]); // the explicit migration step, as the schema owner
    t = await createTestApp({ databaseUrl: urlFor(appRole, appPw) }); // the RUNTIME role
  });

  afterAll(async () => {
    await t?.app.close();
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

  it('is ready and serves the whole hierarchy lifecycle as the runtime role (create, read, list, update through the real API)', async () => {
    await t.http().get('/ready').expect(200);
    const c = client(t);
    const company = await c.company();
    const platform = await c.platform(company.id);
    const org = await c.organization(platform.id);
    expect((await c.patch(`/organization/organizations/${org.id}`, { name: 'Changed' })).body.name).toBe('Changed');
    expect((await c.get(`/organization/organizations?platformId=${platform.id}`)).body.items).toHaveLength(1);
  });

  it('the runtime role cannot change the schema or the triggers that protect the hierarchy', async () => {
    const runtime = new pg.Client({ connectionString: urlFor(appRole, appPw) });
    await runtime.connect();
    try {
      for (const ddl of [
        'CREATE TABLE evil (id int)',
        'ALTER TABLE organization ADD COLUMN "companyId" uuid',
        'DROP TABLE organization',
        'DROP TRIGGER organization_immutable ON organization',
        'ALTER TABLE platform DISABLE TRIGGER platform_immutable',
        'TRUNCATE organization',
      ]) {
        await expect(runtime.query(ddl), ddl).rejects.toThrow(/permission denied|must be owner/i);
      }
      const owner = await runtime.query(`SELECT tableowner FROM pg_tables WHERE tablename = 'organization'`);
      expect(owner.rows[0].tableowner).toBe(migrator);
    } finally {
      await runtime.end();
    }
  });
});
