# billing-service: Stage 1 service foundation

- **Status:** Implemented
- **Author:** Claude (Billing Stage 1 session), for the project owner
- **Related SDD:** [billing-service.md](../sdd/billing-service.md) (section 34.1, Stage 1; sections 19, 20, 24, 28)
- **Related ADRs:** [0032](../adr/0032-database-per-service-on-a-shared-server.md), [0033](../adr/0033-service-to-service-authentication-and-user-identity.md), [0034](../adr/0034-shared-service-kit-and-api-conventions.md), [0037](../adr/0037-reliable-events-outbox-inbox.md)
- **Ticket/issue:** Billing Stage 1 (foundation only; no domain)

## Problem

Billing has an approved design and no code. Stage 1 creates the technical service foundation the later stages build on, without
implementing any Billing domain behaviour or deciding any `[B]` question.

## Approach

Reuse Payment's proven foundation (`docs/tdd/payment-service-foundation.md`) rather than invent another:

- `apps/billing-service` on `@nawara/service-kit`: `loadBillingConfig` over `loadBaseConfig`, `HealthModule`, `DbModule` (own
  database, runtime role), `ServiceAuthModule`, `AuthClientModule`, `EventsModule`, `RateLimitModule`, `configureApp`.
- **One module graph for the app and the tests:** `AppModule.register(config, overrides)` is used by `main.ts` and by every
  integration test, so a test cannot pass against a differently wired application (Payment's test harness wires its modules by hand).
- Configuration carries only what the foundation uses. Two rules go beyond Payment because the SDD forbids development shortcuts
  surviving into production: in production `RABBITMQ_URL` is required (the in-memory bus loses events on restart) and a superuser or
  `*_migrator` database login is refused (ADR-0032). `SWAGGER_PASSWORD`, when set, must be 16+ characters.
- The combined service-token-or-user guard, the deterministic event id and cursor pagination are implemented **locally** (SDD R-9,
  Stage 0: no kit change is required). The guard authenticates only.
- `db/migrations/` exists and is empty. The kit's infrastructure migrations prove the migration path; a test asserts the exact set
  of tables so a Billing table cannot appear before Stage 2.
- The Dockerfile follows Payment's and additionally runs as the unprivileged `node` user.
- Billing joins the Core CI matrix (lint, typecheck, unit, integration, build). The `infra` job already applies the kit migrations
  to the `billing` database as `billing_migrator` and checks the runtime role.

## Files/components affected

`apps/billing-service/**` (new), `package-lock.json` (workspace entry only), `.github/workflows/core-ci.yml` (matrix entry and
comment), `docs/tdd/README.md`, `docs/sdd/billing-service.md` (status line only). No change to Auth, Payment or the service-kit.

## Edge cases

- `/health` stays 200 during a database outage; `/ready` is 503 and names only the failing check.
- An unreachable Auth fails a user-bearer request with 503; a service token never causes an Auth call.
- Stage 1 has no domain endpoint, so guard, error, validation and id behaviour is tested through test-only probe routes.

## Data migration

None: no Billing table exists.

## Test plan

Unit: configuration (required, invalid, no value echoed, production rules, `NAME_FILE`), the guard, basic auth, deterministic id,
pagination. Integration (real PostgreSQL, RabbitMQ when available): health and readiness, service-token and combined-guard
authentication, error sanitization, unknown-field rejection, request and correlation ids, log hygiene, docs mounting, graceful
shutdown, migration infrastructure and CLI, and the whole service as a non-owner DML-only role.

## Rollout

Not deployed. No deploy workflow exists for billing-service; a deployment is a separate approval.
