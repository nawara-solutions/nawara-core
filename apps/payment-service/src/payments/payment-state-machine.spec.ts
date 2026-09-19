import { describe, expect, it } from 'vitest';
import { PAYMENT_STATUSES, TERMINAL_PAYMENT_STATUSES, canTransitionPayment, isTerminalPaymentStatus, type PaymentStatus } from './payment-state-machine.js';

const ALLOWED_PAIRS: [PaymentStatus, PaymentStatus][] = [
  ['created', 'pending'], ['pending', 'created'], ['pending', 'succeeded'], ['pending', 'failed'],
  ['created', 'cancelled'], ['pending', 'cancelled'], ['created', 'expired'], ['pending', 'expired'],
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

  it('forbids created -> succeeded directly (success is only reached from pending)', () => {
    expect(canTransitionPayment('created', 'succeeded')).toBe(false);
  });

  it('classifies succeeded, failed, cancelled and expired as terminal, and no others', () => {
    expect(TERMINAL_PAYMENT_STATUSES).toEqual(['succeeded', 'failed', 'cancelled', 'expired']);
    for (const s of PAYMENT_STATUSES) expect(isTerminalPaymentStatus(s)).toBe(TERMINAL_PAYMENT_STATUSES.includes(s));
  });
});
