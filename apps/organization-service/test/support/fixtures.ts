import pg from 'pg';
import { expect } from 'vitest';
import { bearer, newKey, type TestApp } from './app.js';

/** Small helpers that create through the real HTTP API as a registered service caller. */
export function client(t: TestApp, caller = 'billing-service') {
  const auth = bearer(t.callers[caller]!);
  const create = async (path: string, body: object, expected = 201) => {
    const res = await t.http().post(path).set(auth).set('Idempotency-Key', newKey()).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    return res.body;
  };
  return {
    auth,
    get: (path: string) => t.http().get(path).set(auth),
    patch: (path: string, body: unknown) => t.http().patch(path).set(auth).send(body as object),
    /** `key` null sends NO Idempotency-Key header (an explicit undefined would just take the default). */
    post: (path: string, body: unknown, key: string | null = newKey()) => {
      const r = t.http().post(path).set(auth);
      return (key === null ? r : r.set('Idempotency-Key', key)).send(body as object);
    },
    company: (name = 'Acme Holdings') => create('/organization/companies', { name }),
    platform: (companyId: string, name = 'Acme Platform') => create('/organization/platforms', { companyId, name }),
    organization: (platformId: string, extra: object = {}) => create('/organization/organizations', { platformId, name: 'Acme Org', ...extra }),
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/** Runs one statement against a test database directly (bypassing the API) and returns its rows. */
export async function sql<R extends pg.QueryResultRow = any>(url: string, text: string, params: unknown[] = []): Promise<R[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<R>(text, params)).rows;
  } finally {
    await c.end();
  }
}
