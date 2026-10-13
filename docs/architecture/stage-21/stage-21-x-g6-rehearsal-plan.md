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
- **Amendment (2026-10-13, §17):** G6-BV-I **PASS** after the guest's IPv6 default route was removed (QEMU `ipv6=off`); the order is
  G6-BV-I → G6-S1 → G6-S2 → G6-BV-S → G6-C (B1); MinIO over internal HTTP accepted for the rehearsal only (B2); the Chainguard MinIO
  digest approved for the isolated rehearsal only (B3). **G6-S1, G6-S2 and G6-C are not authorized.**
- **Result (2026-10-13, §18):** **G6-S1 PASS**, owner-authorized and owner-run; the script versions used are recorded (§18.3).
  **G6-S2, G6-BV-S and G6-C are not authorized.**
- **Result (2026-10-13, §19):** **G6-S2 PASS**, owner-authorized and owner-run (supporting evidence, not a §9.1 G1–G3 PASS). A
  corrected G6-BV-S script is prepared and **not executed**. **G6-BV-S has not run; G6-C is not authorized.**
- **Procedure (2026-10-13, §20):** owner decision on how §6.1's check 6 is evidenced: a fresh production capture immediately before
  G6-BV-S, compared with one immediately after (a recorded deviation from the G6-A reference). **Not executed; no production access
  is authorized by it.**
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
**Amended 2026-10-13 (B1, §17.2):** the guest is prepared by **G6-S1** (offline images, Docker) and **G6-S2** (initial guest-only
deployment into new disposable databases); G6-BV-S runs after G6-S2 and before G6-C. G6-S2 is environment preparation, not a §9.1
rehearsal step. The added checks of §16.4, with routes checked for both address families (§17.5), apply.

- `docker context show` is the local default and `DOCKER_HOST` is unset;
- every service's `DATABASE_URL`, `RABBITMQ_URL` and `ORGANIZATION_SERVICE_URL` host is a VM-local container name;
- no production hostname, IP address, bucket or prefix appears under `/home/ubuntu/nawara-core` (compared by name only);
- no `DEPLOY_SSH_*` or GHCR write credential exists on the VM;
- the backup destination is the VM's MinIO and the recipient certificate fingerprint differs from production's;
- the G6-A production fingerprint is unchanged afterwards.

Any failure: **STOP**; no rehearsal mutation runs.

**Amended 2026-10-13 (§20), for the last check only:** it is evidenced by two captures of the same read-only block, one immediately
before G6-BV-S and one immediately after, which must be identical; G6-A is not rerun. The other five checks are unchanged.

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

**Amended 2026-10-13 (B1, §17.2):** row G1–G3 is accepted **only within G6-C**, as an attended deployment and redeployment on the
stack G6-S2 prepared, with the PASS criteria above unchanged. G6-S2's initial deployment logs are supporting evidence, **not** a
G1–G3 PASS.

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

**Status (2026-10-13, §20.1):** that detailed output was never attached and is not among the owner's retained evidence. Only the
summary in the cutover record §14 exists.

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
  - **Amended 2026-10-13 (§17.5):** QEMU user networking must also carry **`ipv6=off`**
    (`-netdev user,id=n0,ipv6=off,restrict=on,hostfwd=tcp:127.0.0.1:2222-:22`). Without it, QEMU's router advertisements give the
    guest an IPv6 default route. This is required for every G6 VM creation or restart.
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
recorded deviation, §16.5). **Amended 2026-10-13** to the B1 order (§17.2): G6-BV-I → G6-S1 → G6-S2 → G6-BV-S → G6-C.

| # | Step | Status (2026-10-13) |
|---|---|---|
| 1 | Final digest approval (§15.2 conditions) | **DONE** — rehearsal use only (§16.1) |
| 2 | PostgreSQL parity decision (§15.3) | **DONE** — difference accepted as a limitation (§16.2) |
| 3 | G6-B (VM provisioning) | **DONE** on `nawara-lab-01` (§15.6, §16.3) |
| 4 | G6-BV-I (infrastructure isolation) | **PASS** (§17.1), after the `ipv6=off` restart |
| 5 | G6-S1: offline image transfer, guest Docker and its dependencies, image loading by exact digest (§16.3) | **PASS** (2026-10-13, §18) |
| 6 | G6-S2: initial guest-only deployment of the broker, Auth, Organization, Audit and MinIO into new disposable databases, with the rehearsal credentials (§17.2) | **PASS** (2026-10-13, §19) |
| 7 | G6-BV-S (service-level isolation, §6.1, §16.4) | NOT STARTED — step 6 passed (§19); its inputs, its authorization and the check 6 evidence are missing (§19.5) |
| 8 | G6-C: attended G1–G3 deployment and redeployment acceptance (§9.1), then the separately authorized rehearsal steps; G6-D to G6-F | NOT AUTHORIZED — not before step 7 passes |
| 9 | G6 CERTIFIED | — |

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

*Superseded 2026-10-13 (§17.1): G6-BV-I is **PASS**. Both limitations below about routes and enforcement are resolved there. The
added route check below applies to both address families (§17.5). The text is kept as history.*

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
| B1 (2026-10-13): G6-S2 deploys the stack before G6-BV-S | Forward-only initialization migrations into new disposable guest databases only; its logs are supporting evidence, not a G1–G3 PASS, which is accepted only within G6-C (§9.1, §17.2) |
| B2 (2026-10-13): Backups travel to the guest's MinIO over HTTP, not HTTPS | Rehearsal only. The network is guest-private, no MinIO port is published, and production and R3 have no path to it. Data is encrypted and verified before upload. **Not approved for production** (§17.3) |
| B3 (2026-10-13): MinIO is a third-party Chainguard image, not production's backup provider | Pinned by digest; signature and SLSA provenance verified; isolated rehearsal only; S3 compatibility is proven by the G6-S2 probe before use (§17.4) |

