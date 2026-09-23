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
  /** sha256 of the file's EXACT bytes on disk: what is stored when applied and compared on every later run. */
  checksum: string;
  /** The SQL the runner executes inside its own transaction (the file itself, or its body under `fileTransaction: 'strip'`). */
  sql: string;
}

/**
 * Behaviour switches for a service whose migration files predate this runner (auth-service). The defaults are exactly the
 * runner's original behaviour, so every other caller is unchanged.
 */
export interface MigrationOptions {
  /**
   * `'forbid'` (default): a file may not contain its own BEGIN/COMMIT. `'strip'`: EVERY file must be exactly one
   * `BEGIN; ... COMMIT;` wrapper (comments allowed around it, no other transaction control anywhere); the runner executes the
   * body inside its OWN transaction together with the bookkeeping row, so the file's effect and its record commit or roll back
   * together. The checksum is always taken over the file as it is on disk.
   */
  fileTransaction?: 'forbid' | 'strip';
  /**
   * Refuse, before changing anything, a history the files cannot explain: an applied migration no file names (the database was
   * migrated by a newer or a foreign release), or a pending file that sorts BEFORE an applied one (a migration inserted into
   * the past). Default false.
   */
  strictHistory?: boolean;
  /**
   * An applied row with NO checksum (recorded before checksums were kept) is, by default, accepted unverified. With this set,
   * the file's current checksum is recorded for it ONCE, reported in `adopted`, and enforced on every later run.
   */
  adoptLegacyChecksums?: boolean;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/;
// A transaction-control STATEMENT (`BEGIN;`, `COMMIT;`...). Function bodies ($$ ... $$) and comments are stripped first, so the
// BEGIN of a plpgsql block is not mistaken for one.
const OWN_TRANSACTION = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*(;|$)/im;
const OWN_TRANSACTION_ALL = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b[^;\n]*(;|$)/gim;
function withoutBodiesAndComments(sql: string): string {
  return sql.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
const LOCK_KEY = 747_501; // advisory lock so two runners never migrate the same database at once
export const MIGRATIONS_TABLE = 'schema_migrations';

const isBlankOrComment = (line: string) => /^\s*(--.*)?$/.test(line);

/**
 * `fileTransaction: 'strip'`: returns the body between a file's single leading `BEGIN;` and single trailing `COMMIT;`, or throws.
 * Anything else (no wrapper, a second transaction statement, a ROLLBACK, statements outside the wrapper, block comments around
 * it) is refused rather than guessed at.
 */
function unwrapFileTransaction(name: string, sql: string): string {
  const statements = withoutBodiesAndComments(sql).match(OWN_TRANSACTION_ALL)?.map((s) => s.trim().split(/\s+/)[0]!.replace(';', '').toUpperCase()) ?? [];
  const lines = sql.split('\n');
  const begin = lines.findIndex((l) => !isBlankOrComment(l));
  let commit = lines.length - 1;
  while (commit >= 0 && isBlankOrComment(lines[commit]!)) commit--;
  const ok =
    statements.length === 2 &&
    statements[0] === 'BEGIN' &&
    statements[1] === 'COMMIT' &&
    begin >= 0 &&
    commit > begin &&
    /^\s*BEGIN\s*;\s*$/i.test(lines[begin]!) &&
    /^\s*COMMIT\s*;\s*$/i.test(lines[commit]!);
  if (!ok) throw new MigrationError(`${name} must be exactly one "BEGIN; ... COMMIT;" transaction (comments may surround it)`);
  return lines.slice(begin + 1, commit).join('\n');
}

/**
 * Lists migration files deterministically: directories in the order given, files inside a directory by name.
 * Only `*.sql` files directly inside a directory count (a `down/` folder is ignored). A file name may not appear twice.
 * By default files must NOT contain their own BEGIN/COMMIT: the runner wraps each file and its bookkeeping row in one
 * transaction (see `MigrationOptions.fileTransaction` for files written with their own wrapper).
 */
export function listMigrationFiles(dirs: string[], opts: MigrationOptions = {}): MigrationFile[] {
  const out: MigrationFile[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const names = readdirSync(dir).filter((n) => n.endsWith('.sql') && statSync(join(dir, n)).isFile()).sort();
    for (const name of names) {
      if (!NAME.test(name)) throw new MigrationError(`invalid migration file name: ${name}`);
      if (seen.has(name)) throw new MigrationError(`duplicate migration file name: ${name}`);
      seen.add(name);
      const content = readFileSync(join(dir, name), 'utf8');
      let sql = content;
      if (opts.fileTransaction === 'strip') sql = unwrapFileTransaction(name, content);
      else if (OWN_TRANSACTION.test(withoutBodiesAndComments(content))) throw new MigrationError(`${name} must not contain BEGIN/COMMIT (the runner wraps it in a transaction)`);
      out.push({ name, dir, sql, checksum: createHash('sha256').update(content).digest('hex') });
    }
  }
  return out;
}

/** Names of migration files not yet recorded as applied. Read-only; a missing bookkeeping table means all are pending. */
export async function pendingMigrations(q: Queryable, dirs: string[], opts: MigrationOptions = {}): Promise<string[]> {
  return pendingOf(q, listMigrationFiles(dirs, opts).map((f) => f.name));
}

/** Read-only: which of `names` the bookkeeping table does not record. A service can list its files once and ask this cheaply. */
export async function pendingOf(q: Queryable, names: string[]): Promise<string[]> {
  const { rows: t } = await q.query(`SELECT to_regclass('${MIGRATIONS_TABLE}') IS NOT NULL AS present`);
  if (!t[0].present) return [...names];
  const { rows } = await q.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`);
  const applied = new Set(rows.map((r) => r.name));
  return names.filter((n) => !applied.has(n));
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  /** Rows recorded before checksums were kept, whose checksum was recorded now (`adoptLegacyChecksums`). */
  adopted: string[];
}

/**
 * Applies pending migrations, explicitly (never as a side effect of starting a service). Safe to run twice and from two
 * places at once: a session-level advisory lock is held for the WHOLE run (validation, execution and bookkeeping) and is
 * released by PostgreSQL itself if the runner's connection dies. The recorded history is validated before anything changes:
 * an already-applied file whose contents changed is refused (a migration is immutable once it may have run anywhere). Each
 * file runs in its own transaction together with its bookkeeping row, so a failure leaves neither the change nor the record.
 */
export async function runMigrations(connectionString: string, dirs: string[], opts: MigrationOptions = {}): Promise<MigrationResult> {
  const files = listMigrationFiles(dirs, opts);
  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [], adopted: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`ALTER TABLE ${MIGRATIONS_TABLE} ADD COLUMN IF NOT EXISTS checksum text`);
    const { rows } = await client.query<{ name: string; checksum: string | null }>(`SELECT name, checksum FROM ${MIGRATIONS_TABLE}`);
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    // 1. Validate the whole recorded history first: nothing is changed unless every check passes.
    const known = new Set(files.map((f) => f.name));
    if (opts.strictHistory) {
      const unknown = [...applied.keys()].filter((n) => !known.has(n)).sort();
      if (unknown.length > 0) {
        throw new MigrationError(`the database records migrations this release does not contain (${unknown.join(', ')}): it was migrated by a newer or a different release; refusing to continue`);
      }
      const lastApplied = files.reduce((last, f, i) => (applied.has(f.name) ? i : last), -1);
      const early = files.slice(0, lastApplied + 1).filter((f) => !applied.has(f.name)).map((f) => f.name);
      if (early.length > 0) {
        throw new MigrationError(`pending migrations sort before already-applied ones (${early.join(', ')}): the history cannot be ordered; refusing to continue`);
      }
    }
    const legacy: typeof files = [];
    for (const f of files) {
      if (!applied.has(f.name)) continue;
      const recorded = applied.get(f.name);
      if (recorded && recorded !== f.checksum) throw new MigrationError(`${f.name} was modified after it was applied`);
      if (!recorded) legacy.push(f);
      result.alreadyApplied.push(f.name);
    }

    // 2. Rows from before checksums were kept: record the checksum once, only when asked to (never overwriting a stored one).
    if (opts.adoptLegacyChecksums) {
      for (const f of legacy) {
        const r = await client.query(`UPDATE ${MIGRATIONS_TABLE} SET checksum = $2 WHERE name = $1 AND checksum IS NULL`, [f.name, f.checksum]);
        if (r.rowCount === 1) result.adopted.push(f.name);
      }
    }

    // 3. Apply what is pending, in order: the file and its record in ONE transaction.
    for (const f of files) {
      if (applied.has(f.name)) continue;
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
