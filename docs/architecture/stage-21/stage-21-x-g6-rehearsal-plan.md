# Stage 21.x G6 — production-like rehearsal plan

- **Status:** PROPOSED — owner decisions approved 2026-09-30; recorded here before any rehearsal step runs.
- **Gate:** ADR-0040 decision 7, G6 (and the parts of G4 and G5 that ADR-0040 assigns to the rehearsal plan).
- **Revision under rehearsal:** `9e29c763179dc954e668d6287a07098c0450decf`. *Superseded by the 2026-10-12 refresh (§15): the rehearsal
  uses the conditionally approved certified digest set (§15.2), once its conditions pass.*
- **Refresh (2026-10-12):** §15 refreshes this plan after the G6 baseline refresh. Where §15 states a change, it governs; the text above
  is kept as history. **G6 is not authorized by this plan or its refresh.**
- **Amendment (2026-10-12, §16):** owner decisions recorded: the digest set is **FINALLY APPROVED for isolated G6 rehearsal use
  only** (not for production deployment); the PostgreSQL image difference is accepted as a documented rehearsal limitation; the
  rehearsal VM runs on `nawara-lab-01` under QEMU/KVM; G6-BV is split into G6-BV-I (PASS WITH LIMITATIONS) and G6-BV-S (NOT STARTED).
  **G6-C is not authorized.**
- **Record of results:** [`stage-21-x-g6-rehearsal-record.md`](stage-21-x-g6-rehearsal-record.md) (written after the rehearsal).

## 1. Purpose

G6 is **one successful production-like rehearsal of the complete ownership-transition procedure**, including authority
activation, recorded with evidence, before the real production activation is approved (G7) and performed (F6). F6 is the
no-rollback boundary of a fresh environment (ADR-0040 A2.6): G6 proves the procedure, the monitoring, and backup and restore
**in an environment where activation is harmless**.

**G6 never runs against production.** ADR-0040 decision 7: the gates govern the real production activation and "do not gate
… running a non-production rehearsal"; the rehearsal includes "authority activation", which on production *is* F6.

## 2. Sources

