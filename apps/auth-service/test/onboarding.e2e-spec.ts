import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);
const statuses = (res: Array<{ status: number }>) => res.map((r) => r.status).sort((a, b) => a - b);

describe('organization join codes, smart registration and membership approval', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let ownerA: Awaited<ReturnType<TestCtx['readyOwner']>>; // company A (the database allows ONE owner per company)
  let ownerB: Awaited<ReturnType<TestCtx['readyOwner']>>; // company B

  // Listen once: parallel supertest bursts otherwise fail with ECONNRESET in the harness.
  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0);
    w = await t.world();
    t.payment.licensed.add(w.orgSchool1);
    t.payment.licensed.add(w.orgSchool2);
    await t.db.query(`UPDATE platform SET key='nawara-drive' WHERE id=$1`, [w.platformSchool]);
    ownerA = await t.readyOwner(w.companyA, `ownera${uniq()}@a.test`);
    ownerB = await t.readyOwner(w.companyB, `ownerb${uniq()}@b.test`);
  });
  afterAll(() => t.close());

  const register = (joinCode: string, over: Record<string, unknown> = {}) =>
    t.http.post('/auth/register').send({ email: `u${uniq()}@a.test`, password: 'member password 1', joinCode, ...over });
  const resolve = (joinCode: string) => t.http.post('/auth/onboarding/resolve').send({ joinCode });
  const membershipOf = async (userId: string) =>
    (await t.db.query(`SELECT id, status, "approvedBy", "rejectedBy", "isOrganizationAdmin" FROM organization_membership WHERE "userId"=$1`, [userId])).rows[0];
  const reach = (tokens: unknown, org: string) => t.http.get(`/auth/organizations/${org}/membership`).set(bearer(tokens as any));
  const approve = (tokens: unknown, org: string, id: string) => t.http.post(`/auth/organizations/${org}/memberships/${id}/approve`).set(bearer(tokens as any));
  const reject = (tokens: unknown, org: string, id: string) => t.http.post(`/auth/organizations/${org}/memberships/${id}/reject`).set(bearer(tokens as any));

  /** A teacher who registered through an approval-required code and is waiting. */
  async function pendingTeacher(org = w.orgSchool1) {
    const c = await t.joinCode(org, { audience: 'teacher', requiresApproval: true, requiresSubscription: false });
    const email = `teacher${uniq()}@a.test`;
    const r = await register(c.code, { email }).expect(201);
    const id = (await t.db.query(`SELECT id FROM "user" WHERE email=$1`, [email])).rows[0].id as string;
    return { id, email, tokens: r.body, membershipId: (await membershipOf(id)).id as string };
  }

  // ------------------------------------------------------------------------------ resolution
  describe('resolving a join code', () => {
    it('returns the context the SERVER derived (platform, organization, audience, hints) and nothing else', async () => {
      const student = await t.joinCode(w.orgSchool1, { audience: 'student', requiresApproval: false, requiresSubscription: true });
      const teacher = await t.joinCode(w.orgSchool1, { audience: 'teacher', requiresApproval: true, requiresSubscription: false });
      const s = (await resolve(student.code).expect(200)).body;
      expect(s).toEqual({
        platform: { id: w.platformSchool, key: 'nawara-drive', name: 'School' },
        organization: { id: w.orgSchool1, name: 'School 1' },
        audience: 'student', requiresSubscription: true, requiresOrganizationApproval: false, requiresVerification: false,
      });
      expect((await resolve(teacher.code).expect(200)).body).toMatchObject({ audience: 'teacher', requiresSubscription: false, requiresOrganizationApproval: true });
      expect(JSON.stringify(s)).not.toMatch(/codeHash|usedCount|maxUses|createdBy|companyId/);
    });

    it('accepts the code case-insensitively, without hyphens, and with any cosmetic prefix', async () => {
      const c = await t.joinCode(w.orgSchool1);
      for (const form of [c.code.toLowerCase(), c.code.replace(/-/g, ' '), c.normalized, `XX-${c.normalized}`]) await resolve(form).expect(200);
    });

    it('cannot be steered by the client: extra properties are rejected', async () => {
      const c = await t.joinCode(w.orgSchool1);
      for (const extra of [{ organizationId: w.orgSchool2 }, { platformId: w.platformDrive }, { audience: 'teacher' }]) {
        await t.http.post('/auth/onboarding/resolve').send({ joinCode: c.code, ...extra }).expect(400);
      }
    });

    it('unknown, malformed, expired, revoked, inactive and exhausted codes are ONE indistinguishable 404, audited internally', async () => {
      const revoked = await t.joinCode(w.orgSchool1);
      await t.db.query(`UPDATE organization_join_code SET "isActive"=false, "revokedAt"=now(), "revokedBy"="createdBy" WHERE id=$1`, [revoked.id]);
      const inactive = await t.joinCode(w.orgSchool1);
      await t.db.query(`UPDATE organization_join_code SET "isActive"=false WHERE id=$1`, [inactive.id]);
      const exhausted = await t.joinCode(w.orgSchool1, { maxUses: 1 });
      await t.db.query(`UPDATE organization_join_code SET "usedCount"=1 WHERE id=$1`, [exhausted.id]);
      const expiring = await t.joinCode(w.orgSchool1, { expiresInDays: 1 });
      t.clock.advance(2 * 86_400_000); // expiry is evaluated against the service clock
      const res = [
        await resolve('ABCDE-FGHJK'), await resolve('this is not a join code!'), await resolve(revoked.code),
        await resolve(inactive.code), await resolve(exhausted.code), await resolve(expiring.code),
      ];
      for (const r of res) expect(r.status).toBe(404);
      for (const r of res.slice(1)) expect(r.body).toEqual(res[0].body);
      const audit = await t.db.query(`SELECT metadata->>'reason' AS reason FROM auth_audit_event WHERE type='onboarding.join_code.resolve_failed'`);
      expect(audit.rows.map((r) => r.reason)).toEqual(expect.arrayContaining(['unknown', 'malformed', 'revoked', 'inactive', 'exhausted', 'expired']));
      t.clock.advance(-2 * 86_400_000);
    });

    it('is rate limited per IP and by a global brake, so the code space cannot be enumerated', async () => {
      const ip = await createTestApp({ RATE_JOIN_CODE_RESOLVE_IP_LIMIT: '5' });
      const glob = await createTestApp({ RATE_JOIN_CODE_RESOLVE_GLOBAL_LIMIT: '3' });
      try {
        const a: number[] = [];
        for (let i = 0; i < 8; i++) a.push((await ip.http.post('/auth/onboarding/resolve').send({ joinCode: 'ABCDE-FGHJK' })).status);
        expect(a.filter((s) => s === 404)).toHaveLength(5);
        expect(a.filter((s) => s === 429)).toHaveLength(3);
        const g: number[] = [];
        for (let i = 0; i < 6; i++) g.push((await glob.http.post('/auth/onboarding/resolve').set('X-Forwarded-For', `10.0.0.${i}`).send({ joinCode: 'ABCDE-FGHJK' })).status);
        expect(g.filter((s) => s === 429).length).toBeGreaterThan(0); // spreading over "IPs" does not evade the global brake
      } finally {
        await ip.close();
        await glob.close();
      }
    });

    it('stores only an HMAC: the plaintext code appears nowhere in the database', async () => {
      const c = await t.joinCode(w.orgSchool1);
      const row = (await t.db.query(`SELECT "codeHash" FROM organization_join_code WHERE id=$1`, [c.id])).rows[0];
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      const dump = JSON.stringify((await t.db.query(`SELECT * FROM organization_join_code`)).rows);
      expect(dump).not.toContain(c.normalized);
    });
  });

  // ------------------------------------------------------------------------------ student flow
  describe('student: join code -> registration -> payment-required context', () => {
    it('creates a kind=member with an ACTIVE membership, a payment-required hint, and NO teacher/approval state', async () => {
      const c = await t.joinCode(w.orgSchool1, { audience: 'student', requiresApproval: false, requiresSubscription: true });
      const email = `student${uniq()}@a.test`;
      const r = await register(c.code, { email }).expect(201);
      expect(r.body.onboarding).toMatchObject({ audience: 'student', membershipStatus: 'active', requiresSubscription: true });
      const u = (await t.db.query(`SELECT id, kind, role, "organizationId", "isActive" FROM "user" WHERE email=$1`, [email])).rows[0];
      expect(u).toMatchObject({ kind: 'member', role: 'student', organizationId: w.orgSchool1, isActive: true });
      const m = await membershipOf(u.id);
      expect(m).toMatchObject({ status: 'active', approvedBy: null, rejectedBy: null });
      const pending = await t.db.query(`SELECT count(*)::int n FROM organization_membership WHERE "userId"=$1 AND status<>'active'`, [u.id]);
      expect(pending.rows[0].n).toBe(0);
      await reach(r.body, w.orgSchool1).expect(204); // admitted
      // auth stores no subscription: entitlement is payment-service's (asked once, at registration)
      expect(t.payment.calls.at(-1)).toBe(w.orgSchool1);
    });

    it('a student code that the client tries to relabel as teacher stays a student', async () => {
      const c = await t.joinCode(w.orgSchool1, { audience: 'student' });
      const email = `s${uniq()}@a.test`;
      await register(c.code, { email, audience: 'teacher' }).expect(400);
      await register(c.code, { email }).expect(201);
      expect((await t.db.query(`SELECT role FROM "user" WHERE email=$1`, [email])).rows[0].role).toBe('student');
    });

    it('an organization-A code cannot be pointed at organization B or platform B', async () => {
      const c = await t.joinCode(w.orgSchool1);
      const email = `x${uniq()}@a.test`;
      await register(c.code, { email, organizationId: w.orgSchool2 }).expect(400);
      await register(c.code, { email, platformId: w.platformDrive }).expect(400);
      await register(c.code, { email }).expect(201);
      expect((await t.db.query(`SELECT "organizationId" FROM "user" WHERE email=$1`, [email])).rows[0].organizationId).toBe(w.orgSchool1);
    });
  });

  // ------------------------------------------------------------------------------ teacher flow
  describe('teacher: join code -> registration -> pending -> organization approval -> active', () => {
    it('registers a member whose membership is PENDING: authenticated, but not admitted, and no subscription', async () => {
      const t1 = await pendingTeacher();
      const m = await membershipOf(t1.id);
      expect(m.status).toBe('pending');
      const u = (await t.db.query(`SELECT kind, "isActive", role FROM "user" WHERE id=$1`, [t1.id])).rows[0];
      expect(u).toEqual({ kind: 'member', isActive: true, role: 'teacher' }); // account valid; membership pending: different things
      await t.http.get('/auth/me').set(bearer(t1.tokens)).expect(200); // can authenticate
      const me = (await t.http.get('/auth/me').set(bearer(t1.tokens))).body;
      expect(me.membership).toMatchObject({ organizationId: w.orgSchool1, status: 'pending' }); // the app can show "waiting for approval"
      await reach(t1.tokens, w.orgSchool1).expect(404); // no organization access
      // and no organization-admin surface either
      await t.http.get(`/auth/organizations/${w.orgSchool1}/memberships`).set(bearer(t1.tokens)).expect(404);
      expect(t.bus.last('membership.requested')).toMatchObject({ userId: t1.id, organizationId: w.orgSchool1, audience: 'teacher' });
    });

    it('an authorized decision flips access on the very next request with the SAME token', async () => {
      const t1 = await pendingTeacher();
      await reach(t1.tokens, w.orgSchool1).expect(404);
      const r = await approve(ownerA.tokens, w.orgSchool1, t1.membershipId).expect(200);
      expect(r.body).toEqual({ id: t1.membershipId, status: 'active' });
      await reach(t1.tokens, w.orgSchool1).expect(204); // stale-token safe: decided from current rows
      expect(await membershipOf(t1.id)).toMatchObject({ status: 'active', approvedBy: ownerA.id });
      expect(t.bus.last('membership.approved')).toMatchObject({ userId: t1.id, organizationId: w.orgSchool1 });
    });

    it('a rejected teacher never gains access and cannot be reversed', async () => {
      const t1 = await pendingTeacher();
      await reject(ownerA.tokens, w.orgSchool1, t1.membershipId).expect(200);
      expect(await membershipOf(t1.id)).toMatchObject({ status: 'rejected', rejectedBy: ownerA.id });
      await reach(t1.tokens, w.orgSchool1).expect(404);
      await approve(ownerA.tokens, w.orgSchool1, t1.membershipId).expect(409); // rejected -> active is illegal
      await reach(t1.tokens, w.orgSchool1).expect(404);
    });

    it('lists pending requests (with the contact needed to review them) for an authorized administrator only', async () => {
      const t1 = await pendingTeacher();
      const list = (await t.http.get(`/auth/organizations/${w.orgSchool1}/memberships?status=pending`).set(bearer(ownerA.tokens)).expect(200)).body;
      expect(list.find((m: any) => m.id === t1.membershipId)).toMatchObject({ userId: t1.id, audience: 'teacher', status: 'pending' });
      await t.http.get(`/auth/organizations/${w.orgSchool1}/memberships?status=bogus`).set(bearer(ownerA.tokens)).expect(400);
    });
  });

  // ------------------------------------------------------------------------------ authorization
  describe('who may decide, and only inside their own organization', () => {
    it('a plain member, a pending member and a member of ANOTHER organization cannot approve (collapsed 404)', async () => {
      const target = await pendingTeacher(w.orgSchool1);
      const plain = await t.member(w.orgSchool1, `plain${uniq()}@a.test`);
      const plainTokens = (await t.http.post('/auth/login').send({ email: plain.email, password: plain.password })).body;
      const other = await t.member(w.orgSchool2, `other${uniq()}@a.test`);
      const otherTokens = (await t.http.post('/auth/login').send({ email: other.email, password: other.password })).body;
      for (const tokens of [plainTokens, otherTokens, target.tokens]) {
        await approve(tokens, w.orgSchool1, target.membershipId).expect(404);
        await reject(tokens, w.orgSchool1, target.membershipId).expect(404);
      }
      expect((await membershipOf(target.id)).status).toBe('pending');
    });

    it('a membership id from another organization is indistinguishable from a missing one', async () => {
      const inOrg2 = await pendingTeacher(w.orgSchool2);
      const foreign = await approve(ownerA.tokens, w.orgSchool1, inOrg2.membershipId); // right owner, wrong organization in the URL
      const missing = await approve(ownerA.tokens, w.orgSchool1, '00000000-0000-4000-8000-00000000dead');
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      expect((await membershipOf(inOrg2.id)).status).toBe('pending');
    });

    it('an owner of ANOTHER company and an unassigned operator are refused; an assigned operator may decide', async () => {
      const target = await pendingTeacher();
      await approve(ownerB.tokens, w.orgSchool1, target.membershipId).expect(404); // other company
      const opEmail = `op${uniq()}@a.test`;
      const op = await t.operator(w.companyA, opEmail);
      const opTokens = await t.operatorLogin(opEmail);
      await approve(opTokens, w.orgSchool1, target.membershipId).expect(404); // no PlatformAssignment yet
      await t.assign(op.id, w.platformSchool, ownerA.id, w.companyA);
      await approve(opTokens, w.orgSchool1, target.membershipId).expect(200);
      expect(await membershipOf(target.id)).toMatchObject({ status: 'active', approvedBy: op.id });
    });

    it('a duplicate decision is a clean 409 and changes nothing', async () => {
      const target = await pendingTeacher();
      await approve(ownerA.tokens, w.orgSchool1, target.membershipId).expect(200);
      await approve(ownerA.tokens, w.orgSchool1, target.membershipId).expect(409);
      await reject(ownerA.tokens, w.orgSchool1, target.membershipId).expect(409);
      expect((await membershipOf(target.id)).status).toBe('active');
    });
  });

  // ------------------------------------------------------------------------------ org admin
  describe('organization administrators (an Auth-owned access scope, granted by an Owner with step-up)', () => {
    async function activeMember(org = w.orgSchool1) {
      const m = await t.member(org, `am${uniq()}@a.test`);
      const tokens = (await t.http.post('/auth/login').send({ email: m.email, password: m.password })).body;
      return { ...m, tokens, membershipId: (await membershipOf(m.id)).id as string };
    }
    const grant = async (memberId: string, org = w.orgSchool1) => {
      const su = await t.stepUpToken(ownerA.tokens, 'organization.admin.grant', ownerA.totpSecret);
      return t.http.post(`/auth/organizations/${org}/memberships/${memberId}/admin`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su);
    };

    it('granting needs an Owner AND a fresh step-up; the flag can only sit on an ACTIVE membership', async () => {
      const a = await activeMember();
      await t.http.post(`/auth/organizations/${w.orgSchool1}/memberships/${a.membershipId}/admin`).set(bearer(ownerA.tokens)).expect(403); // no step-up
      expect((await membershipOf(a.id)).isOrganizationAdmin).toBe(false);
      expect((await grant(a.membershipId)).status).toBe(204);
      expect((await membershipOf(a.id)).isOrganizationAdmin).toBe(true);
      const pending = await pendingTeacher();
      const su = await t.stepUpToken(ownerA.tokens, 'organization.admin.grant', ownerA.totpSecret);
      await t.http.post(`/auth/organizations/${w.orgSchool1}/memberships/${pending.membershipId}/admin`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su).expect(404);
      await t.db.query(`UPDATE organization_membership SET "isOrganizationAdmin"=true WHERE id=$1`, [pending.membershipId]).then(
        () => { throw new Error('a pending member must not be admin'); }, (e) => expect(e.code).toBe('23514'));
    });

    it('an organization admin can review and decide for THEIR organization, and nobody else’s', async () => {
      const admin = await activeMember(w.orgSchool1);
      expect((await grant(admin.membershipId)).status).toBe(204);
      const mine = await pendingTeacher(w.orgSchool1);
      const foreign = await pendingTeacher(w.orgSchool2);
      const list = (await t.http.get(`/auth/organizations/${w.orgSchool1}/memberships`).set(bearer(admin.tokens)).expect(200)).body;
      expect(list.map((m: any) => m.id)).toContain(mine.membershipId);
      await approve(admin.tokens, w.orgSchool1, mine.membershipId).expect(200);
      expect(await membershipOf(mine.id)).toMatchObject({ status: 'active', approvedBy: admin.id });
      await approve(admin.tokens, w.orgSchool2, foreign.membershipId).expect(404); // same platform, other organization
      await t.http.get(`/auth/organizations/${w.orgSchool2}/memberships`).set(bearer(admin.tokens)).expect(404);
    });

    it('an organization admin cannot mint other admins, and cannot approve their own membership', async () => {
      const admin = await activeMember();
      expect((await grant(admin.membershipId)).status).toBe(204);
      const peer = await activeMember();
      await t.http.post(`/auth/organizations/${w.orgSchool1}/memberships/${peer.membershipId}/admin`).set(bearer(admin.tokens)).expect(403); // owners only
      await approve(admin.tokens, w.orgSchool1, admin.membershipId).expect(404); // nobody decides their own membership
      expect((await membershipOf(peer.id)).isOrganizationAdmin).toBe(false);
    });

    it('revoking the flag removes the authority on the next request, with the same token', async () => {
      const admin = await activeMember();
      expect((await grant(admin.membershipId)).status).toBe(204);
      await t.http.get(`/auth/organizations/${w.orgSchool1}/memberships`).set(bearer(admin.tokens)).expect(200);
      const su = await t.stepUpToken(ownerA.tokens, 'organization.admin.revoke', ownerA.totpSecret);
      await t.http.delete(`/auth/organizations/${w.orgSchool1}/memberships/${admin.membershipId}/admin`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su).expect(204);
      await t.http.get(`/auth/organizations/${w.orgSchool1}/memberships`).set(bearer(admin.tokens)).expect(404);
    });

    it('a disabled organization admin loses authority immediately', async () => {
      const admin = await activeMember();
      expect((await grant(admin.membershipId)).status).toBe(204);
      await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [admin.id]);
      await t.http.get(`/auth/organizations/${w.orgSchool1}/memberships`).set(bearer(admin.tokens)).expect(401);
    });
  });

  // ------------------------------------------------------------------------------ join-code admin
  describe('creating and revoking join codes', () => {
    const create = (tokens: unknown, org: string, body: Record<string, unknown>, su?: string) => {
      const r = t.http.post(`/auth/organizations/${org}/join-codes`).set(bearer(tokens as any));
      return (su ? r.set('X-Step-Up-Token', su) : r).send(body);
    };
    const body = { audience: 'teacher', requiresApproval: true, requiresSubscription: false, maxUses: 5 };

    it('an Owner creates a code with a step-up; the plaintext is returned once and works end to end', async () => {
      await create(ownerA.tokens, w.orgSchool1, body).expect(403); // owners need a step-up
      const su = await t.stepUpToken(ownerA.tokens, 'join_code.create', ownerA.totpSecret);
      const r = await create(ownerA.tokens, w.orgSchool1, body, su).expect(201);
      expect(r.body.code).toMatch(/^NAWARA-DRIVE-|^[0-9A-Z-]{11,}$/i);
      expect(r.body).toMatchObject({ audience: 'teacher', requiresApproval: true, maxUses: 5, usedCount: 0 });
      expect(new Date(r.body.expiresAt).getTime()).toBeGreaterThan(t.clock.now().getTime()); // never permanent
      await resolve(r.body.code).expect(200);
      const listed = (await t.http.get(`/auth/organizations/${w.orgSchool1}/join-codes`).set(bearer(ownerA.tokens)).expect(200)).body;
      expect(JSON.stringify(listed)).not.toContain(r.body.code); // the plaintext is not recoverable
      expect(t.logger.lines.join('\n')).not.toContain(r.body.code);
      const audit = await t.db.query(`SELECT metadata FROM auth_audit_event WHERE type='onboarding.join_code.created' AND "targetId"=$1`, [r.body.id]);
      expect(JSON.stringify(audit.rows)).not.toContain(r.body.code);
    });

    it('cannot create a code for another company’s organization, or with unsafe parameters', async () => {
      const su = await t.stepUpToken(ownerB.tokens, 'join_code.create', ownerB.totpSecret);
      await create(ownerB.tokens, w.orgSchool1, body, su).expect(404); // organization of another company
      const su2 = await t.stepUpToken(ownerA.tokens, 'join_code.create', ownerA.totpSecret);
      await create(ownerA.tokens, w.orgSchool1, { ...body, audience: 'Not Valid!' }, su2).expect(400);
      await create(ownerA.tokens, w.orgSchool1, { ...body, audience: 'admin' }, su2).expect(400); // reserved: could never be redeemed
      await create(ownerA.tokens, w.orgSchool1, { ...body, expiresInDays: 4000 }, su2).expect(400);
      await create(ownerA.tokens, w.orgSchool1, { ...body, organizationId: w.orgSchool2, platformId: w.platformDrive }, su2).expect(400);
    });

    it('revoking a code is final: it stops resolving and registering at once', async () => {
      const c = await t.joinCode(w.orgSchool1);
      await resolve(c.code).expect(200);
      const su = await t.stepUpToken(ownerA.tokens, 'join_code.revoke', ownerA.totpSecret);
      await t.http.post(`/auth/organizations/${w.orgSchool1}/join-codes/${c.id}/revoke`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su).expect(204);
      await resolve(c.code).expect(404);
      await register(c.code).expect(403);
      const su2 = await t.stepUpToken(ownerA.tokens, 'join_code.revoke', ownerA.totpSecret);
      await t.http.post(`/auth/organizations/${w.orgSchool1}/join-codes/${c.id}/revoke`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su2).expect(404); // already revoked
      await t.db.query(`UPDATE organization_join_code SET "isActive"=true, "revokedAt"=NULL, "revokedBy"=NULL WHERE id=$1`, [c.id]).then(
        () => { throw new Error('a revoked code must not be revivable'); }, (e) => expect(e.code).toBe('23514'));
    });

    it('a plain member cannot create or revoke codes', async () => {
      const m = await t.member(w.orgSchool1, `plain${uniq()}@a.test`);
      const tokens = (await t.http.post('/auth/login').send({ email: m.email, password: m.password })).body;
      await create(tokens, w.orgSchool1, body).expect(404);
    });
  });

  // ------------------------------------------------------------------------------ concurrency
  describe('concurrency: two simultaneous requests can never create a contradictory state', () => {
    it('8 simultaneous registrations on a code with maxUses=3 create exactly 3 members', async () => {
      const c = await t.joinCode(w.orgSchool1, { maxUses: 3 });
      const res = await Promise.all(Array.from({ length: 8 }, () => register(c.code)));
      expect(statuses(res)).toEqual([201, 201, 201, 403, 403, 403, 403, 403]);
      const row = (await t.db.query(`SELECT "usedCount" FROM organization_join_code WHERE id=$1`, [c.id])).rows[0];
      expect(row.usedCount).toBe(3);
      const made = await t.db.query(`SELECT count(*)::int n FROM organization_membership WHERE "joinCodeId"=$1`, [c.id]);
      expect(made.rows[0].n).toBe(3);
    });

    it('a code revoked while registrations race: every spent use has exactly one membership, and no server error', async () => {
      const c = await t.joinCode(w.orgSchool1);
      const su = await t.stepUpToken(ownerA.tokens, 'join_code.revoke', ownerA.totpSecret);
      const res = await Promise.all([
        ...Array.from({ length: 6 }, () => register(c.code)),
        t.http.post(`/auth/organizations/${w.orgSchool1}/join-codes/${c.id}/revoke`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su),
      ]);
      expect(res.filter((r) => r.status >= 500).map((r) => r.status)).toEqual([]);
      const used = (await t.db.query(`SELECT "usedCount" FROM organization_join_code WHERE id=$1`, [c.id])).rows[0].usedCount;
      const members = (await t.db.query(`SELECT count(*)::int n FROM organization_membership WHERE "joinCodeId"=$1`, [c.id])).rows[0].n;
      expect(members).toBe(used);
      await register(c.code).expect(403); // after the revoke committed, nothing gets through
    });

    it('simultaneous approve and reject of one request leave exactly one consistent final state', async () => {
      for (let i = 0; i < 4; i++) {
        const target = await pendingTeacher();
        const res = await Promise.all([approve(ownerA.tokens, w.orgSchool1, target.membershipId), reject(ownerA.tokens, w.orgSchool1, target.membershipId)]);
        expect(statuses(res)).toEqual([200, 409]);
        const m = await t.db.query(`SELECT status, "approvedAt", "approvedBy", "rejectedAt", "rejectedBy" FROM organization_membership WHERE id=$1`, [target.membershipId]);
        const r = m.rows[0];
        if (r.status === 'active') expect(r).toMatchObject({ rejectedAt: null, rejectedBy: null }); else expect(r).toMatchObject({ approvedAt: null, approvedBy: null });
        expect(r.status === 'active' ? r.approvedBy : r.rejectedBy).toBe(ownerA.id);
      }
    });

    it('10 simultaneous approvals of one request: one 200, nine 409, one audit event', async () => {
      const target = await pendingTeacher();
      const res = await Promise.all(Array.from({ length: 10 }, () => approve(ownerA.tokens, w.orgSchool1, target.membershipId)));
      expect(statuses(res)).toEqual([200, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
      const a = await t.db.query(`SELECT count(*)::int n FROM auth_audit_event WHERE type='membership.approved' AND "targetId"=$1`, [target.id]);
      expect(a.rows[0].n).toBe(1);
    });

    it('the same person registering twice at once creates one account and one membership', async () => {
      const c = await t.joinCode(w.orgSchool1);
      const email = `twin${uniq()}@a.test`;
      const res = await Promise.all(Array.from({ length: 4 }, () => register(c.code, { email })));
      expect(statuses(res)).toEqual([201, 409, 409, 409]);
      const n = await t.db.query(`SELECT count(*)::int n FROM organization_membership m JOIN "user" u ON u.id=m."userId" WHERE u.email=$1`, [email]);
      expect(n.rows[0].n).toBe(1);
      expect((await t.db.query(`SELECT "usedCount" FROM organization_join_code WHERE id=$1`, [c.id])).rows[0].usedCount).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------ audit
  describe('audit trail', () => {
    it('records who did what to which organization, without any secret', async () => {
      const c = await t.joinCode(w.orgSchool1, { audience: 'teacher', requiresApproval: true });
      const email = `aud${uniq()}@a.test`;
      await register(c.code, { email }).expect(201);
      const uid = (await t.db.query(`SELECT id FROM "user" WHERE email=$1`, [email])).rows[0].id;
      const mid = (await membershipOf(uid)).id;
      await approve(ownerA.tokens, w.orgSchool1, mid).expect(200);
      const ev = await t.db.query(`SELECT type, outcome, "actorId", "targetId", metadata FROM auth_audit_event WHERE type IN ('onboarding.join_code.used','membership.requested','membership.approved') AND ("actorId"=$1 OR "targetId"=$1)`, [uid]);
      expect(ev.rows.map((r) => r.type).sort()).toEqual(['membership.approved', 'membership.requested', 'onboarding.join_code.used'].sort());
      const approved = ev.rows.find((r) => r.type === 'membership.approved');
      expect(approved).toMatchObject({ actorId: ownerA.id, targetId: uid, outcome: 'success' });
      expect(approved.metadata).toMatchObject({ organizationId: w.orgSchool1, authority: 'owner' });
      const dump = JSON.stringify(ev.rows) + t.logger.lines.join('\n');
      expect(dump).not.toContain(c.code);
      expect(dump).not.toContain(c.normalized);
      expect(dump).not.toContain('member password 1');
    });
  });
});

// ------------------------------------------------------------------------------ contact verification
describe('member contact verification (behind REQUIRE_CONTACT_VERIFICATION)', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let owner: Awaited<ReturnType<TestCtx['readyOwner']>>;
  beforeAll(async () => {
    t = await createTestApp({ REQUIRE_CONTACT_VERIFICATION: 'true' });
    await t.app.listen(0);
    w = await t.world();
    t.payment.licensed.add(w.orgSchool1);
    owner = await t.readyOwner(w.companyA, `owner${uniq()}@a.test`);
  });
  afterAll(() => t.close());

  async function newMember(approval = false) {
    const c = await t.joinCode(w.orgSchool1, { audience: approval ? 'teacher' : 'student', requiresApproval: approval });
    const email = `v${uniq()}@a.test`;
    const r = await t.http.post('/auth/register').send({ email, password: 'member password 1', joinCode: c.code }).expect(201);
    const id = (await t.db.query(`SELECT id FROM "user" WHERE email=$1`, [email])).rows[0].id as string;
    return { id, email, tokens: r.body, body: r.body };
  }
  const reach = (tokens: unknown) => t.http.get(`/auth/organizations/${w.orgSchool1}/membership`).set(bearer(tokens as any));

  it('an unverified member is authenticated but not admitted, until the delivered code is verified', async () => {
    const m = await newMember(false);
    expect(m.body.onboarding.contactVerificationRequired).toBe(true);
    await reach(m.tokens).expect(404);
    expect((await t.http.get('/auth/me').set(bearer(m.tokens))).body.membership).toMatchObject({ status: 'active', contactVerified: false, contactVerificationRequired: true });
    await t.http.post('/auth/contact/request-code').set(bearer(m.tokens)).expect(204);
    const ev = t.bus.last('member.contact_verification_requested');
    expect(ev).toMatchObject({ userId: m.id, channel: 'email', destination: m.email });
    expect(ev.code).toMatch(/^\d{6}$/);
    await t.http.post('/auth/contact/verify').set(bearer(m.tokens)).send({ code: ev.code }).expect(204);
    await reach(m.tokens).expect(204); // same token, admitted now
    const stored = await t.db.query(`SELECT "codeHash", "consumedAt" FROM member_contact_verification WHERE "userId"=$1`, [m.id]);
    expect(stored.rows[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].consumedAt).not.toBeNull();
    expect(JSON.stringify((await t.db.query(`SELECT metadata FROM auth_audit_event WHERE "actorId"=$1`, [m.id])).rows) + t.logger.lines.join('\n')).not.toContain(ev.code);
    await t.http.post('/auth/contact/verify').set(bearer(m.tokens)).send({ code: ev.code }).expect(400); // single use
  });

  it('five wrong guesses lock the code even against the right one; a new request supersedes it', async () => {
    const m = await newMember(false);
    await t.http.post('/auth/contact/request-code').set(bearer(m.tokens)).expect(204);
    const good = t.bus.last('member.contact_verification_requested').code as string;
    const wrong = String((Number(good) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 5; i++) await t.http.post('/auth/contact/verify').set(bearer(m.tokens)).send({ code: wrong }).expect(400);
    await t.http.post('/auth/contact/verify').set(bearer(m.tokens)).send({ code: good }).expect(400);
    await t.http.post('/auth/contact/request-code').set(bearer(m.tokens)).expect(204);
    const fresh = t.bus.last('member.contact_verification_requested').code as string;
    await t.http.post('/auth/contact/verify').set(bearer(m.tokens)).send({ code: fresh }).expect(204);
    const live = await t.db.query(`SELECT count(*)::int n FROM member_contact_verification WHERE "userId"=$1 AND "consumedAt" IS NULL AND "supersededAt" IS NULL`, [m.id]);
    expect(live.rows[0].n).toBe(0);
  });

  it('an unverified applicant cannot be approved; after verification the decision goes through', async () => {
    const m = await newMember(true);
    const mid = (await t.db.query(`SELECT id FROM organization_membership WHERE "userId"=$1`, [m.id])).rows[0].id;
    await t.http.post(`/auth/organizations/${w.orgSchool1}/memberships/${mid}/approve`).set(bearer(owner.tokens)).expect(409);
    await t.http.post('/auth/contact/request-code').set(bearer(m.tokens)).expect(204);
    await t.http.post('/auth/contact/verify').set(bearer(m.tokens)).send({ code: t.bus.last('member.contact_verification_requested').code }).expect(204);
    await t.http.post(`/auth/organizations/${w.orgSchool1}/memberships/${mid}/approve`).set(bearer(owner.tokens)).expect(200);
    await reach(m.tokens).expect(204);
  });

  it('requesting a code is idempotent for a verified member and never differs in answer', async () => {
    const m = await newMember(false);
    await t.http.post('/auth/contact/request-code').set(bearer(m.tokens)).expect(204);
    await t.http.post('/auth/contact/verify').set(bearer(m.tokens)).send({ code: t.bus.last('member.contact_verification_requested').code }).expect(204);
    const before = t.bus.all('member.contact_verification_requested').length;
    await t.http.post('/auth/contact/request-code').set(bearer(m.tokens)).expect(204);
    expect(t.bus.all('member.contact_verification_requested').length).toBe(before); // nothing sent
  });
});
