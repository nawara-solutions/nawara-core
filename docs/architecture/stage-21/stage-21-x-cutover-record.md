# Stage 21.x — production ownership cutover: evidence record

- **Status:** RECORD — evidence of steps already executed, and the current gate status as of 2026-09-30. This record authorizes
  nothing: every further production step is a separate, reviewed and authorized checkpoint.
- **Scope:** ADR-0040 fresh path (A2.5, F1–F7) and gates G1–G7, plus the Stage 21.x T1 relay gate.
- **Later status:** dated later-status notes are appended as [§10](#10-later-status-note-2026-10-02-v2-a) and
  [§11](#11-later-status-note-2026-10-03-v2-a2). Sections 1–9 are unchanged and remain the record as of 2026-09-30.
- **Related:** [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md),
  [G1 topology](stage-21-x-g1-organization-topology.md), [G6 rehearsal plan](stage-21-x-g6-rehearsal-plan.md),
  [organization-production runbook](../../runbooks/organization-production.md),
  [core-backup-restore runbook](../../runbooks/core-backup-restore.md),
  [core-rabbitmq-production runbook](../../runbooks/core-rabbitmq-production.md).

Status vocabulary used below:

| Status | Meaning |
|---|---|
| EXECUTED / CERTIFIED | executed in production (or in the recovery environment) and certified by a read-only verification |
| EXECUTED / PASSED | executed and passed; no mutation was involved |
| DEFERRED | intentionally postponed by the owner; not executed |
| BLOCKED | cannot start until the named prerequisite is certified |
| OPEN DECISION | an owner decision is required before the named step |
| NOT EXECUTED | nothing has run |

Where a detail could not be recovered from the repository or local evidence, the record says: *Evidence reference unavailable
locally — previously executed result requires later evidence attachment.*

## 1. Purpose and scope

This is the Stage 21 production ownership-cutover evidence record. It preserves, outside chat history, temporary files and
session memory, the results of the steps already executed against production and the current state of every gate. It records
identifiers, digests, counts and results only: no password, token, TOTP secret, key or connection string.

## 2. Certified baseline

| Item | Value |
|---|---|
| Certified code revision | `9e29c763179dc954e668d6287a07098c0450decf` (merge of PR #150) |
| Environment class | **fresh** (ADR-0040 A2.5): the cutover follows F1–F7, not E0–E7 |
| Production runtime root | `/home/ubuntu/nawara-core` (commands run as `ubuntu`) |
| Company (production, reference only) | `91bf0f27-6f5a-4883-a140-2b211d6759ed` / `nawara-solutions` |
| Organization ownership state | `VERIFIED` / `fresh` / `authoritative=false`; not approved, not activated |
| Ownership content digest (D) | `d034e78099cd557f98dd4d9ee0ca72045df1118a661c5076b6c8a2913c3788c8` |
| Auth hierarchy authority | `hierarchy_authority.mode = local`; `hierarchy_authority_event` count 0 |
| `AUTH_EVENTS` | `off` |
| Auth image (running) | `ghcr.io/nawara-solutions/nawara-core-auth-service@sha256:e6279588ffc4742d356d812858964fdc81903c762c3daa9a71bd00c179c9a7ee` (tag `sha-9e29c763…`) |
| Organization image (running) | `ghcr.io/nawara-solutions/nawara-core-organization-service@sha256:76734d81b620b556b3915ef465fa4ef684af236d3a2e8de61aa039b08514e49d` (tag `sha-9e29c763…`) |
| Audit image (running) | `ghcr.io/nawara-solutions/nawara-core-audit-service@sha256:a8dade8c5e4c2bf8efde34d208814d6c441a102bd1c54a9b10ac33dff88e4554` (tag `sha-cf42b9cd…`; see §5) |

**F4-R1 provenance exception (narrow, owner-accepted).** Before F4, Auth had last been deployed at `96800ce` (an automatic build),
not `9e29c763`. The read-only delta `96800ce → 9e29c763` was Class C: every Auth image input, library, package file and Auth
workflow was identical. The owner accepted this exception for exactly that revision pair only; it is not a general rule. F4-M3 then
deployed Auth at `9e29c763`.

## 3. Gates G1–G5 and steps F1–F5

### 3.1 Gates

| Gate | Status | Evidence |
|---|---|---|
| **G1** topology | EXECUTED / CERTIFIED (owner: "G1 CLOSED") | PR #144 (`96800ce`); post-merge production verification. Detailed check counts: *Evidence reference unavailable locally — previously executed result requires later evidence attachment.* Note: the G1 topology document's status line still reads "G1 approval pending"; it was not updated by this record. |
| **G2** migration classification / **G3** roles before migrations | EXECUTED / CERTIFIED (owner: "G1–G3 production prerequisites CERTIFIED") | PR #145 (`9c24079`). Detailed check counts: *Evidence reference unavailable locally — previously executed result requires later evidence attachment.* |
| **G4** monitoring | rules and implementation COMPLETE; **live demonstration DEFERRED** (part of G6-D) | PR #146 (`dbc6fc8`); runbook `organization-production.md` §6 ("demonstrated in the G6 rehearsal: pending") |
| **G5** backup and restore | EXECUTED / CERTIFIED (tooling, Auth and Organization real-volume drills) | see §3.2 |

### 3.2 G5 backup and restore

| Item | Status | Evidence |
|---|---|---|
| Tooling and local certification (A1) | CERTIFIED | PRs #147 (`51f673d`), #148 (`95aac56`), #149 (`6a3e871`); local end-to-end drill in `core-backup-restore.md` §8 |
| First production Auth backup (A2) | EXECUTED / CERTIFIED | stamp `20260929T103715Z`. Workflow run id: *Evidence reference unavailable locally — previously executed result requires later evidence attachment.* |
| Auth real-volume restore drill (A3) | EXECUTED / CERTIFIED ("A3 CERTIFIED — AUTH REAL-VOLUME RESTORE PASSED") | backup `20260929T103715Z`; image `ghcr.io/nawara-solutions/nawara-core-auth-service@sha256:b0d9d805dc86ce004aad5be89abab22cddfc5ec572a02143a2f1002477997c1f`. Check and fact counts: *Evidence reference unavailable locally — previously executed result requires later evidence attachment.* |
| Organization production backup | EXECUTED / CERTIFIED | `SERVICE=organization-service`, `STAMP=20260929T225442Z`, run `36642277446` (2026-09-29, `9e29c763`) |
| Organization real-volume restore drill (recovery environment) | EXECUTED / CERTIFIED | 11/11 checks PASS; 50 restore facts matched the backup; application-level GET of the known Company succeeded; `DRILL_EXIT=0`; drill containers, volumes and plaintext work directory removed; containers and volumes identical to the baseline afterwards; `BACKUP_KEY_PASSPHRASE` unset; no persistent GHCR credential |
| RPO / RTO / retention (G5 D3) | owner decision | RPO 24 h, RTO 4 h, 30 daily backups (`core-backup-restore.md` §1) |
| Daily production backup schedule | NOT EXECUTED (not enabled) | gated by repository variable `CORE_BACKUP_SCHEDULE`; the scheduled run of 2026-09-30 was skipped |

Both drills are certified and are **not** repeated (G6 plan §7).

### 3.3 Fresh-path steps F1–F5

| Step | Status | Evidence |
|---|---|---|
| **F1** Organization provisioning | EXECUTED / CERTIFIED | ownership `PREPARED` / `fresh`; first `ownership_event` = `declare-class` / `succeeded`; provisioning caller registered. Workflow run ids for the individual F1 steps: *Evidence reference unavailable locally — previously executed result requires later evidence attachment.* |
| **F2** first Company | EXECUTED / CERTIFIED | Company `91bf0f27-6f5a-4883-a140-2b211d6759ed` / `nawara-solutions`; hierarchy Company / Platform / Organization = `1 / 0 / 0` |
| **F3** initial hierarchy | CERTIFIED as a no-op by design | Platforms and Organizations are created after activation (ADR-0040 A2.5; OPEN-5); read-only evidence `1 / 0 / 0`, `PREPARED / fresh / f` |
| **F4** Auth reference and bootstrap owner | EXECUTED / CERTIFIED (closed) | see §3.4 |
| **F5** ownership verification | EXECUTED / CERTIFIED | see §3.5 |

### 3.4 F4 checkpoints

| Checkpoint | Result |
|---|---|
| F4-R1 baseline | CERTIFIED (Part A; the Class C exception of §2; Part B runtime, database and exposure; filesystem correction 21/21) |
| F4-R2 precheck | CERTIFIED 9/9 |
| F4-M1 register the `auth-service` caller | EXECUTED once (exit 0); F4-V1 CERTIFIED 33/33 |
| F4-M2 Organization redeploy | run `36696681623` at `9e29c763`, success; image `sha256:76734d81…e49d`; F4-V2 CERTIFIED 56/56 |
| Pre-M3 baseline | CERTIFIED 36/36 |
| F4-M3 Auth redeploy | run `36699283208` at `9e29c763`, success; image `sha256:e6279588…a7ee`; only new keys `ORGANIZATION_SERVICE_URL` / `ORGANIZATION_SERVICE_TOKEN`; F4-V3 CERTIFIED 71/71 |
| Pre-M4 baseline | CERTIFIED 31/31 |
| F4-M4 `bootstrap-owner` | EXECUTED once, 2026-09-30T10:28:46Z, "owner created", exit 0; the one-off container was removed. **Never rerun.** |
| F4-V4 | CERTIFIED 56/56: one Company, one owner, one owner user (role `admin`, active, no membership), no factor, no outbox row, Auth audit 7, marker `local`, Organization unchanged |
| F4-V5 | no-op (fully covered by F4-V4) |

### 3.5 F5

| Checkpoint | Result |
|---|---|
| F5-P preflight | CERTIFIED 35/35 at 2026-09-30T10:53:27Z; D computed by `ownership status` (read-only) |
| F5-M1 `ownership verify --expect-digest D` | EXECUTED once, 2026-09-30T11:01:47Z; `verified`; phase `VERIFIED`; exit 0; correlation id `167198f7-17d7-4593-983a-cb39d8afbc1e`. **Never rerun.** |
| F5-V1 | CERTIFIED 38/38: `VERIFIED` / `fresh` / `false`, `verified_digest` = D, two `ownership_event` rows (`declare-class`, `verify`), both `succeeded`, none rejected |

## 4. T1 — Auth → RabbitMQ → Audit relay

**Status: EXECUTED / CERTIFIED.**

| Checkpoint | Result |
|---|---|
| T1-P preflight | CERTIFIED 26/26 effective (original run 23 PASS / 3 FAIL caused by a helper defect in the check block; repair block 3/3; the original result is preserved) |
| T1-A final guard | PASS 17/17 |
| Enrollment | cycle **#6** was the successful enrollment cycle; confirmed once, 2026-09-30T16:38:35Z. **Do not rerun.** |
| Relay observation (Checkpoint A) | T1-A PASS=12 FAIL=0 TOTAL=12, exit 0 |
| T1-V1 first run | 44/45 — see below |
| **T1-V1 corrected (final)** | **PASS=45 FAIL=0 TOTAL=45, exit 0** |

Non-secret identifiers of the certified result:

| Identifier | Value |
|---|---|
| factorId (TOTP, confirmed, unrevoked) | `7f760007-9070-4d1f-884d-76af4813bf9d` |
| correlationId | `t1-owner-20260930T163820Z` |
| eventId (`outbox.id` = `audit_record.eventId`) | `6fc5f8ca-6567-4b6a-9f9a-73a7b9876d45` |

The corrected T1-V1 proved: exactly one TOTP factor, confirmed and unrevoked; six enrollment challenges (cycles #1–#5 expired and
unconsumed, #6 consumed); six `owner.login.password` successes; one `owner.factor.enrolled`; one enrollment-method `owner.login`;
no T1-scoped failure; Auth audit total 15; the outbox event exactly once and published; the Audit queue settled and the dead-letter
queue empty; the central audit record with the owner as actor; eventId / correlationId / factorId continuity; `AUTH_EVENTS=off`;
Auth marker `local`; Organization `VERIFIED`, not authoritative, not approved, not activated, digest D unchanged; all services
healthy and ready; container identities, networks, exposure and retained previous containers unchanged.

**The earlier 44/45 validation issue.** The only failing check counted a legitimate pre-T1 row: `auth.login` / failure at
2026-09-18T18:57:51Z (actor NULL), before the first T1 login (2026-09-30T11:38:53Z). The pre-T1 audit baseline is exactly 7 rows.
The corrected check requires zero failures at or after the first T1 login **and** the pre-T1 total of exactly 7. This was a check
defect, not a production defect.

**Enrollment incident (recorded for audit).** In cycle #1 the TOTP secret of factor `d4f11b1f-3fd7-40a8-a5a1-5d6d1ef57f01` was
disclosed outside the operator session. That factor was never confirmed. Per the source (`beginTotp` deletes the owner's unconfirmed
TOTP factors before inserting a new one), the next enrollment replaced it. Cycles #2–#5 expired unconfirmed (time and transcription
issues). Cycle #6 used a QR code and was confirmed. No secret is recorded here.

## 5. G6-A — extended production fingerprint

**Status: EXECUTED / PASSED (certified, read-only).** G6-A PASS=3 FAIL=0 TOTAL=3, exit 0 (2026-09-30). **Do not rerun.**

- Block: 57 lines, SHA-256 `ef4c28c338a6027880f2ca99345eac708a48342d37cf7eaca09e7a7d46299715`, transported by a local launcher that
  checks the hash before sending and again on the server before running.
- Guards: Organization `VERIFIED|fresh|false|d034e780…c8c8`: PASS. Auth marker `local`: PASS. `AUTH_EVENTS=off`: PASS.
- An earlier attempt stopped at `sudo` (no terminal for the password) before any fingerprint command ran; it is not counted as an
  execution.

Production parity targets captured by G6-A:

| Area | Production value |
|---|---|
| OS / kernel | Ubuntu 24.04.4 LTS / `6.8.0-142-generic` |
| Docker | Server 29.1.3; storage `overlayfs`; logging `json-file`; cgroup `systemd` |
| PostgreSQL | 16.15, `postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` (`postgres:16-alpine`) |
| RabbitMQ | 3.13.7, `rabbitmq:3.13.7-alpine@sha256:d7af1c87c5f1eda13fcfca06db452bf3aeab6619fc3358b68535c0c02c4e52bc` |
| Auth image | `@sha256:e6279588ffc4742d356d812858964fdc81903c762c3daa9a71bd00c179c9a7ee` |
| Organization image | `@sha256:76734d81b620b556b3915ef465fa4ef684af236d3a2e8de61aa039b08514e49d` |
| Audit image | `@sha256:a8dade8c5e4c2bf8efde34d208814d6c441a102bd1c54a9b10ac33dff88e4554` (tag `sha-cf42b9cdc67589bc4e59446e9589096506ab6af9`) |
| Auth migrations | 11; last `0011_code_event_purge_index.sql`; names+checksums MD5 `b8139c05c1f49393d5ee049464403392` |
| Organization migrations | 8; last `kit_0003_generic_triggers.sql`; names+checksums MD5 `72f2bc1b737a40feca121ccff6fe8ffd` |
| Audit migrations | 6; last `kit_0003_generic_triggers.sql`; names+checksums MD5 `0006a2adda45c36073ef8defa8af7bb2` |
| Network `nawara-core-internal` | driver `bridge`, `internal=true` |
| Network `deploy_edge` | driver `bridge`, `internal=false` |
| Production Docker logging | `json-file`; rotation **deferred** (plan D-10); unchanged |

**Audit image observation.** Production's audit-service runs the image built at `cf42b9cd`, not `9e29c763`. Between those
revisions no file changed in `apps/audit-service`, `libs/`, `package.json` or `package-lock.json`, so the build inputs are identical.
Production was not changed; the G6 rehearsal uses production's actual audit digest.

The remaining G6-A output (per-container restart policy, log options, health checks, networks and environment variable names;
RabbitMQ vhosts, users and tags, permissions, topic permissions, exchanges, bindings and queues): *Evidence reference unavailable
locally — previously executed result requires later evidence attachment.* G6-B needs it for broker and runtime parity.

## 6. Current G6 status

| Checkpoint | Status |
|---|---|
| G6-P owner decisions (D-1…D-17) | COMPLETE |
| G6-P1 rehearsal plan | COMPLETE — PR #151 (merge `4ac4d8a`); file SHA-256 `864545d8003be74259f26ae79a7880d5411d4c458e1751703c182395accda671` |
| **G6-A** | **CERTIFIED** |
| **G6-B** | **DEFERRED** |
| **G6-BV** | **DEFERRED** |
| **G6-C** | **DEFERRED** |
| **G6-D** | **DEFERRED** |
| **G6-E** | **DEFERRED** |
| **G6-F** | **DEFERRED** |
| **OVERALL G6** | **NOT CERTIFIED** |

**Reason.** The approved rehearsal (plan D-1) requires a disposable, isolated Ubuntu VM. That requirement remains approved. Where
the VM runs and which virtualization technology hosts it are not specified by the plan and remain an owner decision. The owner has
intentionally deferred the rest of the rehearsal. No rehearsal VM, firewall rule or GHCR rehearsal credential has been created.

Dependencies recorded for when G6-B resumes: the Core packages on GHCR are private, so plan D-16's dedicated read-only credential
must be created first; and if the VM host shares a network with production, a host-side egress block is needed before G6-BV.

## 7. Downstream gates

| Step | Status |
|---|---|
| Fresh pre-G7 production Auth + Organization backup | **BLOCKED BY G6** |
| Verify the pre-G7 backup artifacts | **BLOCKED BY G6** |
| Enable `CORE_BACKUP_SCHEDULE` | **BLOCKED BY G6** |
| **G7** `ownership approve --reference …` | **BLOCKED BY G6** |
| **F6** ACTIVATE AUTHORITY and the Auth mirror | **BLOCKED BY G6/G7** |
| **F7** retirement and post-activation verification | **BLOCKED BY F6** |
| Post-F7 Auth + Organization backup | **BLOCKED** |
| Opening other callers | **BLOCKED** |
| Stage 22 Final Core Validation | **BLOCKED / ABSOLUTE LAST** |

Sources: `organization-production.md` §3 (G7 "only after G1–G6 **and T1**"); ADR-0040 G7; G6 plan §12 and §13.

## 8. Open decision — F6/F7 image pinning

**Status: OPEN DECISION** (mandatory before G6-C resumes; not resolved by this record).

- **Fact:** the deploy workflows (`auth-service-deploy.yml`, `organization-service-deploy.yml`, `audit-service-deploy.yml`) are manual
  (`workflow_dispatch`, `--ref main`). They build and tag the commit that `main` points to at dispatch time
  (`sha-${{ github.sha }}`).
- **Fact:** the production-certified code revision is `9e29c763179dc954e668d6287a07098c0450decf`.
- **Fact:** later documentation merges moved `main` forward (PR #151 to `4ac4d8a`, a documentation-only delta). A redeploy dispatched
  now would build a new image with a new digest, not the certified digests of §2 and §5.
- **Consequence:** F6's Auth mirror and F7 involve redeploys. Unless the redeploy is pinned, production could receive an image the
  G6 rehearsal did not use. Any Auth, Organization, audit-service or `libs/service-kit` code merged before F7 would reach production
  unrehearsed.
- **Decision required:** how the G6 rehearsal, F6 and F7 guarantee the exact rehearsed and certified image and code identity.

No workflow was changed, and nothing was rebuilt or redeployed.

## 9. Safety invariants

- Retained previous containers are **never cleaned automatically**:
  - Auth: `nawara-core-auth-service-previous-20260928152226`, `-20260928163229`, `-20260930095759`;
  - Organization: `nawara-core-organization-service-previous-20260929221533`, `-20260930093308`.
- Already-certified mutation and verification steps (F2, F4-M4, F5-M1, the T1 enrollment, the backups and restore drills, T1-V1,
  G6-A) are **not rerun** without a specific, stated evidence reason and a new authorization.
- The production cutover (G7, F6, F7) **remains locked** until G6 is certified.
- Production keeps `AUTH_EVENTS=off`, the Auth marker `local`, and Organization `VERIFIED` / not authoritative until the authorized
  cutover steps change them.
- A pre-F6 Organization backup is never restored after F6 (`core-backup-restore.md` §7).
- The GitHub production deploy workflows are never used for the G6 rehearsal.
- **Stage 22 Final Core Validation remains the absolute last full Core validation.**

## 10. Later-status note (2026-10-02, V2-A)

This note is appended after the record was written. It does not change any fact above: §1–§9 remain the certified state as of
2026-09-30. Source: the [V2-A record](../core-v2-a-baseline-and-change-safety.md).

- **Auth image drift.** The Auth image in §2 and §5 (`sha256:e6279588…a7ee`, built at `9e29c763`) was the certified running image
  at that checkpoint. Afterwards, seven merges to `main` that touched the automatic deployment paths of
  `auth-service-docker-build.yml` (`093e3ee`, `b20bbab`, `08475a5`, `52160a2`, `fe5d106`, `fd8c743`, `97f78cb`) each completed its
  `build-production` and `deploy-production` jobs successfully, the last on 2026-10-02T07:38Z. Production Auth therefore no longer
  runs the digest recorded above. The digest it runs has **not** been verified on the server; it must be established read-only
  before G6 resumes.
- **§8 scope.** §8 lists only the manual deploy workflows. The automatic Auth path above also deploys production on merge, so the
  open image-pinning decision covers it too. The accepted future direction (V2-A) is: a merge builds an immutable image, and production
  is deployed only by an explicit, owner-authorized deployment of an exact digest. It is not implemented (V2-A.2 needs its own
  authorization), and adopting it as the §8 answer remains an owner decision.
- **Organization and audit-service.** Not redeployed since §2 and §5. `main` now contains their localization changes (Core V1
  refactor R6.1, R6.2), which production does not run. Whether to redeploy them before G6 is an owner decision for the G6 refresh.
- **Migrations.** No migration changed after `9e29c763`; the §5 migration fingerprints still describe the schemas.
- **G6 status.** Unchanged: **DEFERRED**, not cancelled, waived or passed. Before G6 resumes, the refresh re-establishes the §5 parity
  targets (images and digests, migrations, PostgreSQL, RabbitMQ topology, retained containers, artifact pinning, deployment
  automation) for the system as it is then. §7's order is unchanged; G7, F6 and F7 remain locked.
- **Stage 22.** Final Core Validation remains the absolute last full Core validation. By owner decision (V2-A) it runs after the planned
  Core/platform work, including Core V2, and after the required production gates; not immediately after F7.

## 11. Later-status note (2026-10-03, V2-A.2)

Appended; §1–§10 are unchanged. Source: the [V2-A.2 certification record](../core-v2-a-2-certification.md).

- **Auth deployment.** Since PR #187 (`7295e8e`, 2026-10-02T23:35:56Z) a merge to `main` only builds an Auth image; production Auth
  changes only by an explicit, owner-authorized deployment of an exact index digest. The automatic path described in §10 no longer
  exists. Organization and audit-service deployments are unchanged, so the §8 decision stays open for them; adopting digest deployment
  as the §8 answer remains an owner decision.
- **Running Auth image (observed, not a certified parity target).** On 2026-10-02 the owner observed, read-only, production Auth running
  `sha256:26164d42b5d225b756a450e976e0e23c1142f49be6eb68ff9fad177cb1e05eaf` (container started 2026-10-02T07:38:13Z, healthy,
  configured as `:production`): the image of the last automatic deployment (`97f78cb`), not the §2 and §5 digest. The G6 refresh
  re-establishes the parity targets when it runs.
- **G6, G7, F6, F7, Stage 22.** Unchanged: G6 deferred; G7, F6 and F7 locked; Final Core Validation absolute last.
