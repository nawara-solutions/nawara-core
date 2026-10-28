import { randomBytes } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { InboxService, OutboxService, PgProvenanceStore, RateLimitService, DbService, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { billingMigrationsDir } from '../src/app.module.js';
import { normaliseCreateInvoiceInput } from '../src/domain/invoice-input.js';
import { InvoiceRepository } from '../src/invoices/invoice.repository.js';
import { PlatformCurrencyRepository } from '../src/currencies/platform-currency.repository.js';
import { PaymentRequestRepository } from '../src/invoices/payment-request.repository.js';
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

  it('Core V2 S1e-2: the runtime role holds only INSERT and SELECT on payment_event_origin; UPDATE and DELETE are refused by privilege', async () => {
    const owner = new pg.Client({ connectionString: urlFor(migrator, migPw) });
    const app = new pg.Client({ connectionString: urlFor(appRole, appPw) });
    await owner.connect();
    await app.connect();
    try {
      const grants = await owner.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = 'payment_event_origin' ORDER BY 1`, [appRole]);
      expect(grants.rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
      const id = crypto.randomUUID();
      await app.query(`INSERT INTO payment_event_origin ("eventId", source, "eventName", "eventVersion", "occurredAt") VALUES ($1, 'payment-service', 'payment.succeeded', 1, '2026-01-01T00:00:00.000Z')`, [id]);
      await expect(app.query(`UPDATE payment_event_origin SET "eventVersion" = 2 WHERE "eventId" = $1`, [id])).rejects.toThrow(/permission denied/);
      await expect(app.query(`DELETE FROM payment_event_origin WHERE "eventId" = $1`, [id])).rejects.toThrow(/permission denied/);
    } finally {
      await owner.end();
      await app.end();
    }
  });

  it('Core V2 S3c: the runtime role holds only INSERT and SELECT on personal_subscription, subscription_purchase and subscription_purchase_reversal', async () => {
    const owner = new pg.Client({ connectionString: urlFor(migrator, migPw) });
    const app = new pg.Client({ connectionString: urlFor(appRole, appPw) });
    await owner.connect();
    await app.connect();
    try {
      for (const table of ['personal_subscription', 'subscription_purchase', 'subscription_purchase_reversal']) {
        const grants = await owner.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = $2 ORDER BY 1`, [appRole, table]);
        expect(grants.rows.map((r) => r.privilege_type), table).toEqual(['INSERT', 'SELECT']);
        await expect(app.query(`DELETE FROM ${table}`), table).rejects.toThrow(/permission denied/);
        await expect(app.query(`TRUNCATE ${table}`), table).rejects.toThrow(/permission denied/);
      }
      // the ledger's identity column is usable by the runtime role (a purchase can be appended)
      expect((await owner.query(`SELECT has_sequence_privilege($1, pg_get_serial_sequence('subscription_purchase', 'ledgerSeq'), 'USAGE') AS ok`, [appRole])).rows[0].ok).toBe(true);
    } finally {
      await owner.end();
      await app.end();
    }
  });

  it('Core V2 S3f: the runtime role holds INSERT and SELECT on the append-only fee tables, and UPDATE only on fee_proposal (its guarded decision)', async () => {
    const owner = new pg.Client({ connectionString: urlFor(migrator, migPw) });
    const app = new pg.Client({ connectionString: urlFor(appRole, appPw) });
    await owner.connect();
    await app.connect();
    try {
      const expected: Record<string, string[]> = {
        fee_cap: ['INSERT', 'SELECT'], fee_delegation: ['INSERT', 'SELECT'], fee_delegation_revocation: ['INSERT', 'SELECT'],
        fee_command_idempotency: ['INSERT', 'SELECT'], fee_proposal: ['INSERT', 'SELECT', 'UPDATE'],
        checkout_idempotency: ['INSERT', 'SELECT'], // S3f direct checkout (0026)
        assistance_request: ['INSERT', 'SELECT', 'UPDATE'], assistance_command_idempotency: ['INSERT', 'SELECT'], // S5a Organization assistance (0029)
        assistance_settlement_channel: ['INSERT', 'SELECT', 'UPDATE'], cash_return_obligation: ['INSERT', 'SELECT', 'UPDATE'], assistance_late_settlement: ['INSERT', 'SELECT'], // S5b (0030)
        assistance_dispute: ['INSERT', 'SELECT', 'UPDATE'], assistance_dispute_response: ['INSERT', 'SELECT'], assistance_correction: ['INSERT', 'SELECT'], // S5c (0031)
        refund_case: ['INSERT', 'SELECT', 'UPDATE'], refund_command_idempotency: ['INSERT', 'SELECT'], // S6a (0033)
      };
      for (const [table, privileges] of Object.entries(expected)) {
        const grants = await owner.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = $2 ORDER BY 1`, [appRole, table]);
        expect(grants.rows.map((r) => r.privilege_type), table).toEqual(privileges);
        await expect(app.query(`DELETE FROM ${table}`), table).rejects.toThrow(/permission denied/);
        await expect(app.query(`TRUNCATE ${table}`), table).rejects.toThrow(/permission denied/);
      }
    } finally {
      await owner.end();
      await app.end();
    }
  });

  it('Core V2 S3d (BIL-01): the runtime role holds only INSERT and SELECT on billing_platform; UPDATE, DELETE and TRUNCATE are refused by privilege', async () => {
    const owner = new pg.Client({ connectionString: urlFor(migrator, migPw) });
    const app = new pg.Client({ connectionString: urlFor(appRole, appPw) });
    await owner.connect();
    await app.connect();
    try {
      const grants = await owner.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = 'billing_platform' ORDER BY 1`, [appRole]);
      expect(grants.rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
      await app.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES (gen_random_uuid(), gen_random_uuid(), 'TND', gen_random_uuid())`);
      await expect(app.query(`UPDATE billing_platform SET currency = 'TND'`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`DELETE FROM billing_platform`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`TRUNCATE billing_platform`)).rejects.toThrow(/permission denied/);
    } finally {
      await owner.end();
      await app.end();
    }
  });

  it('Core V2 S3b (DB-9 / DB-10): the runtime role holds only INSERT and SELECT on subscription_settlement; UPDATE, DELETE and TRUNCATE are refused by privilege', async () => {
    const owner = new pg.Client({ connectionString: urlFor(migrator, migPw) });
    const app = new pg.Client({ connectionString: urlFor(appRole, appPw) });
    await owner.connect();
    await app.connect();
    try {
      const grants = await owner.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = 'subscription_settlement' ORDER BY 1`, [appRole]);
      expect(grants.rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
      await expect(app.query(`UPDATE subscription_settlement SET "settledAt" = now()`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`DELETE FROM subscription_settlement`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`TRUNCATE subscription_settlement`)).rejects.toThrow(/permission denied/);
    } finally {
      await owner.end();
      await app.end();
    }
  });

  it('Core V2 S3a (DB-1): the runtime role holds only INSERT and SELECT on invoice_entitlement; UPDATE, DELETE and TRUNCATE are refused by privilege', async () => {
    const owner = new pg.Client({ connectionString: urlFor(migrator, migPw) });
    const app = new pg.Client({ connectionString: urlFor(appRole, appPw) });
    await owner.connect();
    await app.connect();
    try {
      const grants = await owner.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = 'invoice_entitlement' ORDER BY 1`, [appRole]);
      expect(grants.rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
      await expect(app.query(`UPDATE invoice_entitlement SET target = 'none'`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`DELETE FROM invoice_entitlement`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`TRUNCATE invoice_entitlement`)).rejects.toThrow(/permission denied/);
    } finally {
      await owner.end();
      await app.end();
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

  it('Core V2 S1b: the provenance store works as the runtime role (advisory lock, insert, conflict evidence), and its rows stay append-only', async () => {
    const store = new PgProvenanceStore(t.app.get(DbService));
    const eventId = crypto.randomUUID();
    const o = {
      source: 'payment-service', eventId, name: 'payment.succeeded', routingKey: 'payment.succeeded', exchange: 'nawara.events', bodySha256: 'a'.repeat(64),
      producerUserId: 'payment-service', verified: true, reason: 'verified' as const,
    };
    expect(await store.record('billing.payment-events', o)).toBe('recorded');
    expect(await store.record('billing.payment-events', o)).toBe('duplicate');
    expect(await store.record('billing.payment-events', { ...o, bodySha256: 'b'.repeat(64) })).toBe('conflict');
    const app = new pg.Client({ connectionString: urlFor(appRole, appPw) });
    await app.connect();
    try {
      for (const table of ['event_provenance', 'event_provenance_conflict']) {
        await expect(app.query(`UPDATE ${table} SET verified = verified`)).rejects.toMatchObject({ code: '23514' });
        await expect(app.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '23514' });
        await expect(app.query(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject({ code: '42501' }); // no TRUNCATE privilege at all
      }
    } finally {
      await app.end();
    }
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

  it('the whole Stage 2 flow works as the runtime role: create, issue with a number and an event, payment request, history', async () => {
    const db = t.app.get(DbService);
    const invoices = t.app.get(InvoiceRepository);
    const requests = t.app.get(PaymentRequestRepository);
    const org = crypto.randomUUID();
    const product = (await db.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name) VALUES ('test-producer', 'organization', $1, 'plan-a', 'Plan A') RETURNING id`, [org])).rows[0].id;
    const priceId = (await db.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval") VALUES ($1, 'p1', 'TND', 2500, 'one_time') RETURNING id`, [product])).rows[0].id;
    const ctx = { actor: { type: 'service' as const, id: 'test-producer' }, cause: { type: 'request' as const, id: 'r1' } };
    const input = normaliseCreateInvoiceInput({
      invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: org }, payer: { type: 'user', id: 'user-1' }, sourceType: 'contract', sourceId: 'c-1',
      issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId, quantity: 2 }],
    });
    const draft = (await invoices.createDraft('test-producer', input, ['TND'], ctx)).invoice;
    const open = (await invoices.issue(draft.id, { kind: 'service', service: 'test-producer' }, { template: 'system:1', locale: 'fr' }, ctx)).invoice;
    expect(open).toMatchObject({ status: 'open', number: '1', total: '5000' });
    const req = (await requests.createForInvoice(open.id, { kind: 'user', userId: 'user-1' }, ctx)).request;
    expect(req).toMatchObject({ status: 'created', amount: '5000' });
    expect((await db.query(`SELECT count(*)::int AS n FROM outbox WHERE name = 'invoice.created' AND payload->>'invoiceId' = $1`, [open.id])).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityId" = ANY($1::uuid[])`, [[open.id, req.id]])).rows[0].n).toBe(3);
    // Platform currency configuration works as the runtime role too, and leaves a row for the guard test below
    const platforms = t.app.get(PlatformCurrencyRepository);
    await platforms.enable('platform-rt', 'TND');
    expect(await platforms.isPermitted('platform-rt', 'TND')).toBe(true);
    expect((await platforms.disable('platform-rt', 'TND')).revision).toBe(1);
    // an event receipt, so the append-only guard below has a row to refuse to change (a row-level guard cannot fire on an empty table)
    const ignored = await requests.applyPaymentEvent(crypto.randomUUID(), {
      name: 'payment.failed', source: 'payment-service', paymentId: crypto.randomUUID(), producer: 'billing-service', paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: open.id,
      payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: org }, organizationId: org, amount: 5000, currency: 'TND', revision: 1,
    }, { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: 'e1' } }, new Date());
    expect(ignored).toMatchObject({ outcome: 'ignored', detail: 'unknown_payment_request' });
  });

  it('the runtime role cannot bypass a Stage 2 guard: no trigger switch-off, no replica mode, no truncate, no delete, no rewrite of history, a counter or a currency', async () => {
    const app = new pg.Client({ connectionString: urlFor(appRole, appPw) });
    await app.connect();
    try {
      for (const statement of [
        'ALTER TABLE platform_currency DISABLE TRIGGER USER',
        'ALTER TABLE invoice DISABLE TRIGGER USER',
        'ALTER TABLE invoice DISABLE TRIGGER invoice_10_immutable',
        'DROP TRIGGER invoice_20_lifecycle ON invoice',
        'DROP TABLE billing_transition',
        'TRUNCATE invoice CASCADE',
        'TRUNCATE billing_transition',
        'ALTER TABLE currency DROP CONSTRAINT currency_pkey CASCADE',
        'SET session_replication_role = replica',
        'CREATE OR REPLACE FUNCTION billing_allocate_invoice_number(text, text) RETURNS text LANGUAGE sql AS $$ SELECT \'1\' $$',
      ]) {
        await expect(app.query(statement), statement).rejects.toMatchObject({ code: '42501' });
      }
      // ...and the guards that protect the invariants still bind it (DML the role IS allowed to attempt)
      for (const statement of [
        'UPDATE invoice SET total = total + 1',
        'UPDATE invoice SET currency = \'EUR\'',
        'DELETE FROM invoice',
        'DELETE FROM invoice_line',
        'DELETE FROM payment_request',
        'UPDATE billing_transition SET "toStatus" = \'paid\'',
        'DELETE FROM billing_transition',
        'UPDATE payment_event_receipt SET outcome = \'applied\'',
        'DELETE FROM payment_event_receipt',
        'UPDATE invoice_number_sequence SET "nextValue" = 2',
        'DELETE FROM invoice_number_sequence',
        'UPDATE platform_currency SET "platformId" = \'elsewhere\'',
        'UPDATE platform_currency SET currency = \'TND\', "createdAt" = now() - interval \'1 day\'',
        'DELETE FROM platform_currency',
        'UPDATE currency SET exponent = 2',
        'DELETE FROM currency',
        'UPDATE price SET "unitAmount" = 1',
        'UPDATE invoice_line SET quantity = quantity + 1',
      ]) {
        await expect(app.query(statement), statement).rejects.toMatchObject({ code: '23514' });
      }
    } finally {
      await app.end();
    }
  });
});
