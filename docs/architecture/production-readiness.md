# Production readiness: CI/CD, database roles, backups and migrations

- **Status:** Proposed; facts checked on 2026-09-19 against the repository and a local scratch PostgreSQL. Updated after the CI / deployment-safety change: see [service-foundations.md](./service-foundations.md).
- **Scope:** what exists, what the Core requires (CI/CD, least-privilege database access, tested backups, safe migrations), and what
  is done versus not. Nothing here changes production. Related: [core-architecture.md](./core-architecture.md),
  [ADR-0032](../adr/0032-database-per-service-on-a-shared-server.md), the auth security review (`docs/security/`).

## 1. CI/CD

**Current state (verified in `.github/workflows/`):**

| Item | State |
|---|---|
| Formatting, lint, typecheck, unit, integration or migration checks in CI | at the time of the first assessment **none**; since PR #39 `core-ci.yml` runs lint, typecheck, unit, integration and build (not formatting) |
| Docker build | `auth-service-docker-build.yml`: on pull requests it builds **and pushes** a `:develop` image; on push to `main` it builds, pushes `:production` and `:latest`, then deploys |
| Deploy | SSH to the VPS (`appleboy/ssh-action@v1`), runs `deploy/provision-and-deploy.sh`. Failure handling comes from `set -euo pipefail` in the remote script and in the provisioning script. (An earlier `script_stop: true` was **not** protection: it is not an input of `appleboy/ssh-action@v1`, GitHub reported it as unexpected, and it has been removed.) |
| Other services | none has a workflow |

**Gaps in the existing deploy (three, confirmed by reading the workflow):**
1. The SSH step runs `docker run ... cat deploy/provision-and-deploy.sh | IMAGE=... bash -s` **without `pipefail`**: if the `docker run`
   fails, `bash` receives an empty script and the step can still succeed, masking the failure.
2. **No `concurrency` group:** two merges can race on the `:production` tag and on the server.
3. `auth-service-deploy.yml` still carries a **TEMPORARY** `push` trigger on the old `feat/auth-service-security-hardening` branch that
   its own comment says to remove.

**Decision (project owner, 2026-09-19):** fix all three in the same PR as the new CI workflow. No deploy is run or triggered by that
work; merging to `main` is what exercises it, so the first deploy after it must be watched.

**Implemented in PR #39, and verified on GitHub on 2026-09-19 (see below):** the remote script starts with `set -euo pipefail` and logs out
of the registry on exit; one concurrency queue (`production-deploy-core-api`, `cancel-in-progress: false`) covers the `:production`
image publication, the automatic deployment and the manual one; the stale trigger is removed; the manual deploy is now restricted to
`main`. Static checks in `scripts/` fail the build if any of this regresses, including a use of the ignored `script_stop` input.

**Verified on GitHub after the merge of PR #39:** Core CI passed (all six jobs) on the pull request and on `main`; the production
deployment job passed (about 1m10s), the remote script ran under `set -euo pipefail` on the server, migrations `0001`–`0007` were
reported already applied, the new container became healthy, and `GET /auth/health` returned HTTP 200 afterwards.
**Still not verified:** the concurrency queue under two simultaneous deployments (only one has run, so queuing and never-cancelling are
checked statically only) and the manual deploy workflow (never run).

