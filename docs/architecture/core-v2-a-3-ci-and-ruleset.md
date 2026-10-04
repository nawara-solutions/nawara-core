# Core V2-A.3: Core CI aggregate check and `main` ruleset (A3.1 to A3.3)

- **Status:** RECORD of V2-A.3 steps A3.1 (design and owner decisions), A3.2 (the `core-ci-passed` check) and A3.3 (the `main`
  ruleset), written 2026-10-04. **V2-A.3 is not complete and is not certified by this record:** A3.4 and A3.5 are not started, A3.6
  and A3.7 are deferred, and the first pull-request-level observation of the ruleset is recorded separately (§5). It authorizes
  nothing further.
- **Scope:** GitHub control-plane protection of `main`. No application, deployment or production change.
- **Related:** [roadmap](../CORE-ROADMAP.md), [V2-A record](core-v2-a-baseline-and-change-safety.md) §6,
  [V2-A.2 certification](core-v2-a-2-certification.md), [production readiness](production-readiness.md) (finding F2).
- **Evidence basis:** GitHub (pull requests, Actions runs, the ruleset API) and local validation. Timestamps are UTC.

## 1. Position

```text
V2-A.3
  A3.1  discovery and design, owner decisions       ✅ done
  A3.2  core-ci-passed aggregate check              ✅ verified on main
  A3.3  main ruleset                                ✅ active; verified by API readback
        first pull-request behaviour under it       ⏳ pending when this record was written (§5)
  A3.4  production environment                      not started
  A3.5  environment on every production SSH job     not started
  A3.6  production access proof                     ⏸ deferred (owner decision D-3)
  A3.7  organization-secret restriction             ⏸ deferred (owner decision D-4)
  A3.8  certification                               not started

G6 ⏸ deferred (dependency gate); G7, F6, F7 🔒 locked; Final Core Validation 🔒 absolute last
```

## 2. A3.1: what the design found, and the owner decisions

**Finding that widened the scope.** The production SSH credentials (`DEPLOY_SSH_*`) are organization secrets with visibility `all`:
every workflow run in this repository can read them, on any branch. A `main` ruleset and one `environment:` line on the Auth
deployment do not close that. An environment approval is a real gate only when the credentials live only in the environment, every
production SSH job declares it, and the organization secrets are no longer exposed to this repository.

| Decision | Outcome |
|---|---|
| **D-1** environment scope | the `production` environment design covers **all** production SSH workflows, not Auth only. Not implemented yet |
| **D-2** scheduled backups | a future scheduled backup must not need the interactive reviewer: a separate `production-backup` environment. Not created; the backup schedule stays G6-gated and disabled |
| **D-3** production access proof (A3.6) | **deferred.** V2-A.3 may be certified with the explicit limitation that the environment has not been proven as the sole production credential holder |
| **D-4** organization-secret restriction (A3.7) | required eventually, **deferred**: only after a separately authorized production-access proof |
| **D-5** merge policy | merge commits retained; strict (up-to-date) required checks |

**Sole maintainer.** The repository has one administrator and no second member. Required approvals are therefore zero, and a future
environment reviewer can only be the same person (a deliberate second step, not independent review).

## 3. A3.2: the `core-ci-passed` aggregate check

**Why.** Core CI reports 23 matrix-named checks; requiring them individually would leave pull requests pending forever whenever a
matrix entry is renamed. One stable check is required instead.

**What it is** (`.github/workflows/core-ci.yml`, job `core-ci-passed`):

- needs the **seven** other top-level jobs: `repo-checks`, `node`, `images`, `infra`, `e2e-real-broker`, `e2e-auth-organization`,
  `e2e-shared-platform`;
- `if: always()`, because a required check that is **skipped** counts as passed: without it, one failed dependency would skip the
  aggregate and unblock the merge;
- succeeds only when every needed job's result is `success` (`all(.[]; .result == "success")`); `failure`, `cancelled` and `skipped`
  are refused, and each job's result is printed;
- Core CI has **no path filter**, so the check reports on every pull request to `main`, including documentation-only ones. The
  path-filtered Auth image workflow is deliberately **not** a required check (it would never report outside its paths).

**Repository guard** (`checkCiAggregate` in `scripts/lib/checks.mjs`, run by `npm run check:repo`): refuses a missing or renamed
aggregate, a matrix on it, any condition other than `always()`, a job the aggregate does not need, a changed verdict,
`continue-on-error` anywhere in the workflow, a swallowed failure, and a `pull_request` trigger that is missing, path-filtered or does
not cover `main`. Tests execute the workflow's real deciding step against every job result.

