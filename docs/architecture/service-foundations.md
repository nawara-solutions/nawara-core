# Service foundations: what is implemented, designed and deferred

- **Status:** describes the repository as of 2026-09-19, after the service-kit / CI / deployment-safety change.
- **Related:** [core-architecture.md](./core-architecture.md), [financial-architecture.md](./financial-architecture.md),
  [production-readiness.md](./production-readiness.md), [ADR-0032](../adr/0032-database-per-service-on-a-shared-server.md),
  [ADR-0033](../adr/0033-service-to-service-authentication-and-user-identity.md),
  [ADR-0034](../adr/0034-shared-service-kit-and-api-conventions.md), [ADR-0037](../adr/0037-reliable-events-outbox-inbox.md).

Three words are used strictly: **Implemented** (code exists and was run), **Designed** (documented, no code), **Deferred**
(consciously left for later). Nothing in this document is "verified in production": production was not touched.

## 1. Payment Service reality

`apps/payment-service` is still an unmodified NestJS starter (one `GET /` route). The Payment, Billing and Accounting domains are
**Designed** ([financial-architecture.md](./financial-architecture.md)) and **not implemented**. The new Payment SDD has not been
written and must precede any payment code. This change touches payment-service in exactly one way: its starter e2e test no longer
imports the unresolvable `supertest/types` subpath (the same fix in notification-service), and a `typecheck` script was added.

## 2. Implemented

