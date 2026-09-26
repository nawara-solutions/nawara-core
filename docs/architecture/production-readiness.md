# Production readiness: CI/CD, database roles, backups and migrations

- **Status:** Proposed; facts checked on 2026-09-19 against the repository and a local scratch PostgreSQL. Updated after the CI / deployment-safety change: see [service-foundations.md](./service-foundations.md). Updated at the Stage 14 closure (2026-09-23, `main` at `d385299`): sections 1, 2, 4, 5 and the new section 6.
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
| Other services | no deploy workflow. Since Stage 14.2 Core CI builds all four Core images (`core image (<service>)`) and smoke-checks each with production configuration (`scripts/smoke-core-image.sh`: non-root, `/health` 200 and stable, `/ready` wired); only auth-service is deployed |
| Merge protection | **none** (checked 2026-09-23): `main` has no branch protection and no ruleset, so the checks above are not *required*. A repository setting, not code (Stage 14 finding F2) |

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
**Production (auth-service): implemented in Stage 14.3 and applied.** `deploy/provision-and-deploy.sh` runs migrations as the database
owner, then (re)creates `auth_app` (`NOSUPERUSER NOCREATEDB NOCREATEROLE`, CONNECT, DML on the tables, `SELECT` only on
`schema_migrations`) and moves an owner `DATABASE_URL` to it. The production deploy of `ae7fc30` logged
`~ DATABASE_URL (moved from the database owner to the runtime role auth_app)`. In production, Auth, Billing, Notification, Organization and Payment
refuse a superuser, schema-owner or `*_migrator` runtime user at startup.

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

Since Stage 14.5 auth-service migrates with the service-kit runner from its own image (`node dist/cli/migrate.js`, as the database
owner), like the other services: one advisory lock for the whole run (a second runner prints that it is waiting), each file and its
`schema_migrations` row commit together, a stored checksum must match the file, and a history the release cannot explain (unknown or
out-of-order migration) is refused before anything changes. Legacy rows got their checksum once (production deploy of `d097cef`,
`0001`–`0007`); every later deploy enforces it. `/ready` reports not ready while a migration of the release is unapplied. A failed or
refused migration stops the deploy. Migrations are not idempotent. Down migrations exist for auth `0002`–`0007` and **refuse** when they would destroy data.
Never assume production has a migration because the repository does: check `schema_migrations` after every deploy. For each new schema
change, state existing data, backward compatibility, migration and deploy order, and rollback.

## 5. Readiness summary

| Item | State |
|---|---|
| CI that runs lint, typecheck, tests, build (not formatting) | implemented and **verified on GitHub** (6 of 6 jobs passed) |
| Deploy: fail-fast on the piped script, concurrency queue, stale trigger removed | implemented; the deploy passed under the new script; the concurrency queue itself is checked statically only |
| Least-privilege database roles | local: implemented and verified; production (auth-service): **implemented and applied** (Stage 14.3) |
| Required CI checks on `main` (branch protection) | **NEEDS CONFIGURATION** (repository setting; F2) |
| Backup job and off-host copy | **NEEDS IMPLEMENTATION** |
| Restore procedure | proven on a local scratch database only; **BLOCKER** until drilled on the real volume |
| Retention and RPO/RTO | **NEEDS DECISION** |

## 6. Stage 14 operational hardening: runtime limits, signals and open items

