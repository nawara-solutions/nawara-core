# Core V2-A.1 closure and V2-A.2 certification (Auth deployment safety transition)

- **Status:** RECORD. Closes V2-A.1 and certifies V2-A.2 on 2026-10-03. It authorizes nothing further: V2-A.3, every production
  deployment, G6/G7/F6/F7 and Final Core Validation each keep their own authorization.
- **Scope:** V2-A.1 (documentation of the V2-A baseline and change-safety decisions) and V2-A.2 (the Auth deployment safety
  transition: build ≠ deploy). **It does not certify a production deployment:** none was performed, and the digest deployment path has
  not yet been exercised against production (§8).
- **Related:** [V2-A record](core-v2-a-baseline-and-change-safety.md), [auth-service deploy runbook](../runbooks/auth-service-deploy.md),
  [roadmap](../CORE-ROADMAP.md), [Stage 21.x cutover record](stage-21/stage-21-x-cutover-record.md).
- **Evidence basis:** GitHub (pull requests, Actions runs and logs), local git, the local validation of the change, and the owner's
  read-only inspection of the production server. All timestamps are UTC.

## 1. Result

| Checkpoint | Result |
|---|---|
| **V2-A.1** documentation formalization | ✅ **CLOSED / CERTIFIED** (merged, post-merge verified) |
| **V2-A.2** Auth deployment safety transition | ✅ **CLOSED / CERTIFIED**, with the gate history of §4 recorded as it happened |
| **V2-A.3** `main` protection and `production` environment | **NEXT**; not started; needs its own owner authorization |
| G6 | ⏸ **DEFERRED** (not cancelled, waived or passed); G7, F6, F7 locked |
| Final Core Validation | 🔒 **ABSOLUTE LAST**; not run |

## 2. V2-A.1 closure

| Item | Evidence |
|---|---|
| Change | documentation only (8 files): PR #186, commit `d346cb68cb2ef06208c3290ea9147d70b16b8b4a` |
| Merge | `dd7e017b9edcd2f400a8bd2e7f46d9ee15dd3b76`, 2026-10-02T22:48:44Z; the merged tree is identical to the approved commit's tree |
| PR CI | Core CI run 37073886888: 23 of 23 |
| Post-merge CI | Core CI run 37074459836: 23 of 23 |
| Production | no Auth image workflow was triggered (no trigger path touched); no deployment; no production mutation |

## 3. V2-A.2: what changed

Owner decisions OD-1 to OD-7 ([V2-A record](core-v2-a-baseline-and-change-safety.md) §9). PR #187, commit
`bd505e97cda2d7443322a7870bfd306dfb0b14d1` (13 files: the two Auth workflows, repository checks and tests, documentation; no `apps/`,
`libs/`, package, migration or deploy-script change).

- **Build ≠ deploy.** A qualifying merge to `main` runs `build-image` only: one image, tagged `sha-<commit>`, labelled
  `org.opencontainers.image.revision=<commit>`, its **index digest** recorded in the run summary. No SSH, no deployment, outside the
  production queue.
- **Mutable tags.** `:production` and `:latest` are no longer published or moved; the existing tags are frozen, deprecated and not
  deleted.
- **Deployment.** `auth-service-deploy.yml`: `workflow_dispatch` only; required `digest` and typed confirmation `deploy auth-service`
  (an interim safeguard, not a reviewer gate); strict digest validation before any network step; the artifact must exist in the
  auth-service repository and carry a revision label that is an ancestor of `main`; no build; deploys exactly `IMAGE_NAME@digest`;
  `production-deploy-core-api`, `cancel-in-progress: false`.
- **Regression protection.** Repository checks (no SSH job on an automatic event; no `:production`/`:latest` on push; no workflow input
  in a shell script; digest-deployment rules) and tests that execute the workflow's real validation and verification steps and the
  digest form of the deploy script.

