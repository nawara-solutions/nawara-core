import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MigrationError, kitMigrationsDir, listMigrationFiles, pendingMigrations, runMigrations } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

const dirWith = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  for (const [n, sql] of Object.entries(files)) writeFileSync(join(dir, n), sql);
  return dir;
};
const names = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const { rows } = await c.query('SELECT name FROM schema_migrations ORDER BY name');
  await c.end();
  return rows.map((r) => r.name);
};
const tableExists = async (url: string, table: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const { rows } = await c.query(`SELECT to_regclass('public.${table}') IS NOT NULL AS present`);
  await c.end();
  return rows[0].present as boolean;
};

describeWithEnv('migration runner (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'mig');
  });
  afterAll(() => db.drop());

  it('applies the kit migrations, and a second run is a no-op', async () => {
    const first = await runMigrations(db.url, [kitMigrationsDir]);
    expect(first.applied).toEqual(['kit_0001_outbox_inbox.sql', 'kit_0002_rate_limit.sql']);
    expect(await tableExists(db.url, 'outbox')).toBe(true);
    expect(await tableExists(db.url, 'inbox')).toBe(true);
    expect(await tableExists(db.url, 'kit_rate_limit')).toBe(true);
    const second = await runMigrations(db.url, [kitMigrationsDir]);
    expect(second).toEqual({ applied: [], alreadyApplied: ['kit_0001_outbox_inbox.sql', 'kit_0002_rate_limit.sql'] });
  });

  it('orders files deterministically: directories in the order given, files by name', () => {
    const a = dirWith({ '0002_b.sql': 'SELECT 1', '0001_a.sql': 'SELECT 1' });
    const b = dirWith({ '0003_c.sql': 'SELECT 1' });
    expect(listMigrationFiles([a, b]).map((f) => f.name)).toEqual(['0001_a.sql', '0002_b.sql', '0003_c.sql']);
    expect(listMigrationFiles([b, a]).map((f) => f.name)).toEqual(['0003_c.sql', '0001_a.sql', '0002_b.sql']);
  });

  it('ignores a down/ folder and non-sql files, and refuses duplicate names across directories', () => {
    const a = dirWith({ '0001_a.sql': 'SELECT 1', 'notes.txt': 'x' });
    mkdirSync(join(a, 'down'));
    writeFileSync(join(a, 'down', '0001_a.down.sql'), 'SELECT 1');
    expect(listMigrationFiles([a]).map((f) => f.name)).toEqual(['0001_a.sql']);
    expect(() => listMigrationFiles([a, dirWith({ '0001_a.sql': 'SELECT 2' })])).toThrow(MigrationError);
  });

  it('refuses a file that manages its own transaction', () => {
    expect(() => listMigrationFiles([dirWith({ '0001_x.sql': 'BEGIN;\nCREATE TABLE x(id int);\nCOMMIT;' })])).toThrow('must not contain BEGIN/COMMIT');
  });

  it('does not mistake the BEGIN of a function body or a comment for its own transaction', () => {
    const sql = "-- BEGIN;\nCREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN 1;\nEND $$;";
    expect(listMigrationFiles([dirWith({ '0001_f.sql': sql })])).toHaveLength(1);
    expect(() => listMigrationFiles([dirWith({ '0001_x.sql': 'CREATE TABLE x(id int);\nCOMMIT;' })])).toThrow('must not contain BEGIN/COMMIT');
  });

  it('rolls a failing migration back completely and does not record it', async () => {
    const dir = dirWith({ '0001_bad.sql': 'CREATE TABLE half_done(id int); SELECT * FROM does_not_exist;' });
    await expect(runMigrations(db.url, [dir])).rejects.toThrow('0001_bad.sql failed and was rolled back');
    expect(await tableExists(db.url, 'half_done')).toBe(false);
    expect(await names(db.url)).not.toContain('0001_bad.sql');
  });

  it('refuses an applied migration whose contents later changed', async () => {
    const dir = dirWith({ '0001_t.sql': 'CREATE TABLE drift_t(id int)' });
    await runMigrations(db.url, [dir]);
    writeFileSync(join(dir, '0001_t.sql'), 'CREATE TABLE drift_t(id int, extra int)');
    await expect(runMigrations(db.url, [dir])).rejects.toThrow('was modified after it was applied');
  });

  it('two runners at once apply each migration exactly once (advisory lock)', async () => {
    const fresh = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'mig_conc');
    try {
      const dir = dirWith({ '0001_a.sql': 'CREATE TABLE conc_a(id int)', '0002_b.sql': 'CREATE TABLE conc_b(id int)' });
      const results = await Promise.all(Array.from({ length: 4 }, () => runMigrations(fresh.url, [dir])));
      expect(results.flatMap((r) => r.applied).sort()).toEqual(['0001_a.sql', '0002_b.sql']);
    } finally {
      await fresh.drop();
    }
  });

  it('reports pending migrations read-only, before and after applying', async () => {
    const fresh = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'mig_pend');
    const c = new pg.Client({ connectionString: fresh.url });
    await c.connect();
    try {
      const dir = dirWith({ '0001_a.sql': 'SELECT 1', '0002_b.sql': 'SELECT 1' });
      expect(await pendingMigrations(c, [dir])).toEqual(['0001_a.sql', '0002_b.sql']);
      await runMigrations(fresh.url, [dir]);
      expect(await pendingMigrations(c, [dir])).toEqual([]);
    } finally {
      await c.end();
      await fresh.drop();
    }
  });
});
