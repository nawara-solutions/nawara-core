# Core V2 A0: immutable-digest deployment for organization-service and audit-service

- **Status:** **CERTIFIED** (2026-10-04, A0.8): the immutable build and exact-digest deployment mechanism for auth-service,
  organization-service and audit-service, merged by PR #192 (`4979407`), with the post-merge evidence of §7 and the certification
  scope of §8. Record of A0.0 discovery to A0.8 certification. **It performs and authorizes no production deployment: BUILT ≠
  DEPLOYED.**
- **Scope:** A0-A only: the immutable artifact and deployment model of organization-service and audit-service, a correctness fix to
  the auth-service build triggers, and generic repository guards. Platform release provenance (A0-B: service versions, release
  manifests, deployment history, promotion) is separate, later work.
- **Related:** [digest deployment runbook](../runbooks/digest-deployments.md), [V2-A record](core-v2-a-baseline-and-change-safety.md)
  §6, [V2-A.2 certification](core-v2-a-2-certification.md), [V2-A.3 record](core-v2-a-3-ci-and-ruleset.md),
  [Stage 21.x cutover record](stage-21/stage-21-x-cutover-record.md) §8 and §13.

## 1. Problem

Before A0, `organization-service-deploy.yml` and `audit-service-deploy.yml` **rebuilt `main` inside the approved production job** and
deployed the mutable tag `sha-<commit>` (a re-dispatch rebuilt and re-pushed it with a new digest). A certified or rehearsed image could
therefore never be redeployed exactly, and the job holding the production credentials also held `packages: write`. This is the open
image-identity decision of the cutover record §8 (mandatory before G6-C).

## 2. Design

```text
merge to main ─► <service>-image.yml / build-image ─► ghcr.io/<owner>/nawara-core-<service>:sha-<commit> + revision/source labels
                                                     ─► INDEX digest validated and recorded              (no deployment)
dispatch(digest, confirm) ─► verify (no environment, no credentials: digest, repository, revision label, ancestry of main)
                          ─► deploy (needs verify; environment production → approval; production queue; IMAGE_NAME@digest; no build)
```

The model is auth-service's (V2-A.2, V2-A.3 / A3.5), applied without changing it.

| | organization-service | audit-service |
|---|---|---|
| Image workflow | `organization-service-image.yml` (new) | `audit-service-image.yml` (new) |
| Image repository | `ghcr.io/<owner>/nawara-core-organization-service` | `ghcr.io/<owner>/nawara-core-audit-service` |
| Build trigger paths | `apps/organization-service/**`, `libs/service-kit/**`, `libs/audit-contract/**`, `package.json`, `package-lock.json`, `.dockerignore`, the workflow | same, with `apps/audit-service/**` |
| Deploy confirmation | `deploy organization-service` | `deploy audit-service` |
| Server side (unchanged script) | roles before migrations; kit runner as `organization_migrator`; privilege assertions (fail closed); private network, no port; name-based rollback | kit runner as `audit_migrator` (append-only revoke from migration 0001); health = `/ready` (database, migrations, broker, ingestion consumer); ADR-0053: the broker topology must exist first and audit-service is deployed before auth-service relays |

- **Build inputs** were derived from the Dockerfiles: they copy only the workspace manifests, `libs/service-kit` (with its migrations),
  `libs/audit-contract` and the service; both libraries are built from source **inside** the image and `.dockerignore` drops every
  `dist`, so no stale local build output can enter an image. There is no pull-request GHCR push: Core CI builds and smoke-checks both
  images on every pull request without pushing them.
- **Digest compatibility.** Both deploy scripts take `IMAGE` as an opaque full reference (`: "${IMAGE:?…}"`), use it only quoted in
  `docker run` (migrations and the new container) and roll back by container name. They accept `repository@sha256:…` unchanged; the
  deploy-script tests now prove it.

## 3. auth-service correction

`auth-service-docker-build.yml` builds an image that also contains `libs/audit-contract` and depends on `.dockerignore`, but its trigger
paths omitted both: a change to either alone produced no new Auth image. A0 adds both paths (push and pull request). Nothing else in the
Auth workflows changes.

## 4. Repository guards

