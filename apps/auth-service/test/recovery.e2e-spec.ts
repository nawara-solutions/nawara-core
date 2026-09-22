import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, noReqId, type TestCtx } from './helpers/app.js';

describe('owner recovery (MFA must not be bypassable)', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());

  async function ownerWithKey() {
    const cid = await t.newCompany();
    const owner = await t.readyOwner(cid, `rec${Math.random().toString(36).slice(2)}@a.test`);
    const rot = await t.stepUpToken(owner.tokens, 'owner.secret_key.rotate', owner.totpSecret);
    const key = (await t.http.post('/auth/admin/secret-key/rotate').set(bearer(owner.tokens)).set('X-Step-Up-Token', rot).expect(200)).body.secretKey as string;
    return { ...owner, key };
  }
  const start = (o: { email: string; password: string; key?: string }, over: Record<string, unknown> = {}) =>
    t.http.post('/auth/admin/recovery/start').send({ email: o.email, password: o.password, secretKey: o.key, ...over });

  it('password only, key only, or a wrong pair can NOT even start recovery (same generic 401)', async () => {
    const o = await ownerWithKey();
    const a = await start(o, { secretKey: 'AAAA-AAAA' }); // password only (key wrong)
    const b = await start(o, { password: 'not the password' }); // key only (password wrong)
    const c = await start({ email: 'ghost@a.test', password: o.password, key: o.key }); // unknown account
    for (const r of [a, b, c]) expect(r.status).toBe(401);
    expect(noReqId(a.body)).toEqual(noReqId(b.body));
    expect(noReqId(b.body)).toEqual(noReqId(c.body));
    const n = await t.db.query(`SELECT count(*)::int n FROM owner_recovery_request WHERE "ownerId"=$1`, [o.id]);
    expect(n.rows[0].n).toBe(0);
  });

  it('starting recovery changes NOTHING: factors, sessions, key and MFA all stay intact, and the owner is alerted', async () => {
    const o = await ownerWithKey();
    const r = await start(o).expect(202);
    expect(r.body.recoveryToken).toBeTruthy();
    // MFA still fully enforced: a correct password still only gets a challenge
    const login = await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
    expect(login.body.status).toBe('mfa_required');
    await t.http.get('/auth/me').set(bearer(o.tokens)).expect(200); // existing session untouched
    const f = await t.db.query(`SELECT count(*)::int n FROM owner_auth_factor WHERE "ownerId"=$1 AND "revokedAt" IS NULL`, [o.id]);
    expect(f.rows[0].n).toBe(1);
    const k = await t.db.query(`SELECT "secretKeyHash" FROM owner WHERE "userId"=$1`, [o.id]);
    expect(k.rows[0].secretKeyHash).not.toBeNull();
    expect(t.bus.last('admin.owner_recovery_requested')).toMatchObject({ userId: o.id, destination: o.email });
  });

  it('completion is refused during the cool-down, and still changes nothing', async () => {
    const o = await ownerWithKey();
    const { recoveryToken } = (await start(o).expect(202)).body;
    t.clock.advance(60 * 1000);
    await t.http.post('/auth/admin/recovery/complete').send({ recoveryToken, secretKey: o.key }).expect(403);
    const f = await t.db.query(`SELECT count(*)::int n FROM owner_auth_factor WHERE "ownerId"=$1 AND "revokedAt" IS NULL`, [o.id]);
    expect(f.rows[0].n).toBe(1);
    await t.http.get('/auth/me').set(bearer(o.tokens)).expect(200);
  });

  it('the recovery token alone is not enough: it needs the secret key again', async () => {
    const o = await ownerWithKey();
    const { recoveryToken } = (await start(o).expect(202)).body;
    t.clock.advance(3601 * 1000);
    await t.http.post('/auth/admin/recovery/complete').send({ recoveryToken, secretKey: 'AAAA-AAAA-AAAA' }).expect(401);
    await t.http.post('/auth/admin/recovery/complete').send({ recoveryToken: 'x'.repeat(43), secretKey: o.key }).expect(401);
  });

  it('after the cool-down it revokes every factor and session, spends the key, and returns ONLY an enrollment token', async () => {
    const o = await ownerWithKey();
    const { recoveryToken } = (await start(o).expect(202)).body;
    t.clock.advance(3601 * 1000);
    const done = await t.http.post('/auth/admin/recovery/complete').send({ recoveryToken, secretKey: o.key }).expect(200);
    expect(done.body.status).toBe('enrollment_required');
    for (const k of ['accessToken', 'refreshToken']) expect(done.body).not.toHaveProperty(k); // never a session
    await t.http.get('/auth/me').set(bearer(o.tokens)).expect(401); // old session gone
    // the enrollment token grants no privileged access whatsoever
    await t.http.get('/auth/me').set(bearer(done.body.enrollmentToken)).expect(401);
    await t.http.post('/auth/admin/step-up').set(bearer(done.body.enrollmentToken)).send({ purpose: 'platform_assignment.grant', method: 'secret_key', secretKey: o.key }).expect(401);
    // the old TOTP factor is dead and the key is spent (cannot start another recovery, cannot step up)
    // a bare PASSWORD must not be able to enroll a factor now: that path is recovery only
    const login = await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
    expect(login.body).toEqual({ status: 'recovery_required' });
    await start(o).expect(401);
    const key = await t.db.query(`SELECT "secretKeyHash" FROM owner WHERE "userId"=$1`, [o.id]);
    expect(key.rows[0].secretKeyHash).toBeNull();
    // the request cannot be replayed
    await t.http.post('/auth/admin/recovery/complete').send({ recoveryToken, secretKey: o.key }).expect(401);
    // finally the owner re-enrolls through the restricted token and only THEN gets a session
    const begin = await t.http.post('/auth/admin/enroll/totp').send({ enrollmentToken: done.body.enrollmentToken }).expect(200);
    const s = await t.http.post('/auth/admin/enroll/totp/confirm').send({ enrollmentToken: done.body.enrollmentToken, factorId: begin.body.factorId, code: t.nextCode(begin.body.secret) }).expect(200);
    await t.http.get('/auth/me').set(bearer(s.body)).expect(200);
    // the OLD authenticator no longer works
    const c = await t.http.post('/auth/login').send({ email: o.email, password: o.password });
    await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: c.body.challengeToken, method: 'totp', code: t.nextCode(o.totpSecret) }).expect(401);
  });

  it('the real owner, alerted, can cancel from a session that still has a working factor — the attacker’s request then dies', async () => {
    const o = await ownerWithKey();
    const { recoveryToken } = (await start(o).expect(202)).body; // "attacker" with password + key
    const legit = await t.ownerLogin(o, o.totpSecret); // real owner still logs in with MFA
    await t.http.post('/auth/admin/recovery/cancel').set(bearer(legit)).expect(204);
    await t.http.get('/auth/me').set(bearer(legit)).expect(200); // the real owner keeps working
    t.clock.advance(3601 * 1000);
    await t.http.post('/auth/admin/recovery/complete').send({ recoveryToken, secretKey: o.key }).expect(401);
    const st = await t.db.query(`SELECT status FROM owner_recovery_request WHERE "ownerId"=$1`, [o.id]);
    expect(st.rows[0].status).toBe('cancelled');
  });

  it('a stolen SESSION cannot recover or weaken authentication: every account change needs a FACTOR, never the key', async () => {
    const o = await ownerWithKey();
    const stolen = o.tokens;
    // cannot start recovery without password + key
    await t.http.post('/auth/admin/recovery/start').set(bearer(stolen)).send({ email: o.email }).expect(400);
    // cannot rotate the key / change password / add a factor / remove the factor using ONLY the key as step-up
    for (const purpose of ['owner.secret_key.rotate', 'owner.password.change', 'owner.factor.enroll', 'owner.factor.remove']) {
      await t.http.post('/auth/admin/step-up').set(bearer(stolen)).send({ purpose, method: 'secret_key', secretKey: o.key }).expect(400);
    }
    // ...and without any step-up the operations themselves are refused
    await t.http.post('/auth/admin/secret-key/rotate').set(bearer(stolen)).expect(403);
    await t.http.post('/auth/admin/password/change').set(bearer(stolen)).send({ newPassword: 'attacker chosen pw' }).expect(403);
    const list = await t.http.get('/auth/admin/factors').set(bearer(stolen)).expect(200);
    await t.http.delete(`/auth/admin/factors/${list.body[0].id}`).set(bearer(stolen)).expect(403);
    const begin = await t.http.post('/auth/admin/factors/totp').set(bearer(stolen)).expect(200);
    await t.http.post('/auth/admin/factors/totp/confirm').set(bearer(stolen)).send({ factorId: begin.body.factorId, code: t.nextCode(begin.body.secret) }).expect(403);
  });

  it('recovery is rate limited and every stage is audited without secrets', async () => {
    const r = await createTestApp({ RATE_RECOVERY_IDENTIFIER_LIMIT: '2' });
    try {
      const ww = await r.world();
      const o = await r.owner(ww.companyA, 'rr@a.test');
      for (let i = 0; i < 2; i++) await r.http.post('/auth/admin/recovery/start').send({ email: o.email, password: 'nope nope nope', secretKey: 'AAAA' }).expect(401);
      await r.http.post('/auth/admin/recovery/start').send({ email: o.email, password: o.password, secretKey: 'AAAA' }).expect(429);
    } finally { await r.close(); }
    const audit = await t.db.query(`SELECT type, outcome, metadata::text m FROM auth_audit_event WHERE type LIKE 'owner.recovery.%'`);
    expect(audit.rowCount).toBeGreaterThan(3);
    expect(audit.rows.map((x) => x.type)).toEqual(expect.arrayContaining(['owner.recovery.start', 'owner.recovery.complete', 'owner.recovery.cancel']));
    expect(audit.rows.map((x) => x.m).join('')).not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/);
  });
});

describe('enrollment cannot be reached with a password alone once a factor has existed', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());

  it('a stale enrollment token issued before a revocation is dead, and a password never re-opens enrollment', async () => {
    const cid = await t.newCompany();
    const o = await t.owner(cid, 'stale-enroll@a.test');
    // attacker (or anyone) holding only the password grabs an enrollment token while the owner is un-enrolled...
    const stale = (await t.http.post('/auth/login').send({ email: o.email, password: o.password })).body.enrollmentToken;
    // ...the legitimate owner then enrolls, and later that factor is revoked (e.g. clone detection)
    const e = await t.enrollFirstTotp(o);
    await t.db.query(`UPDATE owner_auth_factor SET "revokedAt"=now() WHERE id=$1`, [e.factorId]);
    await t.http.post('/auth/admin/enroll/totp').send({ enrollmentToken: stale }).expect(401);
    const again = await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
    expect(again.body).toEqual({ status: 'recovery_required' });
  });
});
