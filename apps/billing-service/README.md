# billing-service

Answers: **what is owed, why, how much, in which currency, by whom, to whom, and when?** The design contract is
[`docs/sdd/billing-service.md`](../../docs/sdd/billing-service.md); how it fits beside payment-service and accounting-service is in
[`docs/architecture/financial-architecture.md`](../../docs/architecture/financial-architecture.md). It is **not** the payment or
accounting system: it never moves money and keeps no ledger.

## Status: Stage 4 (Payment integration) + Stage 12.2-12.7 (Subscription/Entitlement, real-broker integration)

The full cross-service loop with payment-service (SDD section 21), on top of Stage 3's HTTP API and the Stage 2 domain/schema
foundation, plus the Subscription domain, entitlement derivation, Payment→Subscription linking, the effective-access HTTP
contract, concurrency hardening and real-RabbitMQ-broker integration built in Stage 12 (sections below). Billing can now
actually ask Payment to collect an invoice, learn the outcome, recover from a distributed failure, and — for a recurring
obligation — activate/renew an Organization's Subscription and answer "does this Organization have effective commercial
access" over a real broker. **Not production-ready** and not deployed. See
[ADR-0044](../../docs/adr/0044-subscription-entitlement-final-model.md) for the Subscription/Entitlement decision record.
Design and test detail: [`docs/tdd/billing-service-domain-schema.md`](../../docs/tdd/billing-service-domain-schema.md) and
[`docs/tdd/billing-service-http-api.md`](../../docs/tdd/billing-service-http-api.md).

### Implemented

- **Schema** (`db/migrations/0001..0009`): `currency` (immutable reference, BI-21), `platform_currency` (Platform-enabled currencies, foundation only, B-036), `product` and `price` (immutable), `invoice`,
  `invoice_line`, `invoice_number_sequence`, `payment_request`, `payment_event_receipt`, `billing_transition`. Integer minor units
  (`bigint`, capped at 2^53-1) only; no float or money type anywhere.
- **Financial invariants BI-01 .. BI-21 enforced by the database** (CHECKs, composite foreign keys, unique and partial unique
  indexes, an immutable-by-default allow-list trigger, deferred constraint triggers for totals and history, append-only and
  no-delete guards), so no code path, including a bug or the runtime role, can break them.
