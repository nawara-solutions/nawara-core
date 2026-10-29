import { randomBytes, randomUUID } from 'node:crypto';
import { generateServiceToken } from '@nawara/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/app-config.js';
import { DbService, type Queryable } from '../src/db/db.service.js';
import { bindingDigest, canonicalBinding, parseBinding, requestHash, secretDigest } from '../src/receipts/receipt-binding.js';
import { bearer, claims, createTestApp, type TestCtx, type Tokens } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);
const PURPOSE = 'refund.authorize';
const ISSUE = '/auth/admin/authorization-receipts';
const CONSUME = '/auth/service/authorization-receipts/consume';
const LOOKUP = '/auth/service/authorization-receipts/consumptions/lookup';
const POLICY_BOTH = JSON.stringify({ callers: { 'payment-service': { operations: ['authorization_receipt.consume', 'authorization_receipt.lookup'] } } });

/** A connection-level failure: PostgreSQL never said what happened (no severity), so nothing is proven. */
const connectionLost = () => new Error('Connection terminated unexpectedly');
/** A PostgreSQL ERROR report: the transaction was rolled back, nothing committed. */
const statementError = () => Object.assign(new Error('canceling statement due to statement timeout'), { severity: 'ERROR', code: '57014' });

/**
 * Core V2 S2-Auth.2 (ADR-0067; D-A2 receipt contract §5, §10, §11, §17): the three receipt routes over real HTTP and PostgreSQL.
 */
