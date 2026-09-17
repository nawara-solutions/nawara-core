# 0014. Schedule-anchored operator login-code and session duration

- **Status:** Proposed
- **Date:** 2026-09-17
- **Deciders:** Anwar (project owner)

## Context

ADR-0011's `AdminOperatorCode.expiresAt` is `issuedAt + 8h`, and ADR-0013's
`RefreshToken.sessionExpiresAt` is `now + 8h` at `verifyCode()` success — two different
windows, anchored at two different moments (code issuance vs. login), that happen to share
the same flat duration. Both ADRs, and ADR-0012's own text, are explicit that "8 hours" was
only ever offered as an illustrative example of a typical shift length, not a hard product
requirement.

The actual product requirement is that an operator's granted access — both how long an
issued login code remains redeemable, and how long the resulting session lasts — should
track that operator's own scheduled shift for that day, not an arbitrary flat duration. An
operator scheduled 9am-1pm should not retain a redeemable code or an open session until
whatever a flat 8-hour clock says; an operator scheduled 8am-8pm should not be logged out
mid-shift because a flat 8-hour clock ran out first.

ADR-0012 already introduced `OperatorSchedule` and the composed
`OperatorAvailabilityService.isOperatorAvailable(operatorUserId, now)` check, which knows
whether an operator is inside their scheduled window right now, but nothing in this repo
yet derives a concrete end-of-shift *timestamp* from that data — `isOperatorAvailable` only
answers a boolean "yes/no," not "until when."

## Options considered

1. **Keep the flat `+8h` duration as a coincidental approximation of a typical shift** —
   simplest, no new code. Rejected: it doesn't match the actual requirement for any operator
   whose shift is shorter or longer than 8 hours, or whose shift doesn't start at the moment
   `request-code`/`verify-code` happens to be called — the "8 hours" in ADR-0011/ADR-0013 was
   never meant as a hard rule, only as filler for "a typical shift length."
