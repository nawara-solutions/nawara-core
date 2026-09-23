import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MigrationError, listMigrationFiles, runMigrations, type MigrationOptions } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 14.5: the runner's opt-in behaviour for a service whose files carry their own `BEGIN; ... COMMIT;` (auth-service), plus the
 * history checks every caller now gets before anything changes. Real PostgreSQL throughout.
 */
const AUTH_STYLE: MigrationOptions = { fileTransaction: 'strip', strictHistory: true, adoptLegacyChecksums: true };
const dirWith = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'migs-'));
  for (const [n, sql] of Object.entries(files)) writeFileSync(join(dir, n), sql);
  return dir;
};
const wrapped = (body: string, comment = '-- a migration') => `${comment}\n\nBEGIN;\n${body}\nCOMMIT;\n`;

describeWithEnv('migration runner: self-wrapped files, strict history, legacy checksums (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const dbs: TestDatabase[] = [];
  const fresh = async () => {
    const d = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'migs');
    dbs.push(d);
    return d;
  };
  const q = async (url: string, sql: string) => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return (await c.query(sql)).rows;
    } finally {
      await c.end();
    }
  };
  const history = async (url: string) => (await q(url, 'SELECT name, checksum FROM schema_migrations ORDER BY name')) as { name: string; checksum: string | null }[];
  const has = async (url: string, table: string) => (await q(url, `SELECT to_regclass('public.${table}') IS NOT NULL AS p`))[0].p as boolean;

  beforeAll(() => undefined);
  afterAll(async () => {
    for (const d of dbs) await d.drop();
  });

  it('strip: runs a self-wrapped file inside the runner transaction and records its checksum (over the file as on disk)', async () => {
    const d = await fresh();
    const dir = dirWith({ '0001_a.sql': wrapped('CREATE TABLE s_a(id int);\nCREATE FUNCTION s_f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;') });
    const r = await runMigrations(d.url, [dir], AUTH_STYLE);
    expect(r.applied).toEqual(['0001_a.sql']);
    expect(await has(d.url, 's_a')).toBe(true);
    const [row] = await history(d.url);
    expect(row!.checksum).toBe(listMigrationFiles([dir], AUTH_STYLE)[0]!.checksum);
    expect((await runMigrations(d.url, [dir], AUTH_STYLE)).applied).toEqual([]); // idempotent
  });

  it.each([
    ['no wrapper', 'CREATE TABLE x(id int);'],
    ['a second transaction', 'BEGIN;\nCREATE TABLE x(id int);\nCOMMIT;\nBEGIN;\nSELECT 1;\nCOMMIT;\n'],
    ['a ROLLBACK', 'BEGIN;\nCREATE TABLE x(id int);\nROLLBACK;\n'],
    ['a statement after the COMMIT', 'BEGIN;\nCREATE TABLE x(id int);\nCOMMIT;\nCREATE TABLE y(id int);\n'],
  ])('strip: refuses a file with %s, before touching the database', async (_what, sql) => {
    const d = await fresh();
    const dir = dirWith({ '0001_x.sql': sql });
    await expect(runMigrations(d.url, [dir], AUTH_STYLE)).rejects.toThrow(MigrationError);
    expect(await has(d.url, 'x')).toBe(false);
  });

  it('atomicity: a failing self-wrapped migration leaves neither its changes nor a history row; earlier ones stay applied', async () => {
    const d = await fresh();
    const dir = dirWith({
      '0001_ok.sql': wrapped('CREATE TABLE a_ok(id int);'),
      '0002_bad.sql': wrapped('CREATE TABLE a_half(id int);\nINSERT INTO a_half VALUES (1);\nSELECT 1/0;'),
    });
    await expect(runMigrations(d.url, [dir], AUTH_STYLE)).rejects.toThrow(/0002_bad.sql failed and was rolled back/);
    expect(await has(d.url, 'a_ok')).toBe(true);
    expect(await has(d.url, 'a_half')).toBe(false);
    expect((await history(d.url)).map((r) => r.name)).toEqual(['0001_ok.sql']);
  });

  it('checksum mismatch: a modified applied migration is refused BEFORE a pending one is applied', async () => {
    const d = await fresh();
    const dir = dirWith({ '0001_a.sql': wrapped('CREATE TABLE m_a(id int);') });
    await runMigrations(d.url, [dir], AUTH_STYLE);
    writeFileSync(join(dir, '0001_a.sql'), wrapped('CREATE TABLE m_a(id int, extra int);'));
    writeFileSync(join(dir, '0002_b.sql'), wrapped('CREATE TABLE m_b(id int);'));
    await expect(runMigrations(d.url, [dir], AUTH_STYLE)).rejects.toThrow(/0001_a.sql was modified after it was applied/);
    expect(await has(d.url, 'm_b')).toBe(false); // nothing pending ran
    const [row] = await history(d.url);
    expect(row!.checksum).not.toBe(listMigrationFiles([dir], AUTH_STYLE)[0]!.checksum); // the stored checksum was NOT rewritten
  });

  it('strict history: an applied migration this release does not contain (a newer release) is refused, changing nothing', async () => {
    const d = await fresh();
    const newer = dirWith({ '0001_a.sql': wrapped('CREATE TABLE u_a(id int);'), '0002_b.sql': wrapped('CREATE TABLE u_b(id int);') });
    await runMigrations(d.url, [newer], AUTH_STYLE);
    const older = dirWith({ '0001_a.sql': wrapped('CREATE TABLE u_a(id int);'), '0003_c.sql': wrapped('CREATE TABLE u_c(id int);') });
    await expect(runMigrations(d.url, [older], AUTH_STYLE)).rejects.toThrow(/records migrations this release does not contain \(0002_b.sql\)/);
    expect(await has(d.url, 'u_c')).toBe(false);
  });

  it('strict history: a pending migration that sorts before an applied one is refused, changing nothing', async () => {
    const d = await fresh();
    const dir = dirWith({ '0001_a.sql': wrapped('CREATE TABLE o_a(id int);'), '0003_c.sql': wrapped('CREATE TABLE o_c(id int);') });
    await runMigrations(d.url, [dir], AUTH_STYLE);
    writeFileSync(join(dir, '0002_b.sql'), wrapped('CREATE TABLE o_b(id int);'));
    await expect(runMigrations(d.url, [dir], AUTH_STYLE)).rejects.toThrow(/sort before already-applied ones \(0002_b.sql\)/);
    expect(await has(d.url, 'o_b')).toBe(false);
  });

  it('duplicate identity across directories is refused before connecting', async () => {
    const d = await fresh();
    const a = dirWith({ '0001_a.sql': wrapped('CREATE TABLE d_a(id int);') });
    const b = dirWith({ '0001_a.sql': wrapped('CREATE TABLE d_b(id int);') });
    await expect(runMigrations(d.url, [a, b], AUTH_STYLE)).rejects.toThrow(/duplicate migration file name: 0001_a.sql/);
    expect(await has(d.url, 'd_a')).toBe(false);
  });

  it('legacy rows without a checksum: recorded once when adopting, then enforced; never recorded without the option', async () => {
    const d = await fresh();
    const dir = dirWith({ '0001_a.sql': wrapped('CREATE TABLE l_a(id int);') });
    // The previous bookkeeping shape: (name, applied_at), no checksum, the file applied outside the runner.
    await q(d.url, `CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()); CREATE TABLE l_a(id int);
                    INSERT INTO schema_migrations(name) VALUES ('0001_a.sql')`);
    const plain = await runMigrations(d.url, [dir], { fileTransaction: 'strip' });
    expect(plain.adopted).toEqual([]);
    expect((await history(d.url))[0]!.checksum).toBeNull();
    const adopting = await runMigrations(d.url, [dir], AUTH_STYLE);
    expect(adopting).toMatchObject({ applied: [], alreadyApplied: ['0001_a.sql'], adopted: ['0001_a.sql'] });
    expect((await history(d.url))[0]!.checksum).toBe(listMigrationFiles([dir], AUTH_STYLE)[0]!.checksum);
    expect((await runMigrations(d.url, [dir], AUTH_STYLE)).adopted).toEqual([]); // once
    writeFileSync(join(dir, '0001_a.sql'), wrapped('CREATE TABLE l_a(id int, changed int);'));
    await expect(runMigrations(d.url, [dir], AUTH_STYLE)).rejects.toThrow(/modified after it was applied/);
  });

  it('concurrent runners with self-wrapped files apply each migration once and all resolve', async () => {
    const d = await fresh();
    const dir = dirWith({ '0001_a.sql': wrapped('CREATE TABLE c_a(id int);'), '0002_b.sql': wrapped('CREATE TABLE c_b(id int);\nSELECT pg_sleep(0.3);') });
    const results = await Promise.all(Array.from({ length: 4 }, () => runMigrations(d.url, [dir], AUTH_STYLE)));
    expect(results.flatMap((r) => r.applied).sort()).toEqual(['0001_a.sql', '0002_b.sql']);
    expect((await history(d.url)).map((r) => r.name)).toEqual(['0001_a.sql', '0002_b.sql']);
  });
});
