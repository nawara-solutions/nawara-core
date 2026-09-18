# auth-service core credential flow (register, login, refresh, logout, me)

- **Status:** Draft <!-- Draft | Reviewed | Implemented -->
- **Author:** Anwar (project owner)
- **Related SDD:** [docs/sdd/auth-service.md](../sdd/auth-service.md)
- **Related ADRs:** [0001](../adr/0001-generic-organization-id-scoping-claim.md) (generic
  `organizationId` scoping claim), [0002](../adr/0002-jwt-access-token-with-rotating-refresh-token.md)
  (JWT access token + DB-backed rotating refresh token), [0003](../adr/0003-postgresql-typeorm-persistence.md)
  (PostgreSQL + TypeORM persistence), [0004](../adr/0004-synchronous-fail-closed-license-validation.md)
  (synchronous, fail-closed license validation against payment-service),
  [0005](../adr/0005-bounded-time-license-subscription-revalidation.md) (bounded-time
  license/subscription re-validation on login and refresh),
  [0006](../adr/0006-per-user-subscription-reservation-on-license-lapse.md) (per-user
  subscription reservation — the `403 subscription_invalid` behavior this TDD implements
  in login/refresh comes from this ADR),
  [0009](../adr/0009-platform-scoped-admin-accounts.md) (platform-scoped Admin accounts —
  relevant here because `organizationId: null` short-circuits the license/subscription
  checks for every Admin), [0016](../adr/0016-first-owner-bootstrap-command.md) (first-owner
  bootstrap command and the accompanying null-`organizationId` login/refresh short-circuit
  this flow must implement)
- **Ticket/issue:** https://github.com/nawara-solutions/nawara-core/issues/11

> **Superseded in part — read with the ADRs below.** [ADR-0026](../adr/0026-authentication-is-not-entitlement.md) removes the license/subscription checks from `login` and `refresh` (and `User.trialEndsAt`); only registration still asks `payment-service`. Members authenticate with email **or** phone + password; an owner's correct password yields an MFA challenge, not tokens ([ADR-0025](../adr/0025-owner-mfa-login-with-secret-key-step-up-and-recovery.md)).

## Problem

