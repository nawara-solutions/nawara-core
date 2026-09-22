import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, noReqId, type TestCtx } from './helpers/app.js';

describe('members, and commercial independence (authentication is not entitlement)', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let code: string; // an auto-approved "student" code for orgSchool1
  beforeAll(async () => {
    t = await createTestApp();
    w = await t.world();
    code = (await t.joinCode(w.orgSchool1, { audience: 'student', requiresApproval: false, requiresSubscription: true })).code;
  });
  afterAll(() => t.close());

  const reg = (over: Record<string, unknown> = {}) =>
    t.http.post('/auth/register').send({ email: `m${Math.random().toString(36).slice(2)}@a.test`, password: 'member password 1', joinCode: code, ...over });

  it('registers a member (kind=member, in exactly one organization) from a join code and starts a session', async () => {
    const r = await reg({ email: 'reg@a.test' });
    expect(r.status).toBe(201);
    const row = await t.db.query(`SELECT u.kind, u.role, m."organizationId", m.audience FROM "user" u JOIN organization_membership m ON m."userId" = u.id WHERE u.email='reg@a.test'`);
    // all resolved server-side; the identity has NO organization and NO business role: the label lives on the membership
    expect(row.rows[0]).toEqual({ kind: 'member', role: 'member', organizationId: w.orgSchool1, audience: 'student' });
    expect(t.bus.last('user.registered')).toMatchObject({ role: 'student', organizationId: w.orgSchool1 });
    expect(r.body.onboarding).toMatchObject({ audience: 'student', membershipStatus: 'active', requiresSubscription: true });
    await t.http.get('/auth/me').set(bearer(r.body)).expect(200);
  });

  it('a member can authenticate with a phone number and password', async () => {
    await reg({ email: undefined, phone: '+21612345678' }).expect(201);
    const l = await t.http.post('/auth/login').send({ phone: '+216 12 345 678', password: 'member password 1' }).expect(200);
    await t.http.get('/auth/me').set(bearer(l.body)).expect(200);
  });

  it('the client cannot choose organization, platform, audience, role or kind: every such field is rejected', async () => {
    const extras: Array<Record<string, unknown>> = [
      { organizationId: w.orgSchool2 }, { platformId: w.platformDrive }, { audience: 'teacher' }, { role: 'teacher' }, { role: 'admin' },
      { kind: 'owner' }, { adminTier: 'owner' }, { companyId: w.companyA }, { isActive: true }, { status: 'active' },
    ];
    for (const extra of extras) await reg(extra).expect(400);
    const n = await t.db.query(`SELECT count(*)::int n FROM "user" WHERE kind='member' AND role IN ('admin','teacher')`);
    expect(n.rows[0].n).toBe(0);
  });

  it('a bad, malformed and exhausted code all give the same generic 403 (nothing is revealed)', async () => {
    const exhausted = await t.joinCode(w.orgSchool1, { maxUses: 1 });
    await reg({ joinCode: exhausted.code }).expect(201);
    const results = [
      await reg({ joinCode: 'ABCDE-FGHJK' }), // well-formed but unknown
      await reg({ joinCode: 'not a code' }), // malformed
      await reg({ joinCode: exhausted.code }),
    ];
    for (const r of results) expect(r.status).toBe(403);
    for (const r of results.slice(1)) expect(noReqId(r.body)).toEqual(noReqId(results[0].body));
  });

  it('registration and every membership rule keep working with no commercial subscription/license concept configured', async () => {
    // Registration has no Payment/Billing/Entitlement dependency at all (Stage 11/12 decoupling): the
    // running app was booted with no PAYMENT_SERVICE_URL/PAYMENT_SERVICE_TOKEN and no such client exists
    // in its dependency graph (see app.module.ts). `requiresSubscription` on the code is a passthrough
    // hint only and never gates registration, whichever value it carries.
    expect(Object.keys(t.cfg)).not.toContain('payment');
    const noSub = await t.joinCode(w.orgSchool1, { requiresSubscription: false });
    const withSub = await t.joinCode(w.orgSchool1, { requiresSubscription: true });
    await reg({ email: 'nosub@a.test', joinCode: noSub.code }).expect(201);
    await reg({ email: 'withsub@a.test', joinCode: withSub.code }).expect(201);
  });

  it('LOGIN AND REFRESH remain independent of any commercial state', async () => {
    await reg({ email: 'lapse@a.test' }).expect(201);
    const login = await t.http.post('/auth/login').send({ email: 'lapse@a.test', password: 'member password 1' });
    expect(login.status).toBe(200); // identity still authenticates
    const ref = await t.http.post('/auth/refresh').send({ refreshToken: login.body.refreshToken });
    expect(ref.status).toBe(200);
    await t.http.get('/auth/me').set(bearer(ref.body)).expect(200);
  });

  it('auth-service holds no entitlement STATE: no license/subscription/trial/plan/billing column, only the onboarding hint flag', async () => {
    const cols = await t.db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND column_name ~* '(subscri|licen|trial|billing|payment|plan|entitle)'`);
    // The join code carries ONE non-authoritative hint the app shows ("you will need a subscription");
    // nothing is stored about any subscription, license or payment (ADR-0028).
    expect(cols.rows).toEqual([{ table_name: 'organization_join_code', column_name: 'requiresSubscription' }]);
    const me = await reg({ email: 'noent@a.test' }).expect(201);
    const body = (await t.http.get('/auth/me').set(bearer(me.body)).expect(200)).body;
    expect(Object.keys(body).join(',')).not.toMatch(/subscri|licen|trial|plan|entitle/i);
    const claims = JSON.parse(Buffer.from(me.body.accessToken.split('.')[1], 'base64url').toString());
    expect(Object.keys(claims).join(',')).not.toMatch(/subscri|licen|trial|plan|entitle|platform|company/i);
  });

  it('duplicate identities are refused (and spend no use of the code); weak or oversized passwords are rejected', async () => {
    const c = await t.joinCode(w.orgSchool1, { maxUses: 5 });
    const used = async () => (await t.db.query(`SELECT "usedCount" FROM organization_join_code WHERE id=$1`, [c.id])).rows[0].usedCount as number;
    await reg({ email: 'dup@a.test', joinCode: c.code }).expect(201);
    expect(await used()).toBe(1);
    await reg({ email: 'dup@a.test', joinCode: c.code }).expect(409);
    expect(await used()).toBe(1); // the failed registration rolled its use back
    await reg({ password: 'short' }).expect(400);
    await reg({ password: 'x'.repeat(73) }).expect(400); // bcrypt only reads 72 bytes: never silently truncate
  });

  it('a member’s failed login is generic and rate limited', async () => {
    const a = await t.http.post('/auth/login').send({ email: 'reg@a.test', password: 'wrong password' });
    const b = await t.http.post('/auth/login').send({ email: 'ghost@a.test', password: 'wrong password' });
    expect(a.status).toBe(401);
    expect(noReqId(a.body)).toEqual(noReqId(b.body));
  });

  it('platform-specific audience labels stay opaque to auth (any valid label is stored as the role, none is interpreted)', async () => {
    for (const audience of ['teacher', 'student', 'manager', 'school_admin']) {
      const c = await t.joinCode(w.orgSchool1, { audience });
      await reg({ joinCode: c.code }).expect(201);
    }
    const labels = await t.db.query(`SELECT DISTINCT audience FROM organization_membership`);
    expect(labels.rows.map((r) => r.audience)).toEqual(expect.arrayContaining(['teacher', 'manager', 'school_admin']));
    const roles = await t.db.query(`SELECT DISTINCT role FROM "user" WHERE kind='member'`);
    expect(roles.rows.map((r) => r.role)).toEqual(['member']); // no business label on any identity
    // and having such a label grants nothing in auth's management surface
    const c = await t.joinCode(w.orgSchool1, { audience: 'school_admin' });
    const m = await reg({ joinCode: c.code });
    await t.http.get(`/auth/platform-access/${w.platformSchool}`).set(bearer(m.body)).expect(403);
  });
});
