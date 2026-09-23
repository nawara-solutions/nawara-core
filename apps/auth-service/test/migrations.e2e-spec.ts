import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it, inject } from 'vitest';
import { listMigrationFiles, runMigrations } from '@nawara/service-kit';
import { AUTH_MIGRATIONS_DIR, AUTH_MIGRATION_OPTIONS } from '../src/db/migrations.js';
import { createTestApp } from './helpers/app.js';

/**
 * Stage 14.5: Auth's REAL migrations through the runner and options production uses, against a real PostgreSQL, including the
 * upgrade of a database migrated by the previous deploy script (bookkeeping `(name, applied_at)`, no checksum, files applied by psql).
 */
describe('auth-service migrations: runner, production upgrade and readiness (real PostgreSQL)', () => {
  const created: string[] = [];
  const adminUrl = () => inject('pgAdminUrl');
  const urlOf = (name: string) => adminUrl().replace(/\/[^/]*$/, `/${name}`);
  const freshDb = async () => {
    const name = `mig_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`CREATE DATABASE ${name}`);
    await a.end();
    created.push(name);
    return urlOf(name);
  };
  const q = async (url: string, sql: string, params: unknown[] = []) => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return (await c.query(sql, params)).rows;
    } finally {
      await c.end();
    }
  };
  // `to_jsonb(row)->>'checksum'` reads NULL when the column does not exist yet (the legacy bookkeeping shape before the runner ran).
  const history = async (url: string) =>
    (await q(url, `SELECT name, to_jsonb(s)->>'checksum' AS checksum FROM schema_migrations s ORDER BY name`)) as { name: string; checksum: string | null }[];
  const files = readdirSync(AUTH_MIGRATIONS_DIR).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
  const checksums = new Map(listMigrationFiles([AUTH_MIGRATIONS_DIR], AUTH_MIGRATION_OPTIONS).map((f) => [f.name, f.checksum]));

  /** Exactly what the pre-14.5 deploy did: its own bookkeeping table, each whole file through psql, then a separate INSERT. */
  const legacyDeploy = async (url: string, upTo: number) => {
    await q(url, 'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const f of files.slice(0, upTo)) {
      await q(url, readFileSync(join(AUTH_MIGRATIONS_DIR, f), 'utf8'));
      await q(url, 'INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    }
  };

  afterAll(async () => {
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    for (const n of created) await a.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
    await a.end();
  });

  it('empty database: applies every Auth migration once, with its checksum, and a rerun changes nothing', async () => {
    const url = await freshDb();
    const r = await runMigrations(url, [AUTH_MIGRATIONS_DIR], AUTH_MIGRATION_OPTIONS);
    expect(r.applied).toEqual(files);
    expect(await history(url)).toEqual(files.map((name) => ({ name, checksum: checksums.get(name) })));
    expect((await q(url, `SELECT to_regclass('public.hierarchy_authority') IS NOT NULL AS p`))[0].p).toBe(true);
    const again = await runMigrations(url, [AUTH_MIGRATIONS_DIR], AUTH_MIGRATION_OPTIONS);
    expect(again).toEqual({ applied: [], alreadyApplied: files, adopted: [] });
  });

  it('production upgrade: a database migrated by the previous deploy script is adopted (checksums recorded once), nothing is re-applied', async () => {
    const url = await freshDb();
    await legacyDeploy(url, files.length);
    expect((await history(url)).every((r) => r.checksum === null)).toBe(true); // the old shape: no checksum column at all
    const r = await runMigrations(url, [AUTH_MIGRATIONS_DIR], AUTH_MIGRATION_OPTIONS);
    expect(r).toEqual({ applied: [], alreadyApplied: files, adopted: files });
    expect(await history(url)).toEqual(files.map((name) => ({ name, checksum: checksums.get(name) })));
    expect((await runMigrations(url, [AUTH_MIGRATIONS_DIR], AUTH_MIGRATION_OPTIONS)).adopted).toEqual([]);
  });

  it('production upgrade of a PARTIALLY migrated legacy database: adopts what was applied, applies the rest atomically', async () => {
    const url = await freshDb();
    await legacyDeploy(url, 7);
    const r = await runMigrations(url, [AUTH_MIGRATIONS_DIR], AUTH_MIGRATION_OPTIONS);
    expect(r.adopted).toEqual(files.slice(0, 7));
    expect(r.applied).toEqual(files.slice(7));
    expect((await history(url)).map((h) => h.checksum)).toEqual(files.map((n) => checksums.get(n)));
  });

  it('readiness: /ready reports "migrations" while this release has unapplied migrations, and is ready once the runner has run', async () => {
    const url = await freshDb();
    await legacyDeploy(url, 7); // enough schema for the app to boot; 0008 and 0009 pending
    const t = await createTestApp({ DATABASE_URL: url });
    try {
      const before = await t.http.get('/ready');
      expect(before.status).toBe(503);
      expect(before.body).toEqual({ status: 'unavailable', failed: ['migrations'] });
      await t.http.get('/health').expect(200, { status: 'ok' });
      expect((await history(url)).length).toBe(7); // readiness observed; it never migrated
      await runMigrations(url, [AUTH_MIGRATIONS_DIR], AUTH_MIGRATION_OPTIONS);
      await t.http.get('/ready').expect(200, { status: 'ready' });
    } finally {
      await t.close();
    }
  });

  it('tamper detection on the real files: a changed, already-applied Auth migration stops the run and nothing is rewritten', async () => {
    const url = await freshDb();
    const copy = mkdtempSync(join(tmpdir(), 'auth-mig-'));
    for (const f of files) cpSync(join(AUTH_MIGRATIONS_DIR, f), join(copy, f));
    await runMigrations(url, [copy], AUTH_MIGRATION_OPTIONS);
    const target = files[2]!;
    writeFileSync(join(copy, target), readFileSync(join(copy, target), 'utf8').replace('COMMIT;', '-- edited after being applied\nCOMMIT;'));
    await expect(runMigrations(url, [copy], AUTH_MIGRATION_OPTIONS)).rejects.toThrow(`${target} was modified after it was applied`);
    expect((await history(url)).find((h) => h.name === target)!.checksum).toBe(checksums.get(target));
  });

  it('concurrent runners on the real Auth migrations: every migration is applied exactly once and every runner resolves', async () => {
    const url = await freshDb();
    const results = await Promise.all(Array.from({ length: 3 }, () => runMigrations(url, [AUTH_MIGRATIONS_DIR], AUTH_MIGRATION_OPTIONS)));
    expect(results.flatMap((r) => r.applied).sort()).toEqual(files);
    expect((await history(url)).map((h) => h.name)).toEqual(files);
  });
});