### 16.6 Remaining before service-level readiness

*Superseded 2026-10-13 by §17.7. Item 1 is done (§17.1).*

1. Retained evidence of the IP-filter enforcement test (read-only; this upgrades G6-BV-I).
2. Review and authorization of the offline image transfer and the rehearsal-stack setup on the guest, with MinIO and rehearsal-only
   credentials (D-17).
3. G6-BV-S (§16.4).
4. Only then, a separate authorization for G6-C to G6-F.

## 17. G6-BV-I certification and owner decisions B1–B3 (2026-10-13)

Owner-approved. It records the IPv6 correction, the G6-BV-I result and decisions B1, B2 and B3. It **authorizes no deployment, no
G6-S1, G6-S2, G6-BV-S or G6-C step and no production change**. The evidence kind is the same as in §16: **OWNER-SUPPLIED TERMINAL
OUTPUT**. The owner ran the reviewed scripts on `nawara-lab-01`, and this record's author read the complete output. The scripts and
outputs are retained by the owner outside the repository; neither contains a credential, token or configuration value.

### 17.1 G6-BV-I: PASS

**Run 1, 2026-10-13T07:23:54Z.** The owner ran `g6-ip-filter-evidence-v2.sh --enforce`, which needed and had its own authorization.
- **Evidence:** the original is on the lab at `~/g6-vm/state/ip-filter-evidence-20261013T072338Z.txt`; the owner's copy has SHA-256 `4364df53…d102`.
- **Passed:**
  - A1, the IP filter of `g6-vm.service`: active; `IPAddressDeny` covers all IPv4 and IPv6; `IPAddressAllow` is loopback only.
  - A2, QEMU: `restrict=on`, the forward on `127.0.0.1:2222` only, and a single loopback socket.
  - A4: R3 and the host network fingerprint match the baseline.
- **Kernel enforcement (B):** three transient units, using the same filter as `g6-vm.service`, tested the host's own sshd.

  | Test | Result |
  |---|---|
  | B1: no filter, to the host's LAN address | connected |
  | B2: the filter, to the host's LAN address | **blocked** |
  | B3: the filter, to `127.0.0.1:2222` | connected |

  The run printed **`ENFORCEMENT PROVEN`**. This resolves the §16.4 limitation "IP-filter enforcement not retained".
- **Failed:** A3. The guest reported `default_routes=0 v6_default=1`, so the run's result was `FAIL (1)`. A read-only investigation
  found a **real IPv6 default route**, not a script defect.
  - QEMU's user network sends IPv6 router advertisements even with `restrict=on`, and the guest accepted them:
    `default via fe80::2 dev enp0s1 proto ra` and the address `fec0::5054:ff:fe12:3456/64`.
  - The §16.4 statement "QEMU's restricted DHCP offers none" was true for IPv4 only. The earlier evidence printed only IPv4 routes.

**Run 2, 2026-10-13T07:42:24Z: the correction.** The owner ran `g6-vm-ipv6-off-restart.sh`, which also needed and had its own authorization.
- **Script:** SHA-256 `64d81f4a222aa009d73681ef8d28ed42723696af3beded01706f0cd0501c186f`, checked on the lab before the run.
- **Evidence:** the original is on the lab in `~/g6-vm/state/ipv6-off-20261013T074224Z/`; the owner's copy of the output has SHA-256
  `475c36ab…03ff`.
- **What it did:** it stopped and restarted only `g6-vm.service`, using a poweroff from inside the guest. One QEMU argument changed:
  `-netdev user,id=n0,restrict=on,…` became `-netdev user,id=n0,ipv6=off,restrict=on,hostfwd=tcp:127.0.0.1:2222-:22`.

| Check | Result |
|---|---|
| Unit | active and transient; exactly one QEMU process on the host, the unit's main process |
| QEMU arguments | identical to provisioning before the change; afterwards they differ **only** in the `-netdev` value |
| Unit properties: sandbox, `DynamicUser`, `/dev/kvm` access, IP filter, `MemoryMax`, CPU quota | 23 properties identical before and after |
| QEMU sockets | loopback only |
| Disk | 40 GiB qcow2; read-only `qemu-img check` after the stop: no errors |
| Seed and pinned known-hosts file | unchanged |
| Guest | `g6-rehearsal-01`, a new boot ID, the same ed25519 host key, cloud-init `done` |
| Guest routes and addresses | 0 IPv4 default routes, 0 IPv6 default routes, 0 default routes in any table of either family, 0 IPv6 addresses other than loopback and link-local |
| QEMU host alias `10.0.2.2:22` from the guest | not reachable (`restrict=on`) |
| Host | identical before and after: iptables, nftables, UFW, `ip_forward`, links, routes, listeners, enabled units, sshd, Docker |
| R3 | identical before and after: containers, volumes, networks, timer, queue |
| Earlier evidence in `~/g6-vm/state` | byte-identical, including the run 1 file |

The script prints `RESULT: PASS`, does not certify G6-BV-I itself, and did not repeat the kernel enforcement test.

**Certification: G6-BV-I PASS.**
- **Basis:** this record's author read both complete outputs, and every G6-BV-I criterion has a passing line in them:
  - §16.4's infrastructure checks;
  - kernel enforcement (run 1);
  - no default route in either address family (run 2).

  The enforcement result applies to the corrected VM because its unit properties, the IP filter included, are identical.
- **Not reviewed:** the detail files in the run 2 directory on the lab (argument lists, unit properties, state-file hashes, the copy of
  the earlier serial log) were not read for this record. Their results are in the output that was read.
