/** The payment state machine (SDD section 5.1), gateway settlement only in this phase — no cash states. */
export const PAYMENT_STATUSES = ['created', 'pending', 'closing', 'succeeded', 'failed', 'cancelled', 'expired'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = ['succeeded', 'failed', 'cancelled', 'expired'];

const ALLOWED: Record<PaymentStatus, readonly PaymentStatus[]> = {
  // 'created' -> 'succeeded' is the late-success path (section 5.1): an inferred failure already returned the
  // payment to 'created', and the provider then confirms success for that same attempt.
  // Core V2 S4c (F-1, F-3): 'created' -> 'failed' once an inferred failure is later CONFIRMED and the attempt limit was reached;
  // 'closing' is entered by a cancel or an expiry while an attempt may still settle the payment, and never returns to created/pending.
  created: ['pending', 'cancelled', 'expired', 'succeeded', 'failed', 'closing'],
  pending: ['created', 'succeeded', 'failed', 'cancelled', 'expired', 'closing'],
  closing: ['succeeded', 'cancelled', 'expired'],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
};

/** Mirrors the database trigger (`payment_status_transition_guard`, section 5) so the same rule lives in two places
 * on purpose — application code that never issues an invalid UPDATE, and a trigger that refuses one regardless. */
export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status);
}

/**
 * Core V2 S4c (F-5): the derived, OPERATIONAL finality of a payment. `final` means only that the payment's workflow has closed
 * (succeeded, failed, cancelled, expired); it never asserts that a refund, a dispute, a chargeback or late provider evidence is
 * impossible. `uncertain`: closing, or an attempt may still produce a verified financial result (F-2). `open`: neither.
 */
export type PaymentFinality = 'open' | 'uncertain' | 'final';
export function paymentFinality(status: PaymentStatus, uncertain: boolean): PaymentFinality {
  if (isTerminalPaymentStatus(status)) return 'final';
  return status === 'closing' || uncertain ? 'uncertain' : 'open';
}
