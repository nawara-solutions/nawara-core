import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { Queryable } from './db.service.js';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationFile {
  name: string;
  dir: string;
  checksum: string;
  sql: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/;
// A transaction-control STATEMENT (`BEGIN;`, `COMMIT;`...). Function bodies ($$ ... $$) and comments are stripped first, so the
// BEGIN of a plpgsql block is not mistaken for one.
const OWN_TRANSACTION = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*(;|$)/im;
function withoutBodiesAndComments(sql: string): string {
  return sql.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
const LOCK_KEY = 747_501; // advisory lock so two runners never migrate the same database at once
export const MIGRATIONS_TABLE = 'schema_migrations';

/**
 * Lists migration files deterministically: directories in the order given, files inside a directory by name.
 * Only `*.sql` files directly inside a directory count (a `down/` folder is ignored). A file name may not appear twice.
 * Files must NOT contain their own BEGIN/COMMIT: the runner wraps each file and its bookkeeping row in one transaction.
 */
export function listMigrationFiles(dirs: string[]): MigrationFile[] {
  const out: MigrationFile[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const names = readdirSync(dir).filter((n) => n.endsWith('.sql') && statSync(join(dir, n)).isFile()).sort();
    for (const name of names) {
      if (!NAME.test(name)) throw new MigrationError(`invalid migration file name: ${name}`);
      if (seen.has(name)) throw new MigrationError(`duplicate migration file name: ${name}`);
      seen.add(name);
      const sql = readFileSync(join(dir, name), 'utf8');
      if (OWN_TRANSACTION.test(withoutBodiesAndComments(sql))) throw new MigrationError(`${name} must not contain BEGIN/COMMIT (the runner wraps it in a transaction)`);
      out.push({ name, dir, sql, checksum: createHash('sha256').update(sql).digest('hex') });
    }
  }
  return out;
}

/** Names of migration files not yet recorded as applied. Read-only; a missing bookkeeping table means all are pending. */
export async function pendingMigrations(q: Queryable, dirs: string[]): Promise<string[]> {
  const files = listMigrationFiles(dirs);
  const { rows: t } = await q.query(`SELECT to_regclass('${MIGRATIONS_TABLE}') IS NOT NULL AS present`);
  if (!t[0].present) return files.map((f) => f.name);
  const { rows } = await q.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`);
  const applied = new Set(rows.map((r) => r.name));
  return files.filter((f) => !applied.has(f.name)).map((f) => f.name);
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies pending migrations, explicitly (never as a side effect of starting a service). Safe to run twice and from two
 * places at once (advisory lock). An already-applied file whose contents changed is refused: a migration is immutable
 * once it may have run anywhere. Each file runs in its own transaction together with its bookkeeping row.
 */
export async function runMigrations(connectionString: string, dirs: string[]): Promise<MigrationResult> {
  const files = listMigrationFiles(dirs);
  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`ALTER TABLE ${MIGRATIONS_TABLE} ADD COLUMN IF NOT EXISTS checksum text`);
    const { rows } = await client.query<{ name: string; checksum: string | null }>(`SELECT name, checksum FROM ${MIGRATIONS_TABLE}`);
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const f of files) {
      if (applied.has(f.name)) {
        const recorded = applied.get(f.name);
        if (recorded && recorded !== f.checksum) throw new MigrationError(`${f.name} was modified after it was applied`);
        result.alreadyApplied.push(f.name);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(f.sql);
        await client.query(`INSERT INTO ${MIGRATIONS_TABLE}(name, checksum) VALUES ($1, $2)`, [f.name, f.checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new MigrationError(`${f.name} failed and was rolled back: ${(e as Error).message}`);
      }
      result.applied.push(f.name);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