**Local validation before the PR:** `check:repo` passed; `test:repo` 29 of 29; `test:deploy` 183 of 183; `git diff --check` clean; all
workflow files parse. Fourteen real-file mutations (sixteen detections; the implementation report and the PR description counted
the detections and called them "16 negative controls") were each detected and restored with matching content hashes: the original
workflow restored; automatic SSH job re-added; `:production` on merge; `:latest` on merge; build step in the deployment; digest regex
loosened (two detections); a tag deployed instead of the digest; ancestry check removed (two detections); `cancel-in-progress: true`;
concurrency removed; input in the remote script; secret in the remote script; `set -euo pipefail` removed; migration failure ignored.
*Recorded incident:* the control harness restored `provision-and-deploy.sh` with its content intact but without its executable bit;
the mode was restored and the file showed no difference from `HEAD` before the commit. The script is not part of the change.

## 4. Gate history (as it happened)

The transition had five documented pre-merge gates (runbook §4.1). **PR #187 was merged before P1, P2, P4 and P5 had been verified.**
This record does not present them as pre-merge checks.

| Time (UTC, 2026-10-02 unless noted) | Event |
|---|---|
| 23:32:16 | PR #187 opened; PR Core CI 37078046649 and the Auth PR build 37078046622 start |
| 23:33:16 | Auth PR build completes: `build-develop` success, `build-image` skipped (push only); no deploy job exists |
| **23:35:56** | **PR #187 merged** by the owner: merge commit `7295e8e83a7e06171562fe252a311e71a435ec82`. PR Core CI was 22 of 23 complete, one job still running; P1, P2 and P4 unverified |
| 23:35:59 | merge-triggered runs start: Auth build 37078342576, Core CI 37078342692 |
| 23:36:54 | Auth build completes (§5) |
| 23:37:43 | PR Core CI completes: 23 of 23 |
| 23:38:42 | post-merge Core CI: `notification-service` fails (§7) |
| 23:58:59 | one focused rerun of the failed job requested (owner-authorized) |
| 2026-10-03 00:01:45 | rerun completes: success; post-merge Core CI 23 of 23 |

| Gate | Result | How established |
|---|---|---|
| **P1** no old-definition Auth build run queued or in progress at merge | **SATISFIED** | **retrospectively verified:** the last old-definition run (36979422758, `97f78cb`) completed at 07:38:21; the only run between it and the merge was the PR run, which has no deploy job and completed at 23:33:16 |
| **P2** no competing Auth-path merge | **SATISFIED** | **retrospectively verified:** `dd7e017..7295e8e` contains only the PR commit and its merge; `main` did not move afterwards |
| **P3** no `apps/`, `libs/` or package change | **SATISFIED** | the PR's 13 files; the merged tree equals the PR head tree |
| **P4** no VPS consumer of the mutable tags | **SATISFIED** | **performed after the merge** by the owner, read-only: no updater container, no relevant systemd pull or update mechanism, no script referencing Auth `:production`/`:latest`, no crontab for `deploy`, `ubuntu` or `root` |
| **P5** PR CI green | **SATISFIED** | **retrospectively verified:** 23 of 23, completed about two minutes after the merge |

## 5. Auth immutable-build evidence (the transition merge)

Run 37078342576 (`push`, `main`, `7295e8e`), success.

| Check | Result |
|---|---|
| Jobs | `build-image` success; `build-develop` skipped; **no `deploy-production` job exists** |
| SSH step | **none** (no `appleboy/ssh-action` and no `provision-and-deploy` in the log) |
| `:production` / `:latest` published | **no** |
| Published tag | `ghcr.io/nawara-solutions/nawara-core-auth-service:sha-7295e8e83a7e06171562fe252a311e71a435ec82` |
| **Index digest** | `sha256:9d090ff146d8eeb83ac7bd175be82fbca1d68c75652f5ff8ad76128e9d3a0f3a` (recorded by the run) |
| Revision label passed to the build | `org.opencontainers.image.revision=7295e8e83a7e06171562fe252a311e71a435ec82` |
| `auth-service-deploy.yml` dispatched | **no** (its latest run is 36699283208, 2026-09-30) |

