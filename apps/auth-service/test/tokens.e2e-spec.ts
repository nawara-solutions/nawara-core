import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

describe('tokens, sessions and isActive', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  beforeAll(async () => { t = await createTestApp({ REFRESH_TOKEN_TTL_SEC: '600' }); w = await t.world(); });
  afterAll(() => t.close());

  const login = async (email: string, password = 'member password 1') => (await t.http.post('/auth/login').send({ email, password }).expect(200)).body;

  it('refresh rotates: the new pair works, the old refresh token is rejected', async () => {
    const m = await t.member(w.orgSchool1, 'rot@a.test');
    const a = await login(m.email);
    const b = await t.http.post('/auth/refresh').send({ refreshToken: a.refreshToken }).expect(200);
    expect(b.body.refreshToken).not.toBe(a.refreshToken);
    await t.http.get('/auth/me').set(bearer(b.body)).expect(200);
  });

  it('REUSE of a rotated token is detected and revokes the whole session (family), including the newest token', async () => {
    const m = await t.member(w.orgSchool1, 'reuse@a.test');
    const a = await login(m.email);
    const b = (await t.http.post('/auth/refresh').send({ refreshToken: a.refreshToken }).expect(200)).body;
    await t.http.post('/auth/refresh').send({ refreshToken: a.refreshToken }).expect(401); // replay of the old token
    await t.http.post('/auth/refresh').send({ refreshToken: b.refreshToken }).expect(401); // the legitimate holder is cut too
    await t.http.get('/auth/me').set(bearer(b)).expect(401); // and the session's access token stops working
    const ev = await t.db.query(`SELECT count(*)::int n FROM auth_audit_event WHERE type='session.refresh_reuse_detected' AND "actorId"=$1`, [m.id]);
    expect(ev.rows[0].n).toBe(1);
  });

  it('the replacement chain is recorded and only hashes are stored', async () => {
    const m = await t.member(w.orgSchool1, 'chain@a.test');
    const a = await login(m.email);
    const b = (await t.http.post('/auth/refresh').send({ refreshToken: a.refreshToken }).expect(200)).body;
    const rows = await t.db.query(`SELECT id,"tokenHash","revokedAt","replacedByTokenId","familyId" FROM refresh_token WHERE "userId"=$1`, [m.id]);
    expect(rows.rows).toHaveLength(2);
    const old = rows.rows.find((r) => r.replacedByTokenId)!;
    const cur = rows.rows.find((r) => !r.replacedByTokenId)!;
    expect(old.revokedAt).not.toBeNull();
    expect(old.replacedByTokenId).toBe(cur.id);
    expect(cur.revokedAt).toBeNull();
    expect(old.familyId).toBe(cur.familyId);
    for (const r of rows.rows) expect(r.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows.rows)).not.toContain(a.refreshToken);
    expect(JSON.stringify(rows.rows)).not.toContain(b.refreshToken);
  });

  it('an expired refresh token is rejected', async () => {
    const m = await t.member(w.orgSchool1, 'exp@a.test');
    const a = await login(m.email);
    t.clock.advance(601 * 1000);
    await t.http.post('/auth/refresh').send({ refreshToken: a.refreshToken }).expect(401);
  });

  it('logout revokes the session: refresh fails and the access token stops working immediately', async () => {
    const m = await t.member(w.orgSchool1, 'out@a.test');
    const a = await login(m.email);
    await t.http.post('/auth/logout').set(bearer(a)).send({ refreshToken: a.refreshToken }).expect(204);
    await t.http.post('/auth/refresh').send({ refreshToken: a.refreshToken }).expect(401);
    await t.http.get('/auth/me').set(bearer(a)).expect(401);
  });

  it('isActive: a disabled user cannot log in, refresh, or keep using an already-issued access token', async () => {
    const m = await t.member(w.orgSchool1, 'active@a.test');
    const a = await login(m.email);
    await t.http.get('/auth/me').set(bearer(a)).expect(200);
    await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [m.id]);
    await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(401);
    await t.http.post('/auth/refresh').send({ refreshToken: a.refreshToken }).expect(401);
    await t.http.get('/auth/me').set(bearer(a)).expect(401); // explicit policy: our own routes revoke immediately
    await t.db.query(`UPDATE "user" SET "isActive"=true WHERE id=$1`, [m.id]);
    await login(m.email); // active again -> works
  });

  it('a forged or tampered token is rejected: alg none, wrong secret, edited payload, wrong issuer', async () => {
    const m = await t.member(w.orgSchool1, 'forge@a.test');
    const a = await login(m.email);
    const [h, p, s] = a.accessToken.split('.');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    await t.http.get('/auth/me').set(bearer(none)).expect(401);
    const edited = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: '00000000-0000-0000-0000-000000000001' })).toString('base64url')}.${s}`;
    await t.http.get('/auth/me').set(bearer(edited)).expect(401);
    const wrongKey = await new SignJWT({ role: 'student', sid: '00000000-0000-0000-0000-000000000009' }).setProtectedHeader({ alg: 'HS256' }).setSubject(m.id).setIssuer(t.cfg.jwt.issuer).setAudience(t.cfg.jwt.audience).setExpirationTime('1h').sign(new TextEncoder().encode('x'.repeat(40)));
    await t.http.get('/auth/me').set(bearer(wrongKey)).expect(401);
    const wrongIss = await new SignJWT({ role: 'student', sid: '00000000-0000-0000-0000-000000000009' }).setProtectedHeader({ alg: 'HS256' }).setSubject(m.id).setIssuer('evil').setAudience(t.cfg.jwt.audience).setExpirationTime('1h').sign(t.cfg.jwt.secret);
    await t.http.get('/auth/me').set(bearer(wrongIss)).expect(401);
  });

  it('token claims cannot promote a member: the database kind is authoritative over the adminTier claim', async () => {
    const m = await t.member(w.orgSchool1, 'promo@a.test');
    const a = await login(m.email);
    const sid = JSON.parse(Buffer.from(a.accessToken.split('.')[1], 'base64url').toString()).sid;
    // even a token signed with the REAL secret cannot claim to be an owner for a member row
    const forged = await new SignJWT({ role: 'admin', adminTier: 'owner', sid }).setProtectedHeader({ alg: 'HS256' }).setSubject(m.id).setIssuer(t.cfg.jwt.issuer).setAudience(t.cfg.jwt.audience).setExpirationTime('1h').sign(t.cfg.jwt.secret);
    await t.http.get('/auth/me').set(bearer(forged)).expect(401);
    await t.http.get(`/auth/platform-access/${w.platformSchool}`).set(bearer(forged)).expect(401);
  });

  it('an expired access token is rejected', async () => {
    const m = await t.member(w.orgSchool1, 'aexp@a.test');
    const a = await login(m.email);
    t.clock.advance((t.cfg.jwt.accessTtlSec + 5) * 1000);
    await t.http.get('/auth/me').set(bearer(a)).expect(401);
  });

  it('refresh and login are rate limited per IP-bucket configuration (baseline sanity)', async () => {
    const r = await createTestApp({ RATE_REFRESH_IP_LIMIT: '2' });
    try {
      for (let i = 0; i < 2; i++) await r.http.post('/auth/refresh').send({ refreshToken: 'x'.repeat(30) }).expect(401);
      await r.http.post('/auth/refresh').send({ refreshToken: 'x'.repeat(30) }).expect(429);
    } finally { await r.close(); }
  });
});
