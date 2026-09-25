# Stage 17.2 — File Service foundation

- **Status:** merged (PR #106); certified with the whole of Stage 17 in [17.10](./stage-17-10-focused-certification.md).
- **Scope:** the production-shaped `file-service` application on `@nawara/service-kit`: bootstrap, configuration, logging and request
  context, errors, health and readiness, the bounded HTTP drain and shutdown, service authentication, the caller-policy foundation,
  database provisioning, the production image, Compose and CI integration, tests.
- **Not in scope (and not present):** file or ticket tables, migrations of its own, storage, upload, download, tickets, MIME
  detection, checksums, workers, a scanner, events, any call to Auth or a product service.
- **Frozen design:** [ADR-0048](../../adr/0048-file-service-architecture.md), [SDD](../../sdd/file-service.md),
  [Stage 17.1](./stage-17-1-decisions-and-roadmap.md).

## 1. Baseline

`main` at `d5aab89` (Stage 17.1 merged, PR #105). The service follows the latest Core pattern (Notification 16.3 / 16.4), adapted
to what File needs: no broker, no Swagger yet (no route to document), no feature module.

## 2. Structure

```text
apps/file-service/
  src/main.ts                     bootstrap (the canonical Core path)
  src/app.module.ts               HealthModule + DbModule + ServiceAuthModule + the validated configuration
  src/config/file-config.ts       loadFileConfig (kit BaseConfig + DATABASE_URL + SERVICE_TOKENS + FILE_SERVICE_POLICY + FILE_MAX_BYTES)
  src/policy/caller-policy.ts     FileCallerPolicy (deny by default)
  src/policy/media-types.ts       the V1 allow-list (F13)
  db/migrations/README.md         empty until 17.3
  Dockerfile, README.md, tests (unit, e2e, built process)
```

## 3. Bootstrap, logging, errors, context

`loadFileConfig` → `NestFactory.create(AppModule.register(config), { bodyParser: false })` → `configureApp` (shutdown admission,
request / correlation ids, helmet, the bounded JSON parser, the DTO whitelist, the kit exception filter, the JSON logger, shutdown
hooks) → `listen` → `service_started`. Nothing File-specific was reinvented.

- **Body parsing:** the kit installs `json` only; a non-JSON body is never buffered or rejected by a parser (tested with a 2 MiB
  `application/octet-stream`), so 17.5 can stream raw uploads.
- **Ticket-path log safety:** the kit writes no access log and never logs `req.url`, `originalUrl` or path parameters: the exception
  filter logs an error class and message only; Nest logs route **patterns** at startup (`Mapped {…} route`), never request URLs. No
  redaction facility is needed now. **Requirement for 17.6:** a future access log, if one is ever added, must redact `/file/t/*`
  (the SDD §11.1 rule); a test there must request a ticket path and scan every log line (as the 17.2 leak test already does for a
  token-shaped path).
- **Errors:** the kit's uniform body; no file error code is defined before its stage.

## 4. Configuration

| Variable | Rule |
|---|---|
| kit HTTP baseline (`NODE_ENV`, `PORT`, `LOG_LEVEL`, `BODY_LIMIT_KB`, `CORS_ORIGINS`, `TRUST_PROXY`, `HTTP_DRAIN_TIMEOUT_MS`) | kit bounds |
| `DATABASE_URL` | required; production refuses `postgres`, `root` and `*_migrator` (the least-privilege runtime role) |
| `DB_*` | kit bounds |
| `SERVICE_TOKENS` | kit format; empty refuses every service call |
| `FILE_SERVICE_POLICY` | required when a caller is registered; deny by default (§6) |
| `FILE_MAX_BYTES` | default 26 214 400 (25 MiB), bounds 1 – 104 857 600 (100 MiB) (F29; binary megabytes, stated explicitly) |

Validated at boot here because the caller policy's `maxBytes` must not exceed it; **enforced** on uploads in 17.5. Deliberately
absent until their stage: the attach window and request-hash key (17.5), the ticket TTL (17.6), storage settings (17.4). Every error
names the variable and never echoes its value.

## 5. Database, health and readiness

- **Provisioning:** `infra/postgres/init` creates the `file` database, `file_migrator` (owner) and `file_app` (DML through default
  privileges); `infra/postgres/verify.sh` checks the file roles like every other service (verified: all least-privilege checks pass,
  including the kit migrations as the migrator).
- **Migration baseline:** readiness checks `[kit migrations, apps/file-service/db/migrations]`; the service directory holds only a
  README (the runner counts `*.sql` only), so today the baseline is the three kit migrations. `npm run migrate` applies them as the
  migrator; a re-run applies nothing; the runtime role cannot apply a pending migration (tested with a throwaway fixture).
- **`/health`** = process liveness (200 whatever the database). **`/ready`** = `database` + `migrations`: 503 with no database or with
  migrations pending, 200 once applied, 503 on database loss and 200 on recovery (tested live and in the image). No storage, broker or
  Auth check exists; storage outages will be per-request `503 storage_unavailable` from 17.4 (ADR-0048 §8).

## 6. Service authentication and the caller policy

- The kit `ServiceAuthModule` / `ServiceTokenGuard`: the caller is the service named by the matching token digest; a caller header,
  query parameter or body field cannot change it (tested); unknown, malformed, non-bearer and user-shaped tokens get one generic 401.
- **`FILE_SERVICE_POLICY`** (SDD §11): per caller `operations` ⊆ {`upload`, `read`, `attach`, `delete`, `issue_ticket`},
  `organizations` (`none` | `request`), and — exactly when the caller may `upload` or `issue_ticket` — `mediaTypes` (⊆ the V1
  allow-list) and `maxBytes` (1 … `FILE_MAX_BYTES`). Refused at startup: a registered caller without an entry, an entry without a
  token, unknown properties or operations, a wildcard, a repeated operation, a media type outside the allow-list, `maxBytes` above the
  ceiling (a caller cannot raise its own limit), limits on a caller that cannot create bytes. `allows(caller, operation)` is false for
  anything not granted. The 17.5+ routes will consume it; a test-only probe proves the deny-by-default path end to end.
- No user JWT guard exists (F16 rejected option B); ticket holders will not be callers.

## 7. Shutdown

The kit drain: SIGTERM / SIGINT → `/ready` 503, new requests refused, running requests finish within `HTTP_DRAIN_TIMEOUT_MS` (a
hung request is cut at the bound), the pool closes last, exit. Tested in-process (drain completes; a 1.5 s request is cut at 500 ms)
and on the built process for both signals (one shutdown sequence, bounded exit); in the image `docker stop` exits 0 in 60 ms.

## 8. Image, Compose, CI, repository checks

- **Image:** two stages, production dependencies only, `USER node` (uid 1000), `CMD ["node", "dist/main.js"]` (Node is PID 1),
  environment only `PATH`, `NODE_VERSION`, `YARN_VERSION`, `NODE_ENV=production`, no secret in the layer history. `amqplib`, `multer`
  and `file-type` are present only transitively (the kit's dependency; `@nestjs/platform-express`, `@nestjs/common`), never declared
  or imported by the service. The repository smoke (`scripts/smoke-core-image.sh file-service`) passes: uid 1000, `/health` 200
  stable, `/ready` 503 (no database).
- **Compose:** `file-service` (profile `db`, port 3005, 60 s stop grace, PostgreSQL only); the `FILE_*` role passwords in
  `.env.example` and the postgres service.
- **CI:** `core-ci.yml` node matrix (lint, typecheck, unit, e2e, build) and image matrix now include `file-service`; the product-term
  guard of `check:repo` covers `apps/file-service/src/`.

## 9. Evidence

- **Tests:** unit 42 (configuration 16, caller policy 26); E2E 42 in 4 files (foundation 23, health 4, runtime role 2, built process
  13); all green on a real PostgreSQL. Lint clean.
- **Mutations** (each killed; all files, including the rebuilt kit `dist`, restored and verified with `sha256sum -c`):

  | Mutation | Caught by |
  |---|---|
  | M1 an unknown caller allowed by the policy | the deny-by-default unit test |
  | M2 the caller identity taken from an `x-caller` header (kit guard) | the identity-spoofing E2E |
  | M3 no database module (a database outage still "ready") | 6 E2E (readiness, database loss, sessions, built process) |
  | M4 the presented service token logged (kit guard) | the log-leak E2E, **after a fix**: it first survived because Nest's static logger follows the last application created, so the scan now reads every application's lines (`ALL_LOGS`) |
  | M5 an unbounded HTTP drain | both drain E2E |
  | M6 production accepting the superuser / migrator as the runtime role | the unit test and 2 built-process tests |
  | M7 a caller `maxBytes` above `FILE_MAX_BYTES` accepted | 2 unit tests |

- **Security:** tokens, digests, database passwords, a cookie, a request body secret and a token-shaped path never appear in logs;
  errors are opaque; spoofed identity refused; malformed policy refused; the image is non-root with no baked secret; development-only
  settings (superuser / migrator runtime role) refused in production.

## 10. Observations and carryovers

- **ADR-0033:** a dated pointer note added (documentation only): File ticket redemption is a deliberate case with no user token at
  File Service; the decision is unchanged.
- **Test-quality carryover (Notification):** Notification's foundation log-leak test has the same latent weakness as M4 exposed here
  (it scans one application's `logs` after other applications were created). Not changed in this stage; recorded for 21.R1.
- **Local environment:** the local Compose PostgreSQL container had been removed outside the session (Stage 16.10); this stage's
  database tests ran on throwaway PostgreSQL containers, removed afterwards.
- **Roadmap:** 17.3 persistence (file + ticket tables) → 17.4 storage port → 17.5 upload and upload tickets, type and checksum → 17.6
  download and download tickets → 17.7 delete / orphans / reconciliation → 17.8 security → 17.9 operations → 17.10 certification.
  Production enablement: the storage vendor, the malware policy, legal retention, backup / DR, bucket and credential setup. Core:
  21.R1 / 21.R2, Stage 22.
