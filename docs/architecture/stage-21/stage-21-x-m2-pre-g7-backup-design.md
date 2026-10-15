# Stage 21.x M2 — pre-G7 production backup, verification and schedule: design

- **Status:** DESIGN — **PROPOSED**, not approved. **M2 is NOT CERTIFIED.** Nothing in this document has been implemented or run.
- **Authorizes nothing.** No production, guest or lab access; no backup, restore, deployment or migration; no GitHub environment,
  secret, variable or workflow change; no scheduled-backup implementation. Each step of §11 needs its own explicit owner
  authorization. **M3 (G7, F6, F7, the post-F7 backup) stays LOCKED.**
- **Checkpoint:** roadmap M2, "Fresh pre-G7 Auth + Organization backup, verification, `CORE_BACKUP_SCHEDULE`" (depends on M1, done:
  G6 CERTIFIED 2026-10-14, [G6 record](stage-21-x-g6-rehearsal-record.md) §14).
- **Related:** [cutover record](stage-21-x-cutover-record.md) §3.2, §7, §12, §16; [G6 plan](stage-21-x-g6-rehearsal-plan.md) §3 (D-11
  to D-13), §12, §15.8, §23; [backup and restore runbook](../../runbooks/core-backup-restore.md);
  [V2-A.3 record](../core-v2-a-3-ci-and-ruleset.md) §2 (D-2), A3.5 (B1); [production readiness](../production-readiness.md) §3;
  `.github/workflows/core-backup.yml`; `infra/backup/backup.sh`; `infra/backup/restore-drill.sh`; `scripts/lib/checks.mjs`.

## 1. Decision status vocabulary

Every statement below carries one of these labels. Only **APPROVED** items bind; everything else is a proposal for owner review.

| Label | Meaning |
|---|---|
| **APPROVED** | an existing owner decision, cited to its record |
| **OWNER DIRECTION** | stated by the owner on 2026-10-15 as a proposed decision to verify, **not final**; it shapes this design but binds nothing |
| **PROPOSED** | this document's recommendation; becomes binding only through an owner decision recorded later |
| **OPEN** | not decided; listed in §12 |
| **TO VERIFY** | a platform behaviour this design depends on, not verified in this repository; verified before implementation |

## 2. Approved requirements (what M2 must deliver)

| # | Requirement | Source | Label |
|---|---|---|---|
| R1 | A fresh **manual** Auth + Organization production backup, verified, then the daily schedule, each a separately reviewed production checkpoint, **before G7** | G6 plan D-11 | APPROVED |
| R2 | A fresh **verified** pre-G7 backup, after G6 certification | G6 plan D-12 | APPROVED |
| R3 | Order: manual backup → verify the artifacts → schedule → G7 | G6 plan §12 steps 10–13 | APPROVED |
| R4 | The schedule returns only through a separate `production-backup` environment (no interactive reviewer, `main` only, its own credentials) and a scheduled job bound to it, separately reviewed | V2-A.3 D-2; runbook §2; G6 plan later-status note (2026-10-04) | APPROVED |
| R5 | Every production SSH job bound to a protected environment; `production` jobs dispatch-only; the backup job manual and approved through `production` | V2-A.3 A3.5, owner decision B1 | APPROVED |
| R6 | Off-host private S3-compatible storage; client-side public-key encryption; RPO 24 h, RTO 4 h, 30 daily backups; no PITR | G5 D1–D3 (runbook §1) | APPROVED |
| R7 | Never restore a pre-F6 Organization backup after F6; a pre-F6 Auth backup is forbidden as an ordinary restore after F6 | runbook §7; ADR-0063 §9 | APPROVED |
| R8 | G7 reference `G6-REHEARSAL-20261014@64b503095674a8227527c7f0b68819cdf703669d` | G6 record §14; owner, 2026-10-15 | APPROVED |

**Scope (APPROVED, runbook §1 D4; roadmap M2):** organization-service and auth-service only. audit-service is excluded: `backup.sh`
refuses it until migration `0004` is deployed (A13.4a), and its backup is roadmap M9. RabbitMQ and File Service are not in M2.

## 3. Current state (read from the repository and the GitHub API, 2026-10-15)

- `core-backup.yml` is `workflow_dispatch` only; its `backup` job declares `environment: production` and the concurrency group
  `production-deploy-core-api` (`cancel-in-progress: false`); it streams `infra/backup/backup.sh` from `main` over SSH with the
  `DEPLOY_SSH_*` password credentials.
