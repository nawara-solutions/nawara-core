# Core V2 A0: immutable-digest deployment for organization-service and audit-service

- **Status:** RECORD of the A0 design and implementation (A0.0 discovery, A0.1 design freeze, A0.2 implementation), written
  2026-10-04. Certification (with the first build evidence, §7) is a later step. **It performs and authorizes no production
  deployment.**
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
- **Cutover §8.** The architectural question is answered by A0 and the mechanism is implemented. The first labelled artifacts are proven
  by the build-only runs of the merge (§7). Selecting the exact digests for the G6 rehearsal and for production is deferred to the
  refreshed G6 baseline. G6 is not complete.
- **Status unchanged by A0:** A0 is implemented, not certified (certification needs the merge and the §7 evidence); the first
  organization-service and audit-service digest deployment belongs to A3.6, which stays deferred; A3.7 stays deferred; A3.8 is not
  certified; G6 is deferred; G7, F6 and F7 stay locked; Final Core Validation is the absolute last.

## 7. First build evidence

*To be recorded after the merge (A0.7): for each of organization-service, audit-service and auth-service (whose workflow file changes),
the run id, the source commit, the `sha-<commit>` tag, the index digest, the revision label read back read-only, and the absence of any
SSH step, `production` approval request or deployment.*
