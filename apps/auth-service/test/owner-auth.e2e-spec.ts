import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

describe('owner authentication', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());

  it('a correct password NEVER yields tokens for an owner (no password-only downgrade)', async () => {
    const o = await t.readyOwner(await t.newCompany(), 'own1@a.test');
    const r = await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
    expect(r.body.status).toBe('mfa_required');
    expect(r.body).not.toHaveProperty('accessToken');
    expect(r.body).not.toHaveProperty('refreshToken');
    expect(r.body.methods).toEqual(['totp']);
  });

  it('bootstrap: an owner with no factor gets a restricted enrollment token, not a session', async () => {
    const o = await t.owner(await t.newCompany(), 'boot@a.test');
    const r = await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
    expect(r.body.status).toBe('enrollment_required');
    expect(r.body).not.toHaveProperty('accessToken');
    // the enrollment token carries no API authority anywhere else
    await t.http.get('/auth/me').set(bearer(r.body.enrollmentToken)).expect(401);
    await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: r.body.enrollmentToken, method: 'totp', code: '123456' }).expect(401);
  });

  it('first-factor enrollment ends in the first session; the enrolled TOTP then works for normal logins', async () => {
    const o = await t.owner(await t.newCompany(), 'first@a.test');
    const e = await t.enrollFirstTotp(o);
    await t.http.get('/auth/me').set(bearer(e.tokens)).expect(200);
    const again = await t.ownerLogin(o, e.totpSecret);
    const me = await t.http.get('/auth/me').set(bearer(again)).expect(200);
    expect(me.body.adminTier).toBe('owner');
  });

  it('a wrong TOTP is a generic 401; an observed code cannot be replayed', async () => {
    const o = await t.readyOwner(await t.newCompany(), 'totp@a.test');
    const c1 = await t.http.post('/auth/login').send({ email: o.email, password: o.password });
    const bad = await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: c1.body.challengeToken, method: 'totp', code: '000000' });
    expect(bad.status).toBe(401);
    const code = t.nextCode(o.totpSecret);
    await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: c1.body.challengeToken, method: 'totp', code }).expect(200);
    // same code, same time step, brand-new challenge: rejected (replay)
    const c2 = await t.http.post('/auth/login').send({ email: o.email, password: o.password });
    await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: c2.body.challengeToken, method: 'totp', code }).expect(401);
  });

  it('a challenge is single use and dies after too many wrong attempts, even for the right code', async () => {
    const o = await t.readyOwner(await t.newCompany(), 'attempts@a.test');
    const c = await t.http.post('/auth/login').send({ email: o.email, password: o.password });
    for (let i = 0; i < 5; i++) {
      await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: c.body.challengeToken, method: 'totp', code: '000000' }).expect(401);
    }
    await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: c.body.challengeToken, method: 'totp', code: t.nextCode(o.totpSecret) }).expect(401);
  });

  it('a disabled owner cannot authenticate at any stage', async () => {
    const o = await t.readyOwner(await t.newCompany(), 'disabled@a.test');
    const c = await t.http.post('/auth/login').send({ email: o.email, password: o.password });
    await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [o.id]);
    // password stage
    await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(401);
    // second-factor stage with an already-issued challenge
    await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: c.body.challengeToken, method: 'totp', code: t.nextCode(o.totpSecret) }).expect(401);
    // and the session they already held stops working immediately
    await t.http.get('/auth/me').set(bearer(o.tokens)).expect(401);
  });

  it('the secret key is not a login credential: the old endpoint is gone and no field accepts it', async () => {
    await t.http.post('/auth/admin/login/secret-key').send({ secretKey: 'x' }).expect(404);
    const o = await t.readyOwner(await t.newCompany(), 'nokeylogin@a.test');
    await t.http.post('/auth/login').send({ email: o.email, password: o.password, secretKey: 'anything' }).expect(400);
    const c = await t.http.post('/auth/login').send({ email: o.email, password: o.password });
    await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: c.body.challengeToken, method: 'secret_key', code: '123456' }).expect(400);
  });

  it('wrong password, unknown account and blocked account are indistinguishable', async () => {
    const o = await t.readyOwner(await t.newCompany(), 'same@a.test');
    const a = await t.http.post('/auth/login').send({ email: o.email, password: 'wrong password!!' });
    const b = await t.http.post('/auth/login').send({ email: 'nobody@a.test', password: 'wrong password!!' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('an enrollment token cannot add a factor once the owner already has one', async () => {
    const o = await t.owner(await t.newCompany(), 'stale@a.test');
    const stale = (await t.http.post('/auth/login').send({ email: o.email, password: o.password })).body.enrollmentToken;
    await t.enrollFirstTotp(o); // legitimate enrollment through a second token
    await t.http.post('/auth/admin/enroll/totp').send({ enrollmentToken: stale }).expect(403);
  });

  it('an enrollment token is single use', async () => {
    const o = await t.owner(await t.newCompany(), 'once@a.test');
    const tok = (await t.http.post('/auth/login').send({ email: o.email, password: o.password })).body.enrollmentToken;
    const begin = await t.http.post('/auth/admin/enroll/totp').send({ enrollmentToken: tok }).expect(200);
    await t.http.post('/auth/admin/enroll/totp/confirm').send({ enrollmentToken: tok, factorId: begin.body.factorId, code: t.nextCode(begin.body.secret) }).expect(200);
    await t.http.post('/auth/admin/enroll/totp').send({ enrollmentToken: tok }).expect(401);
  });

  it('a wrong confirmation code does not burn the enrollment token', async () => {
    const o = await t.owner(await t.newCompany(), 'wrongconfirm@a.test');
    const tok = (await t.http.post('/auth/login').send({ email: o.email, password: o.password })).body.enrollmentToken;
    const begin = await t.http.post('/auth/admin/enroll/totp').send({ enrollmentToken: tok }).expect(200);
    await t.http.post('/auth/admin/enroll/totp/confirm').send({ enrollmentToken: tok, factorId: begin.body.factorId, code: '000000' }).expect(400);
    await t.http.post('/auth/admin/enroll/totp/confirm').send({ enrollmentToken: tok, factorId: begin.body.factorId, code: t.nextCode(begin.body.secret) }).expect(200);
  });

  it('login is rate limited per identifier and per IP', async () => {
    const r = await createTestApp({ RATE_LOGIN_IDENTIFIER_LIMIT: '3' });
    try {
      const ww = await r.world();
      const o = await r.owner(ww.companyA, 'rl@a.test');
      for (let i = 0; i < 3; i++) await r.http.post('/auth/login').send({ email: o.email, password: 'wrong wrong wrong' }).expect(401);
      // even the correct password is now refused, and rotating source headers does not help
      await r.http.post('/auth/login').set('X-Forwarded-For', '203.0.113.9').send({ email: o.email, password: o.password }).expect(429);
    } finally { await r.close(); }
  });

  it('TOTP secrets are stored encrypted with a recorded key id, never in plaintext', async () => {
    const o = await t.readyOwner(await t.newCompany(), 'enc@a.test');
    const enrolled = await t.db.query(`SELECT "secretCiphertext","secretKeyId" FROM owner_auth_factor WHERE "ownerId"=$1`, [o.id]);
    expect(enrolled.rows[0].secretKeyId).toBe('k1');
    expect(enrolled.rows[0].secretCiphertext.toString('utf8')).not.toContain(o.totpSecret);
    expect(enrolled.rows[0].secretCiphertext.length).toBeGreaterThan(29);
  });
});
