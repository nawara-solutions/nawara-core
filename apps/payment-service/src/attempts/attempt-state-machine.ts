/** The payment attempt state machine (SDD section 5.2). */
export const ATTEMPT_STATUSES = ['initiated', 'submitted', 'succeeded', 'failed', 'expired', 'unknown'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const OPEN_ATTEMPT_STATUSES: readonly AttemptStatus[] = ['initiated', 'submitted', 'unknown'];

const ALLOWED: Record<AttemptStatus, readonly AttemptStatus[]> = {
  initiated: ['submitted', 'failed', 'unknown'],
  submitted: ['succeeded', 'failed', 'expired'],
  succeeded: [],
  failed: [],
  expired: [],
  unknown: ['submitted', 'succeeded', 'failed'],
};

/** Mirrors the database trigger (`payment_attempt_status_transition_guard`) — defence in depth, section 5.2. */
export function canTransitionAttempt(from: AttemptStatus, to: AttemptStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function isOpenAttemptStatus(status: AttemptStatus): boolean {
  return OPEN_ATTEMPT_STATUSES.includes(status);
}
