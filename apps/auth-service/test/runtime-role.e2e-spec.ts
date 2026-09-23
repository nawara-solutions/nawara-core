import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { runMigrations } from '@nawara/service-kit';
import { bootstrapOwner } from '../src/cli/owner-tools.js';
import { generateJoinCode, hashJoinCode } from '../src/crypto/join-code.js';
import { PasswordService } from '../src/crypto/password.js';
import { DbService } from '../src/db/db.service.js';
import { AUTH_MIGRATIONS_DIR, AUTH_MIGRATION_OPTIONS } from '../src/db/migrations.js';
import { freeze, hierarchyMode, unfreeze } from '../src/hierarchy/hierarchy-authority.js';
import { UsersService } from '../src/users/users.service.js';
import { createTestApp, type TestCtx } from './helpers/app.js';

/**
 * ADR-0032 / Stage 14.3: auth-service runs as a least-privilege role that OWNS nothing. This provisions roles the way
 * `infra/postgres/init` does (the migrator owns the schema; the runtime role gets CONNECT + DML through default privileges),
 * applies Auth's real migrations AS the migrator, then runs the real application AS the runtime role through its main
 * flows, including the two non-plain-DML statements Auth issues (the hierarchy freeze's LOCK TABLE and the owner
 * bootstrap's advisory lock). Self-contained: it creates and drops its own roles and database, so it also runs in CI.
 */
describe('runtime database role: auth-service runs as a non-owner, DML-only role', () => {
  const suffix = randomBytes(4).toString('hex');
  const migrator = `au_mig_${suffix}`;
  const appRole = `au_app_${suffix}`;
  const dbName = `au_auth_${suffix}`;
  const migPw = randomBytes(12).toString('hex');
  const appPw = randomBytes(12).toString('hex');
  const adminUrl = () => inject('pgAdminUrl');
  const urlFor = (user: string, pw: string) => {
    const u = new URL(adminUrl());
    u.username = user;
    u.password = pw;
    u.pathname = `/${dbName}`;
    return u.toString();
  };
  const adminUrlTo = (name: string) => {
    const u = new URL(adminUrl());
    u.pathname = `/${name}`;
    return u.toString();
  };
  const asApp = async (sql: string) => {
    const c = new pg.Client({ connectionString: urlFor(appRole, appPw) });
    await c.connect();
    try {
      return await c.query(sql);
    } finally {
      await c.end();
    }
  };
  let t: TestCtx;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl() });
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
    // Auth's own migrations, applied as the MIGRATOR (never as the runtime role) by the same runner and options production uses.
    await runMigrations(urlFor(migrator, migPw), [AUTH_MIGRATIONS_DIR], AUTH_MIGRATION_OPTIONS);
    t = await createTestApp({ DATABASE_URL: urlFor(appRole, appPw) });
  });

  afterAll(async () => {
    await t?.close();
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${appRole}`);
      await admin.query(`DROP ROLE IF EXISTS ${migrator}`);
    } finally {
      await admin.end();
    }
  });

  it('the application really is connected as the runtime role, which is not a superuser and owns nothing', async () => {
    const dbs = t.app.get(DbService);
    const who = await dbs.query<{ user: string; super: boolean }>(`SELECT current_user AS user, rolsuper AS super FROM pg_roles WHERE rolname = current_user`);
    expect(who.rows[0]).toEqual({ user: appRole, super: false });
    const owned = await dbs.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = current_user`);
    expect(owned.rowCount).toBe(0);
  });

  it('runs the member flow end to end as the runtime role: registration by join code, login, refresh, /auth/me', async () => {
    const dbs = t.app.get(DbService);
    const users = t.app.get(UsersService);
    const [companyId, platformId, organizationId] = [randomUUID(), randomUUID(), randomUUID()];
    await dbs.query(`INSERT INTO company(id, name) VALUES ($1, 'C')`, [companyId]);
    await dbs.query(`INSERT INTO platform(id, "companyId", name) VALUES ($1, $2, 'P')`, [platformId, companyId]);
    await dbs.query(`INSERT INTO organization(id, "platformId", name) VALUES ($1, $2, 'O')`, [organizationId, platformId]);
    const operator = await dbs.tx((q) => users.createOperator({ companyId, email: `op-${suffix}@x.test` }, q));
    const code = generateJoinCode('CORE');
    await dbs.query(
      `INSERT INTO organization_join_code("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","expiresAt","createdBy")
       VALUES ($1, $2, $3, 'member', false, false, now() + interval '1 day', $4)`,
      [organizationId, platformId, hashJoinCode(t.cfg.secrets.joinCodePepper, code.normalized), operator.id],
    );

    const email = `m-${suffix}@x.test`;
    const password = 'member password 1';
    await t.http.post('/auth/register').send({ joinCode: code.display, email, password }).expect(201);
    const login = await t.http.post('/auth/login').send({ email, password }).expect(200);
    const refreshed = await t.http.post('/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
    const me = await t.http.get('/auth/me').set('authorization', `Bearer ${refreshed.body.accessToken}`).expect(200);
    expect(me.body.memberships.map((m: { organization: { id: string } }) => m.organization.id)).toEqual([organizationId]);
  });

  it('runs the operator tools that go beyond plain DML: owner bootstrap (advisory lock) and hierarchy freeze (LOCK TABLE)', async () => {
    const dbs = t.app.get(DbService);
    const r = await bootstrapOwner(dbs, t.app.get(UsersService), t.app.get(PasswordService), { companyName: 'Bootstrap Co', email: `owner-${suffix}@x.test`, password: 'correct horse battery staple' });
    expect(r.created).toBe(true);
    await freeze(dbs, 'runtime-role-test');
    expect(await hierarchyMode(dbs)).toBe('frozen');
    await unfreeze(dbs, 'runtime-role-test');
    expect(await hierarchyMode(dbs)).toBe('local');
  });

  it.each([
    ['create a table', 'CREATE TABLE app_made(id int)'],
    ['alter a table', 'ALTER TABLE "user" ADD COLUMN c int'],
    ['drop a table', 'DROP TABLE auth_audit_event'],
    ['truncate a table', 'TRUNCATE auth_audit_event'],
    ['create a role', 'CREATE ROLE evil LOGIN'],
    ['create a database', 'CREATE DATABASE evil'],
  ])('the runtime role cannot %s', async (_what, sql) => {
    await expect(asApp(sql)).rejects.toThrow(/permission denied|must be owner|not permitted/);
  });
});
