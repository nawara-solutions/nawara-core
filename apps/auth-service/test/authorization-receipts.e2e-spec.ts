import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/app-config.js';
import { StepUpService } from '../src/owner/step-up.service.js';
import { AuthorizationReceiptService, RECEIPT_LIFETIME_MS } from '../src/receipts/authorization-receipt.service.js';
import { bindingDigest, canonicalBinding, parseBinding, requestHash, secretDigest } from '../src/receipts/receipt-binding.js';
import { ReceiptError } from '../src/receipts/receipt-errors.js';
import { claims, createTestApp, type TestCtx, type Tokens } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);
const PURPOSE = 'refund.authorize';
const CALLER = 'payment-service';
const PEPPER = randomBytes(32).toString('base64');

/** The typed code of a rejected receipt operation (anything else fails the test). */
const codeOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof ReceiptError ? e.code : `unexpected: ${(e as Error)?.message}`; }
  return 'resolved';
};
const httpStatusOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as { getStatus?: () => number }).getStatus?.() ?? 'no status'; }
  return 'resolved';
};

/**
 * Core V2 S2-Auth.1 (ADR-0067; D-A2 receipt contract): the authorization receipt domain, exercised through the INTERNAL service (no
 * route exists in this slice) against a real PostgreSQL with every migration applied.
 */
