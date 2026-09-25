# Stage 18.2 — Audit service foundation

- **Status:** implemented and validated on `feat/audit-service-foundation` (awaiting review; not committed).
- **Scope:** the production-shaped `audit-service` on `@nawara/service-kit`: bootstrap, configuration, logging and request context,
  errors, health and readiness, the bounded HTTP drain and shutdown, service authentication, the caller-policy foundation, database
  provisioning and migrations, HTTP-server bounds, the production image, Compose and CI integration, tests.
- **Not in scope (and not present):** the `audit_record` table and its append-only privileges (18.3), the audit contract and catalog
  (18.4), the RabbitMQ consumer, queues, bindings, DLQ (18.5), any query route (18.6), producer changes and the Auth outbox (18.7), the
  retention machinery and maintenance role (18.8), operational campaigns (18.9), certification (18.10).
- **Frozen design followed:** [ADR-0049](../../adr/0049-audit-trail-architecture.md), [SDD](../../sdd/audit-service.md),
  [Stage 18.1](./stage-18-1-decisions-and-roadmap.md) (A23, A25, A36, A38–A40, A52, A68). No decision reopened; no deviation.

## 1. Baseline

`main` at `b623832138c0722c9a1f9904a1046f888cbf18e8` (Stage 18.1 merged, PR #115); working tree clean except the untracked
`docs/reports/` (untouched). The foundation follows the File Service 17.2 pattern (the latest Core foundation), with File's later HTTP
bound (17.9 O-5) applied from the start.

## 2. Structure

```text
apps/audit-service/
  src/main.ts                     bootstrap (the canonical Core path) + the silent-socket bound
  src/app.module.ts               HealthModule + DbModule + ServiceAuthModule + the validated configuration
  src/config/audit-config.ts      loadAuditConfig (kit BaseConfig + DATABASE_URL + SERVICE_TOKENS + AUDIT_SERVICE_POLICY)
  src/policy/caller-policy.ts     AuditCallerPolicy (deny by default)
  src/policy/categories.ts        the four categories frozen by 18.1 (A52)
  src/http/http-server.ts         the silent-socket bound (server.timeout)
  db/migrations/README.md         empty until 18.3
  Dockerfile, README.md, tests (unit, e2e, built process, runtime role)
```

## 3. Service-kit reuse

Everything generic comes from the kit, unchanged: `configureApp` (bounded JSON parser, validation whitelist, helmet, CORS off, request
and correlation ids, exception filter, JSON logger, shutdown hooks), `HealthModule` (liveness, readiness registry, bounded HTTP drain),
`DbModule` (bounded pool, statement / idle-in-transaction / client query deadlines, readiness `database` + `migrations`, pool closed
last), `ServiceAuthModule` / `ServiceTokenGuard` / `@CallerService`, `EnvReader` / `loadBaseConfig` / `parseServiceTokens`, the
migration runner and CLI. **No kit change.** The one service-level addition, the silent-socket bound, duplicates File's 17.9 function
(`configureHttpServer`); moving it into the kit is a 21.R1 consolidation, not a Stage 18 need.

## 4. Configuration

| Variable | Default | Rule |
|---|---|---|
| kit HTTP baseline (`NODE_ENV`, `PORT`, `LOG_LEVEL`, `BODY_LIMIT_KB`, `CORS_ORIGINS`, `TRUST_PROXY`, `HTTP_DRAIN_TIMEOUT_MS`) | production, 3000, info, 100 KB, none, false, 5000 | kit bounds |
| `DATABASE_URL` | required | `postgres:` / `postgresql:`; production refuses `postgres`, `root`, `*_migrator` |
| `DB_*` | 10 / 5000 / 30000 / 60000 / statement + 5000 | kit bounds (pool 1–100; the client query deadline must exceed the statement timeout) |
| `SERVICE_TOKENS` | empty | kit format; empty refuses every service call |
| `AUDIT_SERVICE_POLICY` | empty | required when a caller is registered; deny by default (§6) |
| `MIGRATION_DATABASE_URL` | – | read only by `npm run migrate` |

Every error names the variable and never echoes a value (10 unit refusals, 15 built-process refusals; mutation M5). Absent on
purpose: broker, queue, prefetch, retry (18.5); page / window / rate bounds (18.6); retention durations (18.8); any Auth or Organization
URL (never, A36).

## 5. Health, readiness, shutdown

- **`/health`** = process liveness: `200 {"status":"ok"}` whatever the database (tested with no database, a lost database, a paused
  database in the image).
- **`/ready`** = `database` + `migrations` (the kit checks over `[kit migrations, apps/audit-service/db/migrations]`): 503
  `["migrations"]` while one is pending or a recorded migration disappears from the ledger, 503 `["database"]` on database loss, 200
  on recovery; `["shutting_down"]` once draining. No broker, Auth, Organization or product check. Bodies carry check names only.
- **Shutdown** (kit): SIGTERM / SIGINT → `/ready` 503 and new requests refused → running requests drained within
  `HTTP_DRAIN_TIMEOUT_MS` (a 1.5 s request completes under a 3 s bound; is cut at a 0.5 s bound) → pool closed last (0 sessions left) →
  exit (built process: one shutdown sequence, exit within the bound; image: `docker stop` 66 ms, exit 0). No consumer exists to stop;
  18.5 adds it to this lifecycle.

## 6. Service authentication and the caller policy

- The kit `ServiceTokenGuard`: the caller is the service named by the matching SHA-256 digest, compared in constant time against every
  entry; a caller header, query parameter or body field cannot change it; missing, malformed, non-bearer, unregistered and user-shaped
  tokens get one generic 401; tokens and digests never reach a log.
- **`AUDIT_SERVICE_POLICY`** (A40): per caller `operations` ⊆ {`read_organization`, `read_platform`}, `categories` ⊆ {`security`,
  `business`, `commercial`, `administrative`} (explicit, non-empty), optional `sourceServices` (service-name grammar). Refused at startup:
  a registered caller without an entry, an entry without a token, unknown properties (an organization list included: organization scope
  is one organization per request, 18.6), unknown or wildcard operations / categories / sources, repeats, empty lists. `allows(caller,
  op)` is false for anything not granted; platform scope never implies organization scope. No request value widens a grant (tested with
  scope, category, organization and caller headers and query parameters).
- **Stage 18.6 owns:** the query routes, per-request organization scope, category and source filtering of results,
  `audit.platform_query`, rate limits.
- No end-user authentication, no Auth / Organization client (A36).

## 7. Database

- **Provisioning:** `infra/postgres/init` creates the `audit` database, `audit_migrator` (owner) and `audit_app` (DML through the Core
  default privileges); `infra/postgres/verify.sh` includes `audit` in every least-privilege check (203 checks pass, among them: the
  runtime role cannot create, alter, drop or truncate tables, create roles or databases, or connect to any other service database; the
  migrator cannot connect to another service database; neither is a superuser).
- **Migrations:** the kit baseline only (3 migrations: outbox / inbox, rate limit, generic triggers); the service directory holds only a
  README. Fresh database → 3 applied → re-run 0 applied (tested; also through the image as the migrator). The kit tables are the Core
  baseline every service carries; Audit does not use them in 18.2.
- **Runtime role (tested with self-provisioned roles):** ready as `audit_app`, owns nothing, no role attribute; refused (42501):
  CREATE / ALTER / DROP / TRUNCATE a table, DISABLE / DROP / CREATE a trigger, DROP a constraint, replace a trigger function, create a
  function or schema, `session_replication_role`, take ownership of a table or the schema, create a role, read a server file; cannot run
  a pending migration. The append-only `INSERT, SELECT` grant of `audit_record` is 18.3 (the Core default grant also gives UPDATE /
  DELETE on new tables — `verify.sh` shows it — so 18.3 must revoke them explicitly, A23).
- **Maintenance role:** not created (18.8 decides it with the purge; nothing in 18.2 needs it).
- **Inherited migration-ledger limitation (Stage 21):** through the same default privileges, `audit_app` has `INSERT, UPDATE, DELETE` on
  `schema_migrations` (verified: a runtime `DELETE` of a ledger row succeeds, inside a rolled-back transaction). It cannot apply DDL, but
  could falsify the ledger readiness reads. Identical in every Core service; not made worse and not redesigned here.

## 8. Errors, logging, request context, HTTP bounds

- **Errors:** the kit's uniform body; an unexpected error is an opaque 500 (no message, stack, path, URL or credential; tested with a
  probe that throws a connection string and a bearer). No localized text is authority; the Core error / i18n refactor stays 21.R1 / R2.
