import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECEIPT_OPERATIONS, validateAuditPayload } from '@nawara/audit-contract';
import { AUTH_SERVICE_NAME } from '../src/audit/central-audit.js';
import { AuthorizationReceiptService } from '../src/receipts/authorization-receipt.service.js';
import { RECEIPT_AUDIENCES, RECEIPT_PURPOSES, RECEIPT_TARGET_FIELD, type ReceiptOperation } from '../src/receipts/receipt-binding.js';
import { ReceiptError } from '../src/receipts/receipt-errors.js';
import { claims, createTestApp, type TestCtx, type Tokens } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);
const codeOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof ReceiptError ? e.code : `unexpected: ${(e as Error)?.message}`; }
  return 'resolved';
};
type B = Record<string, unknown>;

/** One valid binding of each of the ten operations (the receipts contract §5, §17a to §17g). */
const BINDINGS: Record<ReceiptOperation, (companyId: string) => B> = {
  refund: (companyId) => ({ operation: 'refund', audience: 'payment-service', companyId, refundCaseId: randomUUID(), paymentId: randomUUID(), amount: 7_300, currency: 'TND', reason: 'duplicate_charge' }),
  dispute_decision: (companyId) => ({ operation: 'dispute_decision', audience: 'payment-service', companyId, disputeId: randomUUID(), paymentId: randomUUID(), decision: 'contest' }),
  fraud_hold_place: (companyId) => ({ operation: 'fraud_hold_place', audience: 'billing-service', companyId, holdId: randomUUID(), beneficiaryUserId: randomUUID(), productId: randomUUID(), reason: 'account_takeover' }),
  fraud_hold_release: (companyId) => ({ operation: 'fraud_hold_release', audience: 'billing-service', companyId, holdId: randomUUID(), beneficiaryUserId: randomUUID(), productId: randomUUID() }),
  recovery_surplus_external: (companyId) => ({ operation: 'recovery_surplus_external', audience: 'billing-service', companyId, surplusId: randomUUID(), organizationId: randomUUID(), amount: 1_200, currency: 'TND' }),
  late_settlement_apply: (companyId) => ({ operation: 'late_settlement_apply', audience: 'billing-service', companyId, lateSettlementId: randomUUID(), assistanceRequestId: randomUUID(), beneficiaryUserId: randomUUID(), reasonCode: 'cash_not_returned_attested' }),
  provider_fact_associate: (companyId) => ({ operation: 'provider_fact_associate', audience: 'payment-service', companyId, factId: randomUUID(), kind: 'capture', amount: 9_000, currency: 'TND', targetType: 'payment', targetId: randomUUID() }),
  recovery_write_off: (companyId) => ({ operation: 'recovery_write_off', audience: 'billing-service', companyId, obligationId: randomUUID(), organizationId: randomUUID(), amount: 6_100, currency: 'TND' }),
  recovery_restriction_suspend: (companyId) => ({ operation: 'recovery_restriction_suspend', audience: 'billing-service', companyId, suspensionId: randomUUID(), obligationId: randomUUID(), organizationId: randomUUID(), disputeId: randomUUID(), refundCaseId: randomUUID(), reasonCode: 'refund_chargeback_overlap' }),
  recovery_restriction_revoke: (companyId) => ({ operation: 'recovery_restriction_revoke', audience: 'billing-service', companyId, suspensionId: randomUUID(), obligationId: randomUUID(), organizationId: randomUUID(), disputeId: randomUUID(), refundCaseId: randomUUID(), reasonCode: 'owner_reinstated_restriction' }),
};
const OPS = Object.keys(BINDINGS) as ReceiptOperation[];
/** The binding identifier each operation's attribution names, written out here (not read from the code under test). */
const EXPECTED_TARGET: Record<ReceiptOperation, [string, string]> = {
  refund: ['refund_case', 'refundCaseId'], dispute_decision: ['payment_dispute', 'disputeId'], fraud_hold_place: ['fraud_hold', 'holdId'],
  fraud_hold_release: ['fraud_hold', 'holdId'], recovery_surplus_external: ['recovery_surplus', 'surplusId'],
  late_settlement_apply: ['assistance_late_settlement', 'lateSettlementId'], provider_fact_associate: ['provider_transaction_fact', 'factId'],
  recovery_write_off: ['recovery_obligation', 'obligationId'], recovery_restriction_suspend: ['recovery_restriction_suspension', 'suspensionId'],
  recovery_restriction_revoke: ['recovery_restriction_suspension', 'suspensionId'],
};

