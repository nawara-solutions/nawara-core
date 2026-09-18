# operator-tier login: registration, calendar, request-code/verify-code, two-phase confirmation

- **Status:** Draft <!-- Draft | Reviewed | Implemented -->
- **Author:** Anwar (project owner)
- **Related SDD:** [docs/sdd/auth-service.md](../sdd/auth-service.md)
- **Related ADRs:** [0009](../adr/0009-platform-scoped-admin-accounts.md) (platform-scoped Admin
  accounts — the `JwtPayload` `platformId`/`adminTier` claims this TDD reuses, unchanged, from
  `admin-owner-secret-key.md`, originate here), [0011](../adr/0011-operator-time-boxed-login-code.md)
  (time-boxed operator login code with business-day gating), [0012](../adr/0012-owner-managed-operator-schedule-and-blocking.md)
  (owner-managed operator schedule and blocking — replaces `request-code`'s direct
  `PlatformCalendarService.isWorkingDay` call with `OperatorAvailabilityService.
  isOperatorAvailable`, per Approach), [0013](../adr/0013-operator-session-ceiling.md) (operator
  session ceiling — the `sessionExpiresAt`/clamping logic this TDD builds on the issuance side, per
  Approach), [0014](../adr/0014-schedule-anchored-operator-duration.md)
  (schedule-anchored operator login-code and session duration — supersedes ADR-0011's flat
  `issuedAt + 8h` login-code-expiry formula **in value only**; per this repo's ADR-immutability
  convention (`docs/adr/README.md`), ADR-0011's own text is left completely unmodified, so this
  TDD implements the login-code `expiresAt` computation exactly as ADR-0014 documents it, not as
  ADR-0011's original text still literally reads — ADR-0014 alone is the record of what
  superseded what), [0015](../adr/0015-two-phase-operator-contact-confirmation.md) (two-phase
  operator contact confirmation before first login)
- **Ticket/issue:** https://github.com/nawara-solutions/nawara-core/issues/14

> **Superseded in part — read with the ADRs below.** Codes are now stored as `HMAC-SHA-256(pepper, operatorId ‖ purpose ‖ code)` (64-hex), not a bare SHA-256, and issuing a code supersedes rather than deletes the previous one; the database also refuses to record a code as consumed after it expired or was locked out, and forces operator sessions to carry a ceiling no refresh token can exceed (migration `0002`, ADR-0024/0025).

## Problem

`auth-service`'s core credential flow (register/login/refresh/logout/me, per
`docs/tdd/auth-core-flow.md`) exists, but nothing platform-scoped-Admin-specific has been built
yet. This TDD implements the operator-tier login surface as already fully designed in
`docs/sdd/auth-service.md`: `POST /auth/admin/operators` (an owner creating an operator account),
the platform working-day calendar management endpoints, the two-call
`POST /auth/admin/login/operator/request-code` / `POST /auth/admin/login/operator/verify-code`
login exchange, and the two-phase contact-confirmation step (`POST /auth/admin/operators/confirm`)
an operator must complete before their first ordinary login code is ever sent. As with
`docs/tdd/auth-core-flow.md`, this TDD sequences already-complete design into working code; it
does not design anything new.

Out of scope for this TDD, tracked separately: the owner's permanent secret-key login and
rotation (ADR-0010, including the `AdminDevice` new-device-alerting check), which is
`docs/tdd/admin-owner-secret-key.md`'s scope — that TDD exists, and this one **depends on it
having shipped first**: an owner must already be able to log in (secret-key, or the existing
`POST /auth/login` per its bootstrap-flow note) before they can call
`POST /auth/admin/operators` (Bearer-gated to `adminTier: 'owner'`) to create an operator in the
first place, so this TDD is architecturally downstream of it, not the other way around — see
Approach. Also out of scope: the owner-facing operator-management surface (profile view/update,
`OperatorSchedule`/`OperatorTimeOff` CRUD, block/unblock, and the operator session ceiling),
which is `docs/tdd/operator-administration.md`'s scope (ADR-0012/ADR-0013/ADR-0014). Also out of
scope: actually publishing any of this feature's `admin.*` events to RabbitMQ — per the ADD's
"Infrastructure gap" note, no broker, exchange/queue convention, or client library exists
anywhere in this repo yet, the same gap `docs/tdd/auth-core-flow.md` already deferred `user.
registered` behind.

