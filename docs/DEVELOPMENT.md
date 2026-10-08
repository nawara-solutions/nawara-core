# Developing Nawara Core

The one path from a fresh clone to a pull request. It covers what every service shares; each service's own settings, commands and
operations stay in its `apps/<service>/README.md`. What Core is and why: the root [README](../README.md) and the
[roadmap](CORE-ROADMAP.md).

## 1. Prerequisites

| Tool | Needed for |
|---|---|
| **Node 22** (`.nvmrc`; `nvm use`) and the npm that ships with it | everything. CI and the service images run Node 22; `package.json` declares it, and npm only warns on another major |
| Docker with Compose | local PostgreSQL and RabbitMQ, the image builds, the Prometheus rule check |
| `psql` | `infra/postgres/verify.sh` and the `test:db` suites |
| `openssl` | generating Auth's local secrets when you run Auth outside Compose |

Repository checks, linting, type checking and unit tests need only Node.

## 2. First run

```bash
npm ci                                                        # reproducible install from the lockfile; also installs the commit-msg hook
npm run build:libs                                            # @nawara/service-kit and @nawara/audit-contract (see below)
npm run check:repo && npm run test:repo                       # the repository's own checks: seconds, no infrastructure

cp .env.example .env                                          # local Compose values; never commit .env
docker compose --profile db up -d --wait postgres             # PostgreSQL 16 on 127.0.0.1:5433, one database and two roles per service
docker compose up -d rabbitmq                                 # RabbitMQ on 127.0.0.1:5672 (only for broker work)
bash infra/postgres/verify.sh                                 # optional: proves the least-privilege roles
```

**Build the libraries first, and again after changing them.** The services import `@nawara/service-kit` and
`@nawara/audit-contract` through their built `dist/` (Notification uses the kit only; the other seven use both). npm workspaces do
not build them for you. A missing `dist/` fails with "Cannot find module"; a **stale** one is worse, because type checks, tests and
running services then silently see the old code. `npm run build:libs` is the command CI runs before anything else.

**Environment.** Configuration reaches a service only through its process environment; no service reads a `.env` file itself.

- The root `.env.example` is the template of the local Compose stack. Copy it to `.env` and change nothing unless you need to. Its
  keys and tokens are published development values, which every service refuses in production.
- Auth, Billing, Payment and Organization also have an `apps/<service>/.env.example` for running that service outside Compose. Copy
  it to `apps/<service>/.env`, then export it into your shell: `set -a; . ./.env; set +a`.
- **Keep `NODE_ENV=development` for a local run.** An unset `NODE_ENV` means production: the service then demands production
  settings and refuses to start.
- Because the shell reads the file, a value with spaces, quotes or braces (a JSON policy) must be wrapped in single quotes.
- Only `.env.example` files are tracked; `npm run check:repo` refuses any other environment file.
- Every setting may also be given as `NAME_FILE=/path` (a mounted secret) instead of `NAME`; both together are refused. You do not
  need this locally. Each service's variables are in the Configuration table of its README; handling and rotating real secrets is in
  the [secret rotation runbook](runbooks/secret-rotation.md).

## 3. Running a service

1. **Migrate.** Nothing migrates at service start, and `/ready` fails while a migration is pending. Databases and roles are created
   when PostgreSQL first starts on an empty volume; the schema is yours to apply, as the service's migrator role:

   ```bash
   MIGRATION_DATABASE_URL=postgres://<service>_migrator:<password>@127.0.0.1:5433/<service> npm run migrate -w <service>-service
   ```

   The passwords are the `*_MIGRATOR_PASSWORD` values of your root `.env`. Auth has its own runner with the same variable
   (`npm run build -w auth-service` first). `nawara-migrate` falls back to `DATABASE_URL` and accepts `NAME_FILE`:
   [kit README](../libs/service-kit/README.md).
