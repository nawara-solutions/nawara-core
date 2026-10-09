# Nawara Core roadmap: Core V1 (current), Core V2 (planned), Nawara Admin

- **Status:** Authoritative. This is the one roadmap for Nawara Core: the current Core V1 state and checkpoint, the planned Core V2
  roadmap, the boundary between them, and the relationship with Nawara Admin. Other documents are the authority for their own
  subjects (see [Where the detail lives](#where-the-detail-lives)); when a statement about *status* or *direction* here conflicts with
  an older document, this one wins and the older one is the historical record.
- **Last verified:** 2026-10-07, `main` at `4279203` (V2-A.3 certified by A3.8 with A3.6 / A3.7 deferred; A12 local observability
  certified).
- **Maintenance:** update the [current checkpoint](#current-checkpoint) when a checkpoint closes. Keep this document short: no run
  ids, test counts, branch names or session history. Evidence belongs in the stage records, not here.

## Agent / developer: start here

Before making changes:

1. Read this document.
2. Decide whether the task is **Core V1** (current) or **Core V2** (planned). If it is unclear, ask.
3. Check the [current checkpoint](#current-checkpoint).
4. Distinguish **CURRENT** implementation from **PLANNED** architecture. Planned behaviour is not evidence that it exists.
5. Do not reopen a CLOSED checkpoint without evidence of a regression.
6. Do not implement a Core V2 concept inside Core V1 implicitly.
7. Preserve V1 compatibility (status, `code`, response shape, events) unless the owner explicitly authorizes a change.
8. Treat Nawara Admin mocks as provisional contracts, never as Core contracts.
9. Every production mutation needs its own explicit owner authorization.
10. Final Core Validation is the **absolute last** full Core validation (see [Final Core Validation](#final-core-validation)). Do not
    run it as part of any other task.
11. Every Core V2 work item carries a G6 label (🟢 / 🟡 / 🔴 / ⚪, see [G6](#g6-production-like-rehearsal)). A 🔴 item stops V2
    work until the production track has run.

```text
NAWARA CORE
│
├── CORE V1   CURRENT / REAL       implemented, partly in production; stabilization and refactor active
│
└── CORE V2   FUTURE / PLANNED     architecture roadmap A0–A19; A0 certified (A3.6 / A3.7 deferred), A13, A14 and A12 local observability certified; most stages NOT STARTED
```

---

## Core V1: current / real

Core V1 is the platform that exists in this repository today. Its services, boundaries and principles are described in
[`CLAUDE.md`](../CLAUDE.md) and [`docs/architecture/core-architecture.md`](architecture/core-architecture.md). Its capability set
was closed by [ADR-0052](adr/0052-core-v1-capability-closure.md).

### Production context

| Item | State |
|---|---|
| In production | auth-service, organization-service (**not authoritative**: Auth still owns the hierarchy), audit-service, RabbitMQ (the Auth → Audit relay) |
| Implemented, not in production | billing-service, payment-service, notification-service, file-service, release-service |
| Outside Core | AI runtime: the separate future `nawara-ia` repository ([ADR-0055](adr/0055-ai-service-repository-boundary.md)); Core's `ai-service` scaffold was removed |
| Ownership cutover | gates G1–G5 and steps F1–F5 executed; **G6 not certified** (see below); G7, F6, F7 blocked behind G6 |
| Organization and Audit deployment | **by exact index digest** (V2 A0): a merge only builds a revision-labelled image; a deployment verifies and deploys a selected digest after approval, never rebuilding. Production still runs their legacy images, which the new workflows refuse ([runbook](runbooks/digest-deployments.md)) |
| Auth deployment | **build ≠ deploy** (V2-A.2): a merge touching Auth, `libs/service-kit`, the package files or the Auth image workflow only builds a revision-labelled image; production changes only by an explicit, owner-authorized deployment of an exact index digest ([runbook](runbooks/auth-service-deploy.md)). Before V2-A.2, seven automatic deployments followed the cutover record's certified revision, so production Auth has drifted from the recorded digest ([V2-A record](architecture/core-v2-a-baseline-and-change-safety.md) §1, §6); it was observed on 2026-10-02 running the legacy image `sha256:26164d42…5eaf`, unchanged by the V2-A.2 merge ([certification record](architecture/core-v2-a-2-certification.md) §6) |
| `main` protection | **repository ruleset `main` active** (V2-A.3 / A3.3): pull request required (0 approvals, sole maintainer), required check `core-ci-passed` on an up-to-date branch, conversation resolution, no force push, no deletion; administrator bypass on pull requests only ([record](architecture/core-v2-a-3-ci-and-ruleset.md)) |
| Production credentials and approval | the protected `production` environment (A3.4: owner as required reviewer, administrator bypass off, `main` only) holds the four `DEPLOY_SSH_*` credentials; **every production SSH job waits for its approval** and is dispatch-only (A3.5). Backups are manual only (no schedule). **Until A3.7** the organization-level `DEPLOY_SSH_*` secrets still exist and are readable by a workflow that does not declare the environment ([record](architecture/core-v2-a-3-ci-and-ruleset.md)) |
| Evidence record | [`stage-21-x-cutover-record.md`](architecture/stage-21/stage-21-x-cutover-record.md) (production facts, gates, digests) |

Production facts change only through authorized checkpoints; re-verify against the cutover record and the
[runbooks](runbooks/) rather than trusting this summary.

### G6: production-like rehearsal

G6 is **one successful rehearsal of the complete ownership-transition procedure in an isolated, disposable, production-like Ubuntu
environment** ([G6 plan](architecture/stage-21/stage-21-x-g6-rehearsal-plan.md), decision D-1). It is **not certified**: the owner has
intentionally deferred the rest of the rehearsal.

G6 is not tied to any particular hardware. The plan requires an isolated, disposable Ubuntu VM; where it runs is an owner decision,
for example:

- a disposable local Ubuntu VM;
- a temporary isolated Ubuntu cloud server;
- a spare physical Ubuntu machine.

Whatever the host, the plan's isolation rules apply (no production credentials, network path or backup destination; see the plan
§6.1 and the cutover record §6).

**What G6 blocks:** G7, F6, F7, the backup schedule and the pre-G7 backups (cutover record §7), every Core V2 item labelled 🔴, the
production activation of 🟡 items that depend on the cutover, and Final Core Validation.
**What G6 does not block:** Core V2 development of 🟢 and 🟡 items, and Nawara Admin development.

**G6 is a dependency gate, not a calendar phase** (owner decision, V2-A). It is deferred: not cancelled, not waived, not passed.
Every Core V2 work item carries one label:

| Label | Meaning |
|---|---|
| 🟢 G6-INDEPENDENT | developed, validated and (when separately authorized) released without G6, F6 or F7 |
| 🟡 DEVELOPMENT ALLOWED / PRODUCTION GATED | built and certified locally; production activation waits for the cutover or another deferred gate |
| 🔴 REQUIRES G6/F6/F7 FIRST | needs the post-F6/F7 ownership state: **STOP** and resume the production track |
| ⚪ UNKNOWN | needs evidence before it is classified |

When the first 🔴 item is reached, the production track resumes, in this order and never shortened:

```text
refresh the G6 baseline → G6 → fresh pre-G7 Auth + Organization backup → verify → enable the required backup schedule
→ G7 → F6 → F7 → fresh post-F7 backup → verify → open the remaining callers and gates
```

The refresh re-establishes every production fact G6 depends on (images and digests, migrations, PostgreSQL, RabbitMQ, retained
containers, artifact pinning, deployment automation) for the system as it is then, including whatever Core V2 changed.

### Core V1 refactor (localization and stabilization)

The refactor implements [ADR-0054](adr/0054-localized-error-messages-and-stable-error-codes.md): stable machine `code`s, human
messages in English, French and Arabic, with English byte-compatible. It changes no business behaviour. Each service is implemented,
tested, reviewed and merged separately; services are never batched.

```text
CORE V1 REFACTOR

R0  Architecture inventory                 ✅ CLOSED
R1  Localization architecture (ADR-0054)   ✅ CLOSED
R2  Billing safe logging                   ✅ CLOSED
R3  Shared localization foundation         ✅ CLOSED
R4  Validation localization                ✅ CLOSED
R5  Auth localization adoption             ✅ CLOSED
R6  Remaining services                     ✅ CLOSED
    R6.1 Audit                             ✅ CLOSED
    R6.2 Organization                      ✅ CLOSED
    R6.3 Release                           ✅ CLOSED
         └─ Audit timing-test stabilization ✅ CLOSED
    R6.4 File                              ✅ CLOSED
    R6.5 Payment                           ✅ CLOSED
    R6.6 Billing                           ✅ CLOSED
    R6.7 Notification                      ✅ CLOSED
R7  Shared cleanup                         ✅ CLOSED (no material cleanup required)
R8  Legacy/type cleanup                    ✅ CLOSED (Release error helpers narrowed to MessageTexts)
R9  Refactor regression validation         ✅ CLOSED (merged R3–R8 state verified; negative controls detected)
R10 Documentation + error catalog          ✅ CLOSED (guide and per-service catalog index; no runtime change)
R11 Refactor certification                 ✅ CLOSED / CERTIFIED (refactor only; Core V1 not yet complete)

Final Core Validation (Stage 22)           🔒 ABSOLUTE LAST
```

### Current checkpoint

The Core V1 refactor (R0–R11) is closed and certified ([certification record](architecture/core-v1-refactor-certification.md)).
**Core V1 is not complete:** the remaining work is the production ownership cutover (G6, then G7, F6 and F7; see
[Production context](#production-context)), and Final Core Validation stays last.

Core V2 has started with **V2-A, baseline and change safety** ([V2-A record](architecture/core-v2-a-baseline-and-change-safety.md)):

```text
V2-A  Baseline and change safety
  V2-A.1  Documentation formalization          ✅ CLOSED / CERTIFIED
  V2-A.2  Auth deployment safety transition    ✅ CLOSED / CERTIFIED (build ≠ deploy; no production deployment performed)
  V2-A.3  main ruleset, production environment ✅ CLOSED / CERTIFIED (records-based, A3.8; A3.6 and A3.7 deferred)
    A3.1  design and owner decisions           ✅
    A3.2  core-ci-passed aggregate check       ✅ verified on main
    A3.3  main ruleset                         ✅ active; verified by API readback; pull-request behaviour observed (PR #190)
    A3.4  production environment               ✅ created and verified (secrets entered by the owner; not yet used)
    A3.5  environment on production SSH jobs   ✅ implemented: all six bound to `production` (Auth verify → deploy; backup manual only)
    A3.6  production access proof              ⏸ DEFERRED (D-3)
    A3.7  organization-secret restriction      ⏸ DEFERRED (D-4; required eventually, not waived)
    A3.8  certification                        ✅ certified 2026-10-07 (limitation: the environment is not proven as the sole
                                                  production credential holder)
  A0 immutable-digest deployment (Org, Audit)  ✅ CLOSED / CERTIFIED
A0  stage (V2-A.1 – V2-A.3 + immutable digests) ✅ CERTIFIED, with A3.6 and A3.7 deferred
A12 Observability
  A12.2 – A12.5                                ✅ CLOSED (A12.5: local collection certified)
  A12.6 dashboards, alerting, integration      ✅ LOCAL OBSERVABILITY FORMALLY CERTIFIED / CLOSED ON MAIN (PR #217)
  A12.7 – A12.9                                scope not yet defined
  A12.10 production observability              not started (production scope)
A13 Audit backup / restore                     ✅ certified (tooling, local, CI; production evidence gated)
A14 Supply chain and build provenance          ✅ certified
A1 Architecture                                ✅ CERTIFIED / CLOSED (PR #222, merge 321ec0b)
  A1.0  discovery                              ✅ closed
  A1.1  decisions, ADR governance (Q-ADR-1)    ✅ closed on main (PR #219)
  A1.2  consolidated conventions ADR           ✅ closed on main (PR #219; ADR-0056 Accepted; ADR-0034 superseded)
  A1.3  caller-policy migration                ✅ closed on main (PR #220)
  A1.4  architecture guards                    ✅ closed on main (PR #221)
  A1.5  certification                          ✅ closed on main (PR #222)
A2 Configuration & Secrets                     ✅ CERTIFIED / CLOSED (PR #228, merge 869100d)
  A2.0  discovery, owner decisions             ✅ complete
  A2.1  service-kit configuration hardening    ✅ closed on main (PR #223)
  A2.2  seven-service adoption                 ✅ closed on main (PR #224)
  A2.3  targeted Auth hardening                ✅ closed on main (PR #225)
  A2.4  hygiene, environment reference, rotation ✅ closed on main (PR #226)
  A2.5  repository guards                      ✅ closed on main (PR #227)
  A2.6  certification                          ✅ closed on main (PR #228)
A15 Developer / Platform Experience            ✅ CERTIFIED / CLOSED (PR #233, merge e2adc20)
  A15.0  discovery, owner decisions            ✅ complete (owner-reviewed)
  A15.1  generic CLI configuration hygiene     ✅ closed on main (PR #229)
  A15.2  developer path (guide, Node version)  ✅ closed on main (PR #230)
  A15.3  local environment, test determinism   ✅ closed on main (PR #231)
  A15.4  new-service checklist, localization   ✅ closed on main (PR #232)
  A15.5  certification                         ✅ closed on main (PR #233)
A3 Messaging (A3M; not V2-A.3's A3.6 / A3.7)   🔄 OPEN
  A3M.0  discovery, decision review            ✅ complete (owner-reviewed; OD-A3M-0 to OD-A3M-7 approved)
  A3M.1  records and policy (ADR-0057 Proposed) ✅ closed on main (PR #234)
  G7 proof  isolated dead-letter broker test   ✅ complete: G7 confirmed locally
  A3M.2  event contracts and versioning        ✅ closed on main (PR #236)
  A3M.3  producer and consumer conventions     ✅ closed on main (PR #237; G11 fixed, S21-5 aligned)
  A3M.4  retry, dead letters, idempotency      ✅ closed on main (G7 PR #235; idempotency matrix PR #239)
  A3M.5  outbox / de-duplication retention     ✅ closed on main (PR #240; manual dry-run CLI, runs nowhere)
  A3M.6  deterministic broker evidence         ✅ closed on main (PR #241)
  A3M.7  local certification                   ✅ closed on main (PR #242)
  A3M.8  production messaging                  not started (each item separately authorized)
A4 Authentication                              ✅ CLOSED / CERTIFIED (record: core-v2-a4-authentication.md; nothing deployed in A4)
  A4.0  discovery                              ✅ complete (owner-reviewed; OD-A4-1 to OD-A4-8 approved)
  A4.1  architecture record                    ✅ closed on main (PR #243)
  A4.2  configuration convergence              ✅ closed on main (PR #244)
  A4.3  CLI configuration                      ✅ closed on main (PR #245)
  A4.4  bootstrap convergence (kit filter option) ✅ closed on main (PR #246)
  A4.5  genericity exemption narrowing         ✅ closed on main (PR #247)
  A4.6  JWT key-ring design                    ✅ closed on main (PR #248; ADR-0058 Accepted, PR #249)
  A4.7  JWT key-ring implementation            ✅ closed on main (PR #250)
  A4.8  deployment-readiness tooling           ✅ closed on main (PR #251)
  A4.9  local certification                    ✅ closed on main (PR #252; 24/24 checks, real-image config check passed)
  A4 production checkpoints                    not started (Auth deploy, minimum-image gate, JWT ring activation: each separately authorized)
A5 Organization                                🔄 OPEN, 🔴 (design 🟡) (record: core-v2-a5-organization.md)
  A5.0  discovery                              ✅ complete (read-only inventory, recorded in the A5 record)
  A5.1  architecture and scope record          ✅ closed on main (PR #253; 24/24 checks, core-ci-passed)
  A5.2  ADR reviews (one ADR at a time)        ✅ COMPLETED 2026-10-09: 0039 (#255), 0026, 0028, 0029, 0030, 0031 (#256), 0023 (#257) Accepted; 0017 and 0020 superseded (0059, 0040); 0022 and 0024 Proposed, deferred to A6 (#263)
  A5.3  post-F7 design                         ✅ CLOSED 2026-10-09 (architecture only, #263): OD-A5-1 to OD-A5-5 decided (ADR-0059 to 0063, #258–#262); runtime not implemented, production not activated
  A5.4  implementation                         ⛔ blocked until F7 (proposed; 🔴) for RED work; GREEN / YELLOW / RED governance (A5.4-G1) ACCEPTED 2026-10-09 (A5 record §9.1): each task separately authorized
  A5.5  certification                          not started (proposed)

G6                                             ⏸ DEFERRED (dependency gate); G7, F6, F7 🔒
Final Core Validation (Stage 22)               🔒 ABSOLUTE LAST
```

V2.0 discovery and the V2-A design are accepted. V2-A.1 formalized them, and V2-A.2 made the Auth deployment explicit (build on
merge, deploy an exact index digest only on owner authorization; [runbook](runbooks/auth-service-deploy.md)). Both are certified in
the [V2-A.2 certification record](architecture/core-v2-a-2-certification.md), which also records what stays open: no digest
deployment has been performed yet, and production still runs a legacy image. V2-A.3 has added the stable `core-ci-passed` check, the `main` ruleset,
the protected `production` environment and its approval on every production SSH job, and is **certified records-based by A3.8**
([record](architecture/core-v2-a-3-ci-and-ruleset.md) §8) with A3.6 (production access proof) and A3.7 (organization-secret
restriction) deferred: the environment has not been proven as the sole production credential holder, and the organization-level
credentials still coexist until A3.7. Every change to `main` goes through a pull request with a green `core-ci-passed`. **A0's
immutable-digest deployment work** extends exact-digest deployment to organization-service and audit-service and is certified
([record](architecture/core-v2-a0-immutable-deployments.md): PR #192, first labelled artifacts of all three services built on the
merge); no digest deployment of any of them has been performed (built ≠ deployed; the first one is A3.6, deferred). With V2-A.1 to
V2-A.3, **stage A0 is certified, with A3.6 and A3.7 deferred**. **V2 A13** (Audit
backup and restore coverage) is certified for its tooling, local proof and CI (PR #194, [record](architecture/core-v2-a13-audit-backup.md)
§9); production Audit backup and restore evidence is **not** complete: no production Audit backup or drill has been performed, the first
one is blocked until an authorized Audit deployment applies migration 0004, and scheduled backups stay G6-gated. **V2 A14** (supply chain
and build provenance) is certified (PR #196, [record](architecture/core-v2-a14-supply-chain.md) §12): the post-merge Auth,
Organization and Audit images carry verified GitHub artifact attestations and SBOMs, and the strict verifier refuses every pre-A14
image; built / attested ≠ deployed: no post-A14 image has been deployed (A3.6-class), and its GitHub settings (secret scanning, push
protection, full-SHA requirement) are not enabled. **V2 A12** (observability): the kit metrics, service and messaging metrics, logging
and PII contract (A12.2–A12.4) and the local collection layer (A12.5) are closed, and the **A12.6 local observability** layer (Grafana
dashboards, Prometheus alert rules, the allowlisted self-scrape, integrated validation) is **formally certified and closed on `main`**
(PR #217, [record](architecture/core-v2-a12-observability.md) §4R). It is LOCAL only: production observability (A12.10) has not
started, and the scope of A12.7–A12.9 is not yet defined. **A1 Architecture** is **certified and closed** (PR #222, merge
`321ec0bedccedb0bbee98b5c05c538ca69e5b1ca`; [record](architecture/core-v2-a1-architecture.md)): A1.0 discovery is complete and A1.1 has recorded the owner decisions OD-A1-1 to
OD-A1-6 (an ADR is Accepted on the architecture owner's explicit approval; one consolidated conventions ADR will supersede ADR-0034;
the five hand-written caller-policy parsers move to the kit; Auth code convergence belongs to A4). A1.2 has written the consolidated
conventions ADR, [ADR-0056](adr/0056-core-architecture-and-api-conventions.md), Accepted by the architecture owner on 2026-10-07; it
supersedes ADR-0034 and is the current Core architecture and API convention. A1.3 moved the five hand-written caller-policy parsers to
the kit's `parseCallerPolicy` (PR #220; Organization's stricter grammar by owner decision OD-A1-3a, with a runbook pre-deploy check
before its first such deployment), and A1.4 enforces the caller-policy delegation of all seven consumers and the dependency direction
in `check:repo` (PR #221). A1.5 certified the stage; its certification PR (#222) is merged
([record](architecture/core-v2-a1-architecture.md) §12). **A2 Configuration & Secrets**
([record](architecture/core-v2-a2-configuration-and-secrets.md)): A2.1 hardened the kit's configuration primitives (PR #223), A2.2
adopted them in the seven kit-based services (PR #224), A2.3 hardened Auth inside its own loader (PR #225; loader convergence stays
A4), A2.4 fixed the ignore policy, the environment reference and the rotation runbook (PR #226), and A2.5 guards those invariants in
`check:repo` (PR #227). The A2.6 certification (record §10) found no A2-owned blocker; **A2 is open until its certification PR is
merged, and is certified and closed by that merge.** It is repository and local: activating A2 in the deployed services stays
separately authorized production work, and A2 has no G6 dependency. (The certification PR, #228, has since merged: A2 is certified and
closed.) **A15 Developer / Platform Experience** is open ([record](architecture/core-v2-a15-developer-experience.md)): A15.0 fixed its
scope and decisions, A15.1 put the generic operator CLIs on the kit's configuration reader (PR #229), A15.2 added the canonical
[developer guide](DEVELOPMENT.md) and declared Node 22 (PR #230), A15.3 made the infrastructure test suites deterministic (PR #231),
and A15.4 added the [new-service checklist](NEW-SERVICE-CHECKLIST.md) and two repository guards (PR #232). The A15.5 certification
(record §8) found no A15-owned blocker; **A15 is open until its certification PR is merged, and is certified and closed by that
merge.** It is repository and local, with no production work and no G6 dependency. (The certification PR, #233, has since merged: A15
is certified and closed.) **A3 Messaging** is open as **A3M**
([record](architecture/core-v2-a3m-messaging.md); the substages are named A3M.0 to A3M.8 so they are never confused with V2-A.3's
deferred A3.6 and A3.7): A3M.0 inventoried the messaging implementation and found G1–G10, and the owner approved OD-A3M-0 to OD-A3M-7.
A3M.1 (documentation only, PR #234) added [ADR-0057](adr/0057-messaging-conventions.md), **Proposed**, which states the current
conventions and reconciles ADR-0018 and ADR-0037 by forward notes. An isolated broker proof then **confirmed G7** (a cross-consumer
dead-letter copy through the shared fanout exchange); its code remediation (A3M.4, R1) merged with PR #235, and the rest of A3M.4 is not
started. A3M.2 (per-service event catalogs, a contract guard, Billing's version check) merged with PR #236. A3M.3 (PR #237) proved
and fixed finding G11 (a forged message could claim a Payment event id in Billing and block the genuine outcome) and removed Payment's
broker readiness dependency (S21-5). The rest of A3M.4 (PR #239) records the idempotency matrix of every producer and consumer
and the open findings F1 to F7; F1 (forged events to Notification) and F2 (Audit's first-writer residual) are **not resolved** and are
security prerequisites to review before the corresponding production activation (P-A1 / A14, A7). A3M.5 (PR #240) records the
retention policy (every consumer de-duplication record is kept) and adds a manual, dry-run-first `nawara-outbox-retention` CLI for
published outbox rows; it runs nowhere and is not scheduled. A3M.6 (PR #241) records the 16-scenario real-broker
evidence matrix and proves Billing's version and source refusals and the G11 fix over a real broker, plus Notification's refusal of an
unmapped source; a broker restarted mid-flow stays a documented limitation (A3M record §15). A3M.7 (PR #242) certifies the local and repository implementation on reused CI evidence, keeps F1 and F2 open, and
certifies nothing in production (A3M record §16). A3M is local; every production messaging change (`AUTH_EVENTS`, broker identities, topology,
retention activation) is separately authorized (A3M.8).

A4 (authentication; [A4 record](architecture/core-v2-a4-authentication.md)) converges the existing Auth implementation on the kit
(configuration, CLIs, bootstrap with its exception filter, the genericity exemption) and adds a JWT signing-key ring designed in A4.6
before it is built in A4.7 (OD-A4-1 to OD-A4-8). It adds no new authentication feature, deploys nothing (each merge only builds an Auth
image) and leaves `AUTH_EVENTS` to A3M.8. A4 is closed: A4.1 to A4.9 are merged (PRs #243 to #252, ADR-0058 Accepted) and A4 is
certified on repository, CI and local evidence (record §18), not on production evidence. Production Auth still runs a pre-V2-A.2 image; its next
deployment is a separate, owner-authorized checkpoint with its own compatibility review, and a production JWT key ring is not
activated before a separately authorized minimum-image gate exists (record §15, §18.7).

A5 (organization; [A5 record](architecture/core-v2-a5-organization.md)) is labelled 🔴 (design 🟡). Auth remains the hierarchy authority
and organization-service is implemented but inactive; after F7 organization-service is the only authority for Company, Platform and
Organization while Auth keeps identities, memberships, join codes and invitations. A5.0 and A5.1 record the inventory, the authority
map and proposed sub-stages and owner decisions; the A5.2 review of the ten Organization ADRs is recorded (A5 record §11). ADR-0039 was
accepted (PR #255); on 2026-10-09 the owner accepted ADR-0031, 0026, 0028, 0029 and 0030, each separately, with the related ADR-0001
and ADR-0004 metadata, merged as the grouped A5.2 documentation pull request (#256; A5 record §11.9); ADR-0023 was accepted on
2026-10-09 (A5.2-I) and merged (#257), which resolves OD-A4-8; OD-A5-3 is decided by ADR-0059 (merged, #258); the OD-A5-1
lifecycle policy is decided by ADR-0060 (merged, #259; no lifecycle runtime exists); OD-A5-4(a)–(d), the Auth hierarchy-reference repair
and diagnostics, are decided by ADR-0061 (merged, #260; no repair functionality exists);
the OD-A5-2 initial-hierarchy policy is decided by ADR-0062 (merged, #261; no
Platform or Organization exists in production; provisioning-credential retirement and `allowedPlatforms` scope tooling are future
prerequisites); the OD-A5-5 and OD-A5-4(e) policies are decided by ADR-0063 (merged, #262; the
readiness check, static boundary test, `EnvReader` convergence, diagnostic CLI and command retirement are not implemented; no production
transition has occurred); ADR-0017 is superseded by ADR-0059 and ADR-0020 by ADR-0040, and ADR-0022 (partially superseded by ADR-0040)
and ADR-0024 stay Proposed, deferred to A6; **A5.3's architecture design is complete** (runtime not implemented, production not
activated): **A5.2 is COMPLETED and A5.3 CLOSED (architecture only) on 2026-10-09** (closure PR #263); A5.4 and A5.5 stay gated; design and ADR reviews proceed now, and every runtime or authority change waits for
G6 → pre-G7 backup → G7 → F6 → F7 → post-F7 backup.

### Compatibility and safety rules for V1 work

- Existing public contracts are preserved: HTTP status, `code`, response shape, event payloads, success bodies. Existing code-less
  errors stay code-less. Default English stays byte-identical.
- No breaking redesign inside V1. A change that would break a contract stops and goes to the owner.
- No production action (deploy, restart, `.env`, secrets, migrations, container changes) without a separate explicit authorization.
  Since V2-A.2, merging to `main` on the Auth paths (`apps/auth-service/**`, `libs/service-kit/**`, `package.json`,
  `package-lock.json`, `auth-service-docker-build.yml`) **builds** an Auth image and never deploys it; deploying an exact index digest
  is a separate, owner-authorized production mutation ([runbook](runbooks/auth-service-deploy.md)). Organization and audit-service
  deployments are manual and still rebuild `main` at dispatch; know a change's workflow impact before it merges.

### Final Core Validation

Final Core Validation (Stage 22) is the **absolute last** full Core validation: the expensive, platform-wide run that happens
**once**, only after the planned Core/platform work (including Core V2's committed scope), the required production gates (G6, G7,
F6, F7 and what follows them) and the appropriate V2 capability certifications are complete (owner decision, V2-A). Earlier records
that place it at the end of Core V1 or immediately after the cutover are historical and are superseded by this decision.

It is **not** re-run after each service, checkpoint or V2 phase. Each checkpoint gets its own focused validation instead: its tests,
negative controls, risk-based regression and CI (the [V2 validation protocol](architecture/core-v2-a-baseline-and-change-safety.md#8-v2-per-capability-validation-protocol)).

---

## Core V2: future / planned

> **PLANNED. NOT YET IMPLEMENTED.** Nothing in this section exists in the code unless a V1 section above says so. A Core V2 stage
> starts only when the owner authorizes it. No completion percentages are tracked here.

Core V2 is the next platform architecture. It may redesign contracts deliberately, but only through explicit design documents
(ADR/ADD/SDD/TDD) and a migration plan, never by drift.

| Stage | Scope (planned) | G6 label |
|---|---|---|
| **A0 Baseline** | the certified V1 baseline: service versions, API compatibility, deployment topology, infrastructure assumptions | 🟢 |
| **A1 Architecture** | service boundaries; standard bootstrap and service-kit adoption; Auth convergence; common request context; compatibility and migration strategy | 🟢 |
| **A2 Configuration & Secrets** | typed and validated configuration; environment separation; secret lifecycle and rotation; deployment contracts | 🟢 |
| **A3 Messaging** | broker conventions; event envelopes and versioning; retry, DLQ, idempotency; producer and consumer conventions; real-broker certification | 🟢 / 🟡 production |
| **A4 Authentication** | sessions, MFA/TOTP, recovery, WebAuthn, cookies, rate limits, service authentication, account lifecycle and security | 🟢 |
| **A5 Organization** | companies and organizations, memberships, ownership, invitations, organization lifecycle, the Auth–Organization interaction | 🔴 (design 🟡) |
| **A6 Authorization** | roles, permissions, policy evaluation, caller and service policies, ownership-aware authorization, cross-service enforcement | 🟡 |
| **A7 Audit** | event schema, accountability, producers, retention and querying, correlation, cross-service coverage | 🟢 |
| **A8 Notification** | templates, content localization, channels, delivery lifecycle, retries and fairness, preferences, observability, product contracts | 🟡 |
| **A9 File** | upload and download, authorization, metadata, limits, storage abstraction, failure handling, cleanup and lifecycle, security | 🟢 |
| **A10 Billing** | plans, subscriptions, billing entities, lifecycle and state, invoices and records, reconciliation, product integration | 🟡 |
| **A11 Payment** | provider architecture, webhooks, idempotency, reconciliation, failures, security, the Billing–Payment interaction | 🟡 |
| **A12 Observability** | logs, metrics, tracing, correlation, dashboards, health, alerts, redaction and privacy | 🟢 |
| **A13 Backup / Disaster Recovery** | automation, off-server storage, integrity, retention, restore automation and rehearsal, runbooks, RPO/RTO | 🟢 / 🟡 schedule |
| **A14 Security** | Auth/Authz, service authentication, secrets, rate limits, proxy trust, input handling, F13 (opaque internal errors), dependencies and supply chain, security regression | 🟢 |
| **A15 Developer / Platform Experience** | service templates, shared libraries, local environment, testing and CI conventions, documentation, generators, localization conventions | 🟢 |
| **A16 Product Integration** | for Nawara School, Nawara Drive and future products: API contracts, authentication, authorization, organization/tenant context, files, notifications, billing and payment, audit | 🟡 / 🔴 |
| **A17 Product Readiness** | end-to-end product workflows, failure paths, onboarding, permissions, operations, deployment readiness | 🔴 |
| **A18 Performance** | load testing, bottlenecks, database and broker behaviour, connection pools, caching, scaling, capacity and load balancing | 🟢 local / ⚪ production |
| **A19 Release Certification** | final V2 certification across architecture, services, security, integration, observability, DR, performance, product readiness, documentation and CI | 🔴 |

The G6 labels are defined under [G6](#g6-production-like-rehearsal); the reasons are in the
[V2-A record](architecture/core-v2-a-baseline-and-change-safety.md) §4. A0 includes **V2-A.2** (the Auth deployment transition:
a merge builds an immutable image, and production is deployed only by an explicit, owner-authorized deployment of an exact digest)
and **V2-A.3** (the `main` ruleset and the `production` environment). V2-A.2 is certified ([record](architecture/core-v2-a-2-certification.md)); V2-A.3 is certified records-based by A3.8, with A3.6 and A3.7 deferred ([record](architecture/core-v2-a-3-ci-and-ruleset.md) §8). **A0's immutable-digest deployment work (Organization and Audit)** follows the Auth model and is certified, with no production deployment ([record](architecture/core-v2-a0-immutable-deployments.md)). Stage A0 as a whole is certified with A3.6 and A3.7 deferred. The items left open by the retired 21.R1/21.R2 umbrella are placed in
A1, A3, A6, A12, A13, A14, A15 and A16 by the [V2-A record](architecture/core-v2-a-baseline-and-change-safety.md) §5.

**Ordering.** Stages are numbered by theme, not by order. Work is sequenced by dependency: A0 first; foundations (A1, A2, A3, A15)
before the services that adopt them; 🟢 and 🟡 work continues while G6 is deferred; the first 🔴 item stops V2 work until the
production track has run. Every capability is certified on its own by the
[V2 validation protocol](architecture/core-v2-a-baseline-and-change-safety.md#8-v2-per-capability-validation-protocol); A19 certifies
V2, and Final Core Validation follows it, last.

**Outside committed V2 scope: FUTURE / IDEA / REQUIRES SEPARATE SCOPE DECISION.** `accounting-service`, `location-service`,
`search-service` and `analytics-service`. They appear in
[`core-architecture.md`](architecture/core-architecture.md) as later services; that is not a V2 commitment. AI is not a Core
service at all: its runtime belongs to the separate future `nawara-ia` repository ([ADR-0055](adr/0055-ai-service-repository-boundary.md)).

---

## The V1 / V2 boundary

| Area | Core V1 | Core V2 |
|---|---|---|
| Status | current, real, partly in production | planned, future |
| Purpose | stabilize, refactor and certify the existing platform | the next platform architecture |
| Compatibility | existing contracts preserved | deliberate migrations may be designed |
| Breaking redesign | avoided; stops and goes to the owner | only through explicit design and a migration plan |
| Localization | the R0–R11 refactor program (ADR-0054) | a native platform convention (A15) |
| Authentication | the existing Auth implementation | planned convergence and evolution (A1, A4) |
| Admin integration | existing APIs where they exist | the primary future target |
| New contracts | only when explicitly required | designed systematically |

**Rules:**

- Do not implement a Core V2 roadmap item while working on Core V1 unless the owner explicitly authorizes it.
- Planned Core V2 behaviour is not evidence that the behaviour already exists in Core V1.
- Accepted ADRs remain binding for V1. A V2 design that departs from one supersedes it with a new ADR; it is never edited away.

---

## Nawara Admin

**Nawara Admin** (`nawara-admin`) is a **separate repository**: an operator frontend that consumes Core APIs. It is not a Core
microservice and holds no Core business rule. It may be developed in parallel with Core.

```text
                 NAWARA PLATFORM

       ┌─────────────────────────────┐
       ▼                             ▼
   nawara-core                  nawara-admin
   backend platform             operator frontend
       │                             │
       └────── API CONTRACTS ────────┘
```

Two accepted decisions already govern it:

- [ADR-0041](adr/0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md): administrative capabilities are APIs of
  the domain service that owns the data, client-neutral, and authorized by the server on every request. Any access or composition
  layer holds no business rule, authority or state.
- [ADR-0050](adr/0050-platform-administration-and-verified-human-authority.md): a privileged human presents their **own** Auth bearer
  to the target service, which verifies them live. Headers, body fields and links are never authority. There is no delegated-human
  token system.

> **Terminology.** "Operator" in this section means a person using Nawara Admin. In Core V1, `operator` is also a specific Auth
> account kind (`owner | operator | member`, [ADR-0012](adr/0012-owner-managed-operator-schedule-and-blocking.md)), and today's
> human platform administration (Release, Audit) is performed by the **owner** of the operating Company. Which Core identities may
> use which Admin capability is an authorization decision for Core (A6), not an Admin assumption.

### Contract states

Every Admin feature declares which state its backend contract is in.

| State | Meaning | Admin may |
|---|---|---|
| 🟢 **EXISTING / CONFIRMED** | the endpoint exists in Core today; its contract is the service's OpenAPI at `GET /<service>/docs` (mounted only when `SWAGGER_PASSWORD` is set, behind basic authentication) | integrate directly (and check whether that service is in production) |
| 🟡 **PLANNED V2 / MOCKED** | the capability is in the accepted V2 direction; no real endpoint yet | build UI, domain models, an API interface, a mock adapter and mock data. **The mock is not the backend contract.** |
| 🔴 **UNDEFINED** | Core has not established the contract | design UX, placeholders and frontend-only view models. **No permanent backend API or schema may be declared;** a Core design decision comes first. |

Existing human-facing administration in Core V1 (🟢; exact routes in each service's `/docs`):

| Service | Human administration that exists | In production |
|---|---|---|
| auth-service | authentication (password, TOTP, WebAuthn, step-up), grants, owner administration of operators and members | yes |
| organization-service | Company/Platform/Organization reads and admin writes (`/organization/admin/…`) | yes, not authoritative |
| audit-service | owner read of one organization's audit records (`/audit/owner/…`) | yes |
| release-service | owner withdrawal and minimum-version administration (`/release/admin/…`) | no |
| billing-service, payment-service | service-token APIs only; **no human administration API** | no |

### Frontend structure (mock versus real)

```text
Angular component
       │
       ▼
Facade / store
       │
       ▼
Domain API interface
       ├──── Mock adapter          (🟡 PLANNED, 🔴 UNDEFINED)
       └──── Core HTTP adapter     (🟢 EXISTING)
```

Components never know whether their data is mocked or real. Moving a feature from mock to real replaces an adapter, not the UI.
This document prescribes the layering, not a state library; that choice belongs to the Admin project.

### Organization context (Admin / V2 product direction, not implemented)

```text
Global context
 ├── Platform overview · Organizations · Users/identity · Licenses
 ├── Billing · Payments · Services · Audit · Platform operations
 │
 ▼ select an organization
Organization context
 └── Overview · Users · Roles/permissions · Licenses · Billing · Payments · Files · Notifications · Audit
```

Selecting an organization is **context selection, not authentication**. The operator stays the same authenticated human; Core
authorizes each request from the operator, the organization and the requested action (ADR-0050). No token claim, header or
endpoint for "switching" exists or is implied.

### Licenses: ownership decided, operator contract undefined

The intended Admin flow is: Licenses → Create → select organization → select product (Nawara School, Nawara Drive, future
products) → plan / entitlements → validity / limits → review → activate.

What exists today:

- **Ownership is decided:** entitlement belongs to **billing-service**
  ([ADR-0038](adr/0038-entitlement-in-billing-service.md), shape in
  [ADR-0044](adr/0044-subscription-entitlement-final-model.md): one organization-scoped Subscription; there is no `License` or
  `UserSubscription` entity). Authentication never depends on entitlement ([ADR-0026](adr/0026-authentication-is-not-entitlement.md)).
- **No operator API exists** to create or change a subscription or entitlement. Billing exposes service-token APIs only.

So the license-management backend contract is **PLANNED / TO BE DEFINED DURING CORE V2** (A10, with A6 for authority). Fields
such as `maxUsers`, `storageQuota`, `features`, `validity`, `plan` or API access are **not** backend fields because a screen
needs them. Whether "license" becomes its own term or stays Billing's Subscription/Entitlement is a V2 design decision against
ADR-0044, not an Admin decision.

### Domain boundaries (not collapsed for the UI)

| Domain | Owns |
|---|---|
| Release | products, components, releases, client compatibility (ADR-0051); never entitlement |
| Billing | what is owed and what is entitled: catalog, prices, invoices, Subscription/Entitlement |
| Payment | how money moved: payments, attempts, provider webhooks, reconciliation |
| Auth / Organization | who the actor is, and which organization and authority they act in |

An Admin screen may combine several of these; the backend contracts stay separate.

### Authorization

Admin should be permission-aware: it may hide or disable actions the operator cannot perform. **Frontend authorization is not
security enforcement.** Core is authoritative, and every privileged operation is enforced server-side by the owning service.

### Localization

Admin is designed for English, French and Arabic, with an RTL-capable layout for Arabic. Frontend localization is the Admin
project's concern. Core's localized `message` is for display only. Application behaviour keys on stable machine values
(`code`, status, enums), **never on parsing a Core human message** (ADR-0054).

---

## Where the detail lives

| Subject | Authority |
|---|---|
| Status and direction (this roadmap), V1/V2 boundary, Admin relationship | this document |
| Decisions | [`docs/adr/`](adr/) |
| Service architecture and boundaries | [`core-architecture.md`](architecture/core-architecture.md), [`financial-architecture.md`](architecture/financial-architecture.md) |
| One service's design | [`docs/sdd/`](sdd/) and the service's README |
| Exact API contract | the service's OpenAPI at `GET /<service>/docs` (JSON at `/<service>/docs-json`; mounted only when `SWAGGER_PASSWORD` is set, behind basic authentication) |
| Production facts and gates | [`stage-21-x-cutover-record.md`](architecture/stage-21/stage-21-x-cutover-record.md), [`docs/runbooks/`](runbooks/) |
| Product integration | [`core-product-integration-guide.md`](architecture/core-product-integration-guide.md) |
| Error localization and the per-service error-code index | [`core-error-localization.md`](architecture/core-error-localization.md) |
| Core V1 refactor certification (R11) | [`core-v1-refactor-certification.md`](architecture/core-v1-refactor-certification.md) |
| Core V2 baseline, G6 labels, V2 scope, 21.R1/21.R2 disposition, deployment and `main` risks, V2 validation protocol | [`core-v2-a-baseline-and-change-safety.md`](architecture/core-v2-a-baseline-and-change-safety.md) |
| V2-A.1 closure and V2-A.2 certification (Auth build ≠ deploy; gate history; production evidence) | [`core-v2-a-2-certification.md`](architecture/core-v2-a-2-certification.md) |
| V2-A.3 A3.1 to A3.8: owner decisions, the `core-ci-passed` check, the `main` ruleset, the `production` environment, the A3.8 certification (A3.6 / A3.7 deferred) | [`core-v2-a-3-ci-and-ruleset.md`](architecture/core-v2-a-3-ci-and-ruleset.md) |
| V2 A0: Organization and Audit immutable-digest deployment; generic build and deploy guards | [`core-v2-a0-immutable-deployments.md`](architecture/core-v2-a0-immutable-deployments.md) |
| V2 A14: supply chain and build provenance (SHA-pinned actions, pinned bases, SBOM, GitHub artifact attestations, attestation-verifying deploys) | [`core-v2-a14-supply-chain.md`](architecture/core-v2-a14-supply-chain.md) |
| V2 A13: Audit backup and restore coverage (O1–O6, the O3-B privilege finding, design, evidence) | [`core-v2-a13-audit-backup.md`](architecture/core-v2-a13-audit-backup.md) |
| V2 A12: observability (kit metrics, logging and PII, local collection, Grafana dashboards, alert rules, integration, local certification) | [`core-v2-a12-observability.md`](architecture/core-v2-a12-observability.md) |
| V2 A1: architecture (scope, A1.0 findings, owner decisions OD-A1-1 to OD-A1-6, the review of every Proposed ADR, A1 targets) | [`core-v2-a1-architecture.md`](architecture/core-v2-a1-architecture.md) |
| V2 A2: configuration and secrets (findings, owner decisions, A2.1 to A2.5, the A2 certification) | [`core-v2-a2-configuration-and-secrets.md`](architecture/core-v2-a2-configuration-and-secrets.md) |
| V2 A15: developer and platform experience (A15.0 scope and owner decisions, the phases, A15.1 CLI configuration hygiene, A15.2 developer path, A15.3 test determinism, A15.4 conventions, the A15 certification) | [`core-v2-a15-developer-experience.md`](architecture/core-v2-a15-developer-experience.md) |
| V2 A4: authentication (A4.0 inventory, preserved guarantees, owner decisions OD-A4-1 to OD-A4-8, convergence and key-ring requirements, the A4.1 to A4.9 stages, validation, deployment exclusion) | [`core-v2-a4-authentication.md`](architecture/core-v2-a4-authentication.md) |
| V2 A5: organization (A5.0 inventory, authority today and after F7, the Auth ↔ Organization interaction, classification, the production gate, proposed sub-stages A5.1 to A5.5, owner decisions OD-A5-1 to OD-A5-5 (OD-A5-3 decided through ADR-0059; OD-A5-1 decided through ADR-0060; OD-A5-4(a)–(d) decided through ADR-0061; OD-A5-2 decided through ADR-0062; OD-A5-4(e) and OD-A5-5 decided through ADR-0063; A5.2 completed and A5.3 closed, architecture only, 2026-10-09 (#263); ADR-0017 and 0020 superseded, 0022 and 0024 deferred to A6), ADR review priorities, the A5.2 review record of the ten Organization ADRs) | [`core-v2-a5-organization.md`](architecture/core-v2-a5-organization.md) |
| V2 A3M: messaging (A3M.0 inventory and findings G1–G10, owner decisions OD-A3M-0 to OD-A3M-7, the A3M.0 to A3M.8 phases, the G7 proof, A3M.1 records and policy) | [`core-v2-a3m-messaging.md`](architecture/core-v2-a3m-messaging.md) |
