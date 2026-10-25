import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/app-config.js';
import { StepUpService } from '../src/owner/step-up.service.js';
import { AuthorizationReceiptService, RECEIPT_LIFETIME_MS } from '../src/receipts/authorization-receipt.service.js';
import { canonicalBinding, parseBinding } from '../src/receipts/receipt-binding.js';
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
  const stepUpConsumed = async (id: string) =>
    (await t.db.query(`SELECT "consumedAt" FROM owner_step_up WHERE id=$1`, [id])).rows[0].consumedAt !== null;

  describe('issuance', () => {
    it('a factor-only refund.authorize step-up issues one receipt: 32 random bytes, 10 minutes, digests only', async () => {
      const o = await ready();
      const r = await issue(o);
      expect(r.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(r.secret, 'base64url')).toHaveLength(32);
      expect(r.expiresAt.getTime() - t.clock.now().getTime()).toBe(RECEIPT_LIFETIME_MS);
      const db = await row(r.receiptId);
      expect(db).toMatchObject({ status: 'issued', issuerUserId: o.id, sessionFamilyId: o.owner.sid, stepUpId: r.stepUpToken, consumeRef: null });
      expect(db.secretDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(db.bindingDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(await stepUpConsumed(r.stepUpToken)).toBe(true);
      const audit = (await t.db.query(`SELECT outcome, "actorId", metadata FROM auth_audit_event WHERE type='authorization_receipt.issued' AND "targetId"=$1`, [r.receiptId])).rows;
      expect(audit).toEqual([{ outcome: 'success', actorId: o.id, metadata: { companyId: o.companyId } }]);
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
      const r = await issue(o);
      t.clock.advance(RECEIPT_LIFETIME_MS);
      try {
        expect(await codeOf(svc.issue(o.owner, { stepUpToken: undefined, idempotencyKey: r.key, binding: r.binding }))).toBe('receipt_expired');
        expect(await codeOf(svc.issue(o.owner, { stepUpToken: undefined, idempotencyKey: r.key, binding: r.binding }))).toBe('receipt_expired');
        expect((await row(r.receiptId)).status).toBe('issued');
      } finally { t.clock.advance(-RECEIPT_LIFETIME_MS); }
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
      t.clock.advance(1000);
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

    it('expiry: at exactly 10 minutes the receipt is receipt_expired and stays issued; it was consumable just before', async () => {
      const o = await ready();
      const r = await issue(o);
      const r2 = await issue(o);
      t.clock.advance(RECEIPT_LIFETIME_MS - 1);
      await svc.consume(CALLER, { secret: r2.secret, binding: r2.binding, consumeRef: randomUUID() });
      t.clock.advance(1);
      try {
        expect(await codeOf(svc.consume(CALLER, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() }))).toBe('receipt_expired');
        expect((await row(r.receiptId)).status).toBe('issued');
      } finally { t.clock.advance(-RECEIPT_LIFETIME_MS); }
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
