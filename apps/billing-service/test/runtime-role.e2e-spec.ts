import { randomBytes } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { InboxService, OutboxService, RateLimitService, DbService, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { billingMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

/**
 * ADR-0032: the service runs as a least-privilege role that OWNS nothing. This provisions roles the way `infra/postgres/init`
 * does (migrator owns the schema; the runtime role gets DML through default privileges), migrates as the migrator, and runs the
 * real application as the runtime role. Self-contained: it creates and drops its own roles, so it also runs in CI.
 */
describeWithEnv('runtime database role: the service runs as a non-owner, DML-only role', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const suffix = randomBytes(4).toString('hex');
  const migrator = `bl_mig_${suffix}`;
  const appRole = `bl_app_${suffix}`;
  const dbName = `bl_billing_${suffix}`;
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
    await runMigrations(urlFor(migrator, migPw), [kitMigrationsDir, billingMigrationsDir]); // the explicit migration step, as the schema owner
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

  it('is ready as the runtime role: connect, and see every applied migration', async () => {
    await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' });
  });

  it('the foundation infrastructure works as the runtime role: outbox, inbox, transaction rollback and the rate limiter', async () => {
    const db = t.app.get(DbService);
    const outbox = t.app.get(OutboxService);
    const id = crypto.randomUUID();
    await db.tx(async (q) => outbox.enqueue(q, { id, name: 'probe.happened', payload: { ok: true } }));
    expect((await db.query('SELECT count(*)::int AS n FROM outbox WHERE id = $1', [id])).rows[0].n).toBe(1);

    // a failing transaction leaves neither a business row nor its event (the atomicity the SDD builds on)
    const rolledBack = crypto.randomUUID();
    await expect(db.tx(async (q) => { await outbox.enqueue(q, { id: rolledBack, name: 'probe.rolled_back', payload: {} }); throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await db.query('SELECT count(*)::int AS n FROM outbox WHERE id = $1', [rolledBack])).rows[0].n).toBe(0);

    const event: EventEnvelope = { id: crypto.randomUUID(), name: 'probe.happened', payload: {}, headers: { eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), source: 'other-service', version: 1 } };
    const inbox = t.app.get(InboxService);
    expect(await inbox.handle(db, event, async () => undefined)).toBe('processed');
    expect(await inbox.handle(db, event, async () => undefined)).toBe('duplicate');

    const limiter = t.app.get(RateLimitService);
    expect((await limiter.hit('probe', 'someone', { limit: 1, windowSec: 60 })).allowed).toBe(true);
    expect((await limiter.hit('probe', 'someone', { limit: 1, windowSec: 60 })).allowed).toBe(false);
  });

  it('the runtime role cannot change the schema, disable a trigger, truncate, or rewrite an event', async () => {
    const app = new pg.Client({ connectionString: urlFor(appRole, appPw) });
    await app.connect();
    try {
      for (const statement of [
        'CREATE TABLE app_made (id int)',
        'ALTER TABLE outbox ADD COLUMN evil int',
        'ALTER TABLE outbox DISABLE TRIGGER outbox_immutable',
        'DROP TRIGGER outbox_immutable ON outbox',
        'DROP TABLE inbox',
        'TRUNCATE outbox',
        'CREATE OR REPLACE FUNCTION forbid_column_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
      ]) {
        await expect(app.query(statement), statement).rejects.toMatchObject({ code: '42501' }); // insufficient_privilege
      }
      // the guards that protect the invariants still bind it: a published event's content is immutable
      await expect(app.query(`UPDATE outbox SET name = 'evil.changed'`)).rejects.toMatchObject({ code: '23514' });
    } finally {
      await app.end();
    }
  });
});