- **Invoice target routing (Core V2 S3a; ADR-0044 B1 / B2, Owner decision Option C; `db/migrations/0019`, `0020`,
  `src/domain/invoice-routing.ts`):** every product declares `subscriptionTarget` (`none` | `organization` | `personal`); a
  subscription product names its `platformId` (one of the producer's `allowedPlatforms`) and has recurring prices only; both fields are
  immutable. Issuing an invoice records, in the same transaction, an immutable `invoice_entitlement` decided by the server from its own
  rows (never from `entitlementKind`): `organization_subscription` (a user pays an Organization's subscription; the Organization must
  belong to the product's Platform, verified through Billing's Organization authority), `direct_purchase` (a user buys a personal
  product for themself) or `non_entitlement` (no subscription line). Anything else, including an Organization paying a subscription
  (B7) and the not-yet-available assisted and recovery settlements, is `422 invoice_routing_invalid` and the invoice stays a draft.
  The database enforces DB-1 to DB-4 (append-only with INSERT / SELECT only for the runtime role, one record per issued invoice at
  commit, the valid combinations, the payer and the product target by composite keys). A paid invoice changes an Organization's
  Subscription only through an `organization_subscription` record for that Organization; an invoice issued before S3a (no record) is
  never routed after the fact and is logged `payment_event_subscription_unrouted`.
- **Verified settlement activation (Core V2 S3b; ADR-0044 B3, S-4, DB-9 to DB-11; `db/migrations/0021`):** an Organization
  Subscription starts or extends a period ONLY in the transaction that applies Payment's verified settlement (the applied
  `payment.succeeded` receipt: a provenance-verified Payment event or the reconciler's direct read of Payment) to an
  `organization_subscription` invoice, and records it as an append-only `subscription_settlement` (INSERT / SELECT only for the runtime
  role). The database checks the evidence (the applied receipt, the request and the invoice `paid`), that the settlement names the
  routing record's own Organization and product (DB-9), one settlement per invoice and per receipt (DB-10), and, at commit, that no
  period started or extended without a settlement in the same transaction (DB-11). The direct `activate()` / `renew()` operations are
  retired; grace, expiry, cancellation and termination are unchanged. Recovery payments (S6) settle into their own table when that slice
  exists.
- **Personal Subscriptions (Core V2 S3c; ADR-0044 B4, B5, B6; K-3 Option D; DB-9, DB-10, DB-12; `db/migrations/0022`):** a routed
  `direct_purchase`, settled through the same verified evidence as S3b (the applied `payment.succeeded` receipt, request and invoice
  `paid`), appends one `subscription_purchase` to its BENEFICIARY's `personal_subscription` (one per user + product; the product is a
  `personal` product of exactly one Platform, so several coexist per user and Platform; no universal plan). The ledger is append-only
  (INSERT / SELECT only for the runtime role): purpose `direct_purchase` only and a composite FK to the routing record's beneficiary and
  product (DB-9), one purchase per invoice and per receipt (DB-10), one per assistance request (DB-12; the column stays empty until S5a).
  Validity is ONE fold in the database, `billing_personal_spans` (K-3 Option D): purchases in ledger order, reversed ones removed; each
  starts at the later of its settlement and the end of the previous kept period and lasts its price's full interval (a continuing
  month / year period keeps the chain's billing anchor); laying and re-laying are the same computation. `subscription_purchase_reversal`
  allows one reversal per purchase (written by S6's refund / chargeback flows). B6:
  `GET /billing/users/:userId/platforms/:platformId/products/:productId/entitlement` (service token, `entitlement.read`, the Platform
  in the caller's `allowedPlatforms`, the product a personal product of it, else `404`) answers `{ valid, expiresAt }`, no grace.
- **Platform commercial configuration (Core V2 S3d; register BIL-01, AUTH-07; `db/migrations/0023`, `src/platforms/`):**
  `billing_platform` holds, per Platform, its Company and its ONE currency; it is append-only (never changed or deleted). Only an Owner
  writes it, with their OWN bearer, verified live through Auth's existing routes (`GET /auth/grants`: an Owner, and their Company;
  `GET /auth/platform-access/:platformId`: the Platform is in that Company), never a service token (`401`, not forwarded). `companyId`
  comes from Auth, never from the request. `POST /billing/admin/platforms/:platformId` `{currency}` answers `201`, an identical repeat
  `200` (`Idempotent-Replayed`), another currency `409 billing_platform_exists`; `GET` reads it. A member or an operator is `403`; an
  unknown or another Company's Platform is the same `404` (never confirmed); Auth unavailable is `503 auth_timeout | auth_unavailable`
  and nothing is written. No step-up (the Owner's Q11 decision for S3d). A NEW subscription product (`organization` / `personal`)
  requires its Platform's row (`409 platform_not_configured`, also a database guard), and a subscription product's prices use that
  currency (`422 unsupported_currency`, also a database guard). Nothing existing is backfilled or rewritten. `platform_currency` (0009)
  is superseded for Core V2 (OD-02): left as it is, with its data, and nothing new reads or writes it.
- **Organization fees (Core V2 S3f; register BIL-04 to BIL-07; the Owner's decisions A1 to A5; `db/migrations/0025`, `src/fees/`):** the
  optional, member-funded fee an Organization may add to one ACTIVE `personal` subscription product of its Platform (used by S5). The
  Owner sets ONE maximum fixed fee per Platform in its S3d currency (minor units, ≥ 0, no percentage; versioned and immutable; no cap
  means 0), delegates proposing to one operator per Platform (no expiry; explicit revocation), and alone approves or rejects; a delegated
  operator proposes `{organizationId, productId, amount}` and may withdraw while pending. Every actor and scope is verified live through
  Auth's existing routes (`/auth/grants`, `/auth/platform-access`, `/auth/admin/organizations/:id`, and the Owner's
  `/auth/admin/operators/:id/platform-assignments`); a service token is never a fee actor. The database serializes a Platform's fee
  writes, enforces the CURRENT cap at proposal and approval, one pending proposal per (Organization, product), one active delegation per
  (Platform, operator), and one-way decisions; `billing_fee_for_use` re-checks the cap at the point of use. Every command needs an
  `Idempotency-Key` (class K: per actor, bound to the exact request, kept permanently, a success replayed). Fees create no invoice,
  payment request, settlement or purchase. Direct checkout (BIL-10) is built for simulation only (below).
- **Direct checkout (Core V2 S3f; register BIL-10 G; the Owner's D1 to D6, D4 Option A; `db/migrations/0026`, `src/checkout/`) —
  DEVELOPMENT AND SIMULATION ONLY:** `POST /billing/checkout/direct` with the member's own bearer (live `/auth/me`: active, no admin
  tier), an `Idempotency-Key` and exactly `{platformId, productId, priceId}`. One transaction creates and issues a one-line invoice
  (quantity 1, `direct_purchase` to the member, no Organization) under the reserved producer `billing-checkout` and its payment request;
  the existing dispatcher contacts Payment later (`paymentId` null until then; poll `GET /billing/payment-requests/:id`). The seller is
  the Platform's Company from `billing_platform`, used as a **simulation commercial seller reference — not a verified legal seller, not
  Nawara's registered operating Company**; the snapshots are version-2 **references** (`legalIdentity: not_determined`), never invented
  identity. Only Payment's verified `payment.succeeded` records the purchase and grants entitlement. **Production refuses it** (not
  mounted under `NODE_ENV=production`; the service refuses too) until B-001 and B-007 are resolved and production activation is
  separately authorized.
- **Organization assistance (Core V2 S5a; register BIL-13 F, BIL-14 F, BIL-15 F and G; the Owner's D-1 to D-12; `db/migrations/0029`,
  `src/assistance/`) — DEVELOPMENT AND SIMULATION ONLY:** every caller uses their own bearer, verified live through `/auth/me` on each
  request, plus the Organization reference (unavailable: `503`, nothing written). A beneficiary (an active ordinary member with an
  active membership in the Organization on its Platform) consents explicitly through `POST /billing/assistance-requests`
  `{organizationId, productId, priceId, consent: true}`. Billing freezes the price, the Organization's current approved fee (0 when
  none; above the current cap `409 fee_not_usable`), the fee proposal, the cap version and the total. At most one unresolved request
  exists per beneficiary, Organization and product. The beneficiary or an Organization actor (an administrator membership, the S4e
  model) may `decline` a pending request, and the decline is final. Only an Organization actor who is not the beneficiary may report
  `cash-collection` `{cashCollectedAt}`, which sets `settleBy` to exactly 72 hours later. `GET /billing/assistance-requests/:id`
  derives `overdue` from the database clock. Commands use class-K idempotency, and each change carries its audit action in the same
  transaction.
  - **A cash report is evidence, never settlement.** It creates no invoice, payment, purchase, entitlement or domain event.
  - Restrictions (T1, T2, T3, inactivity) belong to S5d and are not evaluated here.
  - **Production refuses it:** the routes are not mounted, and the service refuses too.
