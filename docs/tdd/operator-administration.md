# owner-facing operator administration: schedule/time-off, block/unblock, session ceiling

- **Status:** Draft <!-- Draft | Reviewed | Implemented -->
- **Author:** Anwar (project owner)
- **Related SDD:** [docs/sdd/auth-service.md](../sdd/auth-service.md)
- **Related ADRs:** [0012](../adr/0012-owner-managed-operator-schedule-and-blocking.md)
  (owner-managed operator profile, schedule, and block/unblock),
  [0013](../adr/0013-operator-session-ceiling.md) (hard session ceiling for operator
  refresh-token rotation — see the value-superseded-by-ADR-0014 note below),
  [0014](../adr/0014-schedule-anchored-operator-duration.md) (schedule-anchored operator
  login-code and session duration — supersedes ADR-0013's flat `now + 8h` session-ceiling
  formula **in value only**; per this repo's ADR-immutability convention (`docs/adr/README.md`),
  ADR-0013's own text is left completely unmodified, so this TDD implements the
  `sessionExpiresAt` computation exactly as ADR-0014 documents it, not as ADR-0013's original
  text still literally reads — ADR-0014 alone is the record of what superseded what),
  [0015](../adr/0015-two-phase-operator-contact-confirmation.md) (two-phase operator contact
  confirmation — the `block()` endpoint's broadening to delete unconsumed `AdminOperatorCode`
  rows of either `purpose` is a documented consequence of this ADR introducing `purpose` after
  ADR-0012 was written)
- **Ticket/issue:** https://github.com/nawara-solutions/nawara-core/issues/15

## Problem

`docs/tdd/operator-login-and-confirmation.md` implements how an operator gets created and logs
in; nothing yet lets the owner who created them actually *manage* them beyond that one-time
creation call. This TDD implements the rest of `docs/sdd/auth-service.md`'s owner-facing "manage
agent" surface, as already fully designed: listing/viewing operators, updating contact info,
full-replace `OperatorSchedule` management and `OperatorTimeOff` CRUD, block/unblock (activating
`User.isActive`), and the hard session ceiling on an operator's session once granted — enforced
server-side in `RefreshTokenService.rotate()`, independent of, and not to be confused with, the
login-code redemption window `docs/tdd/operator-login-and-confirmation.md` already implements.
Like that TDD, this one sequences already-complete design into working code; it does not design
anything new.

**Dependency on `docs/tdd/operator-login-and-confirmation.md`:** this TDD is not buildable in
isolation. It reuses, rather than rebuilds, several things that TDD adds as shared plumbing:
the `OperatorSchedule`/`OperatorTimeOff` entities/tables, `RefreshToken.sessionExpiresAt` (the
column, and the fact that `verify-code` already stamps it via `RefreshTokenService.issue(userId,
sessionExpiresAt)` and `TokenService.signAccessToken(payload, sessionExpiresAt)`), the
`JwtPayload` `platformId`/`adminTier` claims, and `AdminTierGuard`. This TDD assumes all of that
has already shipped, and adds no new columns or claims of its own beyond what's listed under
Files/components affected below.

Out of scope, tracked separately: the owner's secret-key login/rotation (ADR-0010), covered by
[`admin-owner-secret-key`](./admin-owner-secret-key.md) — and a real audit-log capability for
owner actions against operators, which ADR-0012 itself defers as undesigned future work.

## Approach