## Approach

**Build-sequencing note, stated explicitly since it isn't obvious from the SDD's class diagram
alone:** `JwtPayload`'s `platformId`/`adminTier` claims, `AuthService.login`/`refresh`'s payload
construction extending to include them, `AdminTierGuard`, and `admin.module.ts` are **already
built by `docs/tdd/admin-owner-secret-key.md` (issue #13)** — that TDD is architecturally first,
since an owner must already be able to authenticate as `adminTier: 'owner'` before they can call
this TDD's `POST /auth/admin/operators`. This TDD reuses all four unchanged; it does not rebuild
any of them (see Files/components affected). What this TDD does still build itself, as genuine
new shared plumbing that `docs/tdd/operator-administration.md` (this service's next TDD, scoped
to ADR-0012/ADR-0013) will also depend on:

- `RefreshTokenService.issue()`'s optional `sessionExpiresAt` parameter and
  `TokenService.signAccessToken()`'s optional `sessionExpiresAt` parameter (with its
  `exp = min(now + <normal TTL>, sessionExpiresAt)` clamping, per ADR-0013) are both built here,
  because this TDD's `verify-code` endpoint is the first, and only, caller in this TDD that ever
  passes a non-null value — `docs/sdd/auth-service.md`'s flow (l) stamps `sessionExpiresAt` at
  verify-code success, and that stamping has to exist for verify-code to be a complete,
  shippable endpoint. `docs/tdd/operator-administration.md` (ADR-0013) does **not** rebuild
  either method; it adds the *enforcement* side — the ceiling check inside
  `RefreshTokenService.rotate()` — reusing the column/parameters this TDD adds. `RefreshToken.
  sessionExpiresAt` itself (the column) is therefore also added by this TDD's migration.
- `OperatorAvailabilityService` (`isOperatorAvailable`, `getShiftEndOrFallback`) and the
  `OperatorSchedule`/`OperatorTimeOff` entities it reads are built here too, minimally, because
  `request-code`/`verify-code` cannot function without them (ADR-0012 already replaced
  `request-code`'s direct `PlatformCalendarService.isWorkingDay` call with
  `OperatorAvailabilityService.isOperatorAvailable`, and ADR-0014's `getShiftEndOrFallback` is
  what computes both the login code's `expiresAt` and the session's `sessionExpiresAt`). Neither
  entity gets a write endpoint in this TDD — `docs/tdd/operator-administration.md` owns
  `PUT /auth/admin/operators/:id/schedule` and the time-off CRUD endpoints, built on top of these
  same tables. Until that TDD ships, both tables stay empty for every operator, so
  `isOperatorAvailable`/`getShiftEndOrFallback` only ever exercise their fail-open branches in
  this TDD's own integration tests — the non-empty-schedule branches are covered here only by
  unit tests that insert rows directly via the repository, bypassing the (not-yet-built) CRUD
  endpoints.
- `AdminTierGuard` (already built by `admin-owner-secret-key.md`, reused unchanged here — not
  rebuilt) gates most of this TDD's Bearer-authenticated routes to `adminTier: 'owner'` exactly;
  `GET /auth/admin/platform/calendar` requires only `role: 'admin'` (either tier), per the SDD's
  "Bearer, any admin" contract — the same guard checks tier only when a route declares one, so a
  second guard isn't needed purely for that one case.

Implementation order:

1. **Data model.** `platformId`/`adminTier`/`secretKeyHash`/`secretKeyIssuedAt` are already added
   to the `User` entity by `admin-owner-secret-key.md` — not touched again here (coordinate build
   order so only one migration adds them). This TDD's own additions to `User` (extending the
   entity `docs/tdd/auth-core-flow.md` created): `phone` (nullable, unique) and
   `contactVerifiedAt` (nullable); and relax `email`/`passwordHash` to nullable (an operator has
   no password and may be phone-only, per ADR-0009).
   Add `RefreshToken.sessionExpiresAt` (nullable). Add four new entities/tables:
   `AdminOperatorCode`, `PlatformNonWorkingDay`, `OperatorSchedule`, `OperatorTimeOff` (the last
   two per the "build-sequencing note" above — tables only, no write endpoints yet).
