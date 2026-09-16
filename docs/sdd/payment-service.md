# payment-service

- **Status:** Draft <!-- Draft | Reviewed | Implemented -->
- **Owners:** Anwar (project owner)
- **Related ADD:** [docs/add/payment-service.md](../add/payment-service.md)
- **Related ADRs:** [0004](../adr/0004-synchronous-fail-closed-license-validation.md)
  (`auth-service`'s assumed license-status contract, finalized here),
  [0005](../adr/0005-bounded-time-license-subscription-revalidation.md) (`auth-service`'s
  login/refresh calls into the endpoints below),
  [0006](../adr/0006-per-user-subscription-reservation-on-license-lapse.md) (the primary
  decision this document implements).

## Responsibility

`payment-service` owns `Product`, `Charge`, `License`, and `UserSubscription` data, and answers
two yes/no questions other services depend on: does an organization currently hold a valid
license, and does a given user currently hold a valid individual subscription. It detects when
an organization's license lapses or is renewed, and on each transition suspends or resumes
every affected `UserSubscription` under that organization — freezing unused subscription time
rather than losing it — and publishes events so `notification-service` can inform the affected
users.

It explicitly does **not** own:

- What a `role` means, or which roles/users ever get a `UserSubscription` in the first place.
  That's entirely a consuming-app decision (per `ADR-0006`); `payment-service` only ever
  observes whether a `UserSubscription` row exists, never why.
- Any `auth-service` data (`User`, `RefreshToken`, credentials). `organizationId` and `userId`
  values stored here are opaque foreign references, stamped from the JWT at purchase time —
  never resolved via a cross-service database query.
- Notification delivery. `payment-service` publishes domain events; translating those into an
  actual push/SMS/email is entirely `notification-service`'s job.
- The purchase/checkout flow itself (out of scope per the ADD — see that document's Open
  questions).

## Data model

```mermaid
erDiagram
    PRODUCT ||--o{ CHARGE : "purchased via"
    CHARGE ||--o| LICENSE : "creates (org_license)"
    CHARGE ||--o| USER_SUBSCRIPTION : "creates (individual_subscription)"

    PRODUCT {
        uuid id PK
        string type "org_license | individual_subscription | one_time"
        string name
        int priceAmount
        string priceCurrency
        timestamp createdAt
    }

    CHARGE {
        uuid id PK
        uuid productId FK
        uuid payerId "userId who paid"
        string organizationId "nullable, denormalized"
        string gatewayProvider "flouci | konnect | paymee | stripe"
        string gatewayReference
        int amount
        string currency
        string status "pending | succeeded | failed | refunded"
        timestamp createdAt
    }

    LICENSE {
        uuid id PK
        string organizationId UK
        uuid ownerId "userId who purchased it"
        uuid chargeId FK
        string status "active | expired"
        timestamp expiresAt
        timestamp createdAt
        timestamp updatedAt
    }

    USER_SUBSCRIPTION {
        uuid id PK
        uuid userId
        string organizationId "denormalized from JWT at purchase time"
        uuid chargeId FK
        string status "active | suspended | expired"
        timestamp expiresAt "nullable while suspended"
        int frozenRemainingSeconds "nullable, set only while suspended"
        timestamp createdAt
        timestamp updatedAt
    }
```

Notes:

- `Product`/`Charge` are the generic catalog/transaction concepts from `CLAUDE.md`; their full
  design (pricing rules, gateway-specific fields, refund handling) is out of scope here — only
  the fields this feature depends on are shown. A successful `Charge` against an
  `org_license`-type `Product` creates a `License` row; against an `individual_subscription`-type
  `Product`, a `UserSubscription` row. The purchase flow that performs this creation is out of
  scope (see the ADD).
- `License.organizationId` is unique — one active license per organization at a time. `ownerId`
  is the `userId` of the purchasing admin, used to address the `license.expired`/
  `license.reactivated` notification (per `ADR-0006`).
- `UserSubscription.organizationId` is denormalized from the JWT at purchase time specifically
  so `LicenseLapseService` can find every subscription under a lapsing organization using only
  `payment-service`'s own data — never a cross-service query (per `ADR-0006`).
- `UserSubscription.expiresAt` and `frozenRemainingSeconds` are mutually exclusive in practice:
  `active` rows have `expiresAt` set and `frozenRemainingSeconds` null; `suspended` rows have
  the reverse. A `suspended` row's clock has stopped — only a resume operation restarts it.
- No `auth-service` data (`User`, `RefreshToken`) is referenced by foreign key anywhere in this
  schema — `userId`/`organizationId` columns are opaque strings, per the ADD's data-ownership
  section.

## Key interfaces / classes

```mermaid
classDiagram
    class LicensesController {
      +getStatus(organizationId) LicenseStatusResponse
    }
    class LicensesService {
      -licenseRepository: Repository~License~
      +getStatus(organizationId) LicenseStatusResponse
    }
    class SubscriptionsController {
      +getStatus(userId) SubscriptionStatusResponse
    }
    class SubscriptionsService {
      -subscriptionRepository: Repository~UserSubscription~
      -eventPublisher: EventPublisher
      +getStatus(userId) SubscriptionStatusResponse
      +suspendAllForOrganization(organizationId) void
      +resumeAllForOrganization(organizationId) void
    }
    class LicenseLapseService {
      -licenseRepository: Repository~License~
      -subscriptionsService: SubscriptionsService
      -eventPublisher: EventPublisher
      +handleExpiry(organizationId) void
      +handleReactivation(organizationId) void
    }
    class EventPublisher {
      +publish(eventName, payload) void
    }
    class LicenseStatusResponse {
      +valid: boolean
      +expiresAt: Date?
    }
    class SubscriptionStatusResponse {
      +exists: boolean
      +valid: boolean
      +expiresAt: Date?
    }
    class License {
      +id: string
      +organizationId: string
      +ownerId: string
      +status: string
      +expiresAt: Date
      +createdAt: Date
      +updatedAt: Date
    }
    class UserSubscription {
      +id: string
      +userId: string
      +organizationId: string
      +status: string
      +expiresAt: Date?
      +frozenRemainingSeconds: number?
      +createdAt: Date
      +updatedAt: Date
    }
    LicensesController --> LicensesService
    LicensesService --> License
    LicensesService ..> LicenseStatusResponse
    SubscriptionsController --> SubscriptionsService
    SubscriptionsService --> UserSubscription
    SubscriptionsService ..> SubscriptionStatusResponse
    SubscriptionsService --> EventPublisher
    LicenseLapseService --> LicensesService
    LicenseLapseService --> SubscriptionsService
    LicenseLapseService --> EventPublisher
```

Module boundaries: `LicensesModule` (`LicensesController`/`LicensesService`/`License` entity)
owns the read-only status check `auth-service` calls, and is otherwise not responsible for
detecting lapses. `SubscriptionsModule`
(`SubscriptionsController`/`SubscriptionsService`/`UserSubscription` entity) owns both the
status check and the actual suspend/resume mutation, but never decides *when* to call them —
that's `LicenseLapseService`'s job. Both `LicenseLapseService` (for the org-level
`license.expired`/`license.reactivated` events) and `SubscriptionsService` (for the per-user
`subscription.suspended`/`subscription.resumed` events, published as part of the same
suspend/resume mutation — see flows (a)/(b) below) publish directly through `EventPublisher`.
`LicenseLapseService` is the only component that ties a license-state transition to a batch of
subscription mutations in the first place; it depends on both other services but neither of
them depends on it, keeping the read path (`auth-service`'s hot-path calls) free of any
lapse-detection logic. `EventPublisher` is a thin
wrapper around whatever RabbitMQ client eventually lands (per the ADD's infrastructure gap) —
its interface is stable even though its implementation can't be built yet.

## API contract

- **`GET /payment/licenses/:organizationId/status`** → `200 { valid: boolean, expiresAt: Date |
  null }`. No license found for this `organizationId`, or its license has expired → the same
  `{valid: false, expiresAt: null}` shape for both, deliberately not distinguished (mirrors the
  enumeration-avoidance reasoning `auth-service` already applies at its own boundary). This is
  the contract `auth-service` has assumed since `ADR-0004`, now finalized.

- **`GET /payment/subscriptions/:userId/status`** → `200 { exists: boolean, valid: boolean,
  expiresAt: Date | null }`.
  - No `UserSubscription` row ever created for this user → `{exists: false, valid: false,
    expiresAt: null}`.
  - `active` and not past `expiresAt` → `{exists: true, valid: true, expiresAt}`.
  - `suspended`, or `active` but past `expiresAt` (naturally expired) → `{exists: true, valid:
    false, expiresAt}` (`expiresAt` is `null` for a `suspended` row, since it's cleared while
    frozen — see Data model).

Both endpoints are internal, service-to-service calls in v1 (no API gateway exists in this
repo, per `auth-service`'s ADD) — they carry no separate authentication of their own beyond
whatever network-level trust exists between `nawara-core` services today, which this document
does not change or strengthen.

## Important flows

**(a) License lapse detected → suspend affected subscriptions and notify**

```mermaid
sequenceDiagram
    participant LLS as LicenseLapseService
    participant LS as LicensesService
    participant SS as SubscriptionsService
    participant DB as payment-service DB
    participant EP as EventPublisher
    participant Broker as RabbitMQ

    LLS->>LS: mark License expired (organizationId)
    LS->>DB: UPDATE License SET status = 'expired'
    DB-->>LS: License row
    LS-->>LLS: License (ownerId, organizationId)
    LLS->>EP: publish license.expired {organizationId, ownerId, timestamp}
    EP-)Broker: license.expired
    LLS->>SS: suspendAllForOrganization(organizationId)
    SS->>DB: SELECT UserSubscription WHERE organizationId = ? AND status = 'active'
    DB-->>SS: active UserSubscription rows
    loop each active subscription
        SS->>SS: frozenRemainingSeconds = expiresAt - now
        SS->>DB: UPDATE status='suspended', expiresAt=null, frozenRemainingSeconds=...
        SS->>EP: publish subscription.suspended {userId, organizationId, frozenRemainingSeconds, timestamp}
        EP-)Broker: subscription.suspended
    end
```

**(b) License reactivated → resume affected subscriptions and notify**

```mermaid
sequenceDiagram
    participant LLS as LicenseLapseService
    participant LS as LicensesService
    participant SS as SubscriptionsService
    participant DB as payment-service DB
    participant EP as EventPublisher
    participant Broker as RabbitMQ

    LLS->>LS: mark License active (organizationId)
    LS->>DB: UPDATE License SET status = 'active'
    DB-->>LS: License row
    LS-->>LLS: License (ownerId, organizationId)
    LLS->>EP: publish license.reactivated {organizationId, ownerId, timestamp}
    EP-)Broker: license.reactivated
    LLS->>SS: resumeAllForOrganization(organizationId)
    SS->>DB: SELECT UserSubscription WHERE organizationId = ? AND status = 'suspended'
    DB-->>SS: suspended UserSubscription rows
    loop each suspended subscription
        SS->>SS: expiresAt = now + frozenRemainingSeconds
        SS->>DB: UPDATE status='active', expiresAt=..., frozenRemainingSeconds=null
        SS->>EP: publish subscription.resumed {userId, organizationId, restoredExpiresAt, timestamp}
        EP-)Broker: subscription.resumed
    end
```

**(c) auth-service checking license/subscription status (login or refresh)**

```mermaid
sequenceDiagram
    participant Auth as auth-service
    participant LC as LicensesController
    participant SC as SubscriptionsController
    participant DB as payment-service DB

    Auth->>LC: GET /payment/licenses/:organizationId/status
    LC->>DB: SELECT License WHERE organizationId = ?
    DB-->>LC: License row or none
    LC-->>Auth: {valid, expiresAt}
    alt org license valid
        Auth->>SC: GET /payment/subscriptions/:userId/status
        SC->>DB: SELECT UserSubscription WHERE userId = ?
        DB-->>SC: UserSubscription row or none
        SC-->>Auth: {exists, valid, expiresAt}
    end
```

## Error handling & edge cases

- Organization has no `License` row at all vs. an expired one → identical `{valid: false,
  expiresAt: null}` response, deliberately not distinguished (see API contract).
- User has no `UserSubscription` row at all → `{exists: false, valid: false, expiresAt: null}`;
  `auth-service` treats `exists: false` as "not applicable," never as a block (per `ADR-0006`).
- `LicenseLapseService.handleExpiry`/`handleReactivation` triggered more than once for the same
  transition (whatever the eventual detection mechanism turns out to be) → idempotent:
  `suspendAllForOrganization`/`resumeAllForOrganization` only operate on rows currently in the
  opposite state (`active`→suspend, `suspended`→resume), so a repeat call finds nothing left to
  do and is a no-op.
- A `UserSubscription` that naturally reaches its own `expiresAt` (unrelated to any
  organization license lapse) → moves directly to `expired`, not `suspended` — there is nothing
  to freeze or later resume, since the user's own paid time genuinely ran out. The lapse-sweep
  in flow (a) only selects rows still `active`, so an already-`expired` row is never touched.
- A `UserSubscription` suspended due to an organization's license lapse, whose
  `frozenRemainingSeconds` would have naturally expired *during* the suspension window (i.e.
  its original `expiresAt` was already in the past at suspension time) → `frozenRemainingSeconds`
  is computed as `expiresAt - now` at the moment of suspension per flow (a); if that value is
  zero or negative, the subscription is moved directly to `expired` instead of `suspended` —
  there's no remaining time to bank.
- Publishing any of the four lifecycle events fails (once RabbitMQ infrastructure exists) →
  not designed by this document; flagged as an open question (retry/outbox strategy) in the
  ADD.
- Concurrent purchase and lapse-detection for the same user/organization (e.g. a user buys a
  subscription in the same moment their organization's license lapses) → not designed by this
  document; deferred to a future TDD once the purchase flow itself is designed.

## Open questions

- The exact license-lapse detection mechanism (scheduled sweep vs. reacting to a
  renew/revoke trigger) that calls `LicenseLapseService.handleExpiry`/`handleReactivation` in
  the first place — not decided here (see the ADD's Open questions).
- Whether the two status endpoints need any authentication/authorization of their own beyond
  implicit network trust, once more than one internal caller exists.
- A retry/outbox strategy for the four lifecycle events once RabbitMQ infrastructure lands.
- Locking/concurrency behavior for `suspendAllForOrganization`/`resumeAllForOrganization` at
  scale (many subscriptions under one organization, or overlapping sweep runs) — deferred to a
  future TDD.
- Whether `License`/`UserSubscription` should support a grace period before a lapse actually
  triggers suspension (see the ADD's Open questions).
- The purchase/checkout flow that creates `Product`/`Charge`/`License`/`UserSubscription` rows
  in the first place — out of scope for this pass.