2. **Start.**

   | How | Command | Notes |
   |---|---|---|
   | watch mode | `npm run start:dev -w <service>-service` | needs the built libraries, your exported environment, PostgreSQL |
   | as built | `npm run build -w <service>-service && npm run start:prod -w <service>-service` | the same |
   | in Compose | `docker compose --profile db run --rm <service>-service npm run migrate`, then `docker compose --profile db up -d <service>-service` | builds the image; uses the root `.env`. Auth migrates with `docker compose --profile db run --rm auth-migrate` |

   The full Compose sequence for every service is the header comment of [`docker-compose.yml`](../docker-compose.yml).
3. **Check.** `GET /health` (liveness) and `GET /ready` (dependencies); Auth's liveness is `GET /auth/health`. In Compose the services
   are published on `127.0.0.1`: Auth 3000, Billing 3001, Payment 3002, Organization 3003, Notification 3004, File 3005, Audit 3006,
   Release 3007.

There is no seed or bootstrap step for development or tests. Creating a first owner in Auth is a deliberate, separate action:
[Auth README](../apps/auth-service/README.md).

## 4. Validation ladder

Run what your change touches, from the top. **CI runs all of it on every pull request and is the gate**; nothing below replaces it.

| When | Run | Needs |
|---|---|---|
| always | `npm run check:repo && npm run test:repo`; then `npm run lint`, `typecheck` and `test` with `-w <workspace>` for each workspace you touched | Node only |
| you changed a service's persistence, HTTP wiring or a CLI | that workspace's `npm run test:e2e -w <workspace>`, and `test:db` where it exists (Auth, Billing, Payment, Organization) | PostgreSQL; some suites RabbitMQ |
| you changed a library | `npm run build:libs`; the library's `test` and `test:integration`; then the suites of the services that use what changed | PostgreSQL, RabbitMQ |
| you changed behaviour that crosses services (messaging, audit, the Auth / Organization contract) | the matching root script: `npm run test:e2e:real-broker`, `test:e2e:auth-organization` or `test:e2e:audit-producers` (each builds what it needs) | PostgreSQL, RabbitMQ |
| you changed a deploy script, a workflow or the backup tooling | `npm run test:deploy` | Node only |

**Before opening a pull request**, run the first row and every later row your change falls under. There is deliberately no single
"pre-PR" command: a subset would look like the gate without being it. Branches, commits and pull requests:
[CONTRIBUTING](../CONTRIBUTING.md).

## 5. CI and its local equivalents

| Core CI job | Locally | Needs | Exact |
|---|---|---|---|
| repository checks | `npm run check:repo`, `npm run test:repo`, `bash scripts/check-prometheus-rules.sh`, `npm run test:deploy` | Docker for the rule check | yes |
| one job per workspace (the two libraries and the eight services) | `npm run build:libs`; then `lint`, `typecheck`, `test`, `build` and the workspace's `test:integration` or `test:e2e`, and `test:db` where it exists | PostgreSQL, RabbitMQ; the S3 test server for File | yes |
| core image (one per service) | `docker build -f apps/<service>-service/Dockerfile -t nawara-core/<service>-service:ci .`, then `bash scripts/smoke-core-image.sh <service>-service nawara-core/<service>-service:ci` | Docker, RabbitMQ | yes, slow |
| local infrastructure | `docker compose --profile db up -d --wait postgres`, then `bash infra/postgres/verify.sh --with-kit-migrations` | Docker, `psql` | yes |
| the three cross-service jobs | `npm run test:e2e:real-broker`, `npm run test:e2e:auth-organization`, `npm run test:e2e:audit-producers` | PostgreSQL, RabbitMQ | yes |
| `core-ci-passed` | none: it only aggregates the jobs above, and is the check `main` requires | – | CI only |

## 6. Test environment

The integration and end-to-end suites create and migrate their own scratch databases; you never migrate by hand for a test. They
read:

