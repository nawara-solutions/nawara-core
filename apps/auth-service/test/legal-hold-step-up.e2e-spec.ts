import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx, type Tokens } from './helpers/app.js';
import { SoftAuthenticator } from './helpers/authenticator.js';

const uniq = () => Math.random().toString(36).slice(2);
const PLACE = 'audit.legal_hold.place';
const RELEASE = 'audit.legal_hold.release';

/**
 * Core V2 S2-Audit.4 (OD-13 resolved, Owner decision H3): the two legal-hold step-up purposes, over real HTTP on real PostgreSQL. Auth issues
 * a proof only with TOTP or a passkey (never the bare secret key); audit-service consumes it through the generic POST /auth/step-up/verify
 * with the Owner's own bearer: bound to that owner, session and exact purpose, single use.
 */
describe('legal-hold step-up purposes (S2-Audit.4)', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp(); await t.app.listen(0); });
  afterAll(() => t.close());

  const owner = async () => t.readyOwner(await t.newCompany(), `lh${uniq()}@a.test`);
  const verify = (tokens: Tokens | string, purpose: string, stepUpToken: string) =>
    t.http.post('/auth/step-up/verify').set(bearer(tokens)).send({ purpose, stepUpToken });

  it('TOTP issues a proof for each purpose; the verify endpoint consumes it once', async () => {
    const o = await owner();
    for (const purpose of [PLACE, RELEASE]) {
      const proof = await t.stepUpToken(o.tokens, purpose, o.totpSecret);
      expect((await verify(o.tokens, purpose, proof)).status, purpose).toBe(204);
      const again = await verify(o.tokens, purpose, proof);
      expect([again.status, again.body.code], purpose).toEqual([403, 'step_up_required']);
    }
  });

  it('the bare secret key is refused for both purposes (factor-only)', async () => {
    const o = await owner();
    for (const purpose of [PLACE, RELEASE]) {
      const sk = await t.stepUp(o.tokens, purpose, o.totpSecret, { method: 'secret_key', secretKey: 'x'.repeat(43), code: undefined });
      expect([sk.status, sk.body.code], purpose).toEqual([400, 'step_up_unsupported']);
    }
  });

  it('a proof of one purpose never verifies for the other, and is not spent by the refusal', async () => {
    const o = await owner();
    const place = await t.stepUpToken(o.tokens, PLACE, o.totpSecret);
    expect((await verify(o.tokens, RELEASE, place)).status).toBe(403);
    expect((await verify(o.tokens, PLACE, place)).status).toBe(204);
    const release = await t.stepUpToken(o.tokens, RELEASE, o.totpSecret);
    expect((await verify(o.tokens, PLACE, release)).status).toBe(403);
    expect((await verify(o.tokens, 'refund.authorize', release)).status).toBe(403);
  });

  it('a proof is bound to its owner and session', async () => {
    const o = await owner();
    const other = await owner();
    const proof = await t.stepUpToken(o.tokens, PLACE, o.totpSecret);
    expect((await verify(other.tokens, PLACE, proof)).status).toBe(403);
    const otherSession = await t.ownerLogin({ email: o.email, password: o.password }, o.totpSecret);
    expect((await verify(otherSession, PLACE, proof)).status).toBe(403);
    expect((await verify(o.tokens, PLACE, proof)).status).toBe(204);
  });

  it('a passkey issues a proof for the purpose (its challenge bound to the purpose)', async () => {
    const o = await t.owner(await t.newCompany(), `lhpk${uniq()}@a.test`);
    const auth = new SoftAuthenticator('auth.test', 'https://auth.test');
    const login = await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
    const enrollOpts = await t.http.post('/auth/admin/enroll/webauthn/options').send({ enrollmentToken: login.body.enrollmentToken }).expect(200);
    const reg = await t.http.post('/auth/admin/enroll/webauthn')
      .send({ enrollmentToken: login.body.enrollmentToken, challengeId: enrollOpts.body.challengeId, response: auth.register(enrollOpts.body.options) });
    expect(reg.status).toBe(200);
    const tokens = reg.body as { accessToken: string };
    const opts = await t.http.post('/auth/admin/step-up/webauthn-options').set(bearer(tokens.accessToken)).send({ purpose: PLACE }).expect(200);
    const r = await t.http.post('/auth/admin/step-up').set(bearer(tokens.accessToken))
      .send({ purpose: PLACE, method: 'webauthn', challengeId: opts.body.challengeId, assertion: auth.assert(opts.body.options) });
    expect(r.status).toBe(200);
    expect((await verify(tokens.accessToken, PLACE, r.body.stepUpToken)).status).toBe(204);
  });

  it('an operator or member cannot verify a legal-hold proof (no owner_step_up row can exist for them)', async () => {
    const w = await t.world();
    const m = await t.member(w.orgSchool1, `m${uniq()}@a.test`);
    const mt = (await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(200)).body;
    expect((await verify(mt, PLACE, '00000000-0000-4000-8000-000000000000')).status).toBe(403);
  });
});