- **Remaining limitations:**
  - the VM is transient and does not survive a host reboot;
  - the guest's probes other than `10.0.2.2` still show a missing route, while enforcement is proven on the host side.

### 17.2 B1: order of preparation and verification

1. **G6-BV-I:** infrastructure certification (§17.1, done).
2. **G6-S1:** offline image transfer, the guest's Docker and its dependencies, and image loading. Every reference must resolve to its
   exact approved digest.
3. **G6-S2:** the first guest-only deployment of the broker, Auth, Organization, Audit and MinIO into **new disposable databases**,
   with rehearsal-only credentials. It may run only the forward-only initialization migrations, and only in those guest databases.
4. **G6-BV-S:** the complete service-level isolation check (§6.1 and §16.4, routes per §17.5).
5. **G6-C:** the attended G1–G3 deployment and redeployment acceptance (§9.1), then the rehearsal steps, each separately authorized.

G6-S2's logs are **supporting evidence, not G1–G3 certification**. §9.1's G1–G3 criteria are unchanged and are met only within G6-C.
Each step needs its own owner authorization and the previous step's PASS.

### 17.3 B2: MinIO over internal HTTP (rehearsal only)

The rehearsal's `backup.sh` reaches the guest's MinIO over HTTP, accepted **for the G6 rehearsal only**, under these conditions:
- the MinIO container is reachable only on a guest-private, internal Docker network;
- no MinIO port is published;
- production and R3 have no path to it;
- `BACKUP_S3_ALLOW_INSECURE_HTTP=local-test` is set (the only value `backup.sh` accepts for HTTP, `infra/backup/backup.sh` line 136);
- every artifact is encrypted to the recipient certificate and verified before upload, and the plaintext is removed first (lines 240–244);
- no recipient private key is in the backup data directory (`backup.sh` refuses one, line 128);
- the credentials and key pair are rehearsal-only (D-17).

**HTTP is not approved for production.** Production backups keep the HTTPS requirement.

### 17.4 B3: MinIO image (Chainguard), approved for the isolated rehearsal only

- **Why a third-party image:** the upstream MinIO images are no longer anonymously available.
- **Image:** `cgr.dev/chainguard/minio@sha256:dc455cdd4db6e390b1b26514f15ff37681a777bf8dab41aac445a0259f751e56`.
- **Owner-run verification:** `g6-minio-cosign-verify.sh`, SHA-256 `10078d4a…7fbb`; output copy SHA-256 `1db81891…a63f`.
  - The keyless signature verified for `https://github.com/chainguard-images/images/.github/workflows/release.yaml@refs/heads/main`,
    issuer `https://token.actions.githubusercontent.com`.
  - `PASS SLSA provenance attestation verified for the same identity`.
  - `RESULT: B3 cryptographic verification PASS`.
- **Decision:** the owner approves this provider and digest **for the isolated G6 rehearsal only**.
- **Runtime S3 compatibility: NOT YET VERIFIED.** G6-S2 must prove it on the guest. The probe runs put-object, head-object (size),
  list-objects-v2, get-object (byte-identical round trip) and delete-object. **Any failed operation is a STOP.**
  **Status (2026-10-13, §19.1):** the G6-S2 probe passed all five operations on the guest.

### 17.5 Permanent IPv6 requirement and dual-family gates

- **Provisioning:** every G6 VM creation or restart uses `ipv6=off` together with `restrict=on` and the loopback-only forward (§15.6).
- **Dual-family gates:** every gate that checks the guest's routes checks all four of:
  1. IPv4 default routes;
  2. IPv6 default routes;
  3. default routes in every routing table, both families;
  4. IPv6 addresses other than loopback and link-local.

  Any nonzero count is a STOP. The gates are at the start and end of G6-S1, G6-S2 and G6-BV-S, and at every VM restart.

Script versions reviewed for this record. They are held by the owner outside the repository; a hash here identifies a version and is
**not** an approval to run it:

| Script | SHA-256 | Executed | Route checks |
|---|---|---|---|
| `g6-vm-ipv6-off-restart.sh` | `64d81f4a…186f` | yes, run 2 (§17.1) | all four |
| `g6-guest-stack-prepare-v4.sh` (G6-S1 guest modes, G6-S2 `stack`) | `343b0578…e4d5` | no | 1 and 2 only |
| `g6-offline-image-transfer-v3.sh` (G6-S1 transfer) | `33264924…0843` | no | 1 and 2 only |
| `g6-bv-s-check-v2.sh` (G6-BV-S) | `d68a11ce…58ea` | no | 1 and 2 only |
| `g6-vm-provision-qemu.sh` (G6-B) | `95d329a4…37cc` | yes, G6-B (§16.3) | lacks `ipv6=off` |

Outstanding corrective items, all documentation-tracked and none done by this record:
- **`g6-vm-provision-qemu.sh` still lacks `ipv6=off`.** It must be corrected before any new G6 VM is created.
- **`g6-guest-stack-prepare-v4.sh`, `g6-offline-image-transfer-v3.sh` and `g6-bv-s-check-v2.sh` check only checks 1 and 2.** Each must
  gain checks 3 and 4, and be re-reviewed with a new hash recorded, before it is used.
- **`g6-guest-stack-prepare-v4.sh` wording:**
  - its header names the decision token `B1,B2,B3-accepted`, while its gate requires `B1-plan-amended,B2,B3-verified`;
  - its `stack` mode labels its result "§9.1 G1–G3".

  Per B1, that output is G6-S2 supporting evidence only. Both must be aligned before G6-S2.

**Status (2026-10-13, §18.3):** the transfer and guest-preparation items and the wording item are resolved by
`g6-offline-image-transfer-v4.sh` and `g6-guest-stack-prepare-v5.sh`. The `g6-vm-provision-qemu.sh` and `g6-bv-s-check` items remain
outstanding.

