import { mkdtempSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { organizationMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { MISSING_ID, client, sql } from './support/fixtures.js';

/**
 * Platform.key, reproduced from auth-service migration 0004 (`platform.key text`, nullable, no default,
 * `CHECK (key IS NULL OR key ~ '^[a-z][a-z0-9-]{1,39}$')`, `UNIQUE (key)`, no trigger, no foreign key). These tests pin every part of
 * that definition and prove a Platform carrying an Auth-compatible key can exist, be read and be edited here unchanged. Nothing imports
 * from auth-service: the expected values below are the literal definition.
 */
const KEY_FORMAT_DEF = `CHECK (((key IS NULL) OR (key ~ '^[a-z][a-z0-9-]{1,39}$'::text)))`;

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

describeWithEnv('platform.key (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const CO = 'c2000000-0000-4000-8000-000000000001';
  let n = 0;
  const pid = () => `a2000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const insert = (key: string | null, id = pid()) => sql(db.url, `INSERT INTO platform (id, "companyId", name, key) VALUES ($1, $2, 'P', $3) RETURNING id`, [id, CO, key]);

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgkey');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    await sql(db.url, `INSERT INTO company (id, name) VALUES ($1, 'Co')`, [CO]);
    t = await createTestApp({ databaseUrl: db.url });
  });
  afterAll(async () => {
    await t?.app.close();
    await db.drop();
  });

  describe('the persisted definition matches auth-service migration 0004', () => {
    it('is `key text`, nullable, with no default', async () => {
      const [col] = await sql(db.url, `SELECT data_type, is_nullable, column_default, collation_name FROM information_schema.columns WHERE table_name = 'platform' AND column_name = 'key'`);
      expect(col).toEqual({ data_type: 'text', is_nullable: 'YES', column_default: null, collation_name: null }); // database default collation, as in Auth
    });

    it('carries exactly the format check and the unique constraint under the same names, and nothing else about key', async () => {
      const cons = await sql<{ conname: string; def: string }>(
        db.url,
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'platform'::regclass AND (conname LIKE 'platform_key%') ORDER BY conname`,
      );
      expect(cons).toEqual([
        { conname: 'platform_key_format', def: KEY_FORMAT_DEF },
        { conname: 'platform_key_uk', def: 'UNIQUE (key)' },
      ]);
      // no foreign key from or to key, and the only index on the column is the unique constraint's own
      expect(await sql(db.url, `SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid = 'platform'::regclass AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'platform'::regclass AND attname = 'key')]`)).toHaveLength(0);
      const idx = await sql<{ indexname: string }>(db.url, `SELECT indexname FROM pg_indexes WHERE tablename = 'platform' AND indexdef ILIKE '%(key)%'`);
      expect(idx.map((i) => i.indexname)).toEqual(['platform_key_uk']);
    });

    it('is NOT immutable: no trigger freezes it (Auth freezes only companyId)', async () => {
      const [frozen] = await sql<{ args: string }>(db.url, `SELECT pg_get_triggerdef(oid) AS args FROM pg_trigger WHERE tgrelid = 'platform'::regclass AND tgname = 'platform_immutable'`);
      expect(frozen!.args).toContain(`forbid_column_change('id', 'createdAt', 'companyId')`);
      expect(frozen!.args).not.toContain('key');
    });
  });

  describe('format: ^[a-z][a-z0-9-]{1,39}$ (exactly Auth\'s, nothing stricter)', () => {
    it.each([
      ['ab', 'the shortest (2 characters)'], ['a1', 'a digit after the first letter'], ['nawara-drive', 'the documented example'],
      ['a' + 'b'.repeat(39), 'the longest (40 characters)'], ['ab-', 'a trailing hyphen (Auth permits it)'], ['a--b', 'consecutive hyphens (Auth permits them)'],
      ['a-1-2', 'digits between hyphens'],
    ])('accepts %s (%s)', async (key) => {
      expect(await insert(key)).toHaveLength(1);
    });

    it.each([
      ['a', 'too short (1 character)'], ['', 'empty'], ['a' + 'b'.repeat(40), 'too long (41 characters)'], ['Ab', 'an upper-case letter'], ['aB', 'an upper-case letter later'],
      ['1ab', 'a leading digit'], ['-ab', 'a leading hyphen'], ['a_b', 'an underscore'], ['a b', 'a space'], ['a.b', 'a dot'], ['aé', 'a non-ASCII letter'],
      ['ab\n', 'a trailing newline'], [' ab', 'a leading space'], ['a/b', 'a slash'],
    ])('rejects %j (%s) with platform_key_format', async (key) => {
      expect(await failsWith(db.url, `INSERT INTO platform ("companyId", name, key) VALUES ($1, 'P', $2)`, [CO, key])).toEqual({ code: '23514', constraint: 'platform_key_format' });
    });
  });

  describe('uniqueness', () => {
    it('two platforms cannot share a non-null key (23505 platform_key_uk), even under different companies', async () => {
      await insert('dup-key');
      const other = 'c2000000-0000-4000-8000-000000000002';
      await sql(db.url, `INSERT INTO company (id, name) VALUES ($1, 'Other')`, [other]);
      expect(await failsWith(db.url, `INSERT INTO platform ("companyId", name, key) VALUES ($1, 'P', 'dup-key')`, [other])).toEqual({ code: '23505', constraint: 'platform_key_uk' });
    });

    it('NULL is not a value: any number of platforms may have no key (NULLS DISTINCT, as in Auth)', async () => {
      for (let i = 0; i < 5; i++) await insert(null);
      const [{ n: withoutKey }] = await sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM platform WHERE key IS NULL`);
      expect(withoutKey).toBeGreaterThanOrEqual(5);
    });

    it('comparison is exact: keys differing only by case cannot exist because upper case is refused, so uniqueness needs no case folding', async () => {
      await insert('case-test');
      expect((await failsWith(db.url, `INSERT INTO platform ("companyId", name, key) VALUES ($1, 'P', 'CASE-TEST')`, [CO])).constraint).toBe('platform_key_format');
    });
  });

  describe('persistence and editing (Auth puts no restriction on changing it)', () => {
    it('a value can be set, changed, cleared and re-set by the schema owner path, with the constraints still applying', async () => {
      const [{ id }] = await insert('first-key');
      await sql(db.url, `UPDATE platform SET key = 'second-key' WHERE id = $1`, [id]);
      expect((await sql(db.url, `SELECT key FROM platform WHERE id = $1`, [id]))[0].key).toBe('second-key');
      await sql(db.url, `UPDATE platform SET key = NULL WHERE id = $1`, [id]);
      expect((await sql(db.url, `SELECT key FROM platform WHERE id = $1`, [id]))[0].key).toBeNull();
      await sql(db.url, `UPDATE platform SET key = 'third-key' WHERE id = $1`, [id]);
      expect((await failsWith(db.url, `UPDATE platform SET key = 'Bad' WHERE id = $1`, [id])).constraint).toBe('platform_key_format');
      await insert('taken-key');
      expect((await failsWith(db.url, `UPDATE platform SET key = 'taken-key' WHERE id = $1`, [id])).constraint).toBe('platform_key_uk');
    });

    it('is returned by the API on get and list (null when absent, the stored value otherwise), and survives a name change', async () => {
      const c = client(t);
      const [{ id }] = await insert('served-key');
      const got = (await c.get(`/organization/platforms/${id}`)).body;
      expect(got).toMatchObject({ id, companyId: CO, key: 'served-key' });
      const renamed = await c.patch(`/organization/platforms/${id}`, { name: 'Renamed' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.key).toBe('served-key');
      const listed = (await c.get(`/organization/platforms?companyId=${CO}&limit=100`)).body.items.find((p: { id: string }) => p.id === id);
      expect(listed.key).toBe('served-key');
      const made = await c.platform(CO, 'Keyless');
      expect(made.key).toBeNull();
    });

    it('cannot be set or changed through the API (Auth exposes it in reads only and has no writer): create and update refuse it, nothing changes', async () => {
      const c = client(t);
      const created = await c.post('/organization/platforms', { companyId: CO, name: 'With key', key: 'sneaky-key' });
      expect(created.status).toBe(400);
      expect(created.body.code).toBe('invalid_platform_request');
      expect(await sql(db.url, `SELECT 1 FROM platform WHERE name = 'With key'`)).toHaveLength(0);
      const [{ id }] = await insert('stays-put');
      for (const body of [{ key: 'changed-key' }, { name: 'ok', key: 'changed-key' }, { key: null }]) {
        expect((await c.patch(`/organization/platforms/${id}`, body)).status, JSON.stringify(body)).toBe(400);
      }
      expect((await sql(db.url, `SELECT key FROM platform WHERE id = $1`, [id]))[0].key).toBe('stays-put');
    });

    it('a platform row with an Auth-compatible key, an explicit id and original timestamps exists unchanged, with its organizations', async () => {
      const id = 'a2ffffff-0000-4000-8000-000000000001';
      await sql(db.url, `INSERT INTO platform (id, "companyId", name, key, "createdAt", "updatedAt") VALUES ($1, $2, 'Imported Pl', 'imported-slug', '2022-03-04 05:06:07.123456+00', '2023-04-05 06:07:08.654321+00')`, [id, CO]);
      await sql(db.url, `INSERT INTO organization (id, "platformId", name) VALUES ('b2ffffff-0000-4000-8000-000000000001', $1, 'Org')`, [id]);
      const [row] = await sql(db.url, `SELECT id, key, to_char("createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS c, to_char("updatedAt" AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS u FROM platform WHERE id = $1`, [id]);
      expect(row).toEqual({ id, key: 'imported-slug', c: '2022-03-04 05:06:07.123456', u: '2023-04-05 06:07:08.654321' });
      expect((await client(t).get(`/organization/organizations?platformId=${id}`)).body.items).toHaveLength(1);
    });
  });

  describe('upgrading a database that is already at the previous schema (0001 + 0002) with rows in it', () => {
    it('applies 0003 (and the later inert 0004), keeps every row and id, sets no key, generates nothing, and the key rules then apply', async () => {
      const own = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgkeyup');
      const old = mkdtempSync(join(tmpdir(), 'org-mig-'));
      for (const f of readdirSync(organizationMigrationsDir).filter((f) => /^000[12]_/.test(f))) copyFileSync(join(organizationMigrationsDir, f), join(old, f));
      try {
        const before = await runMigrations(own.url, [kitMigrationsDir, old]);
        expect(before.applied.filter((f) => f.startsWith('0'))).toEqual(['0001_company_platform_organization.sql', '0002_idempotency_key.sql']);
        const co = 'c3000000-0000-4000-8000-000000000001';
        const rows = ['a3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002'];
        await sql(own.url, `INSERT INTO company (id, name) VALUES ($1, 'Old Co')`, [co]);
        for (const [i, id] of rows.entries()) await sql(own.url, `INSERT INTO platform (id, "companyId", name, "createdAt") VALUES ($1, $2, $3, '2021-01-01T00:00:00.000001Z')`, [id, co, `Old ${i}`]);
        expect((await sql(own.url, `SELECT 1 FROM information_schema.columns WHERE table_name='platform' AND column_name='key'`))).toHaveLength(0);

        const after = await runMigrations(own.url, [kitMigrationsDir, organizationMigrationsDir]); // the real directory: 0001/0002 unchanged checksums
        expect(after.applied).toEqual(['0003_platform_key.sql', '0004_ownership_transition.sql', '0005_admin_actor_record.sql']);
        const kept = await sql(own.url, `SELECT id, name, key, to_char("createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS c FROM platform ORDER BY name`);
        expect(kept).toEqual([
          { id: rows[0], name: 'Old 0', key: null, c: '2021-01-01 00:00:00.000001' },
          { id: rows[1], name: 'Old 1', key: null, c: '2021-01-01 00:00:00.000001' },
        ]);
        await sql(own.url, `UPDATE platform SET key = 'now-keyed' WHERE id = $1`, [rows[0]]);
        expect((await failsWith(own.url, `UPDATE platform SET key = 'Not Valid' WHERE id = $1`, [rows[1]])).constraint).toBe('platform_key_format');
        expect((await runMigrations(own.url, [kitMigrationsDir, organizationMigrationsDir])).applied).toEqual([]); // deterministic and idempotent
      } finally {
        await own.drop();
      }
    });
  });

  it('an unknown company id is still refused with the key column present (hierarchy unchanged)', async () => {
    expect((await failsWith(db.url, `INSERT INTO platform ("companyId", name, key) VALUES ($1, 'x', 'orphan-key')`, [MISSING_ID])).constraint).toBe('platform_company_fk');
  });
});
