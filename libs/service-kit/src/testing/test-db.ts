import { randomBytes } from 'node:crypto';
import pg from 'pg';

export interface TestDatabase {
  /** Connection string of the throwaway database. */
  url: string;
  /** Drops the database (terminating stray connections). */
  drop(): Promise<void>;
}

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
    async drop() {
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      try {
        await a.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
        await a.query(`DROP DATABASE IF EXISTS "${name}"`);
      } finally {
        await a.end();
      }
    },
  };
}