- The `production` environment: one required reviewer (the owner), self-review allowed, administrator bypass off, no wait timer,
  deployment branch policy `main`. Its secrets are `DEPLOY_SSH_{HOST,USER,PASSWORD,PORT}`. The organization-level `DEPLOY_SSH_*`
  secrets are still visible to this repository (A3.7 deferred).
- No `production-backup` environment and no repository variables exist. `scripts/lib/checks.mjs` allows production SSH jobs only in
  `PRODUCTION_ENVIRONMENTS = ['production']` and refuses a `production` job in a workflow with any trigger other than
  `workflow_dispatch`.
- Last production backups: Auth `20260929T103715Z` and Organization `20260929T225442Z` (both drilled, G5). The scheduled runs of
  2026-09-29 to 2026-10-04 were skipped (variable unset); no backup has run since. Every change to `backup.sh` since then (A13, the
  canonical ACL fact) has run only locally, in CI and on the G6 guest.
- The repository is **public**: workflow logs are publicly readable (the backup tools print names, sizes, digests and PASS/FAIL only),
  and GitHub disables scheduled workflows of a public repository after 60 days without repository activity (TO VERIFY).

## 4. The removed schedule and why

Before the A3.5 change (`197a1a9`), `core-backup.yml` also ran on `schedule: '17 2 * * *'`, gated by
`vars.CORE_BACKUP_SCHEDULE == 'enabled'`, with the scheduled services from `vars.CORE_BACKUP_SERVICES`, no environment, and the shared
`DEPLOY_SSH_*` credentials. V2-A.3 found that those credentials were organization secrets readable by every workflow on any branch, so
an environment approval is a real gate only when the credentials live only in the environment and every production SSH job declares
it. Binding the backup job to `production` (B1) made a nightly run wait for a human reviewer, so the schedule was removed, and D-2
decided that a schedule returns through a separate environment that does not need the interactive reviewer.

**The design problem M2 must solve.** An environment without a reviewer that holds a credential granting a **shell** on the server
turns every merge to `main` into an unattended production execution path. With one maintainer and zero required pull-request
approvals (V2-A.3 D-5), that is a silent bypass of the `production` approval. The scheduled path must therefore be unable to change
**what** runs in production, not only **when** it runs.

## 5. Proposed scheduling model: restricted SSH from GitHub Actions (PROPOSED)

| Element | Proposal |
|---|---|
| Credential | A dedicated SSH key pair for the scheduled backup only, never the deploy password. The public key is one line in the runtime user's `authorized_keys` with `restrict` and a forced `command=` naming the server entry script, so the command the client sends is ignored: no shell, no PTY, no port, agent or X11 forwarding. The private key is held only as a `production-backup` environment secret |
| Server entry script | A small script installed by an attended, owner-authorized action (never streamed from GitHub). It fixes `BACKUP_SERVICES="auth-service organization-service"`, ignores `SSH_ORIGINAL_COMMAND`, verifies the installed `backup.sh` against a pinned SHA-256 before running it, and exits with `backup.sh`'s exit code |
| Environment | `production-backup`: no reviewers, deployment branch policy `main` only, administrator bypass off; secrets limited to the backup host, port, user, private key and the pinned host-key fingerprint. It never holds `DEPLOY_SSH_*` |
| Workflow | A separate scheduled workflow (for example `core-backup-scheduled.yml`), trigger `schedule` only. Manual backups keep using `core-backup.yml` under `production` approval. The job pins the server's host-key fingerprint (today's backup job pins none), uses the concurrency group `production-deploy-core-api` with `cancel-in-progress: false`, and carries an activation guard that is off when merged |
| Repository guard | `checks.mjs` allows `production-backup` only for a schedule-only job that uses the backup credentials and a pinned fingerprint, no `DEPLOY_SSH_*` and no script payload; it recognizes the backup credentials and a plain `ssh` step as production access; `production` stays dispatch-only |
| Runner | GitHub-hosted, ephemeral. A source-address restriction is not practical; the protection is key-only access plus the forced command |

**Why this does not bypass approval.** A merge to `main` can only make the scheduled job start the server's fixed entry script.
Changing what runs in production needs an attended action: reinstalling the entry script or `backup.sh` on the server, or changing the
`authorized_keys` line, each under its own authorization (console or a `production`-approved dispatch).

**Against the approved requirement R4:** a separate environment, no interactive reviewer, `main` only, its own credentials: **met**.
The forced command, the fingerprint pin and the hash-checked script go beyond R4; they are what makes "its own credentials" safe.

**Alternative (not proposed, OPEN):** a systemd timer on the server, with no production credential in GitHub at all. It departs from
R4 (no environment, no scheduled job) and moves failure visibility off GitHub; it would need its own analysis and an owner decision
that supersedes D-2.