Business logic per endpoint, taken directly from the SDD's API contract, the ADD's "Communication
& data flow" section 3, and flow (m)/(n) — no new behavior invented here. Every `:id`-scoped
lookup below uses the same query shape: `WHERE id = :id AND adminTier = 'operator' AND
platformId = <caller's own JWT claim>` → **`404`, never `403`**, on any mismatch (unknown id,
wrong platform, or an id that isn't an operator at all) — the same collapsed-404 pattern the
`docs/tdd/operator-login-and-confirmation.md` TDD already applies to
`DELETE /auth/admin/platform/calendar/:id`. Every endpoint in this section is Bearer,
`adminTier: 'owner'` only (via `AdminTierGuard`) — unlike the platform-calendar group in
`operator-login-and-confirmation.md`, none of this group's endpoints are readable by an
operator; there is no "any admin" exception here.

- **`GET /auth/admin/operators`** — lists operators scoped to the caller's own `platformId`.
  `200 [{id, email?, phone?, isActive, createdAt}, ...]`.
- **`GET /auth/admin/operators/:id`** — `200 {id, email?, phone?, isActive, createdAt}`; `404`
  per the collapsed pattern.
- **`PATCH /auth/admin/operators/:id/contact`** — `{email?, phone?}`, exactly one required
  (`400` otherwise), `409` on duplicate — the same invariant `POST /auth/admin/operators`
  already enforces at creation time. `200 {id, email?, phone?, isActive, createdAt}`; `404` per
  the collapsed pattern.
- **`POST /auth/admin/operators/:id/block`** (SDD flow (m)): sets `User.isActive = false`;
  deletes any unconsumed `AdminOperatorCode` row(s) for that operator **regardless of
  `purpose`** — both `'confirmation'` and `'login'`. This broadening beyond ADR-0012's original
  "deletes any unconsumed code" wording is a documented consequence of ADR-0015 introducing
  `purpose` after ADR-0012 was written (ADR-0012's own text is unmodified, per this repo's
  ADR-immutability convention — the broadening is recorded in the ADD/SDD as current behavior,
  and implemented here as such, not re-litigated). Calls
  `RefreshTokenService.revokeAllForUser(id)` (new method — see below). `204`; `404` per the
  collapsed pattern.
- **`POST /auth/admin/operators/:id/unblock`** (SDD flow (n)): sets `User.isActive = true`. No
  refresh-token action — re-entry is via a fresh request-code/verify-code cycle. `204`; `404`
  per the collapsed pattern.
- **`PUT /auth/admin/operators/:id/schedule`** — `{days: [{dayOfWeek, startTime, endTime}]}`.
  Full-replace, transactionally: deletes every existing `OperatorSchedule` row for that operator
  and inserts the given set. `400` on a duplicate `dayOfWeek` within the array, or on
  `startTime >= endTime` for any entry. `{days: []}` is the documented way to revert the
  operator to the fail-open state. No optimistic-concurrency/version check of any kind — a
  full-replace call always wins regardless of what else may be reading or about to read the old
  rows (see Edge cases). `200 [{id, dayOfWeek, startTime, endTime}, ...]`; `404` per the
  collapsed pattern.
- **`GET /auth/admin/operators/:id/schedule`** — deliberately **owner-only**, unlike the
  platform calendar's more permissive `GET` (any admin) — an operator must never read even
  their own schedule through this surface (per ADR-0012). `200 [...]`; `404` per the collapsed
  pattern.
- **`POST /auth/admin/operators/:id/time-off`** — `{date, label?}`. `409` on duplicate
  `(userId, date)`. `201 {id, date, label?, createdAt}`; `404` per the collapsed pattern.
- **`GET /auth/admin/operators/:id/time-off`** — `200 [{id, date, label?, createdAt}, ...]`;
  `404` per the collapsed pattern.
- **`DELETE /auth/admin/operators/:id/time-off/:timeOffId`** — `204`; `404` if either `:id`
  isn't the caller's own operator or `:timeOffId` doesn't belong to that operator.
- **Session ceiling enforcement** — the one change in this TDD that isn't a new
  `AdminOperatorController` endpoint: `RefreshTokenService.rotate()` gains a new check, run
  **before** its existing revoked/reuse-detection check (this ordering is a correctness
  requirement per ADR-0013, not a stylistic choice — see Edge cases/Test plan). If the presented
  token's `sessionExpiresAt` is set and `now >= sessionExpiresAt`: call the existing
  `revokeFamily(familyId)` (extracted as a named method by
  `docs/tdd/operator-login-and-confirmation.md`) — a clean, expected session-end revocation, not
  a theft signal — and return `401 {reason: "session_ceiling_reached", message: "Your session
  has ended. Please request a new login code to continue."}` (the message is reworded from
  ADR-0013's original flat "8-hour" wording, since the ceiling now tracks the operator's own
  shift, per ADR-0014). Otherwise, rotation proceeds as already built: the new `RefreshToken`
  row copies `sessionExpiresAt` forward **unchanged** from the old one (never recomputed), and
  `TokenService.signAccessToken(payload, sessionExpiresAt)` is called again on every rotation
  (already built by `docs/tdd/operator-login-and-confirmation.md`; this TDD is simply the first
  to exercise it on the rotation path in addition to initial issuance) — `exp = min(now +
  <normal TTL>, sessionExpiresAt)`, which equals the ceiling itself on the final rotation before
  it, giving the client everything it needs to show a "session ending soon" warning with no new
  field.

## Files/components affected

- `apps/auth-service/src/admin/operator-schedule.service.ts` — new. `OperatorScheduleService`:
  `replaceSchedule`, `getSchedule`, `createTimeOff`, `listTimeOff`, `deleteTimeOff`.
- `apps/auth-service/src/admin/operator-management.service.ts` — new.
  `OperatorManagementService`: `list`, `findOneOrNotFound`, `updateContact`, `block`, `unblock`.
- `apps/auth-service/src/admin/admin-operator.controller.ts` — new. `AdminOperatorController`:
  `list`, `getOne`, `updateContact`, `block`, `unblock`, `replaceSchedule`, `getSchedule`,
  `createTimeOff`, `listTimeOff`, `deleteTimeOff`.
- `apps/auth-service/src/admin/dto/update-operator-contact.dto.ts` — new. `{email?, phone?}`.
- `apps/auth-service/src/admin/dto/schedule-day.dto.ts` — new. `{dayOfWeek, startTime,
  endTime}`.
- `apps/auth-service/src/admin/dto/replace-operator-schedule.dto.ts` — new. `{days:
  ScheduleDayDto[]}`.
- `apps/auth-service/src/admin/dto/create-operator-time-off.dto.ts` — new. `{date, label?}`.
- `apps/auth-service/src/auth/refresh-token.service.ts` — modified. `rotate()` gains the
  ceiling check (run before reuse-detection); adds `revokeAllForUser(userId)`.
- `apps/auth-service/src/admin/admin.module.ts` — modified. Registers `AdminOperatorController`,
  `OperatorManagementService`, `OperatorScheduleService`.

Reused, not modified, from `docs/tdd/operator-login-and-confirmation.md`:
`apps/auth-service/src/admin/entities/operator-schedule.entity.ts`,
`.../operator-time-off.entity.ts`, `apps/auth-service/src/auth/entities/refresh-token.entity.ts`
(`sessionExpiresAt` already exists on it), `apps/auth-service/src/auth/token.service.ts`
(`signAccessToken`'s `sessionExpiresAt` parameter already exists), `.../admin/admin-tier.guard.ts`,
`.../auth/jwt-payload.interface.ts`, and `OperatorAvailabilityService` (this TDD calls
`getShiftEndOrFallback` nowhere new — it's the login-flow endpoints, not this TDD's endpoints,
that call it — but this TDD's `PUT .../schedule` is what makes its non-fail-open branches
actually reachable for the first time; see Edge cases).

## Edge cases

Pulled from the SDD/ADRs, scoped to this TDD's endpoints — no new cases invented:

- **Mid-window schedule-edit inconsistency (accepted per ADR-0014):** `PUT
  /auth/admin/operators/:id/schedule` has no optimistic-concurrency control of any kind. If an
  owner replaces an operator's schedule between that operator's `request-code` and `verify-code`
  calls (both `docs/tdd/operator-login-and-confirmation.md`'s endpoints), `verify-code`'s
  independent `getShiftEndOrFallback` recomputation can legitimately land on a different
  timestamp than `request-code`'s, on the same calendar day (e.g. a wipe to `{days: []}` flips
  the verify-time result to the `+8h` fallback branch). Not mitigated here — reusing the
  request-code-time value instead would just silently apply a schedule the owner had already
  changed, which ADR-0014 judges the worse of the two behaviors.
- **404, never 403, on scope mismatch (per ADR-0012):** every `:id`-scoped endpoint in this TDD
  returns `404` for an unknown id, a different platform's operator, or an id that isn't an
  operator at all — never `403` — to avoid confirming the row exists at all.
- `PUT .../schedule` with a duplicate `dayOfWeek` in the array, or any entry with
  `startTime >= endTime` → `400`.
- `POST .../time-off` with a duplicate `(userId, date)` → `409`.
- `GET .../schedule` called by anyone other than the platform's owner — including the operator
  themselves — → `403`/`404` (deliberately **not** given the platform calendar's more
  permissive any-admin-can-read treatment, per ADR-0012).
- `PATCH .../contact` with neither or both of `email`/`phone` → `400`; duplicate → `409`.
- Blocking an operator with an already-consumed or already-expired code lying around → no-op;
  only *unconsumed* rows are deleted, of either `purpose`.
- **Ceiling-before-reuse-detection ordering is a correctness requirement, not a style choice
  (ADR-0013, explicit):** if the ceiling check ran after the reuse-detection check instead, a
  token that legitimately hit its ceiling would get marked revoked by the ceiling check first,
  and a client retry of that same request would then find an already-revoked token and get
  misclassified by the *existing* reuse-detection logic as reused/stolen — a false positive
  treating a normal, expected session end as a security incident.
- **Accepted theft-replay observability tradeoff (per ADR-0013):** once a family's ceiling has
  passed, a stale token replayed by an attacker (a genuine theft-replay, not a normal client
  retry) is classified identically to a legitimate expected session end
  (`session_ceiling_reached`), since the ceiling check runs before reuse-detection regardless of
  which kind of token is presented. This doesn't create an authorization bypass — access is
  denied either way — but a real post-ceiling theft-replay no longer gets the structured
  "reused/stolen" security-event log entry the reuse-detection path otherwise records. Not
  solved here.
- Block reuses `RefreshTokenService.revokeAllForUser`, bounded by the blocked operator's current
  access token's own short remaining TTL — a stateless JWT cannot be force-expired early, the
  same accepted limitation ADR-0005 already documents for license-lapse enforcement.
- Non-operator refresh tokens (`sessionExpiresAt: null`) pass through the new ceiling check as a
  pure no-op — zero behavior change for registration/password-login/secret-key-login-issued
  tokens.

## Data migration

N/A. This TDD adds no new columns or tables — it builds business logic and endpoints on top of
`OperatorSchedule`, `OperatorTimeOff`, and `RefreshToken.sessionExpiresAt`, all of which
`docs/tdd/operator-login-and-confirmation.md`'s migration already creates.

## Test plan

- **Unit:**
  - `RefreshTokenService.rotate()` ceiling-before-reuse-detection ordering, specifically (this
    is correctness-critical per ADR-0013, not just another branch to cover): a token presented
    at or after its `sessionExpiresAt` is classified as `session_ceiling_reached` and the family
    is revoked as a clean session-end; a **subsequent retry of the same now-revoked token** is
    still classified as `session_ceiling_reached`, **not** as reused/stolen — asserting the
    ceiling check, not the reuse-detection check, is what catches it on the second call too (the
    scenario ADR-0013's ordering requirement exists specifically to prevent misclassifying).
  - `RefreshTokenService.rotate()` on a valid operator token well before its ceiling — rotates
    normally, copies `sessionExpiresAt` forward unchanged (not recomputed) onto the new row.
  - `TokenService.signAccessToken()` on a rotation close to the ceiling — `exp` clamps to
    `sessionExpiresAt` rather than `now + <normal TTL>`.
  - `RefreshTokenService.revokeAllForUser` — revokes every currently-unrevoked token for that
    user, leaving already-revoked/other users' rows untouched.
  - `OperatorAvailabilityService.getShiftEndOrFallback` recomputation behavior, exercised now
    that a real schedule can be written: after `PUT .../schedule` changes an operator's
    today's-row `endTime`, a subsequent `getShiftEndOrFallback` call reflects the new value
    immediately (no caching) — the concrete mechanism behind the mid-window-schedule-edit edge
    case above.
  - `OperatorScheduleService.replaceSchedule` — rejects a duplicate `dayOfWeek` in the input
    array and any `startTime >= endTime` entry with `400`, before touching the database;
    `{days: []}` deletes all existing rows and inserts none.
- **Integration:**
  - `GET /auth/admin/operators`, `GET .../:id` — scoped to the caller's own `platformId`;
    another platform's operator id → `404`.
  - `PATCH .../:id/contact` — success (`200`); neither/both of `email`/`phone` (`400`);
    duplicate (`409`).
  - `POST .../:id/block` → `.../unblock` — block sets `isActive: false`, deletes unconsumed
    codes of both `purpose`s, revokes all of that operator's refresh tokens (a subsequent
    `POST /auth/refresh` with one of them now fails); unblock sets `isActive: true` and a fresh
    `request-code`/`verify-code` cycle succeeds again; either call on a non-owner-scoped `:id`
    → `404`.
  - `PUT .../:id/schedule` — full replace (`200`, old rows gone, new rows present); duplicate
    `dayOfWeek` or invalid time range (`400`); `{days: []}` reverts to fail-open, verified via a
    subsequent `request-code` call succeeding on any day.
  - `GET .../:id/schedule` called by the operator's own (hypothetical) token, if one could be
    minted, or by a non-owner caller → `403`/`404`.
  - `POST .../:id/time-off` / `GET` / `DELETE` — create (`201`), duplicate date (`409`), list,
    delete (`204`), delete a mismatched id (`404`).
  - `POST /auth/refresh` with an operator-issued token at/after its `sessionExpiresAt` →
    `401 {reason: "session_ceiling_reached"}`; well before it → `200` with a new pair carrying
    the same `sessionExpiresAt`.
- **E2E:** not part of this project's test setup yet — none planned, consistent with
  `docs/tdd/auth-core-flow.md`'s and `docs/tdd/operator-login-and-confirmation.md`'s existing
  precedent.

## Rollout

N/A / straightforward. No production data or other in-repo consumer of these endpoints exists
yet, so there's no backwards-compatibility surface to protect and no feature flag needed. No new
migration is required (see Data migration). The only real rollout constraint is ordering:
`docs/tdd/operator-login-and-confirmation.md` must already be deployed, since this TDD builds
directly on the tables, columns, and shared plumbing it creates.
