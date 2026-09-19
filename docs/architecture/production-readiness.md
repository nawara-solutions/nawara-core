# Production readiness: CI/CD, database roles, backups and migrations

- **Status:** Proposed; facts checked on 2026-09-19 against the repository and a local scratch PostgreSQL.
- **Scope:** what exists, what the Core requires (CI/CD, least-privilege database access, tested backups, safe migrations), and what
  is done versus not. Nothing here changes production. Related: [core-architecture.md](./core-architecture.md),
  [ADR-0032](../adr/0032-database-per-service-on-a-shared-server.md), the auth security review (`docs/security/`).

## 1. CI/CD

**Current state (verified in `.github/workflows/`):**

| Item | State |
|---|---|
| Formatting, lint, typecheck, unit, integration or migration checks in CI | **none**: no workflow runs them |
| Docker build | `auth-service-docker-build.yml`: on pull requests it builds **and pushes** a `:develop` image; on push to `main` it builds, pushes `:production` and `:latest`, then deploys |
| Deploy | SSH to the VPS, runs `deploy/provision-and-deploy.sh`, which is `set -euo pipefail`; the SSH step has `script_stop: true` |
| Other services | none has a workflow |

**Gaps in the existing deploy (three, confirmed by reading the workflow):**
1. The SSH step runs `docker run ... cat deploy/provision-and-deploy.sh | IMAGE=... bash -s` **without `pipefail`**: if the `docker run`
   fails, `bash` receives an empty script and the step can still succeed, masking the failure.
2. **No `concurrency` group:** two merges can race on the `:production` tag and on the server.
3. `auth-service-deploy.yml` still carries a **TEMPORARY** `push` trigger on the old `feat/auth-service-security-hardening` branch that
   its own comment says to remove.

**Decision (project owner, 2026-09-19):** fix all three in the same PR as the new CI workflow. No deploy is run or triggered by that
work; merging to `main` is what exercises it, so the first deploy after it must be watched.

**Planned CI (`core-ci.yml`, matrix per service, PostgreSQL service container):** format check, lint, typecheck, unit tests, integration
tests, migration apply-from-scratch and rollback checks where a down migration exists, build, and simple architecture checks (no
service importing another service's code; no product terms in Core service code). **CI coverage is not claimed until it actually runs
these checks on a pull request.**

## 2. Database access: least privilege

**Current state:** the deploy script creates the database with the container's `POSTGRES_USER`, and the application's `DATABASE_URL`
is built from that same user. The official image makes that initial user a **superuser**, so the runtime connects as a superuser.
(Recorded as a production blocker in the auth security review.)

**Target (per [ADR-0032](../adr/0032-database-per-service-on-a-shared-server.md)):** per service, two roles: a **migration role**
(owns the schema, runs DDL, used only by the migration step) and a **runtime role** (DML on that service's tables, no superuser, no
`CREATE`, no access to any other database); credentials generated on the server and never in Git.
**Status: NEEDS IMPLEMENTATION.** It changes the running production database of auth-service, so it needs its own approval and a
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
**Status:** a backup that has never been restored **on the real volume** is not proven; production remains a **BLOCKER** until that drill is done.

## 4. Migrations

The deploy script records applied files in a `schema_migrations` table and applies only unrecorded ones; a failed migration stops the
deploy. Migrations are not idempotent. Down migrations exist for auth `0002`–`0007` and **refuse** when they would destroy data.
Never assume production has a migration because the repository does: check `schema_migrations` after every deploy. For each new schema
change, state existing data, backward compatibility, migration and deploy order, and rollback.

## 5. Readiness summary

| Item | State |
|---|---|
| CI that runs formatting, lint, typecheck, tests, migrations | **NEEDS IMPLEMENTATION** (planned, approved) |
| Deploy: fail-fast on the piped script, concurrency group, stale trigger removed | **NEEDS IMPLEMENTATION** (approved, in the CI PR) |
| Least-privilege database roles | **NEEDS IMPLEMENTATION** (needs approval; changes production) |
| Backup job and off-host copy | **NEEDS IMPLEMENTATION** |
| Restore procedure | proven on a local scratch database only; **BLOCKER** until drilled on the real volume |
| Retention and RPO/RTO | **NEEDS DECISION** |