- **Owner catalog administration (Core V2 S3g; register BIL-02 F, BIL-03 F; the Owner's decisions D-CAT-1 to D-CAT-10;
  `db/migrations/0027`, `src/catalog/owner-catalog.*`) — DEVELOPMENT AND SIMULATION ONLY:** the Owner, with their OWN bearer verified
  live (`/auth/grants`, then `/auth/platform-access/:platformId`; no step-up; a service token `401`), manages the `personal` subscription
  products of their configured Platform: `POST /billing/admin/platforms/:platformId/products` `{code, name, description?, entitlementKind?}`,
  `POST .../products/:productId/prices` `{clientReference, unitAmount, intervalUnit, intervalCount, effectiveFrom}` (recurring, in the
  Platform's currency), `POST .../products/:productId/archive`, `POST .../prices/:priceId/retire` and `GET .../products`. Billing sets the
  seller (`company:<the Platform's Company>`, a simulation reference, not a legal issuer), the target and the reserved provenance
  `billing-owner` (no service may hold that name). Natural keys replay an identical command and refuse other content (`409`); prices may
  coexist; every price write locks its product. Another Company's Platform, another Platform's product and a producer's product are one
  `404`. Direct checkout and new fee proposals accept Owner products only; producer routes and Organization workflows are unchanged.
  Retiring or archiving stops new sales only: nothing issued, settled or purchased changes. **No catalog value is configured: the
  products, durations, amounts and dates are OD-05, approved before the first real configuration.**
- **State machines** (`src/domain/state-machines.ts`): invoice `draft, open, paid, void` (`overdue` is derived from the database
  clock), payment request `created .. rejected`. A test proves TypeScript and the triggers agree on every pair.
- **Snapshots**: party snapshots (container only; content is B-007) and a presentation snapshot v1 (`{schemaVersion, template, locale}`).
- **Numbering foundation**: a concurrency-safe counter per seller at issue; a rolled-back issue returns its number; gaplessness is
  **not** assumed (scope and format are B-004).
- **Currency in three layers**: the global `currency` reference, Platform-enabled currencies (`platform_currency`, with a permission question nothing calls yet) and the immutable historical invoice currency. No Platform currency HTTP API; how an invoice gets its Platform is undecided (B-036). Core V2 S3d (OD-02): the Platform's one currency is `billing_platform`'s; `platform_currency` is superseded for Core V2 and kept untouched.
- **Payment-request mapping** as a pure function of two immutable rows, and **payment-event handling**: a pure decision function plus
  a durable receipt (duplicates, out-of-order, unknown, early events; a `paymentId` is never bound from an event). Billing keeps its
  own `payment_event_receipt` for this rather than the kit's generic `InboxService` — Payment-event deduplication carries Billing
  business semantics (a decision, a detail code, the request/invoice it settles) that does not belong in shared infrastructure.
- **Persistence layer** (`src/invoices`): `InvoiceRepository` (create draft with natural-key idempotency, issue, discard, read) and
  `PaymentRequestRepository` (state-idempotent create, apply a Payment event, plus the Stage 4 dispatch/reconciliation/cancel
  support below). Every state change is one transaction: row lock, change, history row and, on issue, the `invoice.created` outbox
  event.
- **Central audit intent (Stage 18.7.2, ADR-0049; `src/audit/billing-audit.ts`):** `invoice.issued` / `.discarded` / `.paid`,
  `payment_request.created` / `.cancelled`, `subscription.activated` / `.renewed`, `product.created` / `.archived`, `price.created` /
  `.retired`, written through `AuditEventWriter` into the outbox in the change's transaction (beside its `billing_transition` row). The
  actor comes from the change's own `TransitionContext` (service caller, Auth-verified user, or Billing's `payment_event_consumer` /
  `payment_reconciler`); the organization from the persisted invoice, subscription or product seller (catalog corrections G3/G4: null
  for an organization-less invoice or a non-organization seller); a change caused by a Payment event carries its id as `causationId`.
  See the [Stage 18.7 record](../../docs/architecture/stage-18/stage-18-7-core-producer-integration.md).
