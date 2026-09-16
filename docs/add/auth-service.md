# auth-service

- **Status:** Draft <!-- Draft | Reviewed | Implemented -->
- **Owners:** Anwar (project owner)
- **Related ADRs:** [0001](../adr/0001-generic-organization-id-scoping-claim.md) (generic `organizationId` scoping claim), [0002](../adr/0002-jwt-access-token-with-rotating-refresh-token.md) (JWT access token + DB-backed rotating refresh token), [0003](../adr/0003-postgresql-typeorm-persistence.md) (PostgreSQL + TypeORM persistence), [0004](../adr/0004-synchronous-fail-closed-license-validation.md) (synchronous, fail-closed license validation against payment-service), [0005](../adr/0005-bounded-time-license-subscription-revalidation.md) (bounded-time license/subscription re-validation on login and refresh), [0006](../adr/0006-per-user-subscription-reservation-on-license-lapse.md) (per-user subscription reservation on organization license lapse — `payment-service`'s decision, referenced here for the login/refresh contract it implies)
- **Related ADDs/SDDs:** A corresponding SDD, `docs/sdd/auth-service.md`, will follow this ADD to cover `auth-service`'s internal module/class design, data model, and API contract in detail.

## Scope

This document covers `auth-service`'s v1 architecture as a boundary within `nawara-core`:
how it verifies credentials, issues/rotates/revokes tokens, exposes the generic `role` and
`organizationId` claims other services and consuming apps rely on (per ADR-0001), and how it
gates registration on an organization's license validity via a synchronous call to
`payment-service` (per ADR-0004), including stamping the v1 trial period on first-time
registrants for a given organization. It also covers re-validating that same license (and,
when one exists, the requesting user's own individual subscription) on every login and token
refresh, so that a user stays logged out — within one access-token lifetime — once their
organization's license lapses (per ADR-0005), and how `auth-service` distinguishes the two
different `403` reasons a login/refresh can fail for. Per ADR-0001, `organizationId` is
required input on
every self-service `POST /auth/register` call — there is no org-less self-registration mode;
the only null-`organizationId` accounts are the platform's own `Admin` accounts, which are
provisioned out-of-band and never created through this public endpoint (see Context).

This document also covers capturing a best-effort device/network fingerprint at first app
launch, with a registration-time fallback if the first-launch call doesn't succeed (see
"Design rationale: device/network fingerprinting" below) — intended to give future
abuse-prevention/rate-limiting work an early signal to build on. Acting on that signal
(actual blocking, rate-limiting, or abuse scoring) is explicitly out of scope here; this
document covers capture only.

Explicitly out of scope:

- Any app-specific authorization semantics — what a given `role` (e.g. `Admin`,
  `SchoolAdmin`) is actually allowed to do inside a consuming app is that app's concern, not
  `auth-service`'s. `auth-service` only issues and verifies the claim; it never interprets it.
- The five features already deferred past v1: password reset, email verification, MFA,
  social login, and multi-session/device management. None of these are designed here.
- Any API-gateway design. No gateway exists in this repo today, and this document does not
  assume one will.
- The license/organization data model itself, and the individual-subscription
  freeze/resume ("reservation") mechanics from ADR-0006. Per `CLAUDE.md`, licenses and
  subscriptions are `payment-service` `Product`/`Charge` concepts; that model belongs in
  `payment-service`'s own ADD/SDD, not here. This document only covers the shape of
  `auth-service`'s (currently assumed, per ADR-0004/ADR-0005) calls out to it, and how a
  `403` from either check is surfaced to the client.
- Which roles or users ever get an individual subscription in the first place. That's a
  consuming-app decision (e.g. `nawara-drive` choosing which of its own roles must pay
  individually) — `auth-service` only ever observes whether `payment-service` reports a
  subscription for a given user, never why one does or doesn't exist (per ADR-0006).
- Any actual rate-limiting, blocking, or abuse-scoring logic built on top of captured
  `Device` records. As covered below, this document designs only how a device gets
  identified and recorded, not what happens once a pattern of abuse is detected.

## Context

`auth-service` is currently a bare, unmodified Nest CLI scaffold
(`apps/auth-service/src/app.controller.ts`, `app.service.ts`, `app.module.ts`, `main.ts` —
none of it touched yet). This ADD exists to give the first real implementation of that
scaffold a settled shape before code is written, expanding on the four ADRs above, which
resolved token strategy, persistence, the multi-tenancy claim, and the new cross-service
dependency, but did not describe how the resulting pieces fit together as a whole.

Today's and near-term callers of `auth-service`:

- **`nawara-drive`'s backend, desktop (Tauri), and mobile (Expo/React Native) apps** — the
  first real consumer, calling `auth-service` directly over REST/HTTPS. There is no API
  gateway in front of it today, so these clients hit `auth-service` the same way any external
  client would, consistent with this repo's "API is the only contract" principle.
- **Other `nawara-core` services**, potentially, if they need to validate an access token or
  look up minimal user data (e.g. `notification-service` resolving a `userId` to a delivery
  channel). Per ADR-0002, access-token verification is designed to happen without calling
  back into `auth-service` at all — any such service would hold the verification key locally
  — but a service might still need `auth-service`'s API for anything beyond bare
  verification (e.g. confirming a user still exists).
- **`daycare`**, named in this repo's own `CLAUDE.md` as a future migration target. It
  currently runs its own local, domain-agnostic auth/notification/license services and is not
  a current dependency of `auth-service` — it's noted here only because `auth-service`'s
  design should stay generic enough that `daycare` could plausibly adopt it later, per the
  "would an unrelated future app find this useful as-is?" test in `CLAUDE.md`.
- **A possible future API gateway.** No gateway design exists in this repo, and none should
  be assumed by anything in this document — `auth-service` must work correctly as a
  directly-called service.

New in this design, and worth calling out explicitly: `auth-service` now also depends on
**`payment-service`**, called synchronously to validate an organization's license status
during registration (ADR-0004). This is the first synchronous, service-to-service call of
any kind in `nawara-core` — until now, every service in this repo has been an independent,
directly-called leaf with no outbound dependency on another service in the repo.

Also new in this design: that same `payment-service` dependency is no longer limited to
registration. `POST /auth/login` and `POST /auth/refresh` now make the same kind of call, to
re-check that the requesting user's organization still holds a valid license — and, when one
exists, that the user's own individual subscription is still valid — before issuing or
rotating tokens (ADR-0005). This exists because access tokens, once issued, are verified
locally with no call back to `auth-service` or `payment-service` (per ADR-0002); without a
check at login/refresh time, a user whose organization's license lapses after they logged in
would simply keep working until they happened to log out on their own.

Per ADR-0001, `organizationId` is required input on every self-service registration — there
is no supported flow for an end user to register without one. The only accounts with a null
`organizationId` are the platform's own `Admin` accounts, and those are provisioned
out-of-band (seeded directly into the database, or via a separate internal/operator-only
mechanism — see Open questions), never through the public `POST /auth/register` endpoint
this document designs.

Also new in this design: `auth-service` now captures a device/network fingerprint as early
as first app launch — before a user has entered anything, including an organization id —
via a dedicated `POST /auth/devices/register` endpoint, with a fallback onto
`POST /auth/register` itself if that earlier call didn't succeed (see "Design rationale:
device/network fingerprinting" below). This is captured purely as a future
abuse-prevention signal; nothing in this design acts on it yet.

## Component overview

At the architecture level, `auth-service` is composed of six logical components:

- **`AuthModule`** — the `AuthController` and `AuthService` handling registration, login,
  refresh, and logout. This is the module clients actually talk to.
- **`UsersModule`** — owns `User` persistence (credentials, `role`, `organizationId` per
  ADR-0001, trial-period metadata for B2B accounts). `AuthModule` depends on it; it has no
  outward-facing controller of its own in v1.
- **Token handling** — JWT signing/verification for access tokens, and DB-backed refresh
  token issuance/rotation/reuse-detection per ADR-0002. Access-token verification is a pure,
  local, stateless operation (no DB call); refresh-token rotation reads and writes the
  `RefreshToken` table.
- **`OrganizationsModule`** (organization-validation service) — implements
  `POST /auth/organizations/validate` and the server-side re-check inside registration,
  calling out to `payment-service` per ADR-0004. Per ADR-0005, `AuthService` now also calls
  into this component from `login` and `refresh`, to re-check the requesting user's
  organization's license (and, when one exists, their individual subscription) before
  issuing or rotating tokens. This is the only component in `auth-service` with an outbound
  network dependency on another service.
- **RBAC guards (`RolesGuard`)** — a generic Nest guard reading the `role` claim off the
  verified access token to gate `auth-service`'s own endpoints where needed (e.g. anything
  restricted to the platform's own `Admin` role, such as license generation triggers that
  live in `payment-service` but might need an `Admin`-authenticated call path). `RolesGuard`
  only understands the generic `role: string` — it has no built-in notion of what any
  particular role means.
