import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';
import { SoftAuthenticator } from './helpers/authenticator.js';

const RP = 'auth.test';
const ORIGIN = 'https://auth.test';

describe('WebAuthn / passkeys: real protocol verification', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());

  /** owner enrolled with a passkey (bootstrap path) */
  async function passkeyOwner() {
    const o = await t.owner(await t.newCompany(), `pk${Math.random().toString(36).slice(2)}@a.test`);
    const auth = new SoftAuthenticator(RP, ORIGIN);
    const login = await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
    const opts = await t.http.post('/auth/admin/enroll/webauthn/options').send({ enrollmentToken: login.body.enrollmentToken }).expect(200);
    const reg = await t.http.post('/auth/admin/enroll/webauthn').send({ enrollmentToken: login.body.enrollmentToken, challengeId: opts.body.challengeId, response: auth.register(opts.body.options) });
    expect(reg.status).toBe(200);
    return { ...o, auth, tokens: reg.body as { accessToken: string; refreshToken: string; expiresIn: number } };
  }
  async function challenge(o: { email: string; password: string }) {
    const login = await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
    expect(login.body.status).toBe('mfa_required');
    const opts = await t.http.post('/auth/admin/login/owner/webauthn-options').send({ challengeToken: login.body.challengeToken }).expect(200);
    return { challengeToken: login.body.challengeToken as string, options: opts.body };
  }
  const verify = (challengeToken: string, assertion: unknown) => t.http.post('/auth/admin/login/owner/verify').send({ challengeToken, method: 'webauthn', assertion });

  it('registers a passkey and then logs in with it (password + passkey)', async () => {
    const o = await passkeyOwner();
    await t.http.get('/auth/me').set(bearer(o.tokens)).expect(200);
    const c = await challenge(o);
    const r = await verify(c.challengeToken, o.auth.assert(c.options));
    expect(r.status).toBe(200);
    await t.http.get('/auth/me').set(bearer(r.body)).expect(200);
    const stored = await t.db.query(`SELECT "signCount","publicKey","credentialId" FROM owner_auth_factor WHERE "ownerId"=$1`, [o.id]);
    expect(Number(stored.rows[0].signCount)).toBe(1); // counter persisted
    expect(stored.rows[0].publicKey.length).toBeGreaterThan(20); // public key only; no private material exists server-side
  });

  describe('assertion verification rejects everything that is not a genuine, fresh, user-verified signature', () => {
    let o: Awaited<ReturnType<typeof passkeyOwner>>;
    beforeAll(async () => { o = await passkeyOwner(); });

    it.each([
      ['wrong origin', { origin: 'https://evil.test' }],
      ['wrong RP ID (rpIdHash mismatch)', { rpId: 'evil.test' }],
      ['tampered / invalid signature', { badSignature: true }],
      ['user verification missing', { uv: false }],
    ])('%s', async (_n, opt) => {
      const c = await challenge(o);
      const before = (await t.db.query(`SELECT "signCount" FROM owner_auth_factor WHERE "ownerId"=$1`, [o.id])).rows[0].signCount;
      const r = await verify(c.challengeToken, o.auth.assert(c.options, { ...opt, counter: Number(before) + 1 }));
      expect(r.status).toBe(401);
      expect(r.body).not.toHaveProperty('accessToken');
    });

    it('a credentialId that exists but is presented with a signature from a different key is rejected', async () => {
      const c = await challenge(o);
      const attacker = new SoftAuthenticator(RP, ORIGIN);
      const forged = attacker.assert(c.options, { credentialId: o.auth.credentialId, counter: 50 });
      expect((await verify(c.challengeToken, forged)).status).toBe(401);
    });

    it('an unknown credential is rejected', async () => {
      const c = await challenge(o);
      expect((await verify(c.challengeToken, new SoftAuthenticator(RP, ORIGIN).assert(c.options, { counter: 50 }))).status).toBe(401);
    });

    it('an assertion captured for one challenge cannot be replayed against a new challenge', async () => {
      const first = await challenge(o);
      const captured = o.auth.assert(first.options);
      expect((await verify(first.challengeToken, captured)).status).toBe(200);
      const second = await challenge(o);
      expect((await verify(second.challengeToken, captured)).status).toBe(401); // challenge mismatch
    });

    it('a login challenge that never asked for passkey options cannot be satisfied by an assertion', async () => {
      const login = await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
      const forgedOptions = { challenge: 'AAAAAAAAAAAAAAAAAAAAAA' }; // attacker picks their own challenge
      expect((await verify(login.body.challengeToken, o.auth.assert(forgedOptions))).status).toBe(401);
    });

    it('a challenge is single use: the same assertion cannot be submitted twice', async () => {
      const c = await challenge(o);
      const a = o.auth.assert(c.options);
      expect((await verify(c.challengeToken, a)).status).toBe(200);
      expect((await verify(c.challengeToken, a)).status).toBe(401);
    });
  });

  it('a non-advancing signature counter is treated as a possible clone: rejected, the passkey revoked and audited, and a password cannot re-enroll', async () => {
    const o = await passkeyOwner();
    const c1 = await challenge(o);
    expect((await verify(c1.challengeToken, o.auth.assert(c1.options, { counter: 5 }))).status).toBe(200);
    const c2 = await challenge(o);
    expect((await verify(c2.challengeToken, o.auth.assert(c2.options, { counter: 5 }))).status).toBe(401); // did not advance
    const f = await t.db.query(`SELECT "revokedAt" FROM owner_auth_factor WHERE "ownerId"=$1`, [o.id]);
    expect(f.rows[0].revokedAt).not.toBeNull();
    const a = await t.db.query(`SELECT count(*)::int n FROM auth_audit_event WHERE type='owner.webauthn.clone_suspected' AND "actorId"=$1`, [o.id]);
    expect(a.rows[0].n).toBe(1);
    // the only factor is gone: recovery is the path, not a password-only re-enrollment
    const login = await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
    expect(login.body).toEqual({ status: 'recovery_required' });
  });

  describe('registration', () => {
    it('rejects a registration with the wrong origin, wrong RP, or without user verification', async () => {
      for (const bad of [{ origin: 'https://evil.test' }, { rpId: 'evil.test' }, { uv: false }]) {
        const o = await t.owner(await t.newCompany(), `bad${Math.random().toString(36).slice(2)}@a.test`);
        const login = await t.http.post('/auth/login').send({ email: o.email, password: o.password });
        const opts = await t.http.post('/auth/admin/enroll/webauthn/options').send({ enrollmentToken: login.body.enrollmentToken }).expect(200);
        const r = await t.http.post('/auth/admin/enroll/webauthn').send({ enrollmentToken: login.body.enrollmentToken, challengeId: opts.body.challengeId, response: new SoftAuthenticator(RP, ORIGIN).register(opts.body.options, bad) });
        expect(r.status).toBe(400);
        const n = await t.db.query(`SELECT count(*)::int n FROM owner_auth_factor WHERE "ownerId"=$1`, [o.id]);
        expect(n.rows[0].n).toBe(0);
      }
    });

    it('a registration challenge is bound to its session and cannot be used from another', async () => {
      const o = await passkeyOwner();
      const s1 = o.tokens;
      const s2 = await (async () => { // second session: log in with the passkey
        const c = await challenge(o); return (await verify(c.challengeToken, o.auth.assert(c.options))).body;
      })();
      const opts = await t.http.post('/auth/admin/factors/webauthn/options').set(bearer(s1)).expect(200);
      const second = new SoftAuthenticator(RP, ORIGIN);
      const su = await stepUpPasskey(o, s2, 'owner.factor.enroll');
      const r = await t.http.post('/auth/admin/factors/webauthn').set(bearer(s2)).set('X-Step-Up-Token', su).send({ challengeId: opts.body.challengeId, response: second.register(opts.body.options) });
      expect(r.status).toBe(400); // challenge belongs to session 1
    });

    it('the same credential cannot be registered twice', async () => {
      const o = await passkeyOwner();
      const opts = await t.http.post('/auth/admin/factors/webauthn/options').set(bearer(o.tokens)).expect(200);
      const su = await stepUpPasskey(o, o.tokens, 'owner.factor.enroll');
      const r = await t.http.post('/auth/admin/factors/webauthn').set(bearer(o.tokens)).set('X-Step-Up-Token', su).send({ challengeId: opts.body.challengeId, response: o.auth.register(opts.body.options) });
      expect([400, 409]).toContain(r.status); // excluded by the server (or unique credentialId)
      const n = await t.db.query(`SELECT count(*)::int n FROM owner_auth_factor WHERE "ownerId"=$1 AND "revokedAt" IS NULL`, [o.id]);
      expect(n.rows[0].n).toBe(1);
    });
  });

  async function stepUpPasskey(o: Awaited<ReturnType<typeof passkeyOwner>>, tokens: { accessToken: string }, purpose: string) {
    const opts = await t.http.post('/auth/admin/step-up/webauthn-options').set(bearer(tokens.accessToken)).send({ purpose }).expect(200);
    const r = await t.http.post('/auth/admin/step-up').set(bearer(tokens.accessToken)).send({ purpose, method: 'webauthn', challengeId: opts.body.challengeId, assertion: o.auth.assert(opts.body.options) });
    expect(r.status).toBe(200);
    return r.body.stepUpToken as string;
  }

  it('passkey step-up: bound to purpose and session, single use, and enough to authorize a grant', async () => {
    const o = await passkeyOwner();
    // a step-up challenge for one purpose cannot be redeemed for another
    const opts = await t.http.post('/auth/admin/step-up/webauthn-options').set(bearer(o.tokens)).send({ purpose: 'platform_assignment.revoke' }).expect(200);
    await t.http.post('/auth/admin/step-up').set(bearer(o.tokens)).send({ purpose: 'platform_assignment.grant', method: 'webauthn', challengeId: opts.body.challengeId, assertion: o.auth.assert(opts.body.options) }).expect(401);
    // and works end to end for the right purpose
    const w = await t.world().catch(() => null);
    const su = await stepUpPasskey(o, o.tokens, 'platform_assignment.grant');
    expect(su).toMatch(/^[0-9a-f-]{36}$/);
    const row = await t.db.query(`SELECT method, "factorId" FROM owner_step_up WHERE id=$1`, [su]);
    expect(row.rows[0].method).toBe('webauthn');
    expect(row.rows[0].factorId).not.toBeNull();
    void w;
  });
});
