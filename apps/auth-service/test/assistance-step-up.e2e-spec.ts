import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx, type Tokens } from './helpers/app.js';
import { SoftAuthenticator } from './helpers/authenticator.js';

const uniq = () => Math.random().toString(36).slice(2);
const CORRECT = 'billing.assistance.correct';
const RESOLVE = 'billing.assistance.dispute.resolve';

/**
 * Core V2 S5c prerequisite (Owner decision H-1, option B; register AUTH-04): the two assistance step-up purposes, over real HTTP on real
 * PostgreSQL. Auth issues a proof only with TOTP or a passkey (never the bare secret key); billing-service will consume it through the
 * generic POST /auth/step-up/verify with the Owner's own bearer: bound to that owner, session and exact purpose, short-lived, single use.
 */
describe('assistance step-up purposes (S5c prerequisite)', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp(); await t.app.listen(0); });
  afterAll(() => t.close());

  const owner = async () => t.readyOwner(await t.newCompany(), `as${uniq()}@a.test`);
  const verify = (tokens: Tokens | string, purpose: string, stepUpToken: string) =>
    t.http.post('/auth/step-up/verify').set(bearer(tokens)).send({ purpose, stepUpToken });

  it('TOTP issues a proof for each purpose; the verify endpoint consumes it once', async () => {
    const o = await owner();
    for (const purpose of [CORRECT, RESOLVE]) {
      const proof = await t.stepUpToken(o.tokens, purpose, o.totpSecret);
      const row = await t.db.query(`SELECT "ownerId", purpose, method FROM owner_step_up WHERE id=$1`, [proof]);
      expect(row.rows[0], purpose).toMatchObject({ ownerId: o.id, purpose, method: 'totp' });
      expect((await verify(o.tokens, purpose, proof)).status, purpose).toBe(204);
      const again = await verify(o.tokens, purpose, proof);
      expect([again.status, again.body.code], purpose).toEqual([403, 'step_up_required']);
    }
  });

  it('the bare secret key is refused for both purposes (factor-only)', async () => {
    const o = await owner();
    for (const purpose of [CORRECT, RESOLVE]) {
      const sk = await t.stepUp(o.tokens, purpose, o.totpSecret, { method: 'secret_key', secretKey: 'x'.repeat(43), code: undefined });
      expect([sk.status, sk.body.code], purpose).toEqual([400, 'step_up_unsupported']);
    }
  });

  it('a correction proof never resolves a dispute and vice versa, nor verifies for any other purpose; refusals do not spend it', async () => {
    const o = await owner();
    const correct = await t.stepUpToken(o.tokens, CORRECT, o.totpSecret);
    const resolve = await t.stepUpToken(o.tokens, RESOLVE, o.totpSecret);
    for (const other of [RESOLVE, 'audit.legal_hold.place', 'refund.authorize', 'billing.assistance', 'billing.assistance.dispute']) {
      expect((await verify(o.tokens, other, correct)).status, other).toBe(403);
    }
    for (const other of [CORRECT, 'audit.legal_hold.release', 'refund.authorize', 'billing.assistance.dispute']) {
      expect((await verify(o.tokens, other, resolve)).status, other).toBe(403);
    }
    expect((await verify(o.tokens, CORRECT, correct)).status).toBe(204);
    expect((await verify(o.tokens, RESOLVE, resolve)).status).toBe(204);
    const legalHold = await t.stepUpToken(o.tokens, 'audit.legal_hold.place', o.totpSecret);
    expect((await verify(o.tokens, CORRECT, legalHold)).status).toBe(403);
    expect((await verify(o.tokens, RESOLVE, legalHold)).status).toBe(403);
  });

  it('a proof is bound to its owner and session', async () => {
    const o = await owner();
    const other = await owner();
    const proof = await t.stepUpToken(o.tokens, RESOLVE, o.totpSecret);
    expect((await verify(other.tokens, RESOLVE, proof)).status).toBe(403);
    const otherSession = await t.ownerLogin({ email: o.email, password: o.password }, o.totpSecret);
    expect((await verify(otherSession, RESOLVE, proof)).status).toBe(403);
    expect((await verify(o.tokens, RESOLVE, proof)).status).toBe(204);
  });

  it('a proof expires with the existing step-up lifetime', async () => {
    const o = await owner();
    for (const purpose of [CORRECT, RESOLVE]) {
      const proof = await t.stepUpToken(o.tokens, purpose, o.totpSecret);
      t.clock.advance((t.cfg.stepUp.ttlSec + 5) * 1000);
      expect((await verify(o.tokens, purpose, proof)).status, purpose).toBe(403);
    }
  });

  it('concurrent verifications of one proof consume it exactly once (replay refusal)', async () => {
    const o = await owner();
    for (const purpose of [CORRECT, RESOLVE]) {
      const proof = await t.stepUpToken(o.tokens, purpose, o.totpSecret);
      const statuses = (await Promise.all(Array.from({ length: 5 }, () => verify(o.tokens, purpose, proof)))).map((r) => r.status);
      expect(statuses.filter((s) => s === 204), purpose).toHaveLength(1);
      expect(statuses.filter((s) => s === 403), purpose).toHaveLength(4);
    }
  });

  it('a passkey issues a proof for the purpose; a challenge for one purpose cannot be redeemed for the other', async () => {
    const o = await t.owner(await t.newCompany(), `aspk${uniq()}@a.test`);
    const auth = new SoftAuthenticator('auth.test', 'https://auth.test');
    const login = await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
    const enrollOpts = await t.http.post('/auth/admin/enroll/webauthn/options').send({ enrollmentToken: login.body.enrollmentToken }).expect(200);
    const reg = await t.http.post('/auth/admin/enroll/webauthn')
      .send({ enrollmentToken: login.body.enrollmentToken, challengeId: enrollOpts.body.challengeId, response: auth.register(enrollOpts.body.options) });
    expect(reg.status).toBe(200);
    const tokens = reg.body as { accessToken: string };

    const other = await t.http.post('/auth/admin/step-up/webauthn-options').set(bearer(tokens.accessToken)).send({ purpose: CORRECT }).expect(200);
    await t.http.post('/auth/admin/step-up').set(bearer(tokens.accessToken))
      .send({ purpose: RESOLVE, method: 'webauthn', challengeId: other.body.challengeId, assertion: auth.assert(other.body.options) }).expect(401);

    const opts = await t.http.post('/auth/admin/step-up/webauthn-options').set(bearer(tokens.accessToken)).send({ purpose: RESOLVE }).expect(200);
    const r = await t.http.post('/auth/admin/step-up').set(bearer(tokens.accessToken))
      .send({ purpose: RESOLVE, method: 'webauthn', challengeId: opts.body.challengeId, assertion: auth.assert(opts.body.options) });
    expect(r.status).toBe(200);
    expect((await verify(tokens.accessToken, CORRECT, r.body.stepUpToken)).status).toBe(403);
    expect((await verify(tokens.accessToken, RESOLVE, r.body.stepUpToken)).status).toBe(204);
  });

  it('a member cannot obtain or verify an assistance proof (no owner_step_up row can exist for them)', async () => {
    const w = await t.world();
    const m = await t.member(w.orgSchool1, `m${uniq()}@a.test`);
    const mt = (await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(200)).body;
    const issue = await t.http.post('/auth/admin/step-up').set(bearer(mt)).send({ purpose: CORRECT, method: 'totp', code: '000000' });
    expect([issue.status, issue.body.code]).toEqual([403, 'forbidden']);
    for (const purpose of [CORRECT, RESOLVE]) {
      expect((await verify(mt, purpose, '00000000-0000-4000-8000-000000000000')).status, purpose).toBe(403);
    }
  });
});