## 6. Risks of the scheduling model

| Risk | Detail | Mitigation (PROPOSED) |
|---|---|---|
| Production credential scope | The organization-level `DEPLOY_SSH_*` secrets stay readable by any workflow until A3.7; a mistake could wire them into the scheduled job | `checks.mjs` refuses `DEPLOY_SSH_*` in a `production-backup` job; the backup key exists only in that environment; A3.7 stays required (roadmap M4) |
| Forced-command escape | Options other than `restrict`/`command=`, an entry script that reads `SSH_ORIGINAL_COMMAND`, or a writable entry script reopen a shell path | `restrict` plus `command=`; the entry script takes no input; the M2 record captures the `authorized_keys` line form (not the key) and the script's hash |
| Server file ownership | The forced command runs as the runtime user, who can already run Docker (root-equivalent) and owns `$HOME/nawara-core/backup`; anything able to write as that user can change the entry script | The entry script and the pinned `backup.sh` copy are installed read-only (mode 0500/0400), their hashes recorded; a change is an attended, authorized reinstall. A dedicated system account would need Docker access too and is not simpler (OPEN) |
| Script drift | Scheduled runs use the installed `backup.sh`, not `main`'s; a later `backup.sh` change does not reach the schedule until reinstalled | Record the installed hash in the M2 record; after any `backup.sh` change, an authorized reinstall or a recorded decision to keep the installed version |
| Key authentication on the server | Today's deploy path uses password authentication; whether production `sshd` accepts key authentication for the runtime user is not recorded | TO VERIFY read-only in the preflight (§11 P1) |
| Workflow scheduling | GitHub may delay or drop scheduled runs under load, and disables schedules of a public repository after 60 days of inactivity (TO VERIFY); a run that never starts produces no failure | An off-the-hour cron; the freshness check of §9; the runbook §4 staleness rule stays |
| Environment auto-creation | GitHub creates an environment, without protection, when a job references one that does not exist (TO VERIFY whether this applies to a job skipped by its `if:`) | Create `production-backup` with its branch policy **before** the workflow is merged |
| Concurrent runs | In one concurrency group a newly queued run cancels an older **pending** run (TO VERIFY current GitHub behaviour). A scheduled backup can then cancel a pending, approval-waiting deployment or be cancelled itself; whether a run waiting for approval holds the group is not observed (runbook §3) | Keep the shared group (no dump during a migration); schedule outside deployment hours; treat a cancelled backup as missed (freshness check) and a cancelled deployment as a visible, re-dispatchable event |
| Self-approval | One maintainer; every review and approval is the owner's | Recorded limitation, as in V2-A.3 |
| Public logs | Scheduled-run logs are public | The tools print no secret, address or row count; the entry script prints the same `backup.sh` output |

## 7. Retention and historic evidence

- **Retention (APPROVED, D3):** `backup.sh` keeps the newest 30 backup days per service and deletes only that service's own artifact
  names under the prefix, only after a successful backup. Exit 3 means the new backup is intact and retention failed.
- **Conflict with OWNER DIRECTION ("existing backup evidence must be preserved").** Once 30 newer backup days exist, retention deletes
  the certified G5 objects (`20260929T103715Z`, `20260929T225442Z`) and, about 30 days after it is taken, the pre-G7 backup. Options
  (OPEN):
  1. the evidence is the recorded identifiers, digests and drill outputs only (no object kept);
  2. copy the evidence sets to a separate retained prefix that retention never matches (a bucket write, separately authorized);
  3. a reviewed retention exemption in `backup.sh` (a code change).
- **G6 rehearsal evidence (APPROVED, G6 plan §11, D-9, D-15):** unchanged and untouched by M2: checkpoint X, the B2 lock, the stopped
  guest (through G7 + 14 days), the raw logs (until F7 certification + 90 days).
- **Post-F6 validity (APPROVED, R7):** the pre-G7 backup is a recovery point only until F6; after F6 it is never an ordinary restore.
  The M2 record labels it so.

## 8. Encryption and recovery-key custody

- **Encryption (APPROVED, D2):** `openssl cms`, AES-256, on the server to the public recipient certificate; the private key never on the
  server, in the bucket or in the repository; plaintext only in a 0700 work directory removed on every exit path. The current recipient
  is the 2026-09-29 replacement certificate (confirmed by G6-BV-S); each manifest records `recipient_sha256` in plain text.
