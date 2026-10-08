# Core V2 A15: developer and platform experience

- **Status:** RECORD of the A15.0 discovery (read-only, owner-reviewed, 2026-10-07, on `main` at `869100d`, the PR #228 merge that
  certified A2), of the A15.1.0 design (read-only, owner-reviewed), of **A15.1: generic CLI configuration hygiene** (**closed on `main`**:
  PR #229, merge `a7c56643a72c9b1b829c1b89521f7f8165aaa7f0`; §4), of **A15.2: the canonical developer path and toolchain**
  (**closed on `main`**: PR #230, merge `fa569d8f54d7c96c97a8aae2fcfc21c3a05cdc18`; §5) and of **A15.3: local environment and test
  determinism** (**complete locally, owner review pending**; §6). **A15 is OPEN.** A15.4 and A15.5 are not started.
- **Scope of A15** ([roadmap](../CORE-ROADMAP.md) A15): service templates, shared libraries, local environment, testing and CI
  conventions, documentation, generators, localization conventions. The roadmap gives no subphases or completion criteria; §3 does.
  **Not A15:** Auth's CLIs and loader (A4); the Organization ownership tooling (A5 / F6 / F7); observability capabilities (A12);
  secret scanning and dependency policy (A14); messaging conventions (A3); production work of any kind.

## 1. A15.0 findings (summary)

- **Handed to A15 by other records:** generic CLI configuration hygiene ([A2 record](core-v2-a2-configuration-and-secrets.md) §8,
  §10); F9, the `rabbitmq-diagnostics` health checks running as root, and the ADD drift
  ([baseline record](core-v2-a-baseline-and-change-safety.md) §5); the timer-dependent tests (the Billing `57P01` teardown race, the
  Notification overlap test, the Payment `expiry-sweeper` window) and the local RabbitMQ development-environment issue
  ([R11 record](core-v1-refactor-certification.md), [V2-A.2 record](core-v2-a-2-certification.md),
  [A12 record](core-v2-a12-observability.md)).
- **Operator CLIs.** Eleven entry points. Every one already prints value-free errors (`describeCliFailure` or fixed text), and File's
  `reconcile` already reads through its service loader. Five generic ones read one or two variables by name (no trimming, no
  `NAME_FILE`, no refusal of `NAME` + `NAME_FILE`), and `nawara-check-outbox-lag` took its database URL as an argument.
- **Developer path.** The root README has a short setup block. Missing or inconsistent: a declared Node version (CI and the images use
  Node 22); the build of `@nawara/audit-contract` beside the kit; one place for the integration-test environment (repeated in eleven
  READMEs, with two different ports); troubleshooting. Every Core CI job has an exact local command; they are listed nowhere together.
- **Adequate, not changed:** the repository checks (fast, flat, actionable); generated artefacts (the audit catalog document, the
  hierarchy fixtures, the dashboards: each has drift detection); package scripts, apart from three leftover `nest deploy` entries.
- **No P0.** A15 has **no G6 dependency**; nothing in it changes an API, an event or a contract.

## 2. Owner decisions

| Id | Decision |
|---|---|
| OD-A15-1 | **A:** `nawara-check-outbox-lag --database-url` stays compatible and is deprecated; the environment or `_FILE` is the documented way |
| OD-A15-2 | **A, narrow:** Audit's `retention` CLI is included for how `RETENTION_DATABASE_URL` is read, and nothing else (A13 stays closed) |
| OD-A15-3 | **B:** F9 is **accepted** as low-risk local and CI behaviour. The Compose health check and the four CI service definitions are not changed. Disposition recorded here; the item is closed |
| OD-A15-4 | **A:** no formatting enforcement (no format gate in CI) |
| OD-A15-5 | **A:** the Node 22 declaration (`engines`, `.nvmrc`) is part of A15.2 |
| OD-A15-6 | **A:** A15.4 is small: a new-service checklist and the localization convention; no generator or template framework |
| OD-A15-7 | **A, for now:** `nawara-migrate` keeps `MIGRATION_DATABASE_URL` falling back to `DATABASE_URL` |
| OD-A15.1-1 | **A:** using `--database-url` prints one fixed warning on stderr, never the URL; stdout and exit codes unchanged |
| OD-A15.1-2 | **A:** the migration fallback is lazy: when the primary setting resolves, the fallback pair is not read at all |
| OD-A15.1-3 | **Now:** this record and the roadmap entry are created with A15.1 |

## 3. Phases

| Phase | Objective | Done when |
|---|---|---|
| A15.1 | generic CLI configuration hygiene (§4) | the generic operator CLIs read through the kit's reader; no documented command puts a credential in an argument |
| A15.2 | developer path | one canonical developer guide (prerequisites, first run, build order, test progression, CI-to-local map, troubleshooting) linked from the READMEs; Node 22 declared; no contradictory setup or test recipe |
| A15.3 | local environment and test determinism | the recorded timer-dependent tests, the local broker issue and the ADD drift are each fixed or re-homed with a reason (F9: accepted, OD-A15-3) |
| A15.4 | conventions | a new-service checklist from [ADR-0056](../adr/0056-core-architecture-and-api-conventions.md); the localization convention stated ([ADR-0054](../adr/0054-localized-error-messages-and-stable-error-codes.md)) |
| A15.5 | certification | the criteria of each phase met; boundaries to A3, A4, A5, A12 and A14 unchanged; production untouched |

```text
A15.0  discovery, owner decisions       ✅ complete (owner-reviewed)
A15.1.0  CLI hygiene design             ✅ complete (owner-reviewed)
A15.1  generic CLI configuration hygiene   ✅ closed on main (PR #229, merge a7c5664; §4)
A15.2.0  developer-path design          ✅ complete (owner-reviewed)
A15.2  developer path and toolchain     ✅ closed on main (PR #230, merge fa569d8; §5)
A15.3.0  determinism discovery          ✅ complete (owner-reviewed)
A15.3  local environment, determinism   complete locally; owner review pending (§6)
A15.4 – A15.5                           not started
```

## 4. A15.1: generic CLI configuration hygiene (2026-10-07; closed on `main`, PR #229, merge `a7c5664`)

Merged with 24 of 24 pull-request checks green; that run covered the broker-dependent suites that could not run on the development
machine (below).

A15.1 **adopts** the A2 configuration model in the generic operator CLIs. `EnvReader`, `ConfigError` and `describeCliFailure` are
unchanged, and no service runtime changed.

| CLI | Reads, through `new EnvReader(process.env)` | Kept exactly |
|---|---|---|
| `nawara-migrate` (kit) | `MIGRATION_DATABASE_URL`, then `DATABASE_URL` | arguments, output and summary line (parsed by the restore drill), exit codes, the fallback |
| `nawara-dlq`, `nawara-check-dlq` (kit) | `RABBITMQ_URL` | commands, output, exit codes (0, 2, 3, 4, 5, 1) |
| `nawara-check-outbox-lag` (kit) | `DATABASE_URL`; `--database-url` still wins | stdout, exit codes |
| `secret-keys` (Notification) | `DATABASE_URL`, `NOTIFICATION_SECRET_ACTIVE_KEY_ID` | commands, JSON output, exit 0 / 3 (verdict), 2 (usage or configuration), 1 (query) |
| `retention` (Audit) | `RETENTION_DATABASE_URL` | the `postgres://` check, the writer-role refusal, policy, batches, ledger, dry run, JSON output, exit codes |

- **What each gains** (the reader's semantics, proven by the kit's own `EnvReader` tests): surrounding whitespace removed; a blank
  value is unset; `NAME` or `NAME_FILE`; both together refused (`set NAME or NAME_FILE, not both`); an unreadable file reported by
  name; every message value-free.
- **Kit resolvers** (`libs/service-kit/src/cli/cli-config.ts`, internal, not exported from the kit): `migrationDatabaseUrl`,
  `brokerUrl`, `outboxDatabaseUrl`. Three small functions over `EnvReader`, so the resolution is unit-testable; not a second
  configuration abstraction.
- **Migration fallback (OD-A15-7, OD-A15.1-2).**

| `MIGRATION_DATABASE_URL` | `DATABASE_URL` | Result |
|---|---|---|
| name, or file | anything, including ambiguous or unreadable | the primary; the fallback is not read |
| name and file | anything | refused (the primary pair is ambiguous) |
| an unreadable file | anything | refused (never a silent fallback) |
| unset, empty or whitespace only | name, or file | the fallback |
| unset | name and file | refused (the fallback pair is ambiguous) |
| unset | unset | `MIGRATION_DATABASE_URL (or DATABASE_URL) is required` |

- **`--database-url` (OD-A15-1, OD-A15.1-1).** Still accepted and still first; when it is given the environment is not read, so no
  existing command can start failing. Using it prints once, on stderr:
  `--database-url is deprecated: pass DATABASE_URL or DATABASE_URL_FILE (a credential on the command line is visible to other processes)`.
  The kit README and the Release runbook now show the environment form. It was the only credential-bearing argument of the six CLIs.
- **Differences in behaviour, all the A2 semantics:** surrounding whitespace is ignored; a whitespace-only value is unset (for
  `nawara-migrate` it now falls back, as an empty one already did); `NAME` with `NAME_FILE` is refused (the file used to be
  ignored). The missing-URL message of the lag check now names `DATABASE_URL (or DATABASE_URL_FILE)`. **No intentional breaking
  change:** the deploy scripts' migration step (only `MIGRATION_DATABASE_URL` in its environment file) is unaffected.
- **Guard (additive; A2.5 unchanged).** `check:repo` lists the six CLIs (`ENV_READER_CLIS`): in them `process.env` may appear only
  as the argument of `new EnvReader(...)` (a named or bracket read, a destructuring, a copy or a write fails), and the resolvers file
  may not reach `process.env` at all. The path boundary of A2.5 still admits every CLI directory: Auth's CLIs (A4) and the
  Organization ownership CLI (A5 / F6 / F7) are not listed and keep their reads.
- **A13 untouched.** In `retention.ts` one read and one `catch` clause changed. The retention role, its separation from the runtime
  URL, the writer-role refusal, policy-driven durations, batches, the ledger and the output are as certified.
- **Tests.** Kit unit: the resolvers (the fallback table above, the broker pair, the flag precedence, that an unused setting is never
  read). Kit process-level (no database or broker needed: each case exits first or dials a closed port): the four built CLIs refuse a
  missing, blank, ambiguous or unreadable setting by name, accept `NAME` and `NAME_FILE`, and print no sentinel credential, file path
  or argument; the deprecation warning appears once, on stderr, without the URL. Notification and Audit: new cases in their existing
  CLI end-to-end tests (by file, trimmed, both refused, unreadable, unchanged refusals and exit codes).
- **Evidence (local).** Kit: build, typecheck, lint, unit suite 510 passed (37 files), the new process-level spec 10 passed, the
  outbox-lag, outbox-metrics and migration integration specs against PostgreSQL. Billing's migration CLI end-to-end test; Audit's
  retention suite (14 passed); Notification's two CLI tests; `test:deploy` 316 passed; `check:repo`; `test:repo`. **Not run locally:**
  the suites that need RabbitMQ (the DLQ replay end-to-end test, the broker half of the kit observability spec, Audit's operational
  suite): a local broker container would not start on the development machine (the local-environment issue A15.3 owns); Core CI runs
  them. Negative controls, each red when mutated and restored byte-for-byte: a direct `process.env` read in a migrated CLI
  (`check:repo`); the ambiguity refusal bypassed (process-level test; this control showed the resolvers file needed its own guard
  rule, added); the URL appended to the deprecation warning (leak assertion); the migration fallback removed (fallback tests).
- **Production.** GREEN to implement and to merge: the kit path makes the Auth, Organization and Audit image workflows **build**;
  nothing deploys (deploy workflows are dispatch-only). **YELLOW, later and separate:** the new CLI behaviour reaches production with
  the next owner-authorized deploy of each image. RED: none; no G6 dependency.

## 5. A15.2: the canonical developer path and toolchain (2026-10-07; closed on `main`, PR #230, merge `fa569d8`, 24 of 24 checks green)

- **Owner decisions:** OD-A15.2-1 = A (`engines.node` `22.x` and `.nvmrc` `22`: parity with CI and the images; advisory, no
  `engine-strict`, no npm declaration); OD-A15.2-2 = B (the guide is `docs/DEVELOPMENT.md`, linked from the root README);
  OD-A15.2-3 = A (a root `build:libs` script, CI's own command); OD-A15.2-4 = A (pre-PR guidance is documentation only: no
  orchestration command). Also decided: remove the three leftover `nest deploy` scripts; correct Auth's stale migration instruction;
  leave `docker-compose.yml` untouched; no guard on the commands the guide shows.
- **Toolchain.** Node 22 is what CI (`NODE_VERSION`) and every application Dockerfile already use. It is now declared for developers
  in the root `package.json` and `.nvmrc`, and `check:repo` keeps the four in step (`checkNodeToolchain`: `.nvmrc` is the
  reference; `engines.node`, every Node version of Core CI and every Dockerfile base image must name the same major).
- **`npm run build:libs`** builds `@nawara/service-kit` and `@nawara/audit-contract`, which the services consume through their built
  `dist/`. CI keeps its own explicit command.
- **[Developer guide](../DEVELOPMENT.md).** One journey: prerequisites; first run (install, libraries, checks, environment,
  infrastructure); running a service (migrate, start, health); the validation ladder and what to run before a pull request; the local
  equivalent of every Core CI job; the test environment, stated once; changing dependencies; troubleshooting (only failures that
  have actually occurred); where the specialized documents are. It restates no A2 rule beyond what a developer needs and links the
  rest.
- **READMEs.** The root README's setup block is replaced by a short "Developing" section that points to the guide (its build line
  named the kit only). The eight service READMEs and the two library READMEs keep their own commands and lose the repeated shared
  recipe: the library build becomes `npm run build:libs`, and the inline `TEST_DATABASE_ADMIN_URL` / `TEST_RABBITMQ_URL` values
  give way to a reference to the guide. Two examples that pointed at port 5432 (Organization, the kit) are corrected: Compose
  publishes PostgreSQL on 5433. Auth's "apply db/migrations/0001..0007" becomes its real migration command.
- **Package scripts.** `"deploy": "nest deploy"` is removed from Auth, Billing and Payment: a scaffold leftover with no caller, and
  misleading beside the digest deployments. No deployment workflow or script changed.
- **Lockfile.** `package-lock.json` gains the same `engines` entry on its root package (three lines, by owner decision, so that a
  later `npm install` does not produce an unrelated diff); no dependency, version, integrity or resolved URL changed.
- **Not changed, on purpose.** `docker-compose.yml`: its header comment still says
  Auth "does not depend on" the kit, which is no longer true. **Deferred comment debt**, to be corrected the next time that file is
  edited for a reason of its own.
- **Found, for A15.3:** `libs/service-kit/test/observability.int-spec.ts` cannot be loaded without `TEST_RABBITMQ_URL` (it reads the
  variable while the suite is being declared), so its PostgreSQL tests do not run without a broker either. The guide's
  troubleshooting names the symptom; the fix belongs with the other local-determinism items.
- **Boundaries kept.** A15.3 (the local broker, stale test queues, the timer-dependent tests, the ADD drift) and A15.4 (the
  new-service checklist, the localization convention) are untouched. Nothing of A2 or A14 changed: no reader, template, ignore rule,
  guard, workflow, pin or dependency.
- **Evidence (local).** `test:repo` 124 passed (122 before; the Node guard's fixtures and its wiring); `check:repo`; the changed
  `package.json` files parse; `npm run build:libs` builds both libraries; relative links of every changed document; the guide's
  commands read against `package.json`, the workspace scripts and `core-ci.yml`. Negative control: `.nvmrc` set to 20 makes
  `check:repo` red, naming each source that disagrees; restored byte-for-byte.
- **Production:** none. GREEN to implement and to merge: the root `package.json` and the Auth, Audit and library paths make the
  Auth, Organization and Audit image workflows **build**; nothing deploys, and nothing changes at runtime. No G6 dependency. Drive
  does not depend on this: no API, event or contract changed.

## 6. A15.3: local environment and test determinism (2026-10-08, local)

- **Owner decisions:** OD-A15.3-1 = A (one bounded local diagnosis of the broker start failure first); OD-A15.3-2 = A (fix all
  twelve copies of the test infrastructure gate); OD-A15.3-3 = A (tests delete the broker resources they declare, plus a documented
  local reset); OD-A15.3-4 = A (close the items without evidence; re-home `auth_timeout` to A12).
- **The broker start failure (`.erlang.cookie: eacces`), diagnosed.** Seen three times locally and once in Core CI on `main` (run
  37628789313, the RabbitMQ service container of the shared-platform job). Two bounded starts of the Compose image
  (`rabbitmq:3.13-management-alpine`, image `1031d41f…`, the same image that started normally on 2026-10-05):
  1. started while a readiness loop ran `rabbitmq-diagnostics` through `docker exec` right away: the node exited with `eacces`, and
     `/var/lib/rabbitmq/.erlang.cookie` was mode `0400`, owned by **root** (`0:0`), with Erlang's midnight timestamp;
  2. started with nothing run in the container until the log said `Server startup complete`: it started, and the cookie was owned by
     `rabbitmq` (`100:101`); a root `rabbitmq-diagnostics ping` afterwards succeeded.

  **Cause:** the image sets `HOME=/var/lib/rabbitmq` for every user, so a `rabbitmq-diagnostics` command run as root **before the
  broker has created its cookie** creates it, as root, in the broker's home; the broker then runs as `rabbitmq` and cannot read it.
  Only a container's first start is exposed (a reused container already has its cookie). Classification: **B, repository
  configuration**: the health checks of Compose and of the four Core CI RabbitMQ services run `rabbitmq-diagnostics -q ping` as root,
  and CI's first check can fire before a slow broker has written its cookie (it fails intermittently, as observed). It is not an image
  regression (no pin is justified: the same image starts when nothing races it) and needs no host change.

  **Not fixed here.** The fix is to run the health check as the broker's user (for example `su-exec rabbitmq rabbitmq-diagnostics -q
  ping`) in `docker-compose.yml` and in the four service definitions of `core-ci.yml`. Those are exactly the health checks OD-A15-3 = B
  (F9) decided not to change, so this needs a new owner decision: F9 was accepted as a low-risk root health check, and is now evidenced
  as the cause of a CI failure. The developer guide's troubleshooting explains the local symptom meanwhile.
- **Skipped suites ran their setup.** All twelve copies of `describeWithEnv` (`apps/*/test/support`, `libs/*/test/support`,
  `test/*/support`) skipped a suite with missing variables as `describe.skip(title, () => body({}))`. Vitest runs a describe callback
  while collecting, even for a skipped describe, so the body ran with no configuration: the six kit files that build a `URL` from
  `TEST_RABBITMQ_URL` at the top of their broker block failed to load instead of skipping, and `observability.int-spec.ts` lost its
  PostgreSQL tests too. Now the skipped suite registers one skipped placeholder (`needs <VARIABLE>`) and the body is never run. Unchanged:
  with the variables set the suite runs as before, and with `CI=true` a missing variable is still a failing test. A new kit unit test
  (`test/describe-with-env.spec.ts`) checks the three paths.
- **Broker resources owned.** The kit's bus declares durable exchanges and queues (a consumer queue brings `.retry` and `.dead`, an
  exchange its `.dlx`). Seven kit integration files named them uniquely per test but never deleted most of them, so a long-lived local
  broker kept every one (over a thousand queues had accumulated). A small helper (`libs/service-kit/test/support/broker-resources.ts`)
  records each name a file declares and deletes exactly those, with their companions, when the file ends; nothing unregistered, no
  wildcard. The rabbitmq-dlq-retry file already cleaned up and is unchanged; the fixed-name service and cross-service suites already
  delete or purge their queues and were not changed.
- **Two timing tests made deterministic.** Payment `expiry-sweeper` ("refuses to expire a payment with money in flight"): the payment
  expired 150 ms after creation, so a slow runner reached `startAttempt` after expiry (409, run 37310414915). Now it is created with a
  far expiry, the attempt starts, and only then is `expiresAt` moved into the past, by the scratch database's owner, in one transaction
  that disables and re-enables the immutability trigger (as other Payment tests already do for other immutable columns). Notification
  `delivery-engine` ("two deliveries of one intent finishing at the same moment"): the test required the two provider calls to start
  within 40 ms (failed at 62 ms, run 37078342692). Now both fake providers wait at a two-party barrier, so both are in flight before
  either finishes; the bounded wait only stops a broken barrier from hanging. Same five rounds, same functional assertions.
- **Documentation drift corrected.** `docs/add/auth-service.md` said the newer Auth events were "not delivered yet" and that an outbox
  was the future design; they are written to the transactional outbox and relayed (Notification consumes the ones with a destination,
  and deliberately not `user.registered`, `membership.requested`, `membership.admin_provisioned`). `docs/add/payment-service.md`'s open
  question about an outbox "once RabbitMQ exists" is marked resolved.
- **Closed without change (OD-A15.3-4):** the Billing `57P01` teardown race (no failing test or run located; Billing's teardowns close
  the app before dropping the database; the only concrete record is a printed, non-failing Auth message) and the "Billing audit-regex
  flake" (no test, run or symptom recorded). Either reopens on a new observed failure. **Re-homed to A12:** the Audit and Release
  `auth_timeout` attribution question (an outcome-label semantics question, not determinism).
- **Policy** (from these findings only): tests delete the broker resources they declare; a suite skipped for missing infrastructure
  never runs its body; a test does not use a wall-clock gap as its correctness condition when state or synchronization can make it
  deterministic; teardown closes clients before dropping a scratch database.
- **Coverage.** No test was deleted, skipped or weakened, and no retry was added. A local skip that used to crash is now a skip; CI,
  which sets every variable and fails on a missing one, runs exactly what it ran.
- **Evidence (local, throwaway PostgreSQL and RabbitMQ).** `observability.int-spec.ts`: with PostgreSQL only, 6 passed and 1 skipped
  (before: the file failed to load); with `CI=true` and no broker URL, the clear "must be set in CI" failure; with both, 8 passed. All
  eight kit broker files: 51 passed, and the broker's queues and exchanges were the same set before and after the run (nothing left,
  nothing else removed). Payment `expiry-sweeper` 5 of 5 and Notification `delivery-engine` 58 of 58 as whole files; the two formerly
  flaky tests five runs each, all passed. Kit unit suite 514 passed. Negative controls, each restored byte-for-byte: running the body in
  the skip path again (the observability file fails to load, "Invalid URL"); one exchange left unregistered (five `dispose` exchanges
  remain after the run); the old 150 ms expiry with a 300 ms scheduling delay (409), while the new setup with the same delay passes; one
  provider skipping the barrier ("both deliveries were in flight together": expected 1 to be 2).
- **Production:** none. GREEN to implement and to merge (tests and documentation; the kit test paths make the Auth, Organization and
  Audit image workflows build; nothing deploys). No G6 dependency.
