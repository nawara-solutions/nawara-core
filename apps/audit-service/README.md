# audit-service

> **Status: the service foundation (Stage 18.2).** Health, readiness (database and migrations), service authentication, the
> deny-by-default caller policy, least-privilege database roles, the production image, Compose and CI. **No audit domain yet:** the
> append-only `audit_record` table (18.3), the audit contract and catalog (18.4), RabbitMQ ingestion (18.5), the query API (18.6),
> producer integration (18.7) and retention (18.8) arrive in their stages.

Security and business audit trail for Nawara Core: owning services emit cataloged audit events through their transactional outbox;
this service validates, stores them append-only and answers tenant-safe queries. Design: [ADR-0049](../../docs/adr/0049-audit-trail-architecture.md),
[SDD](../../docs/sdd/audit-service.md), [Stage 18.1 decisions and roadmap](../../docs/architecture/stage-18/stage-18-1-decisions-and-roadmap.md),
[Stage 18.2 record](../../docs/architecture/stage-18/stage-18-2-service-foundation.md).

## What exists (18.2 foundation)

| Capability | From the kit |
|---|---|
| Bootstrap, the bounded JSON body parser (the only body parser; `BODY_LIMIT_KB`), DTO whitelist, secure headers, CORS off by default | `configureApp` |
| Structured JSON logs, credential redaction; no access log (no request path is logged) | `JsonLogger` |
| `x-request-id` / `x-correlation-id` accepted when safe, generated otherwise, echoed (correlation is a log join key, never evidence) | `requestContextMiddleware` |
| Uniform error body `{ statusCode, message, error, code?, requestId }`; an unexpected error is an opaque 500 | `KitExceptionFilter` |
| `GET /health` (liveness) and `GET /ready` (readiness: `database` + `migrations`), at the root | `HealthModule`, `DbModule` |
| SIGTERM / SIGINT: `/ready` 503 and new requests refused, running requests drained within `HTTP_DRAIN_TIMEOUT_MS`, the pool closed last, exit | `HttpDrain` (Stage 15.5) |
| Service-token authentication (`SERVICE_TOKENS`); the caller is always the token's service | `ServiceAuthModule` |
| `AUDIT_SERVICE_POLICY`: per-caller operations (`read_organization`, `read_platform`), categories, optional source services; deny by default, validated at startup | this service |
| Silent-socket bound (`server.timeout` = max(headers timeout, one database wait) + 5 s) | this service (the File 17.9 O-5 rule) |

**Not here, by design (ADR-0049):** no call to Auth, Organization or any product service (A36); no end-user authentication; no
RabbitMQ yet (18.5); no route besides health and readiness.

## Configuration

| Variable | Default | Bounds | Notes |
|---|---|---|---|
| `NODE_ENV` | `production` | `development`, `test`, `production` | unset means production (the safe behaviour) |
| `PORT`, `LOG_LEVEL`, `BODY_LIMIT_KB`, `CORS_ORIGINS`, `TRUST_PROXY`, `HTTP_DRAIN_TIMEOUT_MS` | kit defaults (3000, info, 100, none, false, 5000) | kit bounds | the Core HTTP baseline |
| `DATABASE_URL` | **required** | `postgres:` / `postgresql:` | the runtime role `audit_app`; production refuses `postgres`, `root` and `*_migrator` |
| `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS` | 10, 5000, 30000, 60000, statement + 5000 | kit bounds (pool 1–100; query > statement) | |
| `MIGRATION_DATABASE_URL` | – | | the migrator, read only by `npm run migrate` |
| `SERVICE_TOKENS` | empty (every service call refused) | `<caller>:<sha256 hex>`, ≤ 2 per caller | never logged |
| `AUDIT_SERVICE_POLICY` | empty | required when a caller is registered | `{"callers":{"<caller>":{"operations":[…],"categories":[…],"sourceServices":[…]}}}` |

## Run and test

```bash
npm run build -w @nawara/service-kit && npm run build -w audit-service
npm test -w audit-service                                            # unit
TEST_DATABASE_ADMIN_URL=postgres://postgres:…@127.0.0.1:5433/postgres npm run test:e2e -w audit-service   # e2e (real PostgreSQL)
docker compose --profile db run --rm audit-service npm run migrate   # as audit_migrator
docker compose --profile db up -d audit-service                      # 127.0.0.1:3006
```

An existing local PostgreSQL volume predates the `audit` database (the init script runs only on an empty volume): add the `AUDIT_*`
passwords from `.env.example` to your `.env` (Compose refuses to start without them) and recreate the volume, or provision the database
by hand as `infra/postgres/init/01-service-databases.sh` does.

## Stages

| Stage | State |
|---|---|
| 18.1 | ✅ architecture and decisions |
| 18.2 | ✅ service foundation |
| 18.3 – 18.10 | persistence, contract and catalog, ingestion, query, producers, security / retention, operations, certification |