| Variable | Value for the local Compose stack |
|---|---|
| `TEST_DATABASE_ADMIN_URL` | `postgres://postgres:<POSTGRES_ADMIN_PASSWORD from .env>@127.0.0.1:5433/postgres` (port **5433**, not 5432) |
| `TEST_RABBITMQ_URL` | `amqp://guest:guest@127.0.0.1:5672` |
| `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY_ID`, `TEST_S3_SECRET_ACCESS_KEY` | File only: `docker compose --profile storage-test up -d s3-test`, then `http://127.0.0.1:9000` and the `S3_TEST_*` values of `.env` |

```bash
set -a; . ./.env; set +a
export TEST_DATABASE_ADMIN_URL="postgres://postgres:${POSTGRES_ADMIN_PASSWORD}@127.0.0.1:5433/postgres" TEST_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672
```

Locally, a suite whose service is missing is skipped with a notice; with `CI=true` it fails, so CI never silently skips coverage.
**Broker suites need a reachable RabbitMQ.** If you cannot run one locally, run everything else that applies and let CI cover the
broker suites before the merge. That is not a reason to ignore a broker suite that fails when a broker is available.

## 7. Changing dependencies

`npm ci` never changes the lockfile. To add or update a dependency on purpose, use `npm install <package> -w <workspace>` and commit
`package.json` together with `package-lock.json`. A lockfile change rebuilds the service images when it merges; nothing deploys
(see the root [README](../README.md) and [digest deployments](runbooks/digest-deployments.md)).

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot find module '…/dist/…'`, or a test or service that ignores your change | the libraries, or a service a suite spawns, are not rebuilt: `npm run build:libs`, and `npm run build -w <service>-service` for suites that start a built service or CLI |
| a service refuses to start locally and asks for production settings | `NODE_ENV` is unset, which means production: export `NODE_ENV=development` |
| a JSON policy is rejected after `. ./.env` | the shell removed its quotes: wrap the value in single quotes in the file |
| `set NAME or NAME_FILE, not both` | both forms of one setting are set: keep one |
| connection refused on port 5432 | Compose publishes PostgreSQL on **5433** |
| a service's database or role does not exist | your PostgreSQL volume is older than that service: the init script runs only on an empty volume. Recreate the volume, or create the database and roles as `infra/postgres/init/01-service-databases.sh` does |
| Compose does not know `postgres` or a service | `--profile db` is required on every invocation that touches them |
| a spec file fails to load, or broker tests fail | `TEST_RABBITMQ_URL` is unset or the broker is not reachable (section 6) |
| `npm warn EBADENGINE` | your Node is not 22: `nvm use` |
| a fresh RabbitMQ container exits at start with `.erlang.cookie: eacces` | a `rabbitmq-diagnostics` command ran as **root** before the broker had created its cookie, and wrote it as root. The repository's health checks run it as the broker's user, so this comes from a command of your own: run it as `docker exec <container> su-exec rabbitmq rabbitmq-diagnostics …`, and recreate the container |
| the local broker is slow to start or holds many old queues | its state outlives the container (the image keeps it in a volume). To start over **locally**: `docker compose rm -sfv rabbitmq`, then `docker compose up -d rabbitmq`. Tests delete the resources they create; this is only for state left by older runs |

Background on these: [A15 record](architecture/core-v2-a15-developer-experience.md) §6.

## 9. Where things are

| For | Read |
|---|---|
| a service's settings, API, commands and operations | `apps/<service>/README.md` |
| the shared infrastructure library and its operator CLIs | [`libs/service-kit/README.md`](../libs/service-kit/README.md) |
| the audit contract and its catalog | [`libs/audit-contract/README.md`](../libs/audit-contract/README.md) |
| architecture and API conventions | [ADR-0056](adr/0056-core-architecture-and-api-conventions.md); every decision: [`docs/adr`](adr) |
| what is built, planned and deferred | [roadmap](CORE-ROADMAP.md) |
| local metrics, dashboards and alerts | [local observability runbook](runbooks/local-observability.md) |
| production operations | [`docs/runbooks`](runbooks) |
| the kinds of design document | [`docs/README.md`](README.md) |
