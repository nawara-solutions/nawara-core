# payment-service

- **Status:** Draft <!-- Draft | Reviewed | Implemented -->
- **Owners:** Anwar (project owner)
- **Related ADRs:** [0006](../adr/0006-per-user-subscription-reservation-on-license-lapse.md)
  (per-user subscription reservation on organization license lapse — the primary decision this
  document expands on). Also referenced: [0004](../adr/0004-synchronous-fail-closed-license-validation.md)
  (`auth-service`'s assumed license-status contract, finalized here) and
  [0005](../adr/0005-bounded-time-license-subscription-revalidation.md) (`auth-service`'s
  login/refresh calls into the endpoints this document defines).
- **Related ADDs/SDDs:** [docs/add/auth-service.md](./auth-service.md) is this document's main
  consumer (its `OrganizationValidationService` calls the endpoints defined here). A
  corresponding SDD, `docs/sdd/payment-service.md`, follows this ADD.

## Scope

This is `payment-service`'s first design document — until now it existed only as a bare Nest
CLI scaffold with a one-line description in `CLAUDE.md` (a gateway-agnostic billing engine
around a generic `Product`/`Charge` model). This document covers the slice of that model needed
to support `ADR-0006`: the two status endpoints `auth-service` depends on
(`GET /payment/licenses/:organizationId/status`, finalizing `ADR-0004`'s assumed contract, and
a new `GET /payment/subscriptions/:userId/status`), and the suspend/resume ("reservation")
mechanics that run when an organization's license lapses and later recovers, plus the events
`payment-service` publishes as a result.

Explicitly out of scope:

- The actual purchase/checkout flow — how a `Product` gets bought and a `Charge` created in the
  first place. Nothing about this feature requires redesigning that; it only requires that a
  `License` or `UserSubscription` row already exists by the time it's checked or suspended.
  Flagged as future work, see Open questions.
- Payment gateway adapter specifics (Flouci, Konnect, Paymee, Stripe). `CLAUDE.md` already
  establishes that these live behind a common interface so adding a gateway doesn't touch
  business logic; this document doesn't design that interface's details.
- Which roles or users ever get a `UserSubscription` in the first place — that's a
  consuming-app decision (`nawara-drive` or any future app), never `payment-service`'s. This
  document only covers what happens to a `UserSubscription` that already exists.
- RabbitMQ infrastructure itself (broker, exchange/queue conventions, client library) — none
  exists anywhere in this repo yet, same gap already flagged in `auth-service`'s ADD.

## Context

`apps/payment-service/` is currently a bare, unmodified Nest CLI scaffold — no modules,
entities, or endpoints exist. This document gives it its first real shape, scoped narrowly to
what `ADR-0006` requires, rather than designing the whole billing engine `CLAUDE.md` describes
at once.

Today's and near-term callers of `payment-service`:

- **`auth-service`** — the first and, for now, only real consumer. Calls
  `GET /payment/licenses/:organizationId/status` from `POST /auth/organizations/validate`,
  `POST /auth/register`, `POST /auth/login`, and `POST /auth/refresh` (per `ADR-0004`/
  `ADR-0005`), and `GET /payment/subscriptions/:userId/status` from the latter two (per
  `ADR-0006`). This is a synchronous, fail-closed dependency — `payment-service` being down
  now blocks `auth-service` login and token refresh, not just registration (see
  `docs/add/auth-service.md`'s non-functional constraints).
- **`notification-service`**, indirectly, via the async events `payment-service` publishes
  (below) — no direct API call.
- **Consuming apps** (e.g. `nawara-drive`), eventually, for the purchase/checkout flow itself —
  explicitly out of scope here (see Scope).

## Component overview

At the architecture level, this document adds four logical components to `payment-service`:

- **`LicensesModule`** (`LicensesController`, `LicensesService`) — owns the `License` entity
  (one per organization) and implements `GET /payment/licenses/:organizationId/status`,
  finalizing the contract `auth-service` has assumed since `ADR-0004`.
- **`SubscriptionsModule`** (`SubscriptionsController`, `SubscriptionsService`) — owns the
  `UserSubscription` entity (one per user who has ever purchased individual access) and
  implements `GET /payment/subscriptions/:userId/status`.
- **`LicenseLapseService`** — detects when a `License`'s status changes (active → expired,
  or expired → active again) and, on each transition, suspends or resumes every
  `UserSubscription` under that organization and publishes the lifecycle events below. The
  exact detection mechanism (a scheduled sweep vs. reacting to whatever process renews/revokes
  a license) is not decided by this document — see Open questions.
- **`ProductsModule`/`ChargesModule`** — the generic catalog (`Product`) and payment-transaction
  (`Charge`) concepts from `CLAUDE.md`. A successful `Charge` against an `org_license`-type or
  `individual_subscription`-type `Product` is what creates the corresponding `License` or
  `UserSubscription` row in the first place — the purchase flow itself is out of scope here,
  but the resulting entities are what `LicensesModule`/`SubscriptionsModule` operate on.

```mermaid
graph LR
  subgraph Consumers
    Auth[auth-service]
  end

  Auth -- "REST/HTTPS (license status)" --> LicensesController
  Auth -- "REST/HTTPS (subscription status)" --> SubscriptionsController

  subgraph payment-service
    LicensesController --> LicensesService
    SubscriptionsController --> SubscriptionsService
    LicensesService --> LicenseLapseService
    LicenseLapseService --> SubscriptionsService
  end

  LicensesService --> PaymentDB[(payment-service Postgres DB)]
  SubscriptionsService --> PaymentDB
  LicenseLapseService -. license.expired / license.reactivated .-> Broker[[RabbitMQ]]
  SubscriptionsService -. subscription.suspended / subscription.resumed .-> Broker
```

`auth-service` only ever calls the two `*Controller` read endpoints — it has no visibility into
`LicenseLapseService` or the event-publishing side, consistent with `payment-service` owning
this data end to end. `LicenseLapseService` is the only component that mutates a
`UserSubscription`'s status as a side effect of something other than its own owner's action
(purchase, or an eventual cancellation flow, both out of scope here).

## Communication & data flow

Two synchronous read endpoints, both consistent with this repo's "API is the only contract"
principle:

1. **`GET /payment/licenses/:organizationId/status`** → `{ valid: boolean, expiresAt: Date | null }`.
   Finalizes the shape `auth-service` has assumed since `ADR-0004`. Returns `{valid: false,
   expiresAt: null}` for both "no license exists for this organization" and "license expired" —
   deliberately not distinguished, mirroring the same enumeration-avoidance reasoning
   `auth-service` already applies to its own client-facing response.
2. **`GET /payment/subscriptions/:userId/status`** → `{ exists: boolean, valid: boolean,
   expiresAt: Date | null }`. `exists: false` means no `UserSubscription` row was ever created
   for this user — `auth-service` treats that as "not applicable," never as a reason to block
   login/refresh (per `ADR-0006`). `exists: true, valid: false` covers both `suspended` and
   naturally `expired` subscriptions.

Four async events, published for side effects consistent with `CLAUDE.md`'s "async events for
side effects" principle, and following the exact conventions `auth-service`'s `user.registered`
event already established (flat primitive payload, `resource.past_tense_verb` naming,
publisher stays decoupled from `notification-service`'s channel/template concerns):

- **`license.expired`** / **`license.reactivated`** — `{ organizationId, ownerId, timestamp }`,
  where `ownerId` is the `userId` of whoever purchased the organization's license — published
  by `LicenseLapseService` so `notification-service` can inform that admin, without
  `payment-service` needing to know anything about notification channels or templates.
- **`subscription.suspended`** — `{ userId, organizationId, frozenRemainingSeconds, timestamp }`
- **`subscription.resumed`** — `{ userId, organizationId, restoredExpiresAt, timestamp }`

Both published per-affected-user by `SubscriptionsService` when `LicenseLapseService` triggers
a suspend/resume pass over an organization's subscriptions.

**Infrastructure gap:** no RabbitMQ broker, exchange/queue naming convention, or client library
exists anywhere in this repo yet (same gap already flagged in `auth-service`'s ADD) — all four
events above are design recommendations, not components that can be built today without that
follow-up infrastructure work landing first.

**Data ownership:** `payment-service` is the sole owner and writer of `Product`, `Charge`,
`License`, and `UserSubscription` records, in its own dedicated Postgres database, never shared
with any other service. `organizationId` and `userId` values stored on `License`/
`UserSubscription` are opaque foreign references (stamped from the JWT at purchase time) —
`payment-service` never queries `auth-service`'s database directly to resolve them, consistent
with this repo's database-per-service principle.

## Non-functional constraints

- **`payment-service` is now a hard dependency for login, not just registration.** Per
  `ADR-0005`, if `payment-service` is down or slow, `auth-service` cannot complete a login or
  token refresh for anyone. This makes `payment-service`'s own availability and the two status
  endpoints' response latency directly load-bearing for the whole system's ability to
  authenticate — a materially higher bar than a service whose only caller was a registration
  flow.
- **Status endpoints must stay cheap and fast.** Both endpoints are called on every login and
  refresh across the whole system (per `ADR-0005`); they should be simple indexed lookups
  (`organizationId` on `License`, `userId` on `UserSubscription`), not anything requiring a
  join across gateway/payment-provider data on the hot path.
- **RabbitMQ infra gap** (as above) — the four lifecycle events are undeliverable until that
  infrastructure exists.
- **Idempotency of suspend/resume.** `LicenseLapseService` must treat re-triggering a
  suspend or resume pass on an already-suspended or already-active subscription as a no-op —
  whatever detection mechanism is chosen (see Open questions) may fire more than once for the
  same transition.

## Open questions

- The exact mechanism `LicenseLapseService` uses to detect that a license has lapsed or been
  renewed (a scheduled sweep over `License.expiresAt`, vs. reacting synchronously to whatever
  process renews/revokes a license) — not decided by this document; belongs in
  `docs/sdd/payment-service.md` or its own ADR if the choice turns out to be hard to reverse.
- The purchase/checkout API shape for creating a `Product`/`Charge`/`License`/
  `UserSubscription` in the first place — explicitly out of scope for this pass.
- Payment gateway adapter interface specifics (Flouci, Konnect, Paymee, Stripe) — out of scope
  here, per `CLAUDE.md`.
- Whether `License` should support a grace period between expiry and actually triggering
  suspension/logout (e.g. a few days of leeway) — not a requirement surfaced yet, flagged as a
  possible future product decision.
- A retry/outbox strategy for reliably publishing the four lifecycle events once RabbitMQ
  infrastructure actually exists, so a crash between suspending a subscription and publishing
  its event doesn't silently drop the notification.
