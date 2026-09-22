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
- **State machines** (`src/domain/state-machines.ts`): invoice `draft, open, paid, void` (`overdue` is derived from the database
  clock), payment request `created .. rejected`. A test proves TypeScript and the triggers agree on every pair.
- **Snapshots**: party snapshots (container only; content is B-007) and a presentation snapshot v1 (`{schemaVersion, template, locale}`).
- **Numbering foundation**: a concurrency-safe counter per seller at issue; a rolled-back issue returns its number; gaplessness is
  **not** assumed (scope and format are B-004).
- **Currency in three layers**: the global `currency` reference, Platform-enabled currencies (`platform_currency`, with a permission question nothing calls yet) and the immutable historical invoice currency. No Platform currency HTTP API; how an invoice gets its Platform is undecided (B-036).
- **Payment-request mapping** as a pure function of two immutable rows, and **payment-event handling**: a pure decision function plus
  a durable receipt (duplicates, out-of-order, unknown, early events; a `paymentId` is never bound from an event). Billing keeps its
  own `payment_event_receipt` for this rather than the kit's generic `InboxService` — Payment-event deduplication carries Billing
  business semantics (a decision, a detail code, the request/invoice it settles) that does not belong in shared infrastructure.
- **Persistence layer** (`src/invoices`): `InvoiceRepository` (create draft with natural-key idempotency, issue, discard, read) and
  `PaymentRequestRepository` (state-idempotent create, apply a Payment event, plus the Stage 4 dispatch/reconciliation/cancel
  support below). Every state change is one transaction: row lock, change, history row and, on issue, the `invoice.created` outbox
  event.
- **HTTP API** (`src/invoices/*.controller.ts`, mounted at `GET /docs`): products, prices, invoices (create, list, get, issue,
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

`graceUntil` has exactly one trusted authority: `SUBSCRIPTION_GRACE_DAYS` (optional; unset means this deployment offers no
grace at all — no Nawara-wide default exists). `activate`/`renew` precompute it from that policy in the SAME statement as
`currentPeriodEnd`, so it is a trustworthy timestamp from the moment a period exists, not only once some later sweeper calls
`enterGrace` — `enterGrace` itself takes no timestamp at all; it only normalizes the status label once a grace window that
was already computed exists. `create` distinguishes an identical replay (same organization, same product AND price — state
idempotent) from a genuinely conflicting request (same organization, a DIFFERENT product or price — `409 subscription_conflict`);
it is never a disguised upgrade/downgrade. `productId`/`priceId` are immutable today (no method changes them), which does not
block a future offering-change operation: exactly like every other Billing table, a later migration simply widens the
existing `billing_immutable_except` allow-list the day that operation is actually built.

### Entitlement derivation (Stage 12.3; a logical capability, not a service, not a table)

`deriveEntitlement` (`src/domain/entitlement.ts`) answers, purely from an already-loaded Subscription and an explicitly
supplied `now`, whether an Organization has effective commercial access right now: `{ valid: boolean, expiresAt: Date |
null }` — the frozen V1 contract, nothing else (no reason code, no feature flags). No database query, no HTTP call, no
RabbitMQ, no configuration read (grace policy already did its job when Stage 12.2 precomputed `graceUntil`), no `new
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
Secrets may be given as `NAME_FILE=/path` (a mounted secret) instead of `NAME`. See [`.env.example`](./.env.example).

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | runtime connection, the `billing_app` role. In production a superuser or `*_migrator` login is refused |
| `AUTH_SERVICE_URL`, `AUTH_TIMEOUT_MS` | URL yes | live identity for user bearers (sent to Auth only) |
| `BILLING_SUPPORTED_CURRENCIES` | yes | ISO 4217 codes accepted on an invoice or price; **no default** (B-005). Each must also exist in the immutable `currency` table |
| `SERVICE_TOKENS` | no | accepted callers, `<caller>:<sha256 digest>`; empty means every service call is refused |
| `RABBITMQ_URL` | **in production** | event bus; without it the in-memory bus is used (development and tests only) |
| `PAYMENT_SERVICE_URL`, `PAYMENT_SERVICE_TOKEN` | yes | payment-service's base URL and Billing's own service token (bearer sent to Payment; a user's bearer is never forwarded) |
| `PAYMENT_TIMEOUT_MS` | no | per-call timeout to Payment (default 5000ms) |
| `BILLING_DISPATCH_INTERVAL_MS`, `BILLING_DISPATCH_BATCH_SIZE`, `BILLING_DISPATCH_STALE_SENDING_MS` | no | `PaymentDispatcher`'s poll interval, batch size and stale-`sending` retry threshold, which is also the interval between two attempts at the same request (defaults: 2000ms, 50, 60s) |
| `BILLING_RECONCILE_INTERVAL_MS`, `BILLING_RECONCILE_STALE_REQUESTED_MS` | no | `PaymentReconciler`'s poll interval and stale-`requested` threshold (defaults: 30s, 5min) |
| `BILLING_PAYMENT_EVENT_RETRY_MAX` | no | How many times a Payment event whose processing failed with a possibly-transient error is retried before it is dead-lettered (default 3, range 0-10; `0` = dead-letter on the first failure). A permanent failure is never retried. See "Dead-lettered Payment events" |
| `BILLING_PAYMENT_EVENT_RETRY_DELAY_MS` | no | Wait between those retries (default 5000, range 100-300000) |
| `SWAGGER_USERNAME`, `SWAGGER_PASSWORD` | no | docs credentials; the password must be 16+ characters; without it the docs are not mounted |
| `NODE_ENV`, `PORT`, `LOG_LEVEL`, `BODY_LIMIT_KB`, `CORS_ORIGINS`, `TRUST_PROXY` | no | the kit's base configuration (`NODE_ENV` defaults to `production`) |

## Running locally

```bash
cp .env.example .env                                 # edit for your setup
docker compose --profile db up -d --wait postgres    # from the repo root
MIGRATION_DATABASE_URL=postgres://billing_migrator:...@localhost:5433/billing npm run migrate -w billing-service
npm run start:dev -w billing-service
```

Nothing migrates at service start; `/ready` fails while a migration is pending.

## Tests

```bash
npm run lint -w billing-service
npm run typecheck -w billing-service
npm test -w billing-service                # unit
npm run test:e2e -w billing-service        # integration, real PostgreSQL (needs TEST_DATABASE_ADMIN_URL; TEST_RABBITMQ_URL adds the broker case)
npm run build -w billing-service
```

The integration suite builds the **same** module graph as `main.ts` (`AppModule.register`). The foundation-level guards, error
filter, validation and identifiers are additionally exercised through **test-only probe routes** (`test/support/probe.ts`) that
are never part of the shipped application. It also runs the whole service as a non-owner, DML-only database role. Stage 4's own
suite (`test/payment-integration.e2e-spec.ts`) covers the dispatcher, the reconciler and the event consumer against a scripted
`PaymentClient` test double (no network) and the cancel endpoint over real HTTP.
