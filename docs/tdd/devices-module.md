# DevicesModule — device/network fingerprint capture and owner new-device alerting

- **Status:** Draft <!-- Draft | Reviewed | Implemented -->
- **Author:** Anwar (project owner)
- **Related SDD:** [docs/sdd/auth-service.md](../sdd/auth-service.md)
- **Related ADRs:** [0010](../adr/0010-owner-secret-key-login-with-device-alerting.md) (owner
  secret-key login with new-device alerting — the `AdminDevice`/new-device-alert half of this
  TDD). The general `Device`/first-launch-fingerprinting design itself is not ADR-backed — its
  rationale lives in the ADD's "Design rationale: device/network fingerprinting" section, not
  a standalone ADR.
- **Ticket/issue:** https://github.com/nawara-solutions/nawara-core/issues/12

> **Superseded in part — read with the ADRs below.** `AdminDevice` new-device alerting now runs on **every owner login** (after the second factor) and on recovery, not on a secret-key login ([ADR-0025](../adr/0025-owner-mfa-login-with-secret-key-step-up-and-recovery.md)). The event is `admin.owner_login_from_new_device`. It remains an alert-only signal; a User-Agent fingerprint is never an authentication factor.

## Problem

`auth-service` is currently a bare, unmodified Nest CLI scaffold — no code exists yet. This
TDD plans implementing the two device-fingerprinting entities and flows already fully designed
in `docs/sdd/auth-service.md`: `Device`, a best-effort, pre-authentication fingerprint captured
at first app launch (and, as a fallback, at registration) for future abuse-prevention work; and
`AdminDevice`, a narrower, owner-specific fingerprint `SecretKeyService` checks on every
secret-key login to alert the owner when a login comes from a device it hasn't recorded before.
Both are capture/alerting-only — no blocking, rate-limiting, or abuse-scoring logic is designed
or built here (see the SDD's own scope boundary). This TDD does not design anything new; it
only sequences implementing what the SDD already specifies.

Out of scope: `AuthModule`'s core credential flow (register/login/refresh/logout/me — covered
by [`auth-core-flow`](./auth-core-flow.md)) and everything in `AdminModule` other than the
`AdminDevice` check embedded in secret-key login, which the companion
[`admin-owner-secret-key`](./admin-owner-secret-key.md) TDD builds around this module's output.
This TDD implements `DeviceService`/`AdminDeviceService` as standalone, testable units; wiring
`SecretKeyService.login()` to call `AdminDeviceService.checkAndRecord()` is this TDD's
responsibility to build (the method exists here), but the endpoint that calls it
(`POST /auth/admin/login/secret-key`) is specified and sequenced in
`admin-owner-secret-key.md`, not here — see that TDD's Approach for how the two are wired
together.

## Approach

