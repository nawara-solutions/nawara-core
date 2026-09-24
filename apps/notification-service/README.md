# notification-service

> **Status: foundation (16.3), persistence and templates (16.4), Auth event intake (16.5).** Auth's nine notification events are
> consumed from `notification.events` and recorded as durable intents with `PENDING` deliveries (codes sealed, E.164 enforced).
> **It sends nothing yet:** no send API (16.6), no worker (16.7), no provider (16.8).

Generic, product-agnostic delivery of notifications (email and SMS first) for Nawara Core. Producers decide *why* and *when*; this
service decides *how* and *where*. Design: [ADR-0046](../../docs/adr/0046-notification-service-architecture.md),
[SDD](../../docs/sdd/notification-service.md), [Stage 16 roadmap](../../docs/architecture/stage-16/stage-16-1-decisions-and-roadmap.md),
[Stage 16.3 record](../../docs/architecture/stage-16/stage-16-3-service-foundation.md),
[Stage 16.4 record](../../docs/architecture/stage-16/stage-16-4-persistence-and-templates.md),
[Stage 16.5 record](../../docs/architecture/stage-16/stage-16-5-notification-event-intake.md).

## What exists (16.3)

| Capability | From the kit |
|---|---|
| Bootstrap, bounded JSON body, DTO whitelist, secure headers, CORS off by default | `configureApp` |
| Structured JSON logs (`ts`, `level`, `service`, `msg`, `requestId`, `correlationId`), credential redaction | `JsonLogger` |
| `x-request-id` / `x-correlation-id` accepted when safe, generated otherwise, echoed | `requestContextMiddleware` |
| Uniform error body `{ statusCode, message, error, code?, requestId }`; an unexpected error is an opaque 500 | `KitExceptionFilter` |
| `GET /health` (liveness) and `GET /ready` (readiness), at the root | `HealthModule` |
| SIGTERM: `/ready` 503 and new requests refused, running requests drained within `HTTP_DRAIN_TIMEOUT_MS`, exit | `HttpDrain` (Stage 15.5) |
| Service-token authentication, ready for the send API (no route uses it yet) | `ServiceAuthModule` |

| Database: bounded pool and deadlines, `application_name = notification-service`, readiness `database` + `migrations`, pool closed last at shutdown | `DbModule` (16.4) |

`/ready` = `database` + `migrations` + `rabbitmq` + `event-intake`. Email and SMS providers are never readiness dependencies.

## Event intake (16.5)

- **Consumption:** the kit consumer on the durable queue `notification.events`, bound only to the nine mapped Auth events
  (`src/intake/event-map.ts`).
- **One transaction per event:** the intent plus its delivery, `ON CONFLICT (sourceService, sourceEventId) DO NOTHING`. The message
  is acknowledged only after the commit, and a redelivery or replay is a duplicate.
- **Refused (dead-lettered once, nothing written):** a malformed envelope or payload, an unsupported version, an unmapped event, no
  destination, invalid template data, or an unknown template.
- **Invalid destination** (SMS must be E.164; no country is ever guessed): a durable `FAILED invalid_destination` delivery.
- **Codes:** sealed with AES-256-GCM (`NOTIFICATION_SECRET_KEYS`), never in `data` or a log.
- **Start order:** the consumer starts only after the database, the migrations and the default-locale coverage are verified.
  Until then the process stays up and not ready.

## Persistence and templates (16.4)

- **Schema:** `db/migrations/0001_notification_schema.sql`:
  - `notification` (the immutable intent: one recipient, no stored status);
  - `notification_delivery` (one per channel; destination snapshot; pinned version; DB-guarded transitions);
  - `notification_delivery_attempt` (STARTED → one final outcome);
  - `notification_template` and `notification_template_version` (immutable, never deleted).
- **Templates:** `templates/<key>/<CHANNEL>.<locale>.v<N>.json`, with the **provisional** V1 copy for the nine Auth events (D7).
  - A change is a new version file, then `npm run build -w notification-service && npm run templates:migration -w
    notification-service -- <name>`, which runs the publish check and writes the next `NNNN_publish_templates_<name>.sql`.
  - A unit test fails if the committed migrations and the catalog ever drift apart.