2. **Compute `sessionExpiresAt` once, at `requestCode()` time, and thread it through
   `AdminOperatorCode` as a new field, reused verbatim by `verifyCode()`.** Rejected: this
   adds a field, and a coupling, whose only purpose would be to avoid a cheap,
   side-effect-free recomputation that is already provably equivalent to reusing it (see
   Decision below) — and it couples two independently-meaningful timestamps (the code's own
   redemption deadline vs. the session's ceiling) for no benefit, which is exactly the kind of
   conflation ADR-0013's own Context section was written specifically to avoid.
3. **A new method on the existing `OperatorAvailabilityService`, `getShiftEndOrFallback`,
   called independently by both `requestCode()` and `verifyCode()` (chosen).** Extends the
   service ADR-0012 already introduced for availability rather than creating a new one, and
   keeps each of the two call sites deriving its own value from first principles instead of
   passing one concept's value into a different concept's field.

## Decision

We chose **Option 3**. Concretely:

- New method on the **existing** `OperatorAvailabilityService` (no new service):
  `getShiftEndOrFallback(operatorUserId, now): Date`.
  - Load the operator's `OperatorSchedule` rows.
  - If **zero** rows exist at all → fail-open fallback, return `now + 8h` — the same
    fail-open philosophy ADR-0012 already established for an operator with no configured
    schedule (available every day/hour); "8 hours" survives here, but strictly as a fallback
    constant for the unscheduled case, not as the general rule.
  - Otherwise, find today's row by `dayOfWeek`, combine its `endTime` with today's date, and
    return that concrete timestamp.
  - Documented invariant, not a defensive error case: at the `requestCode()` call site, this
    method is called immediately after `isOperatorAvailable` has already returned `true` for
    the same `now`, so if any `OperatorSchedule` rows exist at all for the operator, today's
    row is guaranteed to exist and `now` is guaranteed to fall inside `[startTime, endTime)` —
    the algorithm above does not need to, and does not, handle "schedule rows exist but none
    match today" as a real case. At the `verifyCode()` call site, this same guarantee holds,
    but is derived transitively rather than by a direct preceding `isOperatorAvailable` call —
    see the recomputation reasoning below, which spells out exactly what that guarantee does
    and doesn't cover.
- `AdminOperatorCode.expiresAt` (in `requestCode()`) becomes
  `OperatorAvailabilityService.getShiftEndOrFallback(operator.id, issuedAt)`, replacing
  `issuedAt + 8h`.
- `RefreshToken.sessionExpiresAt` (in `verifyCode()`, at success) becomes
  `OperatorAvailabilityService.getShiftEndOrFallback(operator.id, now)`, replacing
  `now + 8h` — computed **fresh, independently**, at verify-code time. It is **not** reused
  from the value computed at request-code time, and **not** threaded through
  `AdminOperatorCode` as an extra field (see Option 2, rejected above).

  **This independent recomputation is the most important piece of reasoning in this ADR, so
  it's spelled out precisely — including exactly what it does and does not prove:**
  `verifyCode()` can only succeed while `now < AdminOperatorCode.expiresAt` — that's ADR-0011's
  own pre-existing expiry check, unchanged by this ADR. Since `expiresAt` is itself today's
  shift-end (or the 8h fallback, computed the same way), a successful `verify-code` call is
  proof that `now` is still within the same **calendar day** `requestCode()` saw. This
  guarantees recomputing can never resolve to a *different day's* `OperatorSchedule` row than
  `requestCode()` used — a request/verify pair that straddled midnight would already have
  failed the existing expiry check and never reach this computation at all.

  This proves same-day-row-lookup, **not** same-row-*content*. `OperatorSchedule` is
  owner-mutable at any time via ADR-0012's `PUT /auth/admin/operators/:id/schedule`
  (full-replace, no version/lock/optimistic-concurrency control anywhere in this design). If an
  owner replaces an operator's schedule — shortening/extending today's window, or wiping it to
  `{days: []}` — in the window between that operator's `requestCode()` and `verifyCode()`
  calls, `getShiftEndOrFallback` can legitimately return a *different* timestamp at verify time
  than it did at request time, on the same calendar day (e.g. a wiped schedule flips the
  verify-time result to the `+8h` fallback branch). This is an accepted, not-solved-here edge
  case — a normal concurrent-admin-action scenario, not a contrived one — rather than a flaw in
  the recompute choice: reusing the request-code value wouldn't avoid a real inconsistency here
  either, it would just silently apply a schedule value the owner had already changed, which is
  arguably the worse of the two behaviors.

  Given this, recomputing is still the better design choice, independent of the above: reusing
  the request-code value would mean piping one concept's value (the code's own redemption
  deadline) into a different concept (the session's ceiling) purely because they happen to be
  computed by the same method — exactly the conflation ADR-0013's own Context section was
  written to warn against ("two different windows that happen to share a duration... conflating
  these would be a mistake"). Recomputing keeps each concept deriving its own value
  independently, the way ADR-0013 already treats them as separate, and reflects whichever
  schedule is *currently* in force at each moment rather than freezing in a stale one.
- Accepted, explicitly not-solved edge cases: an operator who requests a code moments before
  their shift ends gets a very short remaining redemption window (and, if they make it
  through verify-code in time, an equally short session) — a direct, accepted consequence of
  anchoring to the operator's actual shift rather than a flat duration. Separately, a
  mid-window schedule edit by the owner (above) can change the session ceiling an operator
  ends up with between requesting and verifying a code — also accepted, not mitigated.

## Consequences

- Both ADR-0011's `AdminOperatorCode.expiresAt` formula and ADR-0013's
  `RefreshToken.sessionExpiresAt` formula are superseded **in value only** by this ADR — the
  flat `+8h` computation in each is replaced by
  `OperatorAvailabilityService.getShiftEndOrFallback`, with `+8h` demoted to a fallback
  constant used only when the operator has no configured `OperatorSchedule`. Nothing else in
  either ADR changes: ADR-0011's request-code/verify-code mechanism, its enumeration-avoidance
  check ordering, and its 5-attempt lockout are all unchanged; ADR-0013's
  ceiling-before-reuse-detection ordering in `RefreshTokenService.rotate()` and
  `TokenService.signAccessToken()`'s `exp = min(now + normalTTL, sessionExpiresAt)` clamping
  mechanism are both unchanged — only what gets passed as `sessionExpiresAt` changes.
- Per this repo's ADR-immutability convention (`docs/adr/README.md`), ADR-0011's and
  ADR-0013's own text is left **completely unmodified**, exactly as originally decided — no
  cross-reference notes are added into either file's body. This ADR (0014) alone is the
  record of what superseded what; a reader who wants to know an operator's *current*
  login-code/session-ceiling duration should read this ADR, not expect ADR-0011 or ADR-0013 to
  point forward to it themselves. `docs/add/auth-service.md` and `docs/sdd/auth-service.md`,
  being living documents, **are** being fully updated in place to describe this as current
  behavior.
- Makes an operator's granted access proportional to their actual scheduled shift instead of
  an arbitrary flat window — a shift shorter than 8h no longer over-grants access, and a
  shift longer than 8h is no longer cut short mid-shift.
- Introduces a small, real usability gap for an operator who requests a code very close to
  their shift's end (see Decision) — not mitigated here, and not expected to be common enough
  to warrant one in v1.
- `getShiftEndOrFallback`'s "today's row is guaranteed to exist" guarantee is a coupling
  future changes must preserve, but the coupling differs by call site: at `requestCode()` it
  comes directly from an immediately-preceding `isOperatorAvailable` call; at `verifyCode()`
  it's derived transitively via the `expiresAt > now` check instead (see Decision). If
  `getShiftEndOrFallback` were ever called from a new call site with neither guarantee in
  place, its "today's row is guaranteed to exist" assumption would need to be revisited.
