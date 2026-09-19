# billing-service

Answers: **what is owed, why, how much, in which currency, by whom, to whom, and when?** The design contract is
[`docs/sdd/billing-service.md`](../../docs/sdd/billing-service.md); how it fits beside payment-service and accounting-service is in
[`docs/architecture/financial-architecture.md`](../../docs/architecture/financial-architecture.md). It is **not** the payment or
accounting system: it never moves money and keeps no ledger.

## Status: Stage 1 (service foundation only)

This is the **technical foundation with no domain** (SDD section 34.1, Stage 1). Nothing here is a Billing feature yet.
**Not production-ready** and not deployed.

### Implemented

- A kit-based NestJS service: validated configuration (fails closed and never echoes a value), structured JSON logging with
  redaction, request and correlation ids, the uniform error body with an optional machine-readable `code`, secure headers,
  bounded and whitelisted request bodies, CORS off unless exact origins are listed, graceful shutdown.
- `GET /health` (process alive) and `GET /ready` (database reachable, no migration pending, and the broker when one is configured).
- Service authentication: the kit's per-caller service-token guard, plus the combined **service-token-or-user** guard
  (`ServiceOrUserGuard`). Both **authenticate** only: they say who is calling. **No authorization rule exists** (no Billing role,
  permission or relation): that arrives with each operation and its `[B]` decisions (SDD section 19).
- Database wiring on the `billing` database with the least-privilege runtime role, the explicit migration step
  (`npm run migrate`, as `billing_migrator`), and the kit's infrastructure migrations (outbox, inbox, rate limit, generic triggers).
- Event infrastructure from the kit (transactional outbox and its relay, inbox, RabbitMQ or in-memory bus). **No event is defined
  or published, and no event is consumed.**
- OpenAPI at `/billing/docs`, mounted only when `SWAGGER_PASSWORD` is set, behind basic auth.
- Local technical helpers a later stage will use: the deterministic event id and cursor pagination (`src/common`).
- A Dockerfile that runs as the unprivileged `node` user, and an entry in the Core CI matrix.

### Explicitly NOT implemented (later stages; see the SDD)

No Billing table, endpoint, event, consumer, reconciler, scheduler or metric. Nothing about products, prices, invoices, payment
requests, credit notes, entitlements, subscriptions, tax or numbering. No Payment client and no Payment configuration (Stage 4).
The migrations folder `db/migrations/` is empty on purpose: Stage 2 adds the schema.

## Configuration

Every value below is read at startup and validated; an invalid or missing required value stops the process.
Secrets may be given as `NAME_FILE=/path` (a mounted secret) instead of `NAME`. See [`.env.example`](./.env.example).

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | runtime connection, the `billing_app` role. In production a superuser or `*_migrator` login is refused |
| `AUTH_SERVICE_URL`, `AUTH_TIMEOUT_MS` | URL yes | live identity for user bearers (sent to Auth only) |
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
