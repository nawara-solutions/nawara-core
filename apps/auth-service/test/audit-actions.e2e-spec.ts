import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAuditPayload } from '@nawara/audit-contract';
import { bearer, createTestApp, type TestCtx, type Tokens } from './helpers/app.js';

type Row = { id: string; name: string; payload: Record<string, any> };
const IP = '203.0.113.77';
/** What central audit must never carry (identifiers and codes only): contact data, network data, secrets. */
const PROHIBITED = [/@/, /203\.0\.113/, /\+216/, /password/i, /secret/i, /token/i, /eyJ[A-Za-z0-9_-]{10,}/];
/** The payload WITHOUT its catalog action code (`owner.password_changed` names a fact; it carries no password). */
const facts = (p: Record<string, any>) => JSON.stringify({ ...p, action: undefined });

/**
 * Stage 18.7.6: every wired Auth catalog action, through the REAL HTTP routes on a REAL PostgreSQL: one central audit intent in the
 * mutation's transaction, with the actor Auth verified (kind from the database), the organization from the persisted row, identifiers
 * only. (owner.webauthn_clone_suspected and the passkey enrollment are asserted in webauthn.e2e-spec.ts, where the detection runs.)
 */
describe('Auth central audit intent per catalog action (real PostgreSQL)', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let owner: Awaited<ReturnType<TestCtx['readyOwner']>>;

  const central = async (action: string, resourceId?: string): Promise<Row[]> => (await t.db.query(
    `SELECT id, name, payload FROM outbox WHERE name = $1 ${resourceId ? `AND payload->'resource'->>'id' = $2` : ''} ORDER BY "occurredAt", id`,
    resourceId ? [`audit.${action}`, resourceId] : [`audit.${action}`],
  )).rows;
  const one = async (action: string, resourceId: string) => {
    const rows = await central(action, resourceId);
    expect(rows, action).toHaveLength(1);
    expect(() => validateAuditPayload(rows[0]!.payload, 'auth-service'), action).not.toThrow();
    for (const re of PROHIBITED) expect(facts(rows[0]!.payload), `${action} ${re}`).not.toMatch(re);
    return rows[0]!.payload;
  };
  const su = (purpose: string, o = owner) => t.stepUpToken(o.tokens, purpose, o.totpSecret);
  const memberLogin = async (m: { email: string; password: string }) => (await t.http.post('/auth/login').set('X-Forwarded-For', IP).send({ email: m.email, password: m.password }).expect(200)).body as Tokens;
  const membershipOf = async (userId: string, org: string) => (await t.db.query(`SELECT id FROM organization_membership WHERE "userId"=$1 AND "organizationId"=$2`, [userId, org])).rows[0].id as string;
  const orgAdmin = async (org: string) => {
    const m = await t.member(org, `adm${Math.random().toString(36).slice(2, 8)}@a.test`);
    await t.db.query(`UPDATE organization_membership SET "isOrganizationAdmin"=true WHERE "userId"=$1`, [m.id]);
    return { ...m, tokens: await memberLogin(m) };
  };

  beforeAll(async () => {
    t = await createTestApp({ TRUST_PROXY: 'true' });
    w = await t.world();
    owner = await t.readyOwner(w.companyA, 'owner-audit@a.test');
  });
  afterAll(async () => {
    await t?.close();
  });

  describe('organization-scoped actions: the organization is the persisted row\'s; the actor kind is the database\'s', () => {
    it('join_code.created / join_code.revoked (owner, step-up)', async () => {
      const r = await t.http.post(`/auth/organizations/${w.orgSchool1}/join-codes`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('join_code.create'))
        .send({ audience: 'student', requiresApproval: false, requiresSubscription: false }).expect(201);
      expect(r.body).not.toHaveProperty('organizationId'); // the response is unchanged by the audit wiring
      expect(await one('join_code.created', r.body.id)).toMatchObject({
        actor: { type: 'user', id: owner.id, userKind: 'owner' }, organizationId: w.orgSchool1, resource: { type: 'join_code', id: r.body.id }, changes: { authority: 'owner' },
      });
      await t.http.post(`/auth/organizations/${w.orgSchool1}/join-codes/${r.body.id}/revoke`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('join_code.revoke')).expect(204);
      expect(await one('join_code.revoked', r.body.id)).toMatchObject({ organizationId: w.orgSchool1, changes: { authority: 'owner' } });
    });

    it('an organization admin (a MEMBER) creates a join code: kind member, authority org_admin; another company\'s organization is a 404 with no evidence', async () => {
      const admin = await orgAdmin(w.orgSchool2);
      const r = await t.http.post(`/auth/organizations/${w.orgSchool2}/join-codes`).set(bearer(admin.tokens)).set('x-user-kind', 'owner')
        .send({ audience: 'student', requiresApproval: true, requiresSubscription: false }).expect(201);
      expect(await one('join_code.created', r.body.id)).toMatchObject({ actor: { type: 'user', id: admin.id, userKind: 'member' }, organizationId: w.orgSchool2, changes: { authority: 'org_admin' } });
      const before = (await central('join_code.created')).length;
      await t.http.post(`/auth/organizations/${w.orgClinic}/join-codes`).set(bearer(admin.tokens)).send({ audience: 'student', requiresApproval: true, requiresSubscription: false }).expect(404);
      await t.http.post(`/auth/organizations/${w.orgSchool2}/join-codes`).set(bearer(admin.tokens))
        .send({ audience: 'student', requiresApproval: true, requiresSubscription: false, organizationId: w.orgClinic }).expect(400); // a body cannot name the organization
      expect((await central('join_code.created')).length).toBe(before);
    });

    it('membership.approved / membership.rejected / membership.revoked (subject: the member; was_admin from the row)', async () => {
      const admin = await orgAdmin(w.orgSchool1);
      const p1 = await t.member(w.orgSchool1, 'pend1@a.test', undefined, 'student', 'pending');
      const p2 = await t.member(w.orgSchool1, 'pend2@a.test', undefined, 'student', 'pending');
      const m1 = await membershipOf(p1.id, w.orgSchool1);
      const m2 = await membershipOf(p2.id, w.orgSchool1);
      await t.http.post(`/auth/organizations/${w.orgSchool1}/memberships/${m1}/approve`).set(bearer(admin.tokens)).set('X-Forwarded-For', IP).expect(200);
      await t.http.post(`/auth/organizations/${w.orgSchool1}/memberships/${m2}/reject`).set(bearer(admin.tokens)).expect(200);
      expect(await one('membership.approved', m1)).toMatchObject({
        actor: { type: 'user', id: admin.id, userKind: 'member' }, organizationId: w.orgSchool1, resource: { type: 'membership', id: m1 }, subject: { type: 'user', id: p1.id },
        changes: { authority: 'org_admin' },
      });
      expect(await one('membership.rejected', m2)).toMatchObject({ subject: { type: 'user', id: p2.id }, organizationId: w.orgSchool1 });
      await t.http.post(`/auth/organizations/${w.orgSchool1}/memberships/${m1}/revoke`).set(bearer(owner.tokens)).expect(200);
      expect(await one('membership.revoked', m1)).toMatchObject({ actor: { userKind: 'owner' }, changes: { authority: 'owner', was_admin: false } });
    });

    it('membership.admin_granted / membership.admin_revoked (owner, step-up)', async () => {
      const m = await t.member(w.orgSchool1, 'future-admin@a.test');
      const mid = await membershipOf(m.id, w.orgSchool1);
      await t.http.post(`/auth/organizations/${w.orgSchool1}/memberships/${mid}/admin`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('organization.admin.grant')).expect(204);
      expect(await one('membership.admin_granted', mid)).toMatchObject({ actor: { userKind: 'owner' }, organizationId: w.orgSchool1, subject: { type: 'user', id: m.id } });
      await t.http.delete(`/auth/organizations/${w.orgSchool1}/memberships/${mid}/admin`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('organization.admin.revoke')).expect(204);
      expect(await one('membership.admin_revoked', mid)).toMatchObject({ organizationId: w.orgSchool1, subject: { type: 'user', id: m.id } });
    });

    it('admin_invitation.created / .revoked and membership.admin_provisioned (the accepting member is the actor)', async () => {
      const inv = await t.http.post(`/auth/organizations/${w.orgDrive}/admin-invitations`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('admin_invitation.create'))
        .send({ invitationType: 'org_admin' }).expect(201);
      expect(inv.body).not.toHaveProperty('organizationId');
      expect(await one('admin_invitation.created', inv.body.id)).toMatchObject({ organizationId: w.orgDrive, resource: { type: 'admin_invitation' }, changes: { authority: 'owner' } });
      const accepted = await t.http.post('/auth/onboarding/invitations/accept').set('X-Forwarded-For', IP)
        .send({ invitationCode: inv.body.code, email: 'provisioned@a.test', password: 'admin password 1' }).expect(201);
      const newUser = (await t.db.query(`SELECT id FROM "user" WHERE email='provisioned@a.test'`)).rows[0].id;
      const mid = await membershipOf(newUser, w.orgDrive);
      expect(accepted.body.onboarding).toMatchObject({ isOrganizationAdmin: true });
      expect(await one('membership.admin_provisioned', mid)).toMatchObject({
        actor: { type: 'user', id: newUser, userKind: 'member' }, organizationId: w.orgDrive, resource: { type: 'membership', id: mid }, changes: { invitation_id: inv.body.id },
      });
      const inv2 = await t.http.post(`/auth/organizations/${w.orgDrive}/admin-invitations`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('admin_invitation.create'))
        .send({ invitationType: 'org_admin', inviteeContact: 'someone@a.test' }).expect(201);
      await t.http.post(`/auth/organizations/${w.orgDrive}/admin-invitations/${inv2.body.id}/revoke`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('admin_invitation.revoke')).expect(204);
      expect(await one('admin_invitation.revoked', inv2.body.id)).toMatchObject({ organizationId: w.orgDrive });
    });
  });

  describe('platform-level actions: no organization', () => {
    it('operator.created, account.disabled / account.enabled, platform_assignment.granted / .revoked (the owner, proven from its owner row)', async () => {
      const op = await t.http.post('/auth/admin/operators').set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('operator.create')).send({ email: 'op-audit@a.test' }).expect(201);
      expect(await one('operator.created', op.body.id)).toMatchObject({ actor: { type: 'user', id: owner.id, userKind: 'owner' }, organizationId: null, resource: { type: 'user', id: op.body.id } });
      await t.http.post(`/auth/admin/operators/${op.body.id}/block`).set(bearer(owner.tokens)).expect(204);
      await t.http.post(`/auth/admin/operators/${op.body.id}/unblock`).set(bearer(owner.tokens)).expect(204);
      expect(await one('account.disabled', op.body.id)).toMatchObject({ resource: { type: 'user', id: op.body.id }, organizationId: null });
      expect(await one('account.enabled', op.body.id)).toMatchObject({ resource: { type: 'user', id: op.body.id } });
      // Coexistence: the local security trail is still written in the same transaction, and keeps what central audit never gets (the IP).
      const local = (await t.db.query(`SELECT type, ip FROM auth_audit_event WHERE "targetId"=$1 AND type IN ('operator.create','account.disabled','account.enabled') ORDER BY id`, [op.body.id])).rows;
      expect(local.map((r) => r.type)).toEqual(['operator.create', 'account.disabled', 'account.enabled']);
      await t.http.post(`/auth/admin/operators/${op.body.id}/platform-assignments`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('platform_assignment.grant'))
        .send({ platformId: w.platformSchool }).expect(201);
      const aid = (await t.db.query(`SELECT id FROM platform_assignment WHERE "operatorId"=$1`, [op.body.id])).rows[0].id;
      expect(await one('platform_assignment.granted', aid)).toMatchObject({ subject: { type: 'user', id: op.body.id }, changes: { platform_id: w.platformSchool }, organizationId: null });
      await t.http.delete(`/auth/admin/operators/${op.body.id}/platform-assignments/${w.platformSchool}`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('platform_assignment.revoke')).expect(204);
      expect(await one('platform_assignment.revoked', aid)).toMatchObject({ changes: { platform_id: w.platformSchool } });
    });

    it('owner.factor_enrolled (first TOTP at bootstrap, a second one under step-up), owner.factor_removed', async () => {
      const first = (await t.db.query(`SELECT id FROM owner_auth_factor WHERE "ownerId"=$1`, [owner.id])).rows[0].id;
      expect(await one('owner.factor_enrolled', first)).toMatchObject({ actor: { id: owner.id, userKind: 'owner' }, resource: { type: 'factor', id: first }, changes: { method: 'totp' } });
      const begin = await t.http.post('/auth/admin/factors/totp').set(bearer(owner.tokens)).expect(200);
      await t.http.post('/auth/admin/factors/totp/confirm').set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('owner.factor.enroll'))
        .send({ factorId: begin.body.factorId, code: t.nextCode(begin.body.secret) }).expect(200);
      expect(await one('owner.factor_enrolled', begin.body.factorId)).toMatchObject({ changes: { method: 'totp' } });
      await t.http.delete(`/auth/admin/factors/${begin.body.factorId}`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('owner.factor.remove')).expect(204);
      expect(await one('owner.factor_removed', begin.body.factorId)).toMatchObject({ resource: { type: 'factor', id: begin.body.factorId } });
    });

    it('owner.secret_key_rotated, owner.password_changed, owner.recovery_started / _cancelled / _completed (no IP, no contact, no secret)', async () => {
      const o = await t.readyOwner(await t.newCompany(), 'owner-rec@a.test');
      const key = (await t.http.post('/auth/admin/secret-key/rotate').set(bearer(o.tokens)).set('X-Step-Up-Token', await su('owner.secret_key.rotate', o)).expect(200)).body.secretKey as string;
      expect(await one('owner.secret_key_rotated', o.id)).toMatchObject({ actor: { id: o.id, userKind: 'owner' }, resource: { type: 'user', id: o.id } });
      const start = () => t.http.post('/auth/admin/recovery/start').set('X-Forwarded-For', IP).send({ email: o.email, password: o.password, secretKey: key }).expect(202);
      await start();
      expect((await central('owner.recovery_started', o.id))).toHaveLength(1);
      await t.http.post('/auth/admin/recovery/cancel').set(bearer(o.tokens)).expect(204);
      expect(await one('owner.recovery_cancelled', o.id)).toMatchObject({ resource: { type: 'user', id: o.id } });
      await t.http.post('/auth/admin/recovery/cancel').set(bearer(o.tokens)).expect(204); // nothing pending: no second event
      expect(await central('owner.recovery_cancelled', o.id)).toHaveLength(1);
      await t.http.post('/auth/admin/password/change').set(bearer(o.tokens)).set('X-Step-Up-Token', await su('owner.password.change', o)).send({ newPassword: 'a brand new passphrase' }).expect(204);
      expect(await one('owner.password_changed', o.id)).toMatchObject({ resource: { type: 'user', id: o.id } });
      const rec = await t.http.post('/auth/admin/recovery/start').send({ email: o.email, password: 'a brand new passphrase', secretKey: key }).expect(202);
      t.clock.advance(t.cfg.recovery.cooldownSec * 1000 + 1000);
      await t.http.post('/auth/admin/recovery/complete').set('X-Forwarded-For', IP).send({ recoveryToken: rec.body.recoveryToken, secretKey: key }).expect(200);
      expect(await one('owner.recovery_completed', o.id)).toMatchObject({ actor: { id: o.id, userKind: 'owner' } });
      for (const r of await central('owner.recovery_started', o.id)) for (const re of PROHIBITED) expect(facts(r.payload)).not.toMatch(re);
    });

    it('session.refresh_reuse_detected: the detection is the system\'s, the resource the token\'s user, outcome denied', async () => {
      const m = await t.member(w.orgSchool1, 'reuse@a.test');
      const login = await memberLogin(m);
      await t.http.post('/auth/refresh').send({ refreshToken: login.refreshToken }).expect(200);
      await t.http.post('/auth/refresh').send({ refreshToken: login.refreshToken }).expect(401); // the rotated-out token again
      expect(await one('session.refresh_reuse_detected', m.id)).toMatchObject({
        actor: { type: 'system', id: 'refresh_reuse_detection' }, organizationId: null, resource: { type: 'user', id: m.id }, outcome: 'denied',
      });
    });
  });

  describe('atomicity: the Auth change, its local record and its central intent commit or roll back together', () => {
    it('an outbox failure rolls back the block (the operator stays active, sessions untouched, no local record); the retry writes once', async () => {
      owner.tokens = await t.ownerLogin(owner, owner.totpSecret); // earlier tests advanced the fake clock past the access-token lifetime
      const op = await t.operator(w.companyA, 'op-atomic@a.test');
      await t.db.query(`CREATE OR REPLACE FUNCTION s187_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox refused (test)'; END $$`);
      await t.db.query(`CREATE TRIGGER s187_refuse BEFORE INSERT ON outbox FOR EACH ROW WHEN (NEW.name = 'audit.account.disabled') EXECUTE FUNCTION s187_refuse()`);
      try {
        await t.http.post(`/auth/admin/operators/${op.id}/block`).set(bearer(owner.tokens)).expect(500);
        expect((await t.db.query(`SELECT "isActive" FROM "user" WHERE id=$1`, [op.id])).rows[0].isActive).toBe(true);
        expect((await t.db.query(`SELECT count(*)::int n FROM auth_audit_event WHERE type='account.disabled' AND "targetId"=$1`, [op.id])).rows[0].n).toBe(0);
      } finally {
        await t.db.query('DROP TRIGGER IF EXISTS s187_refuse ON outbox');
      }
      await t.http.post(`/auth/admin/operators/${op.id}/block`).set(bearer(owner.tokens)).expect(204);
      expect(await central('account.disabled', op.id)).toHaveLength(1);
      expect((await t.db.query(`SELECT "isActive" FROM "user" WHERE id=$1`, [op.id])).rows[0].isActive).toBe(false);
    });

    it('a failed decision writes nothing: a 409 (already decided) leaves no central event', async () => {
      const admin = await orgAdmin(w.orgSchool1);
      const p = await t.member(w.orgSchool1, 'twice@a.test', undefined, 'student', 'pending');
      const mid = await membershipOf(p.id, w.orgSchool1);
      await t.http.post(`/auth/organizations/${w.orgSchool1}/memberships/${mid}/approve`).set(bearer(admin.tokens)).expect(200);
      await t.http.post(`/auth/organizations/${w.orgSchool1}/memberships/${mid}/approve`).set(bearer(admin.tokens)).expect(409);
      expect(await central('membership.approved', mid)).toHaveLength(1);
    });
  });

  it('every central row of this suite is valid for the contract and free of contact, network and secret data; nothing leaves on the legacy exchange', async () => {
    const rows = (await t.db.query(`SELECT name, payload FROM outbox`)).rows as Row[];
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect(r.name).toBe(`audit.${r.payload.action}`);
      expect(() => validateAuditPayload(r.payload, 'auth-service')).not.toThrow();
      for (const re of PROHIBITED) expect(facts(r.payload), r.name).not.toMatch(re);
    }
    expect(t.bus.events.filter((e) => e.key.startsWith('audit.'))).toEqual([]); // central audit never rides the fire-and-forget bus
  });
});
