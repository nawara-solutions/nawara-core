# Stage 21.x G6 — production-like rehearsal plan

- **Status:** PROPOSED — owner decisions approved 2026-09-30; recorded here before any rehearsal step runs.
- **Gate:** ADR-0040 decision 7, G6 (and the parts of G4 and G5 that ADR-0040 assigns to the rehearsal plan).
- **Revision under rehearsal:** `9e29c763179dc954e668d6287a07098c0450decf`.
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
