# Core V2 A15: developer and platform experience

- **Status:** RECORD of the A15.0 discovery (read-only, owner-reviewed, 2026-10-07, on `main` at `869100d`, the PR #228 merge that
  certified A2), of the A15.1.0 design (read-only, owner-reviewed) and of **A15.1: generic CLI configuration hygiene** (**complete
  locally, owner review pending**; §4). **A15 is OPEN.** A15.2 to A15.5 are not started.
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
A15.1  generic CLI configuration hygiene   complete locally; owner review pending (§4)
A15.2 – A15.5                           not started
```

## 4. A15.1: generic CLI configuration hygiene (2026-10-07, local)

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
