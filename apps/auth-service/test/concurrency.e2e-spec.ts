import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapOwner } from '../src/cli/owner-tools.js';
import { PasswordService } from '../src/crypto/password.js';
import { FactorService } from '../src/owner/factor.service.js';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statuses = (res: Array<{ status: number }>) => res.map((r) => r.status).sort((a, b) => a - b);

/**
 * Concurrency proofs. A check like `if (!used) markUsed()` is not safe when two transactions can
 * observe the same state, so every "exactly once" / "never zero" invariant is exercised with
 * simultaneous requests against a real PostgreSQL, and asserted on the database afterwards.
 */
describe('concurrency: security invariants hold under simultaneous requests', () => {
  let t: TestCtx;
  // Listen once: supertest otherwise binds a fresh ephemeral socket per request, and a burst of
  // parallel requests then fails with ECONNRESET in the harness (not in the service).
  beforeAll(async () => { t = await createTestApp(); await t.app.listen(0); });
  afterAll(() => t.close());

  const uniq = () => Math.random().toString(36).slice(2);

  // ---------------------------------------------------------------------------- owner recovery
  describe('owner recovery', () => {
    async function ownerWithKey() {
      const cid = await t.newCompany();
      const owner = await t.readyOwner(cid, `rec${uniq()}@a.test`);
      const rot = await t.stepUpToken(owner.tokens, 'owner.secret_key.rotate', owner.totpSecret);
      const key = (await t.http.post('/auth/admin/secret-key/rotate').set(bearer(owner.tokens)).set('X-Step-Up-Token', rot).expect(200)).body.secretKey as string;
      return { ...owner, key };
    }
    const start = (o: { email: string; password: string; key: string }) =>
      t.http.post('/auth/admin/recovery/start').send({ email: o.email, password: o.password, secretKey: o.key });
    const complete = (recoveryToken: string, secretKey: string) =>
      t.http.post('/auth/admin/recovery/complete').send({ recoveryToken, secretKey });

    it('a recovery token is consumed exactly once when 5 completions race', async () => {
      const o = await ownerWithKey();
      const { recoveryToken } = (await start(o).expect(202)).body;
      t.clock.advance(3601 * 1000);
      const res = await Promise.all(Array.from({ length: 5 }, () => complete(recoveryToken, o.key)));
      expect(statuses(res)).toEqual([200, 401, 401, 401, 401]);

      const q = (sql: string) => t.db.query(sql, [o.id]).then((r) => r.rows[0]);
      // exactly ONE live enrollment token, all factors and sessions dead, key spent, one success audited
      expect((await q(`SELECT count(*)::int n FROM owner_auth_challenge WHERE "ownerId"=$1 AND kind='enrollment' AND "consumedAt" IS NULL`)).n).toBe(1);
      expect((await q(`SELECT count(*)::int n FROM owner_auth_factor WHERE "ownerId"=$1 AND "revokedAt" IS NULL`)).n).toBe(0);
      expect((await q(`SELECT count(*)::int n FROM refresh_token WHERE "userId"=$1 AND "revokedAt" IS NULL`)).n).toBe(0);
      expect((await q(`SELECT "secretKeyHash" FROM owner WHERE "userId"=$1`)).secretKeyHash).toBeNull();
      expect((await q(`SELECT count(*)::int n FROM auth_audit_event WHERE "actorId"=$1 AND type='owner.recovery.complete' AND outcome='success'`)).n).toBe(1);
      expect((await q(`SELECT count(*)::int n FROM owner_recovery_request WHERE "ownerId"=$1 AND status='completed'`)).n).toBe(1);
      // the old access token is dead and no session was issued by recovery
      await t.http.get('/auth/me').set(bearer(o.tokens)).expect(401);
      for (const r of res.filter((x) => x.status === 200)) expect(r.body).not.toHaveProperty('accessToken');
    });

    it('5 simultaneous recovery starts leave exactly one pending request and never a server error', async () => {
      const o = await ownerWithKey();
      const res = await Promise.all(Array.from({ length: 5 }, () => start(o)));
      expect(res.filter((r) => r.status >= 500).map((r) => r.status)).toEqual([]);
      const pending = await t.db.query(`SELECT "tokenHash" FROM owner_recovery_request WHERE "ownerId"=$1 AND status='pending'`, [o.id]);
      expect(pending.rowCount).toBe(1);
    });

    it('a superseded, cancelled or expired request can never be completed', async () => {
      const o = await ownerWithKey();
      const first = (await start(o).expect(202)).body.recoveryToken as string;
      const second = (await start(o).expect(202)).body.recoveryToken as string; // supersedes the first
      await complete(first, o.key).expect(401); // superseded
      // cancel the live one from a session that still has a factor (before the access token ages out)
      await t.http.post('/auth/admin/recovery/cancel').set(bearer(o.tokens)).expect(204);
      t.clock.advance(3601 * 1000);
      await complete(second, o.key).expect(401); // cancelled, even after the cool-down

      const p = await ownerWithKey();
      const tok = (await start(p).expect(202)).body.recoveryToken as string;
      t.clock.advance((3600 + 7 * 86_400 + 60) * 1000); // past cool-down AND the request TTL
      await complete(tok, p.key).expect(401); // expired
      const done = await t.db.query(`SELECT count(*)::int n FROM owner_recovery_request WHERE status='completed' AND "ownerId" = ANY($1)`, [[o.id, p.id]]);
      expect(done.rows[0].n).toBe(0);
      // and the owners' factors are untouched by any of it
      const alive = await t.db.query(`SELECT count(*)::int n FROM owner_auth_factor WHERE "ownerId" = ANY($1) AND "revokedAt" IS NULL`, [[o.id, p.id]]);
      expect(alive.rows[0].n).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------- refresh tokens
  describe('refresh token rotation (strict policy: a second presentation is theft, the family dies)', () => {
    it('3 simultaneous refreshes of one token: one rotation succeeds, the family is then revoked, no second branch exists', async () => {
      const w = await t.world();
      const m = await t.member(w.orgSchool1, `r${uniq()}@a.test`);
      const login = (await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(200)).body;
      const res = await Promise.all(Array.from({ length: 3 }, () => t.http.post('/auth/refresh').send({ refreshToken: login.refreshToken })));
      expect(statuses(res)).toEqual([200, 401, 401]);
      const winner = res.find((r) => r.status === 200)!.body;

      const rows = (await t.db.query(`SELECT id, "replacedByTokenId", "revokedAt" FROM refresh_token WHERE "userId"=$1`, [m.id])).rows;
      expect(rows).toHaveLength(2); // the original and exactly ONE successor: no second valid branch
      const original = rows.filter((r) => r.replacedByTokenId);
      expect(original).toHaveLength(1);
      const successor = rows.find((r) => r.id !== original[0].id)!;
      expect(original[0].replacedByTokenId).toBe(successor.id); // replacement link is consistent
      expect(rows.filter((r) => !r.revokedAt)).toHaveLength(0); // family revoked by the reuse detection
      const reuse = await t.db.query(`SELECT count(*)::int n FROM auth_audit_event WHERE type='session.refresh_reuse_detected' AND "actorId"=$1`, [m.id]);
      expect(reuse.rows[0].n).toBe(2);
      // the winner's fresh pair is dead too (this is the documented strict policy)
      await t.http.post('/auth/refresh').send({ refreshToken: winner.refreshToken }).expect(401);
      await t.http.get('/auth/me').set(bearer(winner)).expect(401);
    });
  });

  // ---------------------------------------------------------------------------- factor lifecycle
  describe('owner factors', () => {
    async function ownerWithTwoTotp() {
      const cid = await t.newCompany();
      const o = await t.readyOwner(cid, `f${uniq()}@a.test`);
      const begin = await t.http.post('/auth/admin/factors/totp').set(bearer(o.tokens)).expect(200);
      const su = await t.stepUpToken(o.tokens, 'owner.factor.enroll', o.totpSecret);
      await t.http.post('/auth/admin/factors/totp/confirm').set(bearer(o.tokens)).set('X-Step-Up-Token', su).send({ factorId: begin.body.factorId, code: t.nextCode(begin.body.secret) }).expect(200);
      const list = (await t.http.get('/auth/admin/factors').set(bearer(o.tokens)).expect(200)).body as Array<{ id: string; confirmed: boolean }>;
      expect(list.filter((f) => f.confirmed)).toHaveLength(2);
      return { ...o, f1: list[0].id, f2: list[1].id };
    }
    const confirmedCount = async (id: string) =>
      (await t.db.query(`SELECT count(*)::int n FROM owner_auth_factor WHERE "ownerId"=$1 AND "confirmedAt" IS NOT NULL AND "revokedAt" IS NULL`, [id])).rows[0].n as number;

    it('two transactions removing two DIFFERENT factors can never leave the owner with zero (forced interleaving)', async () => {
      const o = await ownerWithTwoTotp();
      const factors = t.app.get(FactorService);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      // T1 removes factor 1 and stays OPEN (uncommitted) ...
      const t1 = t.dbs.tx(async (q) => { await factors.removeSafely(q, o.id, o.f1); await gate; });
      await sleep(200);
      // ... while T2 tries to remove factor 2. It must not be allowed to count a stale "2 confirmed".
      const t2 = t.dbs.tx((q) => factors.removeSafely(q, o.id, o.f2)).then(() => 'removed', (e: Error) => e.constructor.name);
      await sleep(500);
      release();
      await t1;
      expect(await t2).toBe('ConflictException');
      expect(await confirmedCount(o.id)).toBe(1);
    });

    it('two simultaneous HTTP removals of two different factors leave at least one factor', async () => {
      const o = await ownerWithTwoTotp();
      const su1 = await t.stepUpToken(o.tokens, 'owner.factor.remove', o.totpSecret);
      const su2 = await t.stepUpToken(o.tokens, 'owner.factor.remove', o.totpSecret);
      const res = await Promise.all([
        t.http.delete(`/auth/admin/factors/${o.f1}`).set(bearer(o.tokens)).set('X-Step-Up-Token', su1),
        t.http.delete(`/auth/admin/factors/${o.f2}`).set(bearer(o.tokens)).set('X-Step-Up-Token', su2),
      ]);
      expect(statuses(res)).toEqual([204, 409]);
      expect(await confirmedCount(o.id)).toBe(1);
    });

    it('one TOTP code presented on 4 logins at once is accepted once (replay guard is atomic)', async () => {
      const cid = await t.newCompany();
      const o = await t.readyOwner(cid, `t${uniq()}@a.test`);
      const challenges: string[] = [];
      for (let i = 0; i < 4; i++) {
        challenges.push((await t.http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200)).body.challengeToken);
      }
      const code = t.nextCode(o.totpSecret);
      const res = await Promise.all(challenges.map((c) => t.http.post('/auth/admin/login/owner/verify').send({ challengeToken: c, method: 'totp', code })));
      expect(statuses(res)).toEqual([200, 401, 401, 401]);
    });
  });

  // ---------------------------------------------------------------------------- operator codes
  describe('operator codes', () => {
    it('one working code redeemed by 5 simultaneous requests yields exactly one session', async () => {
      const cid = await t.newCompany();
      const email = `op${uniq()}@a.test`;
      await t.operator(cid, email);
      const code = await t.operatorCode(email);
      expect(code).toMatch(/^\d{6}$/);
      const res = await Promise.all(Array.from({ length: 5 }, () => t.http.post('/auth/admin/login/operator/verify-code').send({ email, code })));
      expect(statuses(res)).toEqual([200, 401, 401, 401, 401]);
    });

    it('10 simultaneous wrong guesses are capped at 5 attempts and then even the right code is refused', async () => {
      const cid = await t.newCompany();
      const email = `op${uniq()}@a.test`;
      const op = await t.operator(cid, email);
      const code = (await t.operatorCode(email))!;
      const wrong = Array.from({ length: 10 }, (_, i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, '0'));
      const res = await Promise.all(wrong.map((c) => t.http.post('/auth/admin/login/operator/verify-code').send({ email, code: c })));
      expect(res.every((r) => r.status === 401)).toBe(true);
      const row = await t.db.query(`SELECT "attemptCount" FROM admin_operator_code WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 1`, [op.id]);
      expect(row.rows[0].attemptCount).toBe(5);
      await t.http.post('/auth/admin/login/operator/verify-code').send({ email, code }).expect(401);
    });
  });

  // ---------------------------------------------------------------------------- assignments
  describe('platform assignments', () => {
    it('interleaved grants and revokes never leave more than one active assignment and never a server error', async () => {
      const w = await t.world();
      const owner = await t.readyOwner(w.companyA, `a${uniq()}@a.test`);
      const op = await t.operator(w.companyA, `o${uniq()}@a.test`);
      const jobs: Array<Promise<{ status: number; body: unknown }>> = [];
      for (let i = 0; i < 4; i++) {
        const g = await t.stepUpToken(owner.tokens, 'platform_assignment.grant', owner.totpSecret);
        const r = await t.stepUpToken(owner.tokens, 'platform_assignment.revoke', owner.totpSecret);
        jobs.push(
          Promise.resolve(t.http.post(`/auth/admin/operators/${op.id}/platform-assignments`).set(bearer(owner.tokens)).set('X-Step-Up-Token', g).send({ platformId: w.platformSchool })),
          Promise.resolve(t.http.delete(`/auth/admin/operators/${op.id}/platform-assignments/${w.platformSchool}`).set(bearer(owner.tokens)).set('X-Step-Up-Token', r)),
        );
      }
      const res = await Promise.all(jobs);
      expect(res.filter((r) => r.status >= 500).map((r) => ({ status: r.status, body: r.body }))).toEqual([]);
      const active = await t.db.query(`SELECT count(*)::int n FROM platform_assignment WHERE "operatorId"=$1 AND active`, [op.id]);
      expect(active.rows[0].n).toBeLessThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------- bootstrap
  describe('owner bootstrap', () => {
    it('5 simultaneous bootstraps create exactly one company and one owner', async () => {
      const b = await createTestApp(); // a pristine database: no company, no owner
      try {
        const passwords = b.app.get(PasswordService);
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            bootstrapOwner(b.dbs, b.users, passwords, { companyName: 'Acme', email: `first${i}@a.test`, password: 'a long enough passphrase' })
              .then((r) => r.created, () => 'error' as const)),
        );
        expect(results.filter((r) => r === true)).toHaveLength(1);
        const owners = await b.db.query(`SELECT count(*)::int n FROM owner`);
        const companies = await b.db.query(`SELECT count(*)::int n FROM company`);
        expect(owners.rows[0].n).toBe(1);
        expect(companies.rows[0].n).toBe(1);
      } finally {
        await b.close();
      }
    });
  });
});

// ------------------------------------------------------------------------------ rate limiting
describe('concurrency: rate-limit counters cannot be bypassed', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp({ RATE_LOGIN_IP_LIMIT: '10' }); await t.app.listen(0); });
  afterAll(() => t.close());

  it('30 parallel failed logins from one IP get exactly 10 answers and 20 x 429 (atomic counter)', async () => {
    const res = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      t.http.post('/auth/login').send({ email: `nobody${i}@a.test`, password: 'wrong password 123' })));
    expect(res.filter((r) => r.status === 401)).toHaveLength(10);
    expect(res.filter((r) => r.status === 429)).toHaveLength(20);
  });

  it('spoofing X-Forwarded-For does not change the key when the proxy is not trusted', async () => {
    const own = await createTestApp({ RATE_LOGIN_IP_LIMIT: '10' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 15; i++) {
        const r = await own.http.post('/auth/login').set('X-Forwarded-For', `203.0.113.${i}`).send({ email: 'x@a.test', password: 'wrong password 123' });
        codes.push(r.status);
      }
      expect(codes.filter((c) => c === 401)).toHaveLength(10);
      expect(codes.filter((c) => c === 429)).toHaveLength(5);
    } finally {
      await own.close();
    }
  });
});
