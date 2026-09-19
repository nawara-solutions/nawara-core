import { afterAll, beforeAll, expect, it } from 'vitest';
import { isUniqueViolation, kitMigrationsDir, runMigrations } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';
import pg from 'pg';

describeWithEnv('generic triggers: forbid_column_change (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let client: pg.Client;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'generictrig');
    await runMigrations(db.url, [kitMigrationsDir]);
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    await client.query(`CREATE TABLE t_snapshot (id int PRIMARY KEY, frozen text, mutable text)`);
    await client.query(`CREATE TRIGGER t_snapshot_immutable BEFORE UPDATE ON t_snapshot FOR EACH ROW EXECUTE FUNCTION forbid_column_change('frozen')`);
    await client.query(`INSERT INTO t_snapshot VALUES (1, 'original', 'anything')`);
  });
  afterAll(async () => {
    await client.end();
    await db.drop();
  });

  it('allows changing a column not listed as frozen', async () => {
    await client.query(`UPDATE t_snapshot SET mutable = 'changed' WHERE id = 1`);
    const { rows } = await client.query('SELECT mutable FROM t_snapshot WHERE id = 1');
    expect(rows[0].mutable).toBe('changed');
  });

  it('rejects changing a column listed as frozen, with a check-violation error code', async () => {
    await expect(client.query(`UPDATE t_snapshot SET frozen = 'tampered' WHERE id = 1`)).rejects.toSatisfy((e) => isUniqueViolation(e) === false && (e as { code?: string }).code === '23514');
    const { rows } = await client.query('SELECT frozen FROM t_snapshot WHERE id = 1');
    expect(rows[0].frozen).toBe('original');
  });

  it('allows a no-op update (setting the frozen column to the same value)', async () => {
    await expect(client.query(`UPDATE t_snapshot SET frozen = 'original' WHERE id = 1`)).resolves.toBeDefined();
  });
});