describe('authorization receipts (S2-Auth.1)', () => {
  let t: TestCtx;
  let svc: AuthorizationReceiptService;
  beforeAll(async () => {
    t = await createTestApp({ AUTHORIZATION_RECEIPT_PEPPER: PEPPER });
    svc = t.app.get(AuthorizationReceiptService);
  });
  afterAll(() => t.close());

  const ready = async () => {
    const companyId = await t.newCompany();
    const o = await t.readyOwner(companyId, `rcpt${uniq()}@a.test`);
    const sid = (claims(o.tokens) as { sid: string }).sid;
    return { ...o, companyId, owner: { userId: o.id, sid } };
  };
  type Ready = Awaited<ReturnType<typeof ready>>;
  const binding = (companyId: string, over: Record<string, unknown> = {}) => ({
    operation: 'refund', audience: CALLER, companyId, refundCaseId: randomUUID(), paymentId: randomUUID(),
    amount: 4900, currency: 'TND', reason: 'duplicate_charge', ...over,
  });
  const key = () => `rk-${uniq()}${uniq()}`;
  const issue = async (o: Ready, b = binding(o.companyId), k = key()) => {
    const stepUpToken = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
    const r = await svc.issue(o.owner, { stepUpToken, idempotencyKey: k, binding: b });
    return { ...r, binding: b, key: k, stepUpToken };
  };
  const row = async (id: string) => (await t.db.query(`SELECT * FROM authorization_receipt WHERE id=$1`, [id])).rows[0];
  /**
   * S2-Auth.2: the database clock decides expiry, so an "old" receipt is made by inserting one whose issuedAt is `ageMs` before the
   * DATABASE's now, with the exact digests issuance would have written (the test knows the pepper). Returns what a caller would hold.
   */
  const backdated = async (o: Ready, ageMs: number) => {
    const pepper = Buffer.from(PEPPER, 'base64');
    const b = binding(o.companyId);
    const canonical = canonicalBinding(parseBinding(b));
    const secret = randomBytes(32).toString('base64url');
    const k = key();
    const id = randomUUID();
    const stepUp = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
    await t.db.query(
      `INSERT INTO authorization_receipt (id,"issuerUserId","sessionFamilyId","stepUpId","idempotencyKey","requestHash","secretDigest","bindingDigest","issuedAt","expiresAt")
       SELECT $1,$2,$3,$4,$5,$6,$7,$8, c.t, c.t + interval '10 minutes' FROM (SELECT clock_timestamp() - make_interval(secs => $9::double precision / 1000) AS t) c`,
      [id, o.id, o.owner.sid, stepUp, k, requestHash(pepper, canonical), secretDigest(pepper, secret), bindingDigest(pepper, canonical), ageMs],
    );
    return { receiptId: id, secret, binding: b, key: k };
  };
  const stepUpConsumed = async (id: string) =>
    (await t.db.query(`SELECT "consumedAt" FROM owner_step_up WHERE id=$1`, [id])).rows[0].consumedAt !== null;

  describe('issuance', () => {
    it('a factor-only refund.authorize step-up issues one receipt: 32 random bytes, 10 minutes, digests only', async () => {
      const o = await ready();
      const r = await issue(o);
      expect(r.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(r.secret, 'base64url')).toHaveLength(32);
      const db = await row(r.receiptId);
      // S2-Auth.2: both instants come from ONE reading of the database clock, and the response carries the stored expiry
      expect(db.expiresAt.getTime() - db.issuedAt.getTime()).toBe(RECEIPT_LIFETIME_MS);
      expect(r.expiresAt.getTime()).toBe(db.expiresAt.getTime());
      const dbNow = (await t.db.query(`SELECT clock_timestamp() AS n`)).rows[0].n as Date;
      expect(Math.abs(dbNow.getTime() - db.issuedAt.getTime())).toBeLessThan(60_000);
      expect(db).toMatchObject({ status: 'issued', issuerUserId: o.id, sessionFamilyId: o.owner.sid, stepUpId: r.stepUpToken, consumeRef: null });
      expect(db.secretDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(db.bindingDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(await stepUpConsumed(r.stepUpToken)).toBe(true);
      const audit = (await t.db.query(`SELECT outcome, "actorId", metadata FROM auth_audit_event WHERE type='authorization_receipt.issued' AND "targetId"=$1`, [r.receiptId])).rows;
      expect(audit).toEqual([{ outcome: 'success', actorId: o.id, metadata: { companyId: o.companyId, operation: 'refund' } }]);
    });

    it('the bare secret key cannot obtain a refund.authorize proof', async () => {
      const o = await ready();
      const sk = await t.stepUp(o.tokens as Tokens, PURPOSE, o.totpSecret, { method: 'secret_key', secretKey: 'x'.repeat(43), code: undefined });
      expect([sk.status, sk.body.code]).toEqual([400, 'step_up_unsupported']);
    });

    it('one issuance per proof: a used, missing, foreign-purpose or foreign-owner proof is refused and nothing is inserted', async () => {
      const o = await ready();
      const r = await issue(o);
      expect(await httpStatusOf(svc.issue(o.owner, { stepUpToken: r.stepUpToken, idempotencyKey: key(), binding: binding(o.companyId) }))).toBe(403);
      expect(await httpStatusOf(svc.issue(o.owner, { stepUpToken: undefined, idempotencyKey: key(), binding: binding(o.companyId) }))).toBe(403);
      const other = await t.stepUpToken(o.tokens as Tokens, 'owner.factor.enroll', o.totpSecret);
      expect(await httpStatusOf(svc.issue(o.owner, { stepUpToken: other, idempotencyKey: key(), binding: binding(o.companyId) }))).toBe(403);
      const o2 = await ready();
      const foreign = await t.stepUpToken(o2.tokens as Tokens, PURPOSE, o2.totpSecret);
      expect(await httpStatusOf(svc.issue(o.owner, { stepUpToken: foreign, idempotencyKey: key(), binding: binding(o.companyId) }))).toBe(403);
      expect(await stepUpConsumed(foreign)).toBe(false);
      expect((await t.db.query(`SELECT count(*)::int AS n FROM authorization_receipt WHERE "issuerUserId"=$1`, [o.id])).rows[0].n).toBe(1);
    });

    it("only the Owner's own Company: another Company is receipt_binding_invalid and the proof is NOT burned", async () => {
      const o = await ready();
      const su = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: binding(await t.newCompany()) }))).toBe('receipt_binding_invalid');
      expect(await stepUpConsumed(su)).toBe(false);
      await svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: binding(o.companyId) }); // still usable
    });

    it('an inactive Owner cannot issue (authority_revoked); the proof is not burned', async () => {
      const o = await ready();
      const su = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [o.id]);
      const code = await codeOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: binding(o.companyId) }));
      expect(code).toBe('authority_revoked');
      expect((await t.db.query(`SELECT count(*)::int AS n FROM authorization_receipt WHERE "issuerUserId"=$1`, [o.id])).rows[0].n).toBe(0);
    });

    it('malformed input is refused before anything is consumed', async () => {
      const o = await ready();
      const su = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: 'short', binding: binding(o.companyId) }))).toBe('validation_error');
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: { ...binding(o.companyId), reason: 'free text' } })))
        .toBe('receipt_binding_invalid');
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: { ...binding(o.companyId), note: 'x' } })))
        .toBe('receipt_binding_invalid');
      expect(await stepUpConsumed(su)).toBe(false);
    });
  });

  describe('issue replay (F-5, F-6; Q6)', () => {
    it('a replay of an issued receipt voids it, answers receipt_issued_response_lost, never returns a secret and burns no new proof', async () => {
      const o = await ready();
      const r = await issue(o);
      const su2 = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: su2, idempotencyKey: r.key, binding: r.binding }))).toBe('receipt_issued_response_lost');
      expect(await stepUpConsumed(su2)).toBe(false);
      expect((await row(r.receiptId)).status).toBe('voided');
      // terminal: the voided receipt can no longer be consumed, and a further replay gives the same answer
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('receipt_invalid');
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: su2, idempotencyKey: r.key, binding: r.binding }))).toBe('receipt_issued_response_lost');
      const voided = (await t.db.query(`SELECT count(*)::int AS n FROM auth_audit_event WHERE type='authorization_receipt.voided' AND "targetId"=$1`, [r.receiptId])).rows[0].n;
      expect(voided).toBe(1);
    });

    it('a replay of a consumed receipt answers receipt_already_consumed and never voids it', async () => {
      const o = await ready();
      const r = await issue(o);
      await svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() });
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: undefined, idempotencyKey: r.key, binding: r.binding }))).toBe('receipt_already_consumed');
      expect((await row(r.receiptId)).status).toBe('consumed');
    });

    it('the same key with a different binding is idempotency_key_reused; nothing changes', async () => {
      const o = await ready();
      const r = await issue(o);
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: undefined, idempotencyKey: r.key, binding: { ...r.binding, amount: 4901 } })))
        .toBe('idempotency_key_reused');
      expect((await row(r.receiptId)).status).toBe('issued');
    });

    it('a replay after expiry is receipt_expired: deterministic, no secret, nothing restored or changed', async () => {
      const o = await ready();
      const r = await backdated(o, RECEIPT_LIFETIME_MS + 1000);
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: undefined, idempotencyKey: r.key, binding: r.binding }))).toBe('receipt_expired');
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: undefined, idempotencyKey: r.key, binding: r.binding }))).toBe('receipt_expired');
      expect((await row(r.receiptId)).status).toBe('issued');
    });

    it('two concurrent issues with one key: at most one receipt exists and no secret is handed out twice', async () => {
      const o = await ready();
      const b = binding(o.companyId);
      const k = key();
      const s1 = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      const s2 = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      const out = await Promise.allSettled([s1, s2].map((s) => svc.issue(o.owner, { stepUpToken: s, idempotencyKey: k, binding: b })));
      const ok = out.filter((x) => x.status === 'fulfilled');
      expect(ok.length).toBeLessThanOrEqual(1);
      for (const x of out) if (x.status === 'rejected') expect((x.reason as ReceiptError).code).toBe('receipt_issued_response_lost');
      expect((await t.db.query(`SELECT count(*)::int AS n FROM authorization_receipt WHERE "idempotencyKey"=$1`, [k])).rows[0].n).toBe(1);
    });
  });

  describe('consumption (F-7 to F-11, F-18)', () => {
    it('consumes once; approvedBy is the issuer from Auth; the same consumeRef retry returns the original consumption', async () => {
      const o = await ready();
      const r = await issue(o);
      const ref = randomUUID();
      const c = await svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: ref });
      expect(c).toMatchObject({ receiptId: r.receiptId, consumeRef: ref, approvedBy: { userId: o.id }, companyId: o.companyId });
      expect(await svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: ref })).toEqual(c);
      expect(await row(r.receiptId)).toMatchObject({ status: 'consumed', consumeRef: ref, consumedBy: CALLER });
      const a = (await t.db.query(`SELECT metadata FROM auth_audit_event WHERE type='authorization_receipt.consumed' AND outcome='success' AND "targetId"=$1`, [r.receiptId])).rows;
      expect(a).toEqual([{ metadata: { caller: CALLER, companyId: o.companyId, approvedBy: o.id } }]);
    });

    it('a different consumeRef conflicts; a consumeRef that consumed another receipt conflicts', async () => {
      const o = await ready();
      const r1 = await issue(o);
      const r2 = await issue(o);
      const ref = randomUUID();
      await svc.consume(CALLER, { secret: r1.secret, binding: r1.binding, consumeRef: ref });
      expect(await codeOf(svc.consume(CALLER, { secret: r1.secret, binding: r1.binding, consumeRef: randomUUID() }))).toBe('consume_ref_conflict');
      expect(await codeOf(svc.consume(CALLER, { secret: r2.secret, binding: r2.binding, consumeRef: ref }))).toBe('consume_ref_conflict');
      expect((await row(r2.receiptId)).status).toBe('issued');
    });

    it('a wrong secret, a changed binding field or an unknown secret are one indistinguishable receipt_invalid; nothing changes', async () => {
      const o = await ready();
      const r = await issue(o);
      const ref = randomUUID();
      const wrongs: Array<[string, unknown]> = [
        ['secret', randomBytes(32).toString('base64url')], ['malformed secret', 'x'],
      ];
      for (const [, secret] of wrongs) expect(await codeOf(svc.consume(CALLER, { secret: secret as string, binding: r.binding, consumeRef: ref }))).toBe('receipt_invalid');
      for (const change of [{ amount: 4901 }, { currency: 'EUR' }, { paymentId: randomUUID() }, { refundCaseId: randomUUID() }, { reason: 'other' }, { legalOverride: true }]) {
        expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: { ...r.binding, ...change }, consumeRef: ref })), JSON.stringify(change)).toBe('receipt_invalid');
      }
      expect((await row(r.receiptId)).status).toBe('issued');
    });

    it('only the bound audience may consume', async () => {
      const o = await ready();
      const r = await issue(o);
      expect(await codeOf(svc.consume('billing-service', { secret: r.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('receipt_binding_invalid');
      expect((await row(r.receiptId)).status).toBe('issued');
    });

    it('expiry by the DATABASE clock: just past 10 minutes is receipt_expired and stays issued; just before, it is consumable', async () => {
      const o = await ready();
      const old = await backdated(o, RECEIPT_LIFETIME_MS + 50);
      const young = await backdated(o, RECEIPT_LIFETIME_MS - 30_000);
      expect(await codeOf(svc.consume(CALLER, { secret: old.secret, binding: old.binding, consumeRef: randomUUID() }))).toBe('receipt_expired');
      expect((await row(old.receiptId)).status).toBe('issued');
      const c = await svc.consume(CALLER, { secret: young.secret, binding: young.binding, consumeRef: randomUUID() });
      expect(c.consumedAt.getTime()).toBeLessThan((await row(young.receiptId)).expiresAt.getTime());
    });

    it("Auth's application clock cannot extend or shorten validity (skew between instances is irrelevant)", async () => {
      const o = await ready();
      const old = await backdated(o, RECEIPT_LIFETIME_MS + 1000);
      const proof = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret); // made before the skew (proofs and JWTs use the app clock)
      const live = await issue(o);
      const DAY = 24 * 3600_000;
      t.clock.advance(-DAY); // an instance whose clock is a day behind cannot revive an expired receipt
      try {
        expect(await codeOf(svc.consume(CALLER, { secret: old.secret, binding: old.binding, consumeRef: randomUUID() }))).toBe('receipt_expired');
        expect(await codeOf(svc.issue(o.owner, { stepUpToken: undefined, idempotencyKey: old.key, binding: old.binding }))).toBe('receipt_expired');
      } finally { t.clock.advance(DAY); }
      t.clock.advance(120_000); // issuance under a skewed app clock (2 minutes ahead, within the proof's own lifetime)
      try {
        const fresh = await svc.issue(o.owner, { stepUpToken: proof, idempotencyKey: key(), binding: binding(o.companyId) });
        const db = await row(fresh.receiptId); // exactly 10 minutes from the DATABASE's now, not from the app clock
        expect(db.expiresAt.getTime() - db.issuedAt.getTime()).toBe(RECEIPT_LIFETIME_MS);
        expect(Math.abs(Date.now() - db.issuedAt.getTime())).toBeLessThan(30_000);
        expect(Math.abs(t.clock.now().getTime() - db.issuedAt.getTime())).toBeGreaterThan(90_000);
      } finally { t.clock.advance(-120_000); }
      t.clock.advance(DAY); // an instance a day ahead cannot expire a live receipt early
      try {
        await svc.consume(CALLER, { secret: live.secret, binding: live.binding, consumeRef: randomUUID() });
      } finally { t.clock.advance(-DAY); }
    });

    it('authority revoked (inactive issuer) refuses WITHOUT consuming; the receipt stays issued (Q7)', async () => {
      const o = await ready();
      const r = await issue(o);
      await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [o.id]);
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('authority_revoked');
      expect((await row(r.receiptId)).status).toBe('issued');
      const denied = (await t.db.query(`SELECT metadata FROM auth_audit_event WHERE type='authorization_receipt.consumed' AND outcome='denied' AND "targetId"=$1`, [r.receiptId])).rows;
      expect(denied).toEqual([{ metadata: { caller: CALLER, reason: 'authority_revoked' } }]);
      await t.db.query(`UPDATE "user" SET "isActive"=true WHERE id=$1`, [o.id]);
    });

    it('two competing consumers: exactly one succeeds, the other conflicts', async () => {
      const o = await ready();
      for (let i = 0; i < 5; i++) {
        const r = await issue(o);
        const out = await Promise.allSettled([randomUUID(), randomUUID(), randomUUID()]
          .map((ref) => svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: ref })));
        expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
        for (const x of out) if (x.status === 'rejected') expect((x.reason as ReceiptError).code).toBe('consume_ref_conflict');
      }
    });

    it('same-reference concurrent retries all return the one consumption', async () => {
      const o = await ready();
      const r = await issue(o);
      const ref = randomUUID();
      const out = await Promise.all([1, 2, 3].map(() => svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: ref })));
      expect(new Set(out.map((c) => c.receiptId)).size).toBe(1);
      expect(new Set(out.map((c) => c.consumedAt.getTime())).size).toBe(1);
    });
  });

  describe('recovery lookup (F-10)', () => {
    it('finds the consumption by reference for the same caller and binding; anything else is not_found', async () => {
      const o = await ready();
      const r = await issue(o);
      const ref = randomUUID();
      const c = await svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: ref });
      expect(await svc.lookupConsumption(CALLER, { consumeRef: ref, binding: r.binding })).toEqual(c);
      expect(await codeOf(svc.lookupConsumption(CALLER, { consumeRef: randomUUID(), binding: r.binding }))).toBe('not_found');
      expect(await codeOf(svc.lookupConsumption(CALLER, { consumeRef: ref, binding: { ...r.binding, amount: 1 } }))).toBe('not_found');
      expect(await codeOf(svc.lookupConsumption('other-service', { consumeRef: ref, binding: { ...r.binding } }))).toBe('not_found');
    });
  });

  describe('Auth-local purpose', () => {
    it('POST /auth/step-up/verify (verifyForService) refuses a refund.authorize proof without consuming it', async () => {
      const o = await ready();
      const su = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      expect(await httpStatusOf(t.app.get(StepUpService).verifyForService(t.dbs, { ownerId: o.id, sid: o.owner.sid, purpose: PURPOSE, token: su }))).toBe(403);
      expect(await stepUpConsumed(su)).toBe(false);
    });
  });

  /**
   * Core V2 S6e Auth prerequisite (the Owner's R6E-3, 2026-10-29): an Owner's contest-or-accept decision on one Payment dispute is a
   * receipt bound to the exact dispute, payment, decision, Company and audience, issued only after the dedicated factor-only
   * `payment.dispute.decide` step-up. Every refund receipt rule above applies unchanged; these cases prove the separation.
   */
  describe('dispute decision receipts (S6e prerequisite, R6E-3)', () => {
    const DECIDE = 'payment.dispute.decide';
    const decision = (companyId: string, over: Record<string, unknown> = {}) => ({
      operation: 'dispute_decision', audience: CALLER, companyId, disputeId: randomUUID(), paymentId: randomUUID(), decision: 'contest', ...over,
    });
    const issueDecision = async (o: Ready, b = decision(o.companyId), k = key()) => {
      const stepUpToken = await t.stepUpToken(o.tokens as Tokens, DECIDE, o.totpSecret);
      const r = await svc.issue(o.owner, { stepUpToken, idempotencyKey: k, binding: b });
      return { ...r, binding: b, key: k, stepUpToken };
    };
    const receipts = async (userId: string) => (await t.db.query(`SELECT count(*)::int AS n FROM authorization_receipt WHERE "issuerUserId"=$1`, [userId])).rows[0].n;

    it('a factor-only payment.dispute.decide step-up issues one decision receipt, consumed once by payment-service for exactly that binding', async () => {
      const o = await ready();
      const r = await issueDecision(o);
      expect(r.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await stepUpConsumed(r.stepUpToken)).toBe(true);
      const audit = (await t.db.query(`SELECT metadata FROM auth_audit_event WHERE type='authorization_receipt.issued' AND "targetId"=$1`, [r.receiptId])).rows;
      expect(audit).toEqual([{ metadata: { companyId: o.companyId, operation: 'dispute_decision' } }]);
      const ref = randomUUID();
      const c = await svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: ref });
      expect(c).toMatchObject({ receiptId: r.receiptId, consumeRef: ref, approvedBy: { userId: o.id }, companyId: o.companyId });
      expect(await svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: ref })).toEqual(c);
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('consume_ref_conflict');
      expect(await svc.lookupConsumption(CALLER, { consumeRef: ref, binding: r.binding })).toEqual(c);
    });

    it('the bare secret key cannot obtain a payment.dispute.decide proof', async () => {
      const o = await ready();
      const sk = await t.stepUp(o.tokens as Tokens, DECIDE, o.totpSecret, { method: 'secret_key', secretKey: 'x'.repeat(43), code: undefined });
      expect([sk.status, sk.body.code]).toEqual([400, 'step_up_unsupported']);
    });

    it('purpose separation: a refund proof never issues a decision receipt, a decision proof never issues a refund receipt; neither is burned', async () => {
      const o = await ready();
      const refundProof = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      expect(await httpStatusOf(svc.issue(o.owner, { stepUpToken: refundProof, idempotencyKey: key(), binding: decision(o.companyId) }))).toBe(403);
      expect(await stepUpConsumed(refundProof)).toBe(false);
      const decideProof = await t.stepUpToken(o.tokens as Tokens, DECIDE, o.totpSecret);
      expect(await httpStatusOf(svc.issue(o.owner, { stepUpToken: decideProof, idempotencyKey: key(), binding: binding(o.companyId) }))).toBe(403);
      expect(await stepUpConsumed(decideProof)).toBe(false);
      for (const other of ['billing.assistance.dispute.resolve', 'audit.legal_hold.place', 'owner.factor.enroll']) {
        const p = await t.stepUpToken(o.tokens as Tokens, other, o.totpSecret);
        expect(await httpStatusOf(svc.issue(o.owner, { stepUpToken: p, idempotencyKey: key(), binding: decision(o.companyId) })), other).toBe(403);
        expect(await stepUpConsumed(p), other).toBe(false);
      }
      expect(await receipts(o.id)).toBe(0);
      // both proofs stay usable for their own operation
      await svc.issue(o.owner, { stepUpToken: refundProof, idempotencyKey: key(), binding: binding(o.companyId) });
      await svc.issue(o.owner, { stepUpToken: decideProof, idempotencyKey: key(), binding: decision(o.companyId) });
      expect(await receipts(o.id)).toBe(2);
    });

    it("a receipt never authorizes another decision, dispute, payment, Company or a refund: one indistinguishable receipt_invalid; nothing changes", async () => {
      const o = await ready();
      const r = await issueDecision(o);
      const ref = randomUUID();
      for (const change of [{ decision: 'accept' }, { disputeId: randomUUID() }, { paymentId: randomUUID() }]) {
        expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: { ...r.binding, ...change }, consumeRef: ref })), JSON.stringify(change)).toBe('receipt_invalid');
      }
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: binding(o.companyId), consumeRef: ref }))).toBe('receipt_invalid');
      // another Company: the issuer is not its Owner, so the binding digest differs (refused, never consumed)
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: { ...r.binding, companyId: await t.newCompany() }, consumeRef: ref }))).toBe('receipt_invalid');
      expect(await codeOf(svc.consume('billing-service', { secret: r.secret, binding: r.binding, consumeRef: ref }))).toBe('receipt_binding_invalid');
      expect((await row(r.receiptId)).status).toBe('issued');
      // and an accept receipt is not a contest receipt
      const accept = await issueDecision(o, decision(o.companyId, { disputeId: r.binding.disputeId, paymentId: r.binding.paymentId, decision: 'accept' }));
      expect(await codeOf(svc.consume(CALLER, { secret: accept.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('receipt_invalid');
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: accept.binding, consumeRef: randomUUID() }))).toBe('receipt_invalid');
    });

    it("only the Owner's own Company; an inactive Owner neither issues nor has a decision consumed; proofs are not burned", async () => {
      const o = await ready();
      const su = await t.stepUpToken(o.tokens as Tokens, DECIDE, o.totpSecret);
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: decision(await t.newCompany()) }))).toBe('receipt_binding_invalid');
      expect(await stepUpConsumed(su)).toBe(false);
      await svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: decision(o.companyId) }); // still usable
      const r2 = await issueDecision(o);
      const su2 = await t.stepUpToken(o.tokens as Tokens, DECIDE, o.totpSecret);
      await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [o.id]);
      try {
        expect(await codeOf(svc.issue(o.owner, { stepUpToken: su2, idempotencyKey: key(), binding: decision(o.companyId) }))).toBe('authority_revoked');
        expect(await codeOf(svc.consume(CALLER, { secret: r2.secret, binding: r2.binding, consumeRef: randomUUID() }))).toBe('authority_revoked');
        expect((await row(r2.receiptId)).status).toBe('issued');
      } finally {
        await t.db.query(`UPDATE "user" SET "isActive"=true WHERE id=$1`, [o.id]);
      }
    });

    it('replay of the issue key never returns a secret: it voids the decision receipt, and another decision under the key is idempotency_key_reused', async () => {
      const o = await ready();
      const r = await issueDecision(o);
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: undefined, idempotencyKey: r.key, binding: { ...r.binding, decision: 'accept' } }))).toBe('idempotency_key_reused');
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: undefined, idempotencyKey: r.key, binding: r.binding }))).toBe('receipt_issued_response_lost');
      expect((await row(r.receiptId)).status).toBe('voided');
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('receipt_invalid');
    });

    it('two concurrent consumers of one decision receipt: exactly one succeeds', async () => {
      const o = await ready();
      const r = await issueDecision(o);
      const out = await Promise.allSettled([0, 1, 2, 3].map(() => svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() })));
      expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      for (const x of out) if (x.status === 'rejected') expect((x.reason as ReceiptError).code).toBe('consume_ref_conflict');
    });

    it('POST /auth/step-up/verify (verifyForService) refuses a payment.dispute.decide proof without consuming it', async () => {
      const o = await ready();
      const su = await t.stepUpToken(o.tokens as Tokens, DECIDE, o.totpSecret);
      expect(await httpStatusOf(t.app.get(StepUpService).verifyForService(t.dbs, { ownerId: o.id, sid: o.owner.sid, purpose: DECIDE, token: su }))).toBe(403);
      expect(await stepUpConsumed(su)).toBe(false);
    });
  });

  /**
   * Core V2 S6e-H Auth prerequisite (the Owner's H-2, 2026-10-29): an Owner's placement and release of one fraud hold are receipts bound to the
   * exact Company, hold, beneficiary, product (and placement reason), issued only after their own dedicated factor-only step-up and
   * consumed only by billing-service. Every receipt rule above applies unchanged.
   */
  describe('fraud-hold receipts (S6e-H prerequisite, H-2)', () => {
    const PLACE = 'billing.fraud_hold.place';
    const RELEASE = 'billing.fraud_hold.release';
    const BILLING = 'billing-service';
    const hold = (companyId: string, over: Record<string, unknown> = {}) => ({
      operation: 'fraud_hold_place', audience: BILLING, companyId, holdId: randomUUID(), beneficiaryUserId: randomUUID(), productId: randomUUID(), reason: 'account_takeover', ...over,
    });
    const releaseOf = (b: Record<string, unknown>) => (({ reason: _r, ...o }) => ({ ...o, operation: 'fraud_hold_release' }))(b as { reason: unknown });
    const issueWith = async (o: Ready, purpose: string, b: Record<string, unknown>, k = key()) => {
      const stepUpToken = await t.stepUpToken(o.tokens as Tokens, purpose, o.totpSecret);
      const r = await svc.issue(o.owner, { stepUpToken, idempotencyKey: k, binding: b });
      return { ...r, binding: b, key: k, stepUpToken };
    };

    it('a placement and a release, each after its own factor-only step-up, consumed once by billing-service for exactly their binding', async () => {
      const o = await ready();
      const p = await issueWith(o, PLACE, hold(o.companyId));
      expect(await stepUpConsumed(p.stepUpToken)).toBe(true);
      const audit = (await t.db.query(`SELECT metadata FROM auth_audit_event WHERE type='authorization_receipt.issued' AND "targetId"=$1`, [p.receiptId])).rows;
      expect(audit).toEqual([{ metadata: { companyId: o.companyId, operation: 'fraud_hold_place' } }]);
      const ref = randomUUID();
      const c = await svc.consume(BILLING, { secret: p.secret, binding: p.binding, consumeRef: ref });
      expect(c).toMatchObject({ receiptId: p.receiptId, consumeRef: ref, approvedBy: { userId: o.id }, companyId: o.companyId });
      expect(await svc.consume(BILLING, { secret: p.secret, binding: p.binding, consumeRef: ref })).toEqual(c);
      expect(await svc.lookupConsumption(BILLING, { consumeRef: ref, binding: p.binding })).toEqual(c);
      const r = await issueWith(o, RELEASE, releaseOf(p.binding));
      expect((await svc.consume(BILLING, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() })).receiptId).toBe(r.receiptId);
    });

    it('only billing-service consumes them, and billing-service consumes nothing else', async () => {
      const o = await ready();
      const p = await issueWith(o, PLACE, hold(o.companyId));
      expect(await codeOf(svc.consume(CALLER, { secret: p.secret, binding: p.binding, consumeRef: randomUUID() }))).toBe('receipt_binding_invalid');
      const refund = await issue(o);
      expect(await codeOf(svc.consume(BILLING, { secret: refund.secret, binding: refund.binding, consumeRef: randomUUID() }))).toBe('receipt_binding_invalid');
      expect((await row(p.receiptId)).status).toBe('issued');
      expect((await row(refund.receiptId)).status).toBe('issued');
    });

    it('purpose separation: placement, release, refund and dispute proofs each issue only their own operation; a refused proof is not burned', async () => {
      const o = await ready();
      const b = hold(o.companyId);
      const pairs: Array<[string, Record<string, unknown>]> = [[RELEASE, b], [PURPOSE, b], ['payment.dispute.decide', b], [PLACE, releaseOf(b)], [PLACE, binding(o.companyId)]];
      for (const [purpose, bnd] of pairs) {
        const su = await t.stepUpToken(o.tokens as Tokens, purpose, o.totpSecret);
        expect(await httpStatusOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: bnd })), `${purpose} ${String(bnd.operation)}`).toBe(403);
        expect(await stepUpConsumed(su)).toBe(false);
      }
      const sk = await t.stepUp(o.tokens as Tokens, PLACE, o.totpSecret, { method: 'secret_key', secretKey: 'x'.repeat(43), code: undefined });
      expect([sk.status, sk.body.code]).toEqual([400, 'step_up_unsupported']);
    });

    it('a receipt never authorizes another hold, beneficiary, product, reason, Company or the other action: one indistinguishable receipt_invalid', async () => {
      const o = await ready();
      const p = await issueWith(o, PLACE, hold(o.companyId));
      for (const change of [{ holdId: randomUUID() }, { beneficiaryUserId: randomUUID() }, { productId: randomUUID() }, { reason: 'chargeback_abuse' }, { companyId: await t.newCompany() }]) {
        expect(await codeOf(svc.consume(BILLING, { secret: p.secret, binding: { ...p.binding, ...change }, consumeRef: randomUUID() })), JSON.stringify(change)).toBe('receipt_invalid');
      }
      expect(await codeOf(svc.consume(BILLING, { secret: p.secret, binding: releaseOf(p.binding), consumeRef: randomUUID() }))).toBe('receipt_invalid');
      expect((await row(p.receiptId)).status).toBe('issued');
      // another Company's hold cannot even be issued; a revoked Owner's receipt is not consumed
      const su = await t.stepUpToken(o.tokens as Tokens, PLACE, o.totpSecret);
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: hold(await t.newCompany()) }))).toBe('receipt_binding_invalid');
      expect(await stepUpConsumed(su)).toBe(false);
      await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [o.id]);
      try {
        expect(await codeOf(svc.consume(BILLING, { secret: p.secret, binding: p.binding, consumeRef: randomUUID() }))).toBe('authority_revoked');
        expect((await row(p.receiptId)).status).toBe('issued');
      } finally {
        await t.db.query(`UPDATE "user" SET "isActive"=true WHERE id=$1`, [o.id]);
      }
    });

    it('replay never returns a secret; concurrent consumers record exactly one consumption', async () => {
      const o = await ready();
      const p = await issueWith(o, PLACE, hold(o.companyId));
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: undefined, idempotencyKey: p.key, binding: { ...p.binding, reason: 'chargeback_abuse' } }))).toBe('idempotency_key_reused');
      const q = await issueWith(o, PLACE, hold(o.companyId));
      const out = await Promise.allSettled([0, 1, 2, 3].map(() => svc.consume(BILLING, { secret: q.secret, binding: q.binding, consumeRef: randomUUID() })));
      expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: undefined, idempotencyKey: p.key, binding: p.binding }))).toBe('receipt_issued_response_lost');
    });

    it('POST /auth/step-up/verify (verifyForService) refuses both fraud-hold proofs without consuming them', async () => {
      const o = await ready();
      for (const purpose of [PLACE, RELEASE]) {
        const su = await t.stepUpToken(o.tokens as Tokens, purpose, o.totpSecret);
        expect(await httpStatusOf(t.app.get(StepUpService).verifyForService(t.dbs, { ownerId: o.id, sid: o.owner.sid, purpose, token: su }))).toBe(403);
        expect(await stepUpConsumed(su)).toBe(false);
      }
    });
  });

  /**
   * Core V2 S6f Auth prerequisite (the Owner's R6F-5, 2026-10-29): an Owner's record of one external recovery-surplus repayment is a receipt
   * bound to the exact Company, surplus, Organization, amount and currency, issued only after its own factor-only step-up and consumed only
   * by billing-service. Every receipt rule above applies unchanged.
   */
  describe('external recovery-surplus receipts (S6f prerequisite, R6F-5)', () => {
    const EXT = 'billing.recovery_surplus.record_external';
    const BILLING = 'billing-service';
    const surplus = (companyId: string, over: Record<string, unknown> = {}) => ({
      operation: 'recovery_surplus_external', audience: BILLING, companyId, surplusId: randomUUID(), organizationId: randomUUID(), amount: 1200, currency: 'TND', ...over,
    });
    const issueExt = async (o: Ready, b = surplus(o.companyId), k = key()) => {
      const stepUpToken = await t.stepUpToken(o.tokens as Tokens, EXT, o.totpSecret);
      return { ...(await svc.issue(o.owner, { stepUpToken, idempotencyKey: k, binding: b })), binding: b, key: k, stepUpToken };
    };

    it('issued after its own factor-only step-up and consumed once by billing-service for exactly that binding', async () => {
      const o = await ready();
      const r = await issueExt(o);
      expect(await stepUpConsumed(r.stepUpToken)).toBe(true);
      const ref = randomUUID();
      const c = await svc.consume(BILLING, { secret: r.secret, binding: r.binding, consumeRef: ref });
      expect(c).toMatchObject({ receiptId: r.receiptId, consumeRef: ref, approvedBy: { userId: o.id }, companyId: o.companyId });
      expect(await svc.consume(BILLING, { secret: r.secret, binding: r.binding, consumeRef: ref })).toEqual(c);
      expect(await codeOf(svc.consume(BILLING, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('consume_ref_conflict');
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('receipt_binding_invalid');
    });

    it('purpose separation both ways; refused proofs are not burned; the secret key never qualifies', async () => {
      const o = await ready();
      const b = surplus(o.companyId);
      for (const purpose of ['billing.fraud_hold.place', PURPOSE, 'payment.dispute.decide']) {
        const su = await t.stepUpToken(o.tokens as Tokens, purpose, o.totpSecret);
        expect(await httpStatusOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: b })), purpose).toBe(403);
        expect(await stepUpConsumed(su)).toBe(false);
      }
      const su = await t.stepUpToken(o.tokens as Tokens, EXT, o.totpSecret);
      expect(await httpStatusOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: binding(o.companyId) }))).toBe(403);
      expect(await stepUpConsumed(su)).toBe(false);
      const sk = await t.stepUp(o.tokens as Tokens, EXT, o.totpSecret, { method: 'secret_key', secretKey: 'x'.repeat(43), code: undefined });
      expect([sk.status, sk.body.code]).toEqual([400, 'step_up_unsupported']);
    });

    it('never authorizes another surplus, Organization, amount, currency or Company; revoked authority consumes nothing; verify refuses the proof', async () => {
      const o = await ready();
      const r = await issueExt(o);
      for (const change of [{ surplusId: randomUUID() }, { organizationId: randomUUID() }, { amount: 1201 }, { currency: 'EUR' }, { companyId: await t.newCompany() }]) {
        expect(await codeOf(svc.consume(BILLING, { secret: r.secret, binding: { ...r.binding, ...change }, consumeRef: randomUUID() })), JSON.stringify(change)).toBe('receipt_invalid');
      }
      expect((await row(r.receiptId)).status).toBe('issued');
      const su = await t.stepUpToken(o.tokens as Tokens, EXT, o.totpSecret);
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: surplus(await t.newCompany()) }))).toBe('receipt_binding_invalid');
      expect(await stepUpConsumed(su)).toBe(false);
      expect(await httpStatusOf(t.app.get(StepUpService).verifyForService(t.dbs, { ownerId: o.id, sid: o.owner.sid, purpose: EXT, token: su }))).toBe(403);
      expect(await stepUpConsumed(su)).toBe(false);
      await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [o.id]);
      try {
        expect(await codeOf(svc.consume(BILLING, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('authority_revoked');
      } finally {
        await t.db.query(`UPDATE "user" SET "isActive"=true WHERE id=$1`, [o.id]);
      }
    });
  });

  /**
   * Core V2 S6g Auth prerequisite (the Owner's R6G-1, 2026-10-30): an Owner's L-4 application of one late assisted settlement is a receipt
   * bound to the exact Company, late settlement, request, beneficiary and closed reason code, issued only after its own factor-only
   * step-up and consumed only by billing-service. Every receipt rule above applies unchanged.
   */
  describe('late-settlement application receipts (S6g prerequisite, R6G-1)', () => {
    const LATE = 'billing.late_settlement.apply';
    const BILLING = 'billing-service';
    const late = (companyId: string, over: Record<string, unknown> = {}) => ({
      operation: 'late_settlement_apply', audience: BILLING, companyId, lateSettlementId: randomUUID(), assistanceRequestId: randomUUID(),
      beneficiaryUserId: randomUUID(), reasonCode: 'cash_not_returned_attested', ...over,
    });
    const issueLate = async (o: Ready, b = late(o.companyId), k = key()) => {
      const stepUpToken = await t.stepUpToken(o.tokens as Tokens, LATE, o.totpSecret);
      return { ...(await svc.issue(o.owner, { stepUpToken, idempotencyKey: k, binding: b })), binding: b, key: k, stepUpToken };
    };

    it('issued after its own factor-only step-up and consumed once by billing-service for exactly that binding; a replay of the key re-answers it', async () => {
      const o = await ready();
      const r = await issueLate(o);
      expect(await stepUpConsumed(r.stepUpToken)).toBe(true);
      const ref = randomUUID();
      const c = await svc.consume(BILLING, { secret: r.secret, binding: r.binding, consumeRef: ref });
      expect(c).toMatchObject({ receiptId: r.receiptId, consumeRef: ref, approvedBy: { userId: o.id }, companyId: o.companyId });
      expect(await svc.consume(BILLING, { secret: r.secret, binding: r.binding, consumeRef: ref })).toEqual(c);
      expect(await codeOf(svc.consume(BILLING, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('consume_ref_conflict');
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('receipt_binding_invalid');
    });

    it('purpose separation both ways; refused proofs are not burned; the secret key never qualifies', async () => {
      const o = await ready();
      const b = late(o.companyId);
      for (const purpose of ['billing.recovery_surplus.record_external', 'billing.fraud_hold.place', PURPOSE, 'payment.dispute.decide']) {
        const su = await t.stepUpToken(o.tokens as Tokens, purpose, o.totpSecret);
        expect(await httpStatusOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: b })), purpose).toBe(403);
        expect(await stepUpConsumed(su)).toBe(false);
      }
      const su = await t.stepUpToken(o.tokens as Tokens, LATE, o.totpSecret);
      expect(await httpStatusOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: binding(o.companyId) }))).toBe(403);
      expect(await stepUpConsumed(su)).toBe(false);
      const sk = await t.stepUp(o.tokens as Tokens, LATE, o.totpSecret, { method: 'secret_key', secretKey: 'x'.repeat(43), code: undefined });
      expect([sk.status, sk.body.code]).toEqual([400, 'step_up_unsupported']);
    });

    it('never authorizes another late settlement, request, beneficiary, reason or Company; an open reason is refused; revoked authority consumes nothing; verify refuses the proof', async () => {
      const o = await ready();
      const r = await issueLate(o);
      for (const change of [{ lateSettlementId: randomUUID() }, { assistanceRequestId: randomUUID() }, { beneficiaryUserId: randomUUID() },
        { reasonCode: 'cash_not_returned_evidenced' }, { companyId: await t.newCompany() }]) {
        expect(await codeOf(svc.consume(BILLING, { secret: r.secret, binding: { ...r.binding, ...change }, consumeRef: randomUUID() })), JSON.stringify(change)).toBe('receipt_invalid');
      }
      expect((await row(r.receiptId)).status).toBe('issued');
      const su = await t.stepUpToken(o.tokens as Tokens, LATE, o.totpSecret);
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: late(await t.newCompany()) }))).toBe('receipt_binding_invalid');
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: late(o.companyId, { reasonCode: 'owner_override' }) }))).toBe('receipt_binding_invalid');
      expect(await stepUpConsumed(su)).toBe(false);
      expect(await httpStatusOf(t.app.get(StepUpService).verifyForService(t.dbs, { ownerId: o.id, sid: o.owner.sid, purpose: LATE, token: su }))).toBe(403);
      expect(await stepUpConsumed(su)).toBe(false);
      await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [o.id]);
      try {
        expect(await codeOf(svc.consume(BILLING, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('authority_revoked');
      } finally {
        await t.db.query(`UPDATE "user" SET "isActive"=true WHERE id=$1`, [o.id]);
      }
    });
  });

  /**
   * Core V2 S6h Auth prerequisite (the Owner's R6H-3, R6H-8, 2026-10-30): an Owner's provider-fact association (consumed by payment-service)
   * and an Owner's recovery write-off (consumed by billing-service), each a receipt bound to its exact resource, issued only after its own
   * factor-only step-up. Every receipt rule above applies unchanged.
   */
  describe('provider-fact association and recovery write-off receipts (S6h prerequisite, R6H-3, R6H-8)', () => {
    const ASSOC = 'payment.provider_fact.associate';
    const WRITE_OFF = 'billing.recovery.write_off';
    const BILLING = 'billing-service';
    const assoc = (companyId: string, over: Record<string, unknown> = {}) => ({
      operation: 'provider_fact_associate', audience: CALLER, companyId, factId: randomUUID(), kind: 'capture', amount: 9000, currency: 'TND', targetType: 'payment', targetId: randomUUID(), ...over,
    });
    const writeOff = (companyId: string, over: Record<string, unknown> = {}) => ({
      operation: 'recovery_write_off', audience: BILLING, companyId, obligationId: randomUUID(), organizationId: randomUUID(), amount: 6100, currency: 'TND', ...over,
    });
    const issueWith = async (o: Ready, purpose: string, b: Record<string, unknown>) => {
      const stepUpToken = await t.stepUpToken(o.tokens as Tokens, purpose, o.totpSecret);
      return { ...(await svc.issue(o.owner, { stepUpToken, idempotencyKey: key(), binding: b })), binding: b, stepUpToken };
    };

    it('each is issued after its own factor-only step-up and consumed once, only by its own audience, for exactly that binding', async () => {
      const o = await ready();
      const a = await issueWith(o, ASSOC, assoc(o.companyId));
      expect(await stepUpConsumed(a.stepUpToken)).toBe(true);
      expect(await codeOf(svc.consume(BILLING, { secret: a.secret, binding: a.binding, consumeRef: randomUUID() }))).toBe('receipt_binding_invalid');
      const ref = randomUUID();
      const c = await svc.consume(CALLER, { secret: a.secret, binding: a.binding, consumeRef: ref });
      expect(c).toMatchObject({ receiptId: a.receiptId, consumeRef: ref, approvedBy: { userId: o.id }, companyId: o.companyId });
      expect(await svc.consume(CALLER, { secret: a.secret, binding: a.binding, consumeRef: ref })).toEqual(c);
      expect(await codeOf(svc.consume(CALLER, { secret: a.secret, binding: a.binding, consumeRef: randomUUID() }))).toBe('consume_ref_conflict');
      const w = await issueWith(o, WRITE_OFF, writeOff(o.companyId));
      expect(await codeOf(svc.consume(CALLER, { secret: w.secret, binding: w.binding, consumeRef: randomUUID() }))).toBe('receipt_binding_invalid');
      expect(await svc.consume(BILLING, { secret: w.secret, binding: w.binding, consumeRef: randomUUID() })).toMatchObject({ receiptId: w.receiptId, approvedBy: { userId: o.id } });
    });

    it('purpose separation both ways; refused proofs are not burned; the secret key never qualifies', async () => {
      const o = await ready();
      for (const [purpose, b] of [[ASSOC, writeOff(o.companyId)], [WRITE_OFF, assoc(o.companyId)], ['billing.late_settlement.apply', assoc(o.companyId)], [PURPOSE, writeOff(o.companyId)]] as const) {
        const su = await t.stepUpToken(o.tokens as Tokens, purpose, o.totpSecret);
        expect(await httpStatusOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: b })), purpose).toBe(403);
        expect(await stepUpConsumed(su)).toBe(false);
      }
      for (const purpose of [ASSOC, WRITE_OFF]) {
        const sk = await t.stepUp(o.tokens as Tokens, purpose, o.totpSecret, { method: 'secret_key', secretKey: 'x'.repeat(43), code: undefined });
        expect([sk.status, sk.body.code], purpose).toEqual([400, 'step_up_unsupported']);
      }
    });

    it('never authorizes another fact, kind, amount, currency, destination, obligation, Organization or Company; revoked authority consumes nothing; verify refuses both proofs', async () => {
      const o = await ready();
      const a = await issueWith(o, ASSOC, assoc(o.companyId));
      for (const change of [{ factId: randomUUID() }, { kind: 'refund' }, { amount: 9001 }, { currency: 'EUR' }, { targetType: 'refund_authorization' }, { targetId: randomUUID() }, { companyId: await t.newCompany() }]) {
        expect(await codeOf(svc.consume(CALLER, { secret: a.secret, binding: { ...a.binding, ...change }, consumeRef: randomUUID() })), JSON.stringify(change)).toBe('receipt_invalid');
      }
      const w = await issueWith(o, WRITE_OFF, writeOff(o.companyId));
      for (const change of [{ obligationId: randomUUID() }, { organizationId: randomUUID() }, { amount: 6000 }, { currency: 'EUR' }]) {
        expect(await codeOf(svc.consume(BILLING, { secret: w.secret, binding: { ...w.binding, ...change }, consumeRef: randomUUID() })), JSON.stringify(change)).toBe('receipt_invalid');
      }
      expect((await row(a.receiptId)).status).toBe('issued');
      expect((await row(w.receiptId)).status).toBe('issued');
      for (const [purpose, b] of [[ASSOC, assoc(await t.newCompany())], [WRITE_OFF, writeOff(await t.newCompany())]] as const) {
        const su = await t.stepUpToken(o.tokens as Tokens, purpose, o.totpSecret);
        expect(await codeOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: b })), purpose).toBe('receipt_binding_invalid');
        expect(await httpStatusOf(t.app.get(StepUpService).verifyForService(t.dbs, { ownerId: o.id, sid: o.owner.sid, purpose, token: su })), purpose).toBe(403);
        expect(await stepUpConsumed(su)).toBe(false);
      }
      await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [o.id]);
      try {
        expect(await codeOf(svc.consume(CALLER, { secret: a.secret, binding: a.binding, consumeRef: randomUUID() }))).toBe('authority_revoked');
        expect(await codeOf(svc.consume(BILLING, { secret: w.secret, binding: w.binding, consumeRef: randomUUID() }))).toBe('authority_revoked');
      } finally {
        await t.db.query(`UPDATE "user" SET "isActive"=true WHERE id=$1`, [o.id]);
      }
    });
  });

  describe('secret handling', () => {
    it('no plaintext secret, canonical binding or pepper in the database, the audit records or the logs', async () => {
      const o = await ready();
      const r = await issue(o);
      await svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() });
      await codeOf(svc.consume(CALLER, { secret: r.secret, binding: { ...r.binding, amount: 1 }, consumeRef: randomUUID() }));
      const canonical = canonicalBinding(parseBinding(r.binding));
      const pepperHex = Buffer.from(PEPPER, 'base64').toString('hex');
      const dump = JSON.stringify([
        (await t.db.query(`SELECT * FROM authorization_receipt`)).rows,
        (await t.db.query(`SELECT * FROM auth_audit_event WHERE type LIKE 'authorization_receipt.%'`)).rows,
        t.logger.lines, t.jsonLogs,
      ]);
      for (const needle of [r.secret, canonical, PEPPER, pepperHex, r.binding.refundCaseId, r.binding.paymentId]) expect(dump).not.toContain(needle);
    });
  });

  describe('database guarantees (for every role)', () => {
    const insert = (o: Ready, over: Record<string, unknown> = {}) => {
      const v = {
        id: randomUUID(), issuerUserId: o.id, sessionFamilyId: o.owner.sid, stepUpId: randomUUID(), idempotencyKey: key(),
        requestHash: 'a'.repeat(64), secretDigest: randomBytes(32).toString('hex'), bindingDigest: 'b'.repeat(64), status: 'issued',
        issuedAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-01-01T00:10:00Z'), ...over,
      };
      return t.db.query(
        `INSERT INTO authorization_receipt (id,"issuerUserId","sessionFamilyId","stepUpId","idempotencyKey","requestHash","secretDigest","bindingDigest",status,"issuedAt","expiresAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, Object.values(v),
      );
    };

    it('refuses a non-issued insert, a lifetime other than 10 minutes and malformed digests', async () => {
      const o = await ready();
      await expect(insert(o, { status: 'consumed' })).rejects.toThrow(); // FK on stepUpId or the guard: either refuses
      const su = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      await expect(insert(o, { stepUpId: su, status: 'consumed' })).rejects.toThrow(/always inserted issued/);
      await expect(insert(o, { stepUpId: su, expiresAt: new Date('2026-01-01T00:11:00Z') })).rejects.toThrow(/authorization_receipt_lifetime/);
      await expect(insert(o, { stepUpId: su, secretDigest: 'plaintext' })).rejects.toThrow(/secretDigest_check|check constraint/);
    });

    it('allows only issued -> consumed | voided; terminal states, digests, issuer and session never change; no DELETE', async () => {
      const o = await ready();
      const r = await issue(o);
      const id = r.receiptId;
      await expect(t.db.query(`UPDATE authorization_receipt SET "secretDigest"=$2 WHERE id=$1`, [id, 'c'.repeat(64)])).rejects.toThrow(/immutable/);
      await expect(t.db.query(`UPDATE authorization_receipt SET "bindingDigest"=$2 WHERE id=$1`, [id, 'c'.repeat(64)])).rejects.toThrow(/immutable/);
      await expect(t.db.query(`UPDATE authorization_receipt SET "voidedAt"="issuedAt" WHERE id=$1`, [id])).rejects.toThrow(/issued -> consumed/);
      await expect(t.db.query(`UPDATE authorization_receipt SET status='voided', "voidedAt"="issuedAt", "issuerUserId"=$2 WHERE id=$1`, [id, randomUUID()]))
        .rejects.toThrow();
      await expect(t.db.query(`UPDATE authorization_receipt SET status='consumed', "consumedAt"="expiresAt", "consumeRef"=$2, "consumedBy"='payment-service' WHERE id=$1`, [id, randomUUID()]))
        .rejects.toThrow(/consumed_in_time/);
      await expect(t.db.query(`UPDATE authorization_receipt SET status='consumed' WHERE id=$1`, [id])).rejects.toThrow(/state_pairing/);
      await expect(t.db.query(`DELETE FROM authorization_receipt WHERE id=$1`, [id])).rejects.toThrow(/cannot be deleted/);
      await svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() });
      await expect(t.db.query(`UPDATE authorization_receipt SET status='voided', "consumedAt"=NULL, "consumeRef"=NULL, "consumedBy"=NULL, "voidedAt"=now() WHERE id=$1`, [id]))
        .rejects.toThrow(/terminal/);
      await expect(t.db.query(`UPDATE authorization_receipt SET "consumeRef"=$2 WHERE id=$1`, [id, randomUUID()])).rejects.toThrow(/terminal/);
    });
  });

  describe('migration 0012', () => {
    it('the down migration removes exactly the receipt objects; the up migration restores them', async () => {
      const dir = join(import.meta.dirname, '../db/migrations');
      const objects = async () => (await t.db.query(
        `SELECT (to_regclass('authorization_receipt') IS NOT NULL) AS tbl,
                EXISTS (SELECT 1 FROM pg_proc WHERE proname='authorization_receipt_guard') AS fn,
                (SELECT count(*)::int FROM pg_tables WHERE schemaname='public') AS tables`,
      )).rows[0];
      const before = await objects();
      expect(before).toMatchObject({ tbl: true, fn: true });
      await t.db.query(readFileSync(join(dir, 'down/0012_authorization_receipt.down.sql'), 'utf8'));
      expect(await objects()).toEqual({ tbl: false, fn: false, tables: before.tables - 1 });
      await t.db.query(readFileSync(join(dir, '0012_authorization_receipt.sql'), 'utf8'));
      expect(await objects()).toEqual(before);
    });
  });

  describe('capture-specific refund receipts (Core V2 R6H-5, the Owner\'s decision 2026-10-30)', () => {
    it('a receipt bound to one capture fact is consumed only for exactly that capture; never as an ordinary refund or for another capture', async () => {
      const o = await ready();
      const capture = randomUUID();
      const r = await issue(o, binding(o.companyId, { captureFactId: capture }));
      const ordinary = (({ captureFactId: _c, ...b }) => b)(r.binding as Record<string, unknown>);
      // a refused consumption changes nothing: the receipt stays issued and is then consumed for its own capture
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: ordinary, consumeRef: randomUUID() }))).toBe('receipt_invalid');
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: { ...r.binding, captureFactId: randomUUID() }, consumeRef: randomUUID() }))).toBe('receipt_invalid');
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: { ...r.binding, captureFactId: capture.toUpperCase() }, consumeRef: randomUUID() })))
        .toBe('receipt_binding_invalid');
      expect((await row(r.receiptId)).status).toBe('issued');
      const ref = randomUUID();
      const c = await svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: ref });
      expect(c).toMatchObject({ consumeRef: ref, approvedBy: { userId: o.id }, companyId: o.companyId });
      expect(await svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: ref })).toEqual(c); // the same consumption, answered again
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('consume_ref_conflict'); // never twice
      // recovery after a lost response: only for the same capture-specific binding
      expect(await svc.lookupConsumption(CALLER, { consumeRef: ref, binding: r.binding })).toEqual(c);
      expect(await codeOf(svc.lookupConsumption(CALLER, { consumeRef: ref, binding: ordinary }))).toBe('not_found');
      expect(await codeOf(svc.lookupConsumption(CALLER, { consumeRef: ref, binding: { ...r.binding, captureFactId: randomUUID() } }))).toBe('not_found');
    });

    it('an ordinary receipt never authorizes a capture-specific refund; its shape and behaviour are unchanged', async () => {
      const o = await ready();
      const r = await issue(o);
      expect('captureFactId' in r.binding).toBe(false);
      expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: { ...r.binding, captureFactId: randomUUID() }, consumeRef: randomUUID() }))).toBe('receipt_invalid');
      expect((await row(r.receiptId)).status).toBe('issued');
      await svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() });
      expect((await row(r.receiptId)).status).toBe('consumed');
    });

    it('issuance: the same refund.authorize factor-only proof; a malformed capture fact or an unexpected field is refused before the proof is burned', async () => {
      const o = await ready();
      const su = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
      for (const bad of [{ captureFactId: null }, { captureFactId: 'fact-1' }, { captureFactId: randomUUID().toUpperCase() }, { captureFactIds: [randomUUID()] }]) {
        expect(await codeOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: key(), binding: binding(o.companyId, bad) })), JSON.stringify(bad)).toBe('receipt_binding_invalid');
      }
      expect(await stepUpConsumed(su)).toBe(false);
      const k = key();
      const b = binding(o.companyId, { captureFactId: randomUUID() });
      const r = await svc.issue(o.owner, { stepUpToken: su, idempotencyKey: k, binding: b });
      expect(r.secret).toEqual(expect.any(String));
      expect(await stepUpConsumed(su)).toBe(true);
      // the issue replay hash covers the capture fact: the same key with another capture is a different request
      expect(await codeOf(svc.issue(o.owner, { stepUpToken: su, idempotencyKey: k, binding: { ...b, captureFactId: randomUUID() } }))).toBe('idempotency_key_reused');
      const audit = (await t.db.query(`SELECT metadata FROM auth_audit_event WHERE type='authorization_receipt.issued' AND "targetId"=$1`, [r.receiptId])).rows;
      expect(audit.map((a) => a.metadata)).toEqual([{ companyId: o.companyId, operation: 'refund' }]); // no capture fact in Auth's audit (no scope change)
    });
  });
});

describe('authorization receipts without the pepper (fail closed)', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());

  it('Auth works; every receipt operation is receipt_unavailable and no proof is consumed', async () => {
    const svc = t.app.get(AuthorizationReceiptService);
    const companyId = await t.newCompany();
    const o = await t.readyOwner(companyId, `nop${uniq()}@a.test`); // login, enrolment and step-up all work
    const sid = (claims(o.tokens) as { sid: string }).sid;
    const su = await t.stepUpToken(o.tokens, PURPOSE, o.totpSecret);
    const b = { operation: 'refund', audience: CALLER, companyId, refundCaseId: randomUUID(), paymentId: randomUUID(), amount: 1, currency: 'TND', reason: 'r' };
    expect(await codeOf(svc.issue({ userId: o.id, sid }, { stepUpToken: su, idempotencyKey: 'k'.repeat(16), binding: b }))).toBe('receipt_unavailable');
    expect(await codeOf(svc.consume(CALLER, { secret: 'x'.repeat(43), binding: b, consumeRef: randomUUID() }))).toBe('receipt_unavailable');
    expect(await codeOf(svc.lookupConsumption(CALLER, { consumeRef: randomUUID(), binding: b }))).toBe('receipt_unavailable');
    expect((await t.db.query(`SELECT "consumedAt" FROM owner_step_up WHERE id=$1`, [su])).rows[0].consumedAt).toBeNull();
  });

  it('a configured receipt pepper must differ from every other key', () => {
    expect(() => loadConfig({ ...t.env, AUTHORIZATION_RECEIPT_PEPPER: t.env.JOIN_CODE_PEPPER } as NodeJS.ProcessEnv)).toThrow(/AUTHORIZATION_RECEIPT_PEPPER/);
    expect(() => loadConfig({ ...t.env, AUTHORIZATION_RECEIPT_PEPPER: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv)).not.toThrow();
  });
});
