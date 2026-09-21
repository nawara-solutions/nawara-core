# billing-service

Answers: **what is owed, why, how much, in which currency, by whom, to whom, and when?** The design contract is
[`docs/sdd/billing-service.md`](../../docs/sdd/billing-service.md); how it fits beside payment-service and accounting-service is in
[`docs/architecture/financial-architecture.md`](../../docs/architecture/financial-architecture.md). It is **not** the payment or
accounting system: it never moves money and keeps no ledger.

## Status: Stage 4 (Payment integration: dispatch, cancel, event consumption, reconciliation)

The full cross-service loop with payment-service (SDD section 21), on top of Stage 3's HTTP API and the Stage 2 domain/schema
foundation. Billing can now actually ask Payment to collect an invoice, learn the outcome, and recover from a distributed
failure — end to end, not just record the request. **Not production-ready** and not deployed.
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
    instance that receives no Payment events should not look healthy).
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
  ownership, runtime role), and a database suite (`npm run test:db`: 188 assertions and 5 concurrency races).

### Explicitly NOT implemented (later stages; see the SDD)

Invoice rendering, templates, PDF, File Service, delivery, QR, signatures, recurring billing, dunning, trials, proration,
discounts, tax engine, credit notes, refunds, real payment providers, cash, payouts, wallets, accounting ledger, settlement
infrastructure, merchant of record, external customers, branches, multiple legal entities, exchange rates, currency conversion,
membership-based payment authorization, entitlements. No table exists for any of them (a test asserts the exact table set).

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
| `BILLING_DISPATCH_INTERVAL_MS`, `BILLING_DISPATCH_BATCH_SIZE`, `BILLING_DISPATCH_STALE_SENDING_MS` | no | `PaymentDispatcher`'s poll interval, batch size and stale-`sending` retry threshold (defaults: 2000ms, 50, 60s) |
| `BILLING_RECONCILE_INTERVAL_MS`, `BILLING_RECONCILE_STALE_REQUESTED_MS` | no | `PaymentReconciler`'s poll interval and stale-`requested` threshold (defaults: 30s, 5min) |
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
