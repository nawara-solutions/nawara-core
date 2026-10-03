# Core V2-A: baseline and change safety

- **Status:** RECORD of accepted owner decisions (V2-A, 2026-10-02). Documentation only: it changes no workflow, repository setting,
  source, test or production state, and it authorizes nothing further.
- **Scope:** the Core V2 starting baseline, the G6 dependency-gate model, the placement of Final Core Validation, the V2 scope
  boundary, the disposition of the old 21.R1/21.R2 umbrella, the Auth deployment and `main` protection risks with their accepted
  future direction, and the V2 per-capability validation protocol.
- **Related:** [roadmap](../CORE-ROADMAP.md) (status and direction), [Core V1 refactor certification](core-v1-refactor-certification.md),
  [Stage 21.x cutover record](stage-21/stage-21-x-cutover-record.md), [G6 rehearsal plan](stage-21/stage-21-x-g6-rehearsal-plan.md),
  [production readiness](production-readiness.md).

## 1. Baseline

| Item | Value |
|---|---|
| Core V1 refactor R0–R11 | **CERTIFIED**, not reopened ([certification record](core-v1-refactor-certification.md)) |
| Certified `main` baseline | `f07fbe0` (merge of PR #185; the R11 record's `cb37cc0` plus the R11 documentation commit only) |
| Production ownership cutover | G1–G5, F1–F5, T1 and G6-A certified; **G6 DEFERRED**; G7, F6, F7 **LOCKED** ([cutover record](stage-21/stage-21-x-cutover-record.md)) |
| Final Core Validation | **ABSOLUTE LAST**; not run |

**Production drift observed after the cutover record (read-only, from GitHub Actions run results).** After the cutover record's
certified revision `9e29c763`, seven pushes to `main` touched the automatic Auth deployment paths, and each run of
`auth-service-docker-build.yml` completed `build-production` and `deploy-production` successfully: `093e3ee`, `b20bbab`, `08475a5`,
`52160a2`, `fe5d106`, `fd8c743`, `97f78cb` (the last on 2026-10-02T07:38Z). Production Auth therefore no longer runs the image
digest the cutover record certified. The digest it does run has **not** been verified on the server: the last run's log shows two
`sha256` values, and which one is the deployed manifest is unresolved. No migration changed after `9e29c763`, so the migration
fingerprints of G6-A still describe the schema. Organization and audit-service are deployed manually and were not redeployed; `main`
contains localization changes to both that production does not run.

## 2. G6 is a dependency gate

G6 is **deferred**: not cancelled, not waived, not passed. It is a **dependency gate**, not a calendar phase of V2: no V2 phase is
scheduled "after" it.

Every V2 work item carries one label:

| Label | Meaning | What happens |
|---|---|---|
| 🟢 **G6-INDEPENDENT** | can be developed, validated and (where separately authorized) released without G6, F6 or F7 | continue |
| 🟡 **DEVELOPMENT ALLOWED / PRODUCTION GATED** | can be built and certified locally; its production activation depends on the cutover or another deferred production gate | build and certify; production activation waits for the gate |
| 🔴 **REQUIRES G6/F6/F7 FIRST** | meaningful implementation genuinely needs the post-F6/F7 ownership state | **STOP** and resume the production track |
| ⚪ **UNKNOWN** | not enough evidence | investigate before classifying; never treat as 🟢 by default |

When the first 🔴 item is reached, the production track resumes in this order and is never shortened:

```text
refresh the G6 baseline (current images and digests, migrations, PostgreSQL, RabbitMQ, retained containers,
                         artifact pinning, deployment automation, every assumption V2 changed)
        ↓
G6 (G6-B, BV, C, D, E, F)
        ↓
fresh pre-G7 Auth + Organization backup → verify → enable the required backup schedule
        ↓
G7 → F6 → F7
        ↓
fresh post-F7 Auth + Organization backup → verify
        ↓
open the remaining callers and gates
```

Every step is a separate, owner-authorized checkpoint. No gate is weakened or removed to unblock V2.

## 3. Final Core Validation placement (owner decision)

Final Core Validation (Stage 22) is the **absolute last** full Core validation. It runs once, only after:

1. the planned Core/platform work (including Core V2's committed scope) is complete;
2. the required production gates (G6, G7, F6, F7 and what follows them) are complete;
3. the appropriate V2 capability certifications exist.

It is **not** placed immediately after V1 or after F7 because older documents ordered it that way, and it is **never** run per phase.
Earlier statements that tie it to the end of V1 or to the end of the cutover are historical; this decision governs. Its relationship
to roadmap stage A19 (V2 certification): A19 certifies the V2 capabilities; Final Core Validation follows it.

## 4. V2 scope boundary

**Committed V2 candidates** (roadmap A0–A19 and the open items moved into them by §5):

| Area | Content | Label |
|---|---|---|
| A0 | baseline and change safety (this record; V2-A.2 Auth deployment transition; V2-A.3 `main` policy) | 🟢 |
| A1, A2, A15 | architecture, configuration and secrets, developer/platform experience (incl. CI for the existing ai-service scaffold) | 🟢 |
| A3 | messaging conventions; production `AUTH_EVENTS=on` and per-service broker users are production steps | 🟢 development / 🟡 production |
| A4, A14 | authentication and security hardening | 🟢 |
| A12 | observability | 🟢 |
| A13 | backup and disaster recovery; enabling the backup schedule is G6-gated | 🟢 / 🟡 |
| A7, A9, Release production readiness | audit, file, release | 🟢 |
| A8 | notification; Auth-triggered delivery needs `AUTH_EVENTS=on` | 🟡 |
| A6 | authorization; ownership-aware checks need an authoritative Organization | 🟡 |
| A10, A11 | billing and payment; Organization-bearing creates fail closed (`503 hierarchy_unavailable`) until Organization is authoritative | 🟡 |
| A5 | organization; authority, hierarchy and Auth–Organization interaction paths | 🔴 (design 🟡) |
| A16 | product integration; opening callers is the last part of F7 | 🟡 / 🔴 |
| A17, A19 | product readiness, V2 certification | 🔴 |
| A18 | performance | 🟢 locally / ⚪ production |

**FUTURE / IDEA / REQUIRES SEPARATE SCOPE DECISION** (not committed to V2; not implemented): `accounting-service`,
`location-service`, `search-service`, `analytics-service`, and a major `ai-service` build-out. Their mention in
[core-architecture.md](core-architecture.md) is not a V2 commitment. CI hygiene for the existing ai-service scaffold is A15 work and
does not commit AI implementation to V2.

## 5. The 21.R1 / 21.R2 umbrella: disposition

21.R1 (quality / API audit) and 21.R2 (controlled refactor) were defined in the
[Stage 21.C.1 design](stage-21/stage-21-c-1-capability-closure-design.md) §19–20 and received items from Stages 16–21. No record
ever closed them. The umbrella is **retired by this record**; every known item is placed below, so nothing is lost.

| Item (source) | Disposition | Evidence / where it now lives |
|---|---|---|
| F3 proxy and client-address trust (20.7; Stage 21 §9) | **CLOSED** | PR #159 (`b20bbab`) |
| F13 raw internal errors in logs | **CLOSED** | PR #158 (`093e3ee`) |
| S21-7 notification fairness flake | **CLOSED** | PR #153 |
| S21C2-1 release limiter-key test | **CLOSED** | PR #155 |
| S21C3-1 file S3 client-abort timing | **CLOSED** | PR #156 |
| CI-1 red CI (20.7 §8) | **CLOSED** | Core CI green at the certified baseline ([R11 record](core-v1-refactor-certification.md)) |
| S21-3 Auth's own error envelope | **SUPERSEDED** | R5: `AuthExceptionFilter` extends the kit's `KitExceptionFilter` (ADR-0054) |
| Core-wide error conventions (16.10 §10) | **SUPERSEDED** | ADR-0054 and the R0–R11 refactor |
| S21-4 older outbound clients follow redirects, no response cap (kit `HttpAuthClient`, Organization's Auth-grants client, Billing's Payment client) | **STILL OPEN** → **A14** | no redirect handling in those three clients |
| S21-5 Payment makes the broker a readiness dependency | **STILL OPEN** → **A3 / A12** (an SRE decision, production-readiness §3) | `apps/payment-service/src/health/rabbitmq-readiness.ts` |
| Optional migration of the five hand-written caller-policy parsers (Organization, Notification, File, Audit, Release) to the kit | **STILL OPEN (optional)** → **A1 / A6** | only Payment and Billing use the kit's `parseCallerPolicy` |
| API route naming (`/notification/notifications`, File's routes) (16.10, 17.6, 17.9, 18.1) | **STILL OPEN** → **A1 / A16**; a breaking change needs a V2 design and migration plan | V1 contracts are preserved |
| F9 `rabbitmq-diagnostics` health checks run as root (18.5) | **STILL OPEN (low)** → **A15** | `core-ci.yml`, `docker-compose.yml` |
| `CLAUDE.md` names `libs/shared-types`, omits `libs/audit-contract` (18.1; 18.5 F11) | **CLOSED** by V2-A.1 | `CLAUDE.md` |
| ADD drift: events described as not delivered (18.1 §2.5) | **STILL OPEN** → **A15** (documentation) | `docs/add/auth-service.md`, `docs/add/payment-service.md` |
| ADR-0037 and ADR-0018 still Proposed; Q-ADR-1 (formal Proposed → Accepted point) | **STILL OPEN** → **A1** (owner decision) | §7 below |
| Retention of published outbox rows and technical tables (F12) | **STILL OPEN** → **A3 / A13** | [production readiness](production-readiness.md) F12 |
| Core-wide DTO conventions (16.10 §10) | **UNKNOWN** → assess in **A1** | no record defines or closes them |
| Kit overload answer for pool exhaustion; readiness that does not queue behind requests (17.9 §16) | **UNKNOWN** → assess in **A12** | no closure found |
| "Focused regression / security" pass after 21.R2 | **UNKNOWN** → covered by the V2 protocol (§8) and A14 | R9 covered the localization regression only |

The R11 record's own non-blocking follow-ups (the Billing `57P01` teardown race, timer-dependent tests, the Audit and Release
`auth_timeout` attribution, the local RabbitMQ development issue, the D10 policy and the deferred R4 variants) stay open and belong
to **A15** (tests and environment) and **A1** (D10).

## 6. Auth deployment and `main` protection

### 6.1 Current risk (unchanged by this record)

```text
merge to main touching: apps/auth-service/**, libs/service-kit/**, package.json, package-lock.json,
                        .github/workflows/auth-service-docker-build.yml
   └─ auth-service-docker-build.yml (push)
        build-production  → push :production and :latest (mutable tags)
        deploy-production → SSH → pull :production → run the image's provision-and-deploy.sh
   ⇒ production Auth is redeployed with no human step
```

- Editing that workflow file is itself a trigger path: a merge of an edited version deploys production unless the edited version has
  no deploy job.
- The manual `auth-service-deploy.yml` (and the Organization and Audit deploy workflows) rebuild `main` at dispatch time and tag
  `sha-<commit>`; a rebuild produces a new digest, so a certified digest cannot be redeployed through them today.
- `provision-and-deploy.sh` accepts any full image reference, including `image@sha256:…`, and runs its migrations and its own script
  from that image; no workflow passes a digest yet.
- All production workflows share the `production-deploy-core-api` queue (`cancel-in-progress: false`). A run already waiting in that
  queue executes its own commit's workflow definition.
- **Consequence for V2:** until the transition below is done, every V2 change to `libs/service-kit/**`, Auth or the package files is a
  production Auth deployment on merge and moves the target the refreshed G6 must rehearse.

**`main` has no branch protection and no repository ruleset.** The repository is public; the organization is on the Free plan
(organization rulesets unavailable; repository rulesets and environments with required reviewers available). There is one
maintainer, so a required approving review could never be satisfied.

### 6.2 Accepted future direction (not implemented)

```text
feature branch → PR → required Core CI → manual merge to main
   → build an immutable image (sha-<commit>, digest recorded) — NO :production push, NO deploy job
   → production unchanged
   → explicit owner-authorized deploy (workflow_dispatch, digest input, protected `production` environment, no rebuild)
   → deploy that exact digest
```

The same digest-input model is the intended answer for Organization and Audit, and it addresses the cutover record's §8 open
decision; formally adopting it as that answer is an owner decision (§7).

**V2-A.2 (separate authorization): the workflow transition.** Requirements recorded for it:

1. one PR containing workflow files only (no `apps/`, `libs/` or package change);
2. the deploy job and the `:production` push are removed in the **same** commit; no intermediate state may still deploy;
3. the `production-deploy-core-api` queue is verified empty immediately before the merge;
4. no other Auth-path merge between approval and verification;
5. optionally, the workflow is disabled before the merge and re-enabled after (itself a separately authorized setting change);
6. `check:repo`, `test:repo` and `test:deploy` pass; the PR's own run builds `:develop` only;
7. after the merge, read-only verification: the push run has no SSH step, and production Auth's container start time and image are
   unchanged;
8. a deploy test for the digest form of `IMAGE` is added before the first digest deployment.

**V2-A.3 (separate authorization): the `main` policy.** A repository ruleset on `refs/heads/main`: pull request required (zero
approvals, single maintainer); the Core CI checks required (later, one aggregate `core-ci-passed` check if adopted, so the ruleset
names one stable check); no force push; no deletion; the administrator bypass limited to pull requests, with the circumstances for an
emergency bypass stated by the owner. The path-filtered Auth image build must not be a required check.

## 7. Deferred owner decisions

| Decision | Needed before |
|---|---|
| V2-A.2 authorization (Auth deployment transition) | any V2 merge touching `libs/service-kit/**`, Auth or the package files |
| V2-A.3 authorization (`main` ruleset) and the emergency-bypass rule | V2 implementation merges |
| Creating a protected `production` environment | the first digest deployment |
| Adopting digest deployment as the answer to cutover record §8 | G6-C |
| Read-only verification of the production Auth digest and configuration | the G6 refresh |
| Whether Organization and audit-service are redeployed with the localization changes before G6 | the G6 refresh |
| Q-ADR-1, then ADR status changes one by one (ADR-0018, 0037 and the other Proposed ADRs already built on) | A1 |
| Resolution of the UNKNOWN items in §5 | their V2 area |

## 8. V2 per-capability validation protocol

Each V2 capability (one service or one shared concern) is validated and certified on its own:

```text
design gate (ADR/ADD/SDD/TDD where required; G6 label and workflow impact stated)
   ↓
focused tests + negative controls (deliberate mutants must be detected, then restored and shown identical)
   ↓
service-level regression (lint, typecheck, unit, e2e, database tests of the affected service)
   ↓
shared-library rule (below) when libs/service-kit/** or libs/audit-contract/** changed
   ↓
appropriate integration and security negatives (credential confusion, tenant isolation, step-up binding,
English default without Accept-Language, …)
   ↓
repository checks (check:repo, test:repo; test:deploy when deploy scripts change) + green Core CI on the PR
   ↓
certify the capability in a short record (evidence, negative controls, what was not run) → continue
```

**Shared-library rule.** Services resolve `@nawara/service-kit` and `@nawara/audit-contract` through their built `dist/`
(`main: ./dist/index.js`), and a service's own `npm test` does not rebuild them. When either library changes:

1. build the libraries first (`npm run build -w @nawara/service-kit -w @nawara/audit-contract`);
2. verify that `dist/` is fresh (newer than every changed source file, or its hash recorded);
3. run the tests of every dependent service and the cross-service suites (`test:e2e:audit-producers`,
   `test:e2e:auth-organization`, `test:e2e:real-broker`).

**Stale `dist/` is never valid evidence.**

**Not part of the protocol:** Final Core Validation (it is absolute last, §3); re-running certified R0–R11 campaigns, restore
drills or production checkpoints. A 🟡 capability is certified locally; its production activation is a separate, gated checkpoint.

## 9. Later status: V2-A.2 (Auth deployment transition)

Appended; §1–§8 remain the V2-A record. V2-A.2 implements §6.2 for Auth with the owner decisions OD-1 to OD-7:

- **Build ≠ deploy.** On a push to `main` on the Auth paths, `build-image` builds once, pushes `:sha-<commit>` labelled
  `org.opencontainers.image.revision=<commit>`, records the **index digest** in the run summary and stops (no SSH, no deployment). It
  is not in the `production-deploy-core-api` queue (OD-7).
- **Tags (OD-1, OD-2).** `:production` and `:latest` are no longer published; existing tags are frozen, deprecated and not deleted;
  nothing moves `:production` after a deployment. The index digest is the deployment authority (OD-6).
- **Deployment.** `auth-service-deploy.yml` is `workflow_dispatch` only, requires `digest` and the typed confirmation
  `deploy auth-service` (OD-5, an interim safeguard, not a reviewer gate), validates the digest before any network step, resolves it in
  the auth-service repository, requires a revision label that is an ancestor of `main` (OD-3, OD-4), never builds, and deploys exactly
  `IMAGE_NAME@digest` in the production queue with `cancel-in-progress: false`.
- **Enforcement.** Repository checks refuse an SSH job on an automatic event, `:production`/`:latest` in a push-triggered workflow, a
  workflow input interpolated into a shell script, and any digest-deployment drift (`scripts/lib/checks.mjs`); the deploy tests
  execute the workflow's real validation and verification steps and the digest form of the deploy script.
- **Procedure, transition preconditions (P1–P5, including the read-only VPS check for consumers of the mutable tags) and post-merge
  expectations:** [auth-service deploy runbook](../runbooks/auth-service-deploy.md).
- **Unchanged:** the `main` ruleset and the `production` environment (V2-A.3); Organization and audit-service deployments.

## 10. Later status: V2-A.1 closed, V2-A.2 certified (2026-10-03)

Appended. V2-A.1 is closed and V2-A.2 is certified: [V2-A.2 certification record](core-v2-a-2-certification.md). V2-A.3 (§6.2: the
`main` ruleset and the `production` environment) is next and not started.

- **§1 and §7, production Auth digest.** The digest left unresolved in §1 is now observed (owner, read-only, 2026-10-02): production
  Auth runs `sha256:26164d42b5d225b756a450e976e0e23c1142f49be6eb68ff9fad177cb1e05eaf`, the image of the last automatic deployment
  (`97f78cb`). It is a legacy image without a revision label. The G6 refresh still re-establishes every production fact at the time
  it runs.
- **§6.2, the V2-A.2 requirements.** The transition was one workflow-only merge (PR #187). The merge happened before the queue check,
  the competing-merge check, the VPS consumer check and the PR CI result were verified; all were established afterwards, and production
  was not changed. The certification record keeps that history.
- **§5, A15.** One more timer-dependent test is a hardening candidate: the overlap precondition of notification-service's
  "two deliveries of one intent finishing at the same moment" test (certification record §7).
- **Unchanged:** G6 deferred; G7, F6 and F7 locked; Final Core Validation absolute last.
