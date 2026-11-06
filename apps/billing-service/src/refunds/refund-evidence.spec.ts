import { describe, expect, it } from 'vitest';
import type { PaymentRefunds } from './payment-refund-client.js';
import { judgeRefundEvidence } from './refund-evidence.js';

const A = '11111111-1111-4111-8111-111111111111'; // a relay of the loss's captured movement
const B = '22222222-2222-4222-8222-222222222222'; // a relay of ANOTHER capture of the same payment
const X = '33333333-3333-4333-8333-333333333333'; // an attempt Billing never relayed
const relays = new Map([[A, true], [B, false]]);
const read = (o: Partial<PaymentRefunds> = {}): PaymentRefunds => ({ attempts: [], refusals: [], authorizations: [], unallocatedFacts: [], ...o });
const attempt = (id: string, status: PaymentRefunds['attempts'][number]['status']) => ({ refundAttemptId: id, status, approvedBy: null });
const auth = (attemptId: string, o: { allocations?: { factId: string; amount: number; currency: string }[]; completedAt?: string | null } = {}) => ({
  refundAuthorizationId: X, refundAttemptId: attemptId, refundCaseId: X, approvedAmount: 100, currency: 'TND', completedAt: o.completedAt ?? null, allocations: o.allocations ?? [] });

/** Core V2 S0-C14 item 6 (a): the remote half of a waiting effect's resumption, judged from one fresh PAY-08 answer. */
describe('judgeRefundEvidence (Core V2 S0-C14 item 6)', () => {
  it('clean only when nothing is attempted, or every attempt of the movement is dead with no refund evidence', () => {
    expect(judgeRefundEvidence(read(), relays)).toEqual({ clean: true });
    for (const s of ['authorization_expired', 'authorization_refused', 'failed'] as const) expect(judgeRefundEvidence(read({ attempts: [attempt(A, s)] }), relays), s).toEqual({ clean: true });
  });

  it('every live status of the movement waits (V25)', () => {
    for (const s of ['authorization_pending', 'authorized', 'dispatching', 'submitted', 'unknown', 'succeeded', 'discrepancy'] as const) {
      expect(judgeRefundEvidence(read({ attempts: [attempt(A, s)] }), relays), s).toEqual({ clean: false, reason: 'attempt_live' });
    }
  });

  it('refund evidence of the movement waits: an allocation, a completed authorization, an unallocated fact (pending or blocked)', () => {
    expect(judgeRefundEvidence(read({ attempts: [attempt(A, 'failed')], authorizations: [auth(A, { allocations: [{ factId: X, amount: 1, currency: 'TND' }] })] }), relays))
      .toEqual({ clean: false, reason: 'refund_evidence' });
    expect(judgeRefundEvidence(read({ authorizations: [auth(A, { completedAt: '2026-11-06T10:00:00.000Z' })] }), relays)).toEqual({ clean: false, reason: 'refund_evidence' });
    for (const state of ['pending', 'blocked'] as const) {
      expect(judgeRefundEvidence(read({ unallocatedFacts: [{ factId: X, refundAttemptId: A, amount: 1, currency: 'TND', state }] }), relays), state)
        .toEqual({ clean: false, reason: 'refund_evidence' });
    }
  });

  it('anything Billing does not know waits (V17, V31): an attempt, an authorization or a fact of an attempt Billing never relayed, or a fact naming no attempt', () => {
    expect(judgeRefundEvidence(read({ attempts: [attempt(X, 'failed')] }), relays)).toEqual({ clean: false, reason: 'attempt_unknown_to_billing' });
    expect(judgeRefundEvidence(read({ authorizations: [auth(X)] }), relays)).toEqual({ clean: false, reason: 'attempt_unknown_to_billing' });
    expect(judgeRefundEvidence(read({ unallocatedFacts: [{ factId: X, refundAttemptId: null, amount: 1, currency: 'TND', state: 'pending' }] }), relays))
      .toEqual({ clean: false, reason: 'attempt_unknown_to_billing' });
  });

  it('a refund of ANOTHER capture of the payment, known to Billing, never blocks this loss\'s effect', () => {
    expect(judgeRefundEvidence(read({ attempts: [attempt(B, 'succeeded')], authorizations: [auth(B, { completedAt: '2026-11-06T10:00:00.000Z',
      allocations: [{ factId: X, amount: 1, currency: 'TND' }] })], unallocatedFacts: [{ factId: X, refundAttemptId: B, amount: 1, currency: 'TND', state: 'pending' }] }), relays))
      .toEqual({ clean: true });
  });

  it('fail closed (V29): Payment\'s 404 and an answer without the producer\'s unallocated facts prove nothing', () => {
    expect(judgeRefundEvidence(null, relays)).toEqual({ clean: false, reason: 'payment_not_found' });
    expect(judgeRefundEvidence(read({ unallocatedFacts: null }), relays)).toEqual({ clean: false, reason: 'unallocated_facts_unknown' });
  });
});
