import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, noReqId, type TestCtx } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);

/**
 * Tenant isolation: an actor of Company A must not be able to read, change or even DETECT resources of
 * Company B. For every route that takes an organization, platform, membership, code, invitation, operator or
 * assignment, the response for a FOREIGN resource must be byte-identical to the response for a resource that
 * does not exist, must never be a success or a server error, and must leave Company B's data untouched.
 */
describe('tenant isolation: Company A actors against Company B resources', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  const A: Record<string, any> = {};
  const B: Record<string, any> = {};

  beforeAll(async () => {
    t = await createTestApp();
    w = await t.world(); // companyA: platformSchool/platformDrive/orgSchool1..; companyB: platformClinic/orgClinic

    // ---- Company A actors
    A.owner = await t.readyOwner(w.companyA, `ownera${uniq()}@a.test`);
    const opEmail = `opa${uniq()}@a.test`;
    A.operatorUser = await t.operator(w.companyA, opEmail);
    await t.assign(A.operatorUser.id, w.platformSchool, A.owner.id, w.companyA);
    A.operator = await t.operatorLogin(opEmail);
    const admin = await t.member(w.orgSchool1, `admina${uniq()}@a.test`);
    await t.db.query(`UPDATE organization_membership SET "isOrganizationAdmin"=true WHERE "userId"=$1`, [admin.id]);
    A.orgAdmin = (await t.http.post('/auth/login').send({ email: admin.email, password: admin.password })).body;
    const member = await t.member(w.orgSchool1, `membera${uniq()}@a.test`);
    A.member = (await t.http.post('/auth/login').send({ email: member.email, password: member.password })).body;

    // ---- Company B resources (and its owner, for the symmetric direction)
    B.owner = await t.readyOwner(w.companyB, `ownerb${uniq()}@b.test`);
    B.code = (await t.joinCode(w.orgClinic, { audience: 'staff', requiresApproval: true })).id;
    const su = await t.stepUpToken(B.owner.tokens, 'admin_invitation.create', B.owner.totpSecret);
    B.invitation = (await t.http.post(`/auth/organizations/${w.orgClinic}/admin-invitations`).set(bearer(B.owner.tokens)).set('X-Step-Up-Token', su).send({ invitationType: 'org_admin' }).expect(201)).body.id;
    const pend = await t.member(w.orgClinic, `pendb${uniq()}@b.test`, 'member password 1', 'staff', 'pending');
    B.membership = (await t.db.query(`SELECT id FROM organization_membership WHERE "userId"=$1`, [pend.id])).rows[0].id;
    B.operatorUser = await t.operator(w.companyB, `opb${uniq()}@b.test`);
    await t.assign(B.operatorUser.id, w.platformClinic, B.owner.id, w.companyB);
    // A's own resources, for the symmetric direction
    A.code = (await t.joinCode(w.orgSchool1, { audience: 'staff' })).id;
    const su2 = await t.stepUpToken(A.owner.tokens, 'admin_invitation.create', A.owner.totpSecret);
    A.invitation = (await t.http.post(`/auth/organizations/${w.orgSchool1}/admin-invitations`).set(bearer(A.owner.tokens)).set('X-Step-Up-Token', su2).send({ invitationType: 'org_admin' }).expect(201)).body.id;
    const pa = await t.member(w.orgSchool1, `penda${uniq()}@a.test`, 'member password 1', 'staff', 'pending');
    A.membership = (await t.db.query(`SELECT id FROM organization_membership WHERE "userId"=$1`, [pa.id])).rows[0].id;
  });
  afterAll(() => t.close());

  type Ids = { platform: string; org: string; code: string; invitation: string; membership: string; operator: string };
  const ghost = (): Ids => ({ platform: randomUUID(), org: randomUUID(), code: randomUUID(), invitation: randomUUID(), membership: randomUUID(), operator: randomUUID() });

  /** every route that names a tenant-owned resource */
  const CASES: Array<[string, (i: Ids) => { method: 'get' | 'post' | 'delete'; url: string; body?: object }]> = [
    ['platform access', (i) => ({ method: 'get', url: `/auth/platform-access/${i.platform}` })],
    ['organization lookup', (i) => ({ method: 'get', url: `/auth/admin/organizations/${i.org}` })],
    ['membership check', (i) => ({ method: 'get', url: `/auth/organizations/${i.org}/membership` })],
    ['join code create', (i) => ({ method: 'post', url: `/auth/organizations/${i.org}/join-codes`, body: { audience: 'x', requiresApproval: false, requiresSubscription: false } })],
    ['join code list', (i) => ({ method: 'get', url: `/auth/organizations/${i.org}/join-codes` })],
    ['join code revoke', (i) => ({ method: 'post', url: `/auth/organizations/${i.org}/join-codes/${i.code}/revoke` })],
    ['invitation create', (i) => ({ method: 'post', url: `/auth/organizations/${i.org}/admin-invitations`, body: { invitationType: 'org_admin' } })],
    ['invitation list', (i) => ({ method: 'get', url: `/auth/organizations/${i.org}/admin-invitations` })],
    ['invitation revoke', (i) => ({ method: 'post', url: `/auth/organizations/${i.org}/admin-invitations/${i.invitation}/revoke` })],
    ['membership list', (i) => ({ method: 'get', url: `/auth/organizations/${i.org}/memberships` })],
    ['membership approve', (i) => ({ method: 'post', url: `/auth/organizations/${i.org}/memberships/${i.membership}/approve` })],
    ['membership reject', (i) => ({ method: 'post', url: `/auth/organizations/${i.org}/memberships/${i.membership}/reject` })],
    ['admin capability grant', (i) => ({ method: 'post', url: `/auth/organizations/${i.org}/memberships/${i.membership}/admin` })],
    ['admin capability revoke', (i) => ({ method: 'delete', url: `/auth/organizations/${i.org}/memberships/${i.membership}/admin` })],
    ['operator block', (i) => ({ method: 'post', url: `/auth/admin/operators/${i.operator}/block` })],
    ['operator unblock', (i) => ({ method: 'post', url: `/auth/admin/operators/${i.operator}/unblock` })],
    ['assignment grant', (i) => ({ method: 'post', url: `/auth/admin/operators/${i.operator}/platform-assignments`, body: { platformId: i.platform } })],
    ['assignment revoke', (i) => ({ method: 'delete', url: `/auth/admin/operators/${i.operator}/platform-assignments/${i.platform}` })],
    ['assignment history', (i) => ({ method: 'get', url: `/auth/admin/operators/${i.operator}/platform-assignments` })],
  ];

  /** a snapshot of everything Company B owns that these routes could change */
  const snapshot = async (org: string, platform: string, operatorId: string) => JSON.stringify({
    codes: (await t.db.query(`SELECT id, "isActive", "revokedAt", "usedCount" FROM organization_join_code WHERE "organizationId"=$1 ORDER BY id`, [org])).rows,
    invitations: (await t.db.query(`SELECT id, "consumedAt", "revokedAt" FROM organization_admin_invitation WHERE "organizationId"=$1 ORDER BY id`, [org])).rows,
    memberships: (await t.db.query(`SELECT id, status, "isOrganizationAdmin", "approvedBy", "rejectedBy" FROM organization_membership WHERE "organizationId"=$1 ORDER BY id`, [org])).rows,
    assignments: (await t.db.query(`SELECT id, active, "revokedAt" FROM platform_assignment WHERE "platformId"=$1 ORDER BY id`, [platform])).rows,
    operator: (await t.db.query(`SELECT "isActive" FROM "user" WHERE id=$1`, [operatorId])).rows,
  });

  const attack = (tokens: unknown, c: (typeof CASES)[number], ids: Ids) => {
    const r = c[1](ids);
    const req = t.http[r.method](r.url).set(bearer(tokens as any));
    return r.body ? req.send(r.body) : req;
  };

  const A_ACTORS: Array<[string, () => unknown]> = [
    ['owner', () => A.owner.tokens], ['operator', () => A.operator], ['organization admin', () => A.orgAdmin], ['active member', () => A.member],
  ];

  describe.each(A_ACTORS)('Company A %s', (_name, tokens) => {
    it('gets the SAME answer for a Company B resource as for one that does not exist, never a success or a 5xx, and changes nothing', async () => {
      const foreign: Ids = { platform: w.platformClinic, org: w.orgClinic, code: B.code, invitation: B.invitation, membership: B.membership, operator: B.operatorUser.id };
      const before = await snapshot(w.orgClinic, w.platformClinic, B.operatorUser.id);
      const mismatches: string[] = [];
      for (const c of CASES) {
        const f = await attack(tokens(), c, foreign);
        const g = await attack(tokens(), c, ghost());
        if (f.status >= 200 && f.status < 300) mismatches.push(`${c[0]}: foreign resource answered ${f.status}`);
        if (f.status >= 500) mismatches.push(`${c[0]}: server error ${f.status}`);
        if (f.status !== g.status || JSON.stringify(noReqId(f.body)) !== JSON.stringify(noReqId(g.body))) {
          mismatches.push(`${c[0]}: foreign=${f.status} ${JSON.stringify(f.body)} vs ghost=${g.status} ${JSON.stringify(g.body)}`);
        }
      }
      expect(mismatches).toEqual([]);
      expect(await snapshot(w.orgClinic, w.platformClinic, B.operatorUser.id)).toBe(before);
    });
  });

  it('the symmetric direction holds too: Company B\'s owner cannot touch Company A resources', async () => {
    const foreign: Ids = { platform: w.platformSchool, org: w.orgSchool1, code: A.code, invitation: A.invitation, membership: A.membership, operator: A.operatorUser.id };
    const before = await snapshot(w.orgSchool1, w.platformSchool, A.operatorUser.id);
    const bad: string[] = [];
    for (const c of CASES) {
      const f = await attack(B.owner.tokens, c, foreign);
      const g = await attack(B.owner.tokens, c, ghost());
      if (f.status < 300 || f.status >= 500 || f.status !== g.status || JSON.stringify(noReqId(f.body)) !== JSON.stringify(noReqId(g.body))) bad.push(`${c[0]}: ${f.status} vs ${g.status}`);
    }
    expect(bad).toEqual([]);
    expect(await snapshot(w.orgSchool1, w.platformSchool, A.operatorUser.id)).toBe(before);
  });

  it('a Company A owner authorized for step-up still cannot mint anything in Company B (authorization precedes the step-up)', async () => {
    const su = await t.stepUpToken(A.owner.tokens, 'admin_invitation.create', A.owner.totpSecret);
    const foreign = await t.http.post(`/auth/organizations/${w.orgClinic}/admin-invitations`).set(bearer(A.owner.tokens)).set('X-Step-Up-Token', su).send({ invitationType: 'org_admin' });
    expect(foreign.status).toBe(404);
    const su2 = await t.stepUpToken(A.owner.tokens, 'admin_invitation.create', A.owner.totpSecret);
    const ghostOrg = await t.http.post(`/auth/organizations/${randomUUID()}/admin-invitations`).set(bearer(A.owner.tokens)).set('X-Step-Up-Token', su2).send({ invitationType: 'org_admin' });
    expect(ghostOrg.status).toBe(404);
    expect(noReqId(ghostOrg.body)).toEqual(noReqId(foreign.body));
    expect((await t.db.query(`SELECT count(*)::int n FROM organization_admin_invitation WHERE "organizationId"=$1 AND "createdBy"=$2`, [w.orgClinic, A.owner.id])).rows[0].n).toBe(0);
    // and the un-burned step-up remains usable inside its own company
    const ok = await t.http.post(`/auth/organizations/${w.orgSchool1}/admin-invitations`).set(bearer(A.owner.tokens)).set('X-Step-Up-Token', su).send({ invitationType: 'org_admin' });
    expect(ok.status).toBe(201);
  });

  it('the database itself refuses cross-company links even if application code were wrong', async () => {
    const attempts: Array<[string, string, unknown[]]> = [
      ['assignment: operator of A + platform of B', `INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES ($1,$2,$3,$4)`, [A.operatorUser.id, w.platformClinic, w.companyA, A.owner.id]],
      ['assignment: operator of B + platform of A', `INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES ($1,$2,$3,$4)`, [B.operatorUser.id, w.platformSchool, w.companyB, B.owner.id]],
      ['join code: organization of B + platform of A', `INSERT INTO organization_join_code("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","createdBy") VALUES ($1,$2,repeat('e',64),'x',false,false,$3)`, [w.orgClinic, w.platformSchool, A.owner.id]],
      ['invitation: organization of B + platform of A', `INSERT INTO organization_admin_invitation("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy") VALUES ($1,$2,repeat('e',64),'org_admin',now()+interval '1 day',$3)`, [w.orgClinic, w.platformSchool, A.owner.id]],
    ];
    for (const [name, sql, params] of attempts) {
      const code = await t.db.query(sql, params).then(() => 'ACCEPTED', (e) => e.code as string);
      expect(code, name).toMatch(/^23/); // a constraint violation, never an accepted row
    }
  });
});
