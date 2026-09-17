# Admin owner secret-key login and rotation

- **Status:** Draft <!-- Draft | Reviewed | Implemented -->
- **Author:** Anwar (project owner)
- **Related SDD:** [docs/sdd/auth-service.md](../sdd/auth-service.md)
- **Related ADRs:** [0009](../adr/0009-platform-scoped-admin-accounts.md) (platform-scoped
  Admin accounts — `platformId`/`adminTier` claims this flow issues and relies on),
  [0010](../adr/0010-owner-secret-key-login-with-device-alerting.md) (owner permanent
  secret-key login with new-device alerting — the flow this TDD implements),
  [0016](../adr/0016-first-owner-bootstrap-command.md) (first-owner bootstrap command — the
  owner row this flow authenticates, and the `secretKeyHash IS NOT NULL` predicate it added to
  the login lookup)
- **Ticket/issue:** https://github.com/nawara-solutions/nawara-core/issues/13

## Problem

`auth-service` is currently a bare, unmodified Nest CLI scaffold — no code exists yet. This TDD
plans implementing the owner-tier authentication surface already fully designed in
`docs/sdd/auth-service.md`: `POST /auth/admin/login/secret-key` (an owner's permanent,
password-free login credential, with new-device alerting) and
`POST /auth/admin/secret-key/rotate` (self-service rotation of that credential, Bearer-gated to
owners only). This TDD does not design anything new — only sequences implementing what the SDD
already specifies, including ADR-0016's amendment to the login lookup for a freshly-bootstrapped
owner.

Out of scope: `AuthModule`'s core credential flow (covered by
[`auth-core-flow`](./auth-core-flow.md), which this flow's Bearer-token rotation path reuses —
see Approach), the `AdminOperatorController`/operator-management surface, the operator
login-code flow (`OperatorCodeService`, ADR-0011/ADR-0012/ADR-0014/ADR-0015), the platform
calendar endpoints (`PlatformCalendarService`, ADR-0011), and the `bootstrap-owner.ts` CLI
command itself (ADR-0016) — this TDD only implements the two endpoints that authenticate
against the owner row that command creates, not the command that creates it. `Device`/
`AdminDevice` fingerprint capture and matching logic is covered by the companion
[`devices-module`](./devices-module.md) TDD; this TDD only wires
`SecretKeyService.login()`'s call into `AdminDeviceService.checkAndRecord()`, built there.

## Approach

Build the `AdminModule` slice covering `SecretKeyService`/`AdminAuthController` (the secret-key
subset only — operator-code/calendar endpoints are separate, later work not covered here)
against the SDD's already-detailed class diagram, data model, API contract, and flows (h) and
(i) — no new behavior invented here.

Two decisions this flow depends on, already made and documented elsewhere, restated here only
so the implementation order is unambiguous:

- **`secretKeyHash: null` is a legitimate owner state, not an error.** Per ADR-0016, a
  freshly-bootstrapped owner (created by `bootstrap-owner.ts`, out of scope here) has no secret
  key at all until their first `POST /auth/admin/secret-key/rotate` call. The login lookup must
  therefore include an explicit `AND secretKeyHash IS NOT NULL` predicate — defense-in-depth
  against a null/empty input somehow hashing to a value that matches a null/empty stored column
  — rather than assuming every owner row has a non-null `secretKeyHash` by construction.
- **SHA-256, not bcrypt, for `secretKeyHash`.** Per ADR-0010/the SDD's data-model notes: a
  secret key is a high-entropy, server-generated value (not a low-entropy, human-chosen
  password), so it doesn't need bcrypt's deliberate slowness to resist brute force — the same
  entropy-based reasoning ADR-0010 states explicitly for refresh tokens (which ADR-0002 also
  persists only as a hash, though without naming an algorithm). Implement `SecretKeyService`'s
  private `hash()` accordingly — `crypto.createHash('sha256')`, not `bcrypt`.

Implementation order:

