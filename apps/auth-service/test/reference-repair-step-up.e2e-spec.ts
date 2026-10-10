import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';
import { SoftAuthenticator } from './helpers/authenticator.js';

const uniq = () => Math.random().toString(36).slice(2);
const PURPOSE = 'hierarchy.reference.repair';

/**
 * A5.4-A1 (ADR-0061 §3, §4): the `hierarchy.reference.repair` step-up purpose is declared, factor-only. Auth issues a proof for it
 * with TOTP or a passkey, never with the bare secret key, bound to the owner, the session and the purpose, single use and short-lived.
 * No Auth route consumes it (the repair runtime is A5.4-A3). The existing generic POST /auth/step-up/verify CAN consume it, as it can
 * any listed purpose: that is unchanged behavior of that endpoint, documented here, not a repair capability.
 */
describe('hierarchy.reference.repair step-up purpose (A5.4-A1)', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp(); await t.app.listen(0); });
  afterAll(() => t.close());

  const verify = (tokens: any, purpose: string, stepUpToken: string) =>
    t.http.post('/auth/step-up/verify').set(bearer(tokens)).send({ purpose, stepUpToken });
  const owner = async () => t.readyOwner(await t.newCompany(), `rr${uniq()}@a.test`);

  it('TOTP issues a proof for the purpose', async () => {
    const o = await owner();
    const r = await t.stepUp(o.tokens, PURPOSE, o.totpSecret);
    expect(r.status).toBe(200);
    expect(r.body.stepUpToken).toMatch(/^[0-9a-f-]{36}$/);
    const row = await t.db.query(`SELECT "ownerId", purpose, method FROM owner_step_up WHERE id=$1`, [r.body.stepUpToken]);
    expect(row.rows[0]).toMatchObject({ ownerId: o.id, purpose: PURPOSE, method: 'totp' });
  });

  it('the bare secret key is refused for the purpose (factor-only)', async () => {
    const o = await owner();
    const sk = await t.stepUp(o.tokens, PURPOSE, o.totpSecret, { method: 'secret_key', secretKey: 'x'.repeat(43), code: undefined });
    expect([sk.status, sk.body.code]).toEqual([400, 'step_up_unsupported']);
  });

  it('a passkey issues a proof for the purpose; its challenge is bound to the purpose', async () => {
    const o = await t.owner(await t.newCompany(), `rrpk${uniq()}@a.test`);
    const auth = new SoftAuthenticator('auth.test', 'https://auth.test');
    const login = await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
    const enrollOpts = await t.http.post('/auth/admin/enroll/webauthn/options').send({ enrollmentToken: login.body.enrollmentToken }).expect(200);
    const reg = await t.http.post('/auth/admin/enroll/webauthn')
      .send({ enrollmentToken: login.body.enrollmentToken, challengeId: enrollOpts.body.challengeId, response: auth.register(enrollOpts.body.options) });
    expect(reg.status).toBe(200);
    const tokens = reg.body as { accessToken: string };

    // a challenge requested for another purpose cannot be redeemed for this one
    const other = await t.http.post('/auth/admin/step-up/webauthn-options').set(bearer(tokens.accessToken)).send({ purpose: 'owner.factor.enroll' }).expect(200);
    await t.http.post('/auth/admin/step-up').set(bearer(tokens.accessToken))
      .send({ purpose: PURPOSE, method: 'webauthn', challengeId: other.body.challengeId, assertion: auth.assert(other.body.options) }).expect(401);

    const opts = await t.http.post('/auth/admin/step-up/webauthn-options').set(bearer(tokens.accessToken)).send({ purpose: PURPOSE }).expect(200);
    const r = await t.http.post('/auth/admin/step-up').set(bearer(tokens.accessToken))
      .send({ purpose: PURPOSE, method: 'webauthn', challengeId: opts.body.challengeId, assertion: auth.assert(opts.body.options) });
    expect(r.status).toBe(200);
    const row = await t.db.query(`SELECT purpose, method FROM owner_step_up WHERE id=$1`, [r.body.stepUpToken]);
    expect(row.rows[0]).toMatchObject({ purpose: PURPOSE, method: 'webauthn' });
  });

  it('a proof is bound to its owner: another owner cannot consume it', async () => {
    const o = await owner();
    const other = await owner();
    const su = await t.stepUpToken(o.tokens, PURPOSE, o.totpSecret);
    await verify(other.tokens, PURPOSE, su).expect(403);
    await verify(o.tokens, PURPOSE, su).expect(204);
  });

  it('a proof is bound to its session: another session of the same owner cannot consume it', async () => {
    const o = await owner();
    const su = await t.stepUpToken(o.tokens, PURPOSE, o.totpSecret);
    const otherSession = await t.ownerLogin({ email: o.email, password: o.password }, o.totpSecret);
    await verify(otherSession, PURPOSE, su).expect(403);
  });

  it('a proof is bound to its purpose, in both directions', async () => {
    const o = await owner();
    const repair = await t.stepUpToken(o.tokens, PURPOSE, o.totpSecret);
    await verify(o.tokens, 'organization.create', repair).expect(403);
    await verify(o.tokens, 'platform.create', repair).expect(403);
    const create = await t.stepUpToken(o.tokens, 'organization.create', o.totpSecret);
    await verify(o.tokens, PURPOSE, create).expect(403);
  });

  it('a proof expires with the existing step-up lifetime', async () => {
    const o = await owner();
    const su = await t.stepUpToken(o.tokens, PURPOSE, o.totpSecret);
    t.clock.advance((t.cfg.stepUp.ttlSec + 5) * 1000);
    await verify(o.tokens, PURPOSE, su).expect(403);
  });

  it('documented, unchanged generic behavior: POST /auth/step-up/verify consumes the proof exactly once', async () => {
    const o = await owner();
    const su = await t.stepUpToken(o.tokens, PURPOSE, o.totpSecret);
    await verify(o.tokens, PURPOSE, su).expect(204);
    await verify(o.tokens, PURPOSE, su).expect(403); // single use
  });

  it('an unknown purpose is still refused at issue and at verification', async () => {
    const o = await owner();
    const r = await t.stepUp(o.tokens, 'hierarchy.reference.repairs', o.totpSecret);
    expect([r.status, r.body.code]).toEqual([400, 'step_up_unsupported']);
    const su = await t.stepUpToken(o.tokens, PURPOSE, o.totpSecret);
    await verify(o.tokens, 'hierarchy.reference', su).expect(403);
  });
});
