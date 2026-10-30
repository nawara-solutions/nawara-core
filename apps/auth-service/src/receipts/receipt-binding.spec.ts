import { randomBytes } from 'node:crypto';
import {
  RECEIPT_AUDIENCES, RECEIPT_DOMAINS, RECEIPT_PURPOSES, bindingDigest, canonicalBinding, parseBinding, requestHash, secretDigest, type RefundBinding,
} from './receipt-binding.js';
import { ReceiptError } from './receipt-errors.js';

/** S2-Auth.1 (ADR-0067; D-A2 receipt contract §5.1, §6): the binding's strict parse, its canonical form and the digests' domains. */
const valid = () => ({
  operation: 'refund', audience: 'payment-service', companyId: '11111111-1111-4111-8111-111111111111',
  refundCaseId: '22222222-2222-4222-8222-222222222222', paymentId: '33333333-3333-4333-8333-333333333333',
  amount: 4900, currency: 'TND', reason: 'duplicate_charge', legalOverride: false,
});
const code = (f: () => unknown) => {
  try { f(); } catch (e) { return e instanceof ReceiptError ? e.code : `not a ReceiptError: ${String(e)}`; }
  return 'no error';
};

describe('authorization receipt binding (S2-Auth.1)', () => {
  it('parses exactly the frozen F-2 fields; legalOverride is false unless given (Q1)', () => {
    expect(parseBinding(valid())).toEqual(valid());
    const { legalOverride: _omit, ...rest } = valid();
    expect((parseBinding(rest) as RefundBinding).legalOverride).toBe(false);
    expect((parseBinding({ ...valid(), legalOverride: true }) as RefundBinding).legalOverride).toBe(true);
  });

  it('refuses anything unknown, missing or mistyped with receipt_binding_invalid', () => {
    const bad: Array<[string, unknown]> = [
      ['not an object', 'x'], ['null', null], ['an array', [valid()]], ['a class instance', new (class { a = 1; })()],
      ['an unknown field', { ...valid(), extra: 1 }], ['a missing field', (({ reason: _r, ...o }) => o)(valid())],
      ['another operation', { ...valid(), operation: 'charge' }], ['another audience', { ...valid(), audience: 'billing-service' }],
      ['an upper-case uuid', { ...valid(), paymentId: '33333333-3333-4333-8333-33333333333A' }], ['a non-uuid', { ...valid(), companyId: 'c1' }],
      ['amount 0', { ...valid(), amount: 0 }], ['a negative amount', { ...valid(), amount: -1 }], ['a fractional amount', { ...valid(), amount: 1.5 }],
      ['an unsafe amount', { ...valid(), amount: 2 ** 53 }], ['a string amount', { ...valid(), amount: '4900' }],
      ['a lower-case currency', { ...valid(), currency: 'tnd' }], ['a 4-letter currency', { ...valid(), currency: 'TNDX' }],
      ['free-text reason (Q2)', { ...valid(), reason: 'The customer asked nicely' }], ['an upper-case reason', { ...valid(), reason: 'Duplicate' }],
      ['an over-long reason', { ...valid(), reason: `r${'x'.repeat(64)}` }], ['a string legalOverride', { ...valid(), legalOverride: 'true' }],
      ['a null legalOverride', { ...valid(), legalOverride: null }],
    ];
    for (const [what, b] of bad) expect(code(() => parseBinding(b)), what).toBe('receipt_binding_invalid');
  });

  it('the canonical form is independent of key order and never includes anything but the F-2 fields', () => {
    const a = valid();
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    expect(canonicalBinding(parseBinding(reordered))).toBe(canonicalBinding(parseBinding(a)));
    expect(canonicalBinding(parseBinding(a))).toBe(
      '{"amount":4900,"audience":"payment-service","companyId":"11111111-1111-4111-8111-111111111111","currency":"TND","legalOverride":false,'
      + '"operation":"refund","paymentId":"33333333-3333-4333-8333-333333333333","reason":"duplicate_charge",'
      + '"refundCaseId":"22222222-2222-4222-8222-222222222222"}',
    );
    expect(canonicalBinding(parseBinding({ ...a, legalOverride: true }))).not.toBe(canonicalBinding(parseBinding(a)));
  });

  it('digests are domain-separated, peppered and versioned: the same input never yields the same digest in two roles', () => {
    const pepper = randomBytes(32);
    const c = canonicalBinding(parseBinding(valid()));
    const d = [bindingDigest(pepper, c), requestHash(pepper, c), secretDigest(pepper, c)];
    for (const x of d) expect(x).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(d).size).toBe(3);
    expect(bindingDigest(randomBytes(32), c)).not.toBe(d[0]);
    expect(Object.values(RECEIPT_DOMAINS).every((v) => v.endsWith('.v1'))).toBe(true);
  });

  describe('dispute decision (S6e Auth prerequisite, R6E-3)', () => {
    const dispute = () => ({
      operation: 'dispute_decision', audience: 'payment-service', companyId: '11111111-1111-4111-8111-111111111111',
      disputeId: '44444444-4444-4444-8444-444444444444', paymentId: '33333333-3333-4333-8333-333333333333', decision: 'contest',
    });

    it('parses exactly its own fields, for contest and accept', () => {
      expect(parseBinding(dispute())).toEqual(dispute());
      expect(parseBinding({ ...dispute(), decision: 'accept' })).toEqual({ ...dispute(), decision: 'accept' });
    });

    it('refuses anything unknown, missing or mistyped, and never mixes the two field sets', () => {
      const bad: Array<[string, unknown]> = [
        ['an unknown field', { ...dispute(), extra: 1 }], ['a missing decision', (({ decision: _d, ...o }) => o)(dispute())],
        ['a missing dispute', (({ disputeId: _d, ...o }) => o)(dispute())], ['another decision', { ...dispute(), decision: 'withdraw' }],
        ['an upper-case decision', { ...dispute(), decision: 'Contest' }], ['another audience', { ...dispute(), audience: 'billing-service' }],
        ['a non-uuid dispute', { ...dispute(), disputeId: 'd1' }], ['an upper-case uuid', { ...dispute(), paymentId: '33333333-3333-4333-8333-33333333333A' }],
        ['a refund field', { ...dispute(), amount: 4900 }], ['a legal override', { ...dispute(), legalOverride: false }],
        ['a refund with a dispute field', { ...valid(), disputeId: dispute().disputeId }],
        ['a refund with a decision', { ...valid(), decision: 'accept' }],
      ];
      for (const [what, b] of bad) expect(code(() => parseBinding(b)), what).toBe('receipt_binding_invalid');
    });

    it('the canonical form (and so every digest) separates operations, disputes, payments, Companies and decisions', () => {
      const c = (o: Record<string, unknown> = {}) => canonicalBinding(parseBinding({ ...dispute(), ...o }));
      expect(c()).toBe(
        '{"audience":"payment-service","companyId":"11111111-1111-4111-8111-111111111111","decision":"contest",'
        + '"disputeId":"44444444-4444-4444-8444-444444444444","operation":"dispute_decision","paymentId":"33333333-3333-4333-8333-333333333333"}',
      );
      const all = [c(), c({ decision: 'accept' }), c({ disputeId: '55555555-5555-4555-8555-555555555555' }),
        c({ paymentId: '66666666-6666-4666-8666-666666666666' }), c({ companyId: '77777777-7777-4777-8777-777777777777' }),
        canonicalBinding(parseBinding(valid()))];
      expect(new Set(all).size).toBe(all.length);
    });

    it('each operation consumes its own step-up purpose, never the other one', () => {
      expect(RECEIPT_PURPOSES).toEqual({ refund: 'refund.authorize', dispute_decision: 'payment.dispute.decide', fraud_hold_place: 'billing.fraud_hold.place', fraud_hold_release: 'billing.fraud_hold.release', recovery_surplus_external: 'billing.recovery_surplus.record_external', late_settlement_apply: 'billing.late_settlement.apply', provider_fact_associate: 'payment.provider_fact.associate', recovery_write_off: 'billing.recovery.write_off' });
    });
  });

  describe('fraud holds (S6e-H Auth prerequisite, H-2)', () => {
    const place = () => ({
      operation: 'fraud_hold_place', audience: 'billing-service', companyId: '11111111-1111-4111-8111-111111111111', holdId: '66666666-6666-4666-8666-666666666666',
      beneficiaryUserId: '77777777-7777-4777-8777-777777777777', productId: '88888888-8888-4888-8888-888888888888', reason: 'account_takeover',
    });
    const release = () => (({ reason: _r, ...o }) => ({ ...o, operation: 'fraud_hold_release' }))(place());

    it('parses exactly their own fields, for billing-service only', () => {
      expect(parseBinding(place())).toEqual(place());
      expect(parseBinding(release())).toEqual(release());
      expect(RECEIPT_AUDIENCES).toEqual({ refund: 'payment-service', dispute_decision: 'payment-service', fraud_hold_place: 'billing-service', fraud_hold_release: 'billing-service', recovery_surplus_external: 'billing-service', late_settlement_apply: 'billing-service', provider_fact_associate: 'payment-service', recovery_write_off: 'billing-service' });
    });

    it('refuses anything unknown, missing, mistyped or for another audience', () => {
      const bad: Array<[string, unknown]> = [
        ['payment-service audience', { ...place(), audience: 'payment-service' }], ['a release with a reason', { ...release(), reason: 'x' }],
        ['a placement without reason', (({ reason: _r, ...o }) => o)(place())], ['a free-text reason', { ...place(), reason: 'He stole it' }],
        ['a missing hold', (({ holdId: _h, ...o }) => o)(place())], ['a non-uuid product', { ...place(), productId: 'p1' }],
        ['an extra field', { ...place(), evidence: 'x' }], ['a refund binding for billing', { ...valid(), audience: 'billing-service' }],
        ['a dispute binding for billing', { operation: 'dispute_decision', audience: 'billing-service', companyId: place().companyId, disputeId: place().holdId, paymentId: place().productId, decision: 'accept' }],
      ];
      for (const [what, b] of bad) expect(code(() => parseBinding(b)), what).toBe('receipt_binding_invalid');
    });

    it('the canonical form separates placement and release, holds, beneficiaries, products, Companies and reasons', () => {
      const c = (b: Record<string, unknown>) => canonicalBinding(parseBinding(b));
      const all = [c(place()), c(release()), c({ ...place(), holdId: '99999999-9999-4999-8999-999999999999' }), c({ ...place(), beneficiaryUserId: '99999999-9999-4999-8999-999999999999' }),
        c({ ...place(), productId: '99999999-9999-4999-8999-999999999999' }), c({ ...place(), companyId: '99999999-9999-4999-8999-999999999999' }), c({ ...place(), reason: 'chargeback_abuse' })];
      expect(new Set(all).size).toBe(all.length);
    });
  });

  describe('external recovery-surplus repayment (S6f Auth prerequisite, R6F-5)', () => {
    const ext = () => ({
      operation: 'recovery_surplus_external', audience: 'billing-service', companyId: '11111111-1111-4111-8111-111111111111',
      surplusId: '22222222-2222-4222-8222-222222222222', organizationId: '33333333-3333-4333-8333-333333333333', amount: 1200, currency: 'TND',
    });
    it('parses exactly its fields, billing-service only', () => {
      expect(parseBinding(ext())).toEqual(ext());
    });
    it('refuses anything unknown, missing, mistyped or for another audience', () => {
      const bad: Array<[string, unknown]> = [
        ['payment audience', { ...ext(), audience: 'payment-service' }], ['a zero amount', { ...ext(), amount: 0 }], ['a fractional amount', { ...ext(), amount: 1.5 }],
        ['a string amount', { ...ext(), amount: '1200' }], ['a lower-case currency', { ...ext(), currency: 'tnd' }], ['an extra field', { ...ext(), evidence: 'x' }],
        ['a missing Organization', (({ organizationId: _o, ...o }) => o)(ext())], ['a non-uuid surplus', { ...ext(), surplusId: 's' }],
      ];
      for (const [what, b] of bad) expect(code(() => parseBinding(b)), what).toBe('receipt_binding_invalid');
    });
    it('the canonical form separates surpluses, Organizations, amounts, currencies and Companies', () => {
      const c = (o: Record<string, unknown> = {}) => canonicalBinding(parseBinding({ ...ext(), ...o }));
      const all = [c(), c({ surplusId: '44444444-4444-4444-8444-444444444444' }), c({ organizationId: '44444444-4444-4444-8444-444444444444' }), c({ amount: 1201 }),
        c({ currency: 'EUR' }), c({ companyId: '44444444-4444-4444-8444-444444444444' })];
      expect(new Set(all).size).toBe(all.length);
    });
  });

  describe('late-settlement application (S6g Auth prerequisite, R6G-1, R6G-3)', () => {
    const late = () => ({
      operation: 'late_settlement_apply', audience: 'billing-service', companyId: '11111111-1111-4111-8111-111111111111',
      lateSettlementId: '22222222-2222-4222-8222-222222222222', assistanceRequestId: '33333333-3333-4333-8333-333333333333',
      beneficiaryUserId: '55555555-5555-4555-8555-555555555555', reasonCode: 'cash_not_returned_attested',
    });
    it('parses exactly its fields with either closed reason code, billing-service only', () => {
      expect(parseBinding(late())).toEqual(late());
      expect(parseBinding({ ...late(), reasonCode: 'cash_not_returned_evidenced' })).toEqual({ ...late(), reasonCode: 'cash_not_returned_evidenced' });
    });
    it('refuses anything unknown, missing, mistyped, an open reason or another audience', () => {
      const bad: Array<[string, unknown]> = [
        ['payment audience', { ...late(), audience: 'payment-service' }], ['a free-text reason', { ...late(), reasonCode: 'owner_override' }],
        ['a legal override', { ...late(), legalOverride: true }], ['an extra field', { ...late(), evidenceFileIds: [] }],
        ['a missing beneficiary', (({ beneficiaryUserId: _b, ...o }) => o)(late())], ['a non-uuid late settlement', { ...late(), lateSettlementId: 'x' }],
        ['an upper-case uuid', { ...late(), assistanceRequestId: '33333333-3333-4333-8333-33333333333A' }],
      ];
      for (const [what, b] of bad) expect(code(() => parseBinding(b)), what).toBe('receipt_binding_invalid');
    });
    it('the canonical form separates late settlements, requests, beneficiaries, reasons and Companies', () => {
      const c = (o: Record<string, unknown> = {}) => canonicalBinding(parseBinding({ ...late(), ...o }));
      const other = '44444444-4444-4444-8444-444444444444';
      const all = [c(), c({ lateSettlementId: other }), c({ assistanceRequestId: other }), c({ beneficiaryUserId: other }), c({ reasonCode: 'cash_not_returned_evidenced' }), c({ companyId: other })];
      expect(new Set(all).size).toBe(all.length);
    });
  });

  describe('provider-fact association and recovery write-off (S6h Auth prerequisite, R6H-3, R6H-8)', () => {
    const other = '44444444-4444-4444-8444-444444444444';
    const assoc = () => ({
      operation: 'provider_fact_associate', audience: 'payment-service', companyId: '11111111-1111-4111-8111-111111111111', factId: '22222222-2222-4222-8222-222222222222',
      kind: 'capture', amount: 9000, currency: 'TND', targetType: 'payment', targetId: '33333333-3333-4333-8333-333333333333',
    });
    const writeOff = () => ({
      operation: 'recovery_write_off', audience: 'billing-service', companyId: '11111111-1111-4111-8111-111111111111', obligationId: '22222222-2222-4222-8222-222222222222',
      organizationId: '33333333-3333-4333-8333-333333333333', amount: 6100, currency: 'TND',
    });
    it('each parses exactly its fields, for its one audience', () => {
      expect(parseBinding(assoc())).toEqual(assoc());
      expect(parseBinding({ ...assoc(), kind: 'refund', targetType: 'refund_authorization' })).toEqual({ ...assoc(), kind: 'refund', targetType: 'refund_authorization' });
      expect(parseBinding(writeOff())).toEqual(writeOff());
    });
    it('refuses anything unknown, missing, mistyped or for another audience', () => {
      const bad: Array<[string, unknown]> = [
        ['association for billing', { ...assoc(), audience: 'billing-service' }], ['an unknown kind', { ...assoc(), kind: 'fee' }], ['an unknown target', { ...assoc(), targetType: 'invoice' }],
        ['a zero amount', { ...assoc(), amount: 0 }], ['a lower-case currency', { ...assoc(), currency: 'tnd' }], ['a missing target', (({ targetId: _t, ...o }) => o)(assoc())],
        ['an extra field', { ...assoc(), providerTxnId: 'x' }], ['write-off for payment', { ...writeOff(), audience: 'payment-service' }],
        ['a fractional write-off', { ...writeOff(), amount: 1.5 }], ['a forgiveness flag', { ...writeOff(), forgive: true }], ['a non-uuid obligation', { ...writeOff(), obligationId: 'o' }],
      ];
      for (const [what, b] of bad) expect(code(() => parseBinding(b)), what).toBe('receipt_binding_invalid');
    });
    it('the canonical forms separate every field', () => {
      const a = (o: Record<string, unknown> = {}) => canonicalBinding(parseBinding({ ...assoc(), ...o }));
      const w = (o: Record<string, unknown> = {}) => canonicalBinding(parseBinding({ ...writeOff(), ...o }));
      const all = [a(), a({ factId: other }), a({ kind: 'refund' }), a({ amount: 9001 }), a({ currency: 'EUR' }), a({ targetType: 'refund_authorization' }), a({ targetId: other }), a({ companyId: other }),
        w(), w({ obligationId: other }), w({ organizationId: other }), w({ amount: 6101 }), w({ currency: 'EUR' }), w({ companyId: other })];
      expect(new Set(all).size).toBe(all.length);
    });
  });
});
