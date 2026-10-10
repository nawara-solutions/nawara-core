# Core V2 A5.4-A5: Auth hierarchy-authority readiness check (design and test plan)

- **Status:** design and test plan, **documentation only (GREEN)**, written 2026-10-10 under the owner's GREEN documentation
  authorization for A5.4-A5. **It authorizes no code, test, commit of code, pull request, merge, image selection, deployment or
  activation.** A5.4-A5 stays **RED with a design-approved pre-G6 exception** ([A5 record](core-v2-a5-organization.md) §9.1 item 4);
  its implementation needs its own RED-exception development authorization (§10).
- **Governs:** [ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md) §4 (Accepted) with its dated
  clarifications of 2026-10-10 (rulings 1 to 7, and items 8 to 10 for R1 to R3), the
  [F6 readiness decision record](core-v2-a5-4-f6-transitional-readiness.md)
  (Decision, "The two windows", "Reasons", "Required design safeguards", "Later rulings", "Still open"), A5.4-G1 ([A5 record](core-v2-a5-organization.md)
  §9.1 item 4) and the [A5.4-D1 specification](core-v2-a5-4-implementation-specifications.md) §6.5. Where this document and one of
  them differ, they govern. This document **decides no policy**: it applies the rulings, and fixes what the decision record
  assigns to it ("the check's name and the reason identifiers (the A5.4-A5 design document)"), with three implementation
  diagnostics: the error class, the Auth reason log line, and the three-way split of the fail-closed reason (§3, §5, §7). **The
  owner confirmed these identifiers on 2026-10-10 (R4).**
