/** The payment state machine (SDD section 5.1), gateway settlement only in this phase — no cash states. */
export const PAYMENT_STATUSES = ['created', 'pending', 'succeeded', 'failed', 'cancelled', 'expired'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = ['succeeded', 'failed', 'cancelled', 'expired'];

const ALLOWED: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ['pending', 'cancelled', 'expired'],
  pending: ['created', 'succeeded', 'failed', 'cancelled', 'expired'],
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
