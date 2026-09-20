import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { organizationMigrationsDir } from '../src/app.module.js';
import { createTestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { MISSING_ID, client, sql } from './support/fixtures.js';

const KIT_MIGRATIONS = ['kit_0001_outbox_inbox.sql', 'kit_0002_rate_limit.sql', 'kit_0003_generic_triggers.sql'];
const OWN_MIGRATIONS = ['0001_company_platform_organization.sql', '0002_idempotency_key.sql', '0003_platform_key.sql'];
/** Exactly the schema of this stage. The exact-set assertion is the tripwire against a table for a concept this service must not own. */
const TABLES = ['company', 'idempotency_key', 'inbox', 'kit_rate_limit', 'organization', 'outbox', 'platform', 'schema_migrations'];

const tableNames = async (url: string) => (await sql<{ table_name: string }>(url, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).map((r) => r.table_name);

async function failsWith(url: string, text: string, params: unknown[] = []): Promise<{ code?: string; constraint?: string }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(text, params);
  } catch (e) {
    return { code: (e as { code?: string }).code, constraint: (e as { constraint?: string }).constraint };
  } finally {
    await c.end();
  }
  throw new Error(`statement unexpectedly succeeded: ${text}`);
}

describeWithEnv('migrations and database integrity (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgmig');
  });
  afterAll(() => db.drop());

  it('applies the kit migrations and this service\'s three migrations from an empty database, in order, creating exactly the expected tables', async () => {
    const first = await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    expect(first.applied).toEqual([...KIT_MIGRATIONS, ...OWN_MIGRATIONS]);
    expect(await tableNames(db.url)).toEqual(TABLES);
  });

  it('is idempotent: a second run applies nothing', async () => {
    expect((await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir])).applied).toEqual([]);
  });

  it('creates NO table for a concept this service must not own: users, credentials, sessions, MFA, membership, billing, payment, accounting, products, prices, invoices, entitlements, or invented hierarchy entities', async () => {
    const present = await tableNames(db.url);
    for (const forbidden of [
      'user', 'users', 'owner', 'operator', 'credential', 'session', 'refresh_token', 'mfa', 'membership', 'organization_membership', 'join_code',
      'invoice', 'payment', 'product', 'price', 'license', 'subscription', 'entitlement', 'ledger', 'wallet',
      'tenant', 'workspace', 'business_unit', 'department', 'team', 'group', 'platform_assignment', 'auth_organization', 'outbox_import', 'migration_freeze', 'authority',
    ]) expect(present, forbidden).not.toContain(forbidden);
  });

  it('is self-contained: every foreign key stays inside this database (no cross-service reference), and no cross-database extension is installed', async () => {
    const fks = await sql<{ from_table: string; to_table: string }>(
      db.url,
      `SELECT conrelid::regclass::text AS from_table, confrelid::regclass::text AS to_table FROM pg_constraint WHERE contype = 'f' ORDER BY 1, 2`,
    );
    expect(fks).toEqual([
      { from_table: 'organization', to_table: 'platform' },
      { from_table: 'platform', to_table: 'company' },
    ]);
    const ext = await sql<{ extname: string }>(db.url, `SELECT extname FROM pg_extension ORDER BY 1`);
    expect(ext.map((e) => e.extname)).toEqual(['plpgsql']); // no dblink, no postgres_fdw
    const fdw = await sql(db.url, `SELECT 1 FROM pg_foreign_server`);
    expect(fdw).toHaveLength(0);
  });

  it('has NO Organization -> Company shortcut: organization has platformId only, platform has companyId only (and platform carries auth-service\'s optional `key`)', async () => {
    const cols = async (t: string) => (await sql<{ column_name: string }>(db.url, `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY 1`, [t])).map((c) => c.column_name);
    expect(await cols('company')).toEqual(['createdAt', 'id', 'name', 'updatedAt']);
    expect(await cols('platform')).toEqual(['companyId', 'createdAt', 'id', 'key', 'name', 'updatedAt']);
    expect(await cols('organization')).toEqual(['address', 'createdAt', 'id', 'name', 'phone', 'platformId', 'taxCode', 'type', 'updatedAt']);
  });

  describe('hierarchy integrity is enforced by the DATABASE, not only by the controllers', () => {
    const CO = '11111111-1111-4111-8111-111111111111';
    const PL = '22222222-2222-4222-8222-222222222222';
    const OR = '33333333-3333-4333-8333-333333333333';
    beforeAll(async () => {
      await sql(db.url, `INSERT INTO company (id, name) VALUES ($1, 'Co')`, [CO]);
      await sql(db.url, `INSERT INTO platform (id, "companyId", name) VALUES ($1, $2, 'Pl')`, [PL, CO]);
      await sql(db.url, `INSERT INTO organization (id, "platformId", name) VALUES ($1, $2, 'Or')`, [OR, PL]);
    });

    it('a platform must reference an existing company (23503 platform_company_fk); an organization an existing platform (organization_platform_fk)', async () => {
      expect(await failsWith(db.url, `INSERT INTO platform ("companyId", name) VALUES ($1, 'x')`, [MISSING_ID])).toEqual({ code: '23503', constraint: 'platform_company_fk' });
      expect(await failsWith(db.url, `INSERT INTO organization ("platformId", name) VALUES ($1, 'x')`, [MISSING_ID])).toEqual({ code: '23503', constraint: 'organization_platform_fk' });
      // an organization cannot point at a COMPANY id (that would be the forbidden shortcut)
      expect((await failsWith(db.url, `INSERT INTO organization ("platformId", name) VALUES ($1, 'x')`, [CO])).code).toBe('23503');
    });

    it('the parent reference is NOT NULL', async () => {
      expect((await failsWith(db.url, `INSERT INTO platform ("companyId", name) VALUES (NULL, 'x')`)).code).toBe('23502');
      expect((await failsWith(db.url, `INSERT INTO organization ("platformId", name) VALUES (NULL, 'x')`)).code).toBe('23502');
    });

    it('a name is required and cannot be blank (23514 / 23502) on every table (same check as auth-service: `btrim(name) <> \'\'`, spaces; the API also rejects tabs and newlines)', async () => {
      expect((await failsWith(db.url, `INSERT INTO company (name) VALUES (' ')`)).code).toBe('23514');
      expect((await failsWith(db.url, `INSERT INTO company (name) VALUES (NULL)`)).code).toBe('23502');
      expect((await failsWith(db.url, `INSERT INTO platform ("companyId", name) VALUES ($1, '')`, [CO])).code).toBe('23514');
      expect((await failsWith(db.url, `INSERT INTO organization ("platformId", name) VALUES ($1, '   ')`, [PL])).code).toBe('23514');
    });

    it('deleting a parent that still has children is refused (ON DELETE RESTRICT): there is no cascade and no orphan', async () => {
      expect((await failsWith(db.url, `DELETE FROM company WHERE id = $1`, [CO])).code).toBe('23503');
      expect((await failsWith(db.url, `DELETE FROM platform WHERE id = $1`, [PL])).code).toBe('23503');
    });

    it('a platform can never be moved to another company, an organization never to another platform, and ids and creation times are frozen (trigger, 23514)', async () => {
      const otherCo = '44444444-4444-4444-8444-444444444444';
      const otherPl = '55555555-5555-4555-8555-555555555555';
      await sql(db.url, `INSERT INTO company (id, name) VALUES ($1, 'Other')`, [otherCo]);
      await sql(db.url, `INSERT INTO platform (id, "companyId", name) VALUES ($1, $2, 'OtherPl')`, [otherPl, CO]);
      for (const [text, params] of [
        [`UPDATE platform SET "companyId" = $2 WHERE id = $1`, [PL, otherCo]],
        [`UPDATE organization SET "platformId" = $2 WHERE id = $1`, [OR, otherPl]],
        [`UPDATE company SET id = $2 WHERE id = $1`, [otherCo, MISSING_ID]],
        [`UPDATE platform SET id = $2 WHERE id = $1`, [PL, MISSING_ID]],
        [`UPDATE organization SET id = $2 WHERE id = $1`, [OR, MISSING_ID]],
        [`UPDATE company SET "createdAt" = now() - interval '1 day' WHERE id = $1`, [CO]],
        [`UPDATE organization SET "createdAt" = now() - interval '1 day' WHERE id = $1`, [OR]],
      ] as [string, unknown[]][]) {
        expect((await failsWith(db.url, text, params)).code, text).toBe('23514');
      }
      // ...while the ordinary, mutable fields update fine
      await sql(db.url, `UPDATE organization SET name = 'Or2', "taxCode" = 'T', address = 'A', phone = 'P', type = 'K', "updatedAt" = now() WHERE id = $1`, [OR]);
      await sql(db.url, `UPDATE platform SET name = 'Pl2' WHERE id = $1`, [PL]);
      await sql(db.url, `UPDATE company SET name = 'Co2' WHERE id = $1`, [CO]);
    });

    it('a duplicate id is refused by the primary key (23505)', async () => {
      expect((await failsWith(db.url, `INSERT INTO company (id, name) VALUES ($1, 'dup')`, [CO])).code).toBe('23505');
    });
  });

  describe('a later import can represent existing records without a schema change (nothing here IMPORTS anything)', () => {
    it('accepts explicitly supplied ids AND original timestamps, keeps the parent-child links, and serves them through the normal API', async () => {
      const own = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgimport');
      await runMigrations(own.url, [kitMigrationsDir, organizationMigrationsDir]);
      const t = await createTestApp({ databaseUrl: own.url });
      try {
        const co = 'aaaaaaaa-0000-4000-8000-000000000001';
        const pl = 'aaaaaaaa-0000-4000-8000-000000000002';
        const or = 'aaaaaaaa-0000-4000-8000-000000000003';
        const created = '2023-05-01T08:00:00.000123Z';
        const updated = '2024-06-02T09:30:00.000456Z';
        // Insertion order is parent-first, exactly as a foreign key needs: the same ids as the rows they would come from.
        await sql(own.url, `INSERT INTO company (id, name, "createdAt", "updatedAt") VALUES ($1, 'Legacy Co', $2, $3)`, [co, created, updated]);
        await sql(own.url, `INSERT INTO platform (id, "companyId", name, "createdAt", "updatedAt") VALUES ($1, $2, 'Legacy Pl', $3, $4)`, [pl, co, created, updated]);
        await sql(own.url, `INSERT INTO organization (id, "platformId", name, "taxCode", address, phone, type, "createdAt", "updatedAt") VALUES ($1, $2, 'Legacy Org', 'T', 'A', 'P', 'opaque', $3, $4)`, [or, pl, created, updated]);

        const c = client(t);
        const org = (await c.get(`/organization/organizations/${or}`)).body;
        expect(org).toMatchObject({ id: or, platformId: pl, name: 'Legacy Org', taxCode: 'T', type: 'opaque' });
        expect(new Date(org.createdAt).toISOString()).toBe('2023-05-01T08:00:00.000Z');
        expect((await c.get(`/organization/platforms/${pl}`)).body).toMatchObject({ id: pl, companyId: co });
        expect((await c.get(`/organization/companies/${co}`)).body).toMatchObject({ id: co, name: 'Legacy Co' });
        expect((await c.get(`/organization/organizations?platformId=${pl}`)).body.items.map((i: { id: string }) => i.id)).toEqual([or]);

        // an imported record is an ordinary record afterwards, and an ordinary create does not collide with it
        expect((await c.patch(`/organization/organizations/${or}`, { name: 'Renamed' })).body.name).toBe('Renamed');
        expect((await c.organization(pl)).id).not.toBe(or);
      } finally {
        await t.app.close();
        await own.drop();
      }
    });

    it('the public API never accepts a client-chosen id: import is not a normal CRUD path', async () => {
      const own = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgnoid');
      await runMigrations(own.url, [kitMigrationsDir, organizationMigrationsDir]);
      const t = await createTestApp({ databaseUrl: own.url });
      try {
        const c = client(t);
        for (const [path, body] of [
          ['/organization/companies', { id: MISSING_ID, name: 'x' }],
          ['/organization/platforms', { id: MISSING_ID, companyId: MISSING_ID, name: 'x' }],
          ['/organization/organizations', { id: MISSING_ID, platformId: MISSING_ID, name: 'x' }],
        ] as [string, object][]) expect((await c.post(path, body)).status, path).toBe(400);
      } finally {
        await t.app.close();
        await own.drop();
      }
    });
  });
});
