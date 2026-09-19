import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { AttemptResolver } from '../src/attempts/attempt-resolver.js';
import { ExpirySweeper } from '../src/payments/expiry-sweeper.js';
import { TestPaymentProvider } from '../src/providers/test-provider.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

/**
 * ADR-0032 / SDD section 16: the service runs as a least-privilege role that OWNS nothing. Every other suite connects as
 * the superuser that created its scratch database, which would hide a missing grant or an owner-only operation. This one
 * reproduces the provisioning of `infra/postgres/init` (migrator owns the schema, app gets DML through default
 * privileges), migrates as the migrator and runs the real service as the app role.
 */
describeWithEnv('runtime database role: service runs as a non-owner, DML-only role', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const suffix = randomBytes(4).toString('hex');
  const migrator = `rv_mig_${suffix}`;
  const appRole = `rv_app_${suffix}`;
  const dbName = `rv_payment_${suffix}`;
  const migPw = randomBytes(12).toString('hex');
  const appPw = randomBytes(12).toString('hex');
  const urlFor = (user: string, pw: string) => {
    const u = new URL(env.TEST_DATABASE_ADMIN_URL);
    u.username = user;
    u.password = pw;
    u.pathname = `/${dbName}`;
    return u.toString();
  };
  const billing = generateServiceToken();
  const user: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const authClient: AuthClient = { getIdentity: async (b) => (b === 'user-1-jwt' ? user : null), hasPlatformAccess: async () => false };
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
    const scoped = new pg.Client({ connectionString: (() => { const u = new URL(env.TEST_DATABASE_ADMIN_URL); u.pathname = `/${dbName}`; return u.toString(); })() });
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
    await runMigrations(urlFor(migrator, migPw), [kitMigrationsDir, paymentMigrationsDir]); // the explicit migration step, as the schema owner
    t = await createTestApp({
      databaseUrl: urlFor(appRole, appPw), // the RUNTIME role
      tokens: [{ caller: 'billing-service', digest: billing.digest }],
      authClient,
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      env: { PAYMENT_TEST_PROVIDER: 'true' },
    });
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

  it('the whole Phase 1 flow works as the runtime role: create, attempt, signed webhook, outbox, resolver, sweeper, rate limiter, readiness', async () => {
    const server = t.app.getHttpServer();
    const organizationId = crypto.randomUUID();
    const body = { paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: 'i-1', payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: organizationId }, organizationId, amount: 1000, currency: 'TND' };
    const payment = (await request(server).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(body).expect(201)).body;
    const attempt = (await request(server).post(`/payment/payments/${payment.id}/attempts`).set('authorization', 'Bearer user-1-jwt').set('idempotency-key', 'rv-key-aaaa').send({ providerOptions: { scenario: 'success' } }).expect(201)).body;
    const { body: raw, signature } = t.app.get(TestPaymentProvider).signSuccessCallback(attempt.id);
    await request(server).post('/payment/webhooks/test').set('content-type', 'application/json').set('x-test-provider-signature', signature).send(raw.toString('utf8')).expect(200);
    const after = (await request(server).get(`/payment/payments/${payment.id}`).set('authorization', 'Bearer user-1-jwt').expect(200)).body;
    expect(after.status).toBe('succeeded');
    await t.app.get(AttemptResolver).drainOnce();
    await t.app.get(ExpirySweeper).sweepOnce();
    await request(server).get('/ready').expect(200);
  });

  it('the runtime role cannot change the schema, disable a trigger, or truncate a financial table', async () => {
    const app = new pg.Client({ connectionString: urlFor(appRole, appPw) });
    await app.connect();
    try {
      for (const statement of [
        'CREATE TABLE app_made (id int)',
        'ALTER TABLE payment ADD COLUMN evil int',
        'ALTER TABLE payment DISABLE TRIGGER payment_status_transition',
        'DROP TRIGGER payment_snapshot_immutable ON payment',
        'DROP TABLE payment_attempt',
        'TRUNCATE payment',
        'CREATE OR REPLACE FUNCTION forbid_column_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
        'DROP INDEX payment_attempt_one_succeeded',
      ]) {
        await expect(app.query(statement), statement).rejects.toMatchObject({ code: '42501' }); // insufficient_privilege
      }
      // ...and the guards that protect the invariants still bind it: a runtime-role UPDATE cannot rewrite the snapshot.
      await expect(app.query(`UPDATE payment SET amount = amount + 1`)).rejects.toMatchObject({ code: '23514' });
    } finally {
      await app.end();
    }
  });
});