- **Logs:** structured JSON lines, one service identity, no access log; tested: no token, digest, database password, cookie, body
  secret, bearer or secret-looking path in any line of any application (the `ALL_LOGS` scan). These are operational logs, never audit
  records; no payload or metadata logging exists.
- **Request context:** `x-request-id` / `x-correlation-id` accepted when safe (8–128 of `[A-Za-z0-9._:-]`), generated otherwise, echoed,
  carried into log lines; an unsafe value is replaced, never echoed. Correlation is a join key, never authentication or evidence (18.1
  A33).
- **HTTP bounds:** the kit JSON parser is the only body parser (`BODY_LIMIT_KB` 100: a 300 KB JSON body is `413`; octet-stream and
  multipart bodies are never parsed into a DTO); Node's headers 60 s / keep-alive 5 s / request 300 s kept; `server.timeout` = max(headers
  timeout, connection wait + query deadline) + 5 s = 65 s by default (silent sockets); helmet headers, no `X-Powered-By`, CORS off, TRACE 404.

## 9. Database resilience (kit behaviour, verified)

Startup with no database: live, not ready, logged as a class only. Runtime loss: `/ready` 503 `database`, `/health` 200, recovery
without restart. Shutdown with a dead database: prompt (< 2 s). Pool exhaustion is not exercised here (no database-bound route exists);
the kit's known behaviour (an opaque 500 and a readiness check that queues behind requests) is inherited and stays a Stage 21 item.

