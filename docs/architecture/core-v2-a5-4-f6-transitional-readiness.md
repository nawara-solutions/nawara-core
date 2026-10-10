# Core V2 A5.4-D2: Auth readiness during the F6 transition (decision record)

- **Status:** **DECIDED IN PRINCIPLE (2026-10-10)** by the architecture owner: see **Decision** below, recorded as a dated
  clarification on ADR-0063 §4. Sections 1 to 7 are the comparison as it was written while the question was open (on `main` at
  `9ca1c8f`); they are kept unchanged as the record of the alternatives, and where they say open, not selected or not decided for a
  ruled item, the Decision governs. Documentation only; **not an ADR**; it authorizes nothing: **A5.4-A5 stays a design-approved
  exception with no implementation authorized.**
- **The question.** [ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md) §4 makes any disagreement between
  Auth's configured hierarchy source and its authority marker **not ready**, "other than the explicit TRANSITIONAL state", and leaves
  the exact TRANSITIONAL implementation unresolved (§12). A5.4-G1 requires it to be specified before any transition-dependent behavior
  is implemented or the check's merge is approved, and certified in the G6 rehearsal.
- **Authority.** Where this record and an Accepted ADR or the A5.4-G1 governance differ, they govern.
- **Companion:** [A5.4-D2 operational runbook drafts](core-v2-a5-4-operational-runbooks.md).

## Decision (2026-10-10, architecture-owner rulings in principle)

These are design rulings. **They authorize no implementation, merge, deployment or activation.** The certified
[G6 plan](stage-21/stage-21-x-g6-rehearsal-plan.md) and the active [F6/F7 runbook](../runbooks/organization-production.md) are
**unchanged, and F6 cannot be executed in the source-first order until both are separately updated and certified**. Deployment
health, traffic routing, the authority commands and every production configuration are unchanged.

| # | Ruling |
|---|---|
| 1 | **Option B** (§4): a source/marker disagreement is **not ready**, with a direction-specific diagnostic reason. This holds inside the attended F6 window too |
| 2 | **Source first:** after `ownership activate`, the Auth deployment with `AUTH_HIERARCHY_SOURCE=organization-service` is verified **before** the irreversible marker change (`hierarchy-retire --fresh`) |
| 3 | On the fresh F6 transition a **`frozen` marker is not ready**. The freeze semantics of an existing environment and the documented recovery rules are not changed |
| 4 | **`/ready` stays monitoring-only**, usable for attended post-transition verification. `/auth/health` stays database-only; the container healthcheck and the deploy wait are unchanged; **no routing enforcement** |
| 5 | A mismatch inside an authorized F6 window is **expected operationally and still not ready**. It is never treated as automatically safe |
| 6 | The readiness check is **not sufficient** to detect a wrong-side restore. Restore provenance, an independent authority agreement and generation or anchor consistency need separately governed designs and controls: **OPEN, not implemented** |

### The window under source first (state S2c of §3)

- **Opens** when the redeployed Auth container starts with the new source: marker `local`, source `organization-service`,
  organization-service `ACTIVE`.
- **Closes** when `hierarchy-retire --fresh` has committed, `/ready` answers ready and the authority agreement
  (runbook §6.2) is MATCH. This assumes the marker command stays inside F6, as the runbook and the plan have it; that placement
  is listed as open below.
- **Before it** (after `ownership activate`, before the redeploy: S2a) Auth answers **ready**. That answer is expected and
  verifies nothing about the mirror.
- **Inside it** Auth reports not ready with the reason "source ahead of the marker". It keeps serving, because `/ready` routes
  nothing. The readiness signal protects nothing by itself.
- **The trade-off of source first.** While the marker is `local`, **the database write guard permits hierarchy writes**
  (migration `0008`). Marker first would close that guard at once; source first leaves it open until the marker command. Inside
  the window the only barriers are the code and the attended rule: with the source `organization-service` the owner tool refuses
  a local Company insert, no HTTP path writes hierarchy rows, and `ensure` places validated references only
  (`apps/auth-service/src/cli/owner-tools.ts`, `src/hierarchy/hierarchy-reference.ts`). In exchange, a failed redeploy leaves no
  standing mismatch under an irreversible marker. **The window is expected, not safe.**
