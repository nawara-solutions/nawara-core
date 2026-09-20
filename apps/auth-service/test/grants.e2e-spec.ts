import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);

/**
 * ADR-0042 decision 6 / Amendment 1 A.2: GET /auth/grants exposes only the server-derived facts a
 * caller service needs to evaluate human administrative authority — never a general identity/profile
 * surface. This spec proves each kind gets exactly its own facts and nothing else.
 */
describe('GET /auth/grants — server-derived authorization facts (ADR-0042 decision 6)', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0);
    w = await t.world();
  });
  afterAll(() => t.close());

  const grants = (tokens: unknown) => t.http.get('/auth/grants').set(bearer(tokens as any));

  it('rejects an unauthenticated caller', async () => {
    await t.http.get('/auth/grants').expect(401);
  });

  it('owner: kind=owner, companyId set, no platform assignments, no org-admin memberships', async () => {
    const o = await t.readyOwner(w.companyA, `owner${uniq()}@a.test`);
    const r = await grants(o.tokens).expect(200);
    expect(r.body).toEqual({ userId: o.id, kind: 'owner', companyId: w.companyA, platformAssignments: [], organizationAdminMemberships: [] });
  });

  it('operator: kind=operator, active Platform assignments only, no companyId, no org-admin memberships', async () => {
    const co = await t.newCompany();
    const owner = await t.owner(co, `owner${uniq()}@a.test`);
    const platform = (await t.db.query(`INSERT INTO platform(id,"companyId",name) VALUES (gen_random_uuid(),$1,'P') RETURNING id`, [co])).rows[0].id as string;
    const op = await t.operator(co, `op${uniq()}@a.test`);
    await t.assign(op.id, platform, owner.id, co);
    const login = await t.operatorLogin(op.email);
    const r = await grants(login).expect(200);
    expect(r.body).toEqual({ userId: op.id, kind: 'operator', companyId: null, platformAssignments: [platform], organizationAdminMemberships: [] });
  });

  it('operator: a revoked assignment does not appear', async () => {
    const co = await t.newCompany();
    const owner = await t.owner(co, `owner${uniq()}@a.test`);
    const platform = (await t.db.query(`INSERT INTO platform(id,"companyId",name) VALUES (gen_random_uuid(),$1,'P') RETURNING id`, [co])).rows[0].id as string;
    const op = await t.operator(co, `op${uniq()}@a.test`);
    await t.assign(op.id, platform, owner.id, co);
    await t.db.query(`UPDATE platform_assignment SET active=false, "revokedAt"=now(), "revokedBy"=$1 WHERE "operatorId"=$2`, [owner.id, op.id]);
    const login = await t.operatorLogin(op.email);
    const r = await grants(login).expect(200);
    expect(r.body.platformAssignments).toEqual([]);
  });

  it('member with no memberships: no companyId, no assignments, no org-admin memberships', async () => {
    const m = await t.memberNoOrg(`zero${uniq()}@x.test`);
    const login = await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(200);
    const r = await grants(login.body).expect(200);
    expect(r.body).toEqual({ userId: m.id, kind: 'member', companyId: null, platformAssignments: [], organizationAdminMemberships: [] });
  });

  it('member with an ordinary (non-admin) active membership: organizationAdminMemberships is empty', async () => {
    const m = await t.member(w.orgSchool1, `mem${uniq()}@x.test`);
    const login = await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(200);
    const r = await grants(login.body).expect(200);
    expect(r.body.organizationAdminMemberships).toEqual([]);
  });

  it('member with an org-admin membership: that organization appears; a second, non-admin membership does not', async () => {
    const m = await t.member(w.orgSchool1, `admin${uniq()}@x.test`);
    await t.db.query(`UPDATE organization_membership SET "isOrganizationAdmin"=true WHERE "userId"=$1 AND "organizationId"=$2`, [m.id, w.orgSchool1]);
    await t.addMembership(m.id, w.orgDrive, 'driver', 'active'); // second org, not admin
    const login = await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(200);
    const r = await grants(login.body).expect(200);
    expect(r.body.organizationAdminMemberships).toEqual([w.orgSchool1]);
  });

  it('a revoked org-admin membership no longer counts (revoke clears the admin flag, ADR-0030)', async () => {
    const m = await t.member(w.orgSchool1, `revadmin${uniq()}@x.test`);
    await t.db.query(`UPDATE organization_membership SET "isOrganizationAdmin"=true WHERE "userId"=$1 AND "organizationId"=$2`, [m.id, w.orgSchool1]);
    const login = await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(200);
    expect((await grants(login.body).expect(200)).body.organizationAdminMemberships).toEqual([w.orgSchool1]);
    await t.db.query(`UPDATE organization_membership SET status='revoked', "isOrganizationAdmin"=false, "revokedAt"=now(), "revokedBy"=$1 WHERE "userId"=$2 AND "organizationId"=$3`, [m.id, m.id, w.orgSchool1]);
    expect((await grants(login.body).expect(200)).body.organizationAdminMemberships).toEqual([]);
  });

  it('never exposes password hash, refresh tokens, or any field beyond the four documented facts', async () => {
    const m = await t.member(w.orgSchool1, `shape${uniq()}@x.test`);
    const login = await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(200);
    const r = await grants(login.body).expect(200);
    expect(Object.keys(r.body).sort()).toEqual(['companyId', 'kind', 'organizationAdminMemberships', 'platformAssignments', 'userId'].sort());
  });
});
