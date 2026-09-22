import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, noReqId, type TestCtx } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);

describe('hardening: stale tokens, error disclosure, expiry and key-ring failure modes', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let ownerA: Awaited<ReturnType<TestCtx['readyOwner']>>; // the database allows exactly ONE owner per company
  beforeAll(async () => {
    t = await createTestApp();
    w = await t.world();
    ownerA = await t.readyOwner(w.companyA, `own${uniq()}@a.test`);
  });
  afterAll(() => t.close());

  // ------------------------------------------------------------------- operator, stale tokens
  describe('operator with an already-issued, unexpired access token', () => {
    async function assignedOperator() {
      const owner = ownerA;
      const op = await t.operator(w.companyA, `op${uniq()}@a.test`);
      await t.assign(op.id, w.platformSchool, owner.id, w.companyA);
      const tokens = await t.operatorLogin(op.email);
      await t.http.get(`/auth/platform-access/${w.platformSchool}`).set(bearer(tokens)).expect(200);
      return { owner, op, tokens };
    }

    it('a DISABLED operator is refused on the very next request and cannot refresh', async () => {
      const { op, tokens } = await assignedOperator();
      await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [op.id]);
      await t.http.get(`/auth/platform-access/${w.platformSchool}`).set(bearer(tokens)).expect(401);
      await t.http.get('/auth/me').set(bearer(tokens)).expect(401);
      await t.http.post('/auth/refresh').send({ refreshToken: tokens.refreshToken }).expect(401);
    });

    it('a BLOCKED operator loses the session at once (access and refresh)', async () => {
      const { owner, op, tokens } = await assignedOperator();
      await t.http.post(`/auth/admin/operators/${op.id}/block`).set(bearer(owner.tokens)).expect(204);
      await t.http.get(`/auth/platform-access/${w.platformSchool}`).set(bearer(tokens)).expect(401);
      await t.http.post('/auth/refresh').send({ refreshToken: tokens.refreshToken }).expect(401);
    });

    it('assignment revoked: access is denied immediately; refresh still yields a token, but that token has no platform either', async () => {
      // Design (documented): revoking an assignment changes AUTHORIZATION SCOPE, not the session. The
      // operator is still an authenticated identity; every protected request is decided against the
      // current assignment, so nothing about the platform is reachable with any token.
      const { owner, op, tokens } = await assignedOperator();
      const su = await t.stepUpToken(owner.tokens, 'platform_assignment.revoke', owner.totpSecret);
      await t.http.delete(`/auth/admin/operators/${op.id}/platform-assignments/${w.platformSchool}`).set(bearer(owner.tokens)).set('X-Step-Up-Token', su).expect(204);
      await t.http.get(`/auth/platform-access/${w.platformSchool}`).set(bearer(tokens)).expect(404);
      const refreshed = await t.http.post('/auth/refresh').send({ refreshToken: tokens.refreshToken }).expect(200);
      await t.http.get(`/auth/platform-access/${w.platformSchool}`).set(bearer(refreshed.body)).expect(404);
      await t.http.get(`/auth/admin/organizations/${w.orgSchool1}`).set(bearer(refreshed.body)).expect(404);
    });

    it('a foreign-company platform is the same 404 as a platform that does not exist', async () => {
      const { tokens } = await assignedOperator();
      const foreign = await t.http.get(`/auth/platform-access/${w.platformClinic}`).set(bearer(tokens));
      const missing = await t.http.get('/auth/platform-access/00000000-0000-4000-8000-00000000dead').set(bearer(tokens));
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(noReqId(foreign.body)).toEqual(noReqId(missing.body));
    });
  });

  // ------------------------------------------------------------------- error disclosure
  describe('authentication errors do not reveal which identity exists', () => {
    it('login: unknown email, wrong password, inactive user and an operator with a password are one indistinguishable 401', async () => {
      const m = await t.member(w.orgSchool1, `m${uniq()}@a.test`);
      const inactive = await t.member(w.orgSchool1, `i${uniq()}@a.test`);
      await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [inactive.id]);
      const op = await t.operator(w.companyA, `op${uniq()}@a.test`);
      const attempts = [
        { email: `ghost${uniq()}@a.test`, password: 'whatever password 1' },
        { email: m.email, password: 'definitely not the password' },
        { email: inactive.email, password: inactive.password },
        { email: op.email, password: 'operators have no password' },
        { phone: '+21600000000', password: 'whatever password 1' },
      ];
      const res = [];
      for (const a of attempts) res.push(await t.http.post('/auth/login').send(a));
      for (const r of res) expect(r.status).toBe(401);
      for (const r of res.slice(1)) expect(noReqId(r.body)).toEqual(noReqId(res[0].body));
    });

    it('owner login MFA: unknown challenge, expired challenge and wrong code all answer the same 401', async () => {
      const owner = await t.readyOwner(await t.newCompany(), `o${uniq()}@a.test`);
      const login = (await t.http.post('/auth/login').send({ email: owner.email, password: owner.password }).expect(200)).body;
      const wrong = await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: login.challengeToken, method: 'totp', code: '000000' });
      const unknown = await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: 'x'.repeat(43), method: 'totp', code: '000000' });
      t.clock.advance(3600 * 1000); // past the challenge lifetime
      const expired = await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: login.challengeToken, method: 'totp', code: t.nextCode(owner.totpSecret) });
      expect([wrong.status, unknown.status, expired.status]).toEqual([401, 401, 401]);
      expect(noReqId(unknown.body)).toEqual(noReqId(expired.body));
    });
  });

  // ------------------------------------------------------------------- TOTP key ring
  describe('TOTP key ring failure modes', () => {
    it('a factor sealed under a key that has been retired from the ring fails SAFELY (401 + audit), never a 500 or a leak', async () => {
      const owner = await t.readyOwner(await t.newCompany(), `k${uniq()}@a.test`);
      await t.db.query(`UPDATE owner_auth_factor SET "secretKeyId"='retired-key' WHERE "ownerId"=$1 AND type='totp'`, [owner.id]);
      const login = (await t.http.post('/auth/login').send({ email: owner.email, password: owner.password }).expect(200)).body;
      const r = await t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: login.challengeToken, method: 'totp', code: t.nextCode(owner.totpSecret) });
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.body)).not.toContain('retired-key');
      const audit = await t.db.query(`SELECT count(*)::int n FROM auth_audit_event WHERE "actorId"=$1 AND type='owner.totp.key_unavailable'`, [owner.id]);
      expect(audit.rows[0].n).toBeGreaterThan(0);
    });
  });
});
