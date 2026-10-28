import { describe, expect, it } from 'vitest';
import { REFUND_REASONS, normaliseEmptyInput, normaliseRefundCaseInput } from './refund-input.js';

const PAYMENT = '0a0a0a0a-0000-4000-8000-000000000001';

describe('Core V2 S6a refund-case input (BIL-23; R6A-1, R6A-4, R6A-5)', () => {
  it('exactly {paymentId, reason, legalOverride?}; legalOverride defaults to false; the payment id is lower-cased', () => {
    expect(normaliseRefundCaseInput({ paymentId: PAYMENT.toUpperCase(), reason: 'duplicate_charge' })).toEqual({ paymentId: PAYMENT, reason: 'duplicate_charge', legalOverride: false });
    expect(normaliseRefundCaseInput({ paymentId: PAYMENT, reason: 'legal_requirement', legalOverride: true }).legalOverride).toBe(true);
  });

  it('the five approved reasons only, no free text', () => {
    expect([...REFUND_REASONS]).toEqual(['duplicate_charge', 'service_not_provided', 'customer_request', 'late_settlement_unapplied', 'legal_requirement']);
    for (const reason of ['other', 'Duplicate_charge', 'the customer asked', '', 1]) {
      expect(() => normaliseRefundCaseInput({ paymentId: PAYMENT, reason }), String(reason)).toThrow();
    }
  });

  it('no amount, currency or any other caller value (no partial refund, D4); legalOverride must be a boolean', () => {
    for (const extra of [{ amount: 100 }, { currency: 'TND' }, { companyId: PAYMENT }, { status: 'completed' }, { legalOverride: 'true' }, { legalOverride: 1 }]) {
      expect(() => normaliseRefundCaseInput({ paymentId: PAYMENT, reason: 'customer_request', ...extra }), JSON.stringify(extra)).toThrow();
    }
    expect(() => normaliseRefundCaseInput({ paymentId: 'not-a-uuid', reason: 'customer_request' })).toThrow();
    expect(() => normaliseRefundCaseInput([])).toThrow();
  });

  it('a cancellation carries no body', () => {
    expect(() => normaliseEmptyInput(undefined)).not.toThrow();
    expect(() => normaliseEmptyInput({})).not.toThrow();
    expect(() => normaliseEmptyInput({ reason: 'x' })).toThrow();
    expect(() => normaliseEmptyInput('x')).toThrow();
  });
});