- **`checkImageBuild`** (new, `IMAGE_BUILDS` covers the three image workflows): push to `main` only (a pull-request-only job such as
  auth-service's `build-develop` is allowed but never publishes `sha-`, `:production` or `:latest`); every image input is a trigger
  path, including the workflow itself; fixed `IMAGE_NAME`; `build-image` with `id: build`, exactly the `sha-${{ github.sha }}` tag, the
  revision label `= github.sha` and a source label, and the index digest captured and checked against `^sha256:[0-9a-f]{64}$`; no job
  with an environment, production SSH or `DEPLOY_SSH_*`, or the production queue; `packages: write` only on a job that pushes an image.
- **`checkDigestDeploy`** (existing, **extended** by A0): `DIGEST_DEPLOYMENTS` now lists the three deploy workflows with their
  repositories, and the guard now also requires, in the `verify` step that extracts the OCI revision label, that the extracted
  revision is refused unless it is a literal lowercase 40-hex commit SHA (`[[ "$rev" =~ ^[0-9a-f]{40}$ ]] || … exit 1`), and that this
  check comes **before** `git merge-base --is-ancestor` on the **same** variable. Without it, a label such as `main` (a ref git
  resolves) could pass the ancestry check. The workflows already performed this check at run time (auth-service since V2-A.2); A0
  adds its structural enforcement. Because the guard is generic, it applies to auth-service, organization-service and audit-service
  alike; the auth-service workflow itself is unchanged.
- **`checkTypedConfirmation`** (existing, unchanged): `CONFIRMED_OPERATIONS` gains `deploy organization-service` and
  `deploy audit-service`.
- Tests: the workflow-step test (`auth-deploy-workflow.test.mjs`) runs the real `verify` steps of all three deploy workflows, including a
  refusal of a digest from another service's repository; the organization-service and audit-service deploy-script tests cover the
  digest form of `IMAGE`. A regression test in `check-repo.test.mjs` (A0.3, control D9) closes a false-green found by the A0
  negative-control campaign: with the revision extraction and the ancestry check left in place, removing the literal-SHA refusal was
  not detected. Every digest deployment is now refused when that check is removed, its pattern weakened, its `exit 1` dropped, or it
  is moved after the ancestry check.

## 5. Migrations and rollback

Migrations run from the selected exact image, before the running service is replaced; a failed migration leaves the running service
untouched; successful migrations are forward-only; a container rollback does not undo them
([runbook](../runbooks/digest-deployments.md) §3).

## 6. Boundaries

- **Legacy images.** The images production runs (organization-service `sha256:76734d81…e49d`, audit-service `sha256:a8dade8c…4554`,
  from the cutover record §5) carry no revision label and are refused by the new deploy workflows. They are not touched; returning to
  them uses the retained-container procedure.
- **No production deployment** is part of A0. The first organization-service or audit-service digest deployment ships current `main`
  (including the Core V1 refactor's localization changes) and is a separate, owner-authorized production action; it would also be the
  first observation of the `production` approval path (V2-A.3 / A3.6).
- **Cutover §8.** The architectural artifact-pinning question is closed by A0 for auth-service, organization-service and audit-service:
  immutable, revision- and source-labelled artifacts with exact index digests exist (§7), a deployment selects one reviewed artifact by
  digest, and organization-service and audit-service no longer rebuild at deployment. **Closing the §8 mechanism is not completing the
  production cutover.** The digests of §7 are evidence, not a selection: a future G6 refreshes the production baseline and selects the
  exact digests appropriate at that time. G6 is not complete.
- **Status unchanged by A0:** A0 is certified (§8), and nothing else advances: A3.1 to A3.5 are closed; the first
  organization-service and audit-service digest deployment belongs to A3.6, which stays deferred; A3.7 stays deferred; A3.8 is not
  certified; G6 is deferred; G7, F6 and F7 stay locked; Final Core Validation is the absolute last.

## 7. Evidence (A0.3 validation, A0.5 to A0.7 merge and first builds)

**Pre-merge validation (A0.3, A0.4).** `check:repo` passed; `test:repo` 50/50; `test:deploy` 211/211, 0 skipped. Negative-control
campaign on real files: 45 mutations, 49 expected validator detections, 49 observed, 0 missed; all 23 files restored exactly (SHA-256
and mode). The final diff, security and scope review passed.

**Merge.** PR #192 (*V2 A0: immutable Organization and Audit deployments*), head `99ca6e322e2e4fa3b5050abe9ecc0407eff34acb`, merged by
the owner at 2026-10-04T16:45:22Z as `4979407e1af1adc1a6a7c94d3e157a62a31ee534`.

| Run | Id (attempt 1) | Result |
|---|---|---|
| PR Core CI | 37217517849 | 24/24 jobs; `core-ci-passed` success |
| PR auth-service Docker build | 37217517850 | `build-develop` success (`:develop`, not deployable); `build-image` skipped. No organization-service or audit-service image build and no deploy workflow ran on the pull request |
| Post-merge Core CI (push, `main`, `4979407`) | 37217937398 | 24/24 jobs; `core-ci-passed` success |
| auth-service image (push, `main`, `4979407`) | 37217937389 | `build-image` success; `build-develop` skipped |
| organization-service image (push, `main`, `4979407`) | 37217937390 | `build-image` success |
| audit-service image (push, `main`, `4979407`) | 37217937392 | `build-image` success |

**First labelled artifacts** (tag `sha-4979407e1af1adc1a6a7c94d3e157a62a31ee534` in each repository under `ghcr.io/nawara-solutions/`):

| Service | Repository | Index digest |
|---|---|---|
| auth-service | `nawara-core-auth-service` | `sha256:0bd9d84acd7df14e9ab62c8229365b4f9e28d90a4e8ff863e9c41fee74feace8` |
| organization-service | `nawara-core-organization-service` | `sha256:96bf973615887ff70837e4da5528635b918774eda86465641d0edfa920353c32` |
| audit-service | `nawara-core-audit-service` | `sha256:37a5a92bf7beccb4fd38c4b8a758163806312b7cbe79b00d6025ed82cf142f2a` |

Read back read-only from the registry for all three: the index fetched by `repository@digest` hashes to the reported digest; the `sha-`
tag resolves to it; the shape is an OCI image index with `linux/amd64` and a provenance attestation manifest; the `linux/amd64` config
carries `org.opencontainers.image.revision=4979407e1af1adc1a6a7c94d3e157a62a31ee534` and
`org.opencontainers.image.source=https://github.com/nawara-solutions/nawara-core`. Static deploy-verifier compatibility passes (fixed
repository, valid digest, literal 40-hex revision equal to the merge, an ancestor of `main`). No `:production` or `:latest` was created
for organization-service or audit-service; auth-service's frozen `:production` and `:latest` still point to the legacy `26164d42…5eaf`.

**No automatic production deployment.** The merge triggered only Core CI and the three image builds (no SSH step); no deploy, broker,
rotation or backup workflow ran; the repository has 0 deployment records (0 for `production`).

| A0.7 checklist | |
|---|---|
| PR merged; PR CI green; post-merge Core CI green | ✅ |
| natural Auth, Organization and Audit immutable builds green | ✅ |
| `sha-` tags observed; exact index digests recorded; digest and tag agree | ✅ |
| revision and source labels read back | ✅ |
| zero automatic production deployment | ✅ (12/12 items) |

## 8. Certification

**Certified (A0.8):** the immutable build and exact-digest deployment mechanism of auth-service, organization-service and audit-service:

```text
merge to main → build-only sha-<commit> artifact → index digest + OCI revision/source labels
             → separate dispatch of <service>-deploy.yml → read-only verify (repository, digest, literal 40-hex revision, ancestor of main)
             → protected production environment: typed confirmation + approval → deploy exactly IMAGE_NAME@digest
```

In particular: organization-service and audit-service no longer rebuild at deployment; building is separated from production
deployment; build and verify jobs cannot cross the production SSH boundary; deployment is dispatch-only, from a fixed repository, with a
strict digest and a literal-SHA revision that is an ancestor of `main`; production deployments stay serialized in one queue; and no
automatic production deployment followed the A0 merge.

**Not meant by this certification:** that any of these artifacts was deployed, that production has been cut over, or that A3.6, A3.7,
A3.8, G6, G7, F6, F7 or the Final Core Validation passed. Production still runs the legacy, unlabelled images (§6). The first
exact-digest production deployment is a separate, explicitly authorized production action (A3.6). **BUILT ≠ DEPLOYED.**

**Open observations (not blockers; first observed during A3.6):**

- No deployment `verify` job has yet run against these artifacts, so the shape that
  `docker buildx imagetools inspect --format '{{json .Image}}'` returns for this real provenance-on index has not been observed in the
  workflow. The verifier's `jq` handles both the image-config and the platform-keyed shape, and static compatibility passed.
- Whether a run waiting for the `production` approval holds the `production-deploy-core-api` queue has not been observed.