**Local validation:** `check:repo` passed; `test:repo` 36 of 36; `test:deploy` 183 of 183. Ten real-file mutations of `core-ci.yml`
(twelve detections) were each detected and restored with content hash and file mode verified: aggregate removed; two different
dependencies removed; `if: always()` removed; `skipped` accepted; failure swallowed; aggregate renamed; a path filter added;
`continue-on-error` on a job; a new job not needed by the aggregate.

| Evidence | Result |
|---|---|
| Change | PR #189, commit `ff2703b44ed4e6e66ff43d6cee1573893a2846f6` (4 files: the workflow and the repository checks and tests) |
| PR Core CI | run 37197182541: **24 of 24**; `core-ci-passed` (job 111422349042) started 11:05:19 after the last dependency (11:05:16), success at 11:05:23 |
| Merge | `946a578f24d58d60a89736104d598b5efba53d38`, 2026-10-04T11:05:55Z; merged tree identical to the approved commit |
| Post-merge Core CI | run 37197565708: **24 of 24**; `core-ci-passed` (job 111423457744) ran after all seven dependencies, success |
| Production | no Auth image build (no trigger path touched), no deployment, no setting changed |

**History as it happened.** PR #189 was merged by the owner **after** its Core CI had completed green (11:05:23) but **before** the
PR CI checkpoint had been reported and reviewed: the last report before the merge still showed the run in progress and the aggregate
not yet created. The result was verified retrospectively.

**Not observed on GitHub:** a real run with a failed dependency. That path is covered by the local tests and negative controls only.

## 4. A3.3: the `main` ruleset

**Procedure.** A read-only preflight established the capabilities of the plan (repository rulesets available; `evaluate` enforcement
not expected on the Free plan). The ruleset was therefore created **disabled**, read back, and only then activated with a single
change of `enforcement`; the ruleset was identical before and after activation in every other field. No rollback was performed.

| Item | Value |
|---|---|
| Ruleset | id `24453879`, name `main`, source: this repository |
| Enforcement | `active` (2026-10-04) |
| Target | branch, `refs/heads/main` only |
| Classic branch protection | none (the ruleset is the only protection) |

**Effective rules on `main`** (API readback):

| Rule | Setting |
|---|---|
| Deletion | blocked |
| Non-fast-forward (force push) | blocked |
| Pull request required | yes; **required approvals 0** (sole maintainer: an author cannot approve their own pull request); conversation resolution required; no code-owner or last-push approval; merge, squash and rebase all allowed |
| Required status check | `core-ci-passed`, bound to the GitHub Actions integration (`integration_id` 15368) |
| Strict (up to date) | yes: the branch must be up to date with `main` before merging |
| Not configured | linear history, signed commits, merge queue, additional required checks, merge-method restriction |

**Bypass:** exactly one actor: `RepositoryRole`, `actor_id` 5 (repository Admin), `bypass_mode: pull_request`. GitHub reports
`current_user_can_bypass: pull_requests_only` for the owner. There is **no** `always` bypass. Under this policy an administrator may
merge a pull request that does not meet the rules, visibly; a direct push to `main` is not permitted to anyone.

**How this was verified.** By API readback of the ruleset and of the effective rules on `main` (`branches/main` reports
`protected=true`). **Direct push, force push and deletion were not attempted**; those protections rest on the readback.

**Procedural note (unexpected field).** In the disabled-state readback GitHub had added a field that was not requested:
`require_extra_approval_for_unattributed_changes: true`. Before activating, GitHub's public documentation was consulted: the option
("Require an additional approval for unattributed Copilot pull requests") concerns pull requests Copilot opens under its own identity
and is documented to have no effect when the ruleset requires zero approvals. Because `required_approving_review_count` is 0, the
field was classified as a harmless GitHub default and activation continued. That classification rested on documentation: the field's
real behaviour had not been observed on a pull request at activation time. This matters here because commits made from the
maintainer's workstation are not linked to a GitHub account, so a rule that did demand an extra approval for unattributed changes
would block the normal path of a sole maintainer. The first real pull request under the ruleset supplies the evidence (§5).

**Residual.** A repository administrator can always edit or disable the ruleset; that is both the recovery path and the remaining
risk. The emergency paths are, in order: a visible bypass merge of a pull request; then an explicit, separately authorized change of
the ruleset.

**Production:** no workflow ran, no environment, secret or variable changed, no deployment.

