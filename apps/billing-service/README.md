# billing-service

Answers: **what is owed, why, how much, in which currency, by whom, to whom, and when?** The design contract is
[`docs/sdd/billing-service.md`](../../docs/sdd/billing-service.md); how it fits beside payment-service and accounting-service is in
[`docs/architecture/financial-architecture.md`](../../docs/architecture/financial-architecture.md). It is **not** the payment or
accounting system: it never moves money and keeps no ledger.

## Status: Stage 2 (domain schema, financial invariants, state-transition foundation)

The **database and the pure domain rules** of the Billing aggregate (SDD section 34.1, Stage 2), on top of the Stage 1 foundation.
There is **still no Billing HTTP endpoint**: the invoice API is Stage 3. **Not production-ready** and not deployed.
Design and test detail: [`docs/tdd/billing-service-domain-schema.md`](../../docs/tdd/billing-service-domain-schema.md).

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
  a durable receipt (duplicates, out-of-order, unknown, early events; a `paymentId` is never bound from an event).
- **Persistence layer** (`src/invoices`): `InvoiceRepository` (create draft with natural-key idempotency, issue, discard, read) and
  `PaymentRequestRepository` (state-idempotent create, apply a Payment event). Every state change is one transaction: row lock,
  change, history row and, on issue, the `invoice.created` outbox event.
- Tests: unit (domain rules, input normalisation, no-float source scan), integration (repositories, races, atomicity, ownership,
  runtime role), and a database suite (`npm run test:db`: 185 assertions and 5 concurrency races).

### Explicitly NOT implemented (later stages; see the SDD)

Invoice HTTP API, rendering, templates, PDF, File Service, delivery, QR, signatures, recurring billing, dunning, trials,
proration, discounts, tax engine, credit notes, refunds, external customers, branches, multiple legal entities, exchange rates,
wallets, accounting ledger, Payment client and provider logic, the payment-event consumer and reconciler, entitlements.
No table exists for any of them (a test asserts the exact table set).

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

The integration suite builds the **same** module graph as `main.ts` (`AppModule.register`). Stage 1 has no domain endpoint, so the
guards, error filter, validation and identifiers are exercised through **test-only probe routes** (`test/support/probe.ts`) that
are never part of the shipped application. It also runs the whole service as a non-owner, DML-only database role.
