import pg from 'pg';

/** Runs one statement on its own connection and returns the rows. */
export async function sql<T = Record<string, unknown>>(url: string, text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Runs a statement that must FAIL; returns the PostgreSQL error code, constraint and message (never the row data). */
export async function failure(url: string, text: string, params: unknown[] = []): Promise<{ code?: string; constraint?: string; message: string }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(text, params);
  } catch (e) {
    const err = e as { code?: string; constraint?: string; message: string };
    return { code: err.code, constraint: err.constraint, message: err.message };
  } finally {
    await c.end();
  }
  throw new Error(`statement unexpectedly succeeded: ${text.slice(0, 120)}`);
}