1. **Schema additions** — extend the `User` entity (already created by `auth-core-flow.md`)
   with the Admin-tier columns this flow reads/writes: `platformId`, `adminTier`,
   `secretKeyHash`, `secretKeyIssuedAt` (all nullable at the schema level, per the SDD's data
   model — enforced non-null-for-admins at the provisioning layer, not the schema). If
   `auth-core-flow.md`'s initial migration already created a bare `user` table, this is an
   additive migration; if this TDD lands first, fold these columns into that same initial
   migration instead of creating a second one — coordinate build order to avoid two competing
   "initial" migrations.
2. **`AdminTierGuard`** — a new, generic Nest guard (analogous to `RolesGuard`) reading the
   `adminTier` claim off the already-verified JWT payload (no DB round-trip), gating
   `POST /auth/admin/secret-key/rotate` to `adminTier: 'owner'` only. Build this before
   `AdminAuthController`, since the controller depends on it.
3. **`JwtPayload` claims + `AuthService.login`/`refresh` extension** — `docs/tdd/auth-core-flow.md`
   deliberately left `JwtPayload` at `{sub, role, organizationId, iat, exp}`, stating "the
   Admin-specific claims are added by a later TDD, not this one." This is that TDD: add
   `platformId?`/`adminTier?` to `JwtPayload`, and extend `AuthService.login`/`refresh`'s payload
   construction to include them whenever non-null on the `User` row (purely additive — both stay
   absent for every non-admin token). This is load-bearing for this TDD's own bootstrap-recovery
   story (see Edge cases and the end-to-end test below): a freshly-bootstrapped owner reaches
   `POST /auth/admin/secret-key/rotate` by first calling `POST /auth/login` (email+password, per
   `auth-core-flow.md`), and without this extension that Bearer token would carry no `adminTier`
   claim for `AdminTierGuard` to check — the endpoint would be unreachable. `docs/tdd/
   operator-login-and-confirmation.md` reuses this claim/payload work unchanged, the same way it
   reuses `AdminTierGuard`.
4. **`SecretKeyService`** — `login(secretKey, ip, userAgent)`, `rotate(ownerId)`, private
   `hash(rawKey)` (SHA-256). Depends on `UsersService` (reused from `auth-core-flow.md`),
   `AdminDeviceService` (built by `devices-module.md` — this TDD only calls
   `checkAndRecord(userId, userAgent, ip)` from within `login()`, per flow (h); it does not
   reimplement device matching), and token handling (`TokenService`/`RefreshTokenService`,
   reused from `auth-core-flow.md` — this flow issues the same access/refresh token pairs
   `AuthService` does, with no operator-only `sessionExpiresAt` involved).
5. **`AdminAuthController`** (the secret-key subset only) — `secretKeyLogin(dto)`,
   `rotateSecretKey(user: JwtPayload)`. The other methods on `AdminAuthController` in the SDD's
   class diagram (`registerOperator`, `confirmOperatorContact`, `requestOperatorCode`,
   `verifyOperatorCode`, `createNonWorkingDay`, `listNonWorkingDays`, `deleteNonWorkingDay`)
   belong to later, separate work and are not built by this TDD — declare the controller with
   only the two methods this TDD covers, extending it later rather than stubbing the rest now.
6. Wire `AdminModule` to import `UsersModule`, token handling, and this `SecretKeyService`/
   `AdminAuthController`/`AdminTierGuard` slice; wire `AppModule` to import `AdminModule`
   alongside `AuthModule`/`UsersModule` (both already wired by `auth-core-flow.md`).

Business logic for each endpoint follows the SDD's flows (h) and (i) exactly — no new behavior
invented here:

