import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { sql } from './db.js';

export interface ProvisionedDatabase {
  name: string;
  migrator: string;
  app: string;
  migratorUrl: string;
  appUrl: string;
  adminUrl: string;
  drop(): Promise<void>;
}

/**
 * A database provisioned exactly as `infra/postgres/init` does (ADR-0032): the migrator owns the database and the schema, the runtime
 * role gets DML on the migrator's future tables through DEFAULT PRIVILEGES (the Core default the release migration then narrows). Own
 * random role and database names, so suites stay independent and run in CI.
 */
export async function provisionServiceDatabase(adminUrl: string, prefix: string): Promise<ProvisionedDatabase> {
  const suffix = randomBytes(4).toString('hex');
  const migrator = `${prefix}_mig_${suffix}`;
  const app = `${prefix}_app_${suffix}`;
  const name = `${prefix}_db_${suffix}`;
  const migPw = randomBytes(12).toString('hex');
  const appPw = randomBytes(12).toString('hex');
  const url = (user: string | undefined, pw: string | undefined, db: string) => {
    const u = new URL(adminUrl);
    if (user) u.username = user;
    if (pw) u.password = pw;
    u.pathname = `/${db}`;
    return u.toString();
  };
  await sql(adminUrl, `CREATE ROLE ${migrator} LOGIN PASSWORD '${migPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await sql(adminUrl, `CREATE ROLE ${app} LOGIN PASSWORD '${appPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await sql(adminUrl, `CREATE DATABASE ${name} OWNER ${migrator}`);
  await sql(adminUrl, `REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
  await sql(adminUrl, `GRANT CONNECT ON DATABASE ${name} TO ${app}`);
  const scoped = new pg.Client({ connectionString: url(undefined, undefined, name) });
  await scoped.connect();
  try {
    await scoped.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await scoped.query(`ALTER SCHEMA public OWNER TO ${migrator}`);
    await scoped.query(`GRANT USAGE ON SCHEMA public TO ${app}`);
    await scoped.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`);
    await scoped.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${app}`);
  } finally {
    await scoped.end();
  }
  return {
    name, migrator, app,
    migratorUrl: url(migrator, migPw, name),
    appUrl: url(app, appPw, name),
    adminUrl: url(undefined, undefined, name),
    async drop() {
      await sql(adminUrl, 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
      await sql(adminUrl, `DROP DATABASE IF EXISTS ${name}`);
      await sql(adminUrl, `DROP ROLE IF EXISTS ${app}`);
      await sql(adminUrl, `DROP ROLE IF EXISTS ${migrator}`);
    },
  };
}