## 10. Image, Compose, CI, repository checks

- **Image:** two stages, production dependencies only (no test runner, spec or `.env`), `USER node` (uid 1000), `CMD ["node",
  "dist/main.js"]` (PID 1), environment `PATH`, `NODE_VERSION`, `YARN_VERSION`, `NODE_ENV=production`, no secret in the history. Run with
  `--read-only --cap-drop ALL --security-opt no-new-privileges`: `CapEff 0`, `NoNewPrivs 1`, root filesystem read-only, ready as
  `audit_app` against the provisioned database; production refuses the migrator as the runtime role (exit 1, no echo); a paused database
  gives `/health` 200, `/ready` 503, then 200; the repository smoke (`scripts/smoke-core-image.sh audit-service`) passes.
- **Compose:** `audit-service` (profile `db`, port 3006, 60 s stop grace, PostgreSQL only); the `AUDIT_*` role passwords in `.env.example`
  and the postgres service. An existing local `.env` needs those two variables added.
- **CI:** the node matrix (lint, typecheck, unit, e2e, build) and the image matrix include `audit-service`; the product-term guard of
  `check:repo` covers `apps/audit-service/src/` and its migrations.

## 11. Evidence

- **Unit:** 42 in 3 files (configuration 16, caller policy 24, HTTP bounds 2).
- **E2E (PostgreSQL 16.15, throwaway container):** 63 in 4 files: foundation 24, health 5, runtime role 19, built process 15; run twice,
  green both times.
- **Least privilege:** `verify.sh --with-kit-migrations` on a container provisioned by the real init script: 203 ok, 0 FAIL.
- **Regressions:** `check:repo`, `test:repo` (16), lint (0 findings), typecheck, `git diff --check`; kit unit 132 and file-service unit
  257 unchanged (no kit change).
- **Mutations** (each alone; every source restored and verified by SHA-256; the kit rebuilt around kit mutations): **10 / 10 killed.**

  | # | Mutation | Caught by |
  |---|---|---|
  | M1 | readiness ignores the migration state | 2 E2E (health) |
  | M2 | caller policy defaults to allow | caller-policy unit |
  | M3 | a wildcard category accepted | 2 unit |
  | M4 | production accepts a privileged runtime database role | 1 unit + 2 built-process |
  | M5 | a configuration error echoes the database URL | 2 built-process |
  | M6 | a registered caller without a policy entry boots | unit |
  | M7 | the silent-socket bound is not applied | unit |
  | M8 | kit: a missing token is accepted | 2 E2E |
  | M9 | kit: the caller identity comes from a spoofable header | 2 E2E |
  | M10 | kit: shutdown keeps readiness green | E2E (drain) |

## 12. Findings and carryovers

| Finding | Class |
|---|---|
| Runtime role can write the migration ledger (Core default privileges) | inherited; Stage 21 |
| Pool exhaustion answers an opaque 500; readiness queues behind requests | inherited kit behaviour; Stage 21 |
| Core default grants give UPDATE / DELETE on new tables | 18.3 must revoke on `audit_record` (A23) |
| The silent-socket bound exists twice (File, Audit) | 21.R1 consolidation into the kit |
| Every production prerequisite of 18.1 §19 (P-A1 – P-A8) | unchanged, still open |
| 18.1 documentation observations (stale ADD sentence, ADR-0037 / 0018 Proposed, `libs/shared-types`) | still recorded for 21.R1; not touched |

## 13. Next

18.3: the `audit_record` table, append-only privileges and triggers, the idempotent insert, the V1 indexes and their plans.
