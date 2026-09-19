import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);
const statuses = (res: Array<{ status: number }>) => res.map((r) => r.status).sort((a, b) => a - b);

/**
 * One identity, N organization memberships, on different platforms (ADR-0030). "School" and "Drive" are only labels
 * for two platforms of one company in these tests; Auth knows nothing about what either business does.
 */
describe('one user, many organizations: membership is the only link', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let ownerA: Awaited<ReturnType<TestCtx['readyOwner']>>;
  let ownerB: Awaited<ReturnType<TestCtx['readyOwner']>>;

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0); // listen once: parallel supertest bursts otherwise ECONNRESET
    w = await t.world(); // platformSchool: orgSchool1/orgSchool2; platformDrive: orgDrive (company A); platformClinic: orgClinic (company B)
    for (const o of [w.orgSchool1, w.orgSchool2, w.orgDrive, w.orgClinic]) t.payment.licensed.add(o);
    ownerA = await t.readyOwner(w.companyA, `ownera${uniq()}@a.test`);
    ownerB = await t.readyOwner(w.companyB, `ownerb${uniq()}@b.test`);
  });
  afterAll(() => t.close());

  const register = (joinCode: string, email: string) => t.http.post('/auth/register').send({ email, password: 'member password 1', joinCode });
  const join = (tokens: unknown, joinCode: string) => t.http.post('/auth/onboarding/join').set(bearer(tokens as any)).send({ joinCode });
  const me = async (tokens: unknown) => (await t.http.get('/auth/me').set(bearer(tokens as any)).expect(200)).body;
  const reach = (tokens: unknown, org: string) => t.http.get(`/auth/organizations/${org}/membership`).set(bearer(tokens as any));
  const memberships = async (userId: string) => (await t.db.query(`SELECT id, "organizationId", status, audience, "isOrganizationAdmin" FROM organization_membership WHERE "userId"=$1 ORDER BY "requestedAt", id`, [userId])).rows;
  const userId = async (email: string) => (await t.db.query(`SELECT id FROM "user" WHERE email=$1`, [email])).rows[0].id as string;
  const decide = (tokens: unknown, org: string, id: string, action: 'approve' | 'reject' | 'revoke') =>
    t.http.post(`/auth/organizations/${org}/memberships/${id}/${action}`).set(bearer(tokens as any));

  /** a user with an ACTIVE membership in orgSchool1 (label "student") registered through the real API */
  async function student() {
    const c = await t.joinCode(w.orgSchool1, { audience: 'student', requiresApproval: false });
    const email = `s${uniq()}@a.test`;
    const r = await register(c.code, email).expect(201);
    return { email, tokens: r.body, id: await userId(email) };
  }

  // ------------------------------------------------------------------------------ the model
  describe('one identity across two platforms', () => {
    it('an existing user joins a second organization with a code: no new account, no new tokens, two memberships with different labels', async () => {
      const s = await student();
      const driveCode = await t.joinCode(w.orgDrive, { audience: 'driver', requiresApproval: true });
      const r = await join(s.tokens, driveCode.code).expect(201);
      expect(r.body.onboarding).toMatchObject({ audience: 'driver', membershipStatus: 'pending' });
      expect(r.body).not.toHaveProperty('accessToken'); // the session is unchanged
      expect((await t.db.query(`SELECT count(*)::int n FROM "user" WHERE email=$1`, [s.email])).rows[0].n).toBe(1);
      const rows = await memberships(s.id);
      const key = (m: string[]) => m.join('|');
      expect(rows.map((m) => key([m.organizationId, m.status, m.audience])).sort((a, b) => a.localeCompare(b))).toEqual([key([w.orgSchool1, 'active', 'student']), key([w.orgDrive, 'pending', 'driver'])].sort((a, b) => a.localeCompare(b))); // order is not defined: same clock tick
      const account = (await t.db.query(`SELECT kind, role FROM "user" WHERE id=$1`, [s.id])).rows[0];
      expect(account).toEqual({ kind: 'member', role: 'member' }); // no business label on the identity
    });

    it('/auth/me lists every membership with its own platform, status and label, from current rows', async () => {
      await t.db.query(`UPDATE platform SET key='school-platform' WHERE id=$1`, [w.platformSchool]);
      const s = await student();
      const c = await t.joinCode(w.orgDrive, { audience: 'driver', requiresApproval: true });
      await join(s.tokens, c.code).expect(201);
      const body = await me(s.tokens);
      expect(body.memberships).toHaveLength(2);
      const byOrg = Object.fromEntries(body.memberships.map((m: any) => [m.organization.id, m]));
      expect(byOrg[w.orgSchool1]).toMatchObject({ status: 'active', audience: 'student', platform: { id: w.platformSchool, key: 'school-platform' }, isOrganizationAdmin: false });
      expect(byOrg[w.orgDrive]).toMatchObject({ status: 'pending', audience: 'driver', platform: { id: w.platformDrive } });
      expect(body).not.toHaveProperty('organizationId');
      expect(body).not.toHaveProperty('role');
    });

    it('access tokens carry NO organization, platform or business-role context (the context is the resource, decided live)', async () => {
      const s = await student();
      const claims = decodeJwt(s.tokens.accessToken) as Record<string, unknown>;
      expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'role', 'sid', 'sub']);
      expect(claims.role).toBe('member');
    });

    it('membership in one organization never grants access to another; a pending one is not admitted; approval takes effect on the same token', async () => {
      const s = await student();
      const c = await t.joinCode(w.orgDrive, { audience: 'driver', requiresApproval: true });
      await join(s.tokens, c.code).expect(201);
      await reach(s.tokens, w.orgSchool1).expect(204); // active
      await reach(s.tokens, w.orgDrive).expect(404); // pending: authenticated, not admitted
      await reach(s.tokens, w.orgSchool2).expect(404); // same platform, no membership
      await reach(s.tokens, w.orgClinic).expect(404); // another company
      const mid = (await memberships(s.id)).find((m) => m.organizationId === w.orgDrive)!.id;
      await decide(ownerA.tokens, w.orgDrive, mid, 'approve').expect(200);
      await reach(s.tokens, w.orgDrive).expect(204); // same token, now admitted there too
      await reach(s.tokens, w.orgClinic).expect(404);
    });

    it('owners and operators have no memberships and no member context', async () => {
      expect((await me(ownerA.tokens)).memberships).toEqual([]);
      const b = await me(ownerB.tokens);
      expect(b.memberships).toEqual([]);
      expect(b.adminTier).toBe('owner');
    });

    it('a contact is ONE account: registering again for another organization is refused, joining with the account is the path', async () => {
      const s = await student();
      const c = await t.joinCode(w.orgDrive, { audience: 'driver' });
      await register(c.code, s.email).expect(409);
      expect((await t.db.query(`SELECT "usedCount" FROM organization_join_code WHERE id=$1`, [c.id])).rows[0].usedCount).toBe(0); // no use spent
      await join(s.tokens, c.code).expect(201);
    });
  });

  // ------------------------------------------------------------------------------ the join route
  describe('POST /auth/onboarding/join', () => {
    it('refuses: unauthenticated (401), owner/operator (403), a bad code and an unlicensed organization (the same generic 403)', async () => {
      const s = await student();
      const c = await t.joinCode(w.orgDrive, { audience: 'driver' });
      await t.http.post('/auth/onboarding/join').send({ joinCode: c.code }).expect(401);
      await join(ownerA.tokens, c.code).expect(403);
      t.payment.licensed.delete(w.orgDrive);
      try {
        const unlicensed = await join(s.tokens, c.code);
        const bad = await join(s.tokens, 'ABCDE-FGHJK');
        expect(unlicensed.status).toBe(403);
        expect(bad.status).toBe(403);
        expect(unlicensed.body).toEqual(bad.body);
      } finally { t.payment.licensed.add(w.orgDrive); }
      expect((await memberships(s.id)).length).toBe(1);
    });

    it('fails CLOSED when payment-service is down and spends no use of the code', async () => {
      const s = await student();
      const c = await t.joinCode(w.orgDrive, { audience: 'driver', maxUses: 1 });
      t.payment.down = true;
      try { await join(s.tokens, c.code).expect(503); } finally { t.payment.down = false; }
      expect((await t.db.query(`SELECT "usedCount" FROM organization_join_code WHERE id=$1`, [c.id])).rows[0].usedCount).toBe(0);
      await join(s.tokens, c.code).expect(201); // still usable
    });

    it('a second membership in the SAME organization is a 409 and spends nothing; a rejected or revoked one cannot be re-opened', async () => {
      const s = await student();
      const c = await t.joinCode(w.orgSchool1, { audience: 'student', maxUses: 5 });
      await join(s.tokens, c.code).expect(409);
      expect((await t.db.query(`SELECT "usedCount" FROM organization_join_code WHERE id=$1`, [c.id])).rows[0].usedCount).toBe(0);
      const mid = (await memberships(s.id))[0].id;
      await decide(ownerA.tokens, w.orgSchool1, mid, 'revoke').expect(200);
      await join(s.tokens, c.code).expect(409); // final state: cannot be re-opened by joining again
    });

    it('concurrency: 6 different users joining a code with maxUses=2 create exactly 2 memberships', async () => {
      const users = await Promise.all(Array.from({ length: 6 }, () => student()));
      const c = await t.joinCode(w.orgDrive, { audience: 'driver', maxUses: 2 });
      const res = await Promise.all(users.map((u) => join(u.tokens, c.code)));
      expect(statuses(res)).toEqual([201, 201, 403, 403, 403, 403]);
      expect((await t.db.query(`SELECT count(*)::int n FROM organization_membership WHERE "joinCodeId"=$1`, [c.id])).rows[0].n).toBe(2);
      expect((await t.db.query(`SELECT "usedCount" FROM organization_join_code WHERE id=$1`, [c.id])).rows[0].usedCount).toBe(2);
    });

    it('concurrency: the same user joining the same organization 5 times at once gets exactly one membership', async () => {
      const s = await student();
      const c = await t.joinCode(w.orgDrive, { audience: 'driver', maxUses: 10 });
      const res = await Promise.all(Array.from({ length: 5 }, () => join(s.tokens, c.code)));
      expect(statuses(res)).toEqual([201, 409, 409, 409, 409]);
      expect((await memberships(s.id)).filter((m) => m.organizationId === w.orgDrive)).toHaveLength(1);
      expect((await t.db.query(`SELECT "usedCount" FROM organization_join_code WHERE id=$1`, [c.id])).rows[0].usedCount).toBe(1); // losers rolled back
    });
  });

  // ------------------------------------------------------------------------------ REVOKED
  describe('REVOKED membership', () => {
    it('affects ONLY that organization: access there ends on the next request, the other membership and the session survive', async () => {
      const s = await student();
      const c = await t.joinCode(w.orgDrive, { audience: 'driver', requiresApproval: false });
      await join(s.tokens, c.code).expect(201);
      await reach(s.tokens, w.orgSchool1).expect(204);
      await reach(s.tokens, w.orgDrive).expect(204);
      const school = (await memberships(s.id)).find((m) => m.organizationId === w.orgSchool1)!.id;
      const r = await decide(ownerA.tokens, w.orgSchool1, school, 'revoke').expect(200);
      expect(r.body).toEqual({ id: school, status: 'revoked' });
      await reach(s.tokens, w.orgSchool1).expect(404); // same token, revoked there
      await reach(s.tokens, w.orgDrive).expect(204); // untouched
      await t.http.post('/auth/refresh').send({ refreshToken: s.tokens.refreshToken }).expect(200); // the SESSION is user-wide and survives
      const body = await me(s.tokens);
      expect(body.memberships.map((m: any) => m.status).sort()).toEqual(['active', 'revoked']);
      expect(t.bus.last('membership.revoked')).toMatchObject({ userId: s.id, organizationId: w.orgSchool1 });
    });

    it('is final and only from active: pending, rejected, already revoked and approve-after-revoke are all 409', async () => {
      const s = await student();
      const mid = (await memberships(s.id))[0].id;
      await decide(ownerA.tokens, w.orgSchool1, mid, 'revoke').expect(200);
      await decide(ownerA.tokens, w.orgSchool1, mid, 'revoke').expect(409);
      await decide(ownerA.tokens, w.orgSchool1, mid, 'approve').expect(409);
      await decide(ownerA.tokens, w.orgSchool1, mid, 'reject').expect(409);
      const p = await t.member(w.orgSchool1, `p${uniq()}@a.test`, 'member password 1', 'student', 'pending');
      const pid = (await memberships(p.id))[0].id;
      await decide(ownerA.tokens, w.orgSchool1, pid, 'revoke').expect(409);
    });

    it('is authorized: a plain member, another company\'s owner and the person themselves get a collapsed 404', async () => {
      const victim = await student();
      const other = await student();
      const mid = (await memberships(victim.id))[0].id;
      await decide(other.tokens, w.orgSchool1, mid, 'revoke').expect(404);
      await decide(ownerB.tokens, w.orgSchool1, mid, 'revoke').expect(404);
      await decide(victim.tokens, w.orgSchool1, mid, 'revoke').expect(404); // nobody revokes themselves here
      expect((await memberships(victim.id))[0].status).toBe('active');
    });

    it('revoking an organization admin clears the capability in the same step; the stale token loses the authority on the next request', async () => {
      const admin = await student();
      await t.db.query(`UPDATE organization_membership SET "isOrganizationAdmin"=true WHERE "userId"=$1`, [admin.id]);
      await t.http.get(`/auth/organizations/${w.orgSchool1}/memberships`).set(bearer(admin.tokens)).expect(200); // authority works
      const mid = (await memberships(admin.id))[0].id;
      await decide(ownerA.tokens, w.orgSchool1, mid, 'revoke').expect(200);
      expect((await memberships(admin.id))[0]).toMatchObject({ status: 'revoked', isOrganizationAdmin: false });
      await t.http.get(`/auth/organizations/${w.orgSchool1}/memberships`).set(bearer(admin.tokens)).expect(404); // authority gone, same token
    });

    it('an organization admin can revoke a plain member but NOT another administrator (admins cannot remove each other)', async () => {
      const adminA = await student();
      const adminB = await student();
      const plain = await student();
      await t.db.query(`UPDATE organization_membership SET "isOrganizationAdmin"=true WHERE "userId" = ANY($1)`, [[adminA.id, adminB.id]]);
      await decide(adminA.tokens, w.orgSchool1, (await memberships(adminB.id))[0].id, 'revoke').expect(404);
      expect((await memberships(adminB.id))[0]).toMatchObject({ status: 'active', isOrganizationAdmin: true });
      await decide(adminA.tokens, w.orgSchool1, (await memberships(plain.id))[0].id, 'revoke').expect(200);
      await decide(ownerA.tokens, w.orgSchool1, (await memberships(adminB.id))[0].id, 'revoke').expect(200); // an Owner can
    });

    it('is audited without secrets and the member keeps the account (never deleted)', async () => {
      const s = await student();
      const mid = (await memberships(s.id))[0].id;
      await decide(ownerA.tokens, w.orgSchool1, mid, 'revoke').expect(200);
      const ev = (await t.db.query(`SELECT outcome, "actorId", "targetId", metadata FROM auth_audit_event WHERE type='membership.revoked' AND "targetId"=$1`, [s.id])).rows;
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ outcome: 'success', actorId: ownerA.id, targetId: s.id });
      expect(ev[0].metadata).toMatchObject({ organizationId: w.orgSchool1, authority: 'owner', wasAdmin: false });
      expect(JSON.stringify(ev) + t.logger.lines.join('\n')).not.toMatch(/member password 1|ABCDE/);
      expect((await t.db.query(`SELECT "isActive" FROM "user" WHERE id=$1`, [s.id])).rows[0].isActive).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------ concurrency
  describe('concurrency: state changes racing each other and in-flight requests', () => {
    it('8 simultaneous revocations of one membership: exactly one wins, seven get 409, one audit event', async () => {
      const s = await student();
      const mid = (await memberships(s.id))[0].id;
      const res = await Promise.all(Array.from({ length: 8 }, () => decide(ownerA.tokens, w.orgSchool1, mid, 'revoke')));
      expect(statuses(res)).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
      expect((await t.db.query(`SELECT count(*)::int n FROM auth_audit_event WHERE type='membership.revoked' AND "targetId"=$1`, [s.id])).rows[0].n).toBe(1);
    });

    it('a membership revoked WHILE the member\'s requests are in flight: no server error, and every request after the commit is refused', async () => {
      const s = await student();
      const mid = (await memberships(s.id))[0].id;
      const burst = await Promise.all([
        ...Array.from({ length: 6 }, () => reach(s.tokens, w.orgSchool1)),
        decide(ownerA.tokens, w.orgSchool1, mid, 'revoke'),
        ...Array.from({ length: 6 }, () => reach(s.tokens, w.orgSchool1)),
      ]);
      expect(burst.filter((r) => r.status >= 500)).toEqual([]);
      for (const r of burst.filter((_, i) => i !== 6)) expect([204, 404]).toContain(r.status); // before the commit or after it
      expect((await memberships(s.id))[0].status).toBe('revoked');
      await reach(s.tokens, w.orgSchool1).expect(404); // deterministic once committed
    });

    it('an organization admin acting WHILE being revoked: no server error and a consistent final state', async () => {
      const admin = await student();
      await t.db.query(`UPDATE organization_membership SET "isOrganizationAdmin"=true WHERE "userId"=$1`, [admin.id]);
      const mid = (await memberships(admin.id))[0].id;
      const res = await Promise.all([
        ...Array.from({ length: 6 }, () => t.http.get(`/auth/organizations/${w.orgSchool1}/memberships`).set(bearer(admin.tokens))),
        decide(ownerA.tokens, w.orgSchool1, mid, 'revoke'),
      ]);
      expect(res.filter((r) => r.status >= 500)).toEqual([]);
      expect((await memberships(admin.id))[0]).toMatchObject({ status: 'revoked', isOrganizationAdmin: false });
      await t.http.get(`/auth/organizations/${w.orgSchool1}/memberships`).set(bearer(admin.tokens)).expect(404);
    });

    it('granting and revoking the organization-management capability at the same time leaves one consistent state and a matching audit', async () => {
      for (let i = 0; i < 3; i++) {
        const s = await student();
        const mid = (await memberships(s.id))[0].id;
        const g = await t.stepUpToken(ownerA.tokens, 'organization.admin.grant', ownerA.totpSecret);
        const r = await t.stepUpToken(ownerA.tokens, 'organization.admin.revoke', ownerA.totpSecret);
        const [grant, revoke] = await Promise.all([
          t.http.post(`/auth/organizations/${w.orgSchool1}/memberships/${mid}/admin`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', g),
          t.http.delete(`/auth/organizations/${w.orgSchool1}/memberships/${mid}/admin`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', r),
        ]);
        expect([grant.status, revoke.status].filter((c) => c >= 500)).toEqual([]);
        const flag = (await memberships(s.id))[0].isOrganizationAdmin;
        // the two possible serial orders: revoke(404, nothing to revoke) then grant -> true; grant then revoke (both 204) -> false
        if (grant.status === 204 && revoke.status === 204) expect(flag).toBe(false);
        else expect([grant.status, revoke.status]).toEqual([204, 404]);
        if (grant.status === 204 && revoke.status === 404) expect(flag).toBe(true);
        const events = (await t.db.query(`SELECT type FROM auth_audit_event WHERE "targetId"=$1 AND type LIKE 'organization.admin.%' ORDER BY "occurredAt"`, [s.id])).rows.map((x) => x.type);
        expect(events.length).toBe([grant.status, revoke.status].filter((c) => c === 204).length); // one audit event per effective change
      }
    });

    it('an operator assignment revoked WHILE the operator acts: no server error, and access is gone once the revoke is committed', async () => {
      const opEmail = `op${uniq()}@a.test`;
      const op = await t.operator(w.companyA, opEmail);
      await t.assign(op.id, w.platformDrive, ownerA.id, w.companyA);
      const tokens = await t.operatorLogin(opEmail);
      await t.http.get(`/auth/platform-access/${w.platformDrive}`).set(bearer(tokens)).expect(200);
      const su = await t.stepUpToken(ownerA.tokens, 'platform_assignment.revoke', ownerA.totpSecret);
      const res = await Promise.all([
        ...Array.from({ length: 6 }, () => t.http.get(`/auth/platform-access/${w.platformDrive}`).set(bearer(tokens))),
        t.http.delete(`/auth/admin/operators/${op.id}/platform-assignments/${w.platformDrive}`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su),
        ...Array.from({ length: 6 }, () => t.http.get(`/auth/platform-access/${w.platformDrive}`).set(bearer(tokens))),
      ]);
      expect(res.filter((r) => r.status >= 500)).toEqual([]);
      expect(res[6].status).toBe(204);
      for (const r of res.filter((_, i) => i !== 6)) expect([200, 404]).toContain(r.status);
      await t.http.get(`/auth/platform-access/${w.platformDrive}`).set(bearer(tokens)).expect(404);
      expect((await t.db.query(`SELECT count(*)::int n FROM platform_assignment WHERE "operatorId"=$1 AND active`, [op.id])).rows[0].n).toBe(0);
    });
  });
});