Closed on `main` at `d385299` (PRs #78–#83). Stage 14 changed no API, event payload, schema or business behaviour.

**Runtime limits** (all validated at startup; an invalid value refuses to start):

| Setting | Default | Bounds | Used by | Purpose |
|---|---|---|---|---|
| `DB_POOL_MAX` | 10 | 1–100 | Auth, Billing, Notification (Stage 16.4), Organization, Payment | connections per process |
| `DB_CONNECTION_TIMEOUT_MS` | 5000 | 100–60000 | same | bound on getting a pooled client or opening a connection |
| `DB_STATEMENT_TIMEOUT_MS` | 30000 | 1000–600000 | same | PostgreSQL cancels a longer statement (57014) |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 60000 | 1000–3600000 | same | PostgreSQL ends a session idle inside a transaction (25P03) |
| `DB_QUERY_TIMEOUT_MS` (Stage 15.2) | statement timeout + 5000 | 1000–660000, must exceed `DB_STATEMENT_TIMEOUT_MS` | same | client-side deadline for a query's answer when the server or network goes silent; the connection is destroyed, never reused |
| `RABBITMQ_CONFIRM_TIMEOUT_MS` | 5000 | 100–60000 | Billing, Payment, Auth (its outbox relay), Notification (16.5) | bound on a publisher confirm; a timeout keeps the outbox row pending (at least once). Since Stage 21.C.2 this includes Auth's domain events |
| `RABBITMQ_HEARTBEAT_S` (Stage 15.3) | 10 | 5–60 | Billing, Payment, Notification (16.5) | the AMQP heartbeat Core requests: a silent broker is detected, and every channel operation and close ended, within about 3 × this value whatever the broker's own heartbeat setting |
| `WEBHOOK_RETRY_MAX_ATTEMPTS` (constant) | 10 | – | Payment | stored webhook retried at 10 s × 2ⁿ after receipt, then `failed` / `retries_exhausted` |
| worker / relay drain (constant) | 5000 ms | – | kit `PollLoop` | bounded wait for an in-flight pass at shutdown; since Stage 15.5 one drain per worker, all started together at shutdown start |
| `HTTP_DRAIN_TIMEOUT_MS` (Stage 15.5) | 5000 | 500–120000 | Auth, Billing, Notification, Organization, Payment | once shutdown starts, how long running requests may finish before every remaining connection is closed; `/ready` is 503 and new requests are refused from the first moment |
| `BILLING_DISPATCH_STALE_SENDING_MS` (Stage 15.8 relationship) | 60000 | 1000–3600000 and **≥ 2 × `PAYMENT_TIMEOUT_MS`** | Billing | re-send after a lost or failed send; the dispatcher renews its unsent claims every quarter of it |
| consumer prefetch (Stage 15.8) | kit 5; Billing and Notification `min(10, max(1, DB_POOL_MAX / 2))` | 1–100 | Billing, Notification (16.5) consumers | unacknowledged deliveries = concurrent handlers = pool clients: at most half the pool |
| outbox relay pass / backoff (Stage 15.8, constants) | full batches of 50 back to back for ≤ 1 s per 1 s poll; per-row backoff 1 s × 2ⁿ up to 15 s | – | kit relay (Billing, Payment) | backlog drain; worst delivery delay after a broker outage |
| AttemptResolver lease (Stage 15.8, constant) | 5000 ms | – | Payment | one provider call per open attempt per lease whatever the number of instances; a dead holder's lease runs out |

**notification-service secrets and API bounds (Stage 16.5 / 16.6):**
- `NOTIFICATION_SECRET_KEYS` + `NOTIFICATION_SECRET_ACTIVE_KEY_ID`: the AES-256-GCM ring that seals one-time codes.
- `NOTIFICATION_REQUEST_HASH_KEY`: the HMAC key of the API request hash (D25). A single key; rotating it turns in-flight retries into
  `422 idempotency_key_reused`, and versioning is a 16.9 item.

  Both are required, generated on the server, and never in Git, a log or the database.
- `NOTIFICATION_SERVICE_POLICY`: the explicit per-caller templates / channels / organizations; deny by default.
- `NOTIFICATION_MAX_SCHEDULE_AHEAD_SEC` (30 days, 60–31536000) and `NOTIFICATION_API_INTAKE_LIMIT_PER_MINUTE` (600, 1–100000):
  engineering bounds.

**notification-service delivery engine (Stage 16.7):**
- Providers per channel (Stage 16.8): `NOTIFICATION_EMAIL_PROVIDER=resend` and `NOTIFICATION_SMS_PROVIDER=twilio` in production;
  `test` (no network, delivers nothing) is refused at startup. Each selected provider's credentials and sender are required and
  validated at startup (never echoed), and may be supplied as `*_FILE` secrets.
- Startup relationships (SDD §8.2): `NOTIFICATION_LEASE_MS` ≥ 2 × `NOTIFICATION_PROVIDER_TIMEOUT_MS`; the provider timeout < the 60 s
  stop grace − `HTTP_DRAIN_TIMEOUT_MS` (so the HTTP drain must stay below 50 s at the default 10 s timeout); the worker's shutdown
  drain is the provider timeout + 2 s; `NOTIFICATION_WORKER_CONCURRENCY` < `DB_POOL_MAX`.
- Retry: base 30 s, ceiling 30 min, 5 attempts; `NOTIFICATION_RATE_CALLER_TEMPLATE_PER_MINUTE` 6000. The provider timeout stays 10 s
  (lease 60 s): the adapters add about 2 ms over a local stub; live provider latency is to be measured in the sandbox smoke.
- **Stage 16.10:** Notification V1 certified ([record](stage-16/stage-16-10-focused-certification.md)); production enablement waits on
  the external / owner prerequisites of its §7 (provider accounts and sandbox smoke, Auth E.164, Resend owner items, alert routing).
- **Stage 16.9:** `notif_dest` (30 per channel + destination per hour by default) keyed by HMAC under `NOTIFICATION_DESTINATION_LIMIT_KEY`
  (required with a provider). Key material for the secret ring, the request hash and the limiter must be pairwise distinct; production
  refuses development keys published in `.env.example` and patterned keys. Rotation: `NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS` (≤ 2),
  `NOTIFICATION_DESTINATION_LIMIT_PREVIOUS_KEY`, and `npm run secret-keys -- retire-check <id>` before removing a secret key. The full
  enablement checklist and the runbooks: [Stage 16.9 record §13](stage-16/stage-16-9-security-operations.md),
  [runbooks](../runbooks/notification-service.md).
- **Before enabling production sending:** the Resend sending domain verified (SPF, DKIM; DMARC advised); a Twilio Messaging
  Service with its senders (a Tunisian alphanumeric sender ID needs registration for domestic entities above 30 000 SMS / month) and
  the destination countries enabled in Messaging Geo Permissions; Auth storing canonical E.164 (else Auth-originated SMS fail
  `invalid_destination`); the Resend cost, MENA deliverability pilot and data-processing review (ADR-0047).
- The secret purge loop runs whatever the provider setting. Operators watch the due backlog with the query in the service README.

A frozen or partitioned broker is detected within about 3 × `RABBITMQ_HEARTBEAT_S` (≈ 30 s at the default), after the shorter
`RABBITMQ_CONFIRM_TIMEOUT_MS`; a SIGTERM while the broker is silent therefore takes up to about that long (still above Docker's 10 s stop
grace: Stage 15.5).
`DB_QUERY_TIMEOUT_MS` is enforced to stay above `DB_STATEMENT_TIMEOUT_MS`: PostgreSQL cancels a slow statement first (57014), the client
deadline only ends a wait on a silent server (`kind=db_query_timeout`). Raising the statement timeout raises the default deadline with it.
Keep `RABBITMQ_CONFIRM_TIMEOUT_MS` below `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`: the relay waits for the confirm inside its claiming
transaction, so a longer confirm wait lets PostgreSQL end the session (the row stays pending and is published again: safe, but wasted).

**Several instances per service (Stage 15.4).** Billing and Payment were validated with 2–4 instances on one database and broker:
no worker assumes it is alone, and no duplicate business effect, lost item or cross-tenant write was found. Re-sends are safe only
because Payment enforces its natural key `(producer, paymentRequestId)`, which every Payment deployment must keep. *(Superseded by Stage
15.8: the batch-tail re-send, the per-instance provider polling and the expiry-sweep stall that 15.4 measured are fixed: claim renewal
with `BILLING_DISPATCH_STALE_SENDING_MS ≥ 2 × PAYMENT_TIMEOUT_MS` enforced at startup, a 5 s AttemptResolver lease, and `SKIP LOCKED`
in the sweep.)* Details: `core-validation.md` sections 13.4 and 13.8.

**Stopping and restarting (Stage 15.5, final).**
- **When shutdown starts** (SIGTERM, the first Nest hook), all of this happens at once:
  - `/ready` answers 503;
  - new requests are refused (503, `Connection: close`);
  - the HTTP server stops accepting connections;
  - running requests have `HTTP_DRAIN_TIMEOUT_MS` (5 s) to finish before every connection is closed, so no client can extend this;
  - every worker starts its one bounded drain (5 s), concurrently.
- The broker connection and the database pool close last. A broker connection that does not close cleanly has its socket destroyed, so
  a silent broker cannot keep the process alive; this matters in a container, where Node is PID 1.
- An idle service stops in about 0.4 s. A stuck broker, a stuck database, or a worker or request waiting on a lock is bounded by Core.
  **Measured worst graceful shutdown: 39.8 s** (a consumer blocked in its transaction while the broker is frozen), theoretical ≈ 41 s.
- **The stop grace is therefore 60 s:** `docker stop -t 60` and `--stop-timeout 60` in the Auth deploy, and `stop_grace_period: 60s` in
  Compose. Every future Billing / Payment / Organization deployment must declare at least 60 s; Docker's 10 s default is not enough.
- SIGKILL at any point was still recovered by the next start with nothing lost or duplicated: outbox rows, unacknowledged messages,
  claimed payment requests, attempts, webhooks and expiries.
- Billing exits at startup if RabbitMQ is unreachable, a documented fail-fast, so it needs a restart policy. Every other dependency
  outage at startup leaves the service running but unready until the dependency returns.
- The Auth deploy stops the old container before starting the new one (an outage per deploy; Stage 20, with an init process).
- **Cancelling a sent payment request** answers success only when Payment confirmed it. A `503 payment_unavailable` means nothing was
  accepted, and the caller retries the same call; the retry is a replay.
- Details: `core-validation.md` sections 13.5 (initial failure), 13.5.1 (patch 1) and 13.5.2 (patch 2, F-H).

**Cross-service failures (Stage 15.6).**
- No service's readiness depends on another service, and each service keeps doing its own work while another is down:
  - Billing issues invoices and accepts payment requests while Payment is down;
  - Payment takes cancellations and payments while Billing is down; the events wait durably;
  - Auth and Organization are unaffected by Billing, Payment or the broker.
- Calls that need another service answer truthfully and within a bound:
  - Billing's cancel gets `503 payment_unavailable` within 5 s;
  - a payer route with Auth unavailable gets 503;
  - bad service credentials get 401.
- After any combination of outages, in any recovery order, Billing and Payment converge by themselves: outbox, queue redelivery,
  receipts, the reconciler, and Payment's natural key for resends. No manual repair; one effect per event.
- **Operational notes:**
  - Billing must run under a restart policy (it exits at startup while RabbitMQ is unreachable);
  - Billing and Payment report unready during a broker outage although their HTTP keeps working (decision open, SRE);
  - a request whose send failed is resent only after the 60 s stale window;
  - a message dead-lettered during a long database outage stays in the DLQ after the reconciler has applied it (replay is safe).
- Details: `core-validation.md` section 13.6.

**Data growth and log volume (Stage 15.7).**
- **Growth.**
  - Each invoice-to-settlement lifecycle adds about 18 KB to Billing and 11 KB to Payment. Nothing is ever deleted by Billing or
    Payment.
  - At 100 k lifecycles: Billing 0.6 GB, Payment 0.4 GB, of which 32 % is published outbox rows that nothing reads again.
  - Request-path and worker-claim queries stay under 0.3 ms at that size. Payment's expiry sweep was the one scan that grew with the
    whole table (11 ms at 100 k); since Stage 15.8 a partial index keeps it at about 0.04 ms.
- **Retention.**
  - No duration is established anywhere except Payment's idempotency key expiry (24 h).
  - `core-validation.md` 13.7 lists, per table, its lifecycle class and the condition under which deleting a row is safe.
  - The durations are open decisions: published outbox; webhook rows and raw bodies (O-17); audit trails; refresh tokens;
    Organization idempotency keys.
  - Payment's `expiresAt` is written but never read, so an expired key still replays (D1). This is stricter than the SDD and safe.
- **DLQ.** After a long database outage, a dead-lettered event can stay in the DLQ although the reconciler applied it. Runbook:
  1. `nawara-dlq list`;
  2. confirm the request is settled;
  3. `nawara-dlq replay`. The replay is recorded as `ignored`, and it has no second effect.
  Never purge a DLQ without inspecting it.
- **Logs.**
  - Healthy services log nothing per probe.
  - An outage logs one line per worker pass (12–60 per minute per worker) plus one line per affected item per retry: the retry lines
    grow with the backlog.
  - Every fault and every recovery has a named line.
  - No token, password or URL credential appears in any captured line.
- **Open items:**
  - Auth answers 429 to its own health probes above about 100 per minute per address, and does not log it (SRE / security);
  - a database-unavailable request is an opaque 500 with a message rather than classified facts in the log (O3);
  - a few failure kinds are missing from the log taxonomy.
- Details: `core-validation.md` section 13.7.

**Capacity and runtime tuning (Stage 15.8).** Measured on one laptop: relative evidence, not a production capacity claim.
- **Kept, with evidence:**
  - `DB_POOL_MAX` 10: 20 is no faster and doubles p99, 5 is 16–19 % slower;
  - dispatcher batch 50, the 60 s stale window, the outbox batch 50, every worker interval, and every internal timeout.
- **Changed, each with before/after measurements, a mutation-proven test and the affected historical campaigns re-run:**
  - Payment's expiry sweep uses a partial index (15 ms → 0.04 ms at 100 k payments), and skips a payment another transaction holds.
    Before, one held payment stopped every expiry: 0 of 1 000 in 120 s; now 999 in 3.5 s.
  - Payment's attempt resolver claims an attempt with a short lease before asking the provider: N instances now make one provider call
    per attempt, not N.
  - Billing's dispatcher renews the claims it has not sent yet, so a slow Payment never makes a second instance send the same request
    again. Startup now refuses `BILLING_DISPATCH_STALE_SENDING_MS` < 2 × `PAYMENT_TIMEOUT_MS`.
  - The Billing consumer's prefetch is 5: half the pool. With 10, a backlog took the whole pool and HTTP waited for connections.
  - The outbox relay drains full batches back to back (a 5 000-event backlog: 111 s → 17 s), and its backoff ceiling is 15 s instead of
    60 s: the worst delivery delay after a broker outage.
  - The duplicate `billing_transition` index is dropped (−39 % index size, −20 % insert time, same plans).
- **Connection budget per deployment:** Σ (`DB_POOL_MAX` × processes) + migration runners + operator sessions + 3 reserved ≤
  `max_connections` (100 by default). With the defaults that is at most 2 processes per service on one default PostgreSQL.
- **Migrations to apply before the new code:** Payment `0007` and `0008`, Billing `0014`. `0007` builds an index under a `SHARE` lock: on
  a large table, build it `CONCURRENTLY` (Stage 20).
- **Open (SRE / security):**
  - Auth's health endpoints share its throttle. Raising the limit is not a fix: the in-memory throttler's cost grows quadratically with
    the requests from one address.
  - Readiness opens one broker connection per probe (about 55 ms); O2 is still open.
- Details: `core-validation.md` section 13.8.

**Phase C closure (Stage 15.9).**
- The final `main` (`aab849f`) was re-certified end to end:
  - the canonical reliability matrix of Stages 15.2–15.8;
  - the migration chain, clean and as an upgrade;
  - the four production images (non-root, Node as PID 1, no validation tooling, natural exit under the 60 s grace);
  - the full regression.
- Invariants I1–I18 hold: authentication, security, authorization and commercial boundaries, tenant isolation, idempotency, durable
  async work, outbox and consumer correctness, bounded database failures, worker concurrency, shutdown, recovery, the V1 commercial
  lifecycle, Payment as settlement authority, failure truthfulness, and bounded resources.
- Every remaining item is a policy or Stage 21.x decision with an owner, a target and a risk: `core-validation.md` section 17.
- **Still blocking production (Stage 21.x Production Prerequisite Closure, not Phase C; moved from "Stage 20" by ADR-0051 D3, 2026-09-26,
  since Stage 20 is Release Management; earlier "Stage 20" mentions in this document mean Stage 21.x):**
  - the backup job and a restore drill on the real volume;
  - RPO / RTO and retention durations;
  - branch protection (F2);
  - the deployment items (restart policy, rolling deploy, the connection budget, `CONCURRENTLY` for large index builds).
- Details: `core-validation.md` sections 13.9 and 17.

**Signals and tools:** the log signals (`*_pass_failure`, `readiness_check_failed|recovered`, `outbox_publish_failure`,
`rabbitmq_confirm_timeout`, `worker_drain_timeout`, `webhook_retry_exhausted`, `service_started`, `service_shutdown_*`) and the CLIs
(`nawara-migrate`, `nawara-check-outbox-lag`, `nawara-check-dlq`, `nawara-dlq`) are described in the
[service-kit README](../../libs/service-kit/README.md#operational-signals-stage-147).

**Findings of the Stage 14.1 baseline:**

| # | Finding | Resolution |
|---|---|---|
| F1 | Auth production image did not build | fixed, 14.2 (#78) |
| F2 | CI checks not required on `main` | **open**: repository setting |
| F3 | Auth ran as the database superuser | fixed, 14.3 (#79); applied in production |
| F4 | Unbounded publisher confirm | fixed, 14.6 (#82) |
| F5 | Incomplete database time limits | fixed, 14.4 (#80) |
| F6 | Workers did not drain on shutdown | fixed, 14.6 (#82) |
| F7 | Webhook retrier unbounded and unlocked | fixed, 14.6 (#82) |
| F8 | Runtime configuration validation gaps | fixed, 14.3 (#79) |
| F9 | Auth migrations without lock or checksum | fixed, 14.5 (#81); applied in production |
| F10 | Containers ran as root | fixed, 14.2 (#78) |
| F11 | CI built only the Auth image | fixed, 14.2 (#78) |
| F12 | No retention for technical tables (`outbox`, `inbox`, rate-limit and throttle rows, idempotency keys, `webhook_event` raw bodies) | measured and classified in Stage 15.7 (`core-validation.md` 13.7: growth per operation, safe-deletion conditions per table); still deferred: the durations need the retention / RPO / RTO decision (section 3). No cleanup is built yet |
| F13 | Operational failures not identifiable in logs | fixed, 14.7 (#83) |
| F14 | Auth events have no transactional outbox | **resolved in code by Stage 21.C.2** (ADR-0052 decision 4): Auth's domain events are written to its transactional outbox in each change's transaction and relayed at least once; code-bearing rows are purged once published or expired. Production still runs `AUTH_EVENTS=off` until Stage 21.x enables it |

**Stage 15** validates these mechanisms under controlled failure and load; its plan, invariants and results are in
[core-validation.md](./core-validation.md).

**Known behaviour to validate in Stage 15 (not defects):** a worker's in-flight pass is waited for in `beforeApplicationShutdown` and
again in `onApplicationShutdown`, module by module, so with passes that hang the total drain can exceed Docker's default 10 s stop
grace, after which the process is killed (work is not lost: transactions roll back and rows are claimed again). Only auth-service is
deployed and it runs no poll loop. A persistent dependency outage logs one failure line per worker pass. Auth ignores `LOG_LEVEL`
(always `info`).