- **Migrate** (explicit, as the migrator, never at startup):
  `MIGRATION_DATABASE_URL=postgres://notification_migrator:…@host/notification npm run migrate -w notification-service`, or
  `docker compose --profile db run --rm notification-service npm run migrate`.
- **Local volume:** an existing local PostgreSQL volume predates the `notification` database (the init script runs only on an empty
  volume). Add the `NOTIFICATION_*` passwords from `.env.example` to `.env`, then recreate the volume or provision it by hand as
  `infra/postgres/init/01-service-databases.sh` does.

## Configuration

| Variable | Default | Bounds | Notes |
|---|---|---|---|
| `NODE_ENV` | `production` | `development`, `test`, `production` | unset means production (the safe behaviour) |
| `PORT` | 3000 | 1–65535 | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` | |
| `BODY_LIMIT_KB` | 100 | 1–10240 | |
| `CORS_ORIGINS` | empty (off) | exact http(s) origins | no wildcard |
| `TRUST_PROXY` | `false` | `true` / `false` | |
| `HTTP_DRAIN_TIMEOUT_MS` | 5000 | 500–120000 | bound on the HTTP drain at shutdown |
| `DATABASE_URL` | **required** | `postgres:` / `postgresql:` | the runtime role `notification_app`; production refuses `postgres`, `root` and `*_migrator` |
| `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS` | 10, 5000, 30000, 60000, statement + 5000 | the kit bounds | |
| `MIGRATION_DATABASE_URL` | – | | the migrator, read only by `npm run migrate` |
| `RABBITMQ_URL` | **required** | `amqp:` / `amqps:` | the broker of the event intake; never logged |
| `RABBITMQ_CONFIRM_TIMEOUT_MS`, `RABBITMQ_HEARTBEAT_S` | 5000, 10 | 100–60000, 5–60 | the Core broker bounds |
| `NOTIFICATION_SECRET_KEYS`, `NOTIFICATION_SECRET_ACTIVE_KEY_ID` | **required** | `id:base64(32 bytes)[,…]`, distinct; the active id must exist | secret: seals one-time codes; rotation = add, activate, retire once unused |
| `NOTIFICATION_DEFAULT_LOCALE` | **required** | BCP 47 | a product input (D7); every mapped template must be published in it, or the intake does not start |
| `SERVICE_TOKENS` | empty | `<caller>:<sha256 hex>`, comma-separated, ≤ 2 per caller | secret-derived (digests only); empty refuses every service-token call |

`DATABASE_URL`, `RABBITMQ_URL`, the key ring and the default locale are mandatory. An invalid value stops the process at startup with a `ConfigError` naming the variable, never
its value.

## Run

```bash
npm run build -w @nawara/service-kit && npm run build -w notification-service
npm run start:prod -w notification-service                      # or: docker compose --profile db up -d notification-service
npm test -w notification-service                                # unit
TEST_DATABASE_ADMIN_URL=postgres://postgres:…@127.0.0.1:5433/postgres npm run test:e2e -w notification-service
                                                                # foundation, built process, and the real-PostgreSQL suites
```

The production image (`apps/notification-service/Dockerfile`, repo-root context) is two stages with production dependencies only.
It runs as the non-root `node` user with Node as PID 1; Compose gives it a 60 s stop grace.

## Next (Stage 16 roadmap)

| Stage | Adds |
|---|---|
| 16.4 ✅ | the database (`DbModule`, provisioning, the migrator / app roles), the five tables, the template catalog and publication |
| 16.5 ✅ | Auth event intake on the kit RabbitMQ consumer; sealed one-time codes (`NOTIFICATION_SECRET_KEYS`); variable-value validation; locale resolution (`NOTIFICATION_DEFAULT_LOCALE`); E.164 enforcement |
| 16.6 | `POST /notification/notifications`, status, cancel; `NOTIFICATION_SERVICE_POLICY`; OpenAPI at `/notification/docs` |
| 16.7 | the delivery engine (claim, lease, attempts, retry, ambiguity), the renderer and the test provider |
| 16.8 | the email and SMS providers |
| 16.9 / 16.10 | security, observability and operations; certification |