2. **Session-plumbing extensions.** `JwtPayload`, `AuthService.login`/`refresh`'s payload
   construction, and `AdminTierGuard` are not built by this step — already done by
   `docs/tdd/admin-owner-secret-key.md`, reused unchanged. This step extracts the
   family-revocation logic `docs/tdd/auth-core-flow.md`'s `rotate()` already performs inline on a
   reused token into a named `RefreshTokenService.revokeFamily(familyId)` method (per the SDD's
   class diagram), so this TDD's own ceiling-adjacent code paths and
   `docs/tdd/operator-administration.md`'s later ceiling check can both call it; and adds
   `RefreshTokenService.issue()`'s and `TokenService.signAccessToken()`'s optional
   `sessionExpiresAt` parameters.
3. **`UsersModule` extension.** `UsersService.findByEmailOrPhone(email?, phone?, adminTier?,
   isActive?, contactVerifiedAt?)`; extend `UsersService.create(...)` to accept `phone`,
   `platformId`, `adminTier`, `contactVerifiedAt` (all optional, per the SDD's class diagram
   signature).
4. **`OperatorAvailabilityService`** (`isOperatorAvailable`, `getShiftEndOrFallback`) and
   **`PlatformCalendarService`** (`isWorkingDay`, `create`, `list`, `delete`).
5. **`OperatorCodeService`** (`requestCode`, `verifyCode`, `sendConfirmationCode`,
   `confirmContact`, private `generateCode`/`hash`).
6. **`AdminAuthController`** — this TDD implements its `registerOperator`,
   `confirmOperatorContact`, `requestOperatorCode`, `verifyOperatorCode`,
   `createNonWorkingDay`, `listNonWorkingDays`, `deleteNonWorkingDay` methods only;
   `secretKeyLogin`/`rotateSecretKey` are left undeclared until ADR-0010 gets its own TDD — plus
   the DTOs each of those methods needs.
7. Wire the new `AdminModule` (`AdminAuthController`, `OperatorCodeService`,
   `PlatformCalendarService`, `OperatorAvailabilityService`, `AdminTierGuard`) into `AppModule`,
   alongside the existing `AuthModule`/`UsersModule`/token handling.

Business logic per endpoint, taken directly from the SDD's API contract and flows (j), (k), (l),
(o) — no new behavior invented here:

- **`POST /auth/admin/operators`** (SDD flow (j)): Bearer, `adminTier: 'owner'` only. `{email?,
  phone?}` — exactly one required (`400` otherwise), `409` on duplicate. `platformId` taken from
  the caller's own JWT claim, never the body. Creates a `User` row (`role: 'admin'`,
  `adminTier: 'operator'`, `passwordHash: null`, `contactVerifiedAt: null`). Then generates and
  stores a `purpose: 'confirmation'` `AdminOperatorCode` with a flat `now + 8h` expiry,
  unconditionally (per ADR-0015 — issued outside the `isOperatorAvailable` gate a shift end
  could anchor to). `201 {id, email?, phone?, platformId, adminTier}`.
- **`POST /auth/admin/operators/confirm`** (SDD flow (o), new per ADR-0015): public, no auth.
  `{email?, phone?, code}` — `400` if neither/both of `email`/`phone`, or `code`, is missing.
  Unknown identifier or blocked operator (`isActive: false`) → generic `401`. Already-confirmed
  operator (`contactVerifiedAt` non-null) → idempotent `204`, **without validating `code` at
  all**. Otherwise, validates `code` against the operator's live `purpose: 'confirmation'` row
  with the same matching/lockout logic `verify-code` uses (hash comparison in application code,
  `attemptCount` increment on a wrong guess, permanent invalidation at 5 attempts); wrong/
  expired/exhausted/no-row → generic `401`. On a match: marks the row consumed, sets
  `contactVerifiedAt = now`, then internally calls `requestCode()` directly (the same code path
  a self-triggered call would hit, gated by the same `isOperatorAvailable` check) — sending the
  operator's real first `purpose: 'login'` code if they're currently available, or nothing if
  not. `204` in both sub-cases.