- **`POST /auth/admin/login/secret-key`** (SDD flow (h)): no auth required → hash the input
  secret key → look up `WHERE secretKeyHash = hash(input) AND adminTier = 'owner' AND
  secretKeyHash IS NOT NULL` (the `IS NOT NULL` predicate per ADR-0016) → no match → generic
  `401` → match → derive `platformId` from the matched row (never from caller input) → call
  `AdminDeviceService.checkAndRecord(userId, userAgent, ip)` (new device → insert + publish
  `admin.secret_key_login_from_new_device`; known device → update `lastSeenAt`/`ipAddress`
  only) → login proceeds identically either way → issue access token (`signAccessToken`, no
  `sessionExpiresAt` — this is not an operator flow) + refresh token (`RefreshTokenService.issue`,
  no `sessionExpiresAt`) → `200 {accessToken, refreshToken, expiresIn}`.
- **`POST /auth/admin/secret-key/rotate`** (SDD flow (i)): Bearer required, `AdminTierGuard`
  enforces `adminTier: 'owner'` (`403` otherwise, before reaching `AdminAuthController`) →
  generate a new high-entropy raw secret key → hash it (SHA-256) → atomically overwrite
  `secretKeyHash`/`secretKeyIssuedAt` on the caller's own `User` row (from the JWT `sub` claim,
  never a body parameter) → publish `admin.secret_key_rotated` → `200 {secretKey, issuedAt}`,
  returning the **raw** key exactly once — it is never retrievable again after this response.
  Reached through `POST /auth/login`'s existing email+password flow (`auth-core-flow.md`)
  issuing the Bearer token used here — deliberately not through secret-key login itself, per
  ADR-0010, so password login remains the recovery path if a secret key leaks. This is also
  the only path to an owner's **first** secret key: a freshly-bootstrapped owner
  (`secretKeyHash: null`, per ADR-0016) logs in via `POST /auth/login` with the
  password `bootstrap-owner.ts` seeded, then calls this endpoint to mint their first key —
  `rotate()`'s logic is identical whether `secretKeyHash` was previously `null` or a real hash;
  it is an unconditional overwrite either way, so no special-casing is needed for the
  first-ever rotation (see Edge cases).

## Files/components affected

Derived from the SDD's class diagram and API contract for the secret-key subset of
`AdminModule`:

- `apps/auth-service/src/users/user.entity.ts` — modified (extends the entity
  `auth-core-flow.md` creates). Adds `platformId`, `adminTier`, `secretKeyHash`,
  `secretKeyIssuedAt` columns.
- `apps/auth-service/src/admin/admin-tier.guard.ts` — new. `AdminTierGuard`, reading
  `adminTier` off the verified `JwtPayload`.
- `apps/auth-service/src/admin/secret-key.service.ts` — new. `login(secretKey, ip, userAgent)`,
  `rotate(ownerId)`, private `hash(rawKey)`.
- `apps/auth-service/src/admin/admin-auth.controller.ts` — new (secret-key methods only in
  this TDD; other `AdminAuthController` methods land with later work — see Approach).
  `secretKeyLogin`, `rotateSecretKey`.
- `apps/auth-service/src/admin/dto/secret-key-login.dto.ts` — new. `{secretKey}`.
- `apps/auth-service/src/admin/admin.module.ts` — new (shared with `devices-module.md`'s
  `AdminDeviceService`/`AdminDevice`; this TDD adds `SecretKeyService`/`AdminAuthController`/
  `AdminTierGuard` to the same module).
- `apps/auth-service/src/auth/jwt-payload.interface.ts` — modified (extends the interface
  `auth-core-flow.md` creates). Adds `platformId?`, `adminTier?` claims, per the SDD's JWT
  claims list — deliberately no email/phone in the token.
