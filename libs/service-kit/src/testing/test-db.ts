import { randomBytes } from 'node:crypto';
import pg from 'pg';

export interface DropOptions {
  /**
   * How long to wait for sessions that are closing on their own (default 2000 ms). `pg.Pool#end()` resolves once its clients are
   * removed, before their sockets have closed, so a drop right after it would otherwise terminate sessions that were about to go.
   */
  closingTimeoutMs?: number;
}

export interface DropReport {
  /** Sessions still connected after the wait, terminated before the drop: a leak in the caller, never a closing pool. */
  terminated: number;
  /** Their `pg_stat_activity.state` (idle, idle in transaction, active, ...): which kind of leak it was. */
  leaked: Record<string, number>;
  /** How long the drop waited for closing sessions. */
  waitedMs: number;
}

export interface TestDatabase {
  /** Connection string of the throwaway database. */
  url: string;
  /** Drops the database: waits (bounded) for closing sessions to go, terminates any still connected (reported), then drops. */
  drop(options?: DropOptions): Promise<DropReport>;
}

const POLL_MS = 25;

/** Creates an isolated, uniquely named database for one test file, on the server at `adminUrl`. Test use only. */
export async function createTestDatabase(adminUrl: string, prefix = 'kit_test'): Promise<TestDatabase> {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(prefix)) throw new Error('test database prefix must be lowercase letters, digits and underscores');
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    async drop(options: DropOptions = {}): Promise<DropReport> {
      const closingTimeoutMs = options.closingTimeoutMs ?? 2000;
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      try {
        const sessions = async () =>
          (await a.query<{ state: string | null }>('SELECT state FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name])).rows;
        // R11: observe the database, not the clock. Sessions whose client is closing disappear on their own; wait for that, bounded.
        const started = Date.now();
        let remaining = await sessions();
        while (remaining.length > 0 && Date.now() - started < closingTimeoutMs) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          remaining = await sessions();
        }
        const waitedMs = Date.now() - started;
        const leaked: Record<string, number> = {};
        for (const s of remaining) leaked[s.state ?? 'unknown'] = (leaked[s.state ?? 'unknown'] ?? 0) + 1;
        let terminated = 0;
        if (remaining.length > 0) {
          // Still connected after the bound: a session the caller never closed. Terminated so the drop cannot hang (the cleanup
          // guarantee), and reported on stderr by state (never a connection string) so the leak stays visible.
          const r = await a.query<{ ok: boolean }>('SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
          terminated = r.rows.filter((row) => row.ok).length;
          process.stderr.write(`test_database_leaked_connections database=${name} terminated=${terminated} states=${Object.entries(leaked).map(([k, v]) => `${k.replace(/ /g, '_')}:${v}`).join(',')} waitedMs=${waitedMs}\n`);
        }
        await a.query(`DROP DATABASE IF EXISTS "${name}"`);
        return { terminated, leaked, waitedMs };
      } finally {
        await a.end();
      }
    },
  };
}