### 17.6 PostgreSQL limitation (unchanged)

§16.2 stands. G6-S2 and G6-C use the candidates' `postgres:16-alpine@sha256:721873c3…`, while production runs
`postgres@sha256:cf78e766…`. Both are PostgreSQL 16.15, but the images are not identical. G6-C records the ICU and collation
versions and assesses their effect on indexes and on the §7 restore. A different major version is a STOP.

### 17.7 Remaining gates

**Before G6-S1:**
1. Checks 3 and 4 (§17.5) are added to `g6-offline-image-transfer-v3.sh` and to the `check`, `install-docker` and `load-images` modes
   of `g6-guest-stack-prepare-v4.sh`; the result is re-reviewed and its hash recorded.
2. Owner review and authorization of G6-S1:
   - the export on the owner workstation;
   - the transfer over the loopback forward;
   - the guest's Docker `.deb` dependency check;
   - the Docker install;
   - image loading by exact digest.
3. At G6-S1's start, the VM still runs with `ipv6=off`, and G6-BV-I's host and R3 fingerprints are unchanged.

**Before G6-S2:**
1. G6-S1 PASS.
2. The `stack` mode wording is aligned with B1 (§17.5).
3. Owner authorization of G6-S2.
4. During G6-S2, the B2 conditions (§17.3) and the five-operation S3 probe (§17.4) must hold; any failure is a STOP.

**Status (2026-10-13, §18.5):** items 1 and 2 are met. Item 3 is **not given**: G6-S2 is not authorized.

**Before G6-C:**
1. G6-S2 PASS.
2. `g6-bv-s-check-v2.sh` gains checks 3 and 4, is re-reviewed, and G6-BV-S passes.
3. A separate owner authorization of G6-C.

**Status (2026-10-13, §19.5):** item 1 is met. Items 2 and 3 are **not met**: the corrected script (§19.4) has not run, and G6-C is
not authorized.

**Before any new G6 VM:** `g6-vm-provision-qemu.sh` carries `ipv6=off`.

**Unchanged, for production after G6:** production Tier B and the other §16.1 checks, the pre-G7 backup, G7, F6 and F7 (§15.8).

## 18. G6-S1: PASS (2026-10-13)

It records the G6-S1 result and the script versions used, as §17.7 requires before G6-S2. It **authorizes no G6-S2, G6-BV-S or G6-C
step, no deployment and no production change**. The evidence kind is the same as in §16 and §17: **OWNER-SUPPLIED TERMINAL OUTPUT**.
The owner authorized and ran every stage; this record's author read the owner's saved copy of each complete output. The scripts and
outputs are retained by the owner outside the repository; none contains a credential, token or configuration value.

### 18.1 Stages

All times are 2026-10-13, UTC. Every stage that reached the guest printed the §17.5 gate with the pinned host key,
`v4_default_all=0 v6_default_all=0 v6_nonlocal_addr=0` and the boot ID of §17.1 run 2: the VM was not restarted during G6-S1.

| Stage | Where | Start | Result | Output copy SHA-256 |
|---|---|---|---|---|
| S1-0 host check `before` | Server 2, read-only | 08:55:23 | **PASS**, 12 checks | `c3df75d2b829b083fd82e9ed242276e2f8d3db75b900a18e1c357e754dd97a53` |
| S1-1 export | owner workstation | 09:05:32 | **PASS**: seven images by pinned digest, `linux/amd64`, every blob verified; three Docker `.debs` from the signature-verified index; three infra scripts at their pinned hashes; a 14-file manifest | `2d610b7e05685bd1bd87e3f66bfe759a512e2ce198d5a1278a6178a88a74a51c` |
| S1-2 transfer | workstation → guest, loopback forward | 09:50:58 | **PASS**: gate before and after; the guest verified every file against the manifest | `ed4be79476cbbe58d107c2cd7c0395de059f9173c192c924276f1ccb99b8229f` |
| S1-2 read-only inspection | guest | 15:45:41 | **COMPLETE**: the expected manifest, 14 listed files verified, 15 files present, none partial, linked, extra or foreign-owned | `389c71ca13d2cf2b2263abe2c67ab11cdd531da8b9c170a3138ead634a07dade` |
| S1-3 `check` | guest | 15:48:28 | **PASS**: capacity, `DOCKER_HOST` unset, manifest, image list equal to the pinned list, offline resolution to exactly the three `.debs` | `788ecbd538d8d536e201ff6a6359514bfa4362697e154609b1221e09957e0137` |
| S1-4 `install-docker` | guest | 15:51:17 | **PASS**: Docker Server 29.1.3, containerd image store, guest-local context; gate at start and end | `83439b2eab05ee13cf2e6f327321172737fdc35710340037612cabba3e332c24` |
| S1-5 `load-images` | guest | 15:55:23 | **PASS**: each of the seven references resolves to its pinned digest, `linux/amd64`; no container started; gate at start and end | `ed55b0a04edd6b30b144db41c13720028cbc9975a63676159a3620b5397e8dee` |
| S1-6 host check `after` | Server 2, read-only | 15:59:22 | **PASS**, 12 checks; seven fingerprint files byte-identical to S1-0's | `a2be8ee32bc510d87e86c9a01bb41d85cee58775714688d1dab7b27d4db244b9` |

### 18.2 Evidence

- **Server 2:** `~/g6-vm/state/s1-host-before-20261013T085523Z/` and `~/g6-vm/state/s1-host-after-20261013T155922Z/`.
- **Final output (owner workstation):** `s1-6-host-after-20261013T155910Z.out`.
- **Export manifest:** SHA-256 `7c4352e8e74e1f90d91b040084447fea42d09101b88290c965855a8f80f5e58c`, printed by the export, the transfer,
  the guest's own verification and the inspection.