## 5. Pull-request-level behaviour under the ruleset

**A3.3 API and effective-rule verification: complete. First real pull-request behavioural verification: pending when this record was
written.** The pull request that adds this record is the first one opened under the active ruleset and is intended to supply that
evidence: whether the pull request is blocked while `core-ci-passed` is pending, whether it becomes mergeable with zero approvals once
the check is green, and whether the unexpected field of §4 has any effect. Its observed behaviour is reported with that pull request
and belongs in the A3.8 certification, not here.

## 6. What is not done

- **A3.4, A3.5:** no `production` environment exists; no workflow references one; the six production SSH workflows are gated only by
  their `main` guard (and Auth by its typed confirmation and artifact validation).
- **A3.6, A3.7 (deferred):** the production credentials remain organization secrets readable by any workflow run in this repository.
  Until both are done, the environment is not the sole credential holder.
- **No digest deployment has been performed** ([V2-A.2 certification](core-v2-a-2-certification.md) §8).
- **G6** stays deferred; its refresh must include the ruleset, and later the environment and where the credentials live.
- **Final Core Validation** stays absolute last.

## 7. Later status: A3.4 and A3.5 (2026-10-04)

Appended; §1–§6 remain the record as written. §5's pull-request-level observation was made on PR #190 (blocked while `core-ci-passed`
was pending, clean once it succeeded, no approval required, merged through the normal path with every rule passing and no bypass); it
is carried into the A3.8 certification.

**A3.4: the `production` environment** (id `23422013679`). Required reviewer: the owner (`User`, id `32715188`), one approval suffices;
`prevent_self_review: false` (a sole maintainer must be able to approve); no wait timer; deployment branches: the explicit branch policy
`main` only (not "protected branches only"); administrator bypass **off** (`can_admins_bypass: false`: GitHub's API does not document
this setting, so the owner switched it off in the UI and it was read back). Environment secrets, entered by the owner and verified by
name only: `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_PASSWORD`, `DEPLOY_SSH_PORT` (`DEPLOY_SSH_KEY` deliberately absent). Their
values have not been proven against the server (A3.6, deferred).

**A3.5: production workflow gating.** Every production SSH job is bound to `production` and is dispatch-only:

| Workflow → job | Change |
|---|---|
| `auth-service-deploy.yml` | split into `verify` (no environment, no production credentials: digest validation, artifact existence, revision label, ancestry of `main`) and `deploy` (`needs: verify`, `environment: production`, re-checks the digest, deploys exactly `IMAGE_NAME@digest`, no build, production queue). Typed confirmation and `main` guard on both |
| `organization-service-deploy.yml` → `deploy`, `audit-service-deploy.yml` → `deploy` | `environment: production` (approval before the build; immutable digest deployment stays separate V2 work) |
| `core-rabbitmq-provision.yml` → `provision`, `auth-db-credential-rotate.yml` → `rotate` | `environment: production` (rotation keeps its typed confirmation) |
| `core-backup.yml` → `backup` | owner decision **B1**: the schedule is removed (dispatch only) and the job is bound to `production`. Scheduled backups return through a separately reviewed `production-backup` environment and job (not created); enabling them stays G6-gated. `CORE_BACKUP_SCHEDULE` and `CORE_BACKUP_SERVICES` are no longer read |

Repository checks (`scripts/lib/checks.mjs`) now refuse: a job using production SSH or `DEPLOY_SSH_*` (any spelling, or all secrets
at once) without an approved literal environment (allow-list: `production`; `production-backup` is not listed until it exists); an
expression or unknown environment name; a `production` job in a workflow with any trigger other than `workflow_dispatch` (so no
schedule, push or pull request); and any drift of the Auth split (missing or bypassed `verify`, an environment or production credential
on `verify`, a deploy job that is not `deploy`, not bound to `production` or not needing `verify`).

**Not observed yet** (documented GitHub behaviour only): a sole owner approving their own run; whether a run waiting for approval holds
the `production-deploy-core-api` queue; environment secrets taking precedence over the same-named organization secrets. They are to be
observed at the first separately authorized production action (A3.6 is the natural one); no test workflow was added for them.

**Still open:** until **A3.7** the organization-level `DEPLOY_SSH_*` secrets remain readable by any workflow run in this repository that
does not declare the environment, including a workflow pushed on a feature branch (the ruleset protects `main` only and the repository
checks report rather than prevent). **A3.6** (production proof) and **A3.7** stay deferred; A3.8 certification has not started.
