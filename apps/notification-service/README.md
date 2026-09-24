# notification-service

> **Status: foundation (16.3), persistence and templates (16.4), Auth event intake (16.5), internal send API (16.6), delivery engine
> (16.7).** Intents arrive from Auth's events and from trusted Core services over the API; the delivery engine claims their
> deliveries, renders the pinned template and calls a provider through the `ChannelProvider` port. **Only the no-network test
> provider exists** (development and tests; refused in production), so production still sends nothing until the real adapters (16.8).

Generic, product-agnostic delivery of notifications (email and SMS first) for Nawara Core. Producers decide *why* and *when*; this
service decides *how* and *where*. Design: [ADR-0046](../../docs/adr/0046-notification-service-architecture.md),
[SDD](../../docs/sdd/notification-service.md), [Stage 16 roadmap](../../docs/architecture/stage-16/stage-16-1-decisions-and-roadmap.md),
[Stage 16.3 record](../../docs/architecture/stage-16/stage-16-3-service-foundation.md),
[Stage 16.4 record](../../docs/architecture/stage-16/stage-16-4-persistence-and-templates.md),
[Stage 16.5 record](../../docs/architecture/stage-16/stage-16-5-notification-event-intake.md),
[Stage 16.6 record](../../docs/architecture/stage-16/stage-16-6-notification-send-api.md),
[Stage 16.7 record](../../docs/architecture/stage-16/stage-16-7-notification-delivery-engine.md).

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

## Send API (16.6, internal)

Every route needs a Core service token (`ServiceTokenGuard`). The caller is the token's service, and its rights come from
`NOTIFICATION_SERVICE_POLICY` (explicit templates, channels and organization mode; deny by default).

| Route | Result |
|---|---|
| `POST /notification/notifications` (`Idempotency-Key` required) | `202 { id, status: "accepted", deliveries }` once committed; the same key and body replays it; a changed body (even only the code) is `422 idempotency_key_reused` |
| `GET /notification/notifications/:id` | the creating caller only; derived status, destination hints only |
| `POST /notification/notifications/:id/cancel` | the creating caller only; PENDING → CANCELLED; `409 delivery_in_progress` if one is SENDING |

The request hash is **HMAC-SHA-256** under `NOTIFICATION_REQUEST_HASH_KEY` (D25), never an unkeyed digest. OpenAPI is at
`/notification/docs` behind basic auth when `SWAGGER_PASSWORD` is set.

## Delivery engine (16.7)

- **Runs** only when `NOTIFICATION_DELIVERY_PROVIDER` names a provider (`test` today, refused in production). With `none` (the
  default) there is no worker and deliveries stay `PENDING`. The secret purge runs in every case.
- **One pass:** recover expired leases from the attempt evidence → claim due `PENDING` rows (`FOR UPDATE SKIP LOCKED`, oldest due
  first) as `SENDING` under a lease → per delivery, with at most `NOTIFICATION_WORKER_CONCURRENCY` in flight: re-check cancel and
  expiry, the caller+template limit, decrypt and render the **pinned** version, commit the attempt `STARTED`, call the provider
  outside any transaction (bounded by `NOTIFICATION_PROVIDER_TIMEOUT_MS`), record the outcome and the transition in one transaction.
- **Outcomes:** accepted → `SENT`; retryable → `PENDING` with backoff (or `FAILED retries_exhausted`, or `EXPIRED` past
  `expiresAt`); terminal → `FAILED`; ambiguous (a timeout, a thrown error, a lost worker) → one resend of a one-time code, otherwise
  `UNCONFIRMED` (SDD §8.5).
- **Secret purge:** in the transaction that ends the last delivery, and a `SecretPurge` loop for intents past `expiresAt`.
- **Test provider** (`src/delivery/test-provider.ts`): the destination picks the scenario (`+retry`, `+429`, `+reject`,
  `+ambiguous`, `+hang` in an email local part; SMS numbers ending `0001`, `0429`, `0002`, `0003`, `0004`); anything else is accepted.
- **Operator query** (the due backlog, no metrics platform yet):
  `SELECT channel, count(*), min("nextAttemptAt") FROM notification_delivery WHERE status = 'PENDING' AND "nextAttemptAt" <= now() GROUP BY channel;`

## Configuration

