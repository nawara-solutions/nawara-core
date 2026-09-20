import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { organizationMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { MISSING_ID, UUID_RE, client, sql } from './support/fixtures.js';

describeWithEnv('companies (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgcompanies');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url });
  });
  afterAll(async () => {
    await t?.app.close();
    await db.drop();
  });

  it('creates a company with a server-generated uuid and timestamps, and returns exactly {id, name, createdAt, updatedAt}', async () => {
    const c = client(t);
    const res = await c.post('/organization/companies', { name: '  Acme Holdings  ' });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['createdAt', 'id', 'name', 'updatedAt']);
    expect(res.body.id).toMatch(UUID_RE);
    expect(res.body.name).toBe('Acme Holdings'); // trimmed
    expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt);
    expect(res.body.updatedAt).toBe(res.body.createdAt);
  });

  it('reads it back by id', async () => {
    const c = client(t);
    const made = await c.company('Readable');
    const res = await c.get(`/organization/companies/${made.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(made);
  });

  it('is 404 (code not_found) for an unknown id and 400 for a malformed one', async () => {
    const c = client(t);
    const missing = await c.get(`/organization/companies/${MISSING_ID}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not_found');
    expect((await c.get('/organization/companies/not-a-uuid')).status).toBe(400);
  });

  it('updates the name, bumps updatedAt, leaves id and createdAt alone; a no-op update writes nothing', async () => {
    const c = client(t);
    const made = await c.company('Before');
    await new Promise((r) => setTimeout(r, 15));
    const res = await c.patch(`/organization/companies/${made.id}`, { name: 'After' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('After');
    expect(res.body.id).toBe(made.id);
    expect(res.body.createdAt).toBe(made.createdAt);
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(new Date(made.updatedAt).getTime());
    const noop = await c.patch(`/organization/companies/${made.id}`, { name: 'After' });
    expect(noop.body.updatedAt).toBe(res.body.updatedAt);
  });

  it.each([
    ['no name', {}],
    ['a blank name', { name: '   ' }],
    ['a whitespace-only name of tabs and newlines', { name: '\t\n ' }],
    ['a non-string name', { name: 42 }],
    ['a null name', { name: null }],
    ['an over-long name', { name: 'x'.repeat(201) }],
    ['an unknown field', { name: 'ok', vatId: 'x' }],
    ['a client-supplied id (mass assignment)', { name: 'ok', id: MISSING_ID }],
    ['client-supplied timestamps', { name: 'ok', createdAt: '2020-01-01T00:00:00.000Z' }],
  ])('rejects a create with %s (400 invalid_company_request)', async (_n, body) => {
    const res = await client(t).post('/organization/companies', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_company_request');
  });

  it.each([
    ['an empty patch', {}],
    ['a blank name', { name: '' }],
    ['an unknown field', { title: 'x' }],
    ['id', { id: MISSING_ID }],
    ['createdAt', { createdAt: '2020-01-01T00:00:00.000Z' }],
  ])('rejects an update with %s', async (_n, body) => {
    const made = await client(t).company();
    const res = await client(t).patch(`/organization/companies/${made.id}`, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_company_request');
  });

  it('rejects a non-object body and malformed JSON with 400, never 500', async () => {
    const c = client(t);
    for (const body of [[], 'text', 7, null]) {
      const res = await t.http().post('/organization/companies').set(c.auth).set('Idempotency-Key', 'key-for-shape-1').set('Content-Type', 'application/json').send(JSON.stringify(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const bad = await t.http().post('/organization/companies').set(c.auth).set('Idempotency-Key', 'key-for-shape-2').set('Content-Type', 'application/json').send('{"name":');
    expect(bad.status).toBe(400);
  });

  it('allows two companies with the same name: name uniqueness is NOT an established rule (it could reject valid imported rows)', async () => {
    const c = client(t);
    const a = await c.company('Twin');
    const b = await c.company('Twin');
    expect(a.id).not.toBe(b.id);
  });

  it('has no delete: DELETE is a 404 even with valid credentials, and the company is still there', async () => {
    const c = client(t);
    const made = await c.company();
    expect((await t.http().delete(`/organization/companies/${made.id}`).set(c.auth)).status).toBe(404);
    expect((await c.get(`/organization/companies/${made.id}`)).status).toBe(200);
  });

  describe('Idempotency-Key', () => {
    it('is required on create (400 idempotency_key_required) and must have the documented shape', async () => {
      const c = client(t);
      for (const key of [null, '', 'short', 'has space in it', 'x'.repeat(129)]) {
        const res = await c.post('/organization/companies', { name: 'K' }, key);
        expect(res.status, String(key)).toBe(400);
        expect(res.body.code).toBe('idempotency_key_required');
      }
    });

    it('an identical replay returns the SAME company with 200 + Idempotent-Replayed, and creates no second row', async () => {
      const c = client(t);
      const key = 'replay-key-0001';
      const first = await c.post('/organization/companies', { name: 'Once' }, key);
      const second = await c.post('/organization/companies', { name: 'Once' }, key);
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      const rows = await sql(db.url, `SELECT count(*)::int AS n FROM company WHERE name = 'Once'`);
      expect(rows[0].n).toBe(1);
    });

    it('the same key with a DIFFERENT body is 422 idempotency_key_reused', async () => {
      const c = client(t);
      await c.post('/organization/companies', { name: 'One' }, 'reuse-key-0001');
      const res = await c.post('/organization/companies', { name: 'Two' }, 'reuse-key-0001');
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('idempotency_key_reused');
    });

    it('keys are scoped per calling service: another caller reusing the key creates its own company', async () => {
      const a = client(t, 'billing-service');
      const b = client(t, 'payment-service');
      const first = await a.post('/organization/companies', { name: 'Scoped' }, 'scoped-key-0001');
      const second = await b.post('/organization/companies', { name: 'Scoped' }, 'scoped-key-0001');
      expect(second.status).toBe(201);
      expect(second.body.id).not.toBe(first.body.id);
    });

    it('concurrent requests with one key create exactly one company', async () => {
      const c = client(t);
      const results = await Promise.all(Array.from({ length: 8 }, () => c.post('/organization/companies', { name: 'Racy' }, 'race-key-00001')));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 200)).toHaveLength(7);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    });
  });

  describe('list', () => {
    it('is paged newest first with an opaque cursor, and every company appears exactly once across pages', async () => {
      const own = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgcolist');
      await runMigrations(own.url, [kitMigrationsDir, organizationMigrationsDir]);
      const t2 = await createTestApp({ databaseUrl: own.url });
      try {
        const c = client(t2);
        const created: string[] = [];
        for (let i = 0; i < 7; i++) created.push((await c.company(`C${i}`)).id);
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const res = await c.get(`/organization/companies?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
          expect(res.status).toBe(200);
          expect(Object.keys(res.body).sort()).toEqual(['items', 'nextCursor']);
          seen.push(...res.body.items.map((i: { id: string }) => i.id));
          cursor = res.body.nextCursor;
          pages++;
        } while (cursor);
        expect(pages).toBe(3);
        expect(seen).toEqual([...created].reverse());
        expect((await c.get('/organization/companies')).body.items).toHaveLength(7); // default limit 20 covers them all
      } finally {
        await t2.app.close();
        await own.drop();
      }
    });

    it.each([
      ['limit 0', 'limit=0'],
      ['limit 101', 'limit=101'],
      ['limit abc', 'limit=abc'],
      ['limit -1', 'limit=-1'],
      ['a repeated limit', 'limit=1&limit=2'],
      ['a garbage cursor', 'cursor=!!!'],
      ['a well-formed cursor of the wrong shape', `cursor=${Buffer.from('{"t":"x","i":"y"}').toString('base64url')}`],
      ['an unknown filter', 'name=x'],
      ['a filter that does not belong to companies', `platformId=${MISSING_ID}`],
      ['an object-shaped parameter', 'limit[a]=1'],
    ])('rejects %s with 400 invalid_query', async (_n, qs) => {
      const res = await client(t).get(`/organization/companies?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_query');
    });
  });
});