- **`POST /auth/admin/login/operator/request-code`** (SDD flow (k)): public, no auth. `{email?,
  phone?}` — `400` if neither or both given. Lookup requires `adminTier: 'operator' AND
  isActive: true AND contactVerifiedAt IS NOT NULL`, checked **before** the availability check —
  not found (unknown identifier, blocked operator, or not-yet-confirmed operator, all
  indistinguishable here) → generic `401`. Found → `OperatorAvailabilityService.
  isOperatorAvailable(operator.id, now)`; `false` (platform calendar, operator's own time off,
  or operator's own schedule — all three collapse to the same outcome) → `403 {reason:
  "non_working_day", message: "You're outside your scheduled login window. Try again during
  your next scheduled shift."}`, no code generated. `true` → generate a 6-digit
  `purpose: 'login'` code, `expiresAt = OperatorAvailabilityService.getShiftEndOrFallback(
  operator.id, issuedAt)` (per ADR-0014 — the operator's own scheduled shift end, or
  `issuedAt + 8h` only if unscheduled), delete any previous unconsumed `purpose: 'login'` row
  for that operator first (scoped by `(userId, purpose)` per ADR-0015 — a live
  `purpose: 'confirmation'` row is untouched), `204`.
- **`POST /auth/admin/login/operator/verify-code`** (SDD flow (l)): public, no auth. `{email?,
  phone?, code}`. Looked up by identifier alone (`adminTier: 'operator' AND isActive: true AND
  contactVerifiedAt IS NOT NULL`, `purpose: 'login'`, unconsumed, unexpired, `attemptCount < 5`)
  — `codeHash` is **not** part of the lookup `WHERE` clause; it's compared in application code
  afterward, so a wrong guess still yields a row whose `attemptCount` can be incremented. No
  matching row → generic `401`, `attemptCount` **not** incremented (it isn't a wrong-code
  guess). Row found, hash mismatch → increment `attemptCount`, `401`. Match → mark consumed;
  compute `sessionExpiresAt = OperatorAvailabilityService.getShiftEndOrFallback(operator.id,
  now)` — a **fresh, independent** call, not reused from the request-code-time value (per
  ADR-0014); `RefreshTokenService.issue(userId, sessionExpiresAt)`;
  `TokenService.signAccessToken(payload, sessionExpiresAt)` (`exp = min(now + <normal TTL>,
  sessionExpiresAt)`); `200 {accessToken, refreshToken, expiresIn}`.
- **`POST /auth/admin/platform/calendar`**: Bearer, `adminTier: 'owner'` only. `{type, date?,
  dayOfWeek?, label?}` — `date` required iff `type = 'holiday'`, `dayOfWeek` required iff
  `type = 'weekly_weekend'`, `400` otherwise. `platformId` from the caller's own JWT claim.
  `201 {id, platformId, type, date?, dayOfWeek?, label, createdAt}`.
- **`GET /auth/admin/platform/calendar`**: Bearer, any admin (either tier). Scoped to the
  caller's own `platformId`. `200 [...]`.
- **`DELETE /auth/admin/platform/calendar/:id`**: Bearer, `adminTier: 'owner'` only. `204`;
  `404` (never `403`) if the row isn't the caller's own platform's.

## Files/components affected

- `apps/auth-service/src/users/user.entity.ts` — modified. Adds `phone`, `contactVerifiedAt`;
  relaxes `email`/`passwordHash` to nullable. (`platformId`/`adminTier`/`secretKeyHash`/
  `secretKeyIssuedAt` are already added by `admin-owner-secret-key.md` — not touched again here.)
- `apps/auth-service/src/users/users.service.ts` — modified. Adds `findByEmailOrPhone`; extends
  `create`.
- `apps/auth-service/src/auth/entities/refresh-token.entity.ts` — modified. Adds
  `sessionExpiresAt`.
- `apps/auth-service/src/auth/jwt-payload.interface.ts` — not touched — already built by
  `admin-owner-secret-key.md`, reused here unchanged.
- `apps/auth-service/src/auth/token.service.ts` — modified. `signAccessToken` gains the
  optional `sessionExpiresAt` parameter and its clamping logic.
- `apps/auth-service/src/auth/refresh-token.service.ts` — modified. `issue` gains the optional
  `sessionExpiresAt` parameter; extracts `revokeFamily(familyId)` as a named method.
- `apps/auth-service/src/auth/auth.service.ts` — not touched — already built by
  `admin-owner-secret-key.md`, reused here unchanged.
- `apps/auth-service/src/admin/admin-tier.guard.ts` — not touched — already built by
  `admin-owner-secret-key.md`, reused here unchanged.
- `apps/auth-service/src/admin/entities/admin-operator-code.entity.ts` — new.
  `AdminOperatorCode` TypeORM entity.
- `apps/auth-service/src/admin/entities/platform-non-working-day.entity.ts` — new.
  `PlatformNonWorkingDay` TypeORM entity.
- `apps/auth-service/src/admin/entities/operator-schedule.entity.ts` — new. `OperatorSchedule`
  TypeORM entity (table only in this TDD — see Approach).
- `apps/auth-service/src/admin/entities/operator-time-off.entity.ts` — new. `OperatorTimeOff`
  TypeORM entity (table only in this TDD — see Approach).
- `apps/auth-service/src/admin/operator-availability.service.ts` — new.
  `OperatorAvailabilityService`: `isOperatorAvailable`, `getShiftEndOrFallback`.
- `apps/auth-service/src/admin/platform-calendar.service.ts` — new. `PlatformCalendarService`:
  `isWorkingDay`, `create`, `list`, `delete`.
- `apps/auth-service/src/admin/operator-code.service.ts` — new. `OperatorCodeService`:
  `requestCode`, `verifyCode`, `sendConfirmationCode`, `confirmContact`, `generateCode`/`hash`
  (private).
- `apps/auth-service/src/admin/admin-auth.controller.ts` — new. `registerOperator`,
  `confirmOperatorContact`, `requestOperatorCode`, `verifyOperatorCode`, `createNonWorkingDay`,
  `listNonWorkingDays`, `deleteNonWorkingDay`.
- `apps/auth-service/src/admin/dto/register-operator.dto.ts` — new. `{email?, phone?}`.
- `apps/auth-service/src/admin/dto/confirm-operator-contact.dto.ts` — new. `{email?, phone?,
  code}`.
- `apps/auth-service/src/admin/dto/request-operator-code.dto.ts` — new. `{email?, phone?}`.
- `apps/auth-service/src/admin/dto/verify-operator-code.dto.ts` — new. `{email?, phone?, code}`.
- `apps/auth-service/src/admin/dto/platform-non-working-day.dto.ts` — new. `{type, date?,
  dayOfWeek?, label?}`.
- `apps/auth-service/src/admin/admin.module.ts` — modified — already created by
  `admin-owner-secret-key.md`/`devices-module.md`; this TDD adds `OperatorCodeService`/
  `PlatformCalendarService`/`OperatorAvailabilityService` and the operator-facing
  `AdminAuthController` methods to that same module.
- `apps/auth-service/src/app.module.ts` — modified. Imports `AdminModule`.
- `apps/auth-service/src/migrations/` — new. Migration(s) for the `User` column additions,
  `RefreshToken.sessionExpiresAt`, and the four new tables.

## Edge cases

Pulled from the SDD's "Error handling & edge cases" section and flows (j)/(k)/(l)/(o), scoped to
this TDD's endpoints — no new cases invented:

- Neither or both of `email`/`phone` on `POST /auth/admin/operators`,
  `POST /auth/admin/login/operator/request-code`, `.../verify-code`, or
  `POST /auth/admin/operators/confirm` → `400`.
- Duplicate `email`/`phone` on operator creation → `409`.
- `POST /auth/admin/operators`/calendar-write endpoints called by a non-owner admin (or a
  non-admin) → `403`, via `AdminTierGuard`.
- **Accepted enumeration side channel on `request-code`** (per ADR-0011/ADR-0012/ADR-0015, not
  re-litigated here): because the not-found check runs before the availability check, only a
  valid, active, contact-confirmed operator identifier can ever produce a `403 non_working_day`
  response — an unknown, blocked, or not-yet-confirmed identifier always gets a generic `401`
  regardless of the day. Implemented exactly as designed, not re-engineered around.
- **Accepted enumeration side channel on `confirm`** (per ADR-0015, same spirit as the above):
  because the idempotent-`204` branch doesn't depend on the submitted `code` being correct while
  the real-validation branch does, a caller submitting a deliberately wrong code can distinguish
  "already-confirmed operator" (`204`) from "unconfirmed or unknown" (`401`). Implemented exactly
  as designed, not re-engineered around.
- `verify-code` with no matching row (unknown identifier, blocked/unconfirmed operator, or no
  live code) → generic `401`, `attemptCount` **not** incremented.
- `verify-code`/`confirm` with a wrong-but-otherwise-matching code → `401`, `attemptCount`
  incremented; at `attemptCount = 5` the code is permanently invalidated even against a
  subsequently correct guess, forcing a fresh request.
- **Accepted short-window-near-shift-end case (per ADR-0014):** an operator who calls
  `request-code` moments before their scheduled shift ends gets a very short remaining
  redemption window and, if `verify-code` succeeds in time, an equally short session — a direct,
  accepted consequence of anchoring to the operator's actual shift rather than a flat duration.
  Not mitigated here.
- `PlatformNonWorkingDay`/`OperatorSchedule`/`OperatorTimeOff` with zero configured rows are
  **fail-open** — every day/hour counts as available — per ADR-0011/ADR-0012. Since this TDD
  ships no write endpoint for the latter two, this is the only reachable branch for them in
  integration tests until `docs/tdd/operator-administration.md` ships.
- `POST /auth/admin/platform/calendar` with `type = 'holiday'` and no `date` (or
  `type = 'weekly_weekend'` and no `dayOfWeek`) → `400`.
- `DELETE /auth/admin/platform/calendar/:id` for a row belonging to a different platform →
  `404`, never `403`.
- `isWorkingDay`'s and `OperatorAvailabilityService`'s notion of "today"/"now" is evaluated as
  **UTC server-date** — the formalized v1 decision per the ADD's/SDD's resolved Open questions,
  not merely a recommendation. No per-platform/per-operator timezone field exists.
- Phone-registered operator's `admin.operator_code_issued`/`admin.operator_confirmation_code_
  issued` events have no real delivery mechanism yet: the SMS gateway *provider* is now named
  (Twilio, per ADR-0019), but `notification-service`'s actual integration remains completely
  undesigned. Separately, RabbitMQ infra itself now exists for local dev (per ADR-0018), but
  this TDD's own code isn't implemented yet, so neither event is actually published anywhere
  until this TDD is built — at that point it publishes through `EventsPublisherService`, not a
  stub. Flagged, not solved here.

## Data migration

New migration(s) under `apps/auth-service/src/migrations/`, additive only — no existing rows to
backfill (`auth-service` has no production data yet):

- Alter `user`: add `phone` (nullable, unique), `contact_verified_at` (nullable); alter
  `email`/`password_hash` to nullable. (`platform_id`/`admin_tier`/`secret_key_hash`/
  `secret_key_issued_at` are already added by `admin-owner-secret-key.md`'s migration — not
  duplicated here; coordinate build order so only one migration adds them.)
- Alter `refresh_token`: add `session_expires_at` (nullable).
- Create `admin_operator_code`, `platform_non_working_day`, `operator_schedule`,
  `operator_time_off` tables, per the SDD's data model.

## Test plan

- **Unit:**
  - `PlatformCalendarService.isWorkingDay` — a platform with zero configured rows is
    fail-open (always `true`); a matching `holiday` row or `weekly_weekend` `dayOfWeek` row
    returns `false`; a non-matching row returns `true`; evaluated against UTC server-date.
  - `OperatorAvailabilityService.isOperatorAvailable` — platform-wide non-working day wins
    first regardless of the operator's own schedule; an `OperatorTimeOff` match returns
    unavailable; zero `OperatorSchedule` rows is fail-open; a configured schedule acts as an
    exhaustive whitelist (no row for today's `dayOfWeek`, or `now` outside `[startTime,
    endTime)`, is unavailable).
  - `OperatorAvailabilityService.getShiftEndOrFallback` — zero schedule rows returns
    `now + 8h`; a configured schedule returns today's row's `endTime` combined with today's
    date; called twice (simulating request-code then verify-code) with no schedule change in
    between returns the same value.
  - `OperatorCodeService` code hashing/lockout — a generated code hashes and matches on
    `verifyCode`/`confirmContact`; a wrong code increments `attemptCount` without marking the
    row consumed; a 5th wrong attempt permanently invalidates the row even against a
    subsequently correct code; a no-row-found case never increments any `attemptCount`;
    requesting a new code deletes only the previous unconsumed row of the **same**
    `(userId, purpose)`, leaving the other purpose's live row untouched.
  - `TokenService.signAccessToken` with a `sessionExpiresAt` far in the future signs
    `exp = now + <normal TTL>`; with a `sessionExpiresAt` sooner than the normal TTL signs
    `exp = sessionExpiresAt`; omitted `sessionExpiresAt` is unchanged from
    `docs/tdd/auth-core-flow.md`'s existing behavior.
  - `RefreshTokenService.issue` with a `sessionExpiresAt` persists it on the new row; omitted
    is `null`, unchanged from existing non-operator paths.
- **Integration** (using the stub `PaymentServiceClient` where a payload happens to touch
  license/subscription checks, though none of this TDD's endpoints exercise them directly):
  - `POST /auth/admin/operators` — success (`201`, `contactVerifiedAt: null`, a
    `purpose: 'confirmation'` `AdminOperatorCode` row created with `now + 8h` expiry); neither/
    both of `email`/`phone` (`400`); duplicate (`409`); called by an operator or unauthenticated
    caller (`403`/`401`).
  - `POST /auth/admin/operators/confirm` — full flow: create an operator, confirm with the
    right code (`204`, `contactVerifiedAt` set, a `purpose: 'login'` code issued if the operator
    is available at that moment); wrong code (`401`, `attemptCount` incremented); already-
    confirmed retried with any code (`204`, no validation); unknown/blocked identifier (`401`).
  - `POST /auth/admin/login/operator/request-code` → `.../verify-code` — full round trip on a
    working day for a confirmed, unblocked operator (`204` then `200` with a token pair whose
    refresh token carries `sessionExpiresAt`); the same round trip attempted on a
    `PlatformNonWorkingDay` (`403 non_working_day`, no code issued); an unconfirmed operator's
    `request-code` call (`401`, indistinguishable from unknown); a wrong code on `verify-code`
    (`401`, `attemptCount` incremented, a subsequent correct code still works until the 5th
    attempt); 5 wrong attempts followed by the correct code (`401`, permanently invalidated).
  - `POST /auth/admin/platform/calendar` / `GET` / `DELETE` — create as owner (`201`); missing
    required field for the given `type` (`400`); list scoped to the caller's own `platformId`
    read by either tier (`200`); delete another platform's row (`404`); delete as owner (`204`,
    subsequently absent from `GET`).
- **E2E:** not part of this project's test setup yet — none planned, per
  `docs/tdd/auth-core-flow.md`'s existing precedent.

## Rollout

N/A / straightforward. `auth-service` has no production data or other in-repo consumer of these
endpoints yet, so there's no backwards-compatibility surface to protect and no feature flag
needed. The one operational prerequisite is running this TDD's migration (additive only) before
deploy, after `docs/tdd/auth-core-flow.md`'s initial migration. This TDD itself depends on
`docs/tdd/admin-owner-secret-key.md` having shipped first, alongside `docs/tdd/auth-core-flow.md`
— it reuses that TDD's `JwtPayload` claims, `AuthService.login`/`refresh` payload extension,
`AdminTierGuard`, and `admin.module.ts` unchanged, rather than rebuilding any of them (see
Approach/Files affected). `docs/tdd/operator-administration.md` (the owner-facing
schedule/time-off/block-unblock surface, and the session-ceiling enforcement in
`RefreshTokenService.rotate()`) in turn depends on this TDD having shipped first — it reuses this
TDD's `OperatorSchedule`/`OperatorTimeOff` tables and `RefreshToken.sessionExpiresAt` column
rather than rebuilding them.
