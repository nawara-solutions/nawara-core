# Core V2 A5.4-D2: operational runbook drafts and readiness specifications

- **Status:** DRAFT (2026-10-10), on `main` at `9ca1c8f` (the PR #268 merge). Documentation only: a **GREEN** task under the Accepted
  A5.4-G1 governance ([A5 record](core-v2-a5-organization.md) §9.1). It is **not an ADR and not an active runbook**.
- **Authority.** Where this document differs from an Accepted ADR, the A5.4-G1 governance or a certified procedure, **they govern**.
  The active runbooks under `docs/runbooks/` and the certified [G6 plan](stage-21/stage-21-x-g6-rehearsal-plan.md) are **not edited**
  by this task; each proposed change to one of them is listed here and needs its own authorization.
- **It executes and authorizes nothing.** No command here was run. No digest is selected, no G6, G7, F6 or F7 step is started, and no
  later task is authorized by being described. A draft procedure becomes usable only when its implementation exists, its open
  decisions are closed and the owner approves the runbook that carries it.
- **Sources:** [ADR-0040](../adr/0040-organization-ownership-migration-decisions.md),
  [ADR-0042](../adr/0042-service-token-scopes-and-administrative-authorization.md),
  [ADR-0059](../adr/0059-company-ownership-transfer-and-exceptional-owner-recovery.md),
  [ADR-0060](../adr/0060-company-platform-organization-lifecycle.md),
  [ADR-0061](../adr/0061-auth-hierarchy-reference-repair-and-diagnostics.md),
  [ADR-0062](../adr/0062-initial-hierarchy-provisioning-and-first-platform-sequencing.md),
  [ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md), the
  [A5.4-D1 specification](core-v2-a5-4-implementation-specifications.md), the
  [cutover record](stage-21/stage-21-x-cutover-record.md), and the runbooks
  [organization-production](../runbooks/organization-production.md), [core-backup-restore](../runbooks/core-backup-restore.md) and
  [digest-deployments](../runbooks/digest-deployments.md).
- **Companion:** [Auth readiness during the F6 transition](core-v2-a5-4-f6-transitional-readiness.md) (an OPEN decision record).

## 1. Labels and action classes

Statements carry the D1 labels: **ALREADY IMPLEMENTED**, **ACCEPTED DESIGN — NOT IMPLEMENTED**, **OPEN DECISION**, **GATED**.

Every future action carries one class. A class describes what an action needs; it grants nothing.

| Class | Meaning |
|---|---|
| **DOC** | documentation only; a GREEN task under its own authorization (editing an active runbook or the G6 plan is its own task) |
| **IMPL** | separately authorized implementation, under its A5.4-G1 class (YELLOW or RED) |
| **DEPLOY** | separately authorized deployment of an exact digest, with the `production` approval |
| **ACTIVATE** | separately authorized activation: a gate, a flag, a configuration value or a production step turns behavior on |
| **OPEN** | blocked by an open architecture-owner decision; nothing proceeds until it is decided |
| **OPS** | a descriptive label only, for a separately authorized operational action that is none of the above: a read-only production check, a backup, a backup inspection, a restore drill, a restoration or a rehearsal step |

**OPS is not a governance class.** It does not redefine or extend GREEN, YELLOW and RED, and it is not an accepted
implementation-risk class; it only names actions that the other five labels do not describe.

- Read-only production verification still requires its own appropriate authorization.
- Backup inspection, rehearsal, restoration and recovery each require their own appropriate, separate authorization.
- OPS authorizes no production access and no execution.
- A high-risk operation labelled OPS keeps every applicable RED restriction and every certified gate restriction (G6, G7, F6, F7,
  the `production` environment approval, the runbooks' own rules).

The production order is unchanged (V2-A record §2; G6 plan §12): G6 baseline refresh → G6 → pre-G7 backup, verified, then the
backup schedule → G7 → F6 → F7 → post-F7 backup, verified → other callers opened. G6 is deferred; G7, F6
and F7 are locked. Final Core Validation is the absolute last validation and is part of no task here.

## 2. A. G6 rehearsal preparation

The certified plan stays the authority for the rehearsal: its decisions D-1 to D-17, its definition of production-like (§4), its
isolation rules (§6), its steps (§9), its evidence (§10) and its PASS, FAIL and STOP rules (§13). This section restates what a
preparation must establish and lists what has changed since the plan was approved. **G6-A is certified and is not rerun**; what
follows describes the baseline refresh that the production track requires before G6-B, which is a separate, owner-authorized,
read-only production checkpoint.

### 2.1 Isolation requirements — ACCEPTED (plan §6, D-1, D-3, D-16, D-17)

- A disposable, isolated Ubuntu VM with no public DNS or TLS. Where it runs is an owner decision.
- The VM holds **none** of: a Docker context or `DOCKER_HOST` pointing at production; production database, broker, backup or
  GHCR-write credentials; a production `.env`, `roles.env`, `callers/` or broker client file; production deployment SSH credentials;
  production Docker volumes; any call to a production service.
- Every secret is generated on the VM by the deploy scripts. Backups go to MinIO on the VM with a rehearsal-only key pair.
- Prerequisites recorded for G6-B (cutover record §6): the dedicated **read-only** GHCR package credential (D-16), and a host-side
  egress block if the VM host shares a network with production.
- **G6-BV is mandatory and read-only, before any rehearsal mutation** (plan §6.1). Any failure: STOP.
- The GitHub production workflows are never used for the rehearsal (plan §5, §12).

### 2.2 Recovery inputs and expected evidence — ACCEPTED (plan §7, §10)

| Input | Source |
|---|---|
| backup and drill tooling | `infra/backup/backup.sh` and `infra/backup/restore-drill.sh`, unchanged, with the rehearsal destination and key |
| targets | RPO 24 h and RTO 4 h (D-4, D-5); the real-volume Auth and Organization drills are already certified (G5) and are not repeated |
| the rehearsed checkpoint | a backup at checkpoint X, rows written after X, a declared loss, a restore |

Expected evidence, in the G6 record: the restored facts equal the facts at X; rows written after X are absent; the last-success stamp
was at most 24 h old at the loss; the measured recovery duration; both services ready; the authority agreement
(organization-production §6.2) is MATCH for the rehearsed phase.

### 2.3 Backup and restore verification in the rehearsal

**ACCEPTED (plan §7):** the RPO and RTO demonstration above.

**Required by later Accepted ADRs and not in the certified plan** (each is a proposed addition, §2.8):

| Addition | Source |
|---|---|
| a restore drill detects a `local` marker after F6 | ADR-0063 §11 |
| a restore of a backup from the wrong side of F6 is refused by the operator procedure, and the agreement check shows the disagreement | ADR-0063 §9, §10; core-backup-restore §7 (procedural, "not rehearsed") |
| every authority-changing command refuses after F7, with a recorded event; read-only commands write nothing | ADR-0063 §11 |

### 2.4 Inventory the refresh must record

The refresh re-establishes every production fact G6 depends on (V2-A record §2; cutover record §10 to §13). The G6-A parity targets
of 2026-09-30 are the last certified values and are known to be stale in the places marked.

| Area | To record | Known change since G6-A |
|---|---|---|
| service images | for auth-service, organization-service and audit-service: the running digest, read on the server | production Auth runs a later image (observed, not certified: cutover record §11); all three run images that predate the immutable builds, which the deploy workflows refuse (digest-deployments §4) |
| infrastructure images | PostgreSQL and RabbitMQ image digests and versions | none recorded |
| migrations | count, last name and names-plus-checksums fingerprint per service | to re-read; the certified set may contain later migrations |
| configuration | variable **names** only, per service; network `Internal` flags; restart policy, health check and log configuration per container | A1.3, A2.1 and A2.2 made newer images read the configuration more strictly (organization-production §2) |
| broker | version, vhosts, users and tags, permissions, topic permissions, exchanges, bindings, queues | the detailed G6-A output is recorded as unavailable locally (cutover record §5) |
| deployment scripts | each service's `deploy/provision-and-deploy.sh` and organization-service's `deploy/register-caller.sh`, which are streamed **from the image**, so their identity is the image digest; `infra/rabbitmq/provision.sh`, `infra/backup/backup.sh` and `infra/backup/restore-drill.sh`, which come from the repository revision | the revision under rehearsal in the plan (`9e29c76`) predates V2 |
| deployment automation | the image and deploy workflows, the `production` environment and its approval, the `main` ruleset, where the production credentials live | build and deploy were separated; every production SSH job waits for approval (cutover record §11 to §13) |
| retained containers | the `-previous-` containers of Auth and Organization | never cleaned automatically (cutover record §9) |
| guards | Organization `VERIFIED`, class `fresh`, not authoritative, with its digest; Auth marker `local`; `AUTH_EVENTS=off` | expected unchanged |

Values are recorded by name, count, digest and version only: never a credential, a token or a row.

### 2.5 Certified digest-set selection procedure — ACCEPTED POLICY, not executed

**No digest is selected here, and none may be selected outside the G6 refresh.** The policy (A5.4-G1 item 3): G6 selects and
rehearses one exact digest each for auth-service, organization-service and audit-service; F6 and F7 use only that set, including
configuration-only redeploys such as the F6 Auth mirror; any change needs a re-rehearsal; the control is procedural.

Draft procedure for the refresh, each step owner-approved:

1. **Candidates.** For each service, an index digest from the summary of that service's image workflow run on `main`
   (digest-deployments §1). Unlabelled or unattested images are not candidates.
2. **Verification, read-only.** `gh attestation verify` for the exact digest, signed by the service's image workflow on
   `refs/heads/main`; the revision label is a commit that is an ancestor of `main` (digest-deployments §2).
3. **Coherence.** The three revisions are recorded. Because `libs/service-kit` and `libs/audit-contract` are built into all three
   images, the record states, for each library, which revision each image contains.
4. **Configuration.** For each digest, the approved configuration by variable name, and the result of the candidate image's own
   configuration check where one exists (organization-production §2; digest-deployments §2).
5. **Scripts and release context.** The deploy script identity (the image), the repository revision of the infrastructure scripts,
   and the workflow revisions.
6. **Use.** For each service, which production steps redeploy it or run a command from it. From the certified runbook: F6 redeploys
   Auth (the mirror); the cutover record §12 speaks of service redeploys within F6 **and F7**, so which service F7 redeploys (for
   example to open other callers) is confirmed at the refresh; the `ownership` commands of G7, F6 and F7 run from **the image the organization-service container runs**
   (`IMG`, organization-production §3); backups read the databases through their own containers.
7. **The record.** The set, its evidence and the owner's approval are written in the G6 baseline record. Each later deployment's
   digest input must equal it.

Consequences to plan for, none of them authorized here:

- **DEPLOY.** Production runs images the workflows refuse, so adopting the set needs a first digest deployment of each service,
  each a separately authorized production mutation (A5.4-G1 item 3). Their order relative to the refresh and to G6 is the owner's.
- Step 6 implies that the organization-service container must already run the certified digest when G7 runs, because the ownership
  CLI is taken from the running image. This follows from the runbook text and is to be confirmed at the refresh.
- A digest deployment applies that image's migrations, forward-only (digest-deployments §3). The snapshot and digest tooling of the
  ownership transition reads the hierarchy tables (D1 §3.5), so the refresh confirms that Organization's recorded digest and its
  `VERIFIED` phase are unchanged after such a deployment.

### 2.6 Conditions requiring a renewed rehearsal

| Condition | Basis |
|---|---|
| any digest of the certified set changes, including through a `libs/service-kit` or `libs/audit-contract` change | **decided** (A5.4-G1 item 3) |
| the approved configuration relevant to a digest changes | **decided** (A5.4-G1 item 3) |
| a deployment script changes | follows from the above: the service scripts are inside the image |
| the PostgreSQL or RabbitMQ version, the Docker major version, the networks or the broker topology differ from the rehearsed ones | derived from the plan's definition of production-like (§4); a deviation is otherwise recorded under plan §5 |
| the procedure changes: an F-step, its order, its commands, or the F6 mirror sequence (for example through the readiness decision) | derived: G6 certifies "the complete ownership-transition procedure" (plan §1) |
| a migration is added to a service of the set | follows from the first row |
| the record is incomplete or not approved | plan §13 |
| the rehearsal evidence is lost before G7 | derived |

The derived rows are for the owner to confirm in the refreshed plan. The certified plan has no validity period: whether elapsed time
alone requires a new rehearsal is **not decided**.

### 2.7 Rollback and stop conditions

- **STOP** (plan §13), at any step: an isolation check fails; a result differs from the runbook; a monitored signal is not observed;
  a secret appears in output; anything touches production. On STOP: record the deviation, fix it **in the rehearsal only**, repeat
  the affected step. G7 cannot proceed while G6 is not certified.
- **Rollback inside the rehearsal:** the plan rehearses `ownership rollback` from `VERIFIED` to `PREPARED` and verifies again, then
  shows that the same command is refused after activation (plan §9.1). After the rehearsal's F6 there is no rollback; the plan
  repeats the affected step after a STOP, and whether a failure after F6 needs a fresh VM state is not decided.
- **Production:** the rehearsal changes nothing in production, so there is nothing to roll back. The production steps after G6 are
  separate checkpoints (plan §12).
- **Retention:** the VM is kept stopped through G7 + 14 days; raw logs until F7 certification + 90 days (plan §11).

### 2.8 Differences between the certified plan and later decisions (for the owner; the plan is not edited)

| # | Certified plan | Later decision or fact | Needs |
|---|---|---|---|
| 1 | "the certified image repo digests" of G6-A; revision under rehearsal `9e29c76` (D-1, §4) | the certified digest set is selected at the refresh from labelled, attested images (A5.4-G1 item 3); production Auth no longer runs the G6-A digest | **DOC** (plan refresh) after the refresh |
| 2 | step 12 enables a backup schedule by a repository variable | that mechanism no longer exists; the plan's own later-status note records it | already noted in the plan |
| 3 | §9.1 ends at F7 and the backup | ADR-0062 §11: the rehearsal includes the post-F7 first Platform, the `allowedPlatforms` extension and the first Organization | **DOC** to add; the scope extension also needs the corrected tool (§5.1), which is **IMPL, RED** |
| 4 | no readiness check exists | ADR-0063 §4 and §11: the F6 transitional sequence is verified in G6 before the check ships | **OPEN** (the [readiness decision](core-v2-a5-4-f6-transitional-readiness.md)), then **IMPL** (A5.4-A5), then the check inside the certified set |
| 5 | §8.1 induces `hierarchy_source_mismatch` and a freeze as monitoring demonstrations | with the readiness check in the rehearsed image, both would also change Auth's `/ready` | **DOC**, with item 4 |
| 6 | §7 restores at the rehearsed phase | ADR-0063 §11: a restore drill detects a `local` marker after F6; the wrong-side restore rule is not rehearsed | **DOC** to add |
| 7 | `ownership verify` is the F5 and post-activation verification | ADR-0063 §6: a read-only replacement for post-transition use is planned; today `verify` appends an event | **IMPL, RED** (A5.4-O5) if wanted in the rehearsed set; otherwise the existing `verify` stays |
| 8 | the plan lists the mirror as marker, then source and redeploy (§9.1) | the active runbook's §3 F6 row lists the source first (its §6.2 prose lists the marker first), its F7 row repeats "retire Auth's hierarchy writes", and its §6.2 accepts either order | the mirror order is **OPEN** with the readiness decision; then **DOC** on both documents |

**Sequencing question for the owner (OPEN, not decided here).** Items 3, 4 and 7 name behavior that the ADRs want certified in G6,
while the code that provides it is RED or unauthorized today. Each such item either enters the certified set before G6-C, under its
own authorization, or its certification is deferred to a later rehearsal. This document does not choose.

## 3. B. F6 TRANSITIONAL readiness

The comparison of approaches is the companion record:
[Auth readiness during the F6 transition](core-v2-a5-4-f6-transitional-readiness.md). It distinguishes normal pre-F6 local
authority, the authorized TRANSITIONAL state, steady-state Organization authority, invalid disagreement and restored or stale state,
and gives for each approach the observable state, the readiness outcome, the alert behavior, the recovery implications, the rehearsal
requirements and the risks of a false ready and a false not ready.

- **OPEN.** No approach is selected.
- **Not authorized.** A5.4-A5 stays a design-approved exception; this document authorizes no implementation of it.
- **Five findings the owner should weigh**, all from the code as it is:
  1. Auth's `/ready` does not control traffic today. The container healthcheck and the deploy wait use `/auth/health`, so a not-ready
     Auth keeps serving; the outcome is a signal for the operator, the restore drill and the gauges.
  2. The check sees only the marker and the source. A restore of **both** the pre-F6 Auth database and its configuration, a restored
     pre-F6 Organization database, and the first part of F6 all look consistent to it. The authority agreement check
     (organization-production §6.2) stays the control for those cases.
  3. With the marker changed first, the F6 window (marker `org_authoritative`, source still `local`) is indistinguishable, by those
     two values, from a source lost after F6.
  4. The certified documents do not fix the order of the two mirror steps (§2.8 row 8). With the source changed first, the window
     carries the same two values as a restored pre-F6 Auth database.
  5. The restore drill keeps the backed-up configuration, so it does not detect a backup from the wrong side of F6.

## 4. C. F7 and post-F7 recovery

### 4.1 One-way authority transition invariants — ALREADY IMPLEMENTED

| Invariant | Enforced by |
|---|---|
| organization-service's phase never moves backward from `ACTIVE`; only `ACTIVE` → `RETIRED` | trigger, migration `0004_ownership_transition.sql` |
| `rollback`, `import`, `declare-class`, `approve` and `activate` refuse after activation, each with a recorded `ownership_event` | `apps/organization-service/src/ownership/ownership-admin.ts` |
| Auth's marker cannot leave `org_authoritative`; in that mode only the reference-cache protocol writes, never a delete | trigger, Auth migration `0008_hierarchy_authority.sql` |
| Auth `freeze`, `unfreeze`, `export` and `retire` refuse once `org_authoritative`, each with a rejected `hierarchy_authority_event` | `apps/auth-service/src/hierarchy/hierarchy-authority.ts` |
| no hierarchy row is deleted and no id is reused once the service is authoritative | migration `0004`; the id ledger |

**ACCEPTED (ADR-0040 A2.6; ADR-0063 §3):** the door is the first committed hierarchy write after activation; in a fresh environment
there is no ownership rollback after `activate`; no procedure restores Auth's local hierarchy authority; there is no emergency
administrator, database bypass or recovery authority mode.

### 4.2 Post-F7 backup verification

**ACCEPTED:** a fresh Auth and Organization backup is taken and verified after F7, before other callers are opened (plan D-13,
steps 16 to 18) and before the first Platform (ADR-0062 §4).

Draft procedure (each run a production action with its own authorization and `production` approval):

1. Confirm F7 first, read-only: phase `RETIRED`, marker `org_authoritative`, source `organization-service`, agreement MATCH
   (organization-production §6.2), both services ready.
2. Dispatch the backup for both services (core-backup-restore §3). Take them in one checkpoint so both are on the same side of F6.
3. The run succeeds only when every stage does: dump, archive listing, restore facts, configuration archive, encryption, upload,
   size check and the manifest written last (core-backup-restore §3).
4. Record the stamps and the manifest digests. The restore facts hold the authority state (`hierarchy_authority.mode` for Auth;
   phase, class and authoritative flag for Organization), encrypted, so they are read only with the recovery key in the isolated
   recovery environment, never in production.
5. Confirm the recorded authority state is on the post-F7 side: `org_authoritative`, and `RETIRED`.

**OPEN (owner to state):** what "verified" requires for this backup. The runbook's own principle is that a backup that has never
been restored is not a backup (core-backup-restore, preamble), and the plan says "verify the backup artifacts". The two readings are
the artifact checks of steps 3 to 5, or those plus an isolated restore drill of both backups. ADR-0063 §9 also asks that backup
generations be tagged by their side of the door; the tagging is **not designed**.

### 4.3 Unsafe restoration scenarios

After F6, per core-backup-restore §7 and ADR-0063 §9. "Detected by" names what exists today; the rule is procedural and no tool
enforces it.

| Scenario | Why it is unsafe | Detected by | Required action |
|---|---|---|---|
| a pre-F6 Organization backup restored | Auth is `org_authoritative` while Organization is `PREPARED`, `VERIFIED` or `ACTIVATABLE`: authority disagreement | the agreement check; the backup's recorded phase | forbidden as ordinary recovery; stop; escalate |
| a pre-F6 Auth database restored, configuration kept | the `local` marker returns; the marker's trigger cannot stop a restore | the agreement check; the start-up `hierarchy_source_mismatch` log; the planned readiness check | forbidden; stop; escalate |
| a pre-F6 Auth database **and** configuration restored (this is also what a restore drill of such a backup boots) | Auth looks like a consistent pre-F6 service; the drill passes | **only** the agreement check against Organization's phase, and the backup's recorded marker | forbidden; stop; escalate |
| a backup taken inside the attended F6 step | it may hold `local` while Organization is `ACTIVE` | the backup's recorded state; the agreement check | not restorable after F6 |
| Auth and Organization backups from different sides of F6, or from different checkpoints | the two no longer describe one authority state | the recorded states; the agreement check | restore only a compatible pair |
| any post-activation backup restored after later hierarchy writes | hierarchy writes made after the backup are lost; Auth may hold references to entities the authority no longer has | not detected by a tool today; the planned ADR-0061 diagnostic would show absent anchors | owner escalation; reconciliation is **not designed** |
| a restored outbox | the relay republishes pending rows, including some already published | Audit stores each `(sourceService, eventId)` once | none; never point a drill at a production broker |
| an Audit database replaced by a backup | later append-only evidence is destroyed | – | never done; core-backup-restore §6A |

Rules that hold in every case: before a restore, read the backup's recorded authority state in the isolated environment; after a
restore and before traffic, read the marker and the phase and run the agreement check; on any disagreement stop, do not resume
traffic, **never edit either side to make them agree**, and escalate to the owner.

### 4.4 Read-only verification procedures — ALREADY IMPLEMENTED unless marked

| Procedure | Reads | Writes |
|---|---|---|
| readiness of both services (organization-production §6.1) | `/ready` | nothing |
| authority agreement (organization-production §6.2) | phase, marker, configured source | nothing |
| evidence queries (organization-production §6.3) | `ownership_event`, `hierarchy_authority_event`, log signal names | nothing |
| Auth `hierarchy-status` | the marker | nothing; the restore drill uses it |
| Auth `hierarchy-verify` | Auth's reference rows, as a content digest | nothing; a **cache** diagnostic, not an authority check (ADR-0063 §6) |
| Organization `ownership status` | phase, class, digest | nothing |
| Organization `ownership verify-snapshot` | a file, offline | nothing; it touches no database |
| Organization `ownership verify` | the hierarchy digest | **it appends an `ownership_event`**: not read-only |
| restore drill (core-backup-restore §5) | a backup, in an isolated environment with no network | only its own disposable containers |
| ADR-0061 reference diagnostic | Auth's anchors against organization-service | nothing; **ACCEPTED DESIGN — NOT IMPLEMENTED** (§5.4) |
| read-only replacement of `ownership verify` | the hierarchy digest | nothing; **ACCEPTED DESIGN — NOT IMPLEMENTED** (ADR-0063 §6) |

A refused authority-changing command is not read-only either: its refusal appends a rejected event, by design.

### 4.5 Separately authorized exceptional recovery

- **ACCEPTED (ADR-0063 §9; ADR-0040 A1.4, A2.6):** any exceptional decision after the door is attended and owner-decided. It never
  authorizes restoring Auth's former authority. No universal administrator and no database-repair bypass apply.
- **OPEN, blocking:** after the door, ADR-0040's rollback semantics require **reconciliation, which is not designed**, and no ADR
  authorizes a mechanism. An operator who reaches this point has no procedure to follow beyond containment.
- **What the active runbooks already require** (core-backup-restore §7; organization-production §6.2, §6.3): stop progression; do
  not resume traffic after a restore that disagrees; keep the evidence (both rows, the event records, the logs); never edit either
  side; escalate to the owner. Nothing beyond that is available.
- A request for exceptional recovery therefore needs, at least, an owner decision that designs it. This document proposes none.

### 4.6 Conditions under which old local-authority paths must refuse

| Path | Condition | Behavior | Status |
|---|---|---|---|
| Auth `hierarchy-freeze`, `-unfreeze`, `-export` | marker `org_authoritative` | refused; rejected event | implemented |
| Auth `hierarchy-retire` | marker already `org_authoritative` | refused (`already_retired`); rejected event | implemented |
| Auth local hierarchy writes | marker `org_authoritative` | refused by the database outside the reference-cache protocol | implemented |
| `bootstrap-owner` legacy Company insert | marker `org_authoritative` | unreachable | implemented (ADR-0063 §6) |
| Organization `rollback`, `import`, `declare-class`, `approve`, `activate` | phase `ACTIVE` or `RETIRED` | refused; recorded event | implemented |
| Organization `retire` | already `RETIRED` | refused (`not_retirable`); recorded event | implemented |
| Auth with a `local` source under an `org_authoritative` marker, or the reverse | any time outside the defined F6 state | not ready, alert, no fallback | ACCEPTED DESIGN — NOT IMPLEMENTED (A5.4-A5; §3) |
| ADR-0061 repair route | hierarchy source `local` | collapsed `404` | ACCEPTED DESIGN — NOT IMPLEMENTED |
| ADR-0061 diagnostic | inconsistent authority state | refuses | ACCEPTED DESIGN — NOT IMPLEMENTED |

These refusals are mandatory for as long as the commands exist. The commands are removed only under ADR-0063 §8, when every one of
its conditions holds and a separate approval is given.

## 5. D. Provisioning and operational tooling

No tool is modified by this task. `register-caller.sh` is F-step tooling: any change to it is **IMPL, RED** (A5.4-O6).

### 5.1 The `allowedPlatforms` tooling gap — ALREADY IMPLEMENTED behavior

- `apps/organization-service/deploy/register-caller.sh` knows two callers and their exact policies; for `auth-service` it writes
  `"allowedPlatforms":[]`.
- **It rebuilds `SERVICE_TOKENS` and `SERVICE_POLICY` from every registered caller on every run.** A scope extended by any other
  means would be reset, silently, by the next run for any caller.
- The active runbook says "After F7, add each new Platform id to `auth-service`'s `allowedPlatforms`" (organization-production §4).
  **No approved means of doing so exists.** Editing `.env` by hand is not that means: the tool would undo it, and ADR-0062 §5 requires
  a recorded, all-or-nothing change.
- Effect while the gap stands: a Platform outside Auth's scope answers as not found, so Auth's first touches and any repair on it
  fail closed (ADR-0062 §10). **Nothing is exposed; the first Platform is simply unusable by Auth until the change exists.**

### 5.2 Caller-registration safety — ALREADY IMPLEMENTED

| Property | Behavior of the tool |
|---|---|
| explicit | never part of a deploy; needs `CALLER` and the exact `CONFIRM="register <caller>"` |
| closed set | an unknown caller, or an unexpected token file in `callers/`, stops it with nothing changed |
| secrets | the token is generated on the server, stored `0600`, never printed; `.env` holds digests only |
| no rotation | an existing token is kept; rotation is a separate, deliberate operation |
| no activation | it restarts nothing; the next organization-service deploy loads the configuration, and for `auth-service` the next Auth deploy hands Auth its token |
| atomic file writes | the token and `.env` are written to a temporary file and moved into place |
| **no deregistration** | no path removes a caller; the active runbook forbids "rotating" a token by deleting its file |

Operational consequences: every run is a production change with its own approval; a run is followed by a redeploy, which under the
certified digest-set policy uses the certified digest; and the candidate image's configuration check (organization-production §2)
is the control that a rebuilt policy is one the image accepts.

### 5.3 Provisioning-credential retirement — ACCEPTED POLICY; design OPEN

- **Decided (ADR-0062 §7):** the production provisioning credential must not remain able to create Companies after the initial
  transition; the disablement or deregistration step belongs **after activation**; nothing in the ADR deletes, revokes, rotates or
  modifies a credential; a later Company needs its own decision and a newly authorized identity.
- **Current exposure (ADR-0062 §1, §10):** the credential stays registered, and once the phase is `ACTIVE` its Company insert is
  accepted again. Such a Company could never receive an Owner. **No control prevents it until the §7 step exists**: there is no
  database guard, and the ADR names §7 as the prevention after activation. The token's `0600` file on the server limits who can
  read it and is not a control; no procedure uses the credential after F2.
- **OPEN, to be designed and approved separately:** the timing relative to F7, the post-F7 backup and the opening of other callers;
  the method (the tool has no deregistration path, so this is **IMPL, RED**, A5.4-O6); the verification; the recovery implications.
- **Decided failure rule (ADR-0062 §10):** if the disablement fails, the credential may still be capable: stop, do not open ordinary
  administration, retry under the same authorization. *Derived, for the owner to confirm in the retirement design:* this reads as
  placing the disablement before ordinary hierarchy administration is opened; ADR-0062 §4 does not list it among the conditions of
  the first Platform, and the timing is open.
- **Draft verification, for the future design to confirm:** after the disablement and the redeploy that loads it, a Company create
  with the retired credential is refused, the registered-caller list no longer grants `hierarchy.provision`, and the events and
  audit records show no Company created since F2.

### 5.4 Diagnostic CLI access restrictions — ACCEPTED DESIGN — NOT IMPLEMENTED

From ADR-0061 §6 and ADR-0063 §7, for the future Auth reference diagnostic:

- a restricted Auth CLI subcommand, run by the operator of the Auth deployment, on the server; **never exposed over HTTP**;
- it uses Auth's own read credential and stays inside Auth's `allowedPlatforms`; it does not extend scope;
- read-only: it places no reference, repairs nothing, modifies no database and changes no authority;
- output: approved identifiers, presence, parent-link agreement and reason codes only; never names, contacts, user data,
  credentials or tokens;
- it refuses when Auth's authority or configuration state is inconsistent;
- it is not a privileged recovery tool.

**OPEN (implementation):** the database role, the use of Auth's service token and the output format. The existing CLIs run today
from a one-off container with a temporary `0600` environment file, never with a secret on a command line (organization-production
§3); the diagnostic's runbook block follows that pattern once the open items are fixed. Its design does not depend on the repair
route.

### 5.5 Read-only and mutating operations

| Operation | Kind | Notes |
|---|---|---|
| readiness, agreement and evidence checks (organization-production §6) | read-only | |
| Auth `hierarchy-status`, `hierarchy-verify`; Organization `ownership status`, `verify-snapshot` | read-only | |
| candidate-image configuration check (organization-production §2; digest-deployments §2) | read-only | prints `OK` or `REFUSED` only |
| `gh attestation verify`; reading an image workflow summary | read-only | no production access |
| restore drill | isolated | never on the production host without an approved override |
| Organization `ownership verify` | **mutating** | appends an event; at F5 it also moves `PREPARED` to `VERIFIED` and records the verified digest; a later confirming run changes no phase |
| any refused authority-changing command | **mutating** | appends a rejected event |
| Organization `declare-class`, `import`, `approve`, `activate`, `retire`, `rollback`; Auth `hierarchy-freeze`, `-unfreeze`, `-export`, `-retire`; `bootstrap-owner` | **mutating**, authority-changing | each a separately approved step; several are irreversible |
| `register-caller.sh` | **mutating** | writes a token file and `.env` |
| any deploy workflow | **mutating** | runs migrations, forward-only, then replaces the container |
| backup workflow | **mutating** off-host | reads the databases; writes the bucket and the status files; applies retention |
| setting `AUTH_HIERARCHY_SOURCE` or `OWNERSHIP_PRODUCTION_ACTIVATION` | **mutating**, authority-changing | only inside the approved F6 step |

### 5.6 Approval requirements for credential and scope changes

| Change | Required before it runs | Status of the means |
|---|---|---|
| register a caller | a separately approved production change; the exact `CONFIRM`; then an approved redeploy | implemented |
| extend Auth's `allowedPlatforms` by one Platform | a separately approved, attended, audited change, **before** any first touch or repair on that Platform; verification of the Platform's Company association; exactly that Platform id; a record of the id, the justification, the approval and the verification result; a redeploy to load it (ADR-0062 §5) | **not implemented**; mechanism **OPEN**; tool change **IMPL, RED** |
| retire the provisioning credential | its own design and approval (ADR-0062 §7) | **not implemented**; **OPEN** |
| rotate a caller token | a deliberate, separate operation; never by deleting the file | no procedure for organization-service callers is documented here |
| authorize a new provisioning identity | its own decision; none while multi-company is undecided (ADR-0062 §6) | **OPEN** |
| any redeploy that loads such a change | an exact digest, the typed confirmation and the `production` approval; after G6, the certified digest | implemented |

None of these is authorized by this document, and none may be bundled into another task.

## 6. E. Lifecycle and ownership operations (operator-facing drafts)

These are drafts of procedures for capabilities that **do not exist yet**. Each names what it cannot fix until an open decision is
closed. In all of them: the human acts through the product's administration client against the service's API, with their own
bearer and a step-up; there is **no CLI, database or operator shortcut** (ADR-0050 decisions 8 and 14); a failure leaves the
previous state in force.

### 6.1 Lifecycle: suspend, reactivate, archive, restore (ADR-0060) — NOT IMPLEMENTED; all of it GATED until F7

**Who may act** (ADR-0060 §5): the active Owner for a Company or a Platform; for an Organization the Owner, or an Operator assigned
to its Platform while the Platform and the Company are effectively active. The Organization Admin never changes lifecycle state.
Archive and restore of an Organization are Owner only. The Operator path waits for the Operator step-up mechanism.

| Step | Draft |
|---|---|
| before | confirm the target and its current local and effective state; choose the reason code; for a Company suspension have a factor available (a fresh factor step-up is required) |
| act | the operation with a fresh step-up; a conflict on the version precondition answers `409` and nothing changes |
| effect to expect | **suspend:** the scope and everything under it becomes effectively inactive; access-granting actions are refused, access-reducing ones stay available. **reactivate:** the entity's local state returns to `ACTIVE`; it stays effectively inactive while an ancestor is inactive. **archive:** from `ACTIVE` or `SUSPENDED`. **restore:** always lands in `SUSPENDED`; reactivation is a second, separate operation |
| verify | the entity's local and effective state through the reference read; the central audit record of the transition with its reason code; the outbox lag check if the record has not arrived |
| what does not change | memberships and access are still reported for an inactive scope (ADR-0060 G3); *inferred from ADR-0060 §7, where authentication never calls organization-service:* sessions and tokens are not revoked by a lifecycle change; codes and invitations created earlier can still be redeemed during a suspension until E3 exists (G1); Billing subscriptions are independent |
| failure | the transition and its audit intent are one transaction: if the audit intent cannot be written, nothing changes. If organization-service is unavailable, the operation fails and the state is unchanged |
| reversal | suspend ↔ reactivate; archive → restore → reactivate. Nothing is deleted. There is no path from `ARCHIVED` straight to `ACTIVE` |

**Cannot be finalized until:** OD-L5 (how the effective state is read, and so the verify step); OD-L6 (the reason codes); the step-up
purpose names and methods; the Operator step-up mechanism; OD-L7 for anything said to customers about commercial effects; the audit
action names (A5.4-AC1). An unavailable Owner is restored first through ADR-0059 recovery; there is no other actor.

### 6.2 Owner transfer (ADR-0059 §5) — NOT IMPLEMENTED; gate `OWNER_TRANSFER` default off

| Step | Draft |
|---|---|
| preconditions | the gate is on; notification delivery works in production; the Company is not `ARCHIVED`; no other case is open for the Company |
| 1 initiate | the active Owner, with a fresh **factor-only** step-up, names the recipient's contact and an expiry |
| 2 token | a single-use token bound to that contact is shown once and delivered out of band |
| 3 accept | the recipient presents the token, the bound contact and a password, then enrolls and confirms a factor; they have no authority and no session |
| 4 cool-down | **24 hours**; the current Owner is notified and may cancel, with a factor-only step-up |
| 5 complete | only after the cool-down **and** a delivered notification; the switch is one transaction |
| verify | exactly one active Owner for the Company; the former Owner's account disabled and its sessions, step-ups and pending recovery revoked; the central audit records of every transition; the notification's delivery state; Operator assignments unchanged |
| failure | a notification that cannot be delivered blocks completion; a database failure changes nothing; a failed completion rolls back entirely |
| reversal | before completion: cancel. **After completion there is no undo**; returning ownership is a new transfer initiated by the new Owner |

**Cannot be finalized until:** the step-up purpose names; the routes; how Auth
learns that a notification was delivered and what the operator reads to confirm it; the template keys. OD-P1 (reuse of an abandoned recipient's contact) leaves one detail
of the accept step open and does not block the rest. Production use also needs
notification-service and A3M.8 in production (ADR-0059 stage T6). The `ARCHIVED` check applies once E5 exists; it is not a
prerequisite for building the transfer.

### 6.3 Exceptional two-steward recovery (ADR-0059 §6, §7) — NOT IMPLEMENTED; gate `OWNER_RECOVERY` default off; **blocked by OD-S1**

Fixed by the ADR, and usable as the frame of a future procedure:

| Step | Decided |
|---|---|
| when | the Owner cannot act; an Owner who can still prove password and secret key uses same-owner credential recovery (ADR-0027) instead |
| 1 open | a steward, with fresh MFA, opens the case with evidence **references** and the procedure version |
| 2 approve | a **different** steward, with fresh MFA, approves; neither is the claimant; the database rejects the same steward twice |
| 3 notify | the existing Owner and the trusted channels, at open, at approval and before completion |
| 4 cool-down | at least **7 days**; the existing Owner (any working factor, or password plus secret key) or either steward can cancel |
| 5 complete | the same atomic switch as a transfer, with reason `recovery` |
| fail closed | any notification, audit-contract or steward-MFA failure blocks open, approve and complete; **cancellation is always allowed** |
| never | automatic approval of a contested or high-risk case; a steward receiving an owner row, Company authority or unrelated Company data |

**This procedure cannot be drafted further, and must not be invented:** **OD-S1** (how stewards are provisioned; no bootstrap or CLI
is authorized) blocks everything; **OD-R2** (the evidence standard) and **OD-R4** (a mandatory external legal or notarial step) block
the verification steps; **OD-S2** (how Release and Audit map Auth's `403` for a steward) is deferred by ADR-0059, with current
behavior failing closed, and blocks nothing here. The gate also needs a non-production rehearsal and
the owner's sign-off (ADR-0059 §10). The steward work is where A5.4-AS1 and A5.4-K1 belong; they are prerequisites of nothing else.

### 6.4 Reference-repair diagnostics (ADR-0061; ADR-0063 §7) — NOT IMPLEMENTED

| Situation | Draft triage |
|---|---|
| an Auth first touch answers `503 hierarchy_unavailable` | today: check organization-service readiness and the `auth-service` caller registration (organization-production §6.3); retry once restored |
| `hierarchy_anchor_mismatch` is logged | today and later: **a security event, never a repair case**. The request already failed closed and nothing was overwritten. Stop; keep the logs; investigate; do not repair around it |
| a reference is suspected missing or stale | later: run the diagnostic (§5.4). It reports presence, parent-link agreement and "outside Auth's scope" |
| the diagnostic reports "outside Auth's scope" | not a repair case: scope is extended only by the change of §5.6 |
| the diagnostic reports an absent reference for an entity the authority has | later: the active Owner may request a repair of that id through the repair route, with a fresh factor-only step-up |
| the diagnostic refuses | Auth's authority state is inconsistent: treat as §4.3, not as a repair case |

A repair grants no access and is not lifecycle evidence. It is permitted while the entity or an ancestor is suspended or archived.
It is not a recovery tool: it places a validated reference only. The diagnostic's design does not depend on the repair route, and
neither depends on the lifecycle work.

**Cannot be finalized until:** the diagnostic's database role, token use and output format; the audit action names and how a failed
repair or a mismatch is recorded (D1 §5.4); the repair route's path.

### 6.5 Audit and notification verification (for §6.1 to §6.4)

- **Audit.** Every successful transition writes its central audit intent in the same transaction, so a committed change always has
  an intent. Its arrival in audit-service is asynchronous: check the record through audit-service's read API as an authorized
  reader, and the outbox lag check when it has not arrived. A broker outage delays the record and never the change.
- **Failed operations** have best-effort evidence only where an ADR says so (repair: ADR-0061 §6). The absence of a failure record
  is not evidence that nothing was attempted.
- **Notification.** A transfer or a recovery completes only after delivery. What the operator reads to confirm delivery is **OPEN**
  (D1 §7.4).
- **Consumer first.** No producer emits a new action or the `steward` kind before audit-service accepts it (D1 §7.1).

### 6.6 Fail-closed and rollback behavior, in one place

| Dependency unavailable | Lifecycle | Transfer | Recovery | Repair |
|---|---|---|---|---|
| organization-service | the operation fails; nothing changes | initiation and completion fail once the `ARCHIVED` check exists | not required by the ADR | `503`; the consumed step-up is not restored |
| Auth (grants, step-up verification) | the operation is refused | – | – | – |
| notification delivery | not involved | no completion | no open, approve or complete | not involved |
| audit intent cannot be written | nothing changes | nothing changes | nothing changes | rolled back |
| broker | the change commits; the audit record waits in the outbox | the same | the same | the same |

A lifecycle read that is unavailable never blocks an access-reducing action (ADR-0060 §7).

## 7. Governance and dependencies

The dependency model is D1 §8, unchanged. In particular, and to avoid reintroducing a false prerequisite:

- A5.4-AS1 and A5.4-K1 belong to the steward work only (ADR-0059 stage T5, after OD-S1).
- Reference repair has no lifecycle prerequisite.
- The transfer API does not need E5 first; E5 is extended to the transfer path once both exist.
- The read-only diagnostic's design does not depend on repair.

### 7.1 Classification of every future action named in this document

| Action | Class |
|---|---|
| refresh the G6 plan for the differences of §2.8; the other edits of §7.2 | **DOC** (each its own authorization) |
| the rehearsal host; fixing the mirror order; which behaviors enter the certified set | **OPEN** |
| the G6 baseline refresh on production (read-only); creating the read-only GHCR credential for the rehearsal | **OPS** |
| select the certified digest set | **OPEN** until the owner records it at the refresh |
| first digest deployment of each service; every later deployment | **DEPLOY** |
| G6 (G6-B to G6-F); never production | **OPS** |
| pre-G7 and post-F7 backups; any restore drill | **OPS** (each backup is a production dispatch needing its own authorization and the `production` approval; each drill its own authorization) |
| G7, F6, F7 | locked; each **ACTIVATE**, a separately authorized production checkpoint; F6 has no rollback; the redeploys inside them are **DEPLOY** |
| opening other callers | **ACTIVATE** (the last part of F7) |
| select the F6 TRANSITIONAL approach | **OPEN** |
| Auth readiness check (A5.4-A5) | not authorized by this document; separately authorized **IMPL** (RED, design-approved exception) after the selection; then **DEPLOY** inside the certified set |
| the meaning of "verified" for the post-F7 backup; backup-generation tagging | **OPEN** |
| reconciliation after the door; any exceptional recovery mechanism | **OPEN**; nothing is designed |
| `register-caller.sh` scope extension and deregistration (A5.4-O6) | **OPEN** (mechanism) then **IMPL** (RED) |
| extend Auth's `allowedPlatforms`; retire the provisioning credential | **ACTIVATE**, each attended and separately approved, after the tool exists |
| first Platform and first Organization | **ACTIVATE**: a separate attended authorization after the verified post-F7 backup |
| read-only replacement of `ownership verify`; `EnvReader` convergence | **IMPL** (RED) |
| reference diagnostic; repair route | **IMPL** (RED); details **OPEN** |
| inert step-up purposes (A5.4-A1); Notification templates without a producer (A5.4-N1) | **IMPL** (YELLOW); names **OPEN** |
| lifecycle runtime; E5; E1 | **IMPL** (RED); OD-L5, OD-L6 **OPEN** |
| the Operator step-up mechanism | **OPEN**, then **IMPL** |
| E3 event-driven propagation | **IMPL** (RED), after A3M.8 and a separate decision |
| owner lifecycle and transfer; enabling `OWNER_TRANSFER` | **IMPL** (RED), then **ACTIVATE** |
| steward work, including A5.4-AS1 and A5.4-K1, and recovery; enabling `OWNER_RECOVERY` | **OPEN** (OD-S1), then **IMPL** (RED), then **ACTIVATE** |
| audit-contract declarations (A5.4-AC1); the audit-service deployment that carries them | **IMPL** (YELLOW); **DEPLOY** |
| capability-based removal of legacy modes and commands (A5.4-R1) | **IMPL** (RED), only when every condition of ADR-0063 §8 holds |
| turn these drafts into active runbooks | **DOC**, each with the capability it describes |

### 7.2 Proposed changes to active documents (none made here)

| Document | Change | When |
|---|---|---|
| G6 plan | the differences of §2.8 | at the G6 refresh |
| organization-production §3 (F6 and F7 rows), §6.2 | the order of the two mirror steps, and where "retire Auth's hierarchy writes" belongs (§2.8 row 8) | with the readiness decision |
| organization-production §4 | the `allowedPlatforms` sentence names a means that does not exist | with A5.4-O6 |
| organization-production §6.1, §6.3 | `/ready` and the Auth not-ready rule | with A5.4-A5 |
| core-backup-restore §7 | backup-generation tagging; the rehearsal status of the wrong-side rule | when designed and rehearsed |
| core-backup-restore §7, last bullet | it says an additional cutover backup "can be approved in the G6 rehearsal plan"; the plan has since required the pre-G7 and post-F7 backups (D-12, D-13) | a wording alignment, at the next authorized edit |

## 8. Open decisions and blockers, consolidated

| Open item | Blocks |
|---|---|
| the F6 TRANSITIONAL approach, the order of the two mirror steps, and the `frozen` detail | A5.4-A5; the amended alert rule; the G6 monitoring demonstrations |
| which ADR-required behaviors enter the certified set before G6-C (§2.8) | the content of the certified set and of the rehearsal |
| whether elapsed time alone requires a new rehearsal; confirmation of the derived conditions of §2.6 | the validity of a certified G6 |
| what "verified" means for the post-F7 backup; backup-generation tagging | the post-F7 backup checkpoint; the restore procedure |
| how a restore from the wrong side of F6 is detected (procedural today; the drill does not detect it, §3) | the restore procedure after F6; the G6 restore rehearsal |
| every architecture-owner decision still open in [D1](core-v2-a5-4-implementation-specifications.md) §9 | as listed there; none is answered here |
| reconciliation after the door | any exceptional recovery |
| the `allowedPlatforms` mechanism | the scope extension, and so Auth's first touch or repair on a new Platform and the first Organization that Auth must reach; **not** the creation of the first Platform (ADR-0062 §4 and §11 order the extension after it; D1 §9 words this row as "the first Platform") |
| the provisioning-credential retirement design and timing | the retirement step; whether it precedes ordinary administration is part of that design |
| the diagnostic's database role, token use and output format | the diagnostic and its runbook block |
| OD-L5, OD-L6, OD-L7; lifecycle step-up purposes and methods; the Operator step-up mechanism | the lifecycle procedure |
| how delivery is confirmed; template keys; the transfer step-up purposes | the transfer procedure |
| OD-P1 | one detail of the transfer's accept step |
| OD-S1 | the recovery procedure, entirely |
| OD-R2, OD-R4 | the verification steps of recovery |
| audit action names; how failures are recorded | every verify step |
| the rehearsal host and the read-only GHCR credential | G6-B |

Every item above stays **OPEN**. Nothing in this document or its companion answers one.

## 9. What this document does not do

It runs no command and reads no production system. It selects no digest and no readiness approach. It edits no runbook, plan, ADR,
script, workflow, schema, test or check. It authorizes no implementation, deployment, activation, rehearsal or production step.