- **HTTP API** (`src/invoices/*.controller.ts`; OpenAPI at `GET /billing/docs`, mounted only when `SWAGGER_PASSWORD` is set, behind basic
  authentication): products, prices, invoices (create, list, get, issue,
  discard) and payment requests (create, get, cancel). `@nestjs/swagger` decorators on every operation and DTO field.
- **Payment integration** (`src/payment-integration`, SDD section 21):
  - `PaymentClient` port + `HttpPaymentClient` adapter — Billing's domain depends on the interface, never on HTTP directly.
  - `PaymentDispatcher` — a background job (same start/stop shape as the kit's `OutboxRelay`) that claims `created`/stale-`sending`
    payment requests and calls Payment's `POST /payment/payments`, never touching Payment's own state or database directly.
  - `PaymentEventConsumer` — subscribes to Payment's terminal events (`payment.succeeded/failed/cancelled/expired`) and feeds them
    through the SAME decision procedure the reconciler uses; trusts nothing about the wire payload's shape. Its RabbitMQ
    subscription is supervised by the kit's bus: after a lost connection, a lost channel or a broker-side cancel it is
    re-created with bounded backoff and drains the queued backlog; redeliveries are absorbed by `payment_event_receipt`. `/ready`
    reports `rabbitmq-consumer` as failing while the consumer is not attached (the HTTP API does not depend on it, but an
    instance that receives no Payment events should not look healthy). A failure while applying an event is classified: a
    malformed payload, or an identifier PostgreSQL rejects as the wrong type (SQLSTATE class 22, e.g. a `paymentRequestId` that
    is not a uuid), is **permanent** and is dead-lettered at once; anything else (a lost connection, a deadlock) is retried by
    the bus (default 3 retries, 5 s apart, through `billing.payment-events.retry`) and then dead-lettered. A `conflict` or
    `deferred` outcome is not a failure: it is acknowledged and recorded in its `payment_event_receipt` row. See
    "Dead-lettered Payment events" below.
  - `PaymentReconciler` — settles a `requested` payment request that has gone stale with no terminal event, by asking Payment
    directly (`GET /payment/payments/{id}`) and applying the answer through that same decision procedure. A request Payment still
    reports as unpaid is not updated, so the scan is a keyset walk over `(updatedAt, id)` (supported by
    `payment_request_reconcile_idx`): each pass examines one batch and the next resumes after it, starting over from the oldest
    when the end is reached, so later requests are reached however many earlier ones stay unpaid. The position is in memory only.
    This changes no request lifetime: an unpaid request still never expires (B-009 is undecided).
  - Cancel (`POST /billing/payment-requests/{id}/cancel`, producer-only): a request never sent is cancelled locally; a request
    already sent stamps `cancelRequestedAt` and asks Payment to cancel — the request's own terminal state still arrives only
    through the normal event/reconciliation path, never set directly by this endpoint.
- Every Payment lifecycle event carries `producer` (sourced only from the authoritative `PaymentRow` on the Payment side, never
  from client input), checked here as extra isolation evidence alongside the full snapshot Billing already validates.
- Tests: unit (domain rules, input normalisation, no-float source scan), integration (repositories, HTTP API, the dispatcher,
  reconciler, event consumer and cancel endpoint under duplicate/out-of-order/timeout/conflict/deferred scenarios, races, atomicity,
  ownership, runtime role), and a database suite (`npm run test:db`: 225 assertions and 8 concurrency races).

### Subscription domain (Stage 12.2 of the org-wide roadmap; domain/database foundation only)

`subscription` (`db/migrations/0013_subscription.sql`): the CURRENT commercial access period an Organization has purchased
("what access period exists right now?" — never "is this user authorized?", never "was money collected?"). One mutable row per
Organization (`organizationId` is the whole scope; Platform is always derivable through Organization and is never duplicated
here), with the same append-only `billing_transition` history invoice/payment_request already use (widened to a third entity
type) rather than a parallel mechanism. States: `pending, active, grace, expired` — `active -> active` is the one self-loop
(a renewal or a cancellation toggle); there is no `cancel_scheduled`, `terminated`, `past_due` or similar. `SubscriptionRepository`
(`src/subscriptions`) is the only writer: `create`, `activate`, `renew` (one operation for early/on-time/grace/late renewal —
the anchor rule in `src/domain/subscription-period.ts` already accounts for every case), `enterGrace`, `expire`,
`scheduleCancellation`/`reverseCancellation`, `terminate`. Payment-event consumption (Stage 12.4) and the public
effective-access route (Stage 12.5) are described in their own sections below; this section covers the domain/database
foundation only.

`graceUntil` is fixed (Core V2 S3e, ADR-0044 B13; `db/migrations/0024`): exactly 24 hours after `currentPeriodEnd` (an absolute
24 hours, UTC instants, no calendar or time-zone arithmetic), written by the settlement in the SAME statement as the period and frozen
for it; the database refuses any other value or none on every established row (`subscription_grace_fixed`). The V1 setting
`SUBSCRIPTION_GRACE_DAYS` is retired: Billing refuses to start if it is set. Grace is only an access boundary: it never records a
settlement, a purchase or a renewal. Personal Subscriptions have no grace. So `graceUntil` is a trustworthy timestamp from the moment a
period exists, not only once some later sweeper calls `enterGrace` — `enterGrace` itself takes no timestamp at all; it only normalizes
the status label once a grace window that
was already computed exists. `create` distinguishes an identical replay (same organization, same product AND price — state
idempotent) from a genuinely conflicting request (same organization, a DIFFERENT product or price — `409 subscription_conflict`);
it is never a disguised upgrade/downgrade. `productId`/`priceId` are immutable today (no method changes them), which does not
block a future offering-change operation: exactly like every other Billing table, a later migration simply widens the
existing `billing_immutable_except` allow-list the day that operation is actually built.

### Entitlement derivation (Stage 12.3; a logical capability, not a service, not a table)

`deriveEntitlement` (`src/domain/entitlement.ts`) answers, purely from an already-loaded Subscription and an explicitly
supplied `now`, whether an Organization has effective commercial access right now: `{ valid: boolean, expiresAt: Date |
null }` — the frozen V1 contract, nothing else (no reason code, no feature flags). No database query, no HTTP call, no
RabbitMQ, no configuration read (the fixed grace is already on the row, S3e), no `new
Date()` inside it — `now` is always the caller's. It never reads `cancelAtPeriodEnd` at all (structurally, not just
behaviorally, irrelevant to already-purchased access) and treats `active`, `grace` and a possibly-premature `expired`
identically: only `pending` (or no subscription) short-circuits to invalid, because Stage 12.2 already guarantees
`graceUntil`/`effectiveTerminationAt` are authoritative timestamps a delayed status-normalizing sweeper — never
built — cannot invalidate. The read-only effective-access HTTP contract is Stage 12.5's, described below.