- **The same two values are the signature of a restored pre-F6 Auth database (S5a).** Inside the window the operator separates the
  two by the attended step log and the agreement check, never by the reason alone.

### Reasons (semantics decided; identifiers illustrative, fixed in the A5.4-A5 design document)

| Reason | Marker | Source | Inside the attended window | At any other time |
|---|---|---|---|---|
| source ahead of the marker (*illustrative:* `source_ahead_of_marker`) | `local` | `organization-service` | the **only** expected reason | critical |
| marker ahead of the source (*illustrative:* `marker_ahead_of_source`) | `org_authoritative` | `local` | **never expected** on this order | critical |
| marker frozen (*illustrative:* `marker_frozen`) | `frozen` | any | never expected on the fresh path | critical on the fresh path |
| marker missing, invalid or unreadable | – | any | never expected | critical; never treated as `local` |

### Attended monitoring, stop conditions and escalation (design only; not an approved or executable procedure)

The runbook text is a later, separately authorized edit, certified in G6. The items below are proposed checks.

- **Monitoring.** The named operator of the F6 step watches, at each sub-step: both services' `/ready`, the reason reported, the
  authority agreement, the event rows and the Auth log signals (runbook §6.1 to §6.3).
- **Inside the window** no Auth CLI or operator command that writes hierarchy rows is run, other than the marker command itself.
- **Proposed checks before the marker change, at least:** the new Auth container is running and healthy on the certified digest; its start-up line
  shows the source `organization-service` with a configured credential; `/ready` fails on this check only, with the source-ahead
  reason; the agreement shows `ACTIVE`, `local`, `organization-service`. If any of these is missing, the marker change is not run.
- **Stop conditions:**
  - any reason other than "source ahead" inside the window;
  - "source ahead" before `ownership activate`, or after the window has closed;
  - a failed Auth redeploy. The deploy restores the previous container, so no mismatch is shown and Auth looks consistent while
    organization-service is `ACTIVE`: **the step is incomplete and the marker change is not run**. A retry of the redeploy is
    the one continuation the owner may allow, and only if the authorization of the F6 step expressly covers it; otherwise stop
    and escalate;
  - any other readiness check failing, an anchor mismatch, or a rejected or failed authority event;
  - a window that stays open beyond the bound the runbook sets. **The bound is not decided here.**
- **Escalation.** Stop; run no further ownership or mirror command; keep the evidence; never edit either side to make them agree;
  escalate to the owner. After `ownership activate` there is no rollback (ADR-0040 A2.6): the step is completed forward or
  escalated.

### Consequences for the comparison below

- §4 and §5 were written for the marker-first order. Under source first the window is S2c, a failed mirror redeploy leaves no
  standing disagreement, and Option B's "source ahead" is the expected reason inside the window.
- Options A, C1, C2, D and E and the phase-reading alternative are **not selected**.
- The G6 plan's monitoring demonstrations (§8.1: an induced source mismatch and an induced freeze) would also change Auth's `/ready`
  once the check is in the rehearsed image. The plan is unchanged; this is input to its refresh.

### Still open after this decision

- The check's name and the reason identifiers (the A5.4-A5 design document); the bound on the window; whether the F6
  authorization covers a redeploy retry.
- A note for the A5.4-A5 design: Auth's start-up warning says first touches "fail closed until configuration and marker agree"
  (`hierarchy-reference.ts`), which is not what happens with a `local` marker and the new source, where `ensure` works. No code
  is changed here.
- The check's behavior during the freeze of an **existing** environment. Auth does not know its environment class, so one rule in
  code would also report not ready there; whether that is wanted is not decided. Production is a fresh environment.
- Wrong-side restore detection: restore provenance, the independent agreement control and generation or anchor consistency.
- What carries an alert in production while no alerting stack is deployed; today the signal is the attended operator.
- The updates to the G6 plan and the active runbooks, and their certification; whether the marker command stays inside F6 as the
  runbook and the plan have it (ADR-0040 A2.5 words F7 as "Retire").