describe('authorization receipt routes (S2-Auth.2)', () => {
  let t: TestCtx;
  const payment = generateServiceToken();
  const strangerToken = generateServiceToken().token; // never registered
  const pepper = randomBytes(32);
  beforeAll(async () => {
    t = await createTestApp({
      AUTHORIZATION_RECEIPT_PEPPER: pepper.toString('base64'),
      SERVICE_TOKENS: `payment-service:${payment.digest}`,
      AUTH_SERVICE_POLICY: POLICY_BOTH,
    });
  });
  afterAll(() => t.close());

  const ready = async () => {
    const companyId = await t.newCompany();
    const o = await t.readyOwner(companyId, `rr${uniq()}@a.test`);
    return { ...o, companyId };
  };
  type Ready = Awaited<ReturnType<typeof ready>>;
  const binding = (companyId: string, over: Record<string, unknown> = {}) => ({
    operation: 'refund', audience: 'payment-service', companyId, refundCaseId: randomUUID(), paymentId: randomUUID(),
    amount: 12_500, currency: 'TND', reason: 'service_not_delivered', ...over,
  });
  const key = () => `rk-${uniq()}${uniq()}`;
  /** `k: null` sends no Idempotency-Key header at all. */
  const post = (o: Ready, body: unknown, k: string | null = key()) => {
    const r = t.http.post(ISSUE).set(bearer(o.tokens as Tokens));
    return (k === null ? r : r.set('Idempotency-Key', k)).send(body as object);
  };
  const issue = async (o: Ready, b = binding(o.companyId), k = key()) => {
    const stepUpToken = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
    const r = await post(o, { stepUpToken, binding: b }, k);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { ...(r.body as { receiptId: string; secret: string; expiresAt: string }), binding: b, key: k, stepUpToken };
  };
  const svcPost = (path: string, body: unknown, token = payment.token) => t.http.post(path).set(bearer(token)).send(body as object);
  /** A receipt issued `ageMs` before the DATABASE's now, with the digests issuance would write (the test knows the pepper). */
  const backdated = async (o: Ready, ageMs: number) => {
    const b = binding(o.companyId);
    const canonical = canonicalBinding(parseBinding(b));
    const secret = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const su = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
    await t.db.query(
      `INSERT INTO authorization_receipt (id,"issuerUserId","sessionFamilyId","stepUpId","idempotencyKey","requestHash","secretDigest","bindingDigest","issuedAt","expiresAt")
       SELECT $1,$2,$3,$4,$5,$6,$7,$8, c.t, c.t + interval '10 minutes' FROM (SELECT clock_timestamp() - make_interval(secs => $9::double precision / 1000) AS t) c`,
      [id, o.id, (claims(o.tokens as Tokens) as { sid: string }).sid, su, key(), requestHash(pepper, canonical), secretDigest(pepper, secret),
        bindingDigest(pepper, canonical), ageMs],
    );
    return { receiptId: id, secret, binding: b };
  };
  const status = async (id: string) => (await t.db.query(`SELECT status FROM authorization_receipt WHERE id=$1`, [id])).rows[0]?.status;

  describe('AUTH-01 issuance', () => {
    it('201 with the secret once, no-store, and the expiry from the database', async () => {
      const o = await ready();
      const r = await post(o, { stepUpToken: await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret), binding: binding(o.companyId) });
      expect(r.status).toBe(201);
      expect(Object.keys(r.body).sort()).toEqual(['expiresAt', 'receiptId', 'secret']);
      expect(r.body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(r.headers['cache-control']).toBe('no-store');
      const row = (await t.db.query(`SELECT "expiresAt" FROM authorization_receipt WHERE id=$1`, [r.body.receiptId])).rows[0];
      expect(new Date(r.body.expiresAt).getTime()).toBe(row.expiresAt.getTime());
    });

    it('unauthenticated, a member and an operator are refused; nothing is issued', async () => {
      const o = await ready();
      const body = { stepUpToken: randomUUID(), binding: binding(o.companyId) };
      expect((await t.http.post(ISSUE).set('Idempotency-Key', key()).send(body)).status).toBe(401);
      expect((await t.http.post(ISSUE).set('Idempotency-Key', key()).set(bearer(payment.token)).send(body)).status).toBe(401); // a service token is not a user
      const w = await t.world();
      const m = await t.member(w.orgSchool1, `m${uniq()}@a.test`);
      const mt = (await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(200)).body;
      const rm = await t.http.post(ISSUE).set(bearer(mt)).set('Idempotency-Key', key()).send(body);
      expect([rm.status, rm.body.code]).toEqual([403, 'forbidden']);
      const op = await t.operator(o.companyId, `op${uniq()}@a.test`);
      const rop = await t.http.post(ISSUE).set(bearer(await t.operatorLogin(op.email))).set('Idempotency-Key', key()).send(body);
      expect([rop.status, rop.body.code]).toEqual([403, 'forbidden']);
      expect((await t.db.query(`SELECT count(*)::int AS n FROM authorization_receipt WHERE "issuerUserId"=$1`, [o.id])).rows[0].n).toBe(0);
    });

    it('Idempotency-Key is required and well-formed', async () => {
      const o = await ready();
      const su = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      for (const k of [null, '', 'short', 'has space in it', 'x'.repeat(129)]) {
        const r = await post(o, { stepUpToken: su, binding: binding(o.companyId) }, k);
        expect([r.status, r.body.code], String(k)).toEqual([400, 'idempotency_key_required']);
      }
    });

    it("another Company's binding is 400 receipt_binding_invalid; malformed bindings too; the proof is not burned", async () => {
      const o = await ready();
      const su = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      const other = await ready();
      for (const b of [binding(other.companyId), { ...binding(o.companyId), extra: 1 }, { ...binding(o.companyId), reason: 'free text' }, { ...binding(o.companyId), amount: 0 }]) {
        const r = await post(o, { stepUpToken: su, binding: b });
        expect([r.status, r.body.code]).toEqual([400, 'receipt_binding_invalid']);
        expect(JSON.stringify(r.body)).not.toContain(other.companyId);
      }
      expect((await post(o, { stepUpToken: su, binding: binding(o.companyId) })).status).toBe(201);
    });

    it('a missing, expired, reused, wrong-purpose, other-session or other-owner proof is 403 step_up_required; secret key cannot step up', async () => {
      const o = await ready();
      const b = () => binding(o.companyId);
      const refused = async (stepUpToken: unknown) => {
        const r = await post(o, { stepUpToken, binding: b() });
        expect([r.status, r.body.code], String(stepUpToken)).toEqual([403, 'step_up_required']);
      };
      await refused(randomUUID());
      const used = await issue(o);
      await refused(used.stepUpToken);
      await refused(await t.stepUpToken(o.tokens as Tokens, 'owner.factor.enroll', o.totpSecret));
      const other = await ready();
      await refused(await t.stepUpToken(other.tokens as Tokens, PURPOSE, other.totpSecret));
      const s2 = await t.ownerLogin({ email: o.email, password: o.password }, o.totpSecret);
      await refused(await t.stepUpToken(s2, PURPOSE, o.totpSecret));
      const expiring = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      t.clock.advance((t.cfg.stepUp.ttlSec + 1) * 1000); // step-up proofs keep their own (application-clock) lifetime
      try { await refused(expiring); } finally { t.clock.advance(-(t.cfg.stepUp.ttlSec + 1) * 1000); }
      const missing = await post(o, { binding: b() });
      expect([missing.status, missing.body.code]).toEqual([400, 'validation_error']);
      const sk = await t.stepUp(o.tokens as Tokens, PURPOSE, o.totpSecret, { method: 'secret_key', secretKey: 'x'.repeat(43), code: undefined });
      expect([sk.status, sk.body.code]).toEqual([400, 'step_up_unsupported']);
    });

    it('sequential replays: 409, never a secret; issued -> voided (lost), consumed -> already consumed, other body -> reused', async () => {
      const o = await ready();
      const r = await issue(o);
      const again = await post(o, { stepUpToken: r.stepUpToken, binding: r.binding }, r.key);
      expect([again.status, again.body.code, again.body.secret]).toEqual([409, 'receipt_issued_response_lost', undefined]);
      expect(await status(r.receiptId)).toBe('voided');
      const c = await issue(o);
      expect((await svcPost(CONSUME, { secret: c.secret, binding: c.binding, consumeRef: randomUUID() })).status).toBe(200);
      const rc = await post(o, { stepUpToken: c.stepUpToken, binding: c.binding }, c.key);
      expect([rc.status, rc.body.code, rc.body.secret]).toEqual([409, 'receipt_already_consumed', undefined]);
      const rr = await post(o, { stepUpToken: c.stepUpToken, binding: { ...c.binding, amount: 1 } }, c.key);
      expect([rr.status, rr.body.code]).toEqual([409, 'idempotency_key_reused']);
    });

    it('simultaneous requests with one key: at most one secret, never two valid receipts, losers follow the replay rules', async () => {
      for (let round = 0; round < 3; round++) {
        const o = await ready();
        const b = binding(o.companyId);
        const k = key();
        const proofs = [];
        for (let i = 0; i < 4; i++) proofs.push(await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret));
        const out = await Promise.all(proofs.map((stepUpToken) => post(o, { stepUpToken, binding: b }, k)));
        const secrets = out.filter((r) => r.status === 201);
        expect(secrets.length).toBeLessThanOrEqual(1);
        for (const r of out.filter((x) => x.status !== 201)) {
          expect([r.status, r.body.secret]).toEqual([409, undefined]);
          expect(['receipt_issued_response_lost', 'receipt_already_consumed']).toContain(r.body.code);
        }
        const rows = (await t.db.query(`SELECT status FROM authorization_receipt WHERE "issuerUserId"=$1 AND "idempotencyKey"=$2`, [o.id, k])).rows;
        expect(rows).toHaveLength(1);
        // a valid receipt exists only if NO duplicate arrived after it: a concurrent duplicate voids it like any replay (F-5)
        if (out.some((r) => r.status === 409)) expect(rows[0].status).toBe('voided');
        // the losers' proofs were not burned
        const burned = (await t.db.query(`SELECT count(*)::int AS n FROM owner_step_up WHERE id = ANY($1) AND "consumedAt" IS NOT NULL`, [proofs])).rows[0].n;
        expect(burned).toBe(secrets.length);
      }
    });
  });

  describe('AUTH-02 / AUTH-03 service authentication and authorization', () => {
    it('no token, an unknown token, an Owner bearer and forged caller headers are all 401; nothing is consumed', async () => {
      const o = await ready();
      const r = await issue(o);
      const body = { secret: r.secret, binding: r.binding, consumeRef: randomUUID() };
      const forged = { 'X-Service-Caller': 'payment-service', 'X-Caller-Service': 'payment-service', 'X-Forwarded-User': o.id, 'X-Service-Name': 'payment-service' };
      for (const path of [CONSUME, LOOKUP]) {
        expect((await t.http.post(path).send(body)).status).toBe(401);
        expect((await t.http.post(path).set(forged).send(body)).status).toBe(401);
        expect((await t.http.post(path).set(bearer(strangerToken)).set(forged).send(body)).status).toBe(401);
        expect((await t.http.post(path).set(bearer(o.tokens as Tokens)).set(forged).send(body)).status).toBe(401);
        expect((await t.http.post(path).set('Authorization', `Basic ${payment.token}`).send(body)).status).toBe(401);
      }
      expect(await status(r.receiptId)).toBe('issued');
    });

    it('only payment-service and (Core V2 S6e-H, H-2) billing-service can ever be admitted: another caller or operation refuses to boot', () => {
      const other = generateServiceToken();
      const env = { ...t.env, SERVICE_TOKENS: `audit-service:${other.digest}`, AUTH_SERVICE_POLICY: JSON.stringify({ callers: { 'audit-service': { operations: ['authorization_receipt.consume'] } } }) };
      expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/audit-service/);
      const billing = { ...t.env, SERVICE_TOKENS: `billing-service:${other.digest}`, AUTH_SERVICE_POLICY: JSON.stringify({ callers: { 'billing-service': { operations: ['authorization_receipt.consume'] } } }) };
      expect(() => loadConfig(billing as NodeJS.ProcessEnv)).not.toThrow();
      expect(() => loadConfig({ ...t.env, AUTH_SERVICE_POLICY: undefined } as NodeJS.ProcessEnv)).toThrow(/AUTH_SERVICE_POLICY is required/);
      const noPepper = { ...t.env, AUTHORIZATION_RECEIPT_PEPPER: undefined };
      expect(() => loadConfig(noPepper as NodeJS.ProcessEnv)).toThrow(/AUTHORIZATION_RECEIPT_PEPPER is required/);
    });
  });

  describe('AUTH-02 consumption', () => {
    it('200 with approvedBy from Auth; same consumeRef is idempotent; different consumeRef conflicts', async () => {
      const o = await ready();
      const r = await issue(o);
      const ref = randomUUID();
      const c = await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: ref });
      expect(c.status).toBe(200);
      expect(c.body).toEqual({ receiptId: r.receiptId, consumeRef: ref, consumedAt: expect.any(String), approvedBy: { userId: o.id }, companyId: o.companyId });
      expect(c.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(c.body)).not.toContain(r.secret);
      expect((await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: ref })).body).toEqual(c.body);
      const other = await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() });
      expect([other.status, other.body.code]).toEqual([409, 'consume_ref_conflict']);
    });

    it('cross-Company and any binding change is one 409 receipt_invalid; a wrong secret too; nothing changes', async () => {
      const o = await ready();
      const other = await ready();
      const r = await issue(o);
      const variants = [
        { ...r.binding, companyId: other.companyId }, { ...r.binding, amount: r.binding.amount + 1 }, { ...r.binding, paymentId: randomUUID() },
        { ...r.binding, legalOverride: true },
      ];
      for (const b of variants) {
        const x = await svcPost(CONSUME, { secret: r.secret, binding: b, consumeRef: randomUUID() });
        expect([x.status, x.body.code]).toEqual([409, 'receipt_invalid']);
      }
      const wrong = await svcPost(CONSUME, { secret: randomBytes(32).toString('base64url'), binding: r.binding, consumeRef: randomUUID() });
      expect([wrong.status, wrong.body.code]).toEqual([409, 'receipt_invalid']);
      const bad = await svcPost(CONSUME, { secret: r.secret, binding: { ...r.binding, audience: 'billing-service' }, consumeRef: randomUUID() });
      expect([bad.status, bad.body.code]).toEqual([400, 'receipt_binding_invalid']);
      expect((await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: 'not-a-uuid' })).status).toBe(400);
      expect(await status(r.receiptId)).toBe('issued');
    });

    it('a revoked issuer is 403 authority_revoked and the receipt stays issued', async () => {
      const o = await ready();
      const r = await issue(o);
      await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [o.id]);
      try {
        const x = await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() });
        expect([x.status, x.body.code]).toEqual([403, 'authority_revoked']);
        expect(await status(r.receiptId)).toBe('issued');
      } finally { await t.db.query(`UPDATE "user" SET "isActive"=true WHERE id=$1`, [o.id]); }
    });

    it('an expired receipt (by the database clock) is 409 receipt_expired; nothing changes; a voided one is receipt_invalid', async () => {
      const o = await ready();
      const old = await backdated(o, 10 * 60_000 + 1000);
      const x = await svcPost(CONSUME, { secret: old.secret, binding: old.binding, consumeRef: randomUUID() });
      expect([x.status, x.body.code]).toEqual([409, 'receipt_expired']);
      expect(await status(old.receiptId)).toBe('issued');
      const r = await issue(o);
      expect((await post(o, { stepUpToken: r.stepUpToken, binding: r.binding }, r.key)).status).toBe(409); // replay voids it
      const v = await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() });
      expect([v.status, v.body.code]).toEqual([409, 'receipt_invalid']);
    });

    it('concurrent consumers with different references: exactly one 200, the rest 409 consume_ref_conflict', async () => {
      const o = await ready();
      for (let i = 0; i < 4; i++) {
        const r = await issue(o);
        const out = await Promise.all(Array.from({ length: 4 }, () => svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() })));
        expect(out.filter((x) => x.status === 200)).toHaveLength(1);
        for (const x of out.filter((y) => y.status !== 200)) expect([x.status, x.body.code]).toEqual([409, 'consume_ref_conflict']);
        expect((await t.db.query(`SELECT count(*)::int AS n FROM authorization_receipt WHERE id=$1 AND status='consumed'`, [r.receiptId])).rows[0].n).toBe(1);
      }
    });
  });

  describe('AUTH-03 recovery', () => {
    it('returns the consumption for the same caller and binding, repeatedly, without a secret and without consuming anything', async () => {
      const o = await ready();
      const r = await issue(o);
      const ref = randomUUID();
      const c = (await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: ref })).body;
      for (let i = 0; i < 3; i++) {
        const l = await svcPost(LOOKUP, { consumeRef: ref, binding: r.binding });
        expect([l.status, l.body]).toEqual([200, c]);
      }
      // an issued receipt is never consumed by a lookup
      const fresh = await issue(o);
      const none = await svcPost(LOOKUP, { consumeRef: randomUUID(), binding: fresh.binding });
      expect([none.status, none.body.code]).toEqual([404, 'not_found']);
      expect(await status(fresh.receiptId)).toBe('issued');
      expect((await svcPost(LOOKUP, { consumeRef: ref, binding: r.binding, secret: r.secret })).status).toBe(400); // no secret accepted
    });

    it('another binding, another Company or an unknown reference is an indistinguishable 404', async () => {
      const o = await ready();
      const other = await ready();
      const r = await issue(o);
      const ref = randomUUID();
      await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: ref });
      const answers = await Promise.all([
        svcPost(LOOKUP, { consumeRef: ref, binding: { ...r.binding, companyId: other.companyId } }),
        svcPost(LOOKUP, { consumeRef: ref, binding: { ...r.binding, amount: 1 } }),
        svcPost(LOOKUP, { consumeRef: randomUUID(), binding: r.binding }),
      ]);
      for (const a of answers) expect([a.status, a.body.code, a.body.message]).toEqual([404, 'not_found', 'Not Found']);
    });
  });

  describe('fault injection: lost responses and uncertain outcomes (D-A2 §10)', () => {
    /** Replaces DbService.tx once with `mode`, for the duration of `fn`. */
    const once = async <T>(mode: 'commit_then_lose' | 'fail_proven' | 'fail_unknown', fn: () => Promise<T>, alsoBreakLookup = false) => {
      const dbs = t.app.get(DbService);
      const tx = dbs.tx.bind(dbs);
      const query = dbs.query.bind(dbs);
      let armed = true;
      dbs.tx = (async (work: (q: Queryable) => Promise<unknown>) => {
        if (!armed) return tx(work);
        armed = false;
        if (mode === 'fail_proven') throw statementError();
        if (mode === 'fail_unknown') throw connectionLost();
        await tx(work);
        if (alsoBreakLookup) dbs.query = (async () => { throw connectionLost(); }) as typeof dbs.query;
        throw connectionLost(); // committed, but the answer never arrived
      }) as typeof dbs.tx;
      try { return await fn(); } finally { dbs.tx = tx; dbs.query = query; }
    };

    it('consumption committed, answer lost: recovered from what committed (200), retries converge, a new reference conflicts', async () => {
      const o = await ready();
      const r = await issue(o);
      const ref = randomUUID();
      const first = await once('commit_then_lose', () => svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: ref }));
      expect(first.status).toBe(200);
      expect(first.body.approvedBy).toEqual({ userId: o.id });
      expect((await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: ref })).body).toEqual(first.body);
      expect((await svcPost(LOOKUP, { consumeRef: ref, binding: r.binding })).body).toEqual(first.body);
      expect((await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() })).body.code).toBe('consume_ref_conflict');
    });

    it('committed and even the recovery read fails: 503 receipt_outcome_unknown, never an invented answer; then a retry finds it', async () => {
      const o = await ready();
      const r = await issue(o);
      const ref = randomUUID();
      const first = await once('commit_then_lose', () => svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: ref }), true);
      expect([first.status, first.body.code]).toEqual([503, 'receipt_outcome_unknown']);
      expect(await status(r.receiptId)).toBe('consumed'); // it did commit: the 503 did not claim otherwise
      const retry = await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: ref });
      expect([retry.status, retry.body.consumeRef]).toEqual([200, ref]);
      expect((await svcPost(LOOKUP, { consumeRef: ref, binding: r.binding })).status).toBe(200);
    });

    it('not committed, proven by the database: 503 receipt_unavailable, the receipt stays issued, a retry consumes it', async () => {
      const o = await ready();
      const r = await issue(o);
      const ref = randomUUID();
      const first = await once('fail_proven', () => svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: ref }));
      expect([first.status, first.body.code]).toEqual([503, 'receipt_unavailable']);
      expect(await status(r.receiptId)).toBe('issued');
      expect((await svcPost(LOOKUP, { consumeRef: ref, binding: r.binding })).status).toBe(404);
      expect((await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: ref })).status).toBe(200);
    });

    it('not committed, but unprovable: 503 receipt_outcome_unknown; AUTH-03 says 404 (not yet); the same reference then consumes once', async () => {
      const o = await ready();
      const r = await issue(o);
      const ref = randomUUID();
      const first = await once('fail_unknown', () => svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: ref }));
      expect([first.status, first.body.code]).toEqual([503, 'receipt_outcome_unknown']);
      expect(await status(r.receiptId)).toBe('issued');
      expect((await svcPost(LOOKUP, { consumeRef: ref, binding: r.binding })).status).toBe(404);
      const retry = await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: ref });
      expect(retry.status).toBe(200);
      expect((await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() })).body.code).toBe('consume_ref_conflict');
    });

    it('issuance committed, answer lost: 503 receipt_outcome_unknown; replaying the key voids it (F-5) and never shows a secret', async () => {
      const o = await ready();
      const su = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      const b = binding(o.companyId);
      const k = key();
      const first = await once('commit_then_lose', () => post(o, { stepUpToken: su, binding: b }, k));
      expect([first.status, first.body.code, first.body.secret]).toEqual([503, 'receipt_outcome_unknown', undefined]);
      const replay = await post(o, { stepUpToken: su, binding: b }, k);
      expect([replay.status, replay.body.code, replay.body.secret]).toEqual([409, 'receipt_issued_response_lost', undefined]);
      const rows = (await t.db.query(`SELECT status FROM authorization_receipt WHERE "issuerUserId"=$1 AND "idempotencyKey"=$2`, [o.id, k])).rows;
      expect(rows).toEqual([{ status: 'voided' }]);
    });

    it('issuance proven not committed: 503 receipt_unavailable; the same key and proof then issue normally', async () => {
      const o = await ready();
      const su = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      const b = binding(o.companyId);
      const k = key();
      const first = await once('fail_proven', () => post(o, { stepUpToken: su, binding: b }, k));
      expect([first.status, first.body.code]).toEqual([503, 'receipt_unavailable']);
      expect((await post(o, { stepUpToken: su, binding: b }, k)).status).toBe(201);
    });
  });

  describe('secret handling', () => {
    it('no receipt secret, step-up proof, service token or binding value in logs, audit records or error bodies', async () => {
      const before = { json: t.jsonLogs.length, lines: t.logger.lines.length };
      const o = await ready();
      const r = await issue(o);
      const ref = randomUUID();
      const bodies = [
        (await post(o, { stepUpToken: r.stepUpToken, binding: r.binding }, r.key)).body,
        (await svcPost(CONSUME, { secret: r.secret, binding: { ...r.binding, amount: 7 }, consumeRef: ref })).body,
        (await svcPost(CONSUME, { secret: r.secret, binding: r.binding, consumeRef: 'x' })).body,
        (await svcPost(LOOKUP, { consumeRef: ref, binding: r.binding })).body,
        (await t.http.post(CONSUME).set(bearer(strangerToken)).send({ secret: r.secret, binding: r.binding, consumeRef: ref })).body,
      ];
      const audit = (await t.db.query(`SELECT metadata FROM auth_audit_event WHERE type LIKE 'authorization_receipt.%'`)).rows;
      const dump = JSON.stringify([t.jsonLogs.slice(before.json), t.logger.lines.slice(before.lines), audit, bodies]);
      for (const needle of [r.secret, r.stepUpToken, payment.token, strangerToken, r.binding.refundCaseId, r.binding.paymentId, ref]) {
        expect(dump).not.toContain(needle);
      }
    });
  });

  describe('regression', () => {
    it("an Owner's existing routes and the generic step-up verification are unchanged; refund proofs stay Auth-local", async () => {
      const o = await ready();
      expect((await t.http.get('/auth/admin/factors').set(bearer(o.tokens as Tokens))).status).toBe(200);
      const enroll = await t.stepUpToken(o.tokens as Tokens, 'owner.factor.enroll', o.totpSecret);
      expect((await t.http.post('/auth/step-up/verify').set(bearer(o.tokens as Tokens)).send({ purpose: 'owner.factor.enroll', stepUpToken: enroll })).status).toBe(204);
      const refund = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      const v = await t.http.post('/auth/step-up/verify').set(bearer(o.tokens as Tokens)).send({ purpose: PURPOSE, stepUpToken: refund });
      expect([v.status, v.body.code]).toEqual([403, 'step_up_required']);
      expect((await post(o, { stepUpToken: refund, binding: binding(o.companyId) })).status).toBe(201); // not burned by the refusal
      // a service token is never a user credential on Auth's user routes
      expect((await t.http.get('/auth/admin/factors').set(bearer(payment.token))).status).toBe(401);
      expect((claims(o.tokens as Tokens) as { sub: string }).sub).toBe(o.id);
    });
  });
});

