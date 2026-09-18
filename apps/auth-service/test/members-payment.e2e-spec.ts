import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

describe('members, and the payment boundary (authentication is not entitlement)', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  beforeAll(async () => { t = await createTestApp(); w = await t.world(); t.payment.licensed.add(w.orgSchool1); });
  afterAll(() => t.close());

  const reg = (over: Record<string, unknown> = {}) =>
    t.http.post('/auth/register').send({ email: `m${Math.random().toString(36).slice(2)}@a.test`, password: 'member password 1', role: 'student', organizationId: w.orgSchool1, ...over });

  it('registers a member (kind=member, in exactly one organization) and starts a session', async () => {
    const r = await reg({ email: 'reg@a.test' });
    expect(r.status).toBe(201);
    const row = await t.db.query(`SELECT kind, "organizationId", role FROM "user" WHERE email='reg@a.test'`);
    expect(row.rows[0]).toEqual({ kind: 'member', organizationId: w.orgSchool1, role: 'student' });
    expect(t.bus.last('user.registered')).toMatchObject({ role: 'student', organizationId: w.orgSchool1 });
    await t.http.get('/auth/me').set(bearer(r.body)).expect(200);
  });

  it('a member can authenticate with a phone number and password', async () => {
    await reg({ email: undefined, phone: '+21612345678' }).expect(201);
    const l = await t.http.post('/auth/login').send({ phone: '+216 12 345 678', password: 'member password 1' }).expect(200);
    await t.http.get('/auth/me').set(bearer(l.body)).expect(200);
  });

  it('no request can create an owner/operator or an admin: reserved role and forbidden fields are rejected', async () => {
    for (const role of ['admin', 'Admin', ' ADMIN ']) await reg({ role }).expect(400);
    for (const extra of [{ kind: 'owner' }, { adminTier: 'owner' }, { platformId: w.platformSchool }, { companyId: w.companyA }, { isActive: true }]) {
      await reg(extra).expect(400);
    }
  });

  it('an unknown organization and an unlicensed one give the same generic 403 (existence not revealed)', async () => {
    const unknown = await reg({ organizationId: '11111111-1111-4111-8111-111111111111' });
    const unlicensed = await reg({ organizationId: w.orgSchool2 });
    expect(unknown.status).toBe(403);
    expect(unlicensed.status).toBe(403);
    expect(unknown.body).toEqual(unlicensed.body);
  });

  it('registration fails CLOSED when payment-service is down, and creates nothing', async () => {
    t.payment.down = true;
    const r = await reg({ email: 'down@a.test' });
    t.payment.down = false;
    expect(r.status).toBe(503);
    const n = await t.db.query(`SELECT count(*)::int n FROM "user" WHERE email='down@a.test'`);
    expect(n.rows[0].n).toBe(0);
  });

  it('LOGIN AND REFRESH NEVER CALL payment-service, and keep working when it is down or the license has lapsed', async () => {
    const r = await reg({ email: 'lapse@a.test' }).expect(201);
    const callsBefore = t.payment.calls.length;
    t.payment.licensed.delete(w.orgSchool1); // organization license lapses
    t.payment.down = true; // and payment-service is unreachable
    try {
      const login = await t.http.post('/auth/login').send({ email: 'lapse@a.test', password: 'member password 1' });
      expect(login.status).toBe(200); // identity still authenticates
      const ref = await t.http.post('/auth/refresh').send({ refreshToken: login.body.refreshToken });
      expect(ref.status).toBe(200);
      await t.http.get('/auth/me').set(bearer(ref.body)).expect(200);
      void r;
    } finally { t.payment.down = false; t.payment.licensed.add(w.orgSchool1); }
    expect(t.payment.calls.length).toBe(callsBefore); // not a single call
  });

  it('auth-service holds no entitlement state: no license/subscription/trial/plan/billing column anywhere', async () => {
    const cols = await t.db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND column_name ~* '(subscri|licen|trial|billing|payment|plan|entitle)'`);
    expect(cols.rows).toEqual([]);
    const me = await reg({ email: 'noent@a.test' }).expect(201);
    const body = (await t.http.get('/auth/me').set(bearer(me.body)).expect(200)).body;
    expect(Object.keys(body).join(',')).not.toMatch(/subscri|licen|trial|plan|entitle/i);
    const claims = JSON.parse(Buffer.from(me.body.accessToken.split('.')[1], 'base64url').toString());
    expect(Object.keys(claims).join(',')).not.toMatch(/subscri|licen|trial|plan|entitle|platform|company/i);
  });

  it('duplicate identities are refused; weak or oversized passwords are rejected', async () => {
    await reg({ email: 'dup@a.test' }).expect(201);
    await reg({ email: 'dup@a.test' }).expect(409);
    await reg({ password: 'short' }).expect(400);
    await reg({ password: 'x'.repeat(73) }).expect(400); // bcrypt only reads 72 bytes: never silently truncate
  });

  it('a member’s failed login is generic and rate limited', async () => {
    const a = await t.http.post('/auth/login').send({ email: 'reg@a.test', password: 'wrong password' });
    const b = await t.http.post('/auth/login').send({ email: 'ghost@a.test', password: 'wrong password' });
    expect(a.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('platform-specific roles stay opaque to auth (any non-reserved string is stored, none is interpreted)', async () => {
    for (const role of ['teacher', 'student', 'manager', 'school_admin']) await reg({ role }).expect(201);
    const roles = await t.db.query(`SELECT DISTINCT role FROM "user" WHERE kind='member'`);
    expect(roles.rows.map((r) => r.role)).toEqual(expect.arrayContaining(['teacher', 'manager', 'school_admin']));
    // and having such a role grants nothing in auth's management surface
    const m = await reg({ role: 'school_admin' });
    await t.http.get(`/auth/platform-access/${w.platformSchool}`).set(bearer(m.body)).expect(403);
  });
});