**Implemented CI (`core-ci.yml`, matrix per workspace, PostgreSQL and RabbitMQ service containers):** lint, typecheck, unit tests, integration
tests, migration apply-from-scratch and rollback checks where a down migration exists, build, and simple architecture checks (no
service importing another service's code; no product terms in Core service code). Formatting is not checked and ai-service (Python) has no job. The workflow has run on GitHub: all six jobs passed on the pull request and on `main`.

## 2. Database access: least privilege

**Current state:** the deploy script creates the database with the container's `POSTGRES_USER`, and the application's `DATABASE_URL`
is built from that same user. The official image makes that initial user a **superuser**, so the runtime connects as a superuser.
(Recorded as a production blocker in the auth security review.)

**Target (per [ADR-0032](../adr/0032-database-per-service-on-a-shared-server.md)):** per service, two roles: a **migration role**
(owns the schema, runs DDL, used only by the migration step) and a **runtime role** (DML on that service's tables, no superuser, no
`CREATE`, no access to any other database); credentials generated on the server and never in Git.
**Local development:** implemented in `infra/postgres` (a migrator and a runtime role per financial service, no superuser, no access
to other databases) and proven by `infra/postgres/verify.sh`, which CI runs.
**Production: NEEDS IMPLEMENTATION.** It changes the running production database of auth-service, so it needs its own approval and a
rehearsal; it has **not** been changed or tested against production.

## 3. Backups and restore

**Current state:** no backup job or procedure is documented in the repository, and no restore has ever been tested on the server.

**Local restore drill (scratch PostgreSQL 16.15; this proves the *procedure*, not production):**

| Step | Result |
|---|---|
| Create a database, apply migrations `0001`–`0007`, insert a company, platform and organization | ok |
| Dump with the **host** `pg_dump` (version 18.4) and restore | **FAILED**: `unrecognized configuration parameter "transaction_timeout"`. A dump made by a newer client cannot be restored on an older server. |
| Dump with the **server container's own** `pg_dump -Fc`, restore with its `pg_restore --exit-on-error` | ok, exit 0 |
| Compare row counts, 172 constraints, 16 triggers | identical |
| Compare schema and data dumps (ignoring the random `\restrict` token each `pg_dump` prints) | identical |

**Findings for the procedure:** dump and restore with the client that matches the server's major version (run them inside the database
container); use a **full custom-format** dump, because a data-only dump warns about the circular foreign key on `refresh_token`;
when comparing dumps, filter the per-dump `\restrict` line or every comparison "differs".

**Proposed procedure (not implemented):** a scheduled `docker exec <db> pg_dump -Fc` per database, written outside the database volume
and copied **off the host**, encrypted; a restore drill into a scratch database on a schedule, verified by counts and a schema diff.
**Undecided (business input):** retention, recovery point and recovery time objectives, and where off-host copies live.

**Application verification (Stage 5 hardening, completion pass — gap noted, not yet drilled):** the local drill above verifies only the
database (row/constraint/trigger counts, schema diff) — it does not yet point a service at the restored database and confirm the
application itself is usable. The smallest addition needed before a restore is proven end-to-end, not just at the database level: boot
the affected service against the restored database and confirm `GET /ready` returns 2xx, then read back one row written before the dump
(e.g. `GET /billing/invoices/:id` for a known id) and confirm it matches.
**Success criteria:** the restore command exits 0; row, constraint and trigger counts match the source exactly; the schema/data diff is
empty (ignoring the per-dump `\restrict` token); the application's `/ready` returns 2xx against the restored database; the known-id read
returns the pre-dump data unchanged.
**Failure criteria:** any restore command exits non-zero; any count or diff differs; `/ready` does not return 2xx against the restored
database; or the known-id read is missing or does not match.
**Status:** a backup that has never been restored **on the real volume**, and never verified at the application level, is not proven;
production remains a **BLOCKER** until that drill is done.

## 4. Migrations

The deploy script records applied files in a `schema_migrations` table and applies only unrecorded ones; a failed migration stops the
deploy. Migrations are not idempotent. Down migrations exist for auth `0002`–`0007` and **refuse** when they would destroy data.
Never assume production has a migration because the repository does: check `schema_migrations` after every deploy. For each new schema
change, state existing data, backward compatibility, migration and deploy order, and rollback.

## 5. Readiness summary

| Item | State |
|---|---|
| CI that runs lint, typecheck, tests, build (not formatting) | implemented and **verified on GitHub** (6 of 6 jobs passed) |
| Deploy: fail-fast on the piped script, concurrency queue, stale trigger removed | implemented; the deploy passed under the new script; the concurrency queue itself is checked statically only |
| Least-privilege database roles | local: implemented and verified; production: **NEEDS IMPLEMENTATION** (needs approval; changes production) |
| Backup job and off-host copy | **NEEDS IMPLEMENTATION** |
| Restore procedure | proven on a local scratch database only; **BLOCKER** until drilled on the real volume |
| Retention and RPO/RTO | **NEEDS DECISION** |
