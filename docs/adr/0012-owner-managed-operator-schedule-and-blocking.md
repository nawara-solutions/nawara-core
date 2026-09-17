# 0012. Owner-managed operator profile, schedule, and block/unblock

- **Status:** Accepted
- **Date:** 2026-09-17
- **Deciders:** Anwar (project owner)

## Context

Per ADR-0011, an owner (`adminTier: "owner"`) can create an operator
(`POST /auth/admin/operators`) and that operator can log in via a time-boxed code, gated only
by the platform-wide working-day calendar (`PlatformNonWorkingDay`). Nothing beyond creation
exists yet: there is no way for the owner to see the operators they've created, update an
operator's contact info, restrict an operator's login window more tightly than the
platform-wide calendar (e.g. to that specific operator's own shift hours), give an operator
individual days off distinct from the platform's calendar, or disable an operator's access
altogether without deleting their account.

The business need is a "manage agent" surface: the owner needs to view and administer their
own operators' profiles, schedules, and active/blocked state. This must be strictly
owner-only — an operator must never be able to reach any of this, including read-only access
to their own record, through this particular management surface.

`User.isActive: boolean` already exists in `auth-service`'s schema
(`docs/sdd/auth-service.md`'s data model), documented there as "schema-only groundwork for
v1 — no endpoint sets this flag yet." Nothing in this repo today writes to it.

## Options considered

1. **A new `operatorStatus` field (e.g. `"active" | "blocked"`), distinct from
   `User.isActive`.** Rejected: this duplicates semantics `isActive` was already added to the
   schema to express, and leaves that existing field permanently dormant instead of activating
   it — two fields would exist to answer what is really one question ("can this account log
   in?").
2. **Fold the operator-availability check directly into `PlatformCalendarService`**, extending
   `isWorkingDay` to also take an operator id and consult per-operator schedule data. Rejected:
   `PlatformCalendarService`'s single responsibility (per ADR-0011) is platform-wide calendar
   data, scoped only by `platformId`. Mixing in per-operator schedule data would make it
   ambiguous, for any given check in that service, which scope (platform or individual
   operator) it actually operates at.
3. **Build a full audit-log system now**, recording every owner action taken against an
   operator. Rejected as materially bigger scope than this pass warrants — no audit-log
   concept exists anywhere in this repo today, and designing one properly (retention, query
   shape, what else it should eventually cover) deserves its own decision, not a rider on this
   one.
4. **A new `OperatorAvailabilityService` that composes the existing `PlatformCalendarService`
   check with new per-operator schedule/time-off data; reuse of the existing, dormant
   `User.isActive` field for blocking; reuse of the existing `RefreshTokenService` revocation
   machinery for ending an operator's session on block (chosen).** Extends what already exists
   rather than introducing parallel concepts for schedule, status, or session termination.

## Decision

We chose **Option 4**. Concretely:

- New entity `OperatorSchedule {id, userId FK -> User (must be adminTier='operator'),
  dayOfWeek 0-6, startTime "HH:mm", endTime "HH:mm", createdAt, updatedAt}`,
  `UNIQUE(userId, dayOfWeek)`. One contiguous window per working day — no split shifts, no
  overnight (wrap-past-midnight) shifts in v1. This is the same deliberate minimalism
  ADR-0011 already applied to `PlatformNonWorkingDay`: no calendar-library dependency, no
  hardcoded scheduling complexity beyond what's actually needed for v1.
- New entity `OperatorTimeOff {id, userId FK -> User, date, label?, createdAt}`,
  `UNIQUE(userId, date)` — per-operator individual holiday/time-off dates, distinct from the
  platform-wide `PlatformNonWorkingDay` calendar ADR-0011 already owns.
- New `OperatorAvailabilityService.isOperatorAvailable(operatorUserId, now)`. This is a new
  service, not folded into `PlatformCalendarService` (see Options considered, option 2), that
  **composes** the existing `isWorkingDay` check rather than replacing it:
  1. `PlatformCalendarService.isWorkingDay(operator.platformId, now.date)` returns `false` →
     unavailable. The platform-wide baseline always wins, regardless of what the operator's
     own schedule says.
  2. An `OperatorTimeOff` row matches today for this operator → unavailable.
  3. Zero `OperatorSchedule` rows exist for this operator → **fail-open**, available every
     day/hour. This is the identical fail-open philosophy ADR-0011 already established for
     `PlatformNonWorkingDay`: an owner who hasn't configured a schedule for an operator
     shouldn't lock that operator out by a default they never opted into. The same reasoning
     applies here as there.
  4. Otherwise, the operator's configured schedule becomes an exhaustive whitelist: no
     `OperatorSchedule` row for today's `dayOfWeek`, or the current time falls outside
     `[startTime, endTime)` → unavailable; otherwise available.

  All three failure branches (1, 2, 4) return the **same** reason code `non_working_day` —
  ADR-0011's existing reason, not a new one. Fragmenting this into
  `outside_working_hours`/`day_off`/etc. would add no real client-facing value: the corrective
  action is identical in every case ("try again during your scheduled window"). The response
  message text is generalized accordingly (no longer calendar-specific wording). Replacing an
  operator's schedule with `{days: []}` (via the endpoint below) is the documented, deliberate
  way an owner reverts that operator to the fail-open state.
- ADR-0011's `POST /auth/admin/login/operator/request-code` flow is updated: the existing
  `PlatformCalendarService.isWorkingDay` call is swapped for
  `OperatorAvailabilityService.isOperatorAvailable`, which already incorporates the platform
  baseline internally (step 1 above), so nothing already designed is lost — only extended.
- Blocking reuses the **existing** `User.isActive` field. This ADR's block/unblock endpoints
  are the first to actually write it, closing the gap `docs/sdd/auth-service.md` already
  flagged rather than introducing a second, parallel status field (see Options considered,
  option 1).
- New endpoints, all under a new `AdminOperatorController` (a sibling to the existing
  `AdminAuthController`, both inside `AdminModule`), all gated by the **existing**
  `AdminTierGuard` (owner-only, per ADR-0010) — this alone is sufficient to guarantee an
  operator can never reach any of this, even about themselves; no new authorization mechanism
  is introduced. Every `:id` lookup is scoped as
  `WHERE id=:id AND adminTier='operator' AND platformId=<caller's own JWT claim>` →
  **`404`, never `403`**, on any mismatch (unknown id, wrong platform, or an id that isn't an
  operator at all). This is the same collapsed-404 pattern the existing
  `DELETE /auth/admin/platform/calendar/:id` endpoint already uses — "404, never 403, to avoid
  confirming the row exists at all" — applied again here for `platformId`-scoped operator
  lookups. (A related but distinct defense-in-depth principle, established by ADR-0007 for
  `organizationId`, is never trusting a body-supplied scope id when the caller's own JWT claim
  already says which scope they act for — every endpoint below likewise takes `platformId`
  only from the caller's own claim, never from the request.)
  - `GET /auth/admin/operators` — lists operators under the caller's own platform. Not
    explicitly part of the original ask, but justified the same way ADR-0007 justified
    `GET /payment/charges?method=cash&status=pending`: no admin dashboard exists anywhere in
    this repo, so without a list endpoint the owner has no way to discover their own
    operators at all.
  - `GET /auth/admin/operators/:id` — view one operator's profile.
  - `PATCH /auth/admin/operators/:id/contact` — `{email?, phone?}`, exactly one required
    (`400` otherwise), `409` on duplicate — the same invariant `POST /auth/admin/operators`
    already enforces at creation time (per ADR-0011).
  - `POST /auth/admin/operators/:id/block` — sets `isActive=false`; deletes any unconsumed
    `AdminOperatorCode` row for that operator (the same "old code is fully superseded"
    cleanup ADR-0011 already applies on a fresh `request-code` call); calls a new
    `RefreshTokenService.revokeAllForUser(id)` (see below); publishes new event
    `admin.operator_blocked = {operatorId, platformId, ownerId, timestamp}`.
  - `POST /auth/admin/operators/:id/unblock` — sets `isActive=true`; publishes new event
    `admin.operator_unblocked = {operatorId, platformId, ownerId, timestamp}`. No
    refresh-token action needed — re-entry happens via a fresh request-code/verify-code
    cycle, same as any other operator login.
  - `PUT /auth/admin/operators/:id/schedule` — full-replace semantics:
    `{days: [{dayOfWeek, startTime, endTime}]}`. Deletes all existing `OperatorSchedule` rows
    for that operator and inserts the given set, transactionally. `400` on a duplicate
    `dayOfWeek` within the array, or on `startTime >= endTime` for any entry.
  - `GET /auth/admin/operators/:id/schedule` — deliberately owner-only, **unlike** the
    existing platform calendar's `GET` (which any admin, including an operator, can read per
    ADR-0011). This asymmetry is intentional: the requirement here is that an operator must
    never reach any manage-agent capability on themselves through this surface, including
    reading their own schedule, so this `GET` does not inherit the platform calendar's more
    permissive treatment.
  - `POST /auth/admin/operators/:id/time-off` (`{date, label?}`, `409` on duplicate),
    `GET /auth/admin/operators/:id/time-off`,
    `DELETE /auth/admin/operators/:id/time-off/:timeOffId` (`204`/`404`, same collapsed-404
    pattern as above).
- Blocked-operator behavior in `request-code`/`verify-code` stays deliberately generic, not a
  distinct "blocked" response:
  - `request-code`'s existing operator-lookup query gains an `isActive: true` filter — a
    blocked operator simply fails to match, falling into the **same** generic `401` an
    unknown identifier already produces. These remain public, unauthenticated endpoints, and
    ADR-0011 already ordered its checks specifically so a day-dependent response could never
    distinguish a valid identifier from an invalid one — though ADR-0011's own Consequences
    section is explicit that this leaves a small, deliberately *accepted* (not closed)
    enumeration side-channel via the day check. A distinct blocked-response here would widen
    that same already-accepted side-channel with a second, different signal (whether the
    account is blocked, instead of whether it's a working day) rather than introducing an
    unrelated new one — staying generic keeps this decision from adding to it.
  - `verify-code`'s lookup query similarly gains a join requiring `isActive: true` — a blocked
    operator's leftover code (if one somehow survived; `block()` above already deletes it)
    falls into the existing "no row found" branch → generic `401`. `attemptCount` is
    explicitly **not** incremented in this case: this isn't a wrong-code guess, so it
    shouldn't burn one of the operator's 5 attempts.
- Session termination on block: new `RefreshTokenService.revokeAllForUser(userId)` —
  `UPDATE refresh_token SET revokedAt = now() WHERE userId = :userId AND revokedAt IS NULL`.
  This reuses ADR-0002's existing revocation machinery rather than inventing new
  blacklist/denylist infrastructure. Accepted limitation, stated explicitly: this caps the
  blocked operator's remaining access to at most their current access token's own short
  remaining TTL, since a stateless JWT cannot be force-expired early. This is the same
  accepted limitation ADR-0005 already documents for license-lapse enforcement ("bounded by
  the access-token TTL") — not a new gap introduced by this ADR.
- Audit-log/"follow operator actions" is explicitly **deferred**, not designed here (see
  Options considered, option 3). The `ownerId` already carried on `admin.operator_blocked`/
  `admin.operator_unblocked` gives an incidental, minimal "who did it" record as a byproduct
  of the existing event convention (per ADR-0010/ADR-0011) — this is not a substitute for a
  real audit log, which remains a future open question.

## Consequences

- Builds directly on ADR-0009 (`adminTier`/`platformId`), ADR-0010 (`AdminTierGuard`), and
  ADR-0011 (`AdminOperatorCode`, `isWorkingDay`, the request-code/verify-code flows this ADR
  modifies).
- Activates `User.isActive`, previously dormant schema-only groundwork, as the mechanism this
  ADR's block/unblock endpoints actually write.
- Gives the owner a real "manage agent" surface (list, view, update contact, schedule, time
  off, block/unblock) where previously only creation existed.
- Introduces `auth-service`'s first per-operator (as opposed to per-platform) scheduling
  concept, layered on top of, not replacing, ADR-0011's platform-wide calendar.
- The new owner-only surface inherits the same already-flagged, undesigned rate-limiting gap
  the rest of `auth-service` has (per `docs/add/auth-service.md`'s non-functional
  constraints) — not a new gap, but a wider surface exposed to the existing one.
- Leaves a real audit-log capability as future, undesigned work — this ADR only records who
  (`ownerId`) blocked/unblocked an operator and when, as an incidental byproduct of the event
  shape, not as a designed audit trail.
- `OperatorSchedule`'s no-overnight-shift restriction is a real, stated v1 limitation — a
  platform whose operators work shifts that cross midnight cannot represent that with a
  single `[startTime, endTime)` window; this would need its own follow-up decision if it
  becomes a real need.