Build `DevicesModule` (new) and the `AdminDevice`/`AdminDeviceService` pair (part of
`AdminModule`, per the SDD's module boundaries) against the SDD's already-detailed data model,
class diagram, API contract, and flows (a) and (h) — no new fingerprinting logic, matching
logic, or event shape is invented here.

**`Device` (general, pre-authentication capture — SDD flow (a)):**

- `POST /auth/devices/register` is public, unauthenticated, and fires before any user exists.
  Body: `{installId, deviceModel?, osVersion?, appVersion?, locale?}`. `ipAddress` and
  `userAgent` are always read server-side off the incoming request — never trusted from the
  client — per the SDD's data-model notes.
- `DeviceService.upsert(fingerprint, ip, userAgent, userId?)` performs an idempotent
  `INSERT ... ON CONFLICT (installId) DO UPDATE lastSeenAt` — a repeat call with a
  previously-seen `installId` is not an error, just a `lastSeenAt` bump (see Edge cases).
  Always returns `204` to the caller regardless of insert-vs-update, per the API contract.
- The `RegisterDto.deviceFingerprint?` fallback field (used only if the client's earlier
  `POST /auth/devices/register` call didn't succeed) is `AuthModule`'s responsibility to wire
  into `AuthService.register()` per `auth-core-flow.md`, which depends on `DeviceService`
  existing — build `DevicesModule` first, as an independent, no-dependency leaf module (per
  the SDD's module-boundaries note: "`DevicesModule` is independent of `AuthModule`... and
  `AuthModule` depends on it, not the other way around").

**`AdminDevice` (owner-specific, per-login check — SDD flow (h)):**

- `AdminDeviceService.checkAndRecord(userId, userAgent, ip)` is called by `SecretKeyService`
  on every successful secret-key login (see `admin-owner-secret-key.md` for that call site).
  It normalizes and SHA-256-hashes the User-Agent header (`hashFingerprint`), then looks up
  `AdminDevice` by `(userId, fingerprintHash)`:
  - Found → update `lastSeenAt`/`ipAddress` (informational only, per the SDD — `ipAddress` is
    deliberately excluded from the identity hash and from the `UNIQUE(userId, fingerprintHash)`
    constraint, so an owner on a dynamic/mobile IP never trips a false "new device" alert on an
    IP change alone).
  - Not found → insert a new `AdminDevice` row and publish
    `admin.secret_key_login_from_new_device {userId, platformId, channel: "email", destination,
    ipAddress, userAgent, timestamp}` (per ADR-0010).
  - Either way, login proceeds — this check never blocks the login itself, only decides
    whether to alert. `checkAndRecord` returns a `NewDeviceCheckResult` so the caller can log
    it, but the login response to the owner is identical either way (per the SDD's class
    diagram and flow (h)).

## Files/components affected

Derived from the SDD's class diagram (`DevicesController`/`DeviceService`/`Device`,
`AdminDeviceService`/`AdminDevice`) and data model for the subset this TDD covers:

- `apps/auth-service/src/devices/device.entity.ts` — new. `Device` TypeORM entity: `id`,
  `installId` (unique), `ipAddress`, `userAgent`, `deviceModel?`, `osVersion?`, `appVersion?`,
  `locale?`, `userId?` (nullable FK), `firstSeenAt`, `lastSeenAt`.
- `apps/auth-service/src/devices/device.service.ts` — new. `upsert(fingerprint, ip, userAgent,
  userId?)`, `linkToUser(installId, userId)` (called by `AuthService.register()` once a `User`
  row exists, per `auth-core-flow.md` — not exercised by this module's own tests beyond a unit
  test of the method itself).
- `apps/auth-service/src/devices/devices.controller.ts` — new. `POST /auth/devices/register`,
  reading `ipAddress`/`userAgent` off the request object, never the body.
- `apps/auth-service/src/devices/dto/device-fingerprint.dto.ts` — new. `{installId,
  deviceModel?, osVersion?, appVersion?, locale?}`, with `class-validator` rules (`installId`
  required; the rest optional strings).
- `apps/auth-service/src/devices/devices.module.ts` — new. No dependency on `AuthModule` or
  `UsersModule` (per the SDD's module-boundaries note).
- `apps/auth-service/src/admin/entities/admin-device.entity.ts` — new. `AdminDevice` TypeORM
  entity: `id`, `userId` (FK), `fingerprintHash`, `ipAddress`, `firstSeenAt`, `lastSeenAt`,
  `UNIQUE(userId, fingerprintHash)`.
- `apps/auth-service/src/admin/admin-device.service.ts` — new. `checkAndRecord(userId,
  userAgent, ip)`, private `hashFingerprint(userAgent)` (SHA-256 of the normalized
  User-Agent — normalization detail, e.g. trim/lowercase, is an implementation choice not
  specified further by the SDD; pick one and apply it consistently on both write and lookup).
- `apps/auth-service/src/admin/admin.module.ts` — new (shared with
  `admin-owner-secret-key.md`; only the `AdminDeviceService`/`AdminDevice` piece is this TDD's
  responsibility to land — the rest of `AdminModule`'s surface is that TDD's).
- `apps/auth-service/src/migrations/` — adds the `device` and `admin_device` tables (additive
  to whatever migration `auth-core-flow.md`/`admin-owner-secret-key.md` land first — see Data
  migration below for sequencing).

Not touched by this TDD: `AuthService.register()`'s call into `DeviceService` (that wiring
belongs to `auth-core-flow.md`, which depends on this module) and `SecretKeyService.login()`'s
call into `AdminDeviceService.checkAndRecord()` (that wiring belongs to
`admin-owner-secret-key.md`, which depends on this module).

## Edge cases

Pulled directly from the SDD's "Error handling & edge cases" and Open-questions sections,
scoped to this module — no new cases invented:

- Repeat `POST /auth/devices/register` call with a previously-seen `installId` → idempotent
  upsert, just updates `lastSeenAt`; always `204`.
- `POST /auth/devices/register` failing client-side (no connectivity at first launch) →
  handled entirely client-side, per flow (a) — the client holds the same payload and retries
  it via the `RegisterDto.deviceFingerprint?` fallback on the next `POST /auth/register` call.
  Nothing on the server side needs to detect or compensate for this; it's invisible to
  `DeviceService`, which only ever sees a normal upsert call whenever it does arrive.
- `installId` collision or reset (e.g. app reinstall generating a fresh `installId`) — per the
  SDD's own Open questions, **this currently just looks like a new, unlinked `Device` row; no
  special handling is designed.** This is the accepted v1 behavior, not something this TDD
  attempts to solve — flagged here only so the gap isn't silently rediscovered as a bug later.
- No real MAC address or other hardware-level identifier exists on `Device` — a platform
  limitation (blocked on iOS/Android/browsers since ~2016), not an implementation gap to close.
- `AdminDevice` new-device check on an owner's very first-ever secret-key login → by
  construction no `AdminDevice` row exists yet for that `userId`, so this is always the "not
  found → insert + alert" branch — the owner's first login always fires
  `admin.secret_key_login_from_new_device`. Not called out separately in the SDD, but follows
  directly from the lookup being scoped by `(userId, fingerprintHash)` with no rows to match
  before the first insert.
- Same owner, same browser/app, different IP (e.g. mobile network switch) → **not** flagged as
  a new device, since `ipAddress` is deliberately excluded from the identity hash — only
  `lastSeenAt`/`ipAddress` are updated. This is the accepted weak-fingerprint tradeoff the SDD
  documents explicitly, not a gap.
- Same owner logging in from a genuinely different browser/app/User-Agent string → flagged as
  a new device and alerted, even if it's the same owner on the same physical machine (e.g.
  switching browsers) — a known false positive inherent to a User-Agent-only fingerprint,
  accepted per the SDD's rationale.
- `AdminDeviceService.checkAndRecord` never blocks the login either way (new device or known
  device) — it only decides whether to publish the alert event. This module builds no
  rate-limiting or blocking logic on top of either `Device` or `AdminDevice` records (per the
  SDD's explicit non-goal).
- `admin.secret_key_login_from_new_device` publish failing/unavailable — no RabbitMQ broker
  exists anywhere in this repo yet (per the ADD's "Infrastructure gap" note); this module's
  publish call is built against whatever stub/no-op event-publishing mechanism
  `auth-core-flow.md`'s `user.registered` publish already established, not a new one invented
  here.

## Data migration

N/A as a standalone concern — this module has no prior data to migrate. Whether the `device`
and `admin_device` tables land in `auth-core-flow.md`'s single initial migration or a separate
one depends on build order relative to that TDD; either is fine functionally, since both are
brand-new tables with no foreign-key dependency on anything not already created by that initial
migration (`user`). Coordinate with whichever TDD's migration lands first to avoid two
initial-migration files racing.

## Test plan

- **Unit:**
  - `DeviceService.upsert` — first call for a new `installId` inserts a row with `userId: null`,
    `firstSeenAt`/`lastSeenAt` both stamped; a repeat call with the same `installId` only bumps
    `lastSeenAt`, leaving `firstSeenAt` and other fields unchanged; `ipAddress`/`userAgent`
    passed in are persisted as given (this test only verifies the service layer — the
    "always server-observed, never client-supplied" property is a controller-layer
    responsibility, covered below).
  - `DeviceService.linkToUser` — sets `userId` on an existing `Device` row keyed by
    `installId`.
  - `AdminDeviceService.hashFingerprint` — SHA-256 of the normalized User-Agent; two calls with
    the same raw User-Agent produce the same hash; a differently-cased/whitespace-varied but
    semantically-identical User-Agent normalizes to the same hash (exercising whatever
    normalization rule is chosen); a genuinely different User-Agent produces a different hash.
  - `AdminDeviceService.checkAndRecord` — first call for a given `(userId, fingerprintHash)`
    inserts a new `AdminDevice` row and returns a result indicating "new device"; a second call
    with the same `(userId, fingerprintHash)` updates `lastSeenAt`/`ipAddress` only and returns
    "known device"; a call with the same `userId` but a different User-Agent (different
    `fingerprintHash`) is treated as a distinct, new device even though `userId` matches.
- **Integration:**
  - `POST /auth/devices/register` — success (`204`, row upserted, `ipAddress`/`userAgent`
    taken from the request headers/socket, not any value in the body even if one were
    supplied); repeat call with the same `installId` (`204`, `lastSeenAt` bumped, no duplicate
    row).
  - New-device alert firing on an owner's first-ever secret-key login: given an owner with no
    existing `AdminDevice` rows, a successful `POST /auth/admin/login/secret-key` call results
    in exactly one new `AdminDevice` row and one `admin.secret_key_login_from_new_device`
    publish (asserted via whatever event-publishing test double
    `auth-core-flow.md`/`admin-owner-secret-key.md` establishes for `user.registered`-style
    assertions). This test necessarily also exercises `SecretKeyService.login()` end-to-end,
    so it should live alongside (or be coordinated with) `admin-owner-secret-key.md`'s own
    integration tests for that endpoint, to avoid duplicating its full request/response
    plumbing here.
  - New-device alert **not** firing on a repeat login from the same device: given an owner with
    an existing `AdminDevice` row matching the login's normalized User-Agent, a second
    successful secret-key login updates that row's `lastSeenAt` and publishes no new-device
    event, while still returning the same `200` token response as any other successful login.
  - New-device alert firing again for a second, genuinely different device: given an owner with
    one existing `AdminDevice` row, a login presenting a different User-Agent inserts a second
    `AdminDevice` row (not a conflict/overwrite of the first) and publishes a second
    `admin.secret_key_login_from_new_device` event.
- **E2E:** not yet part of this project's test setup — none planned for this TDD, consistent
  with `auth-core-flow.md`.

## Rollout

N/A / straightforward. This is a first-ever deploy of these two tables and endpoints — no
existing data, no backwards-compatibility surface, and (per the SDD) no consumer acts on
`Device`/`AdminDevice` records beyond the alert event itself, which is additive and has no
existing subscriber depending on its absence. No feature flag needed. The one operational
prerequisite is the `device`/`admin_device` migration (see Data migration above) landing before
first deploy, and — per the ADD's "Infrastructure gap" note — the
`admin.secret_key_login_from_new_device` event has no real RabbitMQ broker to publish to yet in
this repo, so that publish call should be built against whatever stub mechanism
`auth-core-flow.md` establishes rather than blocking this module's rollout on broker
infrastructure landing first.