- `apps/auth-service/src/auth/auth.service.ts` — modified. `login`/`refresh`'s payload
  construction extended to include `platformId`/`adminTier` when non-null on the `User` row —
  the piece `docs/tdd/auth-core-flow.md` explicitly deferred ("the Admin-specific claims are
  added by a later TDD, not this one"); this is that TDD (see Implementation order step 3).
- `apps/auth-service/src/app.module.ts` — modified. Imports `AdminModule` alongside the
  modules `auth-core-flow.md` already wired.
- `apps/auth-service/src/migrations/` — adds the Admin-tier columns on `user` (see Data
  migration below for sequencing).

Not touched by this TDD: `AdminDevice`/`AdminDeviceService` (built by `devices-module.md`;
this TDD only calls it), `bootstrap-owner.ts` (ADR-0016, separate work), and every other
`AdminAuthController`/`AdminOperatorController` method (operator registration/confirmation/
login-code, platform calendar, operator management — all separate, later work per the SDD's
broader scope).

## Edge cases

Pulled directly from the SDD's "Error handling & edge cases" section and flows (h)/(i), scoped
to these two endpoints — no new cases invented:

- `POST /auth/admin/login/secret-key` with a key that doesn't match any owner → generic `401`
  (per ADR-0010); no distinction is made between "no such key" and "key belongs to a
  non-owner admin" (the `adminTier = 'owner'` predicate is part of the same lookup, not a
  separate check with its own error).
- A freshly-bootstrapped owner attempting secret-key login before their first rotation
  (`secretKeyHash: null`) → cannot match, by construction of the `AND secretKeyHash IS NOT
  NULL` predicate (per ADR-0016) — generic `401`, indistinguishable from any other non-match.
  This is expected: such an owner must use `POST /auth/login` (email+password) first, per the
  bootstrap flow's design.
- `POST /auth/admin/secret-key/rotate` called by a non-owner admin (operator) or a non-admin
  user → `403`, via `AdminTierGuard`, before reaching `SecretKeyService`.
- `POST /auth/admin/secret-key/rotate` called with a missing/invalid/expired Bearer token →
  `401`, via the same JWT verification `auth-core-flow.md`'s `JwtAuthGuard`/`JwtStrategy`
  already provide (reused here, not rebuilt).
- **First-ever rotation, from `secretKeyHash: null`** → not a distinct code path: `rotate()`
  unconditionally overwrites `secretKeyHash`/`secretKeyIssuedAt`, the same whether the prior
  value was `null` or a real hash. No special handling is needed or designed — this is the
  documented, expected way a freshly-bootstrapped owner obtains their first key.
- New-device detection on secret-key login (found-vs-not-found `AdminDevice` row, alert
  publish) — fully owned and tested by `devices-module.md`; this flow only calls
  `checkAndRecord` and never branches its own control flow on the result (login always
  proceeds either way).