- **Images:** the seven references of the transfer script's list, which the guest script requires to equal its own pinned list: the
  §16.1 digest set, the PostgreSQL, RabbitMQ and AWS CLI images the scripts pin, and the B3 MinIO digest (§17.4).
- **Docker packages:** `docker-ce` and `docker-ce-cli` `5:29.1.3-1~ubuntu.24.04~noble`; `containerd.io`
  `2.4.1-2~ubuntu.24.04~noble`, SHA-256 `893c9ddf70deacfb79db14ec3845164f1649807f82634bc453c12a1cc40a88c4`.
- **S1-6 comparison with S1-0:** `qemu-argv`, `unit`, `r3`, `r3x`, `net`, `host` and `state-files` are byte-identical. Both runs
  passed the same 12 checks: the unit, the single QEMU process, the QEMU arguments (`ipv6=off`, `restrict=on`, the loopback forward
  only), the 23 unit properties, loopback-only sockets, the pinned guest key, the guest gate, R3 (containers, volumes, networks, timer;
  queue), the host network and host state fingerprints, and every earlier evidence file in `~/g6-vm/state`.

### 18.3 Script versions

Held by the owner outside the repository; a hash identifies a version and is **not** an approval to run it.

| Script | SHA-256 | Used for | Route checks (§17.5) |
|---|---|---|---|
| `g6-s1-host-check.sh` | `9433890d9cdbbbaa6e6b01e06fa5a56b3cb583437d6840b4f20583d1b3ae4eda` | S1-0, S1-6 | all four |
| `g6-offline-image-transfer-v4.sh` | `4ab1453f2c3b6b399c4aab4fe70f29db95db1207861296b3072e59866224573e` | S1-1, S1-2 | all four |
| `g6-guest-stack-prepare-v5.sh` | `245fe36a6f43fcdc1e1da3468799f8def3a7917e599b263fced8a341bf65ce1c` | S1-3, S1-4, S1-5; its `stack` and `evidence` modes were **not executed** | all four |
| `g6-s1-2-transfer-inspect.sh` | `1dffd436ed15b5bf0f6bfbacb45156d98ed66d0800e1a1b8e1e9d7f1de5821ec` | the S1-2 read-only inspection | all four |

The four scripts carry the same gate text. Status of §17.5's corrective items:
- **Resolved:** the transfer script and the `check`, `install-docker` and `load-images` modes carry checks 3 and 4.
- **Resolved (read, not executed):** the `stack` mode of `g6-guest-stack-prepare-v5.sh` requires `G6_S2_AUTHORIZED=yes` and
  `G6_STACK_DECISIONS=B1,B2,B3`, its header names the same token, and its result line calls its output supporting evidence, not a
  §9.1 G1–G3 PASS.
- **Outstanding:** `g6-vm-provision-qemu.sh` still lacks `ipv6=off`; the G6-BV-S script is not recorded here and is re-reviewed before
  G6-BV-S (§17.7).

### 18.4 Deviations and limitations

- **Hashes recorded after the run.** §17.7 asked for the corrected scripts' hashes to be recorded before G6-S1. The owner authorized and
  ran G6-S1 with the versions above first; this section records them afterwards.
- **A second transfer attempt** at 15:41:30 was refused by the script because the guest's transfer directory existed, and changed
  nothing (output copy SHA-256 `8945424cff72c0e1b44c45fdfe7f398bc5b9e6545b8a74a918139ab8e03e7dc7`). The inspection then confirmed the
  09:50:58 transfer.
- **`check` is not strictly read-only:** every mode of the guest script creates the empty directory `~/g6-stack-logs`.
- **`containerd.io` was not pinned in advance:** the export took the newest version in the signed index; its version and hash are in
  §18.2.