- Any later routing use of readiness: a separately governed infrastructure task.

## 1. What is fixed (not reopened here)

| Fixed by | Rule |
|---|---|
| ADR-0063 §4 | once the marker is `org_authoritative`, a source other than `organization-service` is not ready, named in the `readiness_check_failed check=<name>` form, with an operational alert; the rule is symmetric; a missing, invalid or unreadable marker is not ready and is never treated as `local`; no fallback to local authority; startup does not depend on the database (readiness does); read-only status and diagnostics stay available while not ready, where safe |
| ADR-0063 §4, acceptance item 3 | the attended F6 TRANSITIONAL state is defined explicitly, so that the mirror completes; the sequencing is verified in the G6 rehearsal before the check ships |
| A5.4-G1 item 4 (the kit-registry wording is from its preserved proposal text) | Auth only; one check in the kit's readiness registry (`/ready`); read-only marker access; `/auth/health` unchanged, database-only and outside the deploy health path; no marker, trigger, CLI, `ensure`, migration or deployment-script change |
| ADR-0040 A2.6 | in a fresh environment there is no ownership rollback after `activate` |

## 2. Facts the options rest on (read on `main` at `9ca1c8f`)

- **Two switches.** The configuration `AUTH_HIERARCHY_SOURCE` (`local` when unset, or `organization-service`;
  `apps/auth-service/src/config/app-config.ts`) is read at start, so it changes only by a redeploy. The marker
  `hierarchy_authority.mode` (`local`, `frozen`, `org_authoritative`) is a database row that also records `retired_at`, `retired_by` and
  `activation_evidence` (migration `0008`); `hierarchy-retire --fresh` moves it to `org_authoritative`, once
  (`src/hierarchy/hierarchy-authority.ts`).
- **Today a disagreement is only logged** at start (`hierarchy_source_mismatch`, `src/hierarchy/hierarchy-reference.ts`).
- **The F6 mirror.** `ownership activate` in organization-service comes first; the mirror is Auth's marker
  (`hierarchy-retire --fresh`) and `AUTH_HIERARCHY_SOURCE=organization-service` with an Auth redeploy. **The certified documents do
  not fix the order of those two.** ADR-0063 §4 and the [G6 plan](stage-21/stage-21-x-g6-rehearsal-plan.md) §9.1 list the marker
  first; the [runbook](../runbooks/organization-production.md) §3 F6 row lists the source first, its §6.2 prose lists the marker first, and its §6.2 TRANSITIONAL row accepts
  either marker with either source while the phase is `ACTIVE`. This record calls the two orders **marker first** and **source
  first**. The Auth deploy never writes the source; the operator sets it on the server
  (`apps/auth-service/deploy/provision-and-deploy.sh`).
- **A failed Auth redeploy restores the previous container** with its previous environment (`provision-and-deploy.sh`): on the
  marker-first order, a failed mirror redeploy leaves a running Auth with the new marker and the old source until it is retried.
- **What consumes Auth's `/ready` today.** The container healthcheck and the deploy wait use `/auth/health`
  (`provision-and-deploy.sh`); the router has no health check. `/ready` is read by the attended operator (runbook §6.1), by the Auth
  restore drill, which passes only when the restored service answers ready (`infra/backup/restore-drill.sh`), and by the readiness
  gauges, which have no alert rule (`infra/observability/prometheus/rules/nawara-core.rules.yml`). **A not-ready Auth therefore keeps
  serving traffic today:** the readiness outcome is a signal to the operator and to the drill, not a traffic control.
- **The check sees two values only.** It reads the marker and the source; it does not read organization-service's phase (A5.4-G1).
- **Under the certified digest-set policy** the F6 Auth redeploy runs through `auth-service-deploy.yml` with the certified digest and
  waits for the `production` approval, so the window between the marker change and the new container includes an approval step.

## 3. The states to distinguish