| Source | What it requires of this plan |
|---|---|
| ADR-0040 decision 7, **G6** | one production-like rehearsal of the whole procedure; unit tests are not a rehearsal; this plan defines "production-like" and the approver accepts it |
| ADR-0040 **G4** | the minimum monitoring and alerting is demonstrated in the rehearsal; thresholds and log retention are set here; the owner may adjust the minimum list here |
| ADR-0040 **G5**, A2.8 | the owner states the RPO and RTO here before the rehearsal; this plan states how the real-volume restore requirement is met |
| ADR-0040 **G7** | the rehearsal is completed and its results recorded (environment, versions and checksums, each gate's result, deviations, the approver) before approval |
| ADR-0040 **A2.5** | the fresh-environment sequence F1–F7 (no freeze, no import) |
| ADR-0040 **A2.6** | no ownership rollback after ACTIVATE AUTHORITY in a fresh environment |
| [`organization-production.md`](../../runbooks/organization-production.md) §3, §6 | F1–F7 steps; monitoring signals and alert rules (demonstration pending G6) |
| [`core-backup-restore.md`](../../runbooks/core-backup-restore.md) §1–§7 | D3 targets (RPO 24 h, RTO 4 h, 30 daily); drill procedure; the authority boundary for restores |

## 3. Approved owner decisions (2026-09-30)

| # | Decision |
|---|---|
| D-1 | Rehearsal environment: a **disposable, isolated Ubuntu VM** with an `ubuntu` user and `/home/ubuntu/nawara-core`; Docker major version, PostgreSQL and RabbitMQ versions as recorded by G6-A; the certified image repo digests. No public DNS or TLS. |
| D-2 | "Production-like" as defined in §4; every difference from production is recorded (§5). |
| D-3 | Isolation per §6; **G6-BV is mandatory before any rehearsal mutation**. |
| D-4 | **RPO 24 h** (inherited from G5 D3), plus proof that the exact rehearsal backup checkpoint is restored. |
| D-5 | **RTO 4 h** (inherited from G5 D3); the actual recovery duration is recorded. |
| D-6 | Monitoring: **attended**; outbox relay lag threshold **60 s**; checks at every rehearsal step and every 60 s while a monitored condition is demonstrated. |
| D-7 | `hierarchy_anchor_mismatch`: the existing e2e test is the **primary evidence** (G4 owner adjustment, §8.2); **no** rehearsal-database tamper. |
| D-8 | Scope: the **fresh path** only; the existing-environment freeze / import / import verification is **N/A** (§9.2). |
| D-9 | Evidence retention: signal excerpts permanently in the G6 record; raw rehearsal logs until **F7 certification + 90 days**. |
| D-10 | Production Docker log rotation: **deferred**; not changed by G6 or this rollout; the current configuration is recorded by G6-A only. |
| D-11 | Daily production backups: a fresh **manual** Auth + Organization backup, verified, then `CORE_BACKUP_SCHEDULE=enabled` and `CORE_BACKUP_SERVICES="auth-service organization-service"`, each a separately reviewed production checkpoint, before G7. |
| D-12 | A fresh verified **pre-G7** backup is required (after G6 certification). |
| D-13 | A fresh verified **post-F7** backup is required, before other callers are opened (§12). |
| D-14 | Evidence documents: this plan and `stage-21-x-g6-rehearsal-record.md`; the G7 reference is derived from the certified record. |
| D-15 | Rehearsal VM and volumes kept stopped through **G7 + 14 days**, then destroyed with the rehearsal secrets, key pair and backup storage (if no G6/G7 issue is open). |
| D-16 | GHCR: a dedicated **read-only** package credential for the VM; never a production deployment credential; no write permission. |
| D-17 | Rehearsal backup destination: **MinIO on the VM**, rehearsal-only credentials and a rehearsal-only encryption key pair; never the production bucket. |

## 4. Definition of "production-like"

The rehearsal is production-like when, compared with the G6-A production fingerprint:

- the Auth, Organization and audit-service images are the **same repo digests**; PostgreSQL and RabbitMQ are the
  **same versions**; Docker is the **same major version**;
- the services are deployed with the **same deploy scripts streamed from the same images** and operated with the
  **same runbook blocks** (paths `/home/ubuntu/nawara-core`, `sudo -u ubuntu`), unchanged wherever applicable;
- the networks are the same: `nawara-core-internal` (internal) and `deploy_edge`; Organization and every database are internal
  only; no host port is published by a Core container;
- the broker has the same vhost, per-service identities, permissions, topic permissions, exchange, binding and queues
  (`infra/rabbitmq/provision.sh`);
- the procedure is the certified fresh path F1–F7 (§9).

## 5. Known deviations from production (recorded in the record)

| Deviation | Why it does not weaken G6 |
|---|---|
| no Traefik public route, DNS or TLS | F1–F7, monitoring and restore do not use the public route; the owner steps (T1-style) use the Auth API over the VM's internal address |
| different host hardware and host | parity is on images, versions, scripts and topology, not on the machine |
| deploys run by hand from the images, not through GitHub workflows | the workflows target production and must never be used for the rehearsal; they run the same scripts |
| backups go to MinIO on the VM with a rehearsal key pair | same `backup.sh` and `restore-drill.sh`; only the destination and key differ |
| the rehearsal Company is named `nawara-rehearsal` | prevents any confusion of evidence with production |

Any other difference found at G6-B or during the rehearsal is added here as a deviation and to the record.

## 6. Isolation requirements

The rehearsal VM must have **none** of: a Docker context or `DOCKER_HOST` pointing at production; production database, broker,
backup or GHCR-write credentials; a production `.env`, `roles.env`, `callers/` or broker client file; production deployment SSH
credentials; a production DNS change; production Docker volumes; any call to a production service. All secrets are generated
on the VM by the deploy scripts; the backup destination and key pair are rehearsal-only (D-17).

### 6.1 G6-BV — isolation verification (mandatory, read-only on the VM, before any rehearsal mutation)

**Amended 2026-10-12 (§16.4): G6-BV runs in two stages.** **G6-BV-I** (infrastructure isolation of the host and the guest) is recorded
in §16.4. **G6-BV-S** (service-level isolation) is the list below, **unchanged and in full**. It runs read-only on the guest after the
rehearsal stack, MinIO and the rehearsal credentials exist there, and before any rehearsal mutation. G6-C needs both stages.

- `docker context show` is the local default and `DOCKER_HOST` is unset;
- every service's `DATABASE_URL`, `RABBITMQ_URL` and `ORGANIZATION_SERVICE_URL` host is a VM-local container name;
- no production hostname, IP address, bucket or prefix appears under `/home/ubuntu/nawara-core` (compared by name only);
- no `DEPLOY_SSH_*` or GHCR write credential exists on the VM;
- the backup destination is the VM's MinIO and the recipient certificate fingerprint differs from production's;
- the G6-A production fingerprint is unchanged afterwards.

Any failure: **STOP**; no rehearsal mutation runs.

## 7. RPO and RTO (G5)

- **RPO 24 h.** A rehearsal backup is taken at checkpoint X; rows are written after X; then a declared loss; then a restore.
  **PASS:** the restored facts equal the backup facts at X (the drill's fact comparison), rows written after X are absent,
  and the `backup/status/*.last-success` stamp was ≤ 24 h old at the loss. **FAIL:** anything else.
- **RTO 4 h.** Timer start: the declared loss of the rehearsal Auth and Organization databases. Timer stop: both services
  answer `/ready` ready, the drill checks pass, and the authority agreement (runbook §6.2) is **MATCH** for the rehearsed phase.
  **PASS:** ≤ 4 h; the actual duration is recorded. **FAIL:** anything else.
- **Real-volume requirement:** the real-volume restore drills for Auth and Organization are **already certified** (G5) and are
  not repeated; the rehearsal restore demonstrates the procedure at the rehearsed phase.

## 8. Monitoring (G4)

### 8.1 Model and thresholds

Attended (runbook §6). Checks at every rehearsal step and every 60 s while a condition is being demonstrated. Rules marked
"immediately" in runbook §6.3 need no threshold. **Outbox relay lag: 60 s** (`nawara-check-outbox-lag --max-age-seconds 60`).

| Signal | Induced in the rehearsal by | Evidence | Restored by |
|---|---|---|---|
| readiness (both services) | stopping the Organization database container | `/ready` 503, `readiness_check_failed check=…` | starting it; `/ready` ready |
| authority agreement (MISMATCH) | `hierarchy-freeze` on Auth while Organization is not active | §6.2 output MISMATCH | `hierarchy-unfreeze` |
| failed verification / digest mismatch | `ownership verify --expect-digest <wrong digest>` | `ownership_event` rejected; `ownership_import_failed code=verification_mismatch` | none (append-only evidence) |
| `hierarchy_source_mismatch` | redeploying the rehearsal Auth with `AUTH_HIERARCHY_SOURCE=organization-service` while the marker is `local` | the startup warning | redeploying without it |
| `hierarchy_reference_*` | stopping Organization, then an Auth first touch | 503 `hierarchy_unavailable` and the log line | starting Organization |
| outbox relay failure and lag | stopping RabbitMQ, then an audited action | `outbox_publish_failure`; lag check > 60 s | starting RabbitMQ; the relay drains |

### 8.2 `hierarchy_anchor_mismatch` (owner adjustment under G4)

Not induced in the rehearsal: the application cannot produce it naturally (anchors are immutable at the authority and ids are
never reused), and the only live method would be a direct database tamper, which the owner declined. **Primary evidence:** the
e2e test `apps/auth-service/test/hierarchy-reference.e2e-spec.ts`, "an anchor that disagrees with the authority fails closed
and alerts": the request answers 503, `hierarchy_anchor_mismatch kind=organization id=…` is logged, and the cached reference is
not overwritten. The record cites the passing CI run at the rehearsed revision.

## 9. Scope

### 9.1 The rehearsed procedure (fresh path, ADR-0040 A2.5)

| Step | Rehearsal action (VM only) | PASS |
|---|---|---|
| G1–G3 | broker provisioning; audit-service; Organization deploy (roles before migrations, privilege assertion) | deploy `OK`; privileges `f\|f`, `t\|f` |
| F1 | `declare-class fresh`; provisioning caller; redeploy | `PREPARED\|fresh` |
| F2 | first Company (`nawara-rehearsal`) by the provisioning identity | `1\|0\|0` |
| F3 | none (Company only; OPEN-5) | — |
| F4 | auth-service caller; redeploy Organization and Auth; `bootstrap-owner` | reference row = Organization's; one owner |
| T1-equivalent | owner TOTP enrollment in the rehearsal (feeds the relay demonstration) | outbox → broker → audit record |
| F5 | `ownership verify --expect-digest <status digest>` | `VERIFIED` |
| rollback proof | `ownership rollback` VERIFIED → PREPARED, then `verify` again | rollback event; `VERIFIED` again |
| G7-equivalent | `ownership approve --reference REHEARSAL` | `ACTIVATABLE` |
| **F6** | `OWNERSHIP_PRODUCTION_ACTIVATION=enabled` for the run; `activate --confirm ACTIVATE-AUTHORITY`; Auth mirror (`hierarchy-retire --fresh`, `AUTH_HIERARCHY_SOURCE=organization-service`, redeploy) | `ACTIVE`; §6.2 MATCH |
| post-activation | `ownership rollback` is refused (`rollback_after_activation`) | refusal recorded |
| **F7** | `ownership retire --evidence`; post-activation verification | `RETIRED`; MATCH; digest unchanged |
| health / readiness | every step | ready |
| backup / restore | §7 | RPO and RTO PASS |
| monitoring | §8 | every signal observed |

### 9.2 Not rehearsed: the existing-environment path

Freeze, import and import verification (ADR-0040 E1–E7) are **N/A**: the production environment is the certified **fresh**
environment, whose sequence (A2.5) is "the same activation model without the legacy steps". The existing-environment path is
not rehearsed.

## 10. Evidence (the G6 record)

The record `stage-21-x-g6-rehearsal-record.md` contains: the rehearsal environment id; dates and times; the Git revision; the
image repo digests (rehearsal and production, from G6-A); migration fingerprints; PostgreSQL, RabbitMQ and Docker versions;
broker topology; a configuration fingerprint (variable **names** only); the rehearsal ownership digest; each step's and gate's
result; the monitoring demonstration results (excerpts); the e2e evidence for §8.2; the backup and restore results with the
measured RPO and RTO; all deviations (§5); the operator; the approver; the final result; and the **G7 reference**
`G6-REHEARSAL-<YYYYMMDD>@<commit of the certified record>`.

## 11. Retention and cleanup

- **Signal excerpts:** the monitoring, backup and procedure evidence excerpts are kept **permanently** in the G6 record.
- **Raw rehearsal logs:** kept until **F7 certification + 90 days**, then destroyed under this cleanup policy.
- **Rehearsal VM and volumes:** kept **stopped** through **G7 + 14 days**.
- **Condition for destruction:** the VM is destroyed only when that period has passed **and** no G6 or G7 issue is open; an open
  issue extends retention until it is resolved.
- **On destruction:** the VM, all rehearsal secrets, the rehearsal encryption key pair and the rehearsal MinIO backup storage are
  destroyed together.
- **Production retained containers** (the Auth and Organization `-previous-` containers) are unrelated to G6 and are never
  touched.
- **Production Docker logging** is unchanged: rotation is deferred (D-10) and G6-A only records the current configuration.

## 12. Production safety boundary and checkpoint sequence

The rehearsal changes nothing in production: production data, production retained containers and the production logging
configuration are untouched by G6. The GitHub production deploy workflows are **never** used for G6. Every production-affecting
step after G6 is a separate checkpoint, reviewed and authorized on its own. The complete sequence:

1. **G6-P1** — this plan recorded in the repository.
2. **G6-A** — extended production fingerprint (READ-ONLY).
3. **G6-B** — provision the isolated rehearsal VM (VM only).
4. **G6-BV** — isolation verification (READ-ONLY on the VM; mandatory before any rehearsal mutation).
5. **G6-C** — F1–F7 rehearsal on the VM, including the rollback proof and ACTIVATE (VM only, step by step).
6. **G6-D** — monitoring demonstrations (VM only, signal by signal).
7. **G6-E** — backup and restore with RPO and RTO measurement (VM only).
8. **G6-F** — the G6 evidence record.
9. **G6 CERTIFIED.**
10. Fresh **manual** Auth + Organization production backup (production checkpoint).
11. Verify the backup artifacts.
12. Enable the daily production backup schedule: `CORE_BACKUP_SCHEDULE=enabled`,
    `CORE_BACKUP_SERVICES="auth-service organization-service"` (production checkpoint).
13. **G7** — `ownership approve --reference <G6 record reference>` (production; reversible by rollback until F6).
14. **F6** — ACTIVATE AUTHORITY and the Auth mirror (production; **no fresh-environment rollback**, ADR-0040 A2.6).
15. **F7** — retirement and post-activation verification.
16. Fresh post-F7 Auth + Organization production backup.
17. Verify the backup artifacts.
18. Open other callers (the last part of F7).

A pre-F6 Organization backup is **never** restored after F6 (`core-backup-restore.md` §7).

## 13. PASS, FAIL and STOP

- **G6 PASS:** G6-BV passes; every §9.1 step reaches its PASS result; every §8.1 signal is observed and restored; the §8.2
  evidence is cited; RPO and RTO PASS; the record is complete and approved.
- **G6 FAIL:** any of the above is not met.
- **STOP** (at any step): an isolation check fails; a result differs from the runbook; a monitored signal is not observed; a
  secret appears in output; anything touches production. On STOP: record the deviation, fix it in the rehearsal only, and repeat
  the affected step. G7 cannot proceed while G6 is not certified.

## 14. Next checkpoint

**G6-A**, the extended production fingerprint (READ-ONLY): OS and kernel, Docker version and drivers, each container's image
and repo digests, log configuration, restart policy, health check, networks and environment variable **names**; network
`Internal` flags; PostgreSQL versions; migration fingerprints; RabbitMQ version, vhosts, users (tags), permissions, exchanges,
bindings and queues; and three guard checks (Organization `VERIFIED|fresh|false|<digest>`, Auth marker `local`,
`AUTH_EVENTS=off`). Prepared block: sha256 `ef4c28c338a6027880f2ca99345eac708a48342d37cf7eaca09e7a7d46299715`. Its output fixes
the version parity targets of §4.

## Later-status note (2026-10-04, V2-A.3 / A3.5)

Appended; the plan above is unchanged. Step 12 of §12 ("Enable the daily production backup schedule: `CORE_BACKUP_SCHEDULE=enabled`")
describes a mechanism that no longer exists on current `main`: `core-backup.yml` is dispatch-only and bound to the protected `production`
environment. Scheduled backups return through a future, separately reviewed `production-backup` environment and job; that step is to be
carried out through that design when the time comes, and stays after G6 as planned. The steps that run through GitHub workflows (the backups of
steps 10 and 16, and the service redeploys within F6 and F7) now each need a `production` environment approval; commands the operator
runs on the server are not affected. The G6 refresh must take this into account.

## 15. Refresh (2026-10-12)

Owner-authorized documentation refresh. It prepares G6 for execution and **authorizes nothing**: no rehearsal step, no digest
deployment, no production change. Every step in §15.8 needs its own explicit owner authorization. Where this section changes §1–§14,
it governs; the earlier text is kept as history. Sources: the [cutover record](stage-21-x-cutover-record.md) §14; the
[A5.4 operational draft](../core-v2-a5-4-operational-runbooks.md) §2.4–§2.8; the
[F6 readiness decision record](../core-v2-a5-4-f6-transitional-readiness.md); the
[A5.4-A5 design](../core-v2-a5-4-a5-readiness-design.md) §10; the [R2 review](../core-v2-a5-r2-restore-drill-review.md) §5.

### 15.1 Production baseline (G6 baseline refresh, 2026-10-12)

Read-only, run by the owner on 2026-10-12, 11:16:41–11:16:52 UTC. **Evidence kind: OWNER-SUPPLIED TERMINAL EVIDENCE**, not
independently collected. The result is recorded in the [cutover record](stage-21-x-cutover-record.md) §14: identity PASS (trusted SSH
host key matched), all guards PASS, readiness PASS, agreement MATCH, and no change made. Production runs older images that are not in
the candidate set and carry no revision label. The detailed parity values (OS, Docker, PostgreSQL, RabbitMQ, migration fingerprints,
broker topology, configuration names) are held in the owner's terminal output and are **not transcribed here: PENDING attachment
before G6-B**. G6-A (§14) stays certified and is not rerun.

### 15.2 Certified digest set: CONDITIONALLY APPROVED (2026-10-12), not deployable

Replaces "the certified image repo digests" of D-1 and §4. Approved conditionally by the owner on 2026-10-12, **for the rehearsal
identity only**; it authorizes no deployment.

| Service | Index digest (`ghcr.io/nawara-solutions/…`) | Revision | Build run (push to `main`) |
|---|---|---|---|
| auth-service | `nawara-core-auth-service@sha256:5877c6ad5a4a4ac4b7858efce794abf9ba65c5162dc9fc8f569fdef384ec35ed` | `64ad8e3` (PR #291) | 38091302948 |
| organization-service | `nawara-core-organization-service@sha256:61221d5445f46045cfb9fd99ee38b42833568dfb1f577f853699d5f7acb9ca60` | `564a30f` (PR #283) | 38073779269 |
| audit-service | `nawara-core-audit-service@sha256:785a443169aada802cba82788b4ba1fda6e70676ba2d9e2d45d3bda89eb571ab` | `564a30f` | 38073779294 |

**Verified (read-only, 2026-10-12):**
- each digest is the index digest reported by its successful build run, and the build labels it with the full revision;
- each digest has exactly one GitHub attestation, whose subject is that digest, signed by the service's image workflow on
  `refs/heads/main` from a `push`, at that revision;
- both revisions are ancestors of `main`; no image input of any of the three services changed after them;
- coherence: `libs/`, `package.json` and `package-lock.json` are identical at `564a30f` and `64ad8e3`, so all three images carry the
  same shared libraries;
- the Auth candidate contains A2 (`d5a8cbb`), A3 (`fcf5806`) and the A5.4-A5 readiness check (R1), and its packaged R2 capability
  probe passed (R2 review §5).

**Conditions for final approval (PENDING):**
1. **CRYPTOGRAPHIC ATTESTATION: PENDING.** `gh attestation verify oci://<image>@<digest> --signer-workflow <image workflow>
   --source-ref refs/heads/main` could not run: the registry requires authentication, and no read-only registry credential was
   available. Run once per image with a read-only credential (for example D-16's).
2. **Packaged-image configuration checks: PENDING.** No evidence exists for these exact digests:
   - Auth: the image's own `dist/cli/check-config.js` against production's configuration (variable names; the deploy runs the same
     check);
   - Organization: the runbook's packaged configuration check (`organization-production.md` §2);
   - Audit: no packaged check exists; a static comparison shows its configuration names unchanged. Its start-up in G6-C is the evidence.
3. **Final owner approval**, recorded with the results of 1 and 2.

**Update (2026-10-12): conditions 1–3 are met; the set is FINALLY APPROVED for isolated G6 rehearsal use only (§16.1).**

Any change to a digest, or to its relevant configuration, after final approval requires a new selection and a re-rehearsal (A5.4-G1
item 3).

### 15.3 Parity changes

- **PostgreSQL image: owner decision required before G6-B.** The candidates' deploy scripts pin
  `postgres:16-alpine@sha256:721873c3…`. G6-A recorded production on `postgres@sha256:cf78e766…` (16.15). Recommended:
  - rehearse with the pinned image and record the difference as a §5 deviation, with both server versions compared;
  - a different PostgreSQL major version is a STOP.

  **Decided (2026-10-12, §16.2):** same PostgreSQL version (16.15), different images; the difference is accepted as a documented
  rehearsal limitation.
- **Audit migration `0004_changes_validation_search_path.sql`:** new in the Audit candidate. G6-C applies it on the VM. In production
  it is applied only by an authorized Audit digest deployment, forward-only.
- **Other parity targets** come from the 2026-10-12 refresh (§15.1). The revision `9e29c76` and the G6-A image digests no longer apply.

### 15.4 Procedure changes

1. **F6 Auth mirror, source first** (replaces the order in the §9.1 F6 row). After `ownership activate`:
   1. redeploy Auth with `AUTH_HIERARCHY_SOURCE=organization-service`;
   2. verify that deployment;
   3. run the irreversible `hierarchy-retire --fresh`;
   4. confirm MATCH.

   Inside the window, Auth's `/ready` reports `source_ahead_of_marker`. This is expected, attended, and still not ready.
2. **The seven Auth readiness cases** (F6 readiness decision record). Each is a §9.1 PASS item:
   1. the source-first sequence through F7, with MATCH at its end;
   2. no unintended hierarchy-content change across the disagreement window;
   3. a failed Auth redeploy and one controlled retry;
   4. an interrupted transition and an Auth restart inside the disagreement window;
   5. an abandoned transition detected by the agreement check (organization-production §6.2);
   6. the measured durations, which set the window's hard limit (OPEN-5);
   7. a second redeploy failure leading to the stop and escalation path, with no further retry.
3. **§8.1 monitoring demonstrations, now also on Auth's `/ready`:**
   - the induced freeze also shows `marker_frozen`;
   - the induced `AUTH_HIERARCHY_SOURCE` mismatch also shows `source_ahead_of_marker`;
   - both are restored as before.
4. **§7 restore checkpoint X lies outside any frozen Auth phase.**
   - X is taken with the Auth marker `local` before F6, or `org_authoritative` after F6. It is never taken during the §8.1 freeze
     demonstration.
   - The drill therefore uses the unchanged ready gate, and **no real frozen-backup drill is required for G6** (R2 applies only to a
     drill of a backup taken under a freeze).
   - Added to §7, as ADR-0063 requires: a restore drill of a post-F6 backup detects a `local` marker. A wrong-side restore stays
     procedural (core-backup-restore §7) and is recorded as not rehearsed.

### 15.5 Deferred items (owner decision, 2026-10-12)

The A5.4 operational draft §2.8 items 3 and 7 are **deferred**. Each needs A5.4 RED code that is gated until F7:
- item 3: the post-F7 first Platform, the `allowedPlatforms` extension and the first Organization (ADR-0062 §11);
- item 7: the read-only replacement for `ownership verify` (A5.4-O5).

Each is certified later, in a separately authorized rehearsal after its post-F7 implementation. Until then:
- the existing `ownership verify` stays the F5 and post-activation verification;
- production first-Platform operations stay blocked.

### 15.6 Rehearsal VM and isolation

**Amended 2026-10-12 (owner-approved; details in §16.3).** The earlier text planned a new VM away from `nawara-lab-01`, a GHCR
credential on the VM (D-16) and a host-side egress block. It is replaced by:

- **Host and guest.**
  - The guest `g6-rehearsal-01` (D-1: Ubuntu 24.04, user `ubuntu`, `/home/ubuntu/nawara-core`, no public DNS or TLS) runs under QEMU/KVM **without libvirt** on the
    nonproduction host `nawara-lab-01` (Server 2).
  - It has 2 vCPU, 4 GiB RAM and a 40 GiB thin-provisioned disk, and runs as the transient `g6-vm.service`, which does not restart
    after a host reboot.
  - The host also runs the R3 Auth and PostgreSQL laboratory. **Preserving R3 is mandatory**: no R3 container, volume, network,
    timer or queue is changed.
- **Network.** QEMU user networking with `restrict=on`; guest SSH forwarded only to the host's `127.0.0.1:2222`; the QEMU process
  confined by systemd `IPAddressDeny=any` with localhost allowed.
  - There is no NAT, no bridge and no host firewall change.
  - There is no outbound internet access, and no access to production, the LAN, R3 or the host's Docker networks.
- **Images (replaces D-16 on the VM).**
  - The guest never pulls from GHCR and holds no GHCR credential.
  - The §15.2 digests reach it only through a separately reviewed and authorized **offline transfer** (§16.3).
- **Unchanged.**
  - MinIO on the guest with a rehearsal-only key pair (D-17).
  - G6-BV-I and G6-BV-S before any rehearsal mutation (§6.1).
  - Deployments by digest, by hand, never through the GitHub production workflows.

### 15.7 Unchanged

R2 (source review PASS WITH LIMITATIONS; packaged-image probe PASSED; not certified) and R3 (CERTIFIED — PASS WITH LIMITATIONS,
nonproduction) are unchanged and not repeated. Also unchanged:
- §6 isolation requirements (G6-BV staged by the 2026-10-12 amendment, §6.1 and §16.4, without weakening any check);
- §7 RPO and RTO;
- §10 evidence;
- §11 retention;
- §13 PASS, FAIL and STOP;
- decisions D-1 to D-17 other than the image identity and the 2026-10-12 amendment of D-1's host and D-16 (§15.6).

### 15.8 Authorization boundary

**No production execution, and no rehearsal step, without a new explicit owner authorization.** Each step was or is separately
authorized. **Amended 2026-10-12** to the actual order: G6-B ran before steps 1 and 2 were recorded, by owner authorization (a
recorded deviation, §16.5).

| # | Step | Status (2026-10-12) |
|---|---|---|
| 1 | Final digest approval (§15.2 conditions) | **DONE** — rehearsal use only (§16.1) |
| 2 | PostgreSQL parity decision (§15.3) | **DONE** — difference accepted as a limitation (§16.2) |
| 3 | G6-B (VM provisioning) | **DONE** on `nawara-lab-01` (§15.6, §16.3) |
| 4 | G6-BV-I (infrastructure isolation) | **PASS WITH LIMITATIONS** (§16.4) |
| 5 | Offline image transfer and rehearsal-stack setup on the guest, MinIO and rehearsal credentials included (§16.3) | NOT AUTHORIZED |
| 6 | G6-BV-S (service-level isolation, §6.1) | NOT STARTED |
| 7 | G6-C to G6-F | NOT AUTHORIZED — not before steps 5 and 6 pass |
| 8 | G6 CERTIFIED | — |

After G6, these production steps keep their own checkpoints (§12; cutover record §7):
- the first digest deployment of each service in the set (R3 installed in production before any Auth deployment containing the
  check), each preceded by the production Tier B configuration check (§16.1);
- the pre-G7 backup and its verification;
- the backup schedule design;
- G7, F6 and F7;
- the post-F7 backup.

## 16. Owner decisions and amendment (2026-10-12)

Owner-approved; it records three decisions and the G6-B / G6-BV-I results. It **authorizes no deployment, no rehearsal step and no
production change**. Evidence kind for every result below: **OWNER-SUPPLIED TERMINAL OUTPUT** (the owner ran the reviewed scripts on
the owner workstation or on `nawara-lab-01`; the output files were then read by this record's author). The public attestation
bundles, the scripts and the outputs are retained by the owner outside the repository; no credential, token or configuration value is
in them or here.

### 16.1 Decision 1 — candidate digests FINALLY APPROVED for isolated G6 rehearsal use only

The three §15.2 digests are approved **as the G6 rehearsal identity**. **This is not an authorization to deploy them to production.**

**Cryptographic attestation (§15.2 condition 1): 3/3 PASS.** `gh attestation verify oci://<image>@<digest>` ran once per image with a
short-lived `read:packages`-only credential held in a temporary, deleted Docker configuration, pinned to:
- the image workflow;
- `refs/heads/main`;
- the source commit and the signer commit;
- the SLSA provenance predicate;
- `--deny-self-hosted-runners`.

The verified results were then re-checked independently against the pins:

| Image | Attested digest | Source commit | Signer workflow | Runner, trigger | Bundle SHA-256 |
|---|---|---|---|---|---|
| auth-service | `5877c6ad…35ed` | `64ad8e3` | `auth-service-docker-build.yml@refs/heads/main` | github-hosted, push | `c7f5c434…3a06` |
| organization-service | `61221d54…ca60` | `564a30f` | `organization-service-image.yml@refs/heads/main` | github-hosted, push | `18082711…80e7` |
| audit-service | `785a4431…71ab` | `564a30f` | `audit-service-image.yml@refs/heads/main` | github-hosted, push | `f61f07c5…ef20` |

Each image has one attestation, with a transparency-log timestamp.

**Packaged-image configuration checks, Tier A (§15.2 condition 2): Auth 5/5 PASS, Organization 5/5 PASS.**
- **Images:** pulled by exact digest on the owner workstation; the digest binding was checked.
- **Configuration:** the CI synthetic production configuration (`scripts/smoke-core-image.sh`), with generated values only.
- **Containers:** `--rm --pull=never --network none --read-only --cap-drop ALL --security-opt no-new-privileges`, with no mounts.
- **Auth:** `dist/cli/check-config.js`.
  - A1: a valid configuration is accepted, with the exact expected line.
  - A2: a pepper equal to `JWT_SECRET` is refused.
  - A3: a superuser runtime role is refused.
  - A4: `NAME` and `NAME_FILE` both set is refused.
  - A5: a missing `JWT_SECRET` is refused.
- **Organization:** the `organization-production.md` §2 check.
  - O1: a valid configuration is accepted.
  - O2: a superuser role is refused.
  - O3: a missing `RABBITMQ_URL` in production is refused.
  - O4: an extra top-level key in `SERVICE_POLICY` is refused.
  - O5: `NAME` and `NAME_FILE` both set is refused.
  - Every negative case had to fail with a `ConfigError`.
- **Output and cleanup:** no configuration value appeared in any output, and no check container was left.
- **Limitation:** Tier A proves the images' contracts, not production's values. Audit has no packaged check; its start-up in G6-C is
  the evidence.

**Production configuration, names only (read-only, 2026-10-12).** A reviewed parser read only the three service `.env` files on
production and printed names: no value, length, hash, path or comment.

| Service | Names in the file | Required by the candidate's production loader | Result |
|---|---|---|---|
| auth-service | 24 | all 13 present: `NODE_ENV`, `DATABASE_URL`, `JWT_SECRET`, `TOTP_ENCRYPTION_KEYS`, `TOTP_ENCRYPTION_ACTIVE_KEY_ID`, `OPERATOR_CODE_PEPPER`, `SECRET_KEY_PEPPER`, `THROTTLE_KEY_PEPPER`, `JOIN_CODE_PEPPER`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `AUTH_EVENTS`, `RABBITMQ_URL` | PRESENT |
| organization-service | 6 | all 4 present (`NODE_ENV`, `DATABASE_URL`, `AUTH_SERVICE_URL`, `RABBITMQ_URL`), plus `SERVICE_TOKENS` and `SERVICE_POLICY` | PRESENT |
| audit-service | 3 | all 3 present (`NODE_ENV`, `DATABASE_URL`, `RABBITMQ_URL`) | PRESENT |

Audit's three absent loader names do not block rehearsal approval (`apps/audit-service/src/config/audit-config.ts`, at `564a30f` and unchanged on `main`):

| Name | Classification | Effect of absence | Evidence |
|---|---|---|---|
| `AUTH_SERVICE_URL` | OPTIONAL | the owner read route is not mounted; Audit calls no other service; ingestion unaffected | `audit-config.ts` lines 23, 47–51, 74–76; its spec, lines 57–60 |
| `SERVICE_TOKENS` | OPTIONAL, deny by default | every service-token read is refused (fail closed); ingestion unaffected | `audit-config.ts` lines 30, 64 |
| `AUDIT_SERVICE_POLICY` | required only when a service-token caller is registered | none while no caller is registered | `audit-config.ts` line 69; service-kit `caller-policy.ts` lines 156–160; its spec, lines 122–123 |

- **The deploy script omits these names deliberately:** `apps/audit-service/deploy/provision-and-deploy.sh` lines 167–170.
- **Production's Audit image** (`cf42b9c`) handles the three names the same way.

**Presence of a name proves neither a valid value nor that the running container loads it.** Before G7, and before each production
digest deployment, the following stay open:
- **production Tier B:** each candidate's configuration check against production's real configuration, on the server, with no
  copy. This matters most for Organization, whose deploy does not run the check;
- **Organization policy contents:** `SERVICE_POLICY` and `SERVICE_TOKENS` under the stricter A1.3 parsing;
- **the runtime role:** every service's role under the shared `*_admin` rule;
- **Auth values:**
  - `SWAGGER_PASSWORD` meets the 16-character rule;
  - `TRUST_PROXY` means one hop;
  - the stale `PAYMENT_SERVICE_*` names stay ignored;
  - the `ORGANIZATION_SERVICE_*` values are ready for F6.

Any change to a digest after this approval requires a new selection and a re-rehearsal (§15.2).

### 16.2 Decision 2 — PostgreSQL: version parity, images not identical (accepted limitation)

- **The two images:**
  - candidates and R3: `postgres:16-alpine@sha256:721873c3…`;
  - production (G6-A): `postgres@sha256:cf78e766…`.

  The public image metadata of both reports `PG_MAJOR=16` and `PG_VERSION=16.15`.
- **Not identical:** the image digests differ and were built a month apart (2026-09-17 and 2026-08-13). The base image and its
  libraries (musl, OpenSSL, ICU) may differ, so **binary or image equivalence is not established**.
- **Decision:** the owner accepts the difference as a **documented rehearsal limitation** (§5 deviation).
- **Required of G6-C:**
  - record the ICU and collation versions on the guest and in production (read-only);
  - assess index and restore consequences of any difference, in particular in the §7 restore;
  - a different major version remains a STOP.

### 16.3 G6-B result and offline image transfer

- **G6-B: DONE (2026-10-12)**, as §15.6.
- **Preflight** (owner-run):
  - KVM, VT-x, cgroup v2 and systemd prerequisites passed;
  - the 23 new packages caused no upgrade or removal and touched no protected package.
- **Provisioning controls:**
  - package service starts were denied during the install by a temporary `policy-rc.d`, which was removed afterwards;
  - `qemu-kvm.service`, which would enable KSM, was masked before the install;
  - KSM stays off;
  - the cloud image was verified against Ubuntu's signed `SHA256SUMS`.
- **Offline image transfer (not yet authorized; separate review):**
  - export each §16.1 image by digest on a host with registry access;
  - copy it into the guest only over the loopback SSH forward;
  - load it there;
  - verify inside the guest that each image's repo digest equals the approved digest.

  No GHCR credential and no registry access is placed in the guest. The same applies to the PostgreSQL, RabbitMQ and MinIO images the
  rehearsal stack needs (their digests are recorded at that step).

### 16.4 G6-BV-I: PASS WITH LIMITATIONS; G6-BV-S: NOT STARTED

**G6-BV-I (infrastructure isolation): PASS WITH LIMITATIONS.** Read-only evidence collection on `nawara-lab-01` and the guest
showed:
- **Cloud image:** the `SHA256SUMS` signature and the image hash verify.
- **Guest:** `g6-rehearsal-01`, Ubuntu 24.04, KVM, 2 CPUs, 40 GiB disk. Memory is about 3.9 GiB visible of the 4 GiB assigned.
  - No Docker yet, no `DOCKER_HOST`, no deployment-SSH or GHCR credential, apt timers disabled.
- **QEMU runtime:** `restrict=on`; the only QEMU socket is the listener on `127.0.0.1:2222`.
- **`g6-vm.service`:** transient, `DynamicUser`, `IPAddressDeny=any`, `IPAddressAllow` loopback only, 0 restarts.
- **Host before/after:**
  - identical: the firewall rules, nftables tables, UFW, `ip_forward`, interfaces, routes and listeners;
  - KSM 0; `qemu-kvm.service` masked; no `policy-rc.d`;
  - `packagekit` is the pre-installed static unit, started on demand by the install and inactive again, so it is not a deviation.
- **R3:** containers (ID, image, state, start time, 0 restarts), volumes, networks, the timer (disabled, inactive) and the queue are
  identical before and after.

Limitations:
- **Missing route, not enforcement.** The guest has **no default route**: QEMU's restricted DHCP offers none. Its blocked probes to the
  LAN, R3, the Docker bridge, the internet and DNS therefore show a missing route, **not** firewall enforcement. Two checks do show
  isolation:
  - the probe of QEMU's on-link host alias (`10.0.2.2`, port 22), blocked by `restrict=on`;
  - the IP-filter properties of `g6-vm.service`.
- **IP-filter enforcement not retained:** the separate enforcement test (a transient unit with the same filter must fail to reach an
  outside address) was reported passing, but its output was not retained. G6-BV-I becomes unconditional only with retained evidence of
  that test.
- **Reboot:** the VM does not survive a host reboot (transient by design). The disk and the serial log persist.

**G6-BV-S (service-level isolation): NOT STARTED.** Its acceptance criteria are the §6.1 checks, unchanged:
1. the guest's Docker context is the local default and `DOCKER_HOST` is unset;
2. every service's `DATABASE_URL`, `RABBITMQ_URL` and `ORGANIZATION_SERVICE_URL` host is a guest-local container name;
3. no production hostname, IP address, bucket or prefix appears under `/home/ubuntu/nawara-core` (compared by name only);
4. no `DEPLOY_SSH_*` or GHCR credential exists on the guest;
5. the backup destination is the guest's MinIO, and the recipient certificate fingerprint differs from production's;
6. the G6-A production fingerprint is unchanged afterwards.

Two checks are added, following from §16.3:
- every running image's repo digest equals its §16.1 approval or its recorded infrastructure digest;
- the guest still has no default route, and G6-BV-I's host and R3 fingerprints are unchanged.

It runs after the rehearsal stack, MinIO and the rehearsal credentials exist on the guest. **G6-C does not start before G6-BV-S
passes.**

### 16.5 Deviations added to §5

| Deviation | Why it does not weaken G6 |
|---|---|
| The VM host is `nawara-lab-01`, which also hosts R3, not a separate VM host | QEMU/KVM without libvirt; no host network or firewall change; R3 fingerprints proven unchanged, and re-checked at every gate |
| QEMU's restriction and the systemd IP filter replace a host egress block | No path off the QEMU process except loopback; no host ruleset change to verify or undo |
| Offline image transfer instead of a GHCR credential on the VM (D-16) | Images are verified by repo digest inside the guest; no registry credential on the guest |
| PostgreSQL 16.15 on a different image digest from production | Version parity; image differences assessed in G6-C (§16.2) |
| G6-B ran before the final digest approval and the PostgreSQL decision were recorded | Owner-authorized; both decisions are recorded before any step that uses them (§15.8) |
| The VM is transient and does not survive a host reboot | The disk and logs persist; a restart is a deliberate, recorded step |

### 16.6 Remaining before service-level readiness

1. Retained evidence of the IP-filter enforcement test (read-only; this upgrades G6-BV-I).
2. Review and authorization of the offline image transfer and the rehearsal-stack setup on the guest, with MinIO and rehearsal-only
   credentials (D-17).
3. G6-BV-S (§16.4).
4. Only then, a separate authorization for G6-C to G6-F.