- **Owner rulings (2026-10-10, R1 to R4; recorded on ADR-0063 §4 and in the decision record's "Later rulings"):** R1, a `frozen`
  marker is not ready with `marker_frozen` in fresh and existing environments, with either source (§4, §11); R2, a backup taken
  under a freeze stays a valid backup state, and the restore-drill compatibility change is separately authorized (§9, §10); R3, a
  reviewed operational alert mechanism is implemented and demonstrated before the first production deployment of any Auth image
  containing this check, and for later Auth deployments, including F6-related redeployments (§7, §10); R4, the diagnostics (§3, §5, §7). **The rulings authorize no implementation, alert, drill
  change, merge or deployment.**
- **Not changed here:** no Accepted ADR, the certified [G6 plan](stage-21/stage-21-x-g6-rehearsal-plan.md), the active
  [F6/F7 runbook](../runbooks/organization-production.md), any code, test, schema, workflow, deploy script or shared library.

## 1. Scope

**In scope (for a later, separately authorized implementation):** one readiness check, registered by auth-service in the kit's
readiness registry (`/ready`), that compares Auth's configured hierarchy source with its authority marker and reports **not ready**,
with a named reason, when they disagree or when the marker cannot be trusted. Its diagnostics, its tests and the documentation
statements it makes true.

**What it is:** a **monitoring signal** read by the attended operator, the restore drill and the readiness gauges (ruling 4).
**What it is not:** a traffic control, a deploy gate, a startup gate, a write guard, an authority switch, a restore detector or a
replacement for the authority agreement check (runbook §6.2).

## 2. Facts the design rests on (read on `main` at `d4d9dce`)

- **The registry** (`libs/service-kit/src/health/readiness.registry.ts`). A check is `() => Promise<void>`; a throw is a failure.
  `/ready` runs every registered check with a per-check timeout (Auth: `checkTimeoutMs: 1500`, `apps/auth-service/src/app.module.ts`)
  and answers `200 {"status":"ready"}` or `503 {"status":"unavailable","failed":[<check names, sorted>]}`. **The response carries
  check names only, never a reason.** The registry logs `readiness_check_failed check=<name> <describeFailure(e)>` **only when a
  check's state changes** from passing (or unknown) to failing, and `readiness_check_recovered check=<name>` when it passes again.
  `describeFailure` prints `error=<class> [code=<code>] [kind=<kind>]`, never the message (`libs/service-kit/src/logging/failure.ts`).
  Checks run only when `/ready` is called; nothing probes in the background.
- **The gauges** (`libs/service-kit/src/metrics/install.ts`, when `METRICS_ENABLED`): `nawara_readiness_ready` and
  `nawara_readiness_check_up{check=<name>}` are set by each `/ready` run. A check name matches `^[a-z][a-z0-9_-]{0,40}$`. The local
  rule file states "Readiness has no alert" (`infra/observability/prometheus/rules/nawara-core.rules.yml`).
- **Auth today** registers `database` (`SELECT 1`) and `migrations` (`apps/auth-service/src/db/db.service.ts`). `/auth/health` is
  Auth's own controller, a database-only `SELECT 1` (`apps/auth-service/src/health/health.controller.ts`); the container healthcheck
  and the deploy wait use it (`apps/auth-service/deploy/provision-and-deploy.sh`). Traffic routing has no health check.
- **The source** `AUTH_HIERARCHY_SOURCE` is read once at start; it is `local` when unset, otherwise `organization-service`; any other
  value fails configuration loading, so the process never runs with a third value (`apps/auth-service/src/config/app-config.ts`).
- **The marker** `hierarchy_authority.mode` (migration `0008`): exactly one row (`id boolean PRIMARY KEY DEFAULT true CHECK (id)`),
  `mode` constrained to `local`, `frozen`, `org_authoritative`; row deletion and illegal transitions are refused by a trigger;
  `org_authoritative` is one-way. A missing row is still possible (for example `TRUNCATE`, which row triggers do not see, or a
  privileged session); an invalid value or a second row is impossible while the constraints exist.
- **Existing readers.** `hierarchyMode()` (`src/hierarchy/hierarchy-authority.ts`) assumes the row exists (`rows[0]!.mode`), and the
  start-up report (`reportSource`, `src/hierarchy/hierarchy-reference.ts`) logs `auth_hierarchy_source …` and, on disagreement, the
  warning `hierarchy_source_mismatch`. Neither is a readiness signal, and neither is changed by this design.
- **Readers of Auth's `/ready` today:** the attended operator (runbook §6.1), the restore drill, which passes only when the restored
  service answers ready (`infra/backup/restore-drill.sh`), the gauges, and tests (§8.4). A not-ready Auth keeps serving.

## 3. The check

| Item | Specification |
|---|---|
| Check name | **`hierarchy_authority`** (fixed here, as the decision record assigns; confirmed by R4) |
| Registered by | auth-service only, in the kit's `ReadinessRegistry`, alongside `database` and `migrations` (A5.4-G1 item 4) |
| Inputs | the configured source, from the loaded configuration (memory; no read); the marker, by **one read-only statement per run**: `SELECT mode FROM hierarchy_authority`, through the existing pool |
| Reads on every run | yes, **in both sources**. With source `local` the marker must still be read: `org_authoritative` or `frozen` with source `local` must be reported (§4). This differs deliberately from the A3 route, which never reads the marker with source `local` |
| Writes | **none**: no marker change, no trigger, no event row, no audit record, no outbox row, no `SET` of `nawara.reference_write` |
| Failure form | throws a dedicated error whose class is **`HierarchyAuthorityNotReady`** and whose `code` is the reason identifier (§5), so the registry's existing line reads `readiness_check_failed check=hierarchy_authority error=HierarchyAuthorityNotReady code=<reason>` without a kit change |
| Timeout | the registry's own (1500 ms for Auth). A marker read that does not answer is reported by the registry as `error=ReadinessCheckTimeout`; that is the `marker_unreadable` case (§5) observed through the kit |
| Start-up | registration only. **The check performs no database access at start-up and adds no start-up dependency** (ADR-0063 §4: "Startup itself does not depend on the database (readiness does)"). The existing best-effort, un-awaited `reportSource` read of the marker at bootstrap is unchanged |
| Calls to other services | none. It never calls organization-service (A5.4-T1, `checkAuthOrganizationBoundary`, stays satisfied) |
| Where | a new Auth file under `apps/auth-service/src/hierarchy/` (for example `authority-readiness.ts`) and its registration; the exact file is fixed by the implementation task, inside A5.4-G1 item 4's scope |

The marker reader of the check is its own strict reader (§4, rows 7–9); it does **not** reuse `hierarchyMode()`, whose
`rows[0]!` would turn a missing row into a `TypeError` instead of the named reason. `hierarchyMode()` itself is not changed.

## 4. Source and marker matrix

`S` labels are the decision record's states (§3 there). "Window" means the attended F6 windows of ruling 5: the **transition window**
(from `ownership activate` to the authority agreement MATCH) and, inside it, the **disagreement window** (from the start of the Auth
container with the new source to the commit of `hierarchy-retire --fresh`). The check cannot see either window, nor
organization-service's phase; the operator knows the window from the attended step log.

| # | Source | Marker | Result | Reason (`code`) | Marker read needed | Transitional? | Diagnostic | Operator severity (runbook §6.3 as amended); production alerting: §7, R3 |
|---|---|---|---|---|---|---|---|---|
| 1 | `local` | `local` | **ready** | – | yes | S2a (after `activate`, before the redeploy) looks identical; **ready is expected there and verifies nothing about the mirror** (ruling 1) | none | none from this check; S2a, S5b and an abandoned transition are seen **only** by the agreement check (§6.2) |
| 2 | `local` | `frozen` | **not ready** | `marker_frozen` | yes | never on the fresh path (ruling 3); in an existing environment it is the freeze of ADR-0040 E2, expected only inside that attended step (R1) | registry line; Auth reason line (§7) | critical on the fresh path. In an existing environment: not ready for the whole attended freeze (R1), to be named as expected in that procedure's runbook and critical otherwise |
| 3 | `local` | `org_authoritative` | **not ready** | `marker_ahead_of_source` | yes | **never expected** under source first (ruling 2; decision record "Reasons") | registry line; Auth reason line | critical at any time (S4': a source lost or reverted after F6) |
| 4 | `organization-service` | `local` | **not ready** | `source_ahead_of_marker` | yes | **the only expected reason inside the disagreement window** (state S2c; ruling 5); expected, **not safe**, and still not ready (ruling 1) | registry line; Auth reason line | inside the disagreement window: expected, checked against the stop conditions; **at any other time critical** (S4 or a restored pre-F6 Auth database, S5a; the reason alone never tells them apart) |
| 5 | `organization-service` | `frozen` | **not ready** | `marker_frozen` | yes | never on the fresh path (ruling 3); in an existing environment, reachable between the freeze and the mirror of ADR-0040 E6 (R1) | registry line; Auth reason line | critical on the fresh path; inside the F6 window it is a stop condition ("any reason other than source ahead"). In an existing environment: not ready (R1), expected only inside that procedure's attended freeze-to-mirror step, to be named in its runbook, and critical otherwise |
| 6 | `organization-service` | `org_authoritative` | **ready** | – | yes | S3 (F6 complete; after F7). S5c (restored pre-F6 Organization database) looks identical | none | none from this check; S5c is seen only by the agreement check |
| 7 | any | **missing** (no row) | **not ready** | `marker_missing` | yes | never | registry line; Auth reason line | critical; **never treated as `local`** (ADR-0063 §4) |
| 8 | any | **invalid** (a value outside the three, or more than one row) | **not ready** | `marker_invalid` | yes | never | registry line; Auth reason line | critical; never treated as `local`. Reachable only if the schema constraints are removed or bypassed; tested with a controlled double (§8.2) |
| 9 | any | **unreadable** (the statement fails: database unreachable, table absent, permission refused, connection lost; or no answer within the timeout) | **not ready** | `marker_unreadable` (a timeout shows as the kit's `error=ReadinessCheckTimeout`) | yes | never | registry line `error=HierarchyAuthorityNotReady code=marker_unreadable` (the database class and SQLSTATE appear on the `database` and `migrations` lines when those checks fail too; they are not added to this check's line); Auth reason line when the statement fails, not on a timeout | critical; never treated as `local`. When the database is down, `database` and `migrations` fail too |

Every source/marker combination of the two sources and the six marker observations (three values, missing, invalid, unreadable) is a
row above or is covered by "any" (rows 7–9). **Evaluation order** (fixed, so the reason is deterministic): read the marker; a failed
read is `marker_unreadable`; zero rows is `marker_missing`; more than one row or an unknown value is `marker_invalid`; then `frozen` is
`marker_frozen` whatever the source (the decision record's reason table: "`frozen` | any"); then a disagreement is reported by its
direction; otherwise ready.

**Basis per row.** Rows 3, 4, 7–9 and the symmetric rule: ADR-0063 §4 and ruling 1. Row 2 and row 5: ruling 3 and the decision
record's reason table. Rows 1 and 6: ADR-0063 §4 (agreement is ready) and the decision record's "Limits shared by every option". The
direction names: ruling 1 ("source ahead of the marker, or marker ahead of the source"). The identifiers are those the decision record
calls illustrative, adopted unchanged, plus three for the fail-closed row it groups together, because ADR-0063 §4 asks for "a
distinct reason". Row 5 follows the Decision's reason table (`frozen` with any source), which governs over the earlier Option B
text that grouped `frozen` with source `organization-service` under "source ahead"; either way it is a stop condition inside the
window.

## 5. Reason identifiers

| Code | Meaning | Expected |
|---|---|---|
| `source_ahead_of_marker` | source `organization-service`, marker `local` | only inside the attended disagreement window |
| `marker_ahead_of_source` | marker `org_authoritative`, source `local` | never (source-first order) |
| `marker_frozen` | marker `frozen`, either source | never on the fresh path; in an existing environment, only inside the attended freeze (R1) |
| `marker_missing` | no marker row | never |
| `marker_invalid` | a marker value outside the three, or more than one row | never |
| `marker_unreadable` | the marker statement failed | never |

The codes are stable identifiers (they match the registry's token rule `[A-Za-z0-9_.-]{1,64}`), carry no value, host or message, and
are never returned in the `/ready` body (§2: the body names checks only).

## 6. TRANSITIONAL behavior and the six rulings

The check implements **no allowance**: it has no transitional mode, no operator flag, no timestamp window and no reading of
organization-service's phase (Options A, C, D, E and the phase-reading alternative are not selected; decision record "Consequences").

| State (decision record §3) | What the check reports | What the operator does |
|---|---|---|
| Normal local operation (S1) | ready (row 1) | nothing |
| Transition preparation, before `ownership activate` | ready (row 1) | the G7/F6 preconditions of the runbook |
| Transition window, after `activate`, before the redeploy (S2a); also an abandoned transition | **ready** (row 1): expected, verifies nothing | relies on the agreement check, which reads the phase; an abandoned transition is TRANSITIONAL inside the window and a MISMATCH outside it |
| Disagreement window, new Auth container with source `organization-service`, marker `local` (S2c) | **not ready, `source_ahead_of_marker`** (row 4) | checks it is the **only** failing check and reason, with the other proposed pre-marker checks (decision record "Attended monitoring"), before running `hierarchy-retire --fresh` |
| After `hierarchy-retire --fresh` (S3) | ready (row 6) | the agreement check must return MATCH to close the transition window |
| Frozen marker | not ready, `marker_frozen` (rows 2, 5), in every environment (R1) | on the fresh path: a stop condition. In an existing environment's attended freeze: expected, interpreted by the attended operator; the check takes no action |
| Organization-authoritative steady state (S3, after F7) | ready (row 6) | nothing |
| Invalid or unavailable marker | not ready, `marker_missing` / `marker_invalid` / `marker_unreadable` | stop; never edit either side to make them agree |

| Ruling (ADR-0063 §4 clarification; decision record) | How this design preserves it |
|---|---|
| 1. Every disagreement is not ready, including inside the attended window, with a direction-specific reason; TRANSITIONAL is a named state, not an exemption | rows 3 and 4 are not ready with `marker_ahead_of_source` / `source_ahead_of_marker`; no code path reports a disagreement as ready; the expected in-window state is identified by its reason only. A ready answer in S2a is documented as verifying nothing |
| 2. Source first: Auth redeployed with the new source and verified before the marker change | row 4's reason is the expected one in the disagreement window; row 3 is never expected; a mutation that swaps the two directions fails the tests (§8.3, M3) |
| 3. `frozen` is not ready on the fresh F6 transition; existing-environment freeze semantics unchanged; their readiness not decided | rows 2 and 5; the check changes no freeze rule, command or trigger. The existing-environment question that ruling 3 left undecided is **ruled by R1** (ADR-0063 §4, item 8): `marker_frozen`, not ready, in every environment |
| 4. `/ready` stays monitoring-only; `/auth/health`, the container healthcheck and the deploy wait unchanged; no routing enforcement | §1, §3, §7; no change to `/auth/health`, `provision-and-deploy.sh`, Compose healthchecks or routing; tests T14–T17 (§8.1) |
| 5. Two attended windows; in-window means expected, not safe | the windows are an operator concept recorded in §4 and §6; the check does not try to detect them and never treats a mismatch as safe |
| 6. The check is not sufficient to detect a wrong-side restore; restore provenance, agreement control and generation/anchor consistency are open | §9 states the boundary; S5a, S5b and S5c behave as rows 4, 1 and 6; no restore detection is designed or implied |
| 7. Source-first safeguards; no new technical write guard | the check writes nothing and adds no guard; the safeguards stay runbook and rehearsal work (§10) |

## 7. Diagnostic and alerting contract

**`/ready` body (unchanged form).** `200 {"status":"ready"}`, or `503 {"status":"unavailable","failed":[…]}` with
`"hierarchy_authority"` among the sorted names. No reason, value, host or message is added to the body.

**Registry line (existing, kit-owned).** On the transition from passing to failing:
`readiness_check_failed check=hierarchy_authority error=HierarchyAuthorityNotReady code=<reason> — /ready answers 503 until it
recovers`; on recovery `readiness_check_recovered check=hierarchy_authority`. Written once per state change, not per probe.

**Auth reason line (new, Auth-owned).** Because the registry logs only when the check's pass/fail state changes, a change of reason
while the check keeps failing (for example `source_ahead_of_marker` to `marker_unreadable`) would otherwise be invisible. The check
therefore logs, **at warn level, only when its reason changes** (including the first failure), one line:
`hierarchy_authority_not_ready reason=<code> source=<local|organization-service> marker=<local|frozen|org_authoritative|missing|invalid|unreadable>`.
It carries only these enumerated tokens. On returning to ready it logs nothing (the registry's recovery line suffices), and the
remembered reason is cleared, so the same reason after a ready result is logged again. A statement that fails only after the
registry's timeout has already answered may log a late `marker_unreadable` line. This is a log
line, **not a metric, endpoint or infrastructure dependency**; its name and its three fields are confirmed by R4, and it must
never carry a credential or a sensitive value (its fields are the enumerated tokens only).

**How an operator reads a disagreement.** `failed` contains `hierarchy_authority` → read the latest `hierarchy_authority_not_ready`
line for the direction → confirm the running source from Auth's start-up line `auth_hierarchy_source source=…` (the server's `.env`
can differ from the running container after a failed redeploy; decision record "Attended monitoring") → run the read-only agreement
check (runbook §6.2) for organization-service's phase → decide from the attended step log whether the state is the expected
disagreement window or a mismatch. **The reason alone never separates S2c from a restored pre-F6 database (S5a).**

**Read-only diagnostics stay available while not ready** (ADR-0063 §4): the check blocks no request, command or CLI; `hierarchy-verify`,
the status output and the agreement queries are unaffected.

**Alerting (R3; no alert is implemented by this check or by its implementation task).** For design and local certification, the
diagnostic visibility is the registry line, the reason line and the attended operator, under the runbook's rule that Auth `/ready`
not ready is **critical** (organization-production §6.3), with the in-window expectation of ruling 5 and the stop conditions of the
decision record. The gauge `nawara_readiness_check_up{check="hierarchy_authority"}` appears automatically through the existing
readiness observer when metrics are enabled; **no alert rule is added** (the local rule file keeps "Readiness has no alert").
**For production (R3):** before the first production deployment of any Auth image containing this check, and for every later Auth
deployment including F6-related redeployments, an explicitly reviewed operational alert mechanism must be implemented and
demonstrated; a separately certified equivalent may satisfy this without completing the whole A12.10 stage; logs and an attended
operator do not by themselves satisfy it. The mechanism's implementation, delivery channel, polling strategy (the gauges change only
when `/ready` is called) and demonstration environment are **open**, for a separate reviewed design (§11, OPEN-3). The runbook
statements that `/ready` "never checks authority" (§6.1) and the Auth not-ready row (§6.3) must be amended **when the check ships**,
by a separately authorized runbook edit (§10).

**What the signal guarantees:** that, at the moment of the probe, the running Auth's configured source and the marker it read agree,
or the named way in which they do not, or that the marker could not be trusted. **What it does not guarantee:** anything about
organization-service's phase; that a ready Auth is not in S2a, an abandoned transition, S5b or S5c; that no unapproved hierarchy write
occurred; that a restore came from the right side of F6; that traffic is withheld from a not-ready Auth.

## 8. Test plan

To be implemented only under the implementation authorization. Real PostgreSQL uses the Auth test database helpers and the local test
infrastructure; doubles are used only where the database cannot reach the state.

### 8.1 Functional tests

| # | Test | Evidence |
|---|---|---|
| T1 | source `local`, marker `local`: `/ready` 200; `nawara_readiness_check_up{check="hierarchy_authority"} 1` when metrics are on | real PostgreSQL |
| T2 | source `local`, marker `frozen` (set by the existing `freeze`): 503, `failed` contains `hierarchy_authority`; registry line with `code=marker_frozen`; one reason line | real PostgreSQL |
| T3 | source `local`, marker `org_authoritative` (set by the existing `retireWrites` in a throwaway database): 503, `marker_ahead_of_source` | real PostgreSQL |
| T4 | source `organization-service` (with test credentials), marker `local`: 503, `source_ahead_of_marker` (the disagreement-window state) | real PostgreSQL |
| T5 | source `organization-service`, marker `frozen`: 503, `marker_frozen` (frozen takes precedence over direction) | real PostgreSQL |
| T6 | source `organization-service`, marker `org_authoritative`: 200 | real PostgreSQL |
| T7 | missing row (`TRUNCATE hierarchy_authority` in a throwaway database), both sources: 503, `marker_missing`; never ready, never treated as `local` | real PostgreSQL |
| T8 | unreadable: (a) the database unreachable, `failed` = `database`, `hierarchy_authority`, `migrations`; (b) the table absent (`0008` pending), `failed` = `hierarchy_authority`, `migrations`; (c) `SELECT` refused to the connecting role (a non-superuser test role; if the suite only has a superuser, a double of the failing statement); each asserts `code=marker_unreadable` on the registry line and `reason=marker_unreadable` on the reason line | real PostgreSQL ((c) possibly a double) |
| T9 | a marker read that does not answer within the timeout (the table locked `ACCESS EXCLUSIVE` by another session): 503 within the timeout; registry line `error=ReadinessCheckTimeout`; the lock released afterwards and the check recovers. Note for the implementation: a blocked read holds a pool connection until the statement timeout on each probe | real PostgreSQL |
| T10 | an invalid value and two rows: 503, `marker_invalid` | **controlled double** of the query (the constraints make both impossible in PostgreSQL) |
| T11 | precedence where two conditions can hold together: two rows whose first is `frozen` → `marker_invalid`; `frozen` with source `organization-service` → `marker_frozen`, not `source_ahead_of_marker` (T5). The other steps of the order are mutually exclusive observations and need no precedence test | double for the two-row case; T5 on PostgreSQL |
| T12 | reason-change logging: a failing check whose reason changes (row 4 → row 9) logs a second reason line; repeated probes in one state log nothing more; recovery logs the registry's recovery line and no reason line; the same reason after a ready result is logged again | real PostgreSQL with a log capture |
| T13 | source-first sequence on one database: source `organization-service`, marker `local` → 503 `source_ahead_of_marker`; `retireWrites` (fresh) → 200; no other reason observed in between | real PostgreSQL |
| T14 | `/auth/health` unchanged: byte-identical `200 {"status":"ok"}` in every state of T1–T9 where the database is reachable, and `503 {"status":"unavailable"}` when it is not (the existing Stage 13.2 assertions, rerun in the new states) | real PostgreSQL |
| T15 | monitoring only: a not-ready Auth (T3, T4) still serves an ordinary route (login or `GET /auth/health`) with its usual answer | real PostgreSQL |
| T16 | no start-up dependency: Auth starts with the database unreachable, `/health` 200, `/ready` 503 naming `hierarchy_authority` among the others. In a reachable-database variant, the check's reader is not invoked before the first `/ready` (a spy on the reader); the only start-up marker statement is the existing `reportSource` one | real process, unreachable database; real PostgreSQL with a spy |
| T17 | no marker mutation: across many `/ready` probes in every state, the `hierarchy_authority` row and the `hierarchy_authority_event` count are unchanged, and the check sends only the one `SELECT` (statement capture) | real PostgreSQL |
| T18 | no body leak: the 503 body is exactly `{status, failed}`; no reason, mode, host or SQL text | real PostgreSQL |
| T19 | A2 golden unchanged: the golden fixture's sha256 (`ea7ab0749d8f4f8b462b49b6b7f2b074a459a46d0b0f230fa164dcde2ed5b394`) and its spec pass; `ensure`, `hierarchy-reference.ts`'s hierarchy code and the A3 suites are unchanged and pass | existing suites |
| T20 | deploy path unchanged: `provision-and-deploy.sh`, the Compose healthcheck and the workflows have no diff; `npm run test:deploy` passes unchanged | static diff and existing tests |

### 8.2 Real PostgreSQL versus controlled doubles

- **Real PostgreSQL:** T1–T9, T12–T18 (every state the schema can reach, including the missing row, the absent table, a refused read
  and a timeout).
- **Controlled doubles:** T10 and the ordering cases of T11 that need an unreachable state (an invalid value, two rows). Each double
  replaces only the query result, never the decision code, and is named in the test title as a double.

### 8.3 Mutation checks (each must make at least one test fail, then be restored and shown byte-identical)

| # | Mutation | Caught by |
|---|---|---|
| M1 | treat `frozen` as `local` (or as agreeing with either source) | T2, T5 |
| M2 | treat a missing row, an invalid value or a failed read as `local` (fail open) | T7, T8, T10 |
| M3 | swap the two direction codes (source-first ordering reversed) | T3, T4, T13 |
| M4 | report `source_ahead_of_marker` as ready (a transitional exemption) | T4, T13 |
| M5 | report `marker_ahead_of_source` as ready | T3 |
| M6 | skip the marker read when the source is `local` | T2, T3 |
| M7 | register the check in, or route it to, `/auth/health` | T14 |
| M8 | invoke the check's reader at start-up, awaited or not | T16 |
| M9 | write anything in the check (an event row, a `SET` of `nawara.reference_write`) | T17 |
| M10 | put the reason in the `/ready` body | T18 |
| M11 | log the reason line on every probe instead of on change | T12 |
| M12 | evaluate direction before `frozen`, or `frozen` before the row-count and validity test | T5, T11 |
| M13 | collapse or mislabel the three fail-closed codes | T7, T8, T10 |
| M14 | make the check reuse `hierarchyMode()` (a missing row becomes a `TypeError`, not `marker_missing`) | T7 |

### 8.4 Existing tests whose expectations the implementation must change (named, bounded)

The new check makes existing readiness assertions list one more failing check. Under the implementation authorization these, and
only these, may change, each only by adding `hierarchy_authority` to the expected `failed` list:

| File | Test | Change |
|---|---|---|
| `apps/auth-service/test/health-readiness.e2e-spec.ts` | "GET /ready fails closed with 503 naming exactly "database" and "migrations" …" | `failed` becomes `['database', 'hierarchy_authority', 'migrations']`; the title is updated to match |
| `apps/auth-service/test/migrations.e2e-spec.ts` | "readiness: /ready reports "migrations" while this release has unapplied migrations …" | with `0008` pending the table is absent, so `failed` becomes `['hierarchy_authority', 'migrations']`; after the runner, ready as before |

The test "GET /ready is 200 … the only registered check is "database"" keeps passing (it asserts the ready body) but its title becomes
inaccurate; renaming it is the only other permitted edit. `metrics.e2e-spec.ts` keeps passing; adding an assertion for the new label
is permitted. Any other existing test that changes is a **stop condition**. The non-CI validation campaigns under
`scripts/validation/` probe Auth's `/ready`, including scenarios without a schema, where `failed` will also name
`hierarchy_authority`; they assert no exact list and are not changed.

### 8.5 Repository and CI evidence

`check:repo` (A5.4-T1 and the O2 producer-scope check unchanged and passing), `test:repo`, Auth lint, typecheck, unit and e2e, the
cross-service suites (`test:e2e:auth-organization`, `test:e2e:audit-producers`), `test:deploy`, full Core CI on the pull request. No
`libs/` change, so the shared-library rule does not apply; if one became necessary it is a stop condition.

## 9. Boundaries and non-goals

The check, and the implementation that adds it, must not:

- change request routing, add a gateway health check or gate traffic on readiness (ruling 4);
- change `/auth/health`, the container healthcheck or the deploy wait in `provision-and-deploy.sh` (ruling 4);
- add a start-up database dependency (ADR-0063 §4);
- mutate the marker, write an event, set `nawara.reference_write`, or change migration `0008`, its triggers or any schema;
- run or automate any F6 or F7 step, `ownership activate`, `hierarchy-retire`, `hierarchy-freeze` or `-unfreeze`;
- activate organization-service authority or change `AUTH_HIERARCHY_SOURCE` anywhere;
- change `ensure()`, the A2 resolve/place split, the A3 repair route, or `bootstrap-owner`;
- change the `hierarchy_source_mismatch` start-up warning or its wording (see OPEN-2);
- implement wrong-side restore detection, restore provenance, an independent agreement control or generation/anchor checks
  (ruling 6: open, separately governed);
- change `libs/service-kit`, `libs/audit-contract`, workflows, deploy scripts, the G6 plan or the active runbooks.

**Restore drill.** The drill passes only when the restored Auth answers ready. With the check, a restored source/marker
disagreement or a missing marker fails the drill's ready step, which is the wanted outcome. **R2:** a backup taken
during an existing environment's freeze (`frozen`, which the drill accepts as a backed-up state today) remains a valid backup state,
and its expected `marker_frozen` readiness result must not be treated as backup corruption. As the drill stands it would fail its
ready step for such a backup once the check is in the drilled image; the compatibility change to the drill is a **separately
authorized, tested and reviewed task, required before any affected rehearsal** (§10). The drill script and the backup runbook are
not changed here. A pre-F6 backup drilled after F6 keeps its own configuration (S5b) and still answers ready: the drill does not detect a
wrong-side backup (decision record §3).

## 10. G6 integration and the authorizations that follow

**Why the check must be in the rehearsed Auth image.** ADR-0063 §4 requires the F6 sequencing with the check to be "verified in the G6
rehearsal before the check ships", and A5.4-G1 item 4 certifies it "in G6 with the approved digest and configuration". The decision
record's G6 cases 1 (the source-first sequence through F7 with MATCH), 4 (an interrupted transition and an Auth restart inside the
disagreement window) and the readiness part of 3 (a failed redeploy and one retry) need it in the image.

**Certified digest-set policy** (A5.4-G1 item 3; ADR-0063 §11 clarification; [D2](core-v2-a5-4-operational-runbooks.md) §2.5): G6
selects and rehearses one exact digest each for auth-service, organization-service and audit-service; F6 and F7 use only that set,
including the configuration-only Auth mirror redeploy; any change of a digest or of its relevant configuration needs a separately
authorized re-rehearsal. Therefore the implementation must be **merged before the G6 baseline refresh** selects the Auth digest;
merged after that selection, the set changes and a separately authorized re-rehearsal is required. The selected Auth revision must contain A2 (`d5a8cbb`), A3 (`fcf5806`) and this check.

**Sequence of separate authorizations (none given by this document).** Items 9 and 10 are preconditions placed by their own
"before" clause, not by their number; item 9 precedes item 8 if the G6 rehearsal drills a backup taken under a freeze.

1. this design and test plan (GREEN documentation; the present authorization; its commit and PR are separate);
2. **RED-exception development authorization** for A5.4-A5 under A5.4-G1 item 4, naming the files, the permitted test changes of
   §8.4 and the stop conditions;
3. the commit and pull-request authorization;
4. before the merge, recorded evidence that the change alters no behavior of the **last documented deployed Auth state** other than
   adding the check (source and marker `local`/`local` → ready; A3 design §11.9 records the baseline `97f78cb` and that the live source
   and marker are unverified), and the image-pinning condition of A5.4-G1 item 4, presented **before** the merge;
5. an **explicit, recorded RED-exception merge approval** in the pull request;
6. separately authorized documentation: the amended runbook statements (organization-production §6.1, §6.3) to apply when the check
   ships, and the refreshed G6 plan (the source-first mirror order, the decision record's seven G6 cases, and the §8.1 demonstrations:
   the induced freeze now also shows `marker_frozen` and the induced source mismatch `source_ahead_of_marker` on Auth's `/ready`);
7. inclusion of an Auth digest containing the check in the certified digest set at the G6 refresh;
8. the G6 rehearsal certifying the readiness sequence;
9. **before any affected rehearsal (R2):** the separately authorized, tested and reviewed restore-drill compatibility change, so
   that a drill of a backup taken under a freeze is not failed as corrupt by an expected `marker_frozen`;
10. **before the first production deployment of any Auth image containing the check, and for every later one (R3):** the separately
    designed and reviewed operational alert mechanism, implemented and demonstrated (or a separately certified equivalent);
11. a separately authorized production deployment of the certified digest. The check has no gate or flag, so its runtime effect starts
    when the image runs; the deployment authorization must therefore state explicitly that it also covers that effect (ADR-0063 §11
    clarification: developing, merging, deploying and activating are four separate authorization events). This document does not
    decide that.

**Expected production effect when deployed (inferred, not verified):** production is recorded as source `local` with marker `local`
(A3 design §2, §11.9), so the check would answer ready; the live source, marker and image are **unverified** today and are to be
confirmed by a separately authorized read-only inspection before any deployment.

## 11. Open decisions and limitations

| # | Item | Status | Blocks |
|---|---|---|---|
| OPEN-1 | **Readiness during an existing environment's freeze** (marker `frozen`, either source). Auth has no environment class, so one rule applies to every environment | **RULED 2026-10-10 (R1):** not ready, `marker_frozen`, in fresh and existing environments (ADR-0063 §4, item 8) | no longer blocks. Follow-ups, each separately authorized: the restore-drill compatibility change (R2; OPEN-8); an existing-environment runbook naming `marker_frozen` as expected inside its attended freeze; the G6 plan's induced-freeze demonstration (OPEN-6) |
| OPEN-2 | the start-up warning `hierarchy_source_mismatch` says first touches "fail closed until configuration and marker agree", which overstates the code (decision record "Still open"). Correcting its prose is not in A5.4-G1 item 4's file scope; this design leaves it unchanged | owner decision | nothing in this check |
| OPEN-3 | what carries an alert in production while no alerting stack is deployed | **policy RULED 2026-10-10 (R3):** a reviewed operational alert mechanism, implemented and demonstrated, before the first production deployment of any Auth image containing the check and for later ones; the attended operator and logs alone do not satisfy it. **Still open:** the mechanism's implementation, delivery channel, polling strategy and demonstration environment (a separate reviewed design) | every production deployment of an Auth image containing the check; not the local implementation or its merge |
| OPEN-4 | wrong-side restore detection: restore provenance, an independent agreement control, generation or anchor consistency | open (ruling 6) | nothing in this check; any claim of restore detection |
| OPEN-5 | the transition window's hard duration limit | set from G6 measurements | the refreshed G6 plan and runbook |
| OPEN-6 | the updates to the G6 plan and the active runbooks, and their certification | separately authorized | F6 in source-first order; shipping the check |
| OPEN-7 | post-one-way-door reconciliation; any later routing use of readiness | not designed / separately governed | out of scope |
| OPEN-8 | the restore-drill compatibility change for a backup taken under a freeze (R2): how the drill recognizes an expected `marker_frozen` without weakening its ready check for other states | not designed; separately authorized, tested and reviewed | any rehearsal that drills a frozen backup with the check in the drilled image |

**Limitations stated once:** the check sees two values; it reports ready in S2a, S5b, S5c and an abandoned transition; it runs only
when `/ready` is called; it does not distinguish S2c from S5a; a not-ready Auth keeps serving; a marker read that times out is
reported by the registry's `ReadinessCheckTimeout` class, without a reason code or a reason line.

## 12. A3 governance findings (unchanged by this document)

A3 was merged through PR #287 (`fcf5806`), **not deployed and not activated**. The RED-exception merge approval (A5 record §9.3 A.2
item 5) remains **NOT VERIFIED**; the O1 pre-merge timing remains **unmet** (A3 design §11.8, §11.9). The last documented Auth
deployment is `97f78cb` (2026-10-02, `sha256:26164d42…5eaf`), not `9e29c76`; the live production source, marker and image are
**unverified**. G6 is deferred and no certified digest set is selected. This document neither resolves nor amends any of these.

## 13. What this document does not do

It implements nothing, writes no test, changes no ADR, runbook, plan, schema, workflow, script or library, selects no digest,
deploys nothing and authorizes no task. Its identifiers (the check name, the six reason codes, the reason log line) take effect only
through a separately authorized implementation.
