import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { notificationMigrationsDir } from '../src/app.module.js';
import { stableUuid } from '../src/templates/catalog.js';
import { createTestApp, type TestApp } from './support/app.js';
import { failure, sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * ADR-0032: provisions the notification database exactly as `infra/postgres/init` does (the migrator owns the schema; the runtime role
 * gets DML through default privileges), migrates AS THE MIGRATOR, then runs the real application AS THE RUNTIME ROLE, and proves the
 * runtime role can do the service's work but cannot change the schema or get around the invariants. Self-contained: it creates and
 * drops its own roles and database, so it also runs in CI.
 */
describeWithEnv('runtime database role: DML only, invariants unbypassable (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const suffix = randomBytes(4).toString('hex');
  const migrator = `nt_mig_${suffix}`;
  const appRole = `nt_app_${suffix}`;
  const dbName = `nt_notification_${suffix}`;
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
    await runMigrations(urlAs(migrator, migPw), [kitMigrationsDir, notificationMigrationsDir]); // the explicit step, as the schema owner
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
    const owner = await sql<{ o: string }>(adminTo(dbName), `SELECT tableowner AS o FROM pg_tables WHERE tablename = 'notification'`);
    expect(owner[0].o).toBe(migrator);
  });

  it('the runtime role can do the service\'s work: record an intent, a delivery, its transitions and attempts, and purge a secret', async () => {
    const n = randomUUID();
    const d = randomUUID();
    await sql(APP(), `INSERT INTO notification (id, "sourceKind", "sourceService", "sourceEventId", "templateId", category, "secretCiphertext", "secretKeyId", "expiresAt")
                      VALUES ($1, 'event', 'auth-service', gen_random_uuid(), $2, 'SECURITY', '\\x01', 'k1', now() + interval '10 minutes')`, [n, stableUuid('identity.operator_login_code')]);
    await sql(APP(), `INSERT INTO notification_delivery (id, "notificationId", channel, destination, "templateVersionId", locale, "nextAttemptAt") VALUES ($1, $2, 'SMS', '+21620000010', $3, 'en', now())`,
      [d, n, stableUuid('identity.operator_login_code|SMS|en|v1')]);
    await sql(APP(), `UPDATE notification_delivery SET status = 'SENDING', "nextAttemptAt" = NULL, "leaseUntil" = now() + interval '1 minute' WHERE id = $1`, [d]);
    await sql(APP(), `INSERT INTO notification_delivery_attempt ("deliveryId", "attemptNumber", provider) VALUES ($1, 1, 'test-provider')`, [d]);
    await sql(APP(), `UPDATE notification_delivery_attempt SET outcome = 'ACCEPTED', "completedAt" = now(), "providerMessageId" = 'pm-1' WHERE "deliveryId" = $1`, [d]);
    await sql(APP(), `UPDATE notification_delivery SET status = 'SENT', "leaseUntil" = NULL, "sentAt" = now(), "completedAt" = now() WHERE id = $1`, [d]);
    await sql(APP(), `UPDATE notification SET "secretCiphertext" = NULL, "secretKeyId" = NULL WHERE id = $1`, [n]);
  });

  it.each([
    ['CREATE TABLE', 'CREATE TABLE app_made (id int)'],
    ['ALTER TABLE', 'ALTER TABLE notification ADD COLUMN status text'],
    ['DROP TABLE', 'DROP TABLE notification_delivery_attempt'],
    ['TRUNCATE', 'TRUNCATE notification_delivery_attempt'],
    ['disable a trigger', 'ALTER TABLE notification_delivery DISABLE TRIGGER notification_delivery_status_transition'],
    ['drop a trigger', 'DROP TRIGGER notification_template_version_immutable ON notification_template_version'],
    ['replace a trigger function', `CREATE OR REPLACE FUNCTION notification_delivery_status_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`],
    ['skip triggers (replica role)', 'SET session_replication_role = replica'],
    ['create a role', 'CREATE ROLE evil LOGIN'],
  ])('the runtime role cannot %s', async (_label, statement) => {
    const e = await failure(APP(), statement);
    expect(e.code, e.message).toMatch(/^(42501|42P01)$/); // insufficient privilege (or not visible as owner)
  });

  it('the runtime role is bound by every invariant: it cannot edit a published version, skip a transition or rewrite an attempt', async () => {
    expect(await failure(APP(), `UPDATE notification_template_version SET "bodyText" = 'changed' WHERE id = $1`, [stableUuid('identity.operator_login_code|SMS|en|v1')])).toMatchObject({ code: '23514' });
    expect(await failure(APP(), 'DELETE FROM notification_template_version WHERE id = $1', [stableUuid('identity.operator_login_code|SMS|en|v1')])).toMatchObject({ code: '23514' });
    const [row] = await sql<{ id: string }>(APP(), `SELECT id FROM notification_delivery WHERE status = 'SENT' LIMIT 1`);
    expect(await failure(APP(), `UPDATE notification_delivery SET status = 'PENDING', "nextAttemptAt" = now(), "completedAt" = NULL, "sentAt" = NULL WHERE id = $1`, [row.id])).toMatchObject({ code: '23514' });
    expect(await failure(APP(), `UPDATE notification_delivery_attempt SET outcome = 'TERMINAL_FAILURE' WHERE "deliveryId" = $1`, [row.id])).toMatchObject({ code: '23514' });
  });
});
