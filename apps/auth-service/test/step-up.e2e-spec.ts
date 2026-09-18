import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

describe('owner step-up and sensitive operations', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let owner: Awaited<ReturnType<TestCtx['readyOwner']>>;
  let op: { id: string; email: string };
  beforeAll(async () => {
    t = await createTestApp();
    w = await t.world();
    owner = await t.readyOwner(w.companyA, 'owner@a.test');
    op = await t.operator(w.companyA, 'op@a.test');
  });
  afterAll(() => t.close());

  const grant = (tokens: any, su?: string, platformId = w.platformSchool, operatorId = op.id) => {
    const r = t.http.post(`/auth/admin/operators/${operatorId}/platform-assignments`).set(bearer(tokens));
    if (su) r.set('X-Step-Up-Token', su);
    return r.send({ platformId });
  };
  const revoke = (tokens: any, su?: string, platformId = w.platformSchool) => {
    const r = t.http.delete(`/auth/admin/operators/${op.id}/platform-assignments/${platformId}`).set(bearer(tokens));
    if (su) r.set('X-Step-Up-Token', su);
    return r;
  };

  it('granting requires a step-up; the full security context is checked, not just that a row exists', async () => {
    // none
    await grant(owner.tokens).expect(403);
    // wrong purpose
    const wrongPurpose = await t.stepUpToken(owner.tokens, 'platform_assignment.revoke', owner.totpSecret);
    await grant(owner.tokens, wrongPurpose).expect(403);
    // garbage / not a uuid
    await grant(owner.tokens, 'not-a-token').expect(403);
    // right purpose, right session -> works, exactly once
    const good = await t.stepUpToken(owner.tokens, 'platform_assignment.grant', owner.totpSecret);
    const first = await grant(owner.tokens, good);
    expect(first.status).toBe(201);
    await grant(owner.tokens, good).expect(403); // consumed
  });

  it('assignedBy is derived from the authenticated owner; it cannot be supplied', async () => {
    const stored = await t.db.query(`SELECT "assignedBy" FROM platform_assignment WHERE "operatorId"=$1`, [op.id]);
    expect(stored.rows[0].assignedBy).toBe(owner.id);
    const su = await t.stepUpToken(owner.tokens, 'platform_assignment.grant', owner.totpSecret);
    const r = await t.http.post(`/auth/admin/operators/${op.id}/platform-assignments`).set(bearer(owner.tokens)).set('X-Step-Up-Token', su)
      .send({ platformId: w.platformDrive, assignedBy: '00000000-0000-0000-0000-000000000001', companyId: w.companyB });
    expect(r.status).toBe(400);
  });

  it('an expired step-up is rejected', async () => {
    const su = await t.stepUpToken(owner.tokens, 'platform_assignment.grant', owner.totpSecret);
    t.clock.advance((t.cfg.stepUp.ttlSec + 5) * 1000);
    await grant(owner.tokens, su, w.platformDrive).expect(403);
  });

  it('a step-up from another session (family) is rejected', async () => {
    const session2 = await t.ownerLogin(owner, owner.totpSecret);
    const su = await t.stepUpToken(session2, 'platform_assignment.grant', owner.totpSecret);
    await grant(owner.tokens, su, w.platformDrive).expect(403); // presented in session 1
    await grant(session2, su, w.platformDrive).expect(201); // valid in the session it was issued in
  });

  it('a failed operation does not burn the step-up', async () => {
    const su = await t.stepUpToken(owner.tokens, 'platform_assignment.revoke', owner.totpSecret);
    // nothing to revoke on Clinic (another company's platform) -> 404, step-up survives
    await revoke(owner.tokens, su, w.platformClinic).expect(404);
    await revoke(owner.tokens, su, w.platformSchool).expect(204);
  });

  it('the secret key satisfies grant/revoke step-up but NEVER factor-only purposes', async () => {
    // issue a key (factor step-up required)
    const rot = await t.stepUpToken(owner.tokens, 'owner.secret_key.rotate', owner.totpSecret);
    const issued = await t.http.post('/auth/admin/secret-key/rotate').set(bearer(owner.tokens)).set('X-Step-Up-Token', rot).expect(200);
    const key = issued.body.secretKey as string;
    // allowed purpose
    const okGrant = await t.http.post('/auth/admin/step-up').set(bearer(owner.tokens)).send({ purpose: 'platform_assignment.grant', method: 'secret_key', secretKey: key });
    expect(okGrant.status).toBe(200);
    // factor-only purposes reject the key outright (400), so a leaked key cannot rotate/enroll/remove/change password
    for (const purpose of ['owner.secret_key.rotate', 'owner.factor.enroll', 'owner.factor.remove', 'owner.password.change']) {
      await t.http.post('/auth/admin/step-up').set(bearer(owner.tokens)).send({ purpose, method: 'secret_key', secretKey: key }).expect(400);
    }
    // a wrong key is a generic 401
    await t.http.post('/auth/admin/step-up').set(bearer(owner.tokens)).send({ purpose: 'platform_assignment.grant', method: 'secret_key', secretKey: 'AAAA-AAAA' }).expect(401);
  });

  it('the secret key is returned once and stored only as a keyed digest', async () => {
    const rot = await t.stepUpToken(owner.tokens, 'owner.secret_key.rotate', owner.totpSecret);
    const r = await t.http.post('/auth/admin/secret-key/rotate').set(bearer(owner.tokens)).set('X-Step-Up-Token', rot).expect(200);
    const key = r.body.secretKey as string;
    expect(key).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/); // 256 bits, 52 base32 chars
    const row = await t.db.query(`SELECT "secretKeyHash" FROM owner WHERE "userId"=$1`, [owner.id]);
    expect(row.rows[0].secretKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rows[0].secretKeyHash).not.toContain(key.replace(/-/g, '').toLowerCase());
    // a second rotation invalidates the first key immediately
    const rot2 = await t.stepUpToken(owner.tokens, 'owner.secret_key.rotate', owner.totpSecret);
    await t.http.post('/auth/admin/secret-key/rotate').set(bearer(owner.tokens)).set('X-Step-Up-Token', rot2).expect(200);
    await t.http.post('/auth/admin/step-up').set(bearer(owner.tokens)).send({ purpose: 'platform_assignment.grant', method: 'secret_key', secretKey: key }).expect(401);
  });

  it('factor management cannot weaken authentication', async () => {
    const list = await t.http.get('/auth/admin/factors').set(bearer(owner.tokens)).expect(200);
    const only = list.body[0].id;
    // cannot remove the only factor, even with a valid step-up
    const su1 = await t.stepUpToken(owner.tokens, 'owner.factor.remove', owner.totpSecret);
    await t.http.delete(`/auth/admin/factors/${only}`).set(bearer(owner.tokens)).set('X-Step-Up-Token', su1).expect(409);
    // cannot remove without step-up
    await t.http.delete(`/auth/admin/factors/${only}`).set(bearer(owner.tokens)).expect(403);
    // adding a second factor needs a step-up at confirmation
    const begin = await t.http.post('/auth/admin/factors/totp').set(bearer(owner.tokens)).expect(200);
    const code = t.nextCode(begin.body.secret);
    await t.http.post('/auth/admin/factors/totp/confirm').set(bearer(owner.tokens)).send({ factorId: begin.body.factorId, code }).expect(403);
    const su2 = await t.stepUpToken(owner.tokens, 'owner.factor.enroll', owner.totpSecret);
    await t.http.post('/auth/admin/factors/totp/confirm').set(bearer(owner.tokens)).set('X-Step-Up-Token', su2).send({ factorId: begin.body.factorId, code: t.nextCode(begin.body.secret) }).expect(200);
    // now two factors: removal of one is allowed (with step-up)
    const su3 = await t.stepUpToken(owner.tokens, 'owner.factor.remove', owner.totpSecret);
    await t.http.delete(`/auth/admin/factors/${begin.body.factorId}`).set(bearer(owner.tokens)).set('X-Step-Up-Token', su3).expect(204);
  });

  it('password change needs a factor step-up and ends every OTHER session', async () => {
    const other = await t.ownerLogin(owner, owner.totpSecret);
    const su = await t.stepUpToken(owner.tokens, 'owner.password.change', owner.totpSecret);
    await t.http.post('/auth/admin/password/change').set(bearer(owner.tokens)).set('X-Step-Up-Token', su).send({ newPassword: 'a brand new passphrase' }).expect(204);
    await t.http.get('/auth/me').set(bearer(other)).expect(401);
    await t.http.get('/auth/me').set(bearer(owner.tokens)).expect(200);
    await t.http.post('/auth/login').send({ email: owner.email, password: 'a brand new passphrase' }).expect(200);
  });

  it('a step-up cannot be requested for an unsupported purpose', async () => {
    await t.http.post('/auth/admin/step-up').set(bearer(owner.tokens)).send({ purpose: 'company.delete', method: 'totp', code: t.nextCode(owner.totpSecret) }).expect(400);
  });

  it('a wrong step-up credential is a generic 401 and is audited', async () => {
    await t.http.post('/auth/admin/step-up').set(bearer(owner.tokens)).send({ purpose: 'platform_assignment.grant', method: 'totp', code: '000000' }).expect(401);
    const a = await t.db.query(`SELECT count(*)::int n FROM auth_audit_event WHERE type='owner.step_up' AND outcome='failure' AND "actorId"=$1`, [owner.id]);
    expect(a.rows[0].n).toBeGreaterThan(0);
  });

  it('a disabled owner cannot step up or continue privileged operations', async () => {
    const o = await t.readyOwner(await t.newCompany(), 'gone@a.test');
    const su = await t.stepUpToken(o.tokens, 'platform_assignment.grant', o.totpSecret);
    await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [o.id]);
    await t.stepUp(o.tokens, 'platform_assignment.grant', o.totpSecret).then((r) => expect(r.status).toBe(401));
    await grant(o.tokens, su).expect(401);
  });

  it('operators and members cannot reach owner routes', async () => {
    const opTokens = await t.operatorLogin(op.email);
    await t.http.post('/auth/admin/step-up').set(bearer(opTokens)).send({ purpose: 'platform_assignment.grant', method: 'totp', code: '123456' }).expect(403);
    await grant(opTokens, undefined).expect(403);
    const m = await t.member(w.orgSchool1, 'm1@a.test');
    const mt = (await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(200)).body;
    await grant(mt, undefined).expect(403);
    await t.http.post(`/auth/admin/operators/${op.id}/platform-assignments`).send({ platformId: w.platformSchool }).expect(401);
  });
});