- **Custody (APPROVED, runbook §2):** passphrase-protected private key and passphrase in two separate offline custody locations; when
  the pair is replaced, the old private key is kept as long as backups encrypted to it are retained.
- **OWNER DIRECTION:** old recovery keys are preserved. With §7 option 2 or 3 that means for as long as the evidence sets exist (OPEN).
- **No change** to the cipher, the certificate or the custody is proposed.

## 9. Storage immutability and alerting

- **Storage (APPROVED, D1):** private S3-compatible bucket, credentials scoped to the prefix (put, get, head, list, delete). The
  delete permission held on the server is what retention needs, and also what a server compromise could abuse.
- **Immutability (OPEN, optional; no approved requirement):** bucket versioning with a lifecycle rule, or object lock no longer than
  the retention window so it does not block retention; provider-dependent. Not required for M2 certification.
- **Failure visibility (APPROVED, runbook §4):** the attended model: a red run, `backup/status/<service>.last-attempt result=failed`,
  `last-success` older than 24 h. Automated backup-failure alerting is roadmap **M10**, not M2.
- **OWNER DIRECTION:** failure notifications reach the owner. **PROPOSED:**
  - GitHub notifies scheduled-run failures to the user who last changed the workflow's cron line (TO VERIFY): the owner authors that
    change and keeps Actions failure notifications enabled;
  - additional assurance: a credential-free freshness check (no production SSH, no `production` environment) that lists the bucket
    with a list/head-only credential and fails when the newest manifest of a service is older than a threshold (OPEN, for example
    26 h). It catches runs that never started.

## 10. Verification of the pre-G7 backup

**Mandatory (APPROVED, G6 plan §12 step 11; cutover record §7):** verify the backup artifacts:
- the run exited 0 for both services with one stamp;
- `backup/status/<service>.last-success` names that stamp and `last-attempt` reads `succeeded`;
- four objects per service (`db.dump.cms`, `facts.cms`, `config.tar.cms`, `manifest`), their sizes and SHA-256 equal to the manifest,
  read off-host;
- the manifest's PostgreSQL version is 16.15 and its `recipient_sha256` is the expected certificate's.

**Additional assurance (PROPOSED; OWNER DIRECTION: an isolated recovery environment, never the G6 guest):** one isolated drill per
service (runbook §5) of the **exact stamp**, never `latest`, in a recovery environment off the production host:
- **PostgreSQL pinned:** `restore-drill.sh` runs `postgres:<major>-alpine`, a floating tag. In the recovery environment that tag is
  pointed locally at a pinned image before the drill (as in G6-E): production's `postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685`
  (G6-A), or the G6-E image `postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` (OPEN);
  `PG_VERSION=16.15` is checked first.
- **Service images pinned** (OPEN): the G6-certified digests, Auth
  `sha256:5877c6ad5a4a4ac4b7858efce794abf9ba65c5162dc9fc8f569fdef384ec35ed`, Organization
  `sha256:61221d5445f46045cfb9fd99ee38b42833568dfb1f577f853699d5f7acb9ca60` ("the release that made the backup, or later"; equal
  migration histories), or the running legacy images.
- **Tooling pinned:** `restore-drill.sh` at a recorded `main` commit and hash.
- **Expected:** Auth 10 checks, restored marker `local`; Organization 11 checks, restored `VERIFIED|fresh|false`, the known Company
  read (`KNOWN_ID` = the production Company id of cutover record §2); `KEEP_DRILL` unset (the drill removes only its own disposable
  containers and decrypted files).
- **Why it is worth doing:** the first production run of the current `backup.sh`; the first Auth backup holding the bootstrap owner and
  the T1 factor; the only way to read the recorded authority state (encrypted facts) before the one-way door.
- **Never the G6 guest** (its preserved state, §7) and **never a restore on the production host** (runbook §6 recovery and
  `RESTORE_ON_PRODUCTION_HOST=yes` are outside M2).

**Freshness (OWNER DIRECTION: 24 h; OPEN until decided):** the pre-G7 recovery point is a verified backup whose stamp is at most 24 h
older than the execution of `ownership approve`; otherwise the backup and its verification are repeated. Whether a later scheduled
backup with verified artifacts can be that recovery point, and whether digest deployments before G7 require a new backup, are OPEN.

## 11. Dependencies and step order (PROPOSED)

