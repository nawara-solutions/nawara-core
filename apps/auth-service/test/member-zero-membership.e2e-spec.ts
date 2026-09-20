import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);

/**
 * Owner decision 2026-09-20 (docs/architecture/stage-10/member-membership-invariant-owner-decision.md),
 * migration 0009: a member may now hold [0..N] memberships, was [1..N]. Zero memberships must grant zero
 * organization authority — every check below proves authorization is still derived live from actual
 * ACTIVE membership rows, never from identity, kind, or session alone.
 */
describe('member with zero memberships: identity is valid, authority is not', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0);
    w = await t.world();
  });
  afterAll(() => t.close());

  const login = (email: string, password: string) => t.http.post('/auth/login').send({ email, password });
  const me = async (tokens: unknown) => (await t.http.get('/auth/me').set(bearer(tokens as any)).expect(200)).body;
  const reach = (tokens: unknown, org: string) => t.http.get(`/auth/organizations/${org}/membership`).set(bearer(tokens as any));

  // ---------------------------------------------------------------- Case 1: zero-membership member
  it('a member may be created with zero memberships, and /auth/me returns memberships: []', async () => {
    const email = `zero${uniq()}@x.test`;
    const password = 'member password 1';
    await t.memberNoOrg(email, password);
    const r = await login(email, password).expect(200);
    expect(r.body).toHaveProperty('accessToken');
    const body = await me(r.body);
    expect(body.memberships).toEqual([]);
  });

  // ---------------------------------------------------------------- Case 2: zero-membership authorization
  it('a zero-membership member is DENIED any organization-scoped access', async () => {
    const email = `zero${uniq()}@x.test`;
    const password = 'member password 1';
    await t.memberNoOrg(email, password);
    const r = await login(email, password).expect(200);
    await reach(r.body, w.orgSchool1).expect(404);
    await reach(r.body, w.orgDrive).expect(404);
  });

  // ---------------------------------------------------------------- Case 3: existing (single-membership) member
  it('a member with an active membership in Org A is ALLOWED for Org A (unchanged)', async () => {
    const m = await t.member(w.orgSchool1, `one${uniq()}@x.test`);
    const r = await login(m.email, m.password).expect(200);
    await reach(r.body, w.orgSchool1).expect(204);
  });

  // ---------------------------------------------------------------- Case 4: multiple memberships
  it('a member with active memberships in Org A and Org B is ALLOWED for both (unchanged)', async () => {
    const m = await t.member(w.orgSchool1, `multi${uniq()}@x.test`);
    await t.addMembership(m.id, w.orgDrive, 'driver', 'active');
    const r = await login(m.email, m.password).expect(200);
    await reach(r.body, w.orgSchool1).expect(204);
    await reach(r.body, w.orgDrive).expect(204);
    const body = await me(r.body);
    expect(body.memberships).toHaveLength(2);
  });

  // ---------------------------------------------------------------- Case 5: wrong organization
  it('a member of Org A is DENIED for Org B (unchanged)', async () => {
    const m = await t.member(w.orgSchool1, `wrong${uniq()}@x.test`);
    const r = await login(m.email, m.password).expect(200);
    await reach(r.body, w.orgDrive).expect(404);
  });

  // ---------------------------------------------------------------- Case 6: inactive membership
  it('a member whose only membership is pending (not active) is DENIED, same as zero memberships (unchanged)', async () => {
    const m = await t.member(w.orgSchool1, `pend${uniq()}@x.test`, undefined, 'student', 'pending');
    const r = await login(m.email, m.password).expect(200);
    await reach(r.body, w.orgSchool1).expect(404);
    const body = await me(r.body);
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0]).toMatchObject({ status: 'pending' });
  });

  it('a member whose only membership is revoked is DENIED (unchanged)', async () => {
    const m = await t.member(w.orgSchool1, `rev${uniq()}@x.test`);
    await t.db.query(`UPDATE organization_membership SET status='revoked', "revokedAt"=now(), "revokedBy"=$1 WHERE "userId"=$2`, [m.id, m.id]);
    const r = await login(m.email, m.password).expect(200);
    await reach(r.body, w.orgSchool1).expect(404);
  });

  // ---------------------------------------------------------------- Phase 8: authentication path independence
  it('refresh works for a zero-membership member (ordinary authentication does not require membership)', async () => {
    const email = `refresh${uniq()}@x.test`;
    const password = 'member password 1';
    await t.memberNoOrg(email, password);
    const r = await login(email, password).expect(200);
    const refreshed = await t.http.post('/auth/refresh').send({ refreshToken: r.body.refreshToken }).expect(200);
    expect(refreshed.body).toHaveProperty('accessToken');
    await me(refreshed.body);
  });

  // ---------------------------------------------------------------- Security: client cannot self-grant authority
  it('a client-supplied organizationId is never trusted: a zero-membership member cannot spoof access via the URL alone', async () => {
    const email = `spoof${uniq()}@x.test`;
    const password = 'member password 1';
    await t.memberNoOrg(email, password);
    const r = await login(email, password).expect(200);
    // Every organization in the fixture world, tried directly — none are reachable without a real membership row.
    for (const org of [w.orgSchool1, w.orgSchool2, w.orgDrive, w.orgClinic]) await reach(r.body, org).expect(404);
  });
});
