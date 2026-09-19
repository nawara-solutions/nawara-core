# payment-service

Answers: **how was an obligation paid, by which method, and what is the payment state?** See
[`docs/sdd/payment-service.md`](../../docs/sdd/payment-service.md) for the full design (data model,
state machines, idempotency, authorization, events) and
[`docs/architecture/financial-architecture.md`](../../docs/architecture/financial-architecture.md)
for how it fits alongside billing-service and accounting-service. It is **not** the billing or
accounting system: it never decides what is owed and keeps no ledger.

## Status

Phase 1 (technical foundation) is being built in stages; see the SDD's "Implementation readiness
gate" (section 22) for what is and is not allowed to be implemented yet. As of this stage:

- ✅ Service foundation on `@nawara/service-kit`: configuration, database connection/migration
  wiring, `/health` and `/ready`, service-token authentication, a combined service-token-or-user
  guard, the event bus (in-memory locally, RabbitMQ by configuration), a generic rate limiter,
  OpenAPI at `/payment/docs` (behind basic auth, unmounted unless a password is configured), and
  raw-body capture for the webhook route that a later stage will add.
- ⏳ No domain table, endpoint or business rule exists yet — this stage deliberately mirrors the
  SDD's own "Stage 1: convert the starter into a kit-based service with no domain" (section 21).

## Running locally

```bash
cp .env.example .env                  # edit AUTH_SERVICE_URL etc. for your setup
docker compose --profile db up -d --wait postgres   # from the repo root
npm run start:dev -w payment-service
```

## Migrations

```bash
MIGRATION_DATABASE_URL=postgres://payment_migrator:...@localhost:5433/payment npm run migrate -w payment-service
```

Nothing migrates automatically at service start; `/ready` fails while a migration is pending (see
`@nawara/service-kit`'s README for the full migration model). There are no payment-service-specific
migrations yet — only the kit's own (outbox/inbox, rate limiting) apply today.

## Tests

```bash
npm run test -w payment-service        # unit
npm run test:e2e -w payment-service     # integration, against a real PostgreSQL (needs TEST_DATABASE_ADMIN_URL)
```
