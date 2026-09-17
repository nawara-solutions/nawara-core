# 0015. Two-phase operator contact confirmation before first login

- **Status:** Proposed
- **Date:** 2026-09-17
- **Deciders:** Anwar (project owner)

## Context

Today, `POST /auth/admin/operators` (per ADR-0011) creates an operator `User` row from an
owner-supplied `email`/`phone` and nothing verifies that the given contact actually belongs
to the person who will use it — an owner could mistype an address, or an operator could
never actually check the inbox/phone they were registered with, and the first sign of
trouble would be a login that silently never arrives, with no way to distinguish that from a
delivery failure.

The business requirement is that, before an operator can use ordinary daily login codes,
they must first go through a distinct confirmation step proving they own the given
email/phone, and only after that confirmation succeeds does the system send their actual
first real login code — a second, separate code from the one used for confirmation.

## Options considered

1. **A separate confirmation-link/token system** — a public confirmation web page with its
   own URL-embedded token, the pattern many email-verification flows use. Rejected: this repo
   has no public web-page infrastructure and no link-based token verification anywhere today;
   building both just for this would be new infrastructure introduced solely for one flow,
   when the code+verify mechanism ADR-0011 already built does the same job.
2. **A single combined confirm-and-login step**, where the very first code an operator
   receives both confirms their contact and logs them in. Rejected: doesn't match the
   requirement's explicit two-step description (confirm first, then separately receive a
   distinct first login code), and conflates two different things — "prove you own this
   contact" and "here is your working credential" — into one artifact, which would make it
   impossible to, for example, let an owner know a registration is stuck at "unconfirmed"
   independently of whether a login code was ever issued.
3. **Two distinct, purpose-differentiated codes reusing ADR-0011's existing code/verify
   mechanism (chosen).** A confirmation code and a login code share the same underlying
   `AdminOperatorCode` matching/lockout logic, scoped one dimension finer so they never
   interfere with each other, with no new infrastructure.

## Decision

We chose **Option 3**. Concretely:

- `User` gains `contactVerifiedAt: timestamp | null` — meaningful only for operators
  (`adminTier: 'operator'`); always `null` for owners and non-admin users. Null until
  confirmed; never reset once set.
- `AdminOperatorCode` gains `purpose: "confirmation" | "login"`, required on every row.
  **All** of ADR-0011's existing matching/lockout logic is fully reused for both purposes,
  deliberately, not by oversight: hash comparison happens in application code (so
  `attemptCount` can increment on a wrong guess), `attemptCount < 5` gates validity, 5 failed
  attempts permanently invalidate the code, a no-row-found result never increments
  `attemptCount`, and requesting a new code deletes any previous unconsumed row for that
  operator — just scoped one dimension finer, by `(userId, purpose)` instead of just
  `userId`, so issuing a fresh confirmation code never invalidates a live login code and vice
  versa.
- `expiresAt` computation differs by `purpose`, not by mechanism:
  - `purpose: 'login'` rows use `OperatorAvailabilityService.getShiftEndOrFallback` (per
    ADR-0014), unchanged from that ADR.
  - `purpose: 'confirmation'` rows use a flat `now + 8h` unconditionally, regardless of
    schedule. Confirmation codes are issued at owner-driven registration time, never behind
    the `isOperatorAvailable` gate — there is no "shift" moment to anchor to at that call
    site, so applying ADR-0014's shift-anchoring there would misuse a concept that doesn't
    apply.
- `POST /auth/admin/operators` (the existing registration endpoint, per ADR-0011) is
  extended: after creating the `User` row (now with `contactVerifiedAt: null`), it also
  generates and sends a `purpose: 'confirmation'` code via the chosen channel, publishing a
  new event `admin.operator_confirmation_code_issued = {userId, platformId, channel,
  destination, code, expiresAt, timestamp}`. The existing `admin.operator_registered` event
  is **unchanged** — it still means only "an operator account was created," not overloaded to
  also mean "and a confirmation code was sent."