`auth-service` is currently a bare, unmodified Nest CLI scaffold — no code exists yet. This is
the first real implementation work in the service: `auth-service`'s core credential flow —
`POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, and
`GET /auth/me` — as already fully designed in `docs/sdd/auth-service.md`. This TDD plans
turning that design into working code; it does not design anything new.

Out of scope for this TDD (tracked separately, per the SDD/ADD): device/network
fingerprinting (`DevicesModule`), the `AdminModule`/`AdminOperatorController` surfaces
(secret-key login, operator login codes, operator management), and the real
`payment-service` HTTP integration (this flow is built against a stub client — see Approach).

## Approach

Build `AuthModule` and `UsersModule` against the SDD's already-detailed class diagram, API
contract, and sequence diagrams for these five endpoints (flows (c) registration, (d) login,
(e) refresh, (f) logout, and the `GET /auth/me` contract) — this TDD does not re-derive any of
that behavior, only sequences the work of implementing it.

Two decisions this flow depends on, already made and documented elsewhere, restated here only
so the implementation order is unambiguous — not re-litigated:

- **Stub `PaymentServiceClient`.** Per the build-sequencing note added to
  `docs/add/auth-service.md`'s "Communication & data flow" section, `OrganizationValidationService`
  is implemented against a **stub** `PaymentServiceClient` — same interface
  (`getLicenseStatus(organizationId): LicenseStatus`, `getSubscriptionStatus(userId):
  SubscriptionStatus`), canned responses shaped exactly like `payment-service`'s finalized
  contract (`{valid, expiresAt}` / `{exists, valid, expiresAt}`). This flow's implementation
  does not block on `payment-service`'s real endpoints existing.
- **Decided v1 parameters.** Per the resolved open questions in `docs/add/auth-service.md` and
  `docs/sdd/auth-service.md`: access-token TTL is **15 minutes**; password policy is
  **minimum 8 characters, no composition rules**.

Implementation order:

1. **`UsersModule`** — `User` entity/migration (per ADR-0003, columns as in the SDD's data
   model — only the fields this flow touches: `id`, `email`, `passwordHash`, `role`,
   `organizationId`, `isActive`, `trialEndsAt`, `createdAt`, `updatedAt`; the Admin-specific
   columns from ADR-0009+ can be added by the schema but are not exercised by this flow),
   `UsersService` (`create`, `findByEmail`, `findById`).
2. **Token handling** — `TokenService` (stateless JWT sign/verify, 15-minute access-token
   TTL, no `sessionExpiresAt` clamping needed yet since that's operator-only) and
   `RefreshTokenService` (`RefreshToken` entity/migration per ADR-0002, `issue`/`rotate`/
   `revoke`, hash-only persistence, reuse detection revoking the token family).
3. **`OrganizationsModule`** stub — `PaymentServiceClient` (stub implementation returning
   canned `LicenseStatus`/`SubscriptionStatus` values, injectable so tests can vary the
   response), `OrganizationValidationService` (`checkLicense`, `checkSubscription`),
   `OrganizationsController` (`POST /auth/organizations/validate`).
4. **`AuthModule`** — `AuthService` (`register`, `validateCredentials`, `login`, `refresh`,
   `logout`), `AuthController` (`register`, `login`, `refresh`, `logout`, `me`), DTOs and
   `class-validator` rules (including the 8-character-minimum password rule), `JwtStrategy`
   + `JwtAuthGuard` for `POST /auth/logout` and `GET /auth/me`.
5. Wire `AppModule` to import `UsersModule`, token handling, `OrganizationsModule`, and
   `AuthModule` in place of the scaffold's default `AppController`/`AppService`.

Business logic for each endpoint follows the SDD's flows exactly — no new behavior invented
here:

- **Register** (SDD flow (c)): `organizationId` required (`400` if missing) → duplicate email
  check (`409`) → `OrganizationValidationService.checkLicense` (`403`/`503` on
  invalid/unreachable) → bcrypt-hash password (~250ms cost factor, per the ADD's non-functional
  constraints) → create `User` with `trialEndsAt = now + <configured trial days>` → issue
  access + refresh tokens → `201`. (`deviceFingerprint`/`user.registered` publish are
  out of scope here — see Problem.)
- **Login** (SDD flow (d)): look up by email, generic `401` if not found or `isActive=false`
  → `bcrypt.compare` (`401` on mismatch, identical message to "not found") → if
  `organizationId` is `null` (per ADR-0016, e.g. a bootstrapped owner), skip the license/
  subscription checks entirely and issue tokens → otherwise `checkLicense` (`403`/`503`) then
  `checkSubscription` (`403 subscription_invalid`/`503`) → issue tokens → `200`.
- **Refresh** (SDD flow (e)): look up refresh token by hash (`401` if not found/expired/
  already-rotated, revoking the family on reuse) → if the token's user has
  `organizationId: null`, skip license/subscription checks and rotate → otherwise re-run the
  same `checkLicense`/`checkSubscription` sequence as login before rotating → `200` with a new
  pair. (The `sessionExpiresAt`/operator session-ceiling branch in the SDD's flow (e) is
  operator-only and out of scope for this TDD — this flow only needs the `sessionExpiresAt:
  null` path, which is a no-op pass-through.)
- **Logout** (SDD flow (f)): requires a valid Bearer access token (`401` if missing/invalid)
  → `RefreshTokenService.revoke(rawToken)` → `204`. Revokes only the one presented token —
  family-wide "logout everywhere" is resolved out of v1 scope (see the SDD's Open questions).
- **`GET /auth/me`**: requires a valid Bearer access token → `200` with the fields on the
  `User` entity this flow actually populates (`id`, `email`, `role`, `organizationId`,
  `isActive`, `trialEndsAt`, `createdAt`); the Admin-only fields (`phone`, `platformId`,
  `adminTier`, `contactVerifiedAt`) are `null` for every account this flow creates, consistent
  with the SDD's documented contract.

## Files/components affected

Derived from the SDD's class diagram and API contract for `AuthModule`/`UsersModule`/token
handling/`OrganizationsModule` (the subset this flow actually needs):

- `apps/auth-service/src/users/user.entity.ts` — new. `User` TypeORM entity.
- `apps/auth-service/src/users/users.service.ts` — new. `create`, `findByEmail`, `findById`.
- `apps/auth-service/src/users/users.module.ts` — new.
- `apps/auth-service/src/auth/entities/refresh-token.entity.ts` — new. `RefreshToken` TypeORM
  entity.
- `apps/auth-service/src/auth/token.service.ts` — new. `signAccessToken`, `verifyAccessToken`.
- `apps/auth-service/src/auth/refresh-token.service.ts` — new. `issue`, `rotate`, `revoke`,
  `hash` (private).
- `apps/auth-service/src/auth/jwt.strategy.ts` — new. Passport JWT strategy backing
  `JwtAuthGuard`.
- `apps/auth-service/src/auth/jwt-payload.interface.ts` — new. `{sub, role, organizationId,
  iat, exp}` (the Admin-specific claims are added by a later TDD, not this one).
- `apps/auth-service/src/organizations/payment-service-client.interface.ts` — new.
  `PaymentServiceClient` interface + `LicenseStatus`/`SubscriptionStatus` types.
- `apps/auth-service/src/organizations/payment-service-client.stub.ts` — new. Stub
  implementation returning canned responses shaped per `docs/sdd/payment-service.md`.
- `apps/auth-service/src/organizations/organization-validation.service.ts` — new.
  `checkLicense`, `checkSubscription`.
- `apps/auth-service/src/organizations/organizations.controller.ts` — new.
  `POST /auth/organizations/validate`.
- `apps/auth-service/src/organizations/organizations.module.ts` — new.
- `apps/auth-service/src/auth/dto/register.dto.ts` — new. `{email, password, role,
  organizationId}` (`deviceFingerprint?` omitted — out of scope).
- `apps/auth-service/src/auth/dto/login.dto.ts` — new. `{email, password}`.
- `apps/auth-service/src/auth/dto/refresh-token.dto.ts` — new. `{refreshToken}`.
- `apps/auth-service/src/auth/dto/validate-organization.dto.ts` — new. `{organizationId}`.
- `apps/auth-service/src/auth/auth.service.ts` — new. `register`, `validateCredentials`,
  `login`, `refresh`, `logout`.
- `apps/auth-service/src/auth/auth.controller.ts` — new. `register`, `login`, `refresh`,
  `logout`, `me`.
- `apps/auth-service/src/auth/auth.module.ts` — new.
- `apps/auth-service/src/app.module.ts` — modified. Imports `UsersModule`,
  `OrganizationsModule`, `AuthModule`, TypeORM root config (per ADR-0003).
- `apps/auth-service/src/app.controller.ts`, `app.service.ts` — removed (scaffold
  placeholders, superseded by `AuthModule`).
- `apps/auth-service/src/migrations/` — new. Initial migration creating `user` and
  `refresh_token` tables.

## Edge cases

Pulled directly from the SDD's "Error handling & edge cases" section and flows (c)-(f), scoped
to the five endpoints this TDD covers — no new cases invented:

- Missing `organizationId` on register → `400` (validation error, distinct from the
  license-related `403`s below).
- Duplicate email on register → `409`.
- Wrong password or unknown email on login → `401`, identical message either way
  (enumeration mitigation).
- Inactive user (`isActive=false`) on login/refresh → `401`.
- Malformed, not-found, or expired refresh token → `401`.
- Reused/already-rotated refresh token → `401`, and the entire token family is revoked
  (theft signal; structured log only, no alerting mechanism in v1).
- Register/login/refresh: `organizationId` present but its license is invalid/expired/not
  found → `403` with the exact "Your organization does not have a valid license. Please
  contact your organization." message (same wording for "not found" and "expired," to avoid
  confirming which organization ids exist).
- Login/refresh: license valid but the user's individual subscription (if any) is
  invalid/expired → distinct `403 {reason: "subscription_invalid"}`. A user with no
  subscription row at all is never blocked by this check.
- `payment-service` (stub) unreachable/erroring during any license or subscription check →
  `503` (fail-closed, per ADR-0004/ADR-0005). The stub must be able to simulate this case for
  tests even though it never makes a real network call.
- Login/refresh for a user with `organizationId: null` (per ADR-0016, e.g. a bootstrapped
  owner) → license/subscription checks are skipped entirely as "not applicable"; the flow
  proceeds straight to issuing/rotating tokens. Without this, such an account could never
  successfully log in.
- Invalid/expired/malformed JWT on `POST /auth/logout` or `GET /auth/me` → `401`.
- Other DTO validation failures (e.g. malformed email, password under 8 characters) → `400`,
  via Nest's `ValidationPipe` + `class-validator`.
- Organization license lapsing mid-session while a user holds a still-valid access token →
  not surfaced immediately; the user keeps working until that token expires (≤15 minutes) and
  a refresh is attempted, which then fails per the license-check bullet above. Documented as
  expected behavior (per ADR-0005), not a bug — no special handling needed in this flow.

## Data migration

N/A — this is the first-ever migration for `auth-service`. A single initial migration creates
the `user` and `refresh_token` tables (per ADR-0003); nothing pre-exists to migrate from.

## Test plan

- **Unit:**
  - `TokenService` — signs a token with the correct 15-minute `exp`; `verifyAccessToken`
    round-trips a valid token and rejects a tampered/expired one.
  - `RefreshTokenService` — `issue` persists only a hash of the raw token (never the raw
    value); `rotate` on a valid token revokes the old row and inserts a new one in the same
    family; `rotate` on an already-rotated/expired/revoked token revokes the whole family and
    throws; `revoke` marks a token revoked.
  - Password hashing — a given password hashes and verifies via bcrypt; a wrong password
    fails verification; the 8-character-minimum rule rejects shorter passwords at the DTO
    validation layer.
  - `OrganizationValidationService` against the stub `PaymentServiceClient` — maps each canned
    stub response (valid, invalid/expired, unreachable/error) to the correct
    `LicenseStatus`/`SubscriptionStatus` outcome.
- **Integration** (each endpoint, success + documented error paths, using the stub
  `PaymentServiceClient` for every license/subscription check):
  - `POST /auth/register` — success (`201` + token pair, `trialEndsAt` stamped); missing
    `organizationId` (`400`); duplicate email (`409`); invalid-license organization (`403`);
    stub simulating `payment-service` unreachable (`503`).
  - `POST /auth/login` — success (`200`); unknown email / wrong password (`401`, identical
    message); inactive user (`401`); invalid license (`403`); invalid subscription (`403
    subscription_invalid`); stub unreachable (`503`); `organizationId: null` account logs in
    without any license/subscription call being made (assert the stub was not invoked).
  - `POST /auth/refresh` — success with rotation (`200` + new pair, old token no longer
    usable); not-found/expired/reused token (`401`, family revoked on reuse); same
    license/subscription `403`/`503` outcomes as login; `organizationId: null` account rotates
    without a license/subscription call.
  - `POST /auth/logout` — success (`204`, token no longer usable for a subsequent refresh);
    missing/invalid Bearer token (`401`).
  - `GET /auth/me` — success (`200` with the expected field set); missing/invalid Bearer
    token (`401`).
- **E2E:** not yet part of this project's test setup — none planned for this TDD; revisit if
  the project adopts an e2e test harness later.

## Rollout

N/A / straightforward. This is the first-ever deployment of `auth-service`'s code — no
existing data, no backwards-compatibility surface, and no other service or consumer depends on
it yet. No feature flag needed: the service is simply unusable (a bare scaffold) until this
ships, so there is no partial/staged-rollout concern. The one operational prerequisite is
running the initial migration (per ADR-0003) before first deploy.