- **Transferred files are mode 664** (the guest's default umask), owned by the guest user; each later stage re-verified the manifest.
- **S1-5's command** set the guest-local Docker socket and unset `DOCKER_CONTEXT`; the guest's load log lists the seven images and no
  unpack error.
- **Not inspected:** Docker's own bridge, firewall rules and forwarding setting inside the guest. The gates after the install and the
  load show no default route and no nonlocal IPv6 address.
- **Host check coverage:** it does not fingerprint the host's image list, the host's IPv6 routes or non-main routing tables, or host
  sysctls other than `ip_forward`.
- **Not reviewed:** the detail files in the two Server 2 directories; their results are in the outputs that were read.
- **Kept on the owner workstation:** the export and its temporary copies (public image content only).
- The limitations of §17.1 are unchanged: the VM is transient and does not survive a host reboot.

### 18.5 Remaining gates

*Superseded 2026-10-13 by §19.5 for G6-S2 and the S3 compatibility. The text is kept as history.*

- **Before G6-S2 (§17.7):** G6-S1 PASS and the `stack` wording are met. **Owner authorization of G6-S2 is not given.**
- **G6-S2: NOT AUTHORIZED.** B1, B2 and B3 (§17.2–§17.4) are unchanged; the MinIO runtime S3 compatibility is still **not verified**.
- **G6-BV-S: NOT STARTED. G6-C: NOT AUTHORIZED.** §17.7's gates before G6-C and before any new G6 VM are unchanged.
- **Unchanged, for production after G6:** §15.8.

## 19. G6-S2: PASS (2026-10-13); G6-BV-S tooling prepared, not executed

It records two separate things: the **G6-S2 result**, which is accepted evidence (§19.1–§19.3), and a **corrected G6-BV-S script**,
which is tooling that has **not run** and is not evidence (§19.4). It **authorizes no G6-BV-S or G6-C step, no deployment and no
production change**. The evidence kind is the same as in §16–§18: **OWNER-SUPPLIED TERMINAL OUTPUT**. The owner authorized and ran
every G6-S2 step; this record's author read the owner's saved copy of each complete output. The scripts and outputs are retained by the
owner outside the repository; none contains a credential, token or configuration value.

### 19.1 G6-S2 result

All times are 2026-10-13, UTC. Every step printed the §17.5 gate with the pinned host key, `v4_default_all=0 v6_default_all=0
v6_nonlocal_addr=0` and the boot ID of §17.1 run 2.

| Step | Start | Result | Output copy SHA-256 |
|---|---|---|---|
| Deployment: `g6-guest-stack-prepare-v5.sh stack`, with `G6_S2_AUTHORIZED=yes` and `G6_STACK_DECISIONS=B1,B2,B3` | 16:20:21 | **PASS**, exit 0; gate at start and end | `be560eafc3e8c4409881afe37cec69bc84622c7a21b4389f513d2c8f0357f2b7` |
| Guest inspection, read-only: the `evidence` mode, then `g6-s2-evidence-inspect.sh` | 16:32:39 | **PASS**, both exit 0; gate at start and end | `5e0b5ac6767713f67eca0d8350914ba4ce81dd11281ec61fc34cec4c6e7b529d` |
| Host check `after`, read-only (Server 2 and R3) | 16:34:13 | **PASS**, 12 checks; seven fingerprint files byte-identical to both S1-0's and S1-6's | `ac6e8d6cb84028b278bd14c25adbd5b7cf8a9ff9a6fcda71d96ebbf70db7d605` |

- **Deployed, in order:** the broker, Audit, Organization, Auth (each deploy script read out of its own approved image), then MinIO.
- **Containers (inspection):** exactly eight exist: the broker, the three services, their three databases and MinIO.
  - Each was created from its full pinned reference, and its image ID is the pinned digest (§16.1, the pinned infrastructure digests,
    the B3 MinIO digest).
  - All are running with 0 restarts, no published port and not privileged. Seven are healthy; MinIO has no health check.
- **Networks and volumes (inspection):** the Core network and the backup network are internal; IPv6 is off on the four bridge networks; MinIO is
  alone on the backup network; exactly five named volumes exist; no `docker-proxy` process runs.
- **MinIO (B2, B3):** all capabilities dropped, `no-new-privileges`, a 512 MB limit. The five-operation S3 probe passed: put-object,
  head-object (size), list-objects-v2, get-object (byte-identical round trip) and delete-object. This is the runtime S3
  compatibility that §17.4 left open, **for the isolated rehearsal only**.
- **Auth and Organization:** `AUTH_EVENTS=off` and `AUTH_HIERARCHY_SOURCE` unset, on disk and in the running container; Auth holds no
  Organization credential; Organization has no caller token, no caller policy and no activation switch; no caller was registered.
- **Not run:** no ownership command, no caller registration, no backup and no restore.
- **Server 2 and R3:** the new evidence directory is `~/g6-vm/state/s1-host-after-20261013T163413Z/`, the one directory that run
  created. The checks and the compared files are those of §18.2.
- **Standing (B1):** this is supporting evidence. It is **not** a §9.1 G1–G3 PASS, which is accepted only within G6-C.

### 19.2 Deviations and limitations

- **The inspection script is new.** `g6-s2-evidence-inspect.sh` was written after the deployment, because the `evidence` mode only
  lists and asserts nothing.
- **Not independently inspected:** in-database state (ownership phase, migrations, role privileges) and the broker topology. The
  deploy scripts assert the privileges and the topology themselves and reported success.
- **Auth's database is on `deploy_edge`**, a non-internal bridge, as in production. The guest has no route out (§17.5 gate).
- **The `stack` mode is not re-entrant;** it ran once.
- **Hash checks:** the prepared commands check each script's hash before running it; for the two guest runs that check's own line is
  not in the saved output.
- **The host check's label** is `after` again; the directory is told apart by its timestamp. Its coverage limits are those of §18.4.
- **Open for G6-C and G6-E:** `BACKUP_S3_ALLOW_INSECURE_HTTP=local-test` (§17.3) is read by `backup.sh` from its environment; G6-S2
  does not set it anywhere.

### 19.3 Script versions

Held by the owner outside the repository; a hash identifies a version and is **not** an approval to run it.

| Script | SHA-256 | Status |
|---|---|---|
| `g6-guest-stack-prepare-v5.sh` | `245fe36a6f43fcdc1e1da3468799f8def3a7917e599b263fced8a341bf65ce1c` | `stack` and `evidence` executed (§19.1) |
| `g6-s2-evidence-inspect.sh` | `da20c10b7a71e235c607d372e3be87887892b0ca95028823ccf02dba1de20522` | executed (§19.1); read-only |
| `g6-s1-host-check.sh` | `9433890d9cdbbbaa6e6b01e06fa5a56b3cb583437d6840b4f20583d1b3ae4eda` | executed (§19.1); read-only |
| `g6-bv-s-check-v3.sh` | `b44ff3fea55529a7b24f05477db0c8ca5e84996d19c09429cf7561d2c1ce4437` | **never executed; superseded** (§19.4) |
| `g6-bv-s-check-v4.sh` | `2e7a8ad7761310b5cc109877ad1f6b74777330656249cbdf8e48fe12f71fa5c9` | **not executed**; the reviewed candidate for G6-BV-S (§19.4) |

### 19.4 G6-BV-S tooling: prepared, not executed

Nothing in this subsection is a G6-BV-S result. **G6-BV-S has not run.**

**Why v3 is superseded.** It carries the §17.5 checks 3 and 4 that §17.7 asked for, but a review against the G6-S2 output found:
- its image check reads names from `docker ps`, which prints short forms in this guest, so it would fail on a correct stack;
- it exits 0 even when it reports a failure;
- its header says the production names arrive on standard input and are never stored, while it passes them on a command line and
  writes them to a temporary file in the guest;
- it writes its evidence directly into `~/g6-vm/state`, which would make the host check's "earlier evidence identical" comparison fail
  afterwards.

**What v4 does instead.**
- **Images:** `docker inspect` on each of the eight containers: the full pinned reference, the pinned digest as image ID, and the same
  digest in the image store; plus the exact container set, networks and unpublished ports.
- **§6.1 checks 1–5,** with check 2 extended to every `*URL` variable (`AUTH_SERVICE_URL` included), on disk and in the running
  containers, and check 3 extended to container environments and labels.
- **Inputs:** two owner-prepared files on the lab; they travel on the SSH session's standard input, are never printed or saved, and
  nothing is written in the guest. Production names are validated first: blank, short, unsafe or over-broad entries are refused.
- **Gates:** the pinned key before the guest is contacted; the §17.5 gate at the start and end of the guest half; an incomplete or
  aborted guest half is a failure.
- **Host half:** the checks of `g6-s1-host-check.sh`, plus v3's own.
- **Evidence:** `~/g6-vm/bv-s-evidence/bv-s-<UTC>/` on the lab; nothing under `~/g6-vm/state`.

**Exit status.** It never exits 0.

| Exit | Meaning |
|---|---|
| 3 | every automated check passed; **G6-BV-S is still not PASS**: check 6 is pending |
| 1 | a check failed, did not run or did not report |
| 2 | STOP before anything was inspected (wrong host, or a missing, unsafe or over-broad input) |

**Validation so far: local only.**
- `bash -n` passes. ShellCheck was not run (not installed on the workstation).
- 37 local cases passed against stub commands and dummy fixtures: success; digest mismatch; wrong reference; extra container; a
  default route; failing subprocesses; credentials; a service URL outside the guest; production names; published ports; network
  errors; Auth events on; equal recipient fingerprints; a wrong pinned key; R3 and baseline changes; missing, malformed, loose and
  over-broad inputs. No test input appeared in any output.
- **Not runtime-tested:** three Docker format expressions (the combined environment-and-labels template, the hostname fields, and the
  six-field container line), and the real `sudo`, `systemctl` and SSH behaviour. A wrong expression would show as a failure, not as a
  pass.

### 19.5 Remaining gates

**Before G6-BV-S:**
1. The owner prepares the two inputs on the lab: the production names, and the production backup recipient certificate fingerprint,
   which the owner verifies. Neither is recorded in this repository.
2. An owner decision on where those inputs are kept on Server 2 and whether they stay afterwards.
3. Owner authorization of the G6-BV-S run with `g6-bv-s-check-v4.sh`.

**For G6-BV-S to pass:**
1. The run ends with exit 3 (every automated check).
2. **Check 6 (§6.1):** evidence that the G6-A production fingerprint is unchanged afterwards. This needs a separately authorized,
   read-only production step; G6-A itself is not rerun (cutover record §5). The script cannot supply it, and exit 3 alone is not a PASS.

**Unchanged:** G6-C is **NOT AUTHORIZED** and does not start before G6-BV-S passes; `g6-vm-provision-qemu.sh` still lacks `ipv6=off`
(§17.5); B1, B2 and B3 (§17.2–§17.4); for production after G6, §15.8.

**Status (2026-10-13, §20):** how check 6 is evidenced, and how the recipient fingerprint is verified, is set out in §20. Nothing in
it has been executed.

## 20. Check 6 procedure: a fresh pre-BV-S production baseline (2026-10-13)

Owner decision of 2026-10-13, recorded for review. It settles how §6.1's check 6 is evidenced and how the production recipient
fingerprint is verified. It changes no other gate, and it **authorizes no production access, no G6-BV-S or G6-C step and no
production change**. **Nothing in this section has been executed:** no capture exists, and production has not been contacted for it.

### 20.1 The deviation

§6.1's check 6 reads "the G6-A production fingerprint is unchanged afterwards". Neither existing record can serve as that reference:
- **G6-A (2026-09-30)** is certified and is not rerun (cutover record §5). Production's running Auth image already differs between
  G6-A and the 2026-10-12 refresh (cutover record §5 and §14), so G6-A no longer describes production.
- **The 2026-10-12 refresh** is recorded only as a summary (cutover record §14). Its detailed output, "PENDING attachment before G6-B"
  in §15.1, was never attached and is not among the owner's retained evidence. This is recorded as a gap. The summary stays as
  historical, owner-supplied evidence; it is not claimed to be a recovered capture.

**Decision:** check 6 is evidenced by two captures of the same read-only block, taken immediately before and immediately after
G6-BV-S, which must be identical under §20.3. The first is a new baseline. It is also checked against the 2026-10-12 summary; a
difference there is a finding to explain before G6-BV-S, not a comparison result.

This also means two production reads where §6.1 implies one, plus one read for the recipient certificate (§20.2).

### 20.2 The three production reads

Each needs its own explicit owner authorization. **None has been performed.**

| Read | What it does | Passes when |
|---|---|---|
| `pre` | runs the refresh block; the output is saved on the owner workstation | the capture is complete and well-formed (§20.3) |
| `recipient` | reads only the public certificate `~/nawara-core/backup/recipient.pem`: fingerprint, mode, owner, and a count of private-key lines | the SHA-256 fingerprint equals the replacement certificate's of 2026-09-29, and no private-key line is present |
| `post` | runs the same block again after G6-BV-S | the capture is complete, and identical to `pre` under §20.3 |

- **The block** is the 2026-10-12 refresh block, unmodified: 125 lines, SHA-256
  `281567ce3f4561feb125e5da99cac01f3b5104f79ec8ad313e971fdb86faf866`.
  - It reads host identity; the ownership and Auth guards; each of the seven containers' image, state, health, restart count and
    start time; readiness and authority agreement; platform versions, networks and migration fingerprints; broker topology by name;
    backup status and schedules.
  - It uses no `sudo` and writes no file. It does run read-only SQL sessions, `/ready` requests and broker listings inside the
    production containers, so it is read-only, not zero-contact.
  - At run time only its line 3 changes, to the owner's trusted host-key fingerprint; the executed text is hashed and recorded.
- **The recipient reference:** the owner reported that fingerprint for production's recipient certificate on 2026-09-29, immediately
  before the Organization production backup certified in the cutover record §3. That is owner-supplied evidence of that day, not of
  today: the `recipient` read confirms whether it is still installed, and its result supplies G6-BV-S's recipient input (§19.5).
- **Access rules:** the owner supplies the production address and a host-key fingerprint verified independently of any work session;
  one pinned host key, strict checking, no trust-on-first-use, every SSH configuration file ignored, no forwarding; the block is sent
  on SSH standard input, never pasted interactively. A failing guard is reported and never corrected.

### 20.3 Comparison rules

- **Both captures must be valid:** every mandatory line present exactly once and well-formed; the seven containers with their four
  lines each; the five retained containers; the END line last; no failure marker; no unrecognized line. The runner's recorded
  SHA-256 and run record must vouch for each file, with SSH exit status 0.
- **Excluded from the comparison, and nothing else:** the timestamps of the first and last line, and the message count of each queue
  line.
- **Must be identical:** identity and every guard value; per container the image reference, image ID, repo digests, revision, state,
  health, restart count, start time, networks, ports and environment names; the retained containers; readiness and agreement; OS,
  kernel, Docker, PostgreSQL and RabbitMQ versions; the networks; the migration lines; broker users, permissions, exchanges,
  bindings, queue names and consumer counts; backup stamps and results; schedule and timer counts.
- **Any other difference, a changed line order included:** check 6 is not met. Nothing is corrected on production.
- **SSH's own messages:** none, or only OpenSSH's post-quantum key-exchange notice, is accepted and recorded. Any other text is
  accepted only after the owner has read it and recorded an acknowledgement of that exact file.

### 20.4 Script versions

Held by the owner outside the repository; a hash identifies a version and is **not** an approval to run it. **None has been run
against production.**

| Script | SHA-256 | Role |
|---|---|---|
| `g6-prod-refresh-block.sh` | `281567ce3f4561feb125e5da99cac01f3b5104f79ec8ad313e971fdb86faf866` | the unmodified 2026-10-12 block |
| `g6-prod-fingerprint-run-v2.sh` | `4e6ed2501b9f63be250254153ba28c943015042f5efda26046896c990358ef4e` | performs one read (`pre`, `recipient` or `post`) per run; refuses without that run's own authorization |
| `g6-prod-fingerprint-compare-v2.sh` | `2ce7bcaeece3c9781f66314410db8222bfde05d68da79f20778f87da6994089c` | local only: validates a capture; compares `pre` with `post` |

The first versions of the runner (`4389a8fd…6573`) and the comparator (`74557cb7…d670`) are superseded and were never used. The
second versions call `ssh` and `ssh-keygen` by full path under a fixed system `PATH`, check the recorded hash and run record of every
capture, treat SSH's messages the same way in all three modes, and verify the evidence directory before writing.

**Validation so far: local only.** `bash -n` passes; 74 local cases passed against a stand-in for `ssh` and hand-made captures;
ShellCheck was not run (not installed on the workstation). The comparator's rules come from the block's own output statements and a
hand-made capture, not from real output: an unanticipated line shape would fail closed and need a local correction.

### 20.5 Evidence and confidentiality

- **Owner workstation only.** The access inputs and the captures are kept in two private directories (mode 700, files mode 600).
  Nothing is overwritten. Nothing is copied to the lab host or the guest.
- **Never in this repository:** the production address, the host key or its fingerprint, the raw captures, and SSH's message files
  (they can name the host).
- **May be recorded here:** script hashes, run times, output hashes, line counts, verdicts, and whether the recipient certificate is
  the 2026-09-29 replacement.
- **Content:** the captures hold no secret value, but they hold production identifiers (Company ID, image digests, variable names,
  broker users).
- **Retention:** kept until G6 is certified. Removing the access inputs afterwards is a separate owner decision.

### 20.6 Remaining G6-BV-S prerequisites and limitations

In order, each with its own owner authorization where it touches a server:
1. The owner supplies the production address, the independently verified host-key fingerprint and the SSH key path.
2. The `pre` read, with a valid capture.
3. The `recipient` read, passing.
4. The two G6-BV-S inputs on the lab, and the decision on keeping them there (§19.5).
5. The G6-BV-S run with `g6-bv-s-check-v4.sh`, ending with exit 3.
6. The `post` read, identical to `pre`.

**G6-BV-S passes only with items 5 and 6 together.** G6-C stays **NOT AUTHORIZED**.

**Limitations.** The block's own host-identity check is self-reported; the pinned host key is the control. Container IDs, firewall
state, file contents and database contents are not compared. The comparison shows that the captured state is unchanged; it cannot
prove that nothing contacted production in between.

**Unchanged:** ADR-0062; B1, B2 and B3 (§17.2–§17.4); the §17.5 gates; §6.1's checks 1–5 and the §16.4 additions; for production
after G6, §15.8.
