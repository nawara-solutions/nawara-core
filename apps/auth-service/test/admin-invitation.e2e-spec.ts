import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);
const statuses = (res: Array<{ status: number }>) => res.map((r) => r.status).sort((a, b) => a - b);
const MIN = 60_000;

describe('organization admin invitations (privileged provisioning)', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let ownerA: Awaited<ReturnType<TestCtx['readyOwner']>>; // company A
  let ownerB: Awaited<ReturnType<TestCtx['readyOwner']>>; // company B

  // Listen once: parallel supertest bursts otherwise fail with ECONNRESET in the harness.
  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0);
    w = await t.world(); // NOTE: no organization is licensed: acceptance must not need a license
    ownerA = await t.readyOwner(w.companyA, `ownera${uniq()}@a.test`);
    ownerB = await t.readyOwner(w.companyB, `ownerb${uniq()}@b.test`);
  });
  afterAll(() => t.close());

  const create = (tokens: unknown, org: string, body: Record<string, unknown>, su?: string) => {
    const r = t.http.post(`/auth/organizations/${org}/admin-invitations`).set(bearer(tokens as any));
    return (su ? r.set('X-Step-Up-Token', su) : r).send(body);
  };
  /** An Owner creating an invitation the way production does: with a fresh factor step-up. */
  async function ownerInvite(body: Record<string, unknown> = {}, owner = ownerA, org = w.orgSchool1) {
    const su = await t.stepUpToken(owner.tokens, 'admin_invitation.create', owner.totpSecret);
    return create(owner.tokens, org, { invitationType: 'org_admin', ...body }, su);
  }
  const accept = (invitationCode: string, over: Record<string, unknown> = {}) =>
    t.http.post('/auth/onboarding/invitations/accept').send({ invitationCode, email: `adm${uniq()}@a.test`, password: 'admin password 1', ...over });
  const resolve = (invitationCode: string) => t.http.post('/auth/onboarding/invitations/resolve').send({ invitationCode });
  const invitationRow = async (id: string) => (await t.db.query(`SELECT * FROM organization_admin_invitation WHERE id=$1`, [id])).rows[0];
  const membershipOf = async (userId: string) => (await t.db.query(`SELECT * FROM organization_membership WHERE "userId"=$1`, [userId])).rows[0];
  const userIdOf = async (email: string) => (await t.db.query(`SELECT id FROM "user" WHERE email=$1`, [email])).rows[0]?.id as string | undefined;

  // ------------------------------------------------------------------------------ creation and duration
  describe('creation and duration (the admin picks a duration; the server owns the clock)', () => {
    it('an Owner needs a fresh factor step-up; the code is shown once and stored only as an HMAC', async () => {
      await create(ownerA.tokens, w.orgSchool1, { invitationType: 'org_admin' }).expect(403); // no step-up
      const r = await ownerInvite().then((x) => x);
      expect(r.status).toBe(201);
      expect(r.body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      const row = await invitationRow(r.body.id);
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(r.body.code.replace(/-/g, ''));
      const listed = (await t.http.get(`/auth/organizations/${w.orgSchool1}/admin-invitations`).set(bearer(ownerA.tokens)).expect(200)).body;
      expect(JSON.stringify(listed)).not.toContain(r.body.code); // not recoverable
      expect(t.logger.lines.join('\n')).not.toContain(r.body.code);
    });

    it('the step-up must be factor-only: the bare secret key cannot mint an administrator invitation', async () => {
      const su = await t.stepUp(ownerA.tokens, 'admin_invitation.create', ownerA.totpSecret, { method: 'secret_key', secretKey: 'AAAA-AAAA' });
      expect(su.status).toBeGreaterThanOrEqual(400); // rejected: this purpose does not accept secret_key
      expect(su.status).toBeLessThan(500);
    });

    it('default 24 h, minimum 15 min, maximum 7 days; anything outside the range is a 400', async () => {
      const dur = async (id: string) => {
        const r = await invitationRow(id);
        return (r.expiresAt.getTime() - r.createdAt.getTime()) / MIN;
      };
      const def = await ownerInvite().then((x) => x);
      expect(def.status).toBe(201);
      expect(await dur(def.body.id)).toBe(1440);
      const min = await ownerInvite({ expiresInMinutes: 15 });
      expect(min.status).toBe(201);
      expect(await dur(min.body.id)).toBe(15);
      const max = await ownerInvite({ expiresInMinutes: 10_080 });
      expect(max.status).toBe(201);
      expect(await dur(max.body.id)).toBe(10_080);
      for (const bad of [14, 10_081, 0, -5, 90.5, 'soon']) expect((await ownerInvite({ expiresInMinutes: bad })).status).toBe(400);
    });

    it('the expiry is computed by the SERVER from its own clock; a client-supplied expiresAt is refused', async () => {
      const r = await ownerInvite({ expiresInMinutes: 120 });
      expect(r.status).toBe(201);
      const row = await invitationRow(r.body.id);
      expect(row.expiresAt.getTime()).toBe(row.createdAt.getTime() + 120 * MIN); // absolute timestamp, server-derived
      const far = new Date(t.clock.now().getTime() + 400 * 86_400_000).toISOString();
      expect((await ownerInvite({ expiresAt: far })).status).toBe(400);
      expect((await ownerInvite({ expiresInMinutes: 60, expiresAt: far })).status).toBe(400);
    });

    it('the reserved word "admin" cannot be the invitation type (a member can never carry that role)', async () => {
      expect((await ownerInvite({ invitationType: 'admin' })).status).toBe(400);
      expect((await ownerInvite({ invitationType: 'Not Valid!' })).status).toBe(400);
      expect((await ownerInvite({ invitationType: 'manager' })).status).toBe(201); // any other platform-defined label
    });
  });

  // ------------------------------------------------------------------------------ resolution
  describe('resolving an invitation', () => {
    it('returns only the safe context', async () => {
      await t.db.query(`UPDATE platform SET key='shared-platform' WHERE id=$1`, [w.platformSchool]);
      const inv = await ownerInvite({ invitationType: 'org_admin' });
      const r = (await resolve(inv.body.code).expect(200)).body;
      expect(r).toMatchObject({
        platform: { id: w.platformSchool, key: 'shared-platform', name: 'School' },
        organization: { id: w.orgSchool1, name: 'School 1' },
        invitationType: 'org_admin', contactBound: false, requiresVerification: false,
      });
      expect(JSON.stringify(r)).not.toMatch(/codeHash|createdBy|companyId|license|subscription|inviteeContactHash/i);
    });

    it('unknown, malformed, expired, revoked and consumed invitations are ONE indistinguishable 404, audited internally', async () => {
      const revoked = await ownerInvite();
      const su = await t.stepUpToken(ownerA.tokens, 'admin_invitation.revoke', ownerA.totpSecret);
      await t.http.post(`/auth/organizations/${w.orgSchool1}/admin-invitations/${revoked.body.id}/revoke`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su).expect(204);
      const consumed = await ownerInvite();
      await accept(consumed.body.code).expect(201);
      const expiring = await ownerInvite({ expiresInMinutes: 15 });
      t.clock.advance(20 * MIN);
      try {
        const res = [await resolve('ABCD-EFGH-JKMN'), await resolve('this is not an invitation!'), await resolve(revoked.body.code), await resolve(consumed.body.code), await resolve(expiring.body.code)];
        for (const r of res) expect(r.status).toBe(404);
        for (const r of res.slice(1)) expect(r.body).toEqual(res[0].body);
      } finally { t.clock.advance(-20 * MIN); }
      const reasons = (await t.db.query(`SELECT metadata->>'reason' AS reason FROM auth_audit_event WHERE type='onboarding.admin_invitation.resolve_failed'`)).rows.map((r) => r.reason);
      expect(reasons).toEqual(expect.arrayContaining(['unknown', 'malformed', 'revoked', 'consumed', 'expired']));
    });

    it('is rate limited per IP and by a global brake', async () => {
      const ip = await createTestApp({ RATE_INVITATION_RESOLVE_IP_LIMIT: '4' });
      const glob = await createTestApp({ RATE_INVITATION_RESOLVE_GLOBAL_LIMIT: '3' });
      try {
        const a: number[] = [];
        for (let i = 0; i < 7; i++) a.push((await ip.http.post('/auth/onboarding/invitations/resolve').send({ invitationCode: 'ABCD-EFGH-JKMN' })).status);
        expect(a.filter((s) => s === 404)).toHaveLength(4);
        expect(a.filter((s) => s === 429)).toHaveLength(3);
        const g: number[] = [];
        for (let i = 0; i < 6; i++) g.push((await glob.http.post('/auth/onboarding/invitations/resolve').set('X-Forwarded-For', `10.0.0.${i}`).send({ invitationCode: 'ABCD-EFGH-JKMN' })).status);
        expect(g.filter((s) => s === 429).length).toBeGreaterThan(0);
      } finally { await ip.close(); await glob.close(); }
    });

    it('acceptance is rate limited too', async () => {
      const a = await createTestApp({ RATE_INVITATION_ACCEPT_IP_LIMIT: '3' });
      try {
        const codes: number[] = [];
        for (let i = 0; i < 6; i++) codes.push((await a.http.post('/auth/onboarding/invitations/accept').send({ invitationCode: 'ABCD-EFGH-JKMN', email: `x${i}@a.test`, password: 'admin password 1' })).status);
        expect(codes.filter((s) => s === 403)).toHaveLength(3);
        expect(codes.filter((s) => s === 429)).toHaveLength(3);
      } finally { await a.close(); }
    });
  });

  // ------------------------------------------------------------------------------ acceptance
  describe('accepting an invitation (single use)', () => {
    it('creates a kind=member with an ACTIVE membership carrying the management capability, and a normal session, without any license', async () => {
      const inv = await ownerInvite({ invitationType: 'org_admin' });
      const callsBefore = t.payment.calls.length;
      const email = `first${uniq()}@a.test`;
      const r = await accept(inv.body.code, { email }).expect(201);
      expect(t.payment.calls.length).toBe(callsBefore); // no license question: an organization needs a member before it can pay
      expect(r.body.onboarding).toMatchObject({ invitationType: 'org_admin', membershipStatus: 'active', isOrganizationAdmin: true });
      const uid = (await userIdOf(email))!;
      expect((await t.db.query(`SELECT kind, role, "organizationId", "isActive" FROM "user" WHERE id=$1`, [uid])).rows[0]).toEqual({ kind: 'member', role: 'org_admin', organizationId: w.orgSchool1, isActive: true });
      const m = await membershipOf(uid);
      expect(m).toMatchObject({ status: 'active', isOrganizationAdmin: true, invitationId: inv.body.id, joinCodeId: null, approvedBy: ownerA.id });
      const row = await invitationRow(inv.body.id);
      expect(row.consumedBy).toBe(uid);
      expect(row.consumedAt).not.toBeNull();
      const me = (await t.http.get('/auth/me').set(bearer(r.body)).expect(200)).body;
      expect(me.membership).toMatchObject({ organizationId: w.orgSchool1, status: 'active', isOrganizationAdmin: true });
      expect(t.bus.last('membership.admin_provisioned')).toMatchObject({ userId: uid, organizationId: w.orgSchool1, invitationType: 'org_admin' });
    });

    it('a second use is refused, and so is any attempt to reuse the consumed code for another account', async () => {
      const inv = await ownerInvite();
      await accept(inv.body.code).expect(201);
      await accept(inv.body.code).expect(403);
      await accept(inv.body.code, { phone: '+21655500111', email: undefined }).expect(403);
      expect((await t.db.query(`SELECT count(*)::int n FROM organization_membership WHERE "invitationId"=$1`, [inv.body.id])).rows[0].n).toBe(1);
    });

    it('the client cannot choose the organization, platform, role or capability at acceptance', async () => {
      const inv = await ownerInvite();
      for (const extra of [{ organizationId: w.orgSchool2 }, { platformId: w.platformDrive }, { role: 'owner' }, { invitationType: 'x_other' }, { isOrganizationAdmin: false }, { audience: 'teacher' }]) {
        await accept(inv.body.code, extra).expect(400);
      }
      const email = `ok${uniq()}@a.test`;
      await accept(inv.body.code, { email }).expect(201);
      expect((await t.db.query(`SELECT "organizationId" FROM "user" WHERE email=$1`, [email])).rows[0].organizationId).toBe(w.orgSchool1);
    });

    it('a failed acceptance (duplicate account) does not burn the invitation', async () => {
      const first = await ownerInvite();
      const taken = `taken${uniq()}@a.test`;
      await accept(first.body.code, { email: taken }).expect(201);
      const second = await ownerInvite();
      await accept(second.body.code, { email: taken }).expect(409); // that contact already has an account
      expect((await invitationRow(second.body.id)).consumedAt).toBeNull();
      await accept(second.body.code).expect(201); // still usable by the right person
    });

    it('the invitation lifetime is NOT the session lifetime: the session outlives the (now dead) invitation', async () => {
      const inv = await ownerInvite({ expiresInMinutes: 15 });
      const r = await accept(inv.body.code).expect(201);
      t.clock.advance(20 * MIN); // the invitation would have expired, and it was consumed anyway
      try {
        await resolve(inv.body.code).expect(404); // dead
        await t.http.get('/auth/me').set(bearer(r.body)).expect(200); // session unaffected (its own TTL)
        await t.http.post('/auth/refresh').send({ refreshToken: r.body.refreshToken }).expect(200);
      } finally { t.clock.advance(-20 * MIN); }
      expect(r.body.expiresIn).toBe(t.cfg.jwt.accessTtlSec); // the normal access TTL, not the invitation duration
    });

    it('an expired invitation cannot be accepted, and nothing is created', async () => {
      const inv = await ownerInvite({ expiresInMinutes: 15 });
      t.clock.advance(16 * MIN);
      try {
        const email = `late${uniq()}@a.test`;
        await accept(inv.body.code, { email }).expect(403);
        expect(await userIdOf(email)).toBeUndefined();
        const listed = (await t.http.get(`/auth/organizations/${w.orgSchool1}/admin-invitations`).set(bearer(ownerA.tokens))).body;
        expect(listed.find((i: any) => i.id === inv.body.id).status).toBe('expired');
      } finally { t.clock.advance(-16 * MIN); }
    });
  });

  // ------------------------------------------------------------------------------ credential separation
  describe('credentials are never interchangeable', () => {
    it('a join code is not an invitation, and an invitation is not a join code', async () => {
      const jc = await t.joinCode(w.orgSchool1, { audience: 'teacher', requiresApproval: true });
      t.payment.licensed.add(w.orgSchool1);
      const inv = await ownerInvite();
      await resolve(jc.code).expect(404); // join code as invitation
      await accept(jc.code).expect(403);
      await t.http.post('/auth/onboarding/resolve').send({ joinCode: inv.body.code }).expect(404); // invitation as join code
      await t.http.post('/auth/register').send({ email: `x${uniq()}@a.test`, password: 'member password 1', joinCode: inv.body.code }).expect(403);
      expect((await invitationRow(inv.body.id)).consumedAt).toBeNull(); // untouched by the misuse
    });
  });

  // ------------------------------------------------------------------------------ who may invite
  describe('who may create and revoke invitations', () => {
    it('a plain member, an assigned operator, another company’s owner and an unauthenticated caller are refused', async () => {
      const plain = await t.member(w.orgSchool1, `plain${uniq()}@a.test`);
      const plainTokens = (await t.http.post('/auth/login').send({ email: plain.email, password: plain.password })).body;
      const opEmail = `op${uniq()}@a.test`;
      const op = await t.operator(w.companyA, opEmail);
      await t.assign(op.id, w.platformSchool, ownerA.id, w.companyA);
      const opTokens = await t.operatorLogin(opEmail);
      const body = { invitationType: 'org_admin' };
      expect((await create(plainTokens, w.orgSchool1, body)).status).toBe(404);
      expect((await create(opTokens, w.orgSchool1, body)).status).toBe(404); // operators do not provision administrators
      expect((await ownerInvite({}, ownerB, w.orgSchool1)).status).toBe(404); // other company
      expect((await t.http.post(`/auth/organizations/${w.orgSchool1}/admin-invitations`).send(body)).status).toBe(401);
      expect((await t.db.query(`SELECT count(*)::int n FROM organization_admin_invitation WHERE "createdBy" = ANY($1)`, [[plain.id, op.id, ownerB.id]])).rows[0].n).toBe(0);
    });

    it('an organization admin can invite for THEIR organization, without a step-up, and only theirs', async () => {
      const first = await ownerInvite();
      const email = `adm${uniq()}@a.test`;
      const admin = (await accept(first.body.code, { email }).expect(201)).body;
      const own = await create(admin, w.orgSchool1, { invitationType: 'org_admin', expiresInMinutes: 60 });
      expect(own.status).toBe(201);
      expect((await invitationRow(own.body.id)).createdBy).toBe(await userIdOf(email));
      expect((await create(admin, w.orgSchool2, { invitationType: 'org_admin' })).status).toBe(404); // same platform, another organization
      expect((await create(admin, w.orgClinic, { invitationType: 'org_admin' })).status).toBe(404); // another company
    });

    it('an admin created by an invitation can approve a pending request and invite the next administrator', async () => {
      t.payment.licensed.add(w.orgSchool1);
      const jc = await t.joinCode(w.orgSchool1, { audience: 'teacher', requiresApproval: true });
      const teacherEmail = `teach${uniq()}@a.test`;
      await t.http.post('/auth/register').send({ email: teacherEmail, password: 'member password 1', joinCode: jc.code }).expect(201);
      const teacherId = (await userIdOf(teacherEmail))!;
      const teacherMembership = (await membershipOf(teacherId)).id as string;
      const admin = (await accept((await ownerInvite()).body.code).then((x) => x)).body;
      await t.http.post(`/auth/organizations/${w.orgSchool1}/memberships/${teacherMembership}/approve`).set(bearer(admin)).expect(200);
      expect((await membershipOf(teacherId)).status).toBe('active');
      const next = await create(admin, w.orgSchool1, { invitationType: 'org_admin' });
      expect(next.status).toBe(201);
    });
  });

  // ------------------------------------------------------------------------------ binding
  describe('optional binding to the intended person', () => {
    it('a bound invitation only accepts that contact; a mismatch is the generic 403 and does NOT consume it', async () => {
      const wanted = `wanted${uniq()}@a.test`;
      const inv = await ownerInvite({ inviteeContact: wanted });
      expect((await resolve(inv.body.code).expect(200)).body.contactBound).toBe(true);
      const intruder = `intruder${uniq()}@a.test`;
      await accept(inv.body.code, { email: intruder }).expect(403);
      expect(await userIdOf(intruder)).toBeUndefined();
      expect((await invitationRow(inv.body.id)).consumedAt).toBeNull();
      await accept(inv.body.code, { email: wanted.toUpperCase() }).expect(201); // normalized: case-insensitive
      const dump = JSON.stringify((await t.db.query(`SELECT * FROM organization_admin_invitation WHERE id=$1`, [inv.body.id])).rows);
      expect(dump).not.toContain(wanted); // only an HMAC is stored
    });

    it('a phone binding works the same way', async () => {
      const inv = await ownerInvite({ inviteeContact: '+216 55 500 222' });
      await accept(inv.body.code, { email: undefined, phone: '+21655500999' }).expect(403);
      await accept(inv.body.code, { email: undefined, phone: '+21655500222' }).expect(201);
    });
  });

  // ------------------------------------------------------------------------------ revocation
  describe('revocation', () => {
    it('takes effect immediately, needs an Owner step-up, and cannot revoke what is already used', async () => {
      const inv = await ownerInvite();
      const path = `/auth/organizations/${w.orgSchool1}/admin-invitations/${inv.body.id}/revoke`;
      await t.http.post(path).set(bearer(ownerA.tokens)).expect(403); // no step-up
      const su = await t.stepUpToken(ownerA.tokens, 'admin_invitation.revoke', ownerA.totpSecret);
      await t.http.post(path).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su).expect(204);
      await resolve(inv.body.code).expect(404);
      await accept(inv.body.code).expect(403);
      const su2 = await t.stepUpToken(ownerA.tokens, 'admin_invitation.revoke', ownerA.totpSecret);
      await t.http.post(path).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su2).expect(404); // already revoked
      const used = await ownerInvite();
      await accept(used.body.code).expect(201);
      const su3 = await t.stepUpToken(ownerA.tokens, 'admin_invitation.revoke', ownerA.totpSecret);
      await t.http.post(`/auth/organizations/${w.orgSchool1}/admin-invitations/${used.body.id}/revoke`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su3).expect(404);
    });

    it('a revoked invitation is never revived and history is kept', async () => {
      const inv = await ownerInvite();
      const su = await t.stepUpToken(ownerA.tokens, 'admin_invitation.revoke', ownerA.totpSecret);
      await t.http.post(`/auth/organizations/${w.orgSchool1}/admin-invitations/${inv.body.id}/revoke`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su).expect(204);
      await t.db.query(`UPDATE organization_admin_invitation SET "revokedAt"=NULL, "revokedBy"=NULL WHERE id=$1`, [inv.body.id]).then(() => { throw new Error('revival must fail'); }, (e) => expect(e.code).toBe('23514'));
      await t.db.query(`DELETE FROM organization_admin_invitation WHERE id=$1`, [inv.body.id]).then(() => { throw new Error('delete must fail'); }, (e) => expect(e.code).toBe('23514'));
      const listed = (await t.http.get(`/auth/organizations/${w.orgSchool1}/admin-invitations`).set(bearer(ownerA.tokens))).body;
      expect(listed.find((i: any) => i.id === inv.body.id).status).toBe('revoked');
    });
  });

  // ------------------------------------------------------------------------------ concurrency
  describe('concurrency: an invitation is consumed exactly once', () => {
    it('8 simultaneous acceptances: one 201, seven 403, exactly one account and one membership', async () => {
      const inv = await ownerInvite();
      const emails = Array.from({ length: 8 }, () => `race${uniq()}@a.test`);
      const res = await Promise.all(emails.map((email) => accept(inv.body.code, { email })));
      expect(statuses(res)).toEqual([201, 403, 403, 403, 403, 403, 403, 403]);
      const created = (await t.db.query(`SELECT id, email FROM "user" WHERE email = ANY($1)`, [emails])).rows;
      expect(created).toHaveLength(1); // the seven losers' users were rolled back
      const row = await invitationRow(inv.body.id);
      expect(row.consumedBy).toBe(created[0].id);
      expect((await t.db.query(`SELECT count(*)::int n FROM organization_membership WHERE "invitationId"=$1`, [inv.body.id])).rows[0].n).toBe(1);
      expect((await t.db.query(`SELECT count(*)::int n FROM auth_audit_event WHERE type='onboarding.admin_invitation.consumed' AND "targetId"=$1`, [inv.body.id])).rows[0].n).toBe(1);
    });

    it('revoke racing acceptance: exactly one wins and the state is consistent, never both', async () => {
      for (let i = 0; i < 3; i++) {
        const inv = await ownerInvite();
        const su = await t.stepUpToken(ownerA.tokens, 'admin_invitation.revoke', ownerA.totpSecret);
        const [a, r] = await Promise.all([
          accept(inv.body.code),
          t.http.post(`/auth/organizations/${w.orgSchool1}/admin-invitations/${inv.body.id}/revoke`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su),
        ]);
        expect(a.status).not.toBeGreaterThanOrEqual(500);
        expect(r.status).not.toBeGreaterThanOrEqual(500);
        const row = await invitationRow(inv.body.id);
        expect(Boolean(row.consumedAt) !== Boolean(row.revokedAt)).toBe(true); // exactly one of consumed / revoked
        expect(a.status === 201).toBe(Boolean(row.consumedAt));
        expect(r.status === 204).toBe(Boolean(row.revokedAt));
      }
    });
  });

  // ------------------------------------------------------------------------------ audit
  describe('audit trail', () => {
    it('records created, resolved, consumed and revoked without any secret, contact or password', async () => {
      const contact = `audit${uniq()}@a.test`;
      const inv = await ownerInvite({ inviteeContact: contact });
      await resolve(inv.body.code).expect(200);
      const email = contact;
      await accept(inv.body.code, { email, password: 'super secret admin pw 9' }).expect(201);
      const inv2 = await ownerInvite();
      const su = await t.stepUpToken(ownerA.tokens, 'admin_invitation.revoke', ownerA.totpSecret);
      await t.http.post(`/auth/organizations/${w.orgSchool1}/admin-invitations/${inv2.body.id}/revoke`).set(bearer(ownerA.tokens)).set('X-Step-Up-Token', su).expect(204);
      const ev = await t.db.query(`SELECT type, outcome, "actorId", "targetId", metadata FROM auth_audit_event WHERE type LIKE 'onboarding.admin_invitation.%' AND ("targetId"=$1 OR "targetId"=$2)`, [inv.body.id, inv2.body.id]);
      expect(ev.rows.map((r) => r.type)).toEqual(expect.arrayContaining([
        'onboarding.admin_invitation.created', 'onboarding.admin_invitation.resolved', 'onboarding.admin_invitation.consumed', 'onboarding.admin_invitation.revoked',
      ]));
      const created = ev.rows.find((r) => r.type === 'onboarding.admin_invitation.created' && r.targetId === inv.body.id);
      expect(created).toMatchObject({ actorId: ownerA.id, outcome: 'success' });
      expect(created.metadata).toMatchObject({ organizationId: w.orgSchool1, authority: 'owner', durationMinutes: 1440, contactBound: true });
      const dump = JSON.stringify(ev.rows) + t.logger.lines.join('\n');
      for (const secret of [inv.body.code, inv.body.code.replace(/-/g, ''), 'super secret admin pw 9', contact]) expect(dump).not.toContain(secret);
    });
  });
});
