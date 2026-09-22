import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);

/**
 * Stage 13.2's additive `code` field, proven per representative category: HTTP status and message text are
 * unchanged from before Stage 13.2 (the compatibility requirement), `code` is now present and stable, and
 * every business exception site is enforced (not just tested) by `scripts/lib/checks.mjs`'s
 * `checkAuthErrorCoverage` (`npm run check:repo`), which fails the build if a future call site throws a raw
 * Nest exception class or an uncoded `HttpException` from `apps/auth-service/src`.
 */
describe('error codes: representative categories, additive and status/message-compatible', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('validation (400): message text unchanged, code = validation_error', async () => {
    const r = await t.http.post('/auth/login').send({ password: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Provide exactly one of email or phone.');
    expect(r.body.code).toBe('validation_error');
    expect(r.body.error).toBe('Bad Request');
  });

  it('authentication (401): a missing bearer is a bare, generic 401, code = unauthenticated, no distinction leaked', async () => {
    const r = await t.http.get('/auth/admin/factors');
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('Unauthorized');
    expect(r.body.code).toBe('unauthenticated');
  });

  it('authorization (403): a member token on an owner-only route, code = forbidden', async () => {
    const w = await t.world();
    const member = await t.member(w.orgSchool1, `m${uniq()}@a.test`);
    const login = await t.http.post('/auth/login').send({ email: member.email, password: member.password }).expect(200);
    const r = await t.http.get('/auth/admin/factors').set(bearer(login.body));
    expect(r.status).toBe(403);
    expect(r.body.message).toBe('Forbidden');
    expect(r.body.code).toBe('forbidden');
  });

  it('not-found (404): a member querying a membership on an organization they don\'t belong to, code = not_found', async () => {
    const w = await t.world();
    const member = await t.member(w.orgSchool1, `m${uniq()}@a.test`);
    const login = await t.http.post('/auth/login').send({ email: member.email, password: member.password }).expect(200);
    const r = await t.http.get(`/auth/organizations/${w.orgSchool2}/membership`).set(bearer(login.body));
    expect(r.status).toBe(404);
    expect(r.body.message).toBe('Not Found');
    expect(r.body.code).toBe('not_found');
  });

  it('conflict (409): removing an owner\'s only authentication factor, code = factor_required, message unchanged', async () => {
    const company = await t.newCompany();
    const owner = await t.readyOwner(company, `o${uniq()}@a.test`);
    const list = await t.http.get('/auth/admin/factors').set(bearer(owner.tokens)).expect(200);
    const factorId = list.body[0].id as string;
    const su = await t.stepUpToken(owner.tokens, 'owner.factor.remove', owner.totpSecret);
    const r = await t.http.delete(`/auth/admin/factors/${factorId}`).set(bearer(owner.tokens)).set('x-step-up-token', su);
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('You cannot remove your only authentication factor.');
    expect(r.body.code).toBe('factor_required');
  });

  it('MFA/step-up (401): a wrong TOTP code at step-up verification, code = verification_failed, message unchanged', async () => {
    const company = await t.newCompany();
    const owner = await t.readyOwner(company, `o${uniq()}@a.test`);
    const r = await t.stepUp(owner.tokens, 'owner.factor.remove', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'); // an unrelated, wrong secret
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('Verification failed.');
    expect(r.body.code).toBe('verification_failed');
  });
});