- **`DevicesModule`** (`DevicesController`, `DeviceService`) — implements
  `POST /auth/devices/register`, the unauthenticated first-launch endpoint (see "Design
  rationale: device/network fingerprinting" below). Reads IP address and User-Agent
  directly off the incoming request (never trusting a client-supplied value for either),
  accepts the client's `installId` and optional device
  metadata, and idempotently upserts a `Device` record keyed by `installId`. Also owns the
  server-side handling of the `deviceFingerprint` fallback field on `POST /auth/register`
  when the dedicated call didn't succeed earlier. `DevicesModule` is independent of
  `AuthModule`'s login/refresh/logout flows — it is called before a user exists, and later
  linked to a `User` once one is created via registration.

```mermaid
graph LR
  subgraph Consumers
    NDBackend[nawara-drive backend]
    NDDesktop[nawara-drive desktop]
    NDMobile[nawara-drive mobile]
  end

  NDBackend -- REST/HTTPS --> AuthController
  NDDesktop -- REST/HTTPS --> AuthController
  NDMobile -- REST/HTTPS --> AuthController

  NDBackend -- "REST/HTTPS (first launch)" --> DevicesController
  NDDesktop -- "REST/HTTPS (first launch)" --> DevicesController
  NDMobile -- "REST/HTTPS (first launch)" --> DevicesController

  subgraph auth-service
    AuthController --> AuthService
    AuthService --> UsersService
    AuthService --> TokenService
    AuthService --> OrgValidationService
    AuthController --> RolesGuard
    AuthService --> DeviceService
    DevicesController --> DeviceService
  end

  UsersService --> AuthDB[(auth-service Postgres DB)]
  TokenService --> AuthDB
  DeviceService --> AuthDB
  OrgValidationService -- REST/HTTPS --> PaymentService[payment-service]

  AuthService -. user.registered event .-> Broker[[RabbitMQ]]
```

`AuthController` is the only entry point clients call for credential-based flows;
`UsersModule` and token handling both write to `auth-service`'s own dedicated Postgres
database (per ADR-0003), never shared with any other service. `OrgValidationService` is the
sole component with a solid, synchronous edge leaving `auth-service` (to `payment-service`);
that edge now serves `login` and `refresh` as well as registration (ADR-0005), not just
registration as in the previous revision of this document. The dashed edge to RabbitMQ
represents the one v1 async event, described below.
`DevicesController` is a second, independent entry point consuming apps call directly at
first app launch (see "Design rationale: device/network fingerprinting" below) — its edge
in the diagram above is deliberately drawn separate from the `AuthController` flows, since
it fires before a user exists and does not depend on, or block, registration/login.
`AuthService` calls into `DeviceService` only for the registration-time `deviceFingerprint`
fallback described below.

## Design rationale: device/network fingerprinting

`auth-service` needs a way to recognize and, eventually, rate-limit or block an abusive
device — before that device's user has provided any sensitive information at all,
including the organization id ADR-0004's B2B registration flow requires up front.
Waiting until registration to start collecting a device signal is too late: a bad actor
could otherwise script many failed or throwaway attempts per install with nothing
distinguishing one install from the next until a user account actually exists.
`auth-service` does not own any notion of what "abusive" means yet, nor any
rate-limiting/blocking logic — this rationale is scoped purely to how a device gets
*identified and recorded*, not to what happens once a pattern of abuse is detected.

A hard technical constraint shapes every option here: real hardware MAC addresses are
**not** obtainable from apps on modern platforms (iOS, Android, and browsers have all
blocked this since roughly 2016) — apps requesting a device's MAC address get a
randomized, per-app or per-session value instead. Any design assuming literal MAC capture
is not implementable on today's platforms.

Options considered:

- **Chosen — app-generated, locally-persisted `installId` + server-observed IP/User-Agent
  + optional client-supplied device metadata, via a dedicated first-launch endpoint, with
  a registration-time fallback.** The client generates a random `installId` on first run
  and persists it locally, sending it plus best-effort device metadata (model, OS
  version, app version, locale) to `POST /auth/devices/register` as early as possible.
  `auth-service` reads IP address and User-Agent directly off the incoming request rather
  than trusting any client-supplied value for either. If that first-launch call doesn't
  succeed (e.g. no connectivity yet), the same payload is instead attached to the
  subsequent `POST /auth/register` call, so the signal still gets captured. Gives the
  earliest possible signal in the common case, with a fallback that avoids losing it in
  the uncommon one, at the cost of one new endpoint and a small amount of client-side
  bookkeeping.
- **Passive-only capture** — attach the same signals to every existing auth request
  instead of adding a dedicated endpoint. Simpler, but loses the specifically wanted
  property of a signal captured *before the user does anything*: a device that never
  proceeds past the landing screen would leave no record at all.
- **Real MAC/IMEI-level hardware fingerprinting via native platform code** — rejected
  outright, not as a matter of preference but of platform capability, per the constraint
  above.
- **A third-party device-fingerprinting/fraud-prevention SDK or service** — would likely
  produce a richer, harder-to-spoof fingerprint, but is a materially bigger scope, cost,
  and vendor-dependency decision than this stage warrants, and raises its own
  data-sharing/privacy questions. Worth revisiting later if the in-house signals prove
  insufficient in practice; not chosen for v1.

Consequences carried into this design:

- No real MAC address or other hardware-level identifier is ever collected — a platform
  limitation, not a design choice.
- `installId` is self-reported and trivially reset by reinstalling the app — it is one
  input among several (combined with server-observed IP/User-Agent), not an unspoofable
  identity on its own. Any future abuse-detection logic built on top must account for
  this.
- This rationale covers only the *capture* of the device/network signal; any actual
  rate-limiting, blocking, or abuse-scoring logic that consumes `Device` records is
  explicitly out of scope and needs its own future design.
- Adds a new public, unauthenticated endpoint (`POST /auth/devices/register`) to
  `auth-service`'s surface area, callable before a user exists — its own abuse surface
  (e.g. being spammed to create many `Device` rows) should be considered when it's
  actually implemented.
- Storing IP addresses and device metadata ahead of any user identity raises an open
  data-retention/privacy-disclosure question for unlinked `Device` records — see Open
  questions.

## Communication & data flow

`auth-service`'s primary interface is synchronous REST/JSON, called directly by consuming
apps — there is no gateway or intermediary in v1, so `auth-service` must validate and
authenticate every request itself rather than trusting an upstream layer to have done so.

Two synchronous flows matter architecturally:

1. **Client ⇄ `auth-service`**: `POST /auth/register`, `POST /auth/login`,
   `POST /auth/refresh`, `POST /auth/logout`, and, for B2B registration,
   `POST /auth/organizations/validate`. All plain REST/JSON over HTTPS.
2. **`auth-service` ⇄ `payment-service`**: a synchronous call, `GET
   /payment/licenses/:organizationId/status`, its contract finalized by
   `docs/add/payment-service.md`/`docs/sdd/payment-service.md` (per ADR-0004). Invoked from
   `POST /auth/organizations/validate`, from inside `POST /auth/register` itself (so
   registration never trusts that an earlier validate call is still accurate, closing the
   time-of-check-to-time-of-use gap, per ADR-0004), and now also from `POST /auth/login` and
   `POST /auth/refresh` (per ADR-0005). On a successful registration, and only on a
   first-time B2B registration for that organization, `auth-service` stamps the user's
   account with the v1 trial period (a global config default, e.g. 14 days) — the trial length
   itself is `auth-service`-owned account metadata, not something `payment-service` reports.
3. **`auth-service` ⇄ `payment-service`**: a second synchronous call, `GET
   /payment/subscriptions/:userId/status`, its contract likewise finalized by
   `docs/sdd/payment-service.md` (per ADR-0006), invoked from `POST /auth/login` and
   `POST /auth/refresh` alongside the license-status call above. A response indicating no
   subscription exists for that user is treated as "not applicable" and never blocks
   login/refresh on its own — only an existing-but-invalid (expired or suspended)
   subscription does. `auth-service` never creates, modifies, or interprets *why* a
   subscription exists; it only reads its current status.

For side effects, this design recommends one async event for v1, consistent with
`CLAUDE.md`'s "async events for side effects" principle:

- **`user.registered`** — `{ userId, role, organizationId, timestamp }`, published after a
  successful registration so `notification-service` can react (e.g. send a welcome message)
  without `auth-service` taking on a direct dependency on `notification-service` or knowing
  anything about notification channels/templates.

Two related events — `user.role_changed` and `user.organization_changed` — are explicitly
**not** designed for v1: there is no user-management endpoint in v1 that could mutate a
user's `role` or `organizationId` after creation, so there is nothing yet to trigger them.
They're noted here so a future user-management design doesn't have to rediscover the need.

**Infrastructure gap:** no RabbitMQ broker, exchange/queue naming convention, or client
library exists anywhere in this repo yet — `user.registered` is a design recommendation, not
a component that can be built today without that follow-up infra work landing first.

**Data ownership:** `auth-service` is the sole owner and writer of `User` and `RefreshToken`
records (per ADR-0003, its own dedicated Postgres database — no other service queries it
directly). `organizationId` values are opaque to `auth-service` (per ADR-0001) — it stores and
echoes them but never validates their meaning, except for the one carve-out in ADR-0004 where
it checks license *status* against `payment-service`, not the organization id's validity
itself. License/organization billing data, and now individual-subscription data (per
ADR-0006), are owned entirely by `payment-service` — `auth-service` only ever reads their
*status*, on the same terms as the license check.

## Non-functional constraints

- **Horizontal scalability of token verification.** Per ADR-0002, access-token verification
  must never require a database call, so `auth-service` itself — and any other service that
  chooses to verify tokens locally — can scale horizontally without a shared database becoming
  a bottleneck on the hot path.
- **Password hashing cost.** Tuned for roughly 250ms per hash (bcrypt). This is an
  implementation parameter decided at the SDD level, not significant/hard-to-reverse enough
  to warrant its own ADR.
- **Refresh-token storage growth.** Because refresh tokens are DB-backed and rotated per
  ADR-0002, `RefreshToken` rows accumulate (rotated-away and expired rows are never
  automatically deleted in v1). This implies an eventual token-pruning/cleanup job as a known
  operational need — not v1 code, just something the SDD/TDD should account for before this
  becomes a real table-bloat problem.
- **No secret-distribution mechanism yet.** There is currently no mechanism anywhere in this
  repo for distributing the JWT signing secret/key to other services (or a future gateway)
  that might want to verify tokens locally — no `.env`/secrets infrastructure exists anywhere
  yet. Any service wanting to verify `auth-service`'s tokens today would need an
  out-of-band-shared key, which is not a solved problem.
- **Availability coupling to `payment-service` now extends to login and refresh.** Per
  ADR-0004, the outbound call to `payment-service` needs an explicit request timeout (on the
  order of a few seconds) and fails closed on error or timeout. Per ADR-0005, this coupling is
  no longer limited to new B2B registrations — `payment-service` being down now also blocks
  login and token refresh for already-registered users, since both flows re-check license
  (and, when applicable, subscription) status on every call. Only `POST /auth/logout` remains
  entirely unaffected, since it never touches `payment-service`. This is a materially wider
  blast radius than the previous revision of this document described, and should be weighed
  against `payment-service`'s own availability target.
- **Access-token TTL directly bounds how long a forced logout can take.** Per ADR-0005, a
  user whose organization's license lapses stays logged in until their current access token
  expires and a refresh is attempted. No specific TTL value is decided by this document — see
  Open questions.
- **Rate limiting is an undesigned gap.** Login and registration endpoints have no
  rate-limiting design yet — a known gap to close before production exposure, not addressed
  in this document.

## Open questions

- The five v1-deferred features: password reset, email verification, MFA, social login, and
  multi-session/device management. None are designed here.
- Who is responsible for the ongoing validity/meaning of an `organizationId` over time — e.g.
  if a consuming app's notion of "that organization" is later deleted, does anything in
  `auth-service` need to react, or is that entirely the consumer's problem? Per ADR-0001,
  `auth-service` treats the value as fully opaque, but this specific lifecycle question wasn't
  addressed by that ADR.
- When (if ever) a cross-cutting "shared JWT validation" ADD becomes worth writing, once a
  second real service actually needs to verify `auth-service`'s tokens locally.
- RabbitMQ infrastructure does not exist anywhere in this repo yet (broker, exchange/queue
  conventions) — needs its own follow-up before `user.registered` can actually ship.
- Multi-organization membership is explicitly out of scope per ADR-0001; if a future consumer
  needs it, that requires a new ADR superseding ADR-0001, not a change to this document alone.
- Whether an API gateway will ever front `auth-service` — no decision has been made either
  way, and this design deliberately does not assume one.
- Enumeration risk on `POST /auth/organizations/validate` if organization ids/keys turn out to
  be short, human-typed codes rather than high-entropy tokens — a candidate for rate-limiting
  that specific endpoint, not yet designed.
- Whether the v1 global trial-period default needs to become per-organization or
  per-license configurable, rather than a single fixed value (e.g. 14 days) for everyone.
- How captured `Device` records actually get acted upon — blocking, rate-limiting, or any
  other abuse-scoring logic. As covered above, this pass covers capture only; consuming
  that data is explicitly out of scope here and needs its own future design.
- `Device` data-retention policy, and whether collecting IP/device metadata ahead of user
  registration needs disclosure in a privacy policy. Flagged as an open follow-up above;
  unresolved by this document.
- The internal mechanism for provisioning the platform's `Admin` accounts out-of-band (per
  ADR-0001) — e.g. a seed script vs. a separate internal/operator-only endpoint. Deliberately
  left unspecified in this pass.
- The access-token TTL value itself — not decided by ADR-0005 or this document, but it
  directly bounds how long a user stays logged in after their organization's license lapses.
  A shorter TTL means faster enforcement but more frequent `payment-service` calls (per the
  new availability coupling above); this tradeoff needs an explicit decision, likely at the
  SDD level or its own ADR if the choice turns out to be hard to reverse.
- What mechanism actually detects that an organization's license has lapsed or been renewed,
  in order to trigger the suspend/resume flow from ADR-0006 — that detection lives entirely
  inside `payment-service` and is out of scope for this document.
