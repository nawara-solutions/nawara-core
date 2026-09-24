# notification-service

> **Status: service foundation (Stage 16.3).** The service builds, boots, answers `/health` and `/ready`, and shuts down
> gracefully on `@nawara/service-kit`. **It sends nothing yet:** it has no business route, no database, no event consumer and no
> provider. Those arrive in the Stage 16 sub-stages below. Nothing in any Core flow calls it today.

Generic, product-agnostic delivery of notifications (email and SMS first) for Nawara Core. Producers decide *why* and *when*; this
service decides *how* and *where*. Design: [ADR-0046](../../docs/adr/0046-notification-service-architecture.md),
[SDD](../../docs/sdd/notification-service.md), [Stage 16 roadmap](../../docs/architecture/stage-16/stage-16-1-decisions-and-roadmap.md),
[Stage 16.3 record](../../docs/architecture/stage-16/stage-16-3-service-foundation.md).

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

`/ready` has no dependency check because the service has no dependency yet. The database (16.4) and the RabbitMQ consumer (16.5)
each register their check when they arrive. Email and SMS providers are never readiness dependencies.

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
| `SERVICE_TOKENS` | empty | `<caller>:<sha256 hex>`, comma-separated, ≤ 2 per caller | secret-derived (digests only); empty refuses every service-token call |

Nothing is mandatory yet. An invalid value stops the process at startup with a `ConfigError` naming the variable, never its value.
The kit's `DB_*` limits are parsed with their bounded defaults and unused until 16.4.

## Run

```bash
npm run build -w @nawara/service-kit && npm run build -w notification-service
npm run start:prod -w notification-service                      # or: docker compose --profile db up -d notification-service
npm test -w notification-service                                # unit
npm run test:e2e -w notification-service                        # foundation + built-process E2E (no database or broker needed)
```

The production image (`apps/notification-service/Dockerfile`, repo-root context) is two stages with production dependencies only.
It runs as the non-root `node` user with Node as PID 1; Compose gives it a 60 s stop grace.

## Next (Stage 16 roadmap)

| Stage | Adds |
|---|---|
| 16.4 | the database (`DbModule`, provisioning, the migrator / app roles), the five tables, templates |
| 16.5 | Auth event intake on the kit RabbitMQ consumer; sealed one-time codes (`NOTIFICATION_SECRET_KEYS`) |
| 16.6 | `POST /notification/notifications`, status, cancel; `NOTIFICATION_SERVICE_POLICY`; OpenAPI at `/notification/docs` |
| 16.7 | the delivery engine (claim, lease, attempts, retry, ambiguity) and the test provider |
| 16.8 | the email and SMS providers |
| 16.9 / 16.10 | security, observability and operations; certification |