### Payment → Subscription integration (Stage 12.4)

A settled `payment.succeeded` for a PaymentRequest whose invoice has exactly one recurring line reaches
`linkSubscription` inside `PaymentRequestRepository.applyPaymentEvent` — the **same** transaction as the
`payment_event_receipt` write and the PaymentRequest/Invoice transition, so all three commit or roll back together.
An invoice with more than one recurring line is rejected at draft creation (`ambiguous_subscription_obligation`,
`invoice.repository.ts`), before any PaymentRequest or Subscription obligation exists. An offering mismatch against
an *existing* Subscription (a settled payment for a different product/price) is recorded as its own conflict
classification but never blocks the underlying financial settlement.

### Effective-access HTTP contract (Stage 12.5)

`GET /billing/organizations/:organizationId/entitlement` (`EntitlementController`, service-token only) — the one
public route, `200 { valid, expiresAt }`, composing `EffectiveAccessService` (`organizationId -> SubscriptionRepository.findForOrganization -> deriveEntitlement`) with the caller-supplied request-time clock. No Subscription,
`pending`, not-yet-started or expired are all `valid: false`, never a 404.

`expiresAt` is the **exclusive access-validity deadline**, not the paid-period end (Core V2 S3e, Owner-confirmed): `graceUntil`, i.e.
`currentPeriodEnd` plus the fixed 24-hour Organization grace, or an earlier `effectiveTerminationAt`; access is valid while
`currentPeriodStart <= now < expiresAt`. The Personal read (`/billing/users/.../entitlement`, S3c) has no grace: its `expiresAt` is the
end of the paid span run. The database check `subscription_grace_fixed` states `graceUntil IS NOT NULL` explicitly because a CHECK that
evaluates to NULL passes in PostgreSQL; this enforces the frozen invariant (S0 §3.9) as written.

