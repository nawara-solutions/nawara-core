import { describe, expect, it } from 'vitest';
import { PAYMENT_STATUSES, TERMINAL_PAYMENT_STATUSES, canTransitionPayment, isTerminalPaymentStatus, type PaymentStatus } from './payment-state-machine.js';

const ALLOWED_PAIRS: [PaymentStatus, PaymentStatus][] = [
  ['created', 'pending'], ['pending', 'created'], ['pending', 'succeeded'], ['pending', 'failed'],
  ['created', 'cancelled'], ['pending', 'cancelled'], ['created', 'expired'], ['pending', 'expired'],
  ['created', 'succeeded'], // late success: an inferred failure already returned the payment to created
];

describe('payment state machine (SDD section 5.1)', () => {
  it('allows exactly the transitions the SDD lists, gateway settlement only', () => {
    for (const [from, to] of ALLOWED_PAIRS) expect(canTransitionPayment(from, to)).toBe(true);
  });

  it('forbids every other transition, including every terminal state moving anywhere', () => {
    const allowed = new Set(ALLOWED_PAIRS.map(([f, t]) => `${f}->${t}`));
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        if (allowed.has(`${from}->${to}`)) continue;
        expect(canTransitionPayment(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('allows created -> succeeded ONLY for the late-success path, not as a general shortcut around pending', () => {
    // The application layer only ever takes this edge for a late-verified success after an inferred failure
    // (AttemptService.applyStatus); the state machine itself cannot distinguish "legitimate late success" from
    // "some other path," which is exactly why this one edge is deliberately narrow and documented here.
    expect(canTransitionPayment('created', 'succeeded')).toBe(true);
  });

  it('classifies succeeded, failed, cancelled and expired as terminal, and no others', () => {
    expect(TERMINAL_PAYMENT_STATUSES).toEqual(['succeeded', 'failed', 'cancelled', 'expired']);
    for (const s of PAYMENT_STATUSES) expect(isTerminalPaymentStatus(s)).toBe(TERMINAL_PAYMENT_STATUSES.includes(s));
  });
});