| Area | Implemented | Where |
|---|---|---|
| Shared library | `@nawara/service-kit`: configuration, request/correlation ids, structured logging with redaction, uniform errors, `/health` and `/ready`, service-token authentication, Auth client port, database and migrations, outbox/inbox, in-memory and RabbitMQ event buses, HTTP baseline | `libs/service-kit` |
| Migrations | Explicit runner and `nawara-migrate` CLI: deterministic order, one transaction per file with its bookkeeping row, checksum drift refused, advisory lock, `/ready` fails while migrations are pending; kit migration for `outbox` and `inbox` | `libs/service-kit/src/db`, `migrations/` |
| Local infrastructure | PostgreSQL 16 with one database per financial service and, for each, a **migrator** (schema owner) and a **runtime** role (DML only); RabbitMQ 3.13; ports bound to loopback | `docker-compose.yml`, `infra/postgres/`, `.env.example` |
| CI | One workflow, `core-ci.yml`: repository checks; per workspace (service-kit, auth, payment, notification) lint, typecheck, unit tests, integration tests, build (+ Auth's database invariant tests); a job that starts PostgreSQL and runs the least-privilege verification | `.github/workflows/core-ci.yml` |
| Deployment safety | The three known gaps fixed in both production deploy workflows (section 5) | `.github/workflows/auth-service-*.yml` |
| Static checks | Workflow safety, CI honesty and architecture boundaries as tested code | `scripts/` |

## 3. Designed, not built

Billing, Payment and Accounting services and their tables; the payment-request snapshot flow; provider adapters and webhooks; cash
and refund workflows; entitlements; the organization-service and how Auth references Company/Platform/Organization
(**deferred by decision**, see ADR-0031); RabbitMQ in production; the financial SDDs.

## 4. Deferred (consciously)

Rate limiting and OpenAPI setup in the kit (ADR-0034 lists them; not yet built); consumer retry/delay policy beyond the dead-letter
queue; outbox and inbox pruning; a CI job for ai-service (Python); formatting checks; deploy workflows for new services;
production database roles, backups and RabbitMQ; migrating auth-service onto the kit.

## 5. Deployment safety (fixes in this change)

| Gap | Fix | How it is checked |
|---|---|---|
| The SSH step piped `docker run ... \| bash -s` without `pipefail`, so a failed pull could pass silently | the remote script now starts with `set -euo pipefail`; an `EXIT` trap logs out of the registry even when the script fails | `scripts` fail the build if any `appleboy/ssh-action` script does not start with it |
| No concurrency control | one queue, `production-deploy-core-api`, shared by the `:production` image publication, the automatic deployment and the manual one; `cancel-in-progress: false` | checked for every deploying job; a group other than the shared one, or `cancel-in-progress` other than `false`, fails the build |
| A `TEMPORARY` push trigger on an old branch in `auth-service-deploy.yml` | removed; the manual workflow is `workflow_dispatch` only | a deploying workflow triggered by any branch but `main` fails the build |
| Found while reviewing: the manual deploy could run from any branch | its job is now guarded to `refs/heads/main` | a deploying job without a `refs/heads/main` guard fails the build |

Semantics worth knowing: GitHub keeps **one running and at most one waiting** run per concurrency group. A running deployment is
never cancelled; if a third request arrives, the older *waiting* one is superseded by it (its commit is contained in the newer
`main`). Pull-request runs never reach a deploy job (they are excluded by the `refs/heads/main` guard). Secrets are passed through
`env`, never interpolated into the remote script (also checked).

## 6. Migrations: how they are applied

* **Development and tests:** `nawara-migrate --dir <service migrations>` (or `runMigrations`), as the service's **migrator** role;
  `createTestDatabase` gives each test file a throwaway database.
* **Production:** applying migrations is a **deployment step, not a startup side effect**. Nothing in this change deploys or applies
  anything. Never assume a migration exists in production because it exists in the repository: check `schema_migrations` after each
  deploy. The pending-migrations readiness check keeps a lagging instance out of rotation.
* auth-service keeps its own mechanism (its deploy script and `schema_migrations(name, applied_at)`); the kit's table also has a
  `checksum` column and is used only by services that adopt the kit.
* **Limit:** with the default privileges in `infra/postgres`, the runtime role can also write `schema_migrations`. Tightening this
  is a small follow-up.

## 7. Verification evidence (run locally, on scratch PostgreSQL 16 and RabbitMQ 3.13)

| Check | Result |
|---|---|
| service-kit: lint, typecheck, build | clean (0 warnings) |
| service-kit: unit tests | 46 passed |
| service-kit: integration tests (PostgreSQL + RabbitMQ) | 30 passed |
| payment-service and notification-service: lint, typecheck, unit, e2e, build | all pass (1 unit + 1 e2e each); **payment typecheck now passes** |
| auth-service: lint, typecheck, unit, integration, database invariants, build | all pass: 59, 230 and 281 assertions, **unchanged** |
| repository checks and their tests | pass; 11 tests. Run against the workflows *before* the fixes they reported all three known gaps and one more |
| `infra/postgres/verify.sh --with-kit-migrations` | all checks pass for the three services; deliberately over-granting a runtime role made it fail |
| `npm ci --dry-run` | lockfile in sync |

**Not verified:** any GitHub Actions run (the workflows were parsed and statically checked, and every command in them was run
locally, but no workflow has executed on GitHub); the changed deploy script on the real server (it assumes the remote login shell is
bash: `pipefail` is a bash feature, so on another shell the deploy would fail loudly, not silently); anything in production;
ai-service; behaviour under load.

## 8. Decisions that still need human approval

1. **Manual deploy workflow:** hardened and kept (main only, same queue). Removing it instead is a separate choice; two production
   paths exist until you decide.
2. **`HttpAuthClient` in the kit** reads Auth's identity response (organization id, membership status). It holds no membership logic,
   but it does name those concepts, and it is the only file the architecture check allow-lists. Keep it in the kit, or move it to
   each service?
3. **Failed event consumer → dead-letter queue immediately** (no retry delay). ADR-0037 does not specify a retry policy.
4. **Kit default `NODE_ENV` is `production`** when unset (safe by default; local runs must set `development`).
5. **Relay holds row locks while publishing** a batch of up to 50 events. Fine at low volume; revisit before high volume.

## 9. Risks found

* No workflow has run on GitHub yet: the first CI run may expose an environment difference (runner tools, service startup timing).
* The first production deploy after merge exercises the new script and queue for the first time: **watch it**.
* Outbox rows and inbox rows grow without bound until a pruning policy exists.
* The kit consumes Auth's `/auth/me` contract; a change to that response shape must update the client and its test.