- `admin.secret_key_rotated` publish failing/unavailable — no RabbitMQ broker exists anywhere
  in this repo yet (per the ADD's "Infrastructure gap" note); built against whatever
  stub/no-op event-publishing mechanism `auth-core-flow.md`'s `user.registered` publish
  already established.
- Both secret-key endpoints inherit the same undesigned rate-limiting gap as the rest of
  `auth-service` (per the ADD's non-functional constraints) — secret-key brute force on
  `POST /auth/admin/login/secret-key` is a known, currently unaddressed gap, not solved by
  this TDD.
- `platformId` on a successful login is always derived from the matched `User` row, never
  accepted from the caller — there is no `platformId` field in `SecretKeyLoginDto` to validate
  against in the first place.

## Data migration

Additive only — no pre-existing rows to migrate for these new/extended columns
(`platformId`, `adminTier`, `secretKeyHash`, `secretKeyIssuedAt`), all nullable at the schema
level per the SDD's data model. If `auth-core-flow.md`'s initial migration lands first, this
is a second, additive migration adding these four columns to the existing `user` table; if
this TDD's implementation lands first, fold these columns directly into that same initial
migration instead — coordinate build order with `auth-core-flow.md` and `devices-module.md` to
land exactly one initial migration for `user`, not several competing ones. No owner rows exist
to backfill at this stage — the first owner row is created separately by `bootstrap-owner.ts`
(ADR-0016, out of scope here), after this migration and this TDD's code are both in place.

## Test plan

- **Unit:**
  - `AdminTierGuard` — allows a request with `adminTier: 'owner'` in the verified JWT payload;
    rejects (`403`) a request with `adminTier: 'operator'`, with no `adminTier` claim at all
    (a non-admin user), or with a missing/invalid JWT (delegates that case to the existing
    JWT-verification layer, per `auth-core-flow.md`).
  - `SecretKeyService.hash` — SHA-256, not bcrypt: given the same raw key, `hash()` is
    deterministic (same input → same output, unlike bcrypt's salted output) and round-trips
    correctly against a stored value via direct comparison (no `bcrypt.compare`-style
    verification function needed).
  - `SecretKeyService.login` (with `UsersService`/`AdminDeviceService`/`TokenService`/
    `RefreshTokenService` test doubles) — a matching, non-null `secretKeyHash` for an owner
    row issues a token pair and calls `AdminDeviceService.checkAndRecord`; a matching hash for
    a non-owner `adminTier` (defense against a lookup bug) does not authenticate; a matching
    hash against a row with `secretKeyHash: null` cannot occur by construction (the lookup
    itself excludes it) — assert the repository-level query includes the `IS NOT NULL`
    predicate rather than relying on hash-matching semantics alone.
  - `SecretKeyService.rotate` — overwrites `secretKeyHash`/`secretKeyIssuedAt` atomically and
    returns the new **raw** key (not the hash) exactly once; called again immediately
    invalidates the just-returned key (a second `rotate()` call changes the stored hash again,
    and the previously-returned raw key no longer matches); rotating from
    `secretKeyHash: null` behaves identically to rotating from an existing hash (no branch in
    the implementation — assert both starting states produce the same successful outcome
    shape).
- **Integration** (using the `devices-module.md`-built `AdminDeviceService`/`AdminDevice` for
  the device-alerting assertions, and `auth-core-flow.md`'s existing `POST /auth/login` +
  `JwtAuthGuard` for the Bearer-token setup these tests need):
  - `POST /auth/admin/login/secret-key` — success for an owner with a rotated (non-null)
    `secretKeyHash` (`200` + token pair); non-matching key (`401`); key matching a row where
    `adminTier != 'owner'` (`401`, cannot occur via legitimate data but exercised directly
    against the repository/fixture to confirm the guard clause); a freshly-bootstrapped owner
    (`secretKeyHash: null`) attempting secret-key login with any input (`401`, confirming the
    `IS NOT NULL` predicate).
  - `POST /auth/admin/secret-key/rotate` — success from an owner's Bearer token obtained via
    `POST /auth/login` (`200 {secretKey, issuedAt}`, raw key present and usable immediately
    afterward on `POST /auth/admin/login/secret-key`); **first-ever rotation** from a
    freshly-bootstrapped owner (`secretKeyHash: null` beforehand) succeeds identically (`200`,
    and the returned key subsequently logs in successfully); called by an operator's Bearer
    token (`403`); called with no/invalid Bearer token (`401`); a second rotation immediately
    invalidates the first-returned key for `POST /auth/admin/login/secret-key` (old key now
    `401`, new key `200`).
  - End-to-end owner bootstrap-to-secret-key sequence (ties this TDD together with ADR-0016's
    intent, using a manually-seeded owner fixture rather than the real `bootstrap-owner.ts`
    CLI, which is separate work): seeded owner (`secretKeyHash: null`) → `POST /auth/login`
    with seeded email+password → `200` → `POST /auth/admin/secret-key/rotate` with that Bearer
    token → `200 {secretKey}` → `POST /auth/admin/login/secret-key` with that key → `200`,
    confirming the full in-band path ADR-0016 describes actually works end-to-end.
- **E2E:** not yet part of this project's test setup — none planned for this TDD, consistent
  with `auth-core-flow.md`.

## Rollout

N/A / straightforward. This is a first-ever deploy of these two endpoints and their supporting
schema — no existing data, no backwards-compatibility surface, and no consumer depends on them
yet. No feature flag needed. Two operational prerequisites, both already noted above: the
Admin-tier column migration (see Data migration) landing before first deploy, and a first owner
row actually existing to log in as — which requires `bootstrap-owner.ts` (ADR-0016) to have
been run, a separate, out-of-scope operational step this TDD's endpoints depend on but do not
themselves perform.
