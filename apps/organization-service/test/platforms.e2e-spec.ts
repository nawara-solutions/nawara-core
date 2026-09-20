import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { organizationMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { MISSING_ID, UUID_RE, client, sql } from './support/fixtures.js';

describeWithEnv('platforms (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgplatforms');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url });
  });
  afterAll(async () => {
    await t?.app.close();
    await db.drop();
  });

  it('creates a platform under an existing company: server-generated uuid, exactly {id, companyId, name, key, createdAt, updatedAt}', async () => {
    const c = client(t);
    const company = await c.company();
    const res = await c.post('/organization/platforms', { companyId: company.id, name: ' Main ' });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['companyId', 'createdAt', 'id', 'key', 'name', 'updatedAt']);
    expect(res.body.key).toBeNull(); // no request sets it; it is optional, as in auth-service
    expect(res.body.id).toMatch(UUID_RE);
    expect(res.body.companyId).toBe(company.id);
    expect(res.body.name).toBe('Main');
  });

  it('accepts an upper-case company uuid and stores the canonical lower-case form', async () => {
    const c = client(t);
    const company = await c.company();
    const res = await c.post('/organization/platforms', { companyId: company.id.toUpperCase(), name: 'Upper' });
    expect(res.status).toBe(201);
    expect(res.body.companyId).toBe(company.id);
  });

  it('rejects a nonexistent company with 404 company_not_found, creates nothing, and does not consume the Idempotency-Key', async () => {
    const c = client(t);
    const key = 'missing-parent-0001';
    const res = await c.post('/organization/platforms', { companyId: MISSING_ID, name: 'Orphan' }, key);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('company_not_found');
    expect(await sql(db.url, `SELECT 1 FROM platform WHERE name = 'Orphan'`)).toHaveLength(0);
    expect(await sql(db.url, `SELECT 1 FROM idempotency_key WHERE key = $1`, [key])).toHaveLength(0);
    // the same key can then be used for the corrected request
    const company = await c.company();
    expect((await c.post('/organization/platforms', { companyId: company.id, name: 'Orphan' }, key)).status).toBe(201);
  });

  it('cannot be created under a PLATFORM id or an ORGANIZATION id passed as companyId (ids of another entity are not companies)', async () => {
    const c = client(t);
    const company = await c.company();
    const platform = await c.platform(company.id);
    const org = await c.organization(platform.id);
    for (const wrong of [platform.id, org.id]) {
      const res = await c.post('/organization/platforms', { companyId: wrong, name: 'Wrong parent' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('company_not_found');
    }
  });

  it.each([
    ['no companyId', { name: 'x' }],
    ['a non-uuid companyId', { companyId: 'nope', name: 'x' }],
    ['a numeric companyId', { companyId: 12, name: 'x' }],
    ['a null companyId', { companyId: null, name: 'x' }],
    ['no name', { companyId: MISSING_ID }],
    ['a blank name', { companyId: MISSING_ID, name: ' ' }],
    ['an unknown field', { companyId: MISSING_ID, name: 'x', currency: 'TND' }],
    ['a client-supplied id', { companyId: MISSING_ID, name: 'x', id: MISSING_ID }],
    ['a platformId', { companyId: MISSING_ID, name: 'x', platformId: MISSING_ID }],
  ])('rejects a create with %s (400 invalid_platform_request)', async (_n, body) => {
    const res = await client(t).post('/organization/platforms', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_platform_request');
  });

  it('reads it back; unknown id is 404, malformed id is 400', async () => {
    const c = client(t);
    const platform = await c.platform((await c.company()).id);
    expect((await c.get(`/organization/platforms/${platform.id}`)).body).toEqual(platform);
    expect((await c.get(`/organization/platforms/${MISSING_ID}`)).status).toBe(404);
    expect((await c.get('/organization/platforms/xyz')).status).toBe(400);
    // a company id is not a platform id
    expect((await c.get(`/organization/platforms/${(await c.company()).id}`)).status).toBe(404);
  });

  it('updates the name and bumps updatedAt', async () => {
    const c = client(t);
    const platform = await c.platform((await c.company()).id, 'Old');
    await new Promise((r) => setTimeout(r, 15));
    const res = await c.patch(`/organization/platforms/${platform.id}`, { name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: platform.id, companyId: platform.companyId, name: 'New', createdAt: platform.createdAt });
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(new Date(platform.updatedAt).getTime());
  });

  it('REFUSES to move a platform to another company: companyId in a PATCH is 400, and the row is unchanged', async () => {
    const c = client(t);
    const a = await c.company('A');
    const b = await c.company('B');
    const platform = await c.platform(a.id);
    const res = await c.patch(`/organization/platforms/${platform.id}`, { companyId: b.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_platform_request');
    expect(res.body.message).toMatch(/companyId cannot be changed/);
    const also = await c.patch(`/organization/platforms/${platform.id}`, { name: 'ok', companyId: b.id });
    expect(also.status).toBe(400);
    expect((await c.get(`/organization/platforms/${platform.id}`)).body.companyId).toBe(a.id);
  });

  it.each([['an empty patch', {}], ['a blank name', { name: '' }], ['an unknown field', { title: 'x' }], ['id', { id: MISSING_ID }]])('rejects an update with %s', async (_n, body) => {
    const platform = await client(t).platform((await client(t).company()).id);
    const res = await client(t).patch(`/organization/platforms/${platform.id}`, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_platform_request');
  });

  it('a patch of an unknown platform is 404', async () => {
    expect((await client(t).patch(`/organization/platforms/${MISSING_ID}`, { name: 'x' })).status).toBe(404);
  });

  it('has no delete route', async () => {
    const c = client(t);
    const platform = await c.platform((await c.company()).id);
    expect((await t.http().delete(`/organization/platforms/${platform.id}`).set(c.auth)).status).toBe(404);
  });

  describe('list', () => {
    it('lists newest first, filters by companyId, and pages without loss or duplication', async () => {
      const c = client(t);
      const a = await c.company('ListA');
      const b = await c.company('ListB');
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await c.platform(a.id, `A${i}`)).id);
      const other = await c.platform(b.id, 'B0');

      const all: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await c.get(`/organization/platforms?companyId=${a.id}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status).toBe(200);
        all.push(...res.body.items.map((i: { id: string }) => i.id));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(all).toEqual([...ids].reverse());
      expect(all).not.toContain(other.id);

      const forB = await c.get(`/organization/platforms?companyId=${b.id}`);
      expect(forB.body.items.map((i: { id: string }) => i.id)).toEqual([other.id]);
      expect((await c.get(`/organization/platforms?companyId=${MISSING_ID}`)).body).toEqual({ items: [], nextCursor: null });
    });

    it.each([['a malformed companyId', 'companyId=nope'], ['a repeated companyId', `companyId=${MISSING_ID}&companyId=${MISSING_ID}`], ['organizations\' filter', `platformId=${MISSING_ID}`], ['an injection attempt', `companyId=${encodeURIComponent("' OR 1=1 --")}`]])('rejects %s with 400 invalid_query', async (_n, qs) => {
      const res = await client(t).get(`/organization/platforms?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_query');
    });
  });
});