- New endpoint **`POST /auth/admin/operators/confirm`** — public, no auth (the operator has
  no session yet). Body `{email?, phone?, code}` — `400` if neither/both of `email`/`phone`,
  or `code` is missing.
  1. Look up `User WHERE (email OR phone) AND adminTier = 'operator' AND isActive = true` —
     not found → generic `401`. The same collapsing this repo already uses elsewhere: a
     blocked operator can't progress onboarding through this endpoint either.
  2. If `contactVerifiedAt` is **already** non-null → idempotent no-op success, `204`, with
     **no** side effects regardless of what `code` was submitted (the code isn't even
     validated in this branch). This is the deliberate way an already-confirmed operator
     retrying this call stays harmless.
  3. Otherwise, validate `code` against the operator's live `purpose: 'confirmation'` row
     using the exact same matching/lockout logic `verifyCode` already uses, including
     `attemptCount` increment behavior. Wrong/expired/exhausted/no-row → generic `401`.
  4. On a match: mark the confirmation row consumed, set `contactVerifiedAt = now`, publish a
     new event `admin.operator_contact_confirmed = {operatorId, platformId, timestamp}` (no
     `ownerId` — the confirming actor is the operator, not the owner), then internally call
     the **existing** `requestCode()` method directly — literally the same code path a
     self-triggered call would hit, gated by the same `isOperatorAvailable` check. If the
     operator is currently available, this sends their real first `purpose: 'login'` code; if
     not currently available, no code is sent, but confirm still returns success — the
     operator simply gets their first code at their next scheduled window via an ordinary
     self-triggered `request-code` call, exactly like any already-confirmed operator. Response
     in both sub-cases: `204`.
  - **Accepted side channel**, named explicitly in the same spirit as ADR-0011's already-accepted
    one, not re-engineered around: because the idempotent-`204` branch (step 2) doesn't
    depend on the submitted code being correct, while the real-validation branch (step 3)
    does, a caller submitting a deliberately wrong code can distinguish "this identifier
    belongs to an already-confirmed operator" (`204`) from "unconfirmed or unknown" (`401`).
    This is the same size and shape of leak ADR-0011 already accepted for its own
    non-working-day side channel.
- `POST /auth/admin/login/operator/request-code`'s existing lookup gains one more
  precondition: `contactVerifiedAt IS NOT NULL`, collapsing into the **same** generic `401`
  as unknown-identifier/blocked-operator — **not** a distinct response.

  **This is deliberately the opposite of ADR-0013's choice for `session_ceiling_reached`, for
  a specific reason worth contrasting explicitly:** ADR-0013's ceiling response is allowed to
  be distinct and informative *because* the caller already possesses unforgeable proof of
  prior legitimate access — a real, previously-issued refresh token — so telling them why it
  stopped working leaks nothing new. `request-code` is a public, unauthenticated endpoint
  taking only a low-entropy email/phone string, with no such proof of legitimacy. A distinct
  "not yet confirmed" response there would newly confirm that a guessed identifier belongs to
  a real, registered operator — structurally the same reasoning ADR-0012 already applied to
  its blocked-operator case (no proof of legitimacy at that endpoint means stay generic), not
  ADR-0013's case.

  `verify-code`'s existing lookup also gains the same `contactVerifiedAt IS NOT NULL` check,
  for defense-in-depth, even though by construction a live `purpose: 'login'` code can never
  exist for an unconfirmed operator (nothing issues one until confirmation succeeds).
- Necessary consequence of introducing `purpose`, to be reflected in the ADD/SDD rather than
  in ADR-0012's own text (since `purpose` didn't exist when that ADR was written):
  `OperatorManagementService.block()` needs to broaden to delete unconsumed
  `AdminOperatorCode` rows regardless of `purpose`, not just login-purpose ones — a blocked
  operator shouldn't retain a live confirmation code any more than a live login code.

## Consequences

- Builds on ADR-0011 (reuses its code/verify mechanism and enumeration-avoidance philosophy
  wholesale), ADR-0012 (the `request-code`/`verify-code` flows this ADR further modifies, and
  the `block()` broadening noted above), and ADR-0014 (the `login`-purpose code's duration
  computation).
- Until an operator confirms their contact, they cannot use ordinary daily logins at all —
  the owner should be aware that a freshly-registered operator isn't immediately operational,
  and needs to actually receive and act on the confirmation code first.
- Accepts the same size/shape of enumeration side channel noted above (step 2's idempotent
  `204` vs. step 3's `401`), in the same spirit as, and not materially wider than, ADR-0011's
  own already-accepted side channel.
- `OperatorManagementService.block()`'s broadened cleanup (deleting unconsumed
  `AdminOperatorCode` rows of either `purpose`) needs to land in `docs/add/auth-service.md`/
  `docs/sdd/auth-service.md` as a description of current behavior — ADR-0012 itself is not
  rewritten, per this repo's ADR-immutability convention.
- Adds a second admin-security/operator-lifecycle event
  (`admin.operator_confirmation_code_issued`) alongside `admin.operator_code_issued`, and a
  new `admin.operator_contact_confirmed` event with no `ownerId` (unlike
  `admin.operator_blocked`/`admin.operator_unblocked`) since the confirming actor is the
  operator, not the owner.