```text
[D1 this design reviewed; §12 decisions recorded] ─► [I1 implementation PR: scheduled workflow (guard off), checks.mjs + tests,
        │                                              server entry script, runbook §2/§4] ── merged only after E1 exists
        ▼
[P1 preflight RO] ─► [P2 manual backup MUT] ─► [P3 artifact verification RO] ─► [P4 isolated drill (assurance)]
                                                                                        │
[E1 create production-backup env MUT] ─► [E2 install entry script + restricted key MUT] ─► [E3 environment secrets MUT]
                                                                                        │
                                              [E4 turn the activation guard on MUT] ◄───┘   (after P3, and P4 if decided)
                                                        │
                                              [E5 first scheduled run + freshness RO]
                                                        │
                                       [C1 M2 record → M2 CERTIFIED on the owner's merge]
                                                        │
          ══════ M3 boundary: G7 under its own authorization, within the freshness window of §10 ══════
```

| # | Step | Class | PASS / STOP |
|---|---|---|---|
| D1 | Review this design; record the §12 decisions | repository documentation | decisions recorded |
| I1 | Implementation PR (§5), activation guard off | repository code | `core-ci-passed`; owner merge after E1 |
| P1 | Preflight: host key; Organization `VERIFIED/fresh/false` with digest D, Auth marker `local`, zero `hierarchy_authority_event`, `AUTH_EVENTS=off`; containers healthy and ready; running images equal to the 2026-10-12 baseline; backup directory modes; recipient fingerprint and no private-key line; status stamps; key-authentication availability. The owner-workstation SSH refusal of 2026-10-14 (G6 record §5.4) is resolved first, or P1 runs at the console | PRODUCTION READ-ONLY | every value as expected, else STOP |
| P2 | `core-backup.yml`, `services="organization-service auth-service"`, approved in `production` | PRODUCTION MUTATION | exit 0, one stamp; exit 1: STOP, no blind retry; exit 3: backup intact, STOP to investigate |
| P3 | §10 mandatory verification | PRODUCTION READ-ONLY | all equal, else STOP |
| P4 | §10 isolated drill, if decided | recovery environment (reads the production backup objects) | both drills PASS, else STOP: the backup is not recoverable and no cutover step proceeds |
| E1–E3 | Environment; entry script and restricted key; secrets | PRODUCTION MUTATION, each separately authorized | as designed |
| E4 | Activation guard on | PRODUCTION MUTATION | — |
| E5 | First scheduled run observed; freshness check | PRODUCTION READ-ONLY | success; `last-success` within 24 h |
| C1 | M2 record: run ids, stamp, manifest digests, P1/P3/P4 output digests, installed script hash, the pre-G7 backup labelled "valid until F6" | repository documentation | **M2 CERTIFIED** on the owner's merge |

**STOP at any step:** a result differs from the runbook or this design; a secret, address or credential appears in output; anything
unplanned touches production; a G6-preserved artifact would be touched. On STOP: record, do not correct automatically, escalate to the
owner.

## 12. Open owner decisions (before implementation)

| # | Decision |
|---|---|
| OD-M2-1 | Scheduling model: the restricted-SSH GitHub Actions model of §5, or the server timer alternative (which supersedes D-2) |
| OD-M2-2 | Activation guard: reuse the variable name `CORE_BACKUP_SCHEDULE` (the roadmap's name; its old meaning was removed) or a new name |
| OD-M2-3 | Cron time (formerly 02:17 UTC) and the freshness-check threshold |
| OD-M2-4 | Account of the forced command: the runtime user (proposed) or a dedicated system account |
| OD-M2-5 | Historic evidence versus retention: §7 option 1, 2 or 3 |
| OD-M2-6 | Old recovery keys: kept indefinitely, or until their last backup set is deleted |
| OD-M2-7 | The freshness check of §9 and its list/head-only bucket credential |
| OD-M2-8 | Bucket immutability (§9), and which form |
| OD-M2-9 | The recovery environment: which machine (never the G6 guest), its image access (read-only registry credential or offline transfer) and a read-only bucket credential |
| OD-M2-10 | The isolated drill (§10): required for M2 or optional; the PostgreSQL pin; the service images |
| OD-M2-11 | Freshness: confirm 24 h, measured from the stamp to `ownership approve`; whether a verified scheduled backup can be the pre-G7 recovery point; whether digest deployments before G7 require a new backup |
| OD-M2-12 | The production access path for P1 and E2 after the 2026-10-14 SSH refusal |

## 13. Boundary

M2 ends when its record (C1) is merged. M3 starts only under its own authorization: the production Tier B configuration checks and the
first digest deployments (G6 plan §16.1; R3 installed before any Auth image carrying the readiness check), G7 with the reference of R8,
F6, F7 and the post-F7 backup. Nothing in this document changes G7, F6, F7 or Final Core Validation, which stays the absolute last.
