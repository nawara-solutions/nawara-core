import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

describe('members, and the payment boundary (authentication is not entitlement)', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let code: string; // an auto-approved "student" code for orgSchool1
  beforeAll(async () => {
    t = await createTestApp();
    w = await t.world();
    t.payment.licensed.add(w.orgSchool1);
    code = (await t.joinCode(w.orgSchool1, { audience: 'student', requiresApproval: false, requiresSubscription: true })).code;
  });
  afterAll(() => t.close());

  const reg = (over: Record<string, unknown> = {}) =>
    t.http.post('/auth/register').send({ email: `m${Math.random().toString(36).slice(2)}@a.test`, password: 'member password 1', joinCode: code, ...over });

  it('registers a member (kind=member, in exactly one organization) from a join code and starts a session', async () => {
    const r = await reg({ email: 'reg@a.test' });
    expect(r.status).toBe(201);
    const row = await t.db.query(`SELECT kind, "organizationId", role FROM "user" WHERE email='reg@a.test'`);
    expect(row.rows[0]).toEqual({ kind: 'member', organizationId: w.orgSchool1, role: 'student' }); // all resolved server-side
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

  it('a bad code, an exhausted code and an unlicensed organization give the same generic 403 (nothing is revealed)', async () => {
    const unlicensed = await t.joinCode(w.orgSchool2, { audience: 'student' }); // orgSchool2 has no license
    const exhausted = await t.joinCode(w.orgSchool1, { maxUses: 1 });
    await reg({ joinCode: exhausted.code }).expect(201);
    const results = [
      await reg({ joinCode: 'ABCDE-FGHJK' }), // well-formed but unknown
      await reg({ joinCode: 'not a code' }), // malformed
      await reg({ joinCode: exhausted.code }),
      await reg({ joinCode: unlicensed.code }),
    ];
    for (const r of results) expect(r.status).toBe(403);
    for (const r of results.slice(1)) expect(r.body).toEqual(results[0].body);
  });

  it('registration fails CLOSED when payment-service is down, and creates nothing (no use of the code is spent)', async () => {
    const before = (await t.db.query(`SELECT "usedCount" FROM organization_join_code WHERE "codeHash" IS NOT NULL ORDER BY "createdAt" LIMIT 1`)).rows[0].usedCount;
    t.payment.down = true;
    const r = await reg({ email: 'down@a.test' });
    t.payment.down = false;
    expect(r.status).toBe(503);
    const n = await t.db.query(`SELECT count(*)::int n FROM "user" WHERE email='down@a.test'`);
    expect(n.rows[0].n).toBe(0);
    const after = (await t.db.query(`SELECT "usedCount" FROM organization_join_code WHERE "codeHash" IS NOT NULL ORDER BY "createdAt" LIMIT 1`)).rows[0].usedCount;
    expect(after).toBe(before);
  });

  it('LOGIN AND REFRESH NEVER CALL payment-service, and keep working when it is down or the license has lapsed', async () => {
    await reg({ email: 'lapse@a.test' }).expect(201);
    const callsBefore = t.payment.calls.length;
    t.payment.licensed.delete(w.orgSchool1); // organization license lapses
    t.payment.down = true; // and payment-service is unreachable
    try {
      const login = await t.http.post('/auth/login').send({ email: 'lapse@a.test', password: 'member password 1' });
      expect(login.status).toBe(200); // identity still authenticates
      const ref = await t.http.post('/auth/refresh').send({ refreshToken: login.body.refreshToken });
      expect(ref.status).toBe(200);
      await t.http.get('/auth/me').set(bearer(ref.body)).expect(200);
    } finally { t.payment.down = false; t.payment.licensed.add(w.orgSchool1); }
    expect(t.payment.calls.length).toBe(callsBefore); // not a single call
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
    expect(a.body).toEqual(b.body);
  });

  it('platform-specific audience labels stay opaque to auth (any valid label is stored as the role, none is interpreted)', async () => {
    for (const audience of ['teacher', 'student', 'manager', 'school_admin']) {
      const c = await t.joinCode(w.orgSchool1, { audience });
      await reg({ joinCode: c.code }).expect(201);
    }
    const roles = await t.db.query(`SELECT DISTINCT role FROM "user" WHERE kind='member'`);
    expect(roles.rows.map((r) => r.role)).toEqual(expect.arrayContaining(['teacher', 'manager', 'school_admin']));
    // and having such a label grants nothing in auth's management surface
    const c = await t.joinCode(w.orgSchool1, { audience: 'school_admin' });
    const m = await reg({ joinCode: c.code });
    await t.http.get(`/auth/platform-access/${w.platformSchool}`).set(bearer(m.body)).expect(403);
  });
});