The push run used the merged workflow definition. This image is built and **not deployed**.

## 6. Production non-mutation evidence

**Production Auth was not changed by the transition merge: VERIFIED.**

- **GitHub:** no SSH or deployment job ran, and no deployment workflow was dispatched (§5).
- **Server (owner, read-only, after the merge):**

| Item | Value |
|---|---|
| Container | `nawara-core-auth-service`, id `07830159501ee5bb458351945b091aed27ebec7b571c96e05c6a72910c76f86f` |
| Created / started | 2026-10-02T07:38:13Z, about sixteen hours **before** the merge |
| State | running, healthy |
| Configured image | `ghcr.io/nawara-solutions/nawara-core-auth-service:production` |
| Image id and repository digest | `sha256:26164d42b5d225b756a450e976e0e23c1142f49be6eb68ff9fad177cb1e05eaf` (image created 2026-10-02T07:36:46Z) |

This is the image of the last automatic deployment (run 36979422758, `97f78cb`), a legacy image without a revision label.
**No pre-merge server snapshot existed:** the conclusion rests on the workflow history and on the container's start time predating
the merge, not on a before/after comparison.

## 7. CI history and the focused rerun

| Run | Result |
|---|---|
| PR Core CI 37078046649 | 23 of 23 (completed after the merge, §4) |
| Auth PR build 37078046622 | success (`build-develop`) |
| Post-merge Core CI 37078342692, **attempt 1** | **22 of 23**: `notification-service` (job 111073134672) failed in its integration tests, 320 of 321 |
| Post-merge Core CI 37078342692, **attempt 2** | **23 of 23**: exactly one owner-authorized rerun of the failed job only (job 111078393422, 23:59:04 to 00:01:45): unit 316 of 316, integration 321 of 321; the 22 other jobs were not executed again |

**The failure.** `apps/notification-service/test/delivery-engine.e2e-spec.ts`, "two deliveries of one intent finishing at the same
moment: the last one purges (the intent lock serializes the check)", line 821: `expected 62 to be less than 40`. The assertion is the
test's wall-clock precondition that the two fake provider calls started within 40 ms of each other; the functional assertions after
it were not reached. The same test passed in the PR run on an identical tree and in the rerun; V2-A.2 changed no Notification file.

**Classification:** timing / flaky behaviour confirmed **for this CI incident**. This does not prove the test can never expose a real
race. No second rerun was made, and the test was not modified.

**A15 hardening candidate (recorded, open):** the overlap precondition of that test, alongside the timer-dependent test hardening the
[R11 record](core-v1-refactor-certification.md) already lists. The same file's "fairness" and "shutdown" tests were hardened earlier
for the same class of failure (PRs #153, #175).

## 8. What this certification does not cover (open)

- **No digest deployment has been performed.** The deployment workflow is certified by its checks and tests, not by a production run.
  Its artifact verification reads the revision label through `docker buildx imagetools inspect`; that reading has been tested against
  simulated registry answers only, and the recorded index digest was not inspected in the registry for this record. It fails closed
  (no label found means no deployment). The first digest deployment is a separate, owner-authorized production checkpoint.
- **Production runs a legacy unlabelled image** (§6), which the workflow refuses (OD-3). Returning to it, or to any image built before
  V2-A.2, uses the retained-container procedure or a separately authorized emergency procedure.
- **No reviewer gate.** The typed confirmation is not one; the `production` environment and the `main` ruleset are V2-A.3.
- **Organization and audit-service** deployments still rebuild `main` at dispatch; the cutover record's §8 image-pinning decision
  remains open for them, and adopting digest deployment as its answer remains an owner decision.
- **G6** stays deferred; its refresh must use the production facts as they are then, including §6.
