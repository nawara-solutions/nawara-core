# Stage 16.3 — Notification service foundation

- **Status:** implemented and validated (2026-09-24), pending review
- **Decision:** [ADR-0046](../../adr/0046-notification-service-architecture.md) rule 18 (readiness, shutdown, image); design in the
  [notification-service SDD](../../sdd/notification-service.md) §2, §16 and §18; roadmap row 16.3 of the
  [Stage 16.1 register](./stage-16-1-decisions-and-roadmap.md#3-frozen-implementation-roadmap).
- **Scope:** the runtime shell only. No business route, no persistence, no event intake, no send API, no delivery worker, no
  provider.

## 1. Before

`apps/notification-service` was the unmodified Nest starter from the first commit:
- a `Hello World!` controller and service, their spec and a starter e2e;
- `NestFactory.create` with the default logger and `PORT ?? 3000`;
- no `@nawara/service-kit`, no configuration validation, no health or readiness, no error contract, no shutdown handling;
- no Dockerfile, no Compose entry, no database, no broker;
- the Nest README.

It was already in the CI `node` matrix (lint, typecheck, unit, e2e, build) but excluded from the image job as "a scaffold".

## 2. What changed

| File | Classification | Change |
|---|---|---|
| `src/main.ts` | Notification foundation | the kit bootstrap, as Organization and Billing: `loadNotificationConfig` (fail closed), `JsonLogger`, `configureApp`, `service_started` |
| `src/app.module.ts` | Notification foundation | `AppModule.register(config)`: the kit `HealthModule` (bounded HTTP drain) and `ServiceAuthModule` |
| `src/config/notification-config.ts` | Notification configuration | the kit `BaseConfig` + `SERVICE_TOKENS`; `SERVICE_NAME = 'notification-service'` |
| `src/app.controller.ts`, `app.service.ts`, `app.controller.spec.ts`, `test/app.e2e-spec.ts` | Notification foundation | removed (starter) |
| `package.json`, `package-lock.json` | Notification configuration | + `@nawara/service-kit`, `class-transformer`, `class-validator` (the kit's validation pipe); − `@nestjs/mau` and the `deploy` script (starter); no provider SDK |
| `src/config/notification-config.spec.ts`, `test/**`, `vitest.config.e2e.ts` | Notification tests | the tests in §6; test-only probe routes (the Billing Stage 1 pattern) |
| `Dockerfile`, `README.md` | Notification deployment / documentation | the Organization image pattern; the service README |
| `docker-compose.yml` | Notification deployment (shared file, additive) | a `notification-service` entry: no dependency, 60 s stop grace, loopback port 3004 |
| `scripts/smoke-core-image.sh`, `.github/workflows/core-ci.yml` | Notification deployment (shared CI, additive) | a `notification-service` smoke case; the service joins the CI image job |

No service-kit, Auth, Billing, Payment or Organization code changed.

## 3. Decisions

- **Identity:** `notification-service`. It is used by the logger (`service`), the config, the Compose service, the image and the
  CI matrix. Later stages use it for the database `application_name` and the event `source`.
- **Database: completely deferred to 16.4.** The foundation has nothing to persist. A pool with no query, a readiness check on an
  empty schema, and provisioning with no migration would be infrastructure with no user. 16.4 adds `DbModule`, the migrator /
  app roles in `infra/postgres/init/01-service-databases.sh`, the Compose database wiring, the runtime-role guard, the
  migrations in the image and the database readiness check, together with the five tables. The kit's `DB_*` limits in
  `BaseConfig` are parsed with their bounded defaults and are unused until then.
- **RabbitMQ: completely deferred to 16.5.** A bus with no subscription is a connection with no consumer. 16.5 adds the kit
  `RabbitMqEventBus` subscription, its readiness check (the Billing `registerRabbitmqReadiness` pattern) and the consumer drain.
- **Service authentication: wired, with no route using it.** `ServiceAuthModule` with `SERVICE_TOKENS` (empty = every call
  refused) is part of every kit service's foundation (Billing Stage 1). Malformed tokens stop the process. The send API (16.6)
  puts `ServiceTokenGuard` on its routes.
- **OpenAPI deferred to 16.6.** There is no API to document. `/notification/docs` arrives with the send API, behind basic auth
  as for Organization and Billing.
- **Deviation from the 16.1 roadmap row (recorded, owner-directed).** The row listed "policy parse, key ring", `DbModule`,
  database provisioning and "the kit bus (no subscription yet)" under 16.3. The Stage 16.3 brief restricted configuration to
  what the foundation uses, so they move:

  | Item | Moves to |
  |---|---|
  | `DbModule`, database provisioning, migrations in the image | 16.4 |
  | kit bus, `NOTIFICATION_SECRET_KEYS` (the key ring seals codes at intake) | 16.5 |
  | `NOTIFICATION_SERVICE_POLICY`, OpenAPI docs | 16.6 |

  ADR-0046's decisions are unchanged.

## 4. Runtime

```text
HTTP ──► shutdownAdmission ─► request / correlation ids ─► helmet ─► bounded JSON ─► DTO whitelist ─► routes ─► KitExceptionFilter
                                                                                        │
                                                                     GET /health   GET /ready   (nothing else)
```

- **Routes:** `GET /health` → `{status:'ok'}`, never touching a dependency. `GET /ready` → `{status:'ready'}`, or 503
  `{failed:['shutting_down']}` once shutdown starts. It has no dependency check because the service has none yet. Every
  other path is the kit 404.
- **Configuration:**
  - the kit base: `NODE_ENV` (default `production`), `PORT`, `LOG_LEVEL`, `BODY_LIMIT_KB`, `CORS_ORIGINS`, `TRUST_PROXY`,
    `HTTP_DRAIN_TIMEOUT_MS` (5000, 500–120000);
  - `SERVICE_TOKENS` (optional; secret-derived digests only).

  Nothing is mandatory. Invalid values exit non-zero with a `ConfigError` naming the variable and never its value.
- **Shutdown (the Stage 15.5 kit):** on SIGTERM:
  1. admission closes: new requests get 503 with `Connection: close`, and `/ready` answers 503;
  2. running requests finish within `HTTP_DRAIN_TIMEOUT_MS`; the rest are cut off;
  3. `service_shutdown_complete`.

  As PID 1 in the image, the process then exits with code 0. There are no workers, pool or broker to drain yet.

## 5. Findings (existing kit behaviour; nothing changed)

- **Keep-alive connections hold the drain to its bound.** A request that completes *during* the drain leaves its keep-alive
  connection open (its response was admitted before draining, so it carries no `Connection: close`). The kit closes idle
  connections only when the drain starts, so `server.close()` waits for the `HTTP_DRAIN_TIMEOUT_MS` deadline.

  Measured: close at 3003 ms with keep-alive, 1308 ms with `Connection: close`, drain bound 3000 ms. The effect is bounded and
  certified (Stage 15.5), and it affects every kit service equally.
- **Unhandled error messages are logged (redacted for credentials only).** `KitExceptionFilter` logs `detail: error.message`
  for an unexpected error, and `redact` strips URL credentials and bearer tokens but not phone numbers, emails or codes. Nothing
  in 16.3 can put those in an error.

  **Carried to 16.8 / 16.9:** provider adapters must map provider errors to failure classes and codes, and must never re-throw a
  raw provider error, whose message can contain the destination. The 16.9 redaction test covers this path.

## 6. Evidence

| Proof | Where | Result |
|---|---|---|
| identity; production default; no mandatory setting; no deferred setting present; `SERVICE_TOKENS` parsed or refused without echo; `PORT`, `HTTP_DRAIN_TIMEOUT_MS`, `NODE_ENV`, `LOG_LEVEL`, `BODY_LIMIT_KB`, `CORS_ORIGINS`, `TRUST_PROXY` bounds | `src/config/notification-config.spec.ts` | 12 / 12 |
| `/health`, `/ready`, no business or starter route, kit 404, known error code, opaque 500, validation 400, malformed JSON, 413, request / correlation ids in headers, bodies and logs, unsafe id refused, service-token matrix, fail-closed default, log scan (tokens, digests, bodies, cookies, credentials), secure headers, CORS off | `test/foundation.e2e-spec.ts` | 19 / 19 |
| drain: a running request completes, `/ready` 503 while draining, close bounded; a request outliving the bound is cut off at it | same | 2 / 2 |
| the built `dist/main.js` in production configuration: live, ready, 404 at `/`, structured logs with no token, SIGTERM exit inside the bound; 4 invalid configurations → non-zero exit, `ConfigError` names the variable, value never echoed | `test/process.e2e-spec.ts` | 5 / 5 |
| production image: `scripts/smoke-core-image.sh notification-service` | local run | `SMOKE PASSED uid=1000 /health=200 (stable) /ready=200` |
| container: non-root (uid 1000), Node as PID 1, no `src`, no `typescript` / `vitest` / `@nestjs/cli` / `supertest`; `docker stop` → exit 0 in 318 ms; `service_shutdown_complete signal=SIGTERM`; token digest in logs: 0 | local run | pass |
| mutation M1: identity `notifications` → 1 unit and 2 E2E tests fail | | killed, restored |
| mutation M2: `HealthModule.forRoot()` without the configured drain bound → both drain tests fail | | killed, restored |
| lint, typecheck, build, `check:repo`, `test:repo`, `git diff --check` | | pass |

## 7. Carried over, unchanged

- **E.164 (D20):** no phone behaviour in 16.3. Notification will validate E.164 defensively and never assume a country.
- **D21 (unpeppered rate-limit keys):** open. No rate limiter and no destination exists in 16.3; resolve before destination-keyed
  SMS limits.
- **Auth outbox (D19):** deferred.
- **Attachments:** future File Service references (Stage 17).
- **Retention:** SDD §17, unchanged.
- **Providers:** ADR-0019 acceptance (D3) and the email-vendor ADR (D2) are still due before 16.8.
