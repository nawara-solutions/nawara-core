import { describe, expect, it } from 'vitest';
import type { PaymentRefunds } from './payment-refund-client.js';
import { judgeExposureEvidence, judgeRefundEvidence } from './refund-evidence.js';

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
  it('DO-74: observationConflicts never change a verdict (present, empty, malformed or absent): S0-C14 and S0-C15A read exactly what they read before', () => {
    const answers = [read(), read({ attempts: [attempt(A, 'failed')] }), read({ attempts: [attempt(A, 'discrepancy')] }), read({ attempts: [attempt(X, 'failed')] }),
      read({ authorizations: [auth(A, { allocations: [{ factId: X, amount: 1, currency: 'TND' }] })] }), read({ unallocatedFacts: null })];
    for (const base of answers) {
      for (const o of [[{ refundAttemptId: A, conflictIds: [X], observations: 1 }], [], 'malformed' as const, null]) {
        expect(judgeRefundEvidence({ ...base, observationConflicts: o }, relays)).toEqual(judgeRefundEvidence(base, relays));
        expect(judgeExposureEvidence({ ...base, observationConflicts: o }, relays)).toEqual(judgeExposureEvidence(base, relays));
      }
    }
  });

  it('clean only when nothing is attempted, or every attempt of the movement is dead with no refund evidence', () => {
    expect(judgeRefundEvidence(read(), relays)).toEqual({ clean: true });
    for (const s of ['authorization_expired', 'authorization_refused'] as const) expect(judgeRefundEvidence(read({ attempts: [attempt(A, s)] }), relays), s).toEqual({ clean: true });
    // Core V2 R3: a FAILED attempt of the movement is dead only when Payment states `none` for its refund evidence after the failure
    expect(judgeRefundEvidence(read({ attempts: [attempt(A, 'failed')], failedAttemptEvidence: [{ refundAttemptId: A, state: 'none' }] }), relays)).toEqual({ clean: true });
  });

  it('Core V2 R3: a failed attempt of the movement waits on credible evidence after its failure, and on anything Payment cannot state (fail-closed)', () => {
    const failed = (fae: PaymentRefunds['failedAttemptEvidence'], more: Partial<PaymentRefunds> = {}) => judgeRefundEvidence(read({ attempts: [attempt(A, 'failed')], failedAttemptEvidence: fae, ...more }), relays);
    expect(failed([{ refundAttemptId: A, state: 'unmatched_fact' }])).toEqual({ clean: false, reason: 'refund_evidence_after_failure' });
    expect(failed([{ refundAttemptId: A, state: 'notification_pending' }])).toEqual({ clean: false, reason: 'refund_evidence_after_failure' });
    expect(failed([{ refundAttemptId: A, state: 'unknown' }])).toEqual({ clean: false, reason: 'failure_evidence_unknown' });
    for (const fae of [null, undefined, 'malformed' as const, [], [{ refundAttemptId: X, state: 'none' as const }]]) {
      expect(failed(fae), JSON.stringify(fae)).toEqual({ clean: false, reason: 'failure_evidence_unknown' }); // absent, malformed, or no statement for THIS attempt
    }
    // a risk is reported before an unknown, whatever the order
    const two = '44444444-4444-4444-8444-444444444444';
    const rel2 = new Map([[A, true], [two, true]]);
    expect(judgeRefundEvidence(read({ attempts: [attempt(A, 'failed'), attempt(two, 'failed')], failedAttemptEvidence: [{ refundAttemptId: A, state: 'unknown' }, { refundAttemptId: two, state: 'unmatched_fact' }] }), rel2))
      .toEqual({ clean: false, reason: 'refund_evidence_after_failure' });
    // a failed attempt of ANOTHER capture never holds; nothing failed on the movement needs no statement
    expect(judgeRefundEvidence(read({ attempts: [attempt(B, 'failed')], failedAttemptEvidence: [{ refundAttemptId: B, state: 'unmatched_fact' }] }), relays)).toEqual({ clean: true });
    expect(judgeRefundEvidence(read({ attempts: [attempt(A, 'authorization_expired')], failedAttemptEvidence: null }), relays)).toEqual({ clean: true });
    // S0-C14's earlier reasons keep their precedence
    expect(failed([{ refundAttemptId: A, state: 'unmatched_fact' }], { unallocatedFacts: null })).toEqual({ clean: false, reason: 'unallocated_facts_unknown' });
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

describe('Core V2 S0-C15A item 4: what an exposure case may claim about its refund evidence', () => {
  const money = [{ factId: X, amount: 60, currency: 'TND' }];
  it('money is claimed only from a verified allocation on a relay of the movement', () => {
    expect(judgeExposureEvidence(read({ authorizations: [auth(A, { allocations: money })] }), relays)).toBe('refund_money_verified');
  });
  it('another capture, an unknown attempt, no allocation, an unallocated fact or no answer prove no money', () => {
    expect(judgeExposureEvidence(read({ authorizations: [auth(B, { allocations: money })] }), relays)).toBe('refund_evidence_unresolved');
    expect(judgeExposureEvidence(read({ authorizations: [auth(X, { allocations: money })] }), relays)).toBe('refund_evidence_unresolved');
    expect(judgeExposureEvidence(read({ authorizations: [auth(A)] }), relays)).toBe('refund_evidence_unresolved');
    expect(judgeExposureEvidence(read({ unallocatedFacts: [{ factId: X, refundAttemptId: A, amount: 60, currency: 'TND', state: 'pending' } as never] }), relays)).toBe('refund_evidence_unresolved');
    expect(judgeExposureEvidence(null, relays)).toBe('refund_evidence_unresolved');
  });
});
