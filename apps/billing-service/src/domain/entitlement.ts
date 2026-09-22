import type { SubscriptionStatus } from './state-machines.js';

/**
 * Pure Entitlement derivation (Stage 12.3). Entitlement is a logical Billing capability, not a physical service and not
 * a persisted table: it answers ONE question — "does this Organization have effective commercial access at
 * authoritative time `now`?" — entirely from Subscription's own already-established fields. It never queries the
 * database, never calls another service, and never reads configuration (Stage 12.2's `SUBSCRIPTION_GRACE_DAYS` already
 * did its job by the time `graceUntil` was precomputed and persisted; re-reading it here would be the architecture
 * leaking). `now` is always supplied by the caller — never `new Date()`/`Date.now()` internally — so boundary behavior
 * is deterministic and testable.
 *
 * The V1 result is frozen to exactly `{ valid, expiresAt }` (Stage 11): no reason code, no feature flags, no plan
 * metadata. `cancelAtPeriodEnd` is deliberately NOT part of the input — it describes what happens at the NEXT
 * boundary, never a reason to revoke already-purchased access, so it is structurally incapable of affecting this
 * result, not just behaviorally ignored.
 */
export interface SubscriptionForEntitlement {
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
  effectiveTerminationAt: Date | null;
}

export interface EffectiveEntitlement {
  valid: boolean;
  expiresAt: Date | null;
}

/** A Subscription (or the `now` supplied against it) violates an invariant the database itself already enforces. Never
 * thrown for a normal commercial outcome (not started, expired, grace expired, terminated, pending are all `{valid:
 * false, expiresAt: null}`, not errors) — only for a structurally impossible state, which can only mean a caller bug. */
export class EntitlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntitlementError';
  }
}

const INVALID: EffectiveEntitlement = { valid: false, expiresAt: null };

function assertValidDate(d: Date, field: string): void {
  if (Number.isNaN(d.getTime())) throw new EntitlementError(`${field} is an invalid Date`);
}

/**
 * Algorithm (half-open intervals throughout, section 12/17):
 *
 * 1. No subscription, or `status = 'pending'`: no effective entitlement ever existed yet.
 * 2. Otherwise a period MUST exist (`currentPeriodStart`/`currentPeriodEnd` non-null — the database's own
 *    `subscription_active_has_period` CHECK already guarantees this for every real, non-pending row); re-validate the
 *    same relative-order invariants the database enforces (`currentPeriodEnd > currentPeriodStart`, `graceUntil >
 *    currentPeriodEnd`, `effectiveTerminationAt` no later than the period/grace boundary) and throw rather than derive
 *    a silent, wrong answer from data that could not actually exist.
 * 3. The NORMAL boundary is `graceUntil` if the subscription has one, else `currentPeriodEnd` — deliberately read from
 *    whichever timestamp is ALREADY on the row, never re-derived from status. A subscription whose `status` is still
 *    `active` (or even a premature `expired`, section 23) but whose `now` already falls inside `[currentPeriodEnd,
 *    graceUntil)` is exactly as valid as one already labelled `grace`: Stage 12.2 precomputes `graceUntil` at
 *    activate/renew time FOR THIS REASON, so a delayed status-normalizing sweeper (never built, and never required)
 *    cannot cause an incorrect answer.
 * 4. `effectiveTerminationAt`, when present, can only SHORTEN that boundary (never lengthen it — the database CHECK
 *    already guarantees `effectiveTerminationAt <= boundary`, so simply preferring it when present is correct without
 *    needing a `min()`).
 * 5. Access is valid while `currentPeriodStart <= now < effectiveBoundary`; `expiresAt` is that boundary. Otherwise
 *    `{ valid: false, expiresAt: null }` — a stale past timestamp is never exposed as if it were a live expiry.
 */
export function deriveEntitlement(subscription: SubscriptionForEntitlement | null, now: Date): EffectiveEntitlement {
  assertValidDate(now, 'now');
  if (subscription === null || subscription.status === 'pending') return INVALID;

  const { currentPeriodStart, currentPeriodEnd, graceUntil, effectiveTerminationAt } = subscription;
  if (currentPeriodStart === null || currentPeriodEnd === null) {
    throw new EntitlementError(`a subscription with status '${subscription.status}' must have a period`);
  }
  assertValidDate(currentPeriodStart, 'currentPeriodStart');
  assertValidDate(currentPeriodEnd, 'currentPeriodEnd');
  if (currentPeriodEnd.getTime() <= currentPeriodStart.getTime()) {
    throw new EntitlementError('currentPeriodEnd must be after currentPeriodStart');
  }

  let boundary = currentPeriodEnd;
  if (graceUntil !== null) {
    assertValidDate(graceUntil, 'graceUntil');
    if (graceUntil.getTime() <= currentPeriodEnd.getTime()) throw new EntitlementError('graceUntil must be after currentPeriodEnd');
    boundary = graceUntil;
  }
  if (effectiveTerminationAt !== null) {
    assertValidDate(effectiveTerminationAt, 'effectiveTerminationAt');
    if (effectiveTerminationAt.getTime() > boundary.getTime()) {
      throw new EntitlementError('effectiveTerminationAt cannot extend access past the period/grace boundary');
    }
    boundary = effectiveTerminationAt;
  }

  if (now.getTime() < currentPeriodStart.getTime()) return INVALID; // not started yet, whatever `status` says (section 13)
  return now.getTime() < boundary.getTime() ? { valid: true, expiresAt: boundary } : INVALID;
}
