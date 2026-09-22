/**
 * Pure renewal-anchor math for Subscription (Stage 12.2, sections 17/22-25/50). Deliberately NOT `deriveEntitlement`
 * (section 55): this answers only "where does the next purchased period start from", the one calculation Subscription's
 * own renewal needs. The actual `{valid, expiresAt}` effective-access question is Stage 12.3's.
 *
 * Periods are half-open: `[currentPeriodStart, currentPeriodEnd)`. Access is valid while `now < currentPeriodEnd`, and
 * `now === currentPeriodEnd` means the paid period has already ended.
 */
export interface RenewalBasis {
  currentPeriodEnd: Date;
  graceUntil: Date | null;
}

/**
 * The instant the next purchased period starts counting from (frozen rule, section 25: "anchor from ORIGINAL
 * currentPeriodEnd").
 *
 * - Renewing before or exactly at the access boundary (still `active`, or within `graceUntil`): the anchor is the
 *   ORIGINAL `currentPeriodEnd`, never `now` and never `graceUntil` — already-paid-for time is never lost, and grace
 *   time is never additionally credited on top of it (sections 22, 23, 25).
 * - Renewing after that boundary has passed (no grace configured and the period already ended, or grace itself has
 *   elapsed): the anchor is `now` — no back-charging for inaccessible days (section 24).
 *
 * `now === boundary` (the exact edge of the paid-or-graced window) resolves to `currentPeriodEnd` either way, since at
 * that instant `now` and the boundary coincide when there is no grace, and grace itself is defined to sit strictly
 * after `currentPeriodEnd` — so the two branches never disagree at the boundary (section 50).
 */
export function renewalAnchor(sub: RenewalBasis, now: Date): Date {
  const boundary = sub.graceUntil ?? sub.currentPeriodEnd;
  return now.getTime() <= boundary.getTime() ? sub.currentPeriodEnd : now;
}
