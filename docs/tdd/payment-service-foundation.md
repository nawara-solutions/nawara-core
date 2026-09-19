# payment-service: technical foundation and Phase 1 schema

- **Status:** Implemented
- **Author:** Claude (Phase 1 implementation session), reviewed against the SDD by the project owner
- **Related SDD:** [payment-service.md](../sdd/payment-service.md)
- **Related ADRs:** [0032](../adr/0032-database-per-service-on-a-shared-server.md), [0033](../adr/0033-service-to-service-authentication-and-user-identity.md), [0034](../adr/0034-shared-service-kit-and-api-conventions.md), [0037](../adr/0037-reliable-events-outbox-inbox.md)
- **Ticket/issue:** Payment Service Phase 1, steps 1–2 (service foundation, database schema)

## Problem

`apps/payment-service` was an unmodified NestJS starter. Before any domain code (payments, attempts,
webhooks) can be written, the service needs to sit on the same technical baseline as the rest of
Core (`@nawara/service-kit`) and its schema needs to exist with the financial invariants the SDD
requires enforced at the database level, not just in application code.

This TDD covers exactly the SDD's own "Stage 1" (section 21: *"convert the payment-service starter
into a kit-based service with no domain"*) plus the immediately following schema step. No endpoint,
business rule, cash/refund table, or `[B]`-gated behavior is included here.

## Approach

**Kit prerequisites** (needed by payment-service, generic enough for any future kit consumer, so
added to `libs/service-kit` rather than duplicated locally):
- `KitExceptionFilter` gained an additive, optional `code` field on the error body (`{ statusCode, message, error, code?, requestId }`), via `new HttpException({ message, code }, status)`, and a `502` status-text entry.
- A new `RateLimitModule`/`RateLimitService`: Postgres-backed fixed-window limiter (`kit_rate_limit` table), bucket/identifier/rule all caller-supplied, identifiers hashed before storage.
- A new generic `forbid_column_change(...cols)` trigger function (`kit_0003_generic_triggers.sql`), reusable by any table that needs an immutable-snapshot invariant (matches the pattern auth-service already uses locally).

**Service foundation** (`apps/payment-service/src`):
- `config/payment-config.ts`: `loadPaymentConfig()` layers payment-specific env vars (currencies, max attempts, idempotency TTL, test-provider switch, return-URL allowlist, Swagger credentials) on top of the kit's `loadBaseConfig`/`EnvReader`.
- `app.module.ts`: wires `DbModule` (own database, `payment_app`/`payment_migrator` roles per ADR-0032), `HealthModule`, `ServiceAuthModule`, `EventsModule` (RabbitMQ by configuration, in-memory otherwise), `RateLimitModule`.
- `auth/service-or-user.guard.ts`: the combined guard the SDD explicitly calls for (section 8.1) — service-token digests are tried first (constant-time, no early exit), and only on no match is the bearer asked of Auth (`HttpAuthClient`); an inactive identity is refused.
- `main.ts`: boots the app with `{ bodyParser: false, rawBody: true }` — Nest's built-in raw-body capture works with the kit's existing `configureApp`/`useBodyParser('json', ...)` with no kit change, exactly as the SDD's own prerequisite note (section 21) anticipated. Mounts OpenAPI at `/payment/docs` behind HTTP Basic auth (unmounted unless `SWAGGER_PASSWORD` is set), mirroring `auth-service`'s pattern.
- `health/rabbitmq-readiness.ts`: a connect-and-close probe registered on `ReadinessRegistry` when `RABBITMQ_URL` is configured — the kit wires database/migration readiness automatically but has no broker check.

**Schema** (`apps/payment-service/db/migrations`, applied after the kit's own `kit_000N_*.sql`):
- `0001_currency.sql`: reference table, seeded with TND/USD/EUR as neutral examples (which currencies are supported beyond that is O-10, not decided here).
- `0002_payment.sql`: the `payment` table with the section 3.1/4.1 contract fields; CHECK constraints for FI-01 (amount > 0), the payer≠seller and organizationId-matches-seller-when-organization contract rules, and the natural key `UNIQUE(producer, paymentRequestId)`; `forbid_column_change(...)` for FI-02 (snapshot immutability); a `payment_status_transition_guard()` trigger enforcing exactly the gateway-settlement transitions of SDD section 5.1 (no cash states, since cash isn't built yet).
- `0003_payment_attempt.sql`: the `payment_attempt` table; a generated `merchantReference` column (`= id`); `UNIQUE(provider, providerTransactionId)` for FI-09; a partial unique index for "one open attempt per payment"; a status-transition trigger for section 5.2; then (now that both tables exist) the `succeededAttemptId` FK plus a `payment_succeeded_attempt_integrity()` trigger enforcing FI-03/FI-04 (same payment, succeeded attempt, set once).
- `0004_idempotency_key.sql`: the header-based idempotency table (section 4.7); natural-key idempotency for payment creation is the `payment` table's own unique constraint instead.

No `down/` migrations were written, matching the kit's own migrations (forward-only, checksum-immutable, tracked in `schema_migrations`) rather than auth-service's heavier roll-back convention — there's nothing destructive to roll back yet.

## Files/components affected

- `libs/service-kit/src/errors/exception.filter.ts`, `src/rate-limit/*`, `migrations/kit_0002_rate_limit.sql`, `migrations/kit_0003_generic_triggers.sql`
- `apps/payment-service/src/{config,auth,docs,health}/*`, `app.module.ts`, `main.ts`
- `apps/payment-service/db/migrations/000{1..4}_*.sql`, `db/tests/{invariants.sql,run.sh}`
- `apps/payment-service/{Dockerfile,.env.example,README.md,package.json}`
- `.github/workflows/core-ci.yml`: `database-tests: true` for the payment-service matrix entry

## Edge cases

- Test provider enabled with `NODE_ENV=production` → config load throws (fail closed), never silently ignored.
- `succeededAttemptId` set twice, or to an attempt of another payment, or to a non-succeeded attempt → all refused by `payment_succeeded_attempt_integrity()`, SQLSTATE `23514`.
- A second attempt started while one is `initiated`/`submitted`/`unknown` → refused by the partial unique index, proven under concurrency (8 racing inserts, `db/tests/run.sh`).
- Two concurrent identical payment creates → exactly one row survives (`payment_request_id_unique`), also proven under concurrency.
- Database unreachable at boot → `/health` stays 200, `/ready` is 503 naming only `database`/`migrations` (proven in `test/health.e2e-spec.ts`).

## Data migration

N/A — greenfield tables, no existing data.

## Test plan

- Unit: `libs/service-kit/test/http.spec.ts` (error `code` passthrough, 502 text), `test/rate-limit.int-spec.ts`; `apps/payment-service/src/config/payment-config.spec.ts`, `src/auth/service-or-user.guard.spec.ts`, `src/docs/basic-auth.spec.ts`.
- Integration: `libs/service-kit/test/generic-triggers.int-spec.ts`; `apps/payment-service/test/health.e2e-spec.ts` (health/ready/raw-body, against a real throwaway Postgres via `createTestDatabase`).
- Database: `apps/payment-service/db/tests/invariants.sql` (29 assertions covering FI-01, FI-02, FI-04, FI-09, FI-11 and the section 3.1 contract shape) plus two concurrency races in `run.sh`.
- Manual: `docker build` + container smoke run against local Postgres/RabbitMQ (`/health` 200, `/ready` 503→200 after migration, `/payment/docs` 401→200 with basic auth).

## Rollout

No feature flags: this is infrastructure with no external behavior yet (no domain endpoint exists).
Safe to merge and deploy independently of any later stage.
