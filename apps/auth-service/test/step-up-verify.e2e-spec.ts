import { afterAll, beforeAll, describe, it } from 'vitest';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);

/**
 * ADR-0042 Amendment 1 A.1: POST /auth/step-up/verify lets a caller service (organization-service)
 * verify-and-consume a step-up proof on behalf of the user whose bearer is presented. This is the
 * generic surface the owner-facing routes already exercise internally (step-up.e2e-spec.ts); this
 * spec proves the HTTP surface itself behaves identically and denies non-owners.
 */
describe('POST /auth/step-up/verify', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;

  beforeAll(async () => {
    t = await createTestApp();
    w = await t.world();
  });
  afterAll(() => t.close());

  const verify = (tokens: any, purpose: string, stepUpToken: string) =>
    t.http.post('/auth/step-up/verify').set(bearer(tokens)).send({ purpose, stepUpToken });

  it('rejects an unauthenticated caller', async () => {
    await t.http.post('/auth/step-up/verify').send({ purpose: 'organization.create', stepUpToken: 'x'.repeat(36) }).expect(401);
  });

  it('denies missing, wrong-purpose and garbage step-up proofs', async () => {
    const owner = await t.readyOwner(await t.newCompany(), `o${uniq()}@a.test`);
    await verify(owner.tokens, 'organization.create', 'not-a-real-token-at-all-not-a-uuid').expect(403);
    const wrongPurpose = await t.stepUpToken(owner.tokens, 'platform.create', owner.totpSecret);
    await verify(owner.tokens, 'organization.create', wrongPurpose).expect(403);
  });

  it('verifies and consumes exactly once for the right purpose and session', async () => {
    const owner = await t.readyOwner(await t.newCompany(), `o${uniq()}@a.test`);
    const good = await t.stepUpToken(owner.tokens, 'organization.create', owner.totpSecret);
    await verify(owner.tokens, 'organization.create', good).expect(204);
    await verify(owner.tokens, 'organization.create', good).expect(403); // already consumed
  });

  it('denies a step-up presented from a different session (wrong-session)', async () => {
    const owner = await t.readyOwner(await t.newCompany(), `o${uniq()}@a.test`);
    const su = await t.stepUpToken(owner.tokens, 'organization.create', owner.totpSecret);
    const otherSession = await t.ownerLogin({ email: owner.email, password: owner.password }, owner.totpSecret);
    await verify(otherSession, 'organization.create', su).expect(403);
  });

  it('denies an operator: operators have no step-up mechanism yet (deferred, ADR-0042 Amendment 1 A.1)', async () => {
    const op = await t.operator(w.companyA, `op${uniq()}@a.test`);
    const login = await t.operatorLogin(op.email);
    await verify(login, 'organization.create', 'x'.repeat(36)).expect(403);
  });

  it('denies an unknown purpose', async () => {
    const owner = await t.readyOwner(await t.newCompany(), `o${uniq()}@a.test`);
    const good = await t.stepUpToken(owner.tokens, 'organization.create', owner.totpSecret);
    await verify(owner.tokens, 'not_a_real_purpose', good).expect(403);
  });

  it('Stage 20.4: the two Release Management purposes are factor-only and not interchangeable', async () => {
    const owner = await t.readyOwner(await t.newCompany(), `o${uniq()}@a.test`);
    for (const purpose of ['release.withdraw', 'compatibility_policy.change']) {
      const sk = await t.stepUp(owner.tokens, purpose, owner.totpSecret, { method: 'secret_key', secretKey: 'x'.repeat(43), code: undefined });
      if (sk.status !== 400 || sk.body.code !== 'step_up_unsupported') throw new Error(`${purpose}: the bare secret key must be refused (${sk.status})`);
    }
    const withdraw = await t.stepUpToken(owner.tokens, 'release.withdraw', owner.totpSecret);
    await verify(owner.tokens, 'compatibility_policy.change', withdraw).expect(403); // a withdrawal proof never changes a policy
    await verify(owner.tokens, 'release.withdraw', withdraw).expect(204);
    await verify(owner.tokens, 'release.withdraw', withdraw).expect(403); // single use
    const change = await t.stepUpToken(owner.tokens, 'compatibility_policy.change', owner.totpSecret);
    await verify(owner.tokens, 'release.withdraw', change).expect(403);
    await verify(owner.tokens, 'compatibility_policy.change', change).expect(204);
  });
});