`P` is organization-service's phase, which the Auth check cannot see.

| # | State | Marker | Source | `P` | What it is |
|---|---|---|---|---|---|
| S1 | normal pre-F6 local authority | `local` | `local` | `PREPARED`, `VERIFIED`, `ACTIVATABLE` | production today |
| S2a | F6 TRANSITIONAL, first part | `local` | `local` | `ACTIVE` | after `activate`, before `hierarchy-retire --fresh` |
| S2b | F6 TRANSITIONAL, marker first | `org_authoritative` | `local` | `ACTIVE` | after the marker change, while the old container runs, until the redeploy with the new source (also after a failed redeploy) |
| S2c | F6 TRANSITIONAL, source first | `local` | `organization-service` | `ACTIVE` | after a redeploy with the new source, before the marker change; valid under runbook §6.2 |
| S3 | steady-state Organization authority | `org_authoritative` | `organization-service` | `ACTIVE`, `RETIRED` | F6 complete; after F7 |
| S4 | invalid disagreement, source ahead | `local` or `frozen` | `organization-service` | any | a premature configuration change, or S5a; **with a `local` marker, indistinguishable from S2c by these two values** |
| S4' | invalid disagreement, marker ahead | `org_authoritative` | `local` | any | the source was lost or reverted after F6; **indistinguishable from S2b by these two values** |
| S4'' | marker missing, invalid or unreadable | – | any | any | fail closed (ADR-0063 §4) |
| S5a | restored pre-F6 Auth **database** with the current configuration | `local` | `organization-service` | `ACTIVE`, `RETIRED` | the case ADR-0063 §4 names; it occurs in a production restore, not in a drill (below) |
| S5b | restored pre-F6 Auth database **and** configuration | `local` | `local` | `ACTIVE`, `RETIRED` | **indistinguishable from S1 and S2a by these two values** |
| S5c | restored pre-F6 Organization database, Auth untouched | `org_authoritative` | `organization-service` | `PREPARED`, `VERIFIED`, `ACTIVATABLE` | **indistinguishable from S3 by these two values** |

**Limits shared by every option within the approved scope.** S2a, S5b and S5c look consistent to the check, so it reports ready
while the system is transitional or wrong. Only the authority agreement check, which also reads organization-service's phase
(runbook §6.2), detects them. The readiness check is one signal and never replaces that agreement check.

**The restore drill and the check.** The drill boots the restored service with the backed-up configuration, keeping its
`AUTH_HIERARCHY_SOURCE`, and compares the marker only with the state recorded in the same backup (`infra/backup/restore-drill.sh`).
A pre-F6 Auth backup drilled after F6 is therefore `local` with `local` (S5b) and answers ready under every option: the drill does
not detect a backup from the wrong side of F6 without a new comparison. S5a arises only when a database is restored under the
current production configuration.

**The options below are written for the marker-first order.** On the source-first order the window is S2c, the directions of
Options B and C are reversed, and S2c carries the same two values as a restored pre-F6 database (S5a). Fixing the order is part of
the decision.

`frozen` with a `local` source is the freeze step of an existing environment (ADR-0040 E2). The preserved A5.4-G1 proposal text lists
`frozen` as not ready; the accepted items do not mention it. Production is a fresh environment and never freezes, but the G6 plan
induces a freeze for a monitoring demonstration (§8.1). **OPEN detail**, whichever option is chosen.

## 4. Options

### Option A: no allowance in code; the window is not ready and the runbook defines it

- **Observable state:** S2b is reported as a source/marker disagreement, like S4'.
- **Readiness outcome:** S1 and S3 ready; S2a ready (not seen); S2b, S4, S4', S4'', S5a not ready.
- **Alert behavior:** the alert fires during S2b. The runbook defines the attended window (from `hierarchy-retire --fresh` to the
  redeployed container answering ready) in which this one named reason is expected, and treats it as critical at any other time.
- **Recovery implications:** none added. A backup taken inside S2b fails the restore drill's ready step, which is the wanted outcome.
  A failed mirror redeploy leaves S2b standing and the alert firing until the redeploy is retried.
