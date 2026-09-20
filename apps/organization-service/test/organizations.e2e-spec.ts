import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { organizationMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { MISSING_ID, UUID_RE, client, sql } from './support/fixtures.js';

describeWithEnv('organizations (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let platformId: string;
  let companyId: string;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgorgs');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url });
    const c = client(t);
    companyId = (await c.company()).id;
    platformId = (await c.platform(companyId)).id;
  });
  afterAll(async () => {
    await t?.app.close();
    await db.drop();
  });

  it('creates an organization under an existing platform with the full established shape', async () => {
    const res = await client(t).post('/organization/organizations', {
      platformId, name: ' Lakeside ', taxCode: 'TX-123', address: '1 Main St', phone: '+21611111111', type: 'anything-goes',
    });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['address', 'createdAt', 'id', 'name', 'phone', 'platformId', 'taxCode', 'type', 'updatedAt']);
    expect(res.body).toMatchObject({ platformId, name: 'Lakeside', taxCode: 'TX-123', address: '1 Main St', phone: '+21611111111', type: 'anything-goes' });
    expect(res.body.id).toMatch(UUID_RE);
  });

  it('has NO companyId: an organization reaches its company only through its platform, in the response and in the table', async () => {
    const org = await client(t).organization(platformId);
    expect(org).not.toHaveProperty('companyId');
    const cols = await sql<{ column_name: string }>(db.url, `SELECT column_name FROM information_schema.columns WHERE table_name = 'organization'`);
    expect(cols.map((c) => c.column_name)).not.toContain('companyId');
    const res = await client(t).post('/organization/organizations', { platformId, name: 'x', companyId });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_organization_request');
  });

  it('optional fields default to null; `type` is opaque (never validated against a list)', async () => {
    const org = await client(t).organization(platformId, { type: 'zz-9 something else entirely' });
    expect(org).toMatchObject({ taxCode: null, address: null, phone: null, type: 'zz-9 something else entirely' });
  });

  it('rejects a nonexistent platform with 404 platform_not_found, and does not consume the Idempotency-Key', async () => {
    const c = client(t);
    const key = 'missing-platform-001';
    const res = await c.post('/organization/organizations', { platformId: MISSING_ID, name: 'Orphan Org' }, key);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('platform_not_found');
    expect(await sql(db.url, `SELECT 1 FROM organization WHERE name = 'Orphan Org'`)).toHaveLength(0);
    expect(await sql(db.url, `SELECT 1 FROM idempotency_key WHERE key = $1`, [key])).toHaveLength(0);
  });

  it('a company id or another organization id is not a platform: 404 platform_not_found', async () => {
    const c = client(t);
    const org = await c.organization(platformId);
    for (const wrong of [companyId, org.id]) {
      const res = await c.post('/organization/organizations', { platformId: wrong, name: 'Wrong parent' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('platform_not_found');
    }
  });

  it.each([
    ['no platformId', { name: 'x' }],
    ['a non-uuid platformId', { platformId: 'p1', name: 'x' }],
    ['no name', { platformId: MISSING_ID }],
    ['a blank name', { platformId: MISSING_ID, name: '  ' }],
    ['a non-string taxCode', { platformId: MISSING_ID, name: 'x', taxCode: 5 }],
    ['a blank address', { platformId: MISSING_ID, name: 'x', address: ' ' }],
    ['an over-long phone', { platformId: MISSING_ID, name: 'x', phone: '1'.repeat(33) }],
    ['an over-long type', { platformId: MISSING_ID, name: 'x', type: 't'.repeat(65) }],
    ['an unknown field', { platformId: MISSING_ID, name: 'x', status: 'active' }],
    ['a lifecycle field (unresolved semantics, not accepted)', { platformId: MISSING_ID, name: 'x', archived: true }],
    ['a client-supplied id', { platformId: MISSING_ID, name: 'x', id: MISSING_ID }],
    ['client-supplied timestamps', { platformId: MISSING_ID, name: 'x', updatedAt: '2020-01-01T00:00:00.000Z' }],
  ])('rejects a create with %s (400 invalid_organization_request)', async (_n, body) => {
    const res = await client(t).post('/organization/organizations', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_organization_request');
  });

  it('reads it back; unknown is 404, malformed is 400, and other entities\' ids are not organizations', async () => {
    const c = client(t);
    const org = await c.organization(platformId);
    expect((await c.get(`/organization/organizations/${org.id}`)).body).toEqual(org);
    expect((await c.get(`/organization/organizations/${MISSING_ID}`)).status).toBe(404);
    expect((await c.get('/organization/organizations/1')).status).toBe(400);
    expect((await c.get(`/organization/organizations/${platformId}`)).status).toBe(404);
    expect((await c.get(`/organization/organizations/${companyId}`)).status).toBe(404);
  });

  it('updates fields selectively; null clears an optional field; a no-op leaves updatedAt alone', async () => {
    const c = client(t);
    const org = await c.organization(platformId, { taxCode: 'T1', address: 'A1', phone: 'P1', type: 'K1' });
    await new Promise((r) => setTimeout(r, 15));
    const res = await c.patch(`/organization/organizations/${org.id}`, { name: 'Renamed', address: null, phone: '999' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: org.id, platformId, name: 'Renamed', taxCode: 'T1', address: null, phone: '999', type: 'K1', createdAt: org.createdAt });
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(new Date(org.updatedAt).getTime());
    const again = await c.patch(`/organization/organizations/${org.id}`, { name: 'Renamed', address: null });
    expect(again.body.updatedAt).toBe(res.body.updatedAt);
  });

  it('REFUSES to move an organization to another platform: platformId in a PATCH is 400 and the row is unchanged', async () => {
    const c = client(t);
    const other = await c.platform(companyId, 'Other platform');
    const org = await c.organization(platformId);
    for (const body of [{ platformId: other.id }, { name: 'sneaky', platformId: other.id }]) {
      const res = await c.patch(`/organization/organizations/${org.id}`, body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/platformId cannot be changed/);
    }
    const now = (await c.get(`/organization/organizations/${org.id}`)).body;
    expect(now).toEqual(org);
  });

  it.each([['an empty patch', {}], ['a blank name', { name: ' ' }], ['a bad type', { type: 7 }], ['an unknown field', { status: 'x' }], ['id', { id: MISSING_ID }], ['createdAt', { createdAt: 'x' }]])('rejects an update with %s', async (_n, body) => {
    const org = await client(t).organization(platformId);
    const res = await client(t).patch(`/organization/organizations/${org.id}`, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_organization_request');
  });

  it('a patch of an unknown organization is 404; name is required so it cannot be cleared with null', async () => {
    expect((await client(t).patch(`/organization/organizations/${MISSING_ID}`, { name: 'x' })).status).toBe(404);
    const org = await client(t).organization(platformId);
    expect((await client(t).patch(`/organization/organizations/${org.id}`, { name: null })).status).toBe(400);
  });

  it('has no delete route and NO membership routes (membership is auth-service\'s)', async () => {
    const c = client(t);
    const org = await c.organization(platformId);
    expect((await t.http().delete(`/organization/organizations/${org.id}`).set(c.auth)).status).toBe(404);
    for (const path of [`/organization/organizations/${org.id}/memberships`, `/organization/organizations/${org.id}/members`, `/organization/memberships`, `/organization/users`]) {
      expect((await c.get(path)).status, path).toBe(404);
    }
  });

  it('idempotent create: replay returns the same organization; a different body under the same key is 422', async () => {
    const c = client(t);
    const key = 'org-replay-key-01';
    const first = await c.post('/organization/organizations', { platformId, name: 'Idem' }, key);
    const replay = await c.post('/organization/organizations', { platformId, name: 'Idem' }, key);
    expect([first.status, replay.status]).toEqual([201, 200]);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await c.post('/organization/organizations', { platformId, name: 'Different' }, key)).status).toBe(422);
  });

  it('lists newest first, filters by platformId, and pages without loss or duplication', async () => {
    const c = client(t);
    const p1 = await c.platform(companyId, 'LP1');
    const p2 = await c.platform(companyId, 'LP2');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await c.organization(p1.id, { name: `O${i}` })).id);
    const foreign = await c.organization(p2.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await c.get(`/organization/organizations?platformId=${p1.id}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...ids].reverse());
    expect(seen).not.toContain(foreign.id);
    expect((await c.get(`/organization/organizations?platformId=${MISSING_ID}`)).body).toEqual({ items: [], nextCursor: null });
    expect((await c.get('/organization/organizations?companyId=' + companyId)).status).toBe(400); // no Organization -> Company shortcut in the API either
    expect((await c.get('/organization/organizations?platformId=nope')).status).toBe(400);
  });

  it('pages correctly across rows whose timestamps differ only below a millisecond (rows imported with original timestamps can)', async () => {
    const own = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgmicro');
    await runMigrations(own.url, [kitMigrationsDir, organizationMigrationsDir]);
    const t2 = await createTestApp({ databaseUrl: own.url });
    try {
      const c = client(t2);
      const p = await c.platform((await c.company()).id);
      const base = '2024-03-01 10:00:00';
      const expected: string[] = [];
      for (let i = 0; i < 6; i++) {
        const id = `00000000-0000-4000-8000-00000000000${i}`;
        // microsecond-apart timestamps, all inside ONE millisecond
        await sql(own.url, `INSERT INTO organization (id, "platformId", name, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz)`, [id, p.id, `M${i}`, `${base}.12345${i}+00`]);
        expected.unshift(id);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await c.get(`/organization/organizations?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...res.body.items.map((i: { id: string }) => i.id));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(seen).toEqual(expected);
    } finally {
      await t2.app.close();
      await own.drop();
    }
  });
});