describe('authorization receipt routes: a caller without the operation, and Auth without receipts configured', () => {
  it('payment-service holding only consume: AUTH-03 is 403 operation_not_permitted; AUTH-02 works', async () => {
    const payment = generateServiceToken();
    const t = await createTestApp({
      AUTHORIZATION_RECEIPT_PEPPER: randomBytes(32).toString('base64'),
      SERVICE_TOKENS: `payment-service:${payment.digest}`,
      AUTH_SERVICE_POLICY: JSON.stringify({ callers: { 'payment-service': { operations: ['authorization_receipt.consume'] } } }),
    });
    try {
      const companyId = await t.newCompany();
      const o = await t.readyOwner(companyId, `np${uniq()}@a.test`);
      const su = await t.stepUpToken(o.tokens, PURPOSE, o.totpSecret);
      const b = { operation: 'refund', audience: 'payment-service', companyId, refundCaseId: randomUUID(), paymentId: randomUUID(), amount: 5, currency: 'TND', reason: 'r' };
      const r = (await t.http.post(ISSUE).set(bearer(o.tokens)).set('Idempotency-Key', `k-${uniq()}${uniq()}`).send({ stepUpToken: su, binding: b }).expect(201)).body;
      const ref = randomUUID();
      const l = await t.http.post(LOOKUP).set(bearer(payment.token)).send({ consumeRef: ref, binding: b });
      expect([l.status, l.body.code]).toEqual([403, 'operation_not_permitted']);
      expect((await t.http.post(CONSUME).set(bearer(payment.token)).send({ secret: r.secret, binding: b, consumeRef: ref })).status).toBe(200);
    } finally { await t.close(); }
  });

  it('no SERVICE_TOKENS, no policy, no pepper: service routes are 401 for everyone, AUTH-01 is 503; the rest of Auth works', async () => {
    const t = await createTestApp();
    try {
      const companyId = await t.newCompany();
      const o = await t.readyOwner(companyId, `none${uniq()}@a.test`);
      const su = await t.stepUpToken(o.tokens, PURPOSE, o.totpSecret);
      const b = { operation: 'refund', audience: 'payment-service', companyId, refundCaseId: randomUUID(), paymentId: randomUUID(), amount: 5, currency: 'TND', reason: 'r' };
      const r = await t.http.post(ISSUE).set(bearer(o.tokens)).set('Idempotency-Key', `k-${uniq()}${uniq()}`).send({ stepUpToken: su, binding: b });
      expect([r.status, r.body.code]).toEqual([503, 'receipt_unavailable']);
      expect((await t.db.query(`SELECT "consumedAt" FROM owner_step_up WHERE id=$1`, [su])).rows[0].consumedAt).toBeNull();
      for (const path of [CONSUME, LOOKUP]) {
        expect((await t.http.post(path).set(bearer(generateServiceToken().token)).send({})).status).toBe(401);
      }
      expect((await t.http.get('/auth/admin/factors').set(bearer(o.tokens))).status).toBe(200);
    } finally { await t.close(); }
  });
});
