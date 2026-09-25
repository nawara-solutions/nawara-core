# audit-service

> **Status: foundation (18.2), append-only persistence (18.3), the shared contract and catalog (18.4), RabbitMQ ingestion (18.5).**
> Cataloged audit events arrive on `audit-service.audit` (bound to `audit.#`), are validated with the shared
> [`@nawara/audit-contract`](../../libs/audit-contract/README.md) (49 actions), admitted only from their catalog producer, and stored
> once in the append-only `audit_record` (the runtime role can INSERT and SELECT, never UPDATE, DELETE or TRUNCATE; a database superuser
> remains outside the guarantee). **Not yet:** the query API (18.6), producer integration (18.7), retention (18.8).

Security and business audit trail for Nawara Core: owning services emit cataloged audit events through their transactional outbox;
this service validates, stores them append-only and answers tenant-safe queries. Design: [ADR-0049](../../docs/adr/0049-audit-trail-architecture.md),
[SDD](../../docs/sdd/audit-service.md), [Stage 18.1 decisions and roadmap](../../docs/architecture/stage-18/stage-18-1-decisions-and-roadmap.md),
[Stage 18.2 record](../../docs/architecture/stage-18/stage-18-2-service-foundation.md),
[Stage 18.3 record](../../docs/architecture/stage-18/stage-18-3-persistence-append-only.md),
[Stage 18.4 record](../../docs/architecture/stage-18/stage-18-4-canonical-contract-catalog.md), [event catalog](../../docs/architecture/audit-event-catalog.md),
[Stage 18.5 record](../../docs/architecture/stage-18/stage-18-5-rabbitmq-ingestion.md).

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

**Not here, by design (ADR-0049):** no call to Auth, Organization or any product service (A36); no end-user authentication; no HTTP
ingestion route (A16: the bus is the only way in); no route besides health and readiness until 18.6.

## Ingestion (18.5)

| | |
|---|---|
| Path | producer business transaction → `AuditEventWriter` → producer outbox → kit relay → `nawara.events` (`audit.<action>`) → `audit-service.audit` |
| Pipeline | `validateAuditEvent` (the shared validator, incl. producer admission) → `toNewAuditRecord` → `insertOnce` (one statement) → ACK |
| Exact duplicate | acknowledged, one row (`audit_event_duplicate`) |
| Same id, different evidence | never overwritten; dead-lettered `event_id_conflict` |
| Invalid event | dead-lettered at once with its contract reason (never retried) |
| Database / transient failure | not acknowledged; kit retry 3 × 5 s through `audit-service.audit.retry`, then `audit-service.audit.dead` (`retries_exhausted`) |
| Delivery | at least once, with idempotent immutable persistence (never "exactly once") |
| Prefetch | half `DB_POOL_MAX` (1–10; 5 by default): at most that many deliveries in flight or in memory |
| Readiness | `database`, `migrations`, `rabbitmq`, `audit-ingestion`; `/health` never depends on them |
| Observability | `audit_ops_snapshot` every 60 s; `audit_event_persisted` / `_duplicate` / `_refused`, `audit_clock_skew`, the kit's retry / DLQ notices |

**Dead letters** (the kit tool; the broker URL only from `RABBITMQ_URL`): `nawara-dlq list --queue audit-service.audit.dead` peeks without
consuming; after fixing the cause, `nawara-dlq replay --queue audit-service.audit.dead --event-id <id>` sends ONE message back through the
normal path (validation, admission, idempotency, conflict detection all apply: an already-stored event is a duplicate, a conflict is
rejected again). Never edit a dead-lettered payload. The DLQ holds a copy of each refused message (retention and access: 18.8).

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
| `RABBITMQ_URL` | **required** | `amqp:` / `amqps:` | the ingestion broker; never logged. Local: the shared `guest` user; production: a per-service identity (P-A1) |
| `RABBITMQ_CONFIRM_TIMEOUT_MS`, `RABBITMQ_HEARTBEAT_S` | 5000, 10 | 100–60000, 5–60 | kit bounds (retry / DLQ copy confirms; silent-broker detection ≈ 3 × heartbeat) |

## Run and test

```bash
npm run build -w @nawara/service-kit -w @nawara/audit-contract && npm run build -w audit-service
npm test -w audit-service                                            # unit
TEST_DATABASE_ADMIN_URL=postgres://postgres:…@127.0.0.1:5433/postgres TEST_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672 \
  npm run test:e2e -w audit-service                                  # e2e (real PostgreSQL 16 + real RabbitMQ)
# local failure probes (restart / stop the named containers; never against shared infrastructure):
TEST_RABBITMQ_CONTAINER=<broker container> TEST_POSTGRES_CONTAINER=<postgres container> … npm run test:chaos -w audit-service
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
| 18.3 | ✅ append-only persistence (`audit_record`, repository, idempotency foundation) |
| 18.4 | ✅ contract and catalog (`@nawara/audit-contract`; `toNewAuditRecord` here) |
| 18.5 | ✅ RabbitMQ ingestion (consumer, admission, duplicates / conflicts, DLQ reasons, readiness, shutdown) |
| 18.6 – 18.10 | query, producers, security / retention, operations, certification |