| Variable | Default | Bounds | Notes |
|---|---|---|---|
| `NODE_ENV` | `production` | `development`, `test`, `production` | unset means production (the safe behaviour) |
| `PORT` | 3000 | 1–65535 | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` | |
| `BODY_LIMIT_KB` | 100 | 1–10240 | |
| `CORS_ORIGINS` | empty (off) | exact http(s) origins | no wildcard |
| `TRUST_PROXY` | `false` | `true` / `false` | |
| `HTTP_DRAIN_TIMEOUT_MS` | 5000 | 500–120000 | bound on the HTTP drain at shutdown; also `NOTIFICATION_PROVIDER_TIMEOUT_MS` < 60 s − this (SDD §8.2) |
| `DATABASE_URL` | **required** | `postgres:` / `postgresql:` | the runtime role `notification_app`; production refuses `postgres`, `root` and `*_migrator` |
| `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS` | 10, 5000, 30000, 60000, statement + 5000 | the kit bounds | |
| `MIGRATION_DATABASE_URL` | – | | the migrator, read only by `npm run migrate` |
| `RABBITMQ_URL` | **required** | `amqp:` / `amqps:` | the broker of the event intake; never logged |
| `RABBITMQ_CONFIRM_TIMEOUT_MS`, `RABBITMQ_HEARTBEAT_S` | 5000, 10 | 100–60000, 5–60 | the Core broker bounds |
| `NOTIFICATION_SECRET_KEYS`, `NOTIFICATION_SECRET_ACTIVE_KEY_ID` | **required** | `id:base64(32 bytes)[,…]`, distinct; the active id must exist | secret: seals one-time codes; rotation = add, activate, retire once unused |
| `NOTIFICATION_DEFAULT_LOCALE` | **required** | BCP 47 | a product input (D7); every mapped template must be published in it, or the intake does not start |
| `NOTIFICATION_REQUEST_HASH_KEY` | **required** | base64, ≥ 32 bytes, differs from the secret keys | secret: the HMAC key of the API request hash; one key (rotation: 16.9) |
| `NOTIFICATION_SERVICE_POLICY` | empty | `{"callers": {…}}` | required once `SERVICE_TOKENS` registers a caller |
| `NOTIFICATION_MAX_SCHEDULE_AHEAD_SEC` | 2592000 | 60–31536000 | how far ahead `scheduledAt` may be |
| `NOTIFICATION_API_INTAKE_LIMIT_PER_MINUTE` | 600 | 1–100000 | per caller (`429 rate_limited`) |
| `SWAGGER_USERNAME`, `SWAGGER_PASSWORD` | `docs`, unset | password ≥ 16 | OpenAPI mounted only with a password |
| `NOTIFICATION_DELIVERY_PROVIDER` | `none` | `none`, `test` | `test` (no network, delivers nothing) is refused in production; `none` runs no worker |
| `NOTIFICATION_WORKER_INTERVAL_MS` | 1000 | 100–60000 | pause between two passes (delivery and purge loops) |
| `NOTIFICATION_WORKER_BATCH_SIZE` | 20 | 1–500 | deliveries claimed (and secrets purged) per pass |
| `NOTIFICATION_WORKER_CONCURRENCY` | 4 | 1–50, < `DB_POOL_MAX` | provider calls in flight per instance |
| `NOTIFICATION_LEASE_MS` | 60000 | 5000–3600000, ≥ 2 × the provider timeout | a claim's lease; queued claims are renewed every lease / 4 |
| `NOTIFICATION_PROVIDER_TIMEOUT_MS` | 10000 | 100–30000 | bound on one provider call (then ambiguous); the worker's shutdown drain is this + 2 s |
| `NOTIFICATION_RETRY_BASE_MS`, `NOTIFICATION_RETRY_CEILING_MS` | 30000, 1800000 | 1000–3600000; ≥ base, ≤ 86400000 | backoff base × 2ⁿ⁻¹ ± 20 %, capped; `Retry-After` honoured |
| `NOTIFICATION_MAX_ATTEMPTS` | 5 | 1–20 | provider calls before `FAILED retries_exhausted` |
| `NOTIFICATION_TIME_ZONE` | `UTC` | an IANA zone | the platform zone datetimes are rendered in (D22) |
| `NOTIFICATION_RATE_CALLER_TEMPLATE_PER_MINUTE` | 6000 | 1–1000000 | sends per source + template per minute (`notif_caller_template`); over it → `FAILED rate_limited` |
| `SERVICE_TOKENS` | empty | `<caller>:<sha256 hex>`, comma-separated, ≤ 2 per caller | secret-derived (digests only); empty refuses every service-token call |

`DATABASE_URL`, `RABBITMQ_URL`, the secret key ring, the request-hash key and the default locale are mandatory. An invalid value stops the process at startup with a `ConfigError` naming the variable, never
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
| 16.6 ✅ | `POST /notification/notifications`, status, cancel; `NOTIFICATION_SERVICE_POLICY`; the keyed request hash; OpenAPI at `/notification/docs` |
| 16.7 ✅ | the delivery engine (claim, lease, attempts, retry, ambiguity), the renderer, the test provider and the secret purge |
| 16.8 | the email and SMS providers |
| 16.9 / 16.10 | security, observability and operations; certification |