### Concurrency/lifecycle hardening (Stage 12.6)

Real-PostgreSQL concurrency races, calling the repository/consumer layer directly (not a real broker — that is
Stage 12.7's): duplicate and concurrent-duplicate delivery, distinct legitimate concurrent renewals, concurrent
first activation, offering-conflict behaviour, live-event-vs-reconciliation overlap, renewal/termination and
renewal/cancellation races, tenant isolation, and the fixed `invoice -> payment_request -> subscription` lock order
under a mixed-race storm (`test/subscription-hardening.e2e-spec.ts`).

### Real-broker integration (Stage 12.7)

Extends the real-broker suite (see "Dead-lettered Payment events" below) through `payment.succeeded` into
Subscription activation and the effective-access contract, against a real RabbitMQ broker and real PostgreSQL, two
separately-spawned already-built processes: golden path, duplicate real-broker delivery (one Subscription effect),
a spoofed event naming a different organization's real PaymentRequest (rejected, zero cross-tenant mutation), Billing
unavailable while Payment settles (durable retention, restart resumes, anchored on the original settlement instant,
not the delayed processing time), and the broker itself unreachable (Payment/outbox unaffected, delivery resumes
once the broker returns) — `test/e2e-real-broker/stage12-7-real-broker-subscription.e2e-spec.ts`.

### Explicitly NOT implemented (deferred by decision, not forgotten; see ADR-0044 and the SDD)

Invoice rendering, templates, PDF, File Service, delivery, QR, signatures, dunning, trials, proration, upgrade/downgrade,
pause/resume, discounts, tax engine, credit notes, refunds (including refund-driven entitlement revocation), real payment
providers, cash, payouts, wallets, accounting ledger, settlement infrastructure, merchant of
record, external customers, branches, multiple legal entities, exchange rates, currency conversion, membership-based payment
authorization, an Entitlement table or persistence of any kind (Entitlement stays a pure derivation, never stored),
feature/quota entitlements, Plan/SubscriptionPlan as a concept above Product/Price, user-scoped (per-user-within-organization)
subscriptions — rejected, not merely deferred, ADR-0044. No table exists for any of the still-fully-deferred ones (a test
asserts the exact table set).

## Dead-lettered Payment events (inspect and replay)

Queues: `billing.payment-events` (work), `billing.payment-events.retry` (delay, no consumer), `billing.payment-events.dead` (the
DLQ, durable, never emptied automatically). Log events (one structured line each, all carry `event=` and `correlationId=`):

| Event | Meaning |
|---|---|
| `payment_event_processing_failure` | applying the event threw; `classification=transient\|permanent`, `retry=<n>`, `error=<class>`, `paymentRequestId=` |
| `event_retry_scheduled` / `event_retry_exhausted` / `event_dead_lettered` | the bus retried, gave up, or moved it to the DLQ (`classification=malformed\|permanent\|retries_exhausted`) |
| `payment_event_dead_letter` | the payload failed the shape check (permanent) |
| `payment_event_replay_succeeded` | a replayed event was applied now |
| `payment_event_replay_duplicate` | a replayed event had already been processed: nothing changed (`recordedOutcome=`) |
| `payment_event_replay_ignored` / `_deferred` / `_conflict` | a replayed event was recorded as ignored / deferred / conflict, like a normal delivery |
| `payment_event_replay_rejected` | a replayed event failed permanently again: it is back in the DLQ |

Runbook (needs `RABBITMQ_URL` and the kit's built CLI, `node libs/service-kit/dist/cli/dlq.js`, which the service image contains like the migrate CLI; the steps abbreviate it as `nawara-dlq`):

1. **Inspect the DLQ.** `nawara-check-dlq --queue billing.payment-events.dead` (depth; exits 1 if non-empty), then
   `nawara-dlq list --queue billing.payment-events.dead --field paymentRequestId`. Nothing is consumed.
2. **Identify the event** (`event=`) and read its `classification`, `reason`, `error` and `retries`. `retries_exhausted` usually means a
   dependency was down (fix that first); `permanent` means the event itself is wrong and a replay will be rejected again unless
   something else has changed.
3. **Replay that one event.** `nawara-dlq replay --queue billing.payment-events.dead --event-id <id>`. Exit 0 = the consumer
   acknowledged it, 2 = rejected again (still in the DLQ), 3 = still pending, 4 = not in the DLQ.
4. **Verify the consumer's result** in Billing's log (`payment_event_replay_*` with the same `event=`), then in the database:
   `SELECT outcome, "detailCode" FROM payment_event_receipt WHERE "eventId" = '<id>';` (exactly one row; `applied`, or `deferred` /
   `conflict` which need the reconciler or a manual review as before).
5. **Verify Billing state and that nothing was applied twice:** `SELECT status FROM payment_request WHERE id = '<paymentRequestId>';`
   and `SELECT count(*) FROM billing_transition WHERE "entityId" = '<paymentRequestId>' AND "causeId" = '<id>';` (at most one).
   Replaying an event that was already processed is a no-op (`payment_event_replay_duplicate`).

Replay cannot settle money: it republishes the original bytes into the work queue and the normal consumer decides, under the
invoice lock, with `payment_event_receipt` as the de-duplication authority. It is not an HTTP endpoint and has no authorization
model of its own: the security boundary is the trusted infrastructure/operator boundary around the broker credentials (whoever holds
them can run it, as with `rabbitmqctl`, and could equally publish to the broker directly). Verified against a real broker (a local test container, not a production broker) and two
live processes in `test/e2e-real-broker/stage4-real-broker-dlq-replay.e2e-spec.ts`; **not** exercised in any deployed environment.

## Configuration

Every value below is read at startup and validated; an invalid or missing required value stops the process.
**Every** value may be given as `NAME_FILE=/path` (a mounted secret) instead of `NAME` (setting both is refused); surrounding
whitespace is removed and a blank value is unset. This table is the reference; [`.env.example`](./.env.example) is a local-development
template. Rotation: [secret rotation runbook](../../docs/runbooks/secret-rotation.md).

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | runtime connection, the `billing_app` role. In production `postgres`, `root`, `*_migrator` and `*_admin` are refused |
| `AUTH_SERVICE_URL`, `AUTH_TIMEOUT_MS` | URL yes | live identity for user bearers (sent to Auth only) |
| `BILLING_SUPPORTED_CURRENCIES` | yes | ISO 4217 codes accepted on an invoice or price; **no default** (B-005). Each must also exist in the immutable `currency` table |
| `SERVICE_TOKENS` | no | accepted callers, `<caller>:<sha256 digest>`; empty means every service call is refused. **Core V1 admits none** (ADR-0052, Q5) |
| `BILLING_SERVICE_POLICY` | when a token is registered | Stage 21.C.2: each caller's operations and `allowedPlatforms` (deny by default; kit caller-policy mechanism). V1: `{"callers":{}}` |
| `ORGANIZATION_SERVICE_URL`, `ORGANIZATION_REFERENCE_TOKEN`, `ORGANIZATION_REFERENCE_TIMEOUT_MS` | in production once a caller is admitted | Organization verification of asserted Organizations and of the entitlement read (fails closed, `503 hierarchy_unavailable`); `ORGANIZATION_REFERENCE_FIXTURE` is a non-production alternative, refused in production |
| `RABBITMQ_URL` | **in production** | event bus; without it the in-memory bus is used (development and tests only). Core V2 S1e-2: the Payment-event consumer is verified-only and needs the RabbitMQ bus, so without `RABBITMQ_URL` Billing does not start |
| `RABBITMQ_CONFIRM_TIMEOUT_MS` | no | bound on a publisher confirm; past it the publish fails and the outbox retries it (default 5000, range 100-60000) |
| `RABBITMQ_HEARTBEAT_S` | no | the AMQP heartbeat this service requests, in seconds (default 10, range 5-60); a broker that goes silent is detected within about three times this value |
| `BILLING_RATE_LIMIT_INVOICE_CREATE_PER_MINUTE`, `BILLING_RATE_LIMIT_PAYMENT_REQUEST_CREATE_PER_MINUTE` | no | baseline abuse limits: invoice creations and payment-request creations per minute per authenticated caller (defaults 300 and 30, range 1-100000 each). Technical values, no business meaning |
| `PAYMENT_SERVICE_URL`, `PAYMENT_SERVICE_TOKEN` | yes | payment-service's base URL and Billing's own service token (bearer sent to Payment; a user's bearer is never forwarded). In production the token published in the root `.env.example` is refused |
| `PAYMENT_TIMEOUT_MS` | no | per-call timeout to Payment (default 5000ms) |
| `BILLING_DISPATCH_INTERVAL_MS`, `BILLING_DISPATCH_BATCH_SIZE`, `BILLING_DISPATCH_STALE_SENDING_MS` | no | `PaymentDispatcher`'s poll interval, batch size and stale-`sending` retry threshold, which is also the interval between two attempts at the same request (defaults: 2000ms, 50, 60s). A pass renews its claims not sent yet every quarter of the stale window, so a slow Payment never makes another instance re-send them; the stale window must be at least twice `PAYMENT_TIMEOUT_MS` (refused at startup otherwise; Stage 15.8) |
| `BILLING_RECONCILE_INTERVAL_MS`, `BILLING_RECONCILE_STALE_REQUESTED_MS` | no | `PaymentReconciler`'s poll interval and stale-`requested` threshold (defaults: 30s, 5min) |
| `BILLING_PAYMENT_EVENT_RETRY_MAX` | no | How many times a Payment event whose processing failed with a possibly-transient error is retried before it is dead-lettered (default 3, range 0-10; `0` = dead-letter on the first failure). A permanent failure is never retried. See "Dead-lettered Payment events" |
| `BILLING_PAYMENT_EVENT_RETRY_DELAY_MS` | no | Wait between those retries (default 5000, range 100-300000) |
| `SWAGGER_USERNAME`, `SWAGGER_PASSWORD` | no | docs credentials; the password must be 16+ characters; without it the docs are not mounted |
| `NODE_ENV`, `PORT`, `LOG_LEVEL`, `BODY_LIMIT_KB`, `CORS_ORIGINS`, `TRUST_PROXY_HOPS` | no | the kit's base configuration (`NODE_ENV` defaults to `production`) |

## Running locally

```bash
cd apps/billing-service
cp .env.example .env                                 # edit for your setup (NODE_ENV=development is in the template)
set -a; . ./.env; set +a                             # nothing loads .env for you: export it into this shell before starting
docker compose --profile db up -d --wait postgres    # from the repo root
MIGRATION_DATABASE_URL=postgres://billing_migrator:...@localhost:5433/billing npm run migrate -w billing-service
npm run start:dev -w billing-service
```

Nothing migrates at service start; `/ready` fails while a migration is pending. Shared setup (Node 22, `npm run build:libs`, the environment, the test environment variables): [developer guide](../../docs/DEVELOPMENT.md).

## Tests

```bash
npm run lint -w billing-service
npm run typecheck -w billing-service
npm test -w billing-service                # unit
npm run test:e2e -w billing-service        # integration, real PostgreSQL (TEST_DATABASE_ADMIN_URL; TEST_RABBITMQ_URL adds the broker case: developer guide §6)
npm run build -w billing-service
```

The integration suite builds the **same** module graph as `main.ts` (`AppModule.register`). The foundation-level guards, error
filter, validation and identifiers are additionally exercised through **test-only probe routes** (`test/support/probe.ts`) that
are never part of the shipped application. It also runs the whole service as a non-owner, DML-only database role. Stage 4's own
suite (`test/payment-integration.e2e-spec.ts`) covers the dispatcher, the reconciler and the event consumer against a scripted
`PaymentClient` test double (no network) and the cancel endpoint over real HTTP.
