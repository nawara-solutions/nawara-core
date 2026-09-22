import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacHex } from '../src/crypto/hmac.js';
import { bearer, createTestApp, noReqId, type TestCtx } from './helpers/app.js';

const WED_0900 = new Date('2026-03-04T09:00:00Z'); // a Wednesday (dow 3)
const WED_1630 = new Date('2026-03-04T16:30:00Z');

describe('operator working code and session', () => {
  let t: TestCtx;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  beforeAll(async () => { t = await createTestApp(); w = await t.world(); });
  afterAll(() => t.close());

  const schedule = (id: string, dow: number, start = '08:00', end = '17:00') =>
    t.db.query(`INSERT INTO operator_schedule("userId","dayOfWeek","startTime","endTime") VALUES ($1,$2,$3,$4)`, [id, dow, start, end]);
  const verify = (email: string, code: string) => t.http.post('/auth/admin/login/operator/verify-code').send({ email, code });
  const req = (email: string) => t.http.post('/auth/admin/login/operator/request-code').send({ email });

  it('operators have no password: password login is impossible', async () => {
    const op = await t.operator(w.companyA, 'nopw@a.test');
    await t.http.post('/auth/login').send({ email: op.email, password: 'anything at all' }).expect(401);
    const row = await t.db.query(`SELECT "passwordHash" FROM "user" WHERE id=$1`, [op.id]);
    expect(row.rows[0].passwordHash).toBeNull();
  });

  it('a code is 6 digits, stored only as a peppered HMAC, and delivered only via the notification event', async () => {
    const op = await t.operator(w.companyA, 'hash@a.test');
    const code = await t.operatorCode(op.email);
    expect(code).toMatch(/^\d{6}$/);
    const row = await t.db.query(`SELECT "codeHash", purpose FROM admin_operator_code WHERE "userId"=$1`, [op.id]);
    expect(row.rows[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rows[0].codeHash).not.toContain(code);
    expect(row.rows[0].codeHash).toBe(hmacHex(t.cfg.secrets.operatorCodePepper, 'operator.code', op.id, 'login', code!));
    // a bare SHA-256 of the code (the weak scheme) would NOT match
    const { createHash } = await import('node:crypto');
    expect(row.rows[0].codeHash).not.toBe(createHash('sha256').update(code!).digest('hex'));
  });

  it('request-code always answers 204 and reveals nothing: unknown, blocked and unconfirmed issue no code', async () => {
    await req('ghost@a.test').then((r) => expect(r.status).toBe(204));
    const blocked = await t.operator(w.companyA, 'blk@a.test');
    await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [blocked.id]);
    const unconfirmed = await t.operator(w.companyA, 'unc@a.test', false);
    const n0 = t.bus.all('admin.operator_code_issued').length;
    for (const e of [blocked.email, unconfirmed.email]) await req(e).then((r) => expect(r.status).toBe(204));
    expect(t.bus.all('admin.operator_code_issued').length).toBe(n0);
  });

  it('a valid code creates a temporary session and cannot be used twice', async () => {
    const op = await t.operator(w.companyA, 'once@a.test');
    const code = (await t.operatorCode(op.email))!;
    const r = await verify(op.email, code);
    expect(r.status).toBe(200);
    await t.http.get('/auth/me').set(bearer(r.body)).expect(200);
    await verify(op.email, code).then((x) => expect(x.status).toBe(401)); // consumed
    const row = await t.db.query(`SELECT "consumedAt" FROM admin_operator_code WHERE "userId"=$1`, [op.id]);
    expect(row.rows[0].consumedAt).not.toBeNull();
  });

  it('a wrong code is a generic 401 that costs an attempt; 5 wrong attempts lock the code even against the right one', async () => {
    const op = await t.operator(w.companyA, 'lock@a.test');
    const code = (await t.operatorCode(op.email))!;
    const wrong = code === '000000' ? '111111' : '000000';
    const bodies = new Set<string>();
    for (let i = 0; i < 5; i++) { const r = await verify(op.email, wrong); expect(r.status).toBe(401); bodies.add(JSON.stringify(noReqId(r.body))); }
    const stored = await t.db.query(`SELECT "attemptCount" FROM admin_operator_code WHERE "userId"=$1`, [op.id]);
    expect(stored.rows[0].attemptCount).toBe(5);
    const right = await verify(op.email, code);
    expect(right.status).toBe(401);
    bodies.add(JSON.stringify(noReqId(right.body)));
    // unknown identifier gives the very same answer: no oracle for "which stage failed"
    const ghost = await verify('nobody@a.test', '123456');
    bodies.add(JSON.stringify(noReqId(ghost.body)));
    expect(bodies.size).toBe(1);
    // asking for a fresh code recovers (the old one is superseded, not deleted)
    const fresh = (await t.operatorCode(op.email))!;
    expect((await verify(op.email, fresh)).status).toBe(200);
    const rows = await t.db.query(`SELECT count(*)::int n, count("supersededAt")::int s FROM admin_operator_code WHERE "userId"=$1 AND purpose='login'`, [op.id]);
    expect(rows.rows[0]).toEqual({ n: 2, s: 1 });
  });

  it('requesting a new code supersedes the previous one (only the latest can authenticate)', async () => {
    const op = await t.operator(w.companyA, 'super@a.test');
    const c1 = (await t.operatorCode(op.email))!;
    const c2 = (await t.operatorCode(op.email))!;
    if (c1 !== c2) await verify(op.email, c1).then((r) => expect(r.status).toBe(401));
    expect((await verify(op.email, c2)).status).toBe(200);
  });

  describe('shift ceiling and working day', () => {
    it('the session cannot outlive today’s shift: access exp is clamped, refresh honors the ceiling, then a new code is needed', async () => {
      t.clock.set(WED_1630);
      const op = await t.operator(w.companyA, 'shift@a.test');
      await schedule(op.id, 3); // Wednesday 08:00–17:00 UTC
      const tk = await t.operatorLogin(op.email);
      expect(tk.expiresIn).toBe(30 * 60); // clamped to 17:00, not the 1h access TTL
      const row = await t.db.query(`SELECT "sessionExpiresAt","expiresAt" FROM refresh_token WHERE "userId"=$1`, [op.id]);
      expect(row.rows[0].sessionExpiresAt.toISOString()).toBe('2026-03-04T17:00:00.000Z');
      expect(row.rows[0].expiresAt <= row.rows[0].sessionExpiresAt).toBe(true); // refresh token cannot outlive it either
      // refresh before the ceiling works and keeps the ceiling
      t.clock.advance(10 * 60 * 1000);
      const r1 = await t.http.post('/auth/refresh').send({ refreshToken: tk.refreshToken }).expect(200);
      expect(r1.body.expiresIn).toBe(20 * 60);
      const rows = await t.db.query(`SELECT count(DISTINCT "sessionExpiresAt")::int n FROM refresh_token WHERE "userId"=$1`, [op.id]);
      expect(rows.rows[0].n).toBe(1);
      // after 17:00: the access token dies and refresh cannot extend the session
      t.clock.advance(21 * 60 * 1000);
      await t.http.get('/auth/me').set(bearer(r1.body)).expect(401);
      const r2 = await t.http.post('/auth/refresh').send({ refreshToken: r1.body.refreshToken });
      expect(r2.status).toBe(401);
      expect(r2.body.reason).toBe('session_ceiling_reached');
      // the whole family is revoked: the ceiling is a clean end, not extendable by retrying
      await t.http.post('/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
    });

    it('a code issued for the shift expires at the shift end', async () => {
      t.clock.set(WED_1630);
      const op = await t.operator(w.companyA, 'expire@a.test');
      await schedule(op.id, 3);
      const code = (await t.operatorCode(op.email))!;
      const row = await t.db.query(`SELECT "expiresAt" FROM admin_operator_code WHERE "userId"=$1`, [op.id]);
      expect(row.rows[0].expiresAt.toISOString()).toBe('2026-03-04T17:00:00.000Z');
      t.clock.advance(31 * 60 * 1000);
      await verify(op.email, code).then((r) => expect(r.status).toBe(401));
    });

    it('the next working day requires a NEW code', async () => {
      t.clock.set(WED_0900);
      const op = await t.operator(w.companyA, 'nextday@a.test');
      await schedule(op.id, 3); await schedule(op.id, 4);
      const yesterday = await t.operatorLogin(op.email);
      t.clock.set(new Date('2026-03-05T09:00:00Z')); // Thursday
      await t.http.post('/auth/refresh').send({ refreshToken: yesterday.refreshToken }).expect(401);
      const code = (await t.operatorCode(op.email))!;
      expect(code).toMatch(/^\d{6}$/);
      expect((await verify(op.email, code)).status).toBe(200);
    });

    it('DAY OFF, TIME OFF and OUTSIDE HOURS each issue no code; they are different denials', async () => {
      t.clock.set(WED_0900);
      const dayOff = await t.operator(w.companyA, 'dayoff@a.test'); await schedule(dayOff.id, 4);
      const timeOff = await t.operator(w.companyA, 'timeoff@a.test'); await schedule(timeOff.id, 3);
      await t.db.query(`INSERT INTO operator_time_off("userId",date) VALUES ($1,'2026-03-04')`, [timeOff.id]);
      const early = await t.operator(w.companyA, 'early@a.test'); await schedule(early.id, 3, '10:00', '18:00');
      for (const o of [dayOff, timeOff, early]) expect(await t.operatorCode(o.email)).toBeUndefined();
      const reasons = await t.db.query(`SELECT metadata->>'reason' r FROM auth_audit_event WHERE type='operator.code.request' AND "actorId" = ANY($1) ORDER BY id`, [[dayOff.id, timeOff.id, early.id]]);
      expect(reasons.rows.map((x) => x.r).sort((a, b) => a.localeCompare(b))).toEqual(['DAY_OFF', 'OUTSIDE_WORKING_HOURS', 'TIME_OFF']);
    });

    it('ZERO schedule rows is intentionally unrestricted (fail-open), not denied, with the flat fallback ceiling', async () => {
      t.clock.set(WED_0900);
      const op = await t.operator(w.companyA, 'noschedule@a.test');
      const tk = await t.operatorLogin(op.email);
      expect(tk.expiresIn).toBe(t.cfg.jwt.accessTtlSec);
      const row = await t.db.query(`SELECT "sessionExpiresAt" FROM refresh_token WHERE "userId"=$1`, [op.id]);
      expect(row.rows[0].sessionExpiresAt.getTime()).toBe(WED_0900.getTime() + t.cfg.operator.fallbackSessionSec * 1000);
    });

    it('the business calendar (PlatformNonWorkingDay) plays no part in operator login', async () => {
      t.clock.set(WED_0900);
      const op = await t.operator(w.companyA, 'holiday@a.test');
      await t.db.query(`INSERT INTO platform_non_working_day("platformId",type,date,label) VALUES ($1,'holiday','2026-03-04','Holiday')`, [w.platformSchool]);
      await t.db.query(`INSERT INTO platform_non_working_day("platformId",type,"dayOfWeek",label) VALUES ($1,'weekly_weekend',3,'Wed off')`, [w.platformSchool]);
      expect(await t.operatorCode(op.email)).toMatch(/^\d{6}$/);
    });

    it('schedule times are interpreted in the configured work timezone', async () => {
      const tz = await createTestApp({ WORK_TIMEZONE: 'Africa/Tunis' }); // UTC+1
      try {
        const ww = await tz.world();
        tz.clock.set(new Date('2026-03-04T15:30:00Z')); // 16:30 local
        const op = await tz.operator(ww.companyA, 'tz@a.test');
        await tz.db.query(`INSERT INTO operator_schedule("userId","dayOfWeek","startTime","endTime") VALUES ($1,3,'08:00','17:00')`, [op.id]);
        const tk = await tz.operatorLogin(op.email);
        expect(tk.expiresIn).toBe(30 * 60); // 17:00 local = 16:00Z
      } finally { await tz.close(); }
    });
  });

  describe('brute-force protection at the application layer', () => {
    it('is enforced per operator regardless of source IP, without revealing whether the operator exists', async () => {
      const r = await createTestApp({ RATE_OPERATOR_VERIFY_IDENTIFIER_LIMIT: '3' });
      try {
        const ww = await r.world();
        const op = await r.operator(ww.companyA, 'rl@a.test');
        const code = (await r.operatorCode(op.email))!;
        const wrong = code === '999999' ? '888888' : '999999';
        for (let i = 0; i < 3; i++) await r.http.post('/auth/admin/login/operator/verify-code').set('X-Forwarded-For', `203.0.113.${i}`).send({ email: op.email, code: wrong }).expect(401);
        // rotating IPs (even via a spoofed header) does not reset the per-operator bucket; the RIGHT code is now refused too
        await r.http.post('/auth/admin/login/operator/verify-code').set('X-Forwarded-For', '198.51.100.7').send({ email: op.email, code }).expect(429);
        // the limit is on the identifier, so an unknown identifier behaves identically (no existence oracle)
        for (let i = 0; i < 3; i++) await r.http.post('/auth/admin/login/operator/verify-code').send({ email: 'ghost@a.test', code: wrong }).expect(401);
        await r.http.post('/auth/admin/login/operator/verify-code').send({ email: 'ghost@a.test', code: wrong }).expect(429);
      } finally { await r.close(); }
    });

    it('has a global brake against guessing spread across many operators, and limits code requests', async () => {
      const r = await createTestApp({ RATE_OPERATOR_VERIFY_GLOBAL_LIMIT: '4', RATE_OPERATOR_REQUEST_IDENTIFIER_LIMIT: '2' });
      try {
        for (let i = 0; i < 4; i++) await r.http.post('/auth/admin/login/operator/verify-code').send({ email: `spray${i}@a.test`, code: '123456' }).expect(401);
        await r.http.post('/auth/admin/login/operator/verify-code').send({ email: 'spray9@a.test', code: '123456' }).expect(429);
        await r.http.post('/auth/admin/login/operator/request-code').send({ email: 'x@a.test' }).expect(204);
        await r.http.post('/auth/admin/login/operator/request-code').send({ email: 'x@a.test' }).expect(204);
        await r.http.post('/auth/admin/login/operator/request-code').send({ email: 'x@a.test' }).expect(429);
      } finally { await r.close(); }
    });

    it('a successful login clears the per-operator counter (legitimate use is not penalised)', async () => {
      const r = await createTestApp({ RATE_OPERATOR_VERIFY_IDENTIFIER_LIMIT: '3' });
      try {
        const ww = await r.world();
        const op = await r.operator(ww.companyA, 'clear@a.test');
        for (let round = 0; round < 3; round++) await r.operatorLogin(op.email); // 3 successes would exceed 3 hits if not reset
      } finally { await r.close(); }
    });
  });

  describe('lifecycle: create -> confirm -> work', () => {
    it('an owner creates an operator (step-up); the operator must confirm their contact before any working code', async () => {
      const cid = await t.newCompany();
      const owner = await t.readyOwner(cid, 'boss@c.test');
      const noStep = await t.http.post('/auth/admin/operators').set(bearer(owner.tokens)).send({ email: 'newop@c.test' });
      expect(noStep.status).toBe(403);
      const su = await t.stepUpToken(owner.tokens, 'operator.create', owner.totpSecret);
      const created = await t.http.post('/auth/admin/operators').set(bearer(owner.tokens)).set('X-Step-Up-Token', su).send({ email: 'newop@c.test' }).expect(201);
      const inCompany = await t.db.query(`SELECT "companyId" FROM operator WHERE "userId"=$1`, [created.body.id]);
      expect(inCompany.rows[0].companyId).toBe(cid); // company derived from the owner, never the body
      // unconfirmed: no login code
      expect(await t.operatorCode('newop@c.test')).toBeUndefined();
      const conf = t.bus.last('admin.operator_confirmation_code_issued').code as string;
      await t.http.post('/auth/admin/operators/confirm').send({ email: 'newop@c.test', code: '000000' === conf ? '111111' : '000000' }).expect(401);
      await t.http.post('/auth/admin/operators/confirm').send({ email: 'newop@c.test', code: conf }).expect(204);
      expect(await t.operatorCode('newop@c.test')).toMatch(/^\d{6}$/);
      // a confirmation code cannot be used as a login code (purpose-scoped)
      expect((await verify('newop@c.test', conf)).status).toBe(401);
    });
  });
});