- **Rehearsal requirements:** the G6 mirror is run in the order the owner fixes (§2); the not-ready reason is observed between the two
  commands and clears after the redeploy; the deploy completes although `/ready` fails, because its wait uses `/auth/health`.
- **False ready:** none beyond the shared limits. **False not ready:** the F6 window itself, by design; an operator who has not read
  the amended rule may stop a correct F6.
- **Point for the owner:** ADR-0063 §4 says the state is "defined explicitly in the implementation"; acceptance item 3 says "in the
  future runbook". Whether a runbook definition with a named reason satisfies §4 is the owner's reading.

### Option B: no allowance, with direction-specific reasons

- **Observable state:** two distinct reasons: marker ahead of source (`org_authoritative` with `local`: S2b, S4') and source ahead of
  marker (`local` or `frozen` with `organization-service`: S4, S5a).
- **Readiness outcome:** as Option A.
- **Alert behavior:** as Option A, with the direction named. On the marker-first order "marker ahead" is the only reason expected
  inside F6, and "source ahead" is the signature of a restored pre-F6 Auth database. This holds only if the order is fixed as marker
  first, which the runbook does not do today (§2).
- **Recovery implications:** after a production restore, the reason tells the operator which side is stale without reading either
  database. It says nothing in a drill (§3). A failed mirror redeploy is as in Option A.
- **Rehearsal requirements:** as Option A, plus one induced "source ahead" state. The G6 plan already induces it for the
  `hierarchy_source_mismatch` signal (§8.1).
- **False ready:** none beyond the shared limits. **False not ready:** as Option A. It relies on the mirror order being fixed as
  marker first; on the source-first order the F6 window shows the restore signature.

### Option C: a self-expiring transitional state derived from the marker's own timestamp

- **Observable state:** "marker ahead" within a fixed interval of the marker's `retired_at` is reported as TRANSITIONAL; after the
  interval it is a disagreement. The check still reads only the marker row and the source. No operator switch exists.
- **Readiness outcome:** a sub-choice the owner would make: **C1** TRANSITIONAL is ready with a warning, or **C2** TRANSITIONAL is not
  ready with its own reason (then it differs from Option B only by naming the window and by escalating when it expires).
- **Alert behavior:** inside the interval a warning (C1) or a named, expected reason (C2); after it, critical, without anyone having
  to remember to close a window.
- **Recovery implications:** a backup taken inside the window and restored later is past the interval, so it is reported as a
  disagreement. Under C1 the restore drill would accept a backup taken and drilled inside the interval. A failed mirror redeploy
  that is not retried within the interval becomes a critical disagreement.
- **Rehearsal requirements:** the mirror inside the interval; the expiry (a redeploy delayed past it); the interval measured against
  the real approval and redeploy time of the certified procedure.
- **False ready:** under C1, S4' occurring within the interval after `retired_at` (a source lost right after F6). None added under C2.
  **False not ready:** an F6 redeploy slower than the interval. The interval length is a new parameter to decide, and the outcome
  depends on the database clock.

### Option D: an operator-declared transitional window

- **Observable state:** an explicit, operator-set configuration value declares the window; while it is set, the transitional
  combination is accepted.
- **Readiness outcome:** ready (or ready with a warning) in S2b while declared; otherwise as Option A.
- **Alert behavior:** quiet during the declared window; a separate signal is needed for "the window is still declared".
- **Recovery implications:** if the declaration is not limited to the "marker ahead" direction, a restored pre-F6 marker (S5a) is
  accepted while it is set. The declaration is part of the backed-up configuration, so a restored configuration can bring it back.
  A failed mirror redeploy restores the previous container, which still carries the declaration.
- **Rehearsal requirements:** setting and removing the declaration; a forgotten declaration; a restore while it is set.
- **False ready:** S4' and, if not direction-limited, S5a, for as long as the declaration stays set. **False not ready:** F6 run
  without the declaration.
- **Procedure impact:** configuration is read at start, so declaring the window needs one added Auth start before the marker
  change; removing it can be part of the mirror's own redeploy, assuming the declaration is a configuration value. This adds a step
  to the F6 mirror, which then has to be rehearsed in its new form. The preserved A5.4-G1 proposal text names "an explicit,
  operator-set transitional window" only as an example.

### Option E: no observed window (Auth stopped across the mirror)

- **Observable state:** Auth is stopped before the marker change and started with the new source, so on the successful path no
  running container holds S2b.
- **Readiness outcome:** S2b does not answer on the successful path; S1 and S3 ready; every disagreement not ready with no exception.
- **Alert behavior:** no transitional rule is needed; an Auth outage is observed instead.
- **Recovery implications:** a failed redeploy restores and starts the previous container with the old source, which is S2b,
  reported as a disagreement until the redeploy is retried.
- **Rehearsal requirements:** the changed sequence, the measured outage and a failed redeploy.
- **False ready and false not ready:** none added.
- **Procedure impact:** authentication is unavailable for the window, which includes a `production` approval. It **changes the
  certified F6 procedure**, so it needs its own approval and a rehearsal of the new sequence.

### Outside the approved scope: reading organization-service's phase

It would let the check detect S5c (a phase before `ACTIVE` under an `org_authoritative` marker), and S4' and S5b once the phase is
`RETIRED`. It would not separate S2b from a source lost between F6 and F7, nor S5b from S2a, because the phase is `ACTIVE` in each.
It is listed for completeness only. A5.4-G1 limits the
check to the marker and the source, and reading the phase would make Auth's readiness depend on organization-service, against
ADR-0063 §10 ("Organization Service unavailable: … authentication unaffected") and the narrowed dependency of §5. Choosing it needs a
governance amendment, not only this decision.

## 5. Comparison

| | A | B | C1 | C2 | D | E |
|---|---|---|---|---|---|---|
| S2b during attended F6 | not ready | not ready, "marker ahead" | ready, warning | not ready, "transitional" | ready while declared | no answer (stopped) |
| S2c, the window on the source-first order | not ready | not ready, "source ahead" | not ready | not ready | ready only if declared for that direction | no answer (stopped) |
| S4' long after F6 | not ready | not ready | not ready | not ready | **ready if still declared** | not ready |
| S5a restored pre-F6 Auth database | not ready | not ready, "source ahead" | not ready | not ready | not ready if direction-limited | not ready |
| S2a, S5b, S5c | ready (not seen) | ready (not seen) | ready (not seen) | ready (not seen) | ready (not seen) | ready (not seen) |
| new parameter or switch | none | none | an interval | an interval | a declaration | none |
| change to the F6 mirror steps | none | none | none | none | one added start | Auth stopped and started |
| runbook rule needed for the window | yes | yes | a note for the warning | yes | yes (set and remove) | no |
| needs the mirror order fixed | no (its runbook window follows whichever order is fixed) | yes | yes | yes | if direction-limited | yes (it defines one) |

## 6. What every option needs before A5.4-A5 can be authorized

- An owner selection among the options (or another one), with the mirror order (§2) and the `frozen` detail of §3.
- The exact check name and reason codes, in the task's design document.
- The amended alert rule for Auth not ready and the amended statement that `/ready` never checks authority (runbook §6.1, §6.3),
  written with the check and applied when it ships.
- The G6 plan's monitoring demonstrations reviewed: the induced `hierarchy_source_mismatch` (source ahead, before F6) and the induced
  freeze (plan §8.1) would also change Auth's `/ready` once the check is in the rehearsed image.
- The check inside the certified digest set, certified in G6 with the approved configuration.

## 7. Not decided here

*Superseded in part by the Decision above (2026-10-10): the option, the mirror order, the `frozen` behavior on the fresh path and
the monitoring-only use of `/ready` are ruled. Original text:* Which option; the mirror order; the `frozen` behavior; the interval of Option C; whether Auth's readiness should later gate traffic; whether a check
of organization-service's phase is wanted. No implementation, merge, deployment or activation is authorized by this record.
