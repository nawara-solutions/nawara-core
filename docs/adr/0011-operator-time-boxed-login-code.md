# 0011. Time-boxed operator login code with business-day gating

- **Status:** Accepted
- **Date:** 2026-09-16
- **Deciders:** Anwar (project owner)

## Context

Per ADR-0009, a platform's owner (`adminTier: "owner"`) needs to delegate day-to-day admin
work — handling licenses, reviewing cash payments per ADR-0007, and similar tasks — to staff
(`adminTier: "operator"`) without giving each of them a standing password to manage,
remember, or have compromised. The business need additionally restricts this delegation to
actual working hours: operators should only be able to obtain access on the platform's
working days, not on weekends or holidays.

Nothing in this repo today models a time-boxed, single-use login credential (as distinct
from ADR-0002's longer-lived refresh tokens), nor any notion of a business day, holiday, or
weekend — `auth-service` has no calendar concept of any kind.

## Options considered

1. **A single endpoint handling both "request" and "verify," branching on whether a `code`
   field is present in the body** — fewer routes overall. Rejected: it overloads one route's
   meaning ambiguously (its behavior, and what a given response even means, depends on which
   optional field happened to be supplied), which breaks the "a request either succeeds or
   tells you why" clarity every other endpoint in this design has, and diverges from this
   repo's own existing two-call precedent for a similar preview/act split
   (`POST /auth/organizations/validate` followed by `POST /auth/register`).
2. **A manually-triggered "send me a code" action, separate from the login attempt itself**
   — an explicit button/action before the actual login call. Rejected: not what was asked
   for. The requirement is that an operator gets their code automatically "each time he
   arrives," with no extra step in between.
3. **The login attempt itself is what triggers sending the code; a second call completes
   verification (chosen).** `POST /auth/admin/login/operator/request-code` is both "attempt
   to log in" and "trigger a code," and `POST /auth/admin/login/operator/verify-code`
   completes the exchange — two calls, each with one unambiguous responsibility, matching
   this repo's existing two-call precedent.

## Decision

We chose **Option 3**. Concretely:

- New endpoint **`POST /auth/admin/operators`** — Bearer-authenticated, `adminTier: owner`
  only (via the `AdminTierGuard` introduced in ADR-0010). Body `{email?, phone?}` — exactly
  one required, `400` otherwise; `409` on duplicate. Creates a `User` row with
  `role: 'admin'`, `adminTier: 'operator'`, and `platformId` taken from the **caller's own**
  JWT claim — never accepted in the request body. This is the same defense-in-depth pattern
  ADR-0007 already applies to `organizationId` on `POST /payment/charges/cash` ("never trust
  a body-supplied tenant/scope id when the caller's own claim already says which scope they
  act for"): it prevents an owner registering an operator onto a platform that isn't theirs,
  even if the request body were tampered with. Publishes
  `admin.operator_registered = {operatorId, platformId, ownerId, channel: "email"|"phone",
  timestamp}` — a minor addition letting `notification-service` send a welcome message.
- New **`AdminOperatorCode`** entity: `{id, userId FK -> User (the operator), codeHash
  (SHA-256 of a 6-digit numeric code), expiresAt (issuedAt + 8h), attemptCount (default 0),
  consumedAt, createdAt}`. Requesting a new code invalidates any previous unconsumed code for
  that operator — only the most recently issued code is ever valid, the same "old one is
  fully superseded" rule ADR-0010 uses for secret-key rotation. A 6-digit code is low-entropy
  relative to an 8-hour validity window, so a companion control is necessary, not optional:
  5 failed `verify-code` attempts permanently invalidate that code, forcing a fresh
  `request-code` call rather than leaving an 8-hour window open to continued guessing.
- New, deliberately minimal, generic business-day model — kept this small so `auth-service`
  stays culture/region-agnostic, exactly the same way it already stays app-agnostic for
  `organizationId`/`platformId`: no calendar library dependency, and no hardcoded weekend
  convention (e.g. assuming Saturday/Sunday, which doesn't hold everywhere).
  `PlatformNonWorkingDay {id, platformId, type: "holiday" | "weekly_weekend", date (required
  iff type='holiday'), dayOfWeek 0-6 Sun-Sat (required iff type='weekly_weekend'), label,
  createdAt}`. `isWorkingDay(platformId, date)` checks both row types for that platform. A
  platform with zero configured rows is **fail-open** — every day counts as a working day.
  This is deliberate: an owner who hasn't bothered to configure a calendar yet shouldn't have
  their operators silently locked out by a default they never opted into.
- New calendar-management endpoints, Bearer-authenticated; writes require
  `adminTier: owner` (via `AdminTierGuard`), reads are allowed for any admin scoped to that
  platform:
  - `POST /auth/admin/platform/calendar` — body `{type, date?, dayOfWeek?, label?}`.
  - `GET /auth/admin/platform/calendar` — scoped to the caller's own `platformId`.
  - `DELETE /auth/admin/platform/calendar/:id` — `404` if the row doesn't belong to the
    caller's own platform.
- New endpoint **`POST /auth/admin/login/operator/request-code`** — no authentication
  required. Body `{email?, phone?}`. Flow, precisely, in order:
  1. Validate the DTO — `400` if neither or both of `email`/`phone` are given.
  2. Look up `User WHERE (email = :email OR phone = :phone) AND adminTier = 'operator'` —
     not found → generic `401`. This check runs **before** the business-day check,
     deliberately, so a non-working-day response can never be used to distinguish "a valid
     operator identifier" from "an unknown one" via a different status code.
  3. If found, evaluate `isWorkingDay(operator.platformId, today)`:
     - `false` → `403 {reason: "non_working_day", message: "Codes aren't issued on weekends
       or holidays. Try again on the next business day."}`. No code is generated, no event
       is published.
     - `true` → generate a 6-digit code, store the `AdminOperatorCode` row, publish
       `admin.operator_code_issued = {userId, platformId, channel: "email"|"sms",
       destination, code, expiresAt, timestamp}`, and return `204` — the code itself never
       appears in the response body, only in the published event/notification channel.

  This endpoint *is* the trigger the business need describes — an operator "arriving" and
  attempting to log in is itself what sends the code; there is no separate, manual
  "send me a code" action anywhere in this design (see Options considered, option 2).
- New endpoint **`POST /auth/admin/login/operator/verify-code`** — no authentication
  required. Body `{email?, phone?, code}`. Validates the code against `AdminOperatorCode`
  (matching hash, unexpired, unconsumed, `attemptCount < 5`); on success, marks it consumed
  and returns `200 {accessToken, refreshToken, expiresIn}`; on any failure, increments
  `attemptCount` and returns a generic `401`. Once `attemptCount` reaches 5, the code is
  permanently invalidated even against a subsequently-correct guess, forcing a fresh
  `request-code` call.

**Prominent departure from existing event shape:** like ADR-0010's
`admin.secret_key_login_from_new_device`, `admin.operator_code_issued` carries
`destination`/`channel`/`code` inline — a deliberate deviation from `user.registered`'s
contact-info-free shape, for the same reason: per this repo's database-per-service
principle, only `auth-service` owns `User.email`/`User.phone`, `notification-service` has no
independent way to resolve a `userId` to a contact address, and this delivery is
time-critical (the code is only valid for 8 hours and is the operator's sole means of
logging in).

## Consequences

- Operators can be delegated admin access without ever holding a password, restricted to
  the platform's own configured working days, with no calendar-library dependency and no
  hardcoded regional convention baked into `auth-service`.
- A small, explicitly accepted account-enumeration side channel: because the
  not-found check runs before the business-day check, a valid operator identifier is the
  only thing that can ever produce a `403 non_working_day` response on a holiday — an
  invalid identifier always gets a generic `401` regardless of the day. This is in the same
  spirit as the already-accepted enumeration risk on `POST /auth/organizations/validate`
  (per `docs/add/auth-service.md`'s Open questions); it is not re-engineered around here.
- No SMS gateway or provider is chosen anywhere in this repo yet. A phone-registered
  operator's `admin.operator_code_issued` event has nowhere real to be delivered until that
  infrastructure lands — flagged here as a shared, undesigned dependency, the same move
  ADR-0007 made for its own still-undesigned issuance hand-off.
- "Today," for the purposes of `isWorkingDay`, is evaluated in an unspecified timezone. This
  ADR recommends UTC server-date as the default until, or unless, a per-platform timezone
  field is added to `PlatformNonWorkingDay`'s owning concept — not solved here, an open
  question.
- `docs/add/auth-service.md`'s existing "Rate limiting is an undesigned gap" bullet now also
  explicitly covers brute-forcing `POST /auth/admin/login/operator/verify-code` beyond the
  5-attempt-per-code lockout this ADR adds — an attacker could still exhaust many
  `request-code` calls to generate fresh codes to attack, since `request-code` itself is
  unauthenticated and unthrottled.
- Introduces `auth-service`'s first calendar/scheduling concept. It is intentionally minimal
  (two row types, no recurrence beyond a weekly weekend pattern) — richer scheduling needs
  (e.g. per-year holiday sets, half-days) are out of scope and would need their own decision.