/**
 * Core V2 F-22 / G6-B (DO-62; ADR-0070; the Owner's D-F22-2 to D-F22-6, 2026-11-22): Auth's central receipt events carry the complete
 * attribution tuple, taken from the binding Auth itself parsed and verified, for every one of the ten operations, at issue, consume and
 * void; nothing of the receipt lifecycle changes. Real PostgreSQL, the internal service, the outbox rows the relay publishes.
 */
describe('authorization receipts: central audit attribution (F-22)', () => {
  let t: TestCtx;
  let svc: AuthorizationReceiptService;
  beforeAll(async () => {
    t = await createTestApp({ AUTHORIZATION_RECEIPT_PEPPER: randomBytes(32).toString('base64'), BASELINE_RATE_LIMIT_PER_MINUTE: '100000' });
    svc = t.app.get(AuthorizationReceiptService);
  });
  afterAll(() => t.close());

  const ready = async () => {
    const companyId = await t.newCompany();
    const o = await t.readyOwner(companyId, `attr${uniq()}@a.test`);
    return { ...o, companyId, owner: { userId: o.id, sid: (claims(o.tokens) as { sid: string }).sid } };
  };
  type Ready = Awaited<ReturnType<typeof ready>>;
  const issue = async (o: Ready, op: ReceiptOperation, b: B = BINDINGS[op](o.companyId), key = `ak-${uniq()}${uniq()}`) => {
    const stepUpToken = await t.stepUpToken(o.tokens as Tokens, RECEIPT_PURPOSES[op], o.totpSecret);
    const r = await svc.issue(o.owner, { idempotencyKey: key, binding: b, stepUpToken });
    return { ...r, binding: b, key, stepUpToken };
  };
  const central = async (receiptId: string) =>
    (await t.db.query(`SELECT name, payload FROM outbox WHERE name LIKE 'audit.authorization_receipt.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", id`, [receiptId])).rows as Array<{ name: string; payload: Record<string, any> }>;
  const tuple = (op: ReceiptOperation, b: B) => ({ operation: op, target_type: EXPECTED_TARGET[op][0], target_id: b[EXPECTED_TARGET[op][1]] });

  it('Auth\'s audiences and target fields equal the audit contract\'s operation table (no operation, audience or target of its own)', () => {
    expect(Object.keys(RECEIPT_OPERATIONS).sort()).toEqual([...OPS].sort());
    for (const op of OPS) {
      expect(RECEIPT_AUDIENCES[op], op).toBe(RECEIPT_OPERATIONS[op].audience);
      expect([RECEIPT_OPERATIONS[op].targetType, RECEIPT_TARGET_FIELD[op]], op).toEqual(EXPECTED_TARGET[op]);
    }
  });

  it('every operation: .issued, .consumed (by its audience, with consume_ref) and .voided carry exactly the binding\'s tuple; each validates', async () => {
    const o = await ready();
    for (const op of OPS) {
      const r = await issue(o, op);
      const ref = randomUUID();
      const audience = RECEIPT_AUDIENCES[op];
      const c = await svc.consume(audience, { secret: r.secret, binding: r.binding, consumeRef: ref });
      // NC-14: the consumption's answer and the receipt row are exactly what they were before attribution existed
      expect(c).toEqual({ receiptId: r.receiptId, consumeRef: ref, consumedAt: expect.any(Date), approvedBy: { userId: o.id }, companyId: o.companyId });
      expect((await t.db.query(`SELECT status, "consumeRef"::text AS ref, "consumedBy" FROM authorization_receipt WHERE id=$1`, [r.receiptId])).rows[0]).toEqual({ status: 'consumed', ref, consumedBy: audience });
      const [issued, consumed, ...more] = await central(r.receiptId);
      expect(more, op).toEqual([]);
      expect(issued!.payload.changes, op).toEqual(tuple(op, r.binding));
      expect(consumed!.payload, op).toMatchObject({ actor: { type: 'service', id: audience }, approvedBy: { type: 'user', id: o.id, userKind: 'owner' }, companyId: o.companyId });
      expect(consumed!.payload.changes, op).toEqual({ ...tuple(op, r.binding), consume_ref: ref });
      for (const row of [issued!, consumed!]) expect(validateAuditPayload(row.payload, AUTH_SERVICE_NAME, 2).changes, op).toEqual(row.payload.changes);

      // the automatic void of a replayed issue request: the receipt's own binding (same request hash), its tuple, no consume_ref
      const v = await issue(o, op);
      expect(await codeOf(svc.issue(o.owner, { idempotencyKey: v.key, binding: v.binding, stepUpToken: v.stepUpToken }))).toBe('receipt_issued_response_lost');
      const [, voided, ...none] = await central(v.receiptId);
      expect(none, op).toEqual([]);
      expect(voided!.payload, op).toMatchObject({ action: 'authorization_receipt.voided', actor: { type: 'system', id: 'authorization_receipt_replay' } });
      expect(voided!.payload.changes, op).toEqual(tuple(op, v.binding));
      validateAuditPayload(voided!.payload, AUTH_SERVICE_NAME, 2);
    }
  });

  it('NC-12: the refund consumption\'s consume_ref is the refund attempt id Payment sends (consumeRef = refund_attempt.id); target_id is the case', async () => {
    const o = await ready();
    const r = await issue(o, 'refund');
    const refundAttemptId = randomUUID(); // Payment's refund attempt id IS its consumeRef (payment-service refund-attempt.service.ts)
    await svc.consume('payment-service', { secret: r.secret, binding: r.binding, consumeRef: refundAttemptId });
    const consumed = (await central(r.receiptId))[1]!.payload;
    expect([consumed.changes.consume_ref, consumed.changes.target_id, consumed.changes.target_type]).toEqual([refundAttemptId, r.binding.refundCaseId, 'refund_case']);
    expect(JSON.stringify(consumed)).not.toContain(r.binding.paymentId as string); // the payment stays Payment's own fact
  });

  it('NC-4 / NC-5 / NC-9: a wrong consumer, a forged audience or a mismatched binding is refused and writes no central consumption', async () => {
    const o = await ready();
    for (const op of OPS) {
      const r = await issue(o, op);
      const other = RECEIPT_AUDIENCES[op] === 'payment-service' ? 'billing-service' : 'payment-service';
      // the authenticated caller is not the binding's audience (F-7), also when the binding claims the caller's audience
      expect(await codeOf(svc.consume(other, { secret: r.secret, binding: r.binding, consumeRef: randomUUID() })), op).toBe('receipt_binding_invalid');
      expect(await codeOf(svc.consume(other, { secret: r.secret, binding: { ...r.binding, audience: other }, consumeRef: randomUUID() })), op).toBe('receipt_binding_invalid');
      // the same operation for another target: a different binding digest, never this receipt
      const field = EXPECTED_TARGET[op][1];
      expect(await codeOf(svc.consume(RECEIPT_AUDIENCES[op], { secret: r.secret, binding: { ...r.binding, [field]: randomUUID() }, consumeRef: randomUUID() })), op).toBe('receipt_invalid');
      expect((await central(r.receiptId)).map((x) => x.name), op).toEqual(['audit.authorization_receipt.issued']);
      expect((await t.db.query(`SELECT status FROM authorization_receipt WHERE id=$1`, [r.receiptId])).rows[0].status, op).toBe('issued');
    }
  });

  it('a replay with another binding under the same key voids nothing and writes nothing (the request hash differs)', async () => {
    const o = await ready();
    const r = await issue(o, 'fraud_hold_place');
    const otherTarget = { ...r.binding, holdId: randomUUID() };
    expect(await codeOf(svc.issue(o.owner, { idempotencyKey: r.key, binding: otherTarget, stepUpToken: r.stepUpToken }))).toBe('idempotency_key_reused');
    expect((await central(r.receiptId)).map((x) => x.name)).toEqual(['audit.authorization_receipt.issued']);
    expect((await t.db.query(`SELECT status FROM authorization_receipt WHERE id=$1`, [r.receiptId])).rows[0].status).toBe('issued');
  });

  it('NC-11: every central receipt intent Auth wrote in this suite carries the complete, valid tuple; no amount, beneficiary or Organization', async () => {
    const rows = (await t.db.query(`SELECT name, payload FROM outbox WHERE name LIKE 'audit.authorization_receipt.%'`)).rows as Array<{ name: string; payload: Record<string, any> }>;
    expect(rows.length).toBeGreaterThan(30);
    for (const { name, payload } of rows) {
      const keys = name === 'audit.authorization_receipt.consumed' ? ['consume_ref', 'operation', 'target_id', 'target_type'] : ['operation', 'target_id', 'target_type'];
      expect(Object.keys(payload.changes ?? {}).sort(), name).toEqual(keys);
      expect(payload.organizationId, name).toBeNull();
      validateAuditPayload(payload, AUTH_SERVICE_NAME, 2);
    }
  });
});
