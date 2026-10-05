# Core V2 A14: supply chain and build provenance

- **Status:** **CERTIFIED — IMPLEMENTATION + REAL GITHUB/GHCR EVIDENCE** (2026-10-05, §12): merged by PR #196 (`38fa576`, merge
  `7527d53`). Record of A14.0 discovery, the owner decisions D1–D5, the A14.1 design freeze, the A14.2 implementation, the A14.3
  negative-control campaign, the A14.2a correction, the A14.3a re-proof, the A14.4 owner decisions and the A14.6 real evidence.
  **Not ENABLED IN GITHUB SETTINGS** (secret scanning, push protection and the full-SHA requirement are designed, not switched on; §5) and
  **not PROVEN IN PRODUCTION**: the attested post-A14 images are built, not deployed, and no deployment has gone through the new verifier.
  BUILT / ATTESTED ≠ DEPLOYED. It performs and authorizes no production action.
- **Scope:** the Auth, Organization and Audit production images and the workflows that build and deploy them. Not included: A3.7
  credential scoping, the SSH deployment mechanism, a release architecture, CVE gating, reproducible builds, the five unpublished
  services, G6.
- **Related:** [digest deployment runbook](../runbooks/digest-deployments.md), [V2 A0 record](core-v2-a0-immutable-deployments.md),
  [production readiness](production-readiness.md).

## 1. Problem (A14.0)

The deploy verifier accepted any artifact in the service's GHCR package whose OCI revision label named a `main` commit. Labels are claims:
anything that could push to the package (a same-repository pull request through Auth's `build-develop`, a workflow change on any branch,
a stolen token) could produce an acceptable artifact. Every GitHub Action was referenced by a mutable major tag, including the third-party
SSH action that receives the production credentials; the Node base and the production PostgreSQL image were floating tags; no SBOM and
no verifiable provenance existed (BuildKit's unsigned provenance was never checked).

## 2. Owner decisions

| | Decision |
|---|---|
| D1 | GitHub artifact attestations (keyless; the repository is public, so the public-good Sigstore instance); no managed key, no Cosign |
| D2 | every external action pinned to a full commit SHA with its exact release as a comment; `appleboy/ssh-action` kept and pinned (D2b); the repository full-SHA requirement switched on later, separately (D2c) |
| D3 | pull requests never publish: Auth's `build-develop` and its `pull_request` trigger are removed; Core CI still builds and smoke-checks every image on every pull request without pushing |
| D4 | strict cutover: an unattested image is not deployable; no allow-list, no legacy exception (every pre-A14 image, including the current Audit image, is refused) |
| D5 | secret scanning, push protection and Dependabot version updates (npm, GitHub Actions; normal pull requests, no auto-merge) |

## 3. Design and implementation

```text
protected main commit ─► <service> image workflow (SHA-pinned actions)
  ─► BuildKit build (node:22-alpine@sha256:… ; npm ci --ignore-scripts on the lockfile)
  ─► GHCR push sha-<commit> ─► INDEX digest (contains the image, SLSA provenance mode=max and an SPDX SBOM)
  ─► actions/attest-build-provenance: a signed attestation for that exact index digest, by this workflow on refs/heads/main
deploy dispatch(digest) ─► verify: digest format → artifact exists → literal-SHA label →
     gh attestation verify oci://IMAGE@digest --repo nawara-solutions/nawara-core --signer-workflow …/<service>-image workflow
       --source-ref refs/heads/main --source-digest <label> --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners
     → jq re-check of the certificate and the signed subject → ancestry of main
  ─► deploy (typed confirmation, production approval, production queue) exactly IMAGE_NAME@digest
```

| Service | Image workflow (signer) | Deploy workflow |
|---|---|---|
| auth-service | `auth-service-docker-build.yml` | `auth-service-deploy.yml` |
| organization-service | `organization-service-image.yml` | `organization-service-deploy.yml` |
| audit-service | `audit-service-image.yml` | `audit-service-deploy.yml` |

- **Provenance.** `build-image` (job-level `contents: read`, `packages: write`, `id-token: write`, `attestations: write`) attests with
  `subject-name: ${{ env.IMAGE_NAME }}`, `subject-digest: ${{ steps.build.outputs.digest }}` and `push-to-registry: true`. The attestation
  lives in the repository's attestations API (what the verifier reads) and as a bundle next to the image.
- **SBOM.** `attests: type=sbom,generator=docker/buildkit-syft-scanner:1.12.0@sha256:ae4f3b55…` (a digest-pinned generator) puts an SPDX
  SBOM inside the index; the index digest is the attested subject, so the SBOM is covered by it. Read it with
  `docker buildx imagetools inspect <image>@<digest> --format '{{json .SBOM}}'`. No policy gate.
- **Verifier.** The label is only an assertion: the signed certificate must name the same commit (`--source-digest`), and that commit
  must still be an ancestor of `main`. `verify` needs `attestations: read` (read-only). Every failure (no attestation, wrong repository,
  workflow, ref, commit, predicate, runner, another digest, malformed or empty output, an unavailable service) refuses before the
  approval. There is no bypass.
- **Pinning.** All 47 action references, plus the new attestation action; `node:22-alpine@sha256:0a7108bf…` in both stages of all eight
  Dockerfiles; `postgres:16-alpine@sha256:721873c3…` as `DB_IMAGE` in the three deploy scripts. The PostgreSQL pin only affects a database
  container a deploy creates (fresh provisioning): existing production databases are never recreated by a deploy. The A13 restore drill
  keeps `postgres:<manifest major>-alpine` (a disposable recovery container; accepted).
- **Dependabot.** `.github/dependabot.yml`: npm and GitHub Actions at `/`, weekly, at most five open pull requests each. Base-image digests
  stay manual.
- **Guards** (`check:repo`): `checkActionPins` (every workflow; full SHA and `# vX.Y.Z`; no exceptions); `checkImagePins` (identical pinned
  Node base in every application Dockerfile; identical pinned PostgreSQL in the three deploy scripts); `checkImageBuild` (push-only, a
  single `build-image` job, `provenance: mode=max`, exactly the frozen SBOM generator `SBOM_GENERATOR` (name, version and digest; one
  constant, so the three builds cannot diverge), the attestation step, its subject and permissions); `checkDigestDeploy` (the exact
  `gh attestation verify` identity between the literal-SHA and ancestry checks on the same variable, its refusal, the jq re-check and its
  refusal, `attestations: read`, no signing permission in a deployment) and, since A14.2a, **the canonical verify job**: each deploy
  workflow's `verify` job must equal `scripts/lib/digest-deploy-verify.yml` (with the service and its signer substituted): every step,
  key, condition and output, and every trust script byte for byte (an action's commit SHA is the only normalization; `checkActionPins`
  still requires it). `deploy` must need exactly `verify` under exactly the same condition (no `always()`/`!cancelled()`), and the
  workflow sets no `defaults` and no env beyond `IMAGE_NAME`. This is D4 made structural: no early success, allow-list, bypass variable,
  shadowed `gh`/`jq`, conditional call, skipped or failure-tolerant step or injected shell environment can reach the approval.

## 4. Proof items (A14.2)

| | Question | Result | Evidence |
|---|---|---|---|
| P1 | permissions and authentication of `gh attestation verify` in `verify` | **PROVEN** | the REST "list attestations" endpoint requires `attestations:read`; gh's help: an `oci://` subject needs registry authentication (the existing GHCR login) |
| P2 | the JSON the verifier parses | **PROVEN** | a read-only verification of a public GitHub-built image: an array of `{attestation, verificationResult}`; `statement.subject[].digest.sha256`, `statement.predicateType`, `signature.certificate.{buildSignerURI, sourceRepositoryURI, sourceRepositoryRef, sourceRepositoryDigest, runnerEnvironment}` |
| P3 | attestations for this repository and its private GHCR packages | **PROVEN for the attestation itself** (public repository: available on every plan; stored in the attestations API); **the registry copy (`push-to-registry`) requires A14.6 real post-merge proof** | the action's README at the pinned SHA |
| P4 | a digest-pinned SBOM generator | **PROVEN** | buildx documents `--attest type=sbom,generator=<image>`; a local build with the pinned generator, exported to a local OCI archive, held an SPDX SBOM and SLSA v1 provenance |

## 5. GitHub settings (designed, not applied)

| Setting | Mutation (later, separately authorized) | Verification |
|---|---|---|
| secret scanning | `PATCH /repos/nawara-solutions/nawara-core` `security_and_analysis.secret_scanning.status=enabled` | `GET` shows `enabled` |
| push protection | the same, `secret_scanning_push_protection` | `GET` shows `enabled` |
| full-SHA actions | `PUT /repos/nawara-solutions/nawara-core/actions/permissions` with `sha_pinning_required=true`, after the merge | `GET` shows `true` |

At certification (2026-10-05, read-only `GET`): secret scanning, push protection and `sha_pinning_required` are all still **disabled**.
None of them is part of the A14 certification; each stays a later, separately authorized settings change. Dependabot version updates
(D5) are active through `.github/dependabot.yml`: their pull requests are ordinary dependency maintenance, reviewed separately, never
auto-merged; an action bump must update the reviewed pin and its guard fixture together (the first one, the attestation action, is
refused by the repository checks until it does).

## 6. Cutover

A14 merged → the natural builds of the three image workflows (their files change) produce attested images with SBOMs → post-merge
evidence: read-only `gh attestation verify` of each new digest and a refused legacy digest → certification (local and CI) → a later,
separately authorized production deployment uses only a post-A14 attested digest (A3.6-class). No production deployment is part of A14.

## 7. Release interface

Per production artifact: repository, index digest, source commit (from the signed certificate), signer workflow and ref, run (in the
certificate and the run summary), attestation (attestations API and the registry bundle), SBOM (in the index, by digest).

## 8. Evidence (A14.2, local)

`check:repo` passes; `test:repo` 56/56 (50 + 6 A14); `test:deploy` 315/315 (261 + 54 A14 workflow-step cases: the accepted identity and
16 refusals per service against a fake `gh` that enforces the real flags and emits the proven schema); a local build of a Dockerfile with
the pinned base. While writing the tests, two guard gaps were found and closed: a `|| true` after `gh attestation verify` or after the
jq re-check could pass when a later `|| {` existed; the guards now require the refusal immediately after each command.

## 9. A14.3 negative controls and the A14.2a correction (local)

A14.3 mutated the real files 167 times (every mutation restored byte-exactly, 0 hash mismatches). Three real gaps: an early-success
path before `gh attestation verify` (a legacy-digest allow-list, V27; a bypass variable, V28) passed every control, and another
valid-looking SBOM generator digest was accepted (SBOM4). A14.2a closes them by whitelisting rather than blacklisting: the canonical
verify job and the exact `SBOM_GENERATOR` (§3). Probing the old guard also showed it missed `always()` on deploy, `continue-on-error`, a
step `if`, a replaced shell, `BASH_ENV` through `$GITHUB_ENV`, a shadowing `gh()` and a conditional call; all are refused now. No
workflow, Dockerfile or script changed in A14.2a; `test:repo` 61/61. The targeted A14.3a re-proof passed: 131 security mutations
across the three services (the V27/V28 and SBOM4 cases, generic early-success variants, GitHub Actions structural bypasses,
cross-service transplants, adjacent identity controls, a consistent change of all three generators) were all refused, every legitimate
configuration (including a reviewed action-SHA bump) was accepted, and every mutation was restored byte-exactly.

## 10. Trust boundary of the verifier policy (A14.4, owner decision)

- The repository guards (`check:repo`) protect the **established** verifier policy: a deploy workflow that differs from it, or an image
  build with another SBOM generator, is refused in Core CI.
- `scripts/lib/digest-deploy-verify.yml` (with `scripts/lib/checks.mjs` and the security tests) is a **reviewed policy artifact, not an
  independent trust root**: a change that edits the policy and the workflows it guards together can pass every automated control (A14.3a
  proved it with a synchronized allow-list). Such a change requires human review.
- In the current single-owner repository, **deliberate owner review of the pull request** is the accepted policy-integrity trust
  boundary (the `main` ruleset requires a pull request and a green `core-ci-passed`; a deployment can only run the verifier from `main`).
  This is not independent or two-person review and not cryptographically independent enforcement.
- CODEOWNERS alone would not provide independent review while the same sole owner authors, reviews and merges; none is added. Stronger
  independent approval is to be revisited when another trusted maintainer exists.
- This is an accepted governance residual, not an open A14 defect.
- The behavioural (workflow-step) tests are defence in depth: they catch a blanket bypass, not every synchronized policy change.
- Real GitHub attestations and the private-GHCR registry copy were proven after the merge (A14.6, §11).

## 11. Real GitHub and GHCR evidence (A14.6, read-only)

Anchored to the merge `7527d532a7820c2c6c7eae02f458c72453c8a819` (still `origin/main` when collected, 2026-10-05). Each image workflow
ran naturally on the merge: event `push`, `refs/heads/main`, head `7527d53`, attempt 1, success, one `build-image` job on a
GitHub-hosted runner. Every tag is `sha-7527d532a7820c2c6c7eae02f458c72453c8a819`; every package is private.

| Service | Signer workflow, run | Image @ index digest | Attestation ID, Rekor log index |
|---|---|---|---|
| auth-service | `auth-service-docker-build.yml`, 37242947448 | `ghcr.io/nawara-solutions/nawara-core-auth-service@sha256:81ed5d98a0f14e6ec4922f02d0c0f773c2a8e83779d91466b1809cf7c8a72d24` | 52661246, 3078777150 |
| organization-service | `organization-service-image.yml`, 37242947465 | `ghcr.io/nawara-solutions/nawara-core-organization-service@sha256:d7e9e36f30d2673c6fbc61683a3b1dafa0122cb051b2c811173fd71525c2bc77` | 52661245, 3078777130 |
| audit-service | `audit-service-image.yml`, 37242947534 | `ghcr.io/nawara-solutions/nawara-core-audit-service@sha256:ff62218f4a4a633cb29485fe20c35db4e48c512191703d3f6d2fc0c262c94cc1` | 52661298, 3078778449 |

- **Artifact.** For each, the immutable tag resolves to the digest, the fetched index body hashes to it locally, it is an OCI image
  index (one `linux/amd64` manifest and its attestation manifest), and the image labels are revision `7527d53` and source
  `https://github.com/nawara-solutions/nawara-core`.
- **Attestation.** The frozen verifier command (§3, `scripts/lib/digest-deploy-verify.yml`: repository, service signer workflow,
  `refs/heads/main`, source digest `7527d53`, `https://slsa.dev/provenance/v1`, `--deny-self-hosted-runners`) exited 0 for all three,
  each returning exactly one attestation, and the canonical jq identity check passed: certificate `buildSignerURI`
  `…/<signer>@refs/heads/main`, `sourceRepositoryURI` this repository, `sourceRepositoryRef` `refs/heads/main`,
  `sourceRepositoryDigest` `7527d53`, `runnerEnvironment` `github-hosted`, `buildTrigger` `push`.
- **Subject binding.** The attested subject digest was compared with the actual GHCR index digest for each service, not inferred from
  workflow success: Auth `81ed5d98…a72d24`, Organization `d7e9e36f…2bc77`, Audit `ff62218f…94cc1`: **exact match, all three**.
- **Provenance.** The signed attestation proves repository, commit, ref, signer workflow, builder, run invocation, event, runner
  environment and subject; its only material is the source commit. BuildKit's `mode=max` provenance inside the attested index records
  the resolved inputs: `node:22-alpine@sha256:0a7108bf…` (the Dockerfile pin), `buildkit-syft-scanner@1.12.0` at `sha256:ae4f3b55…`
  and the Dockerfile frontend `docker/dockerfile@1` at `sha256:4edf897a…`.
- **SBOM.** Each index holds an SPDX-2.3 SBOM (`https://spdx.dev/Document`; creators `syft-v1.51.0`, `buildkit-v0.33.1`; 405, 370 and
  370 packages). The workflow configuration requests the exact frozen generator, the registry holds the resulting SBOM, and the BuildKit
  provenance records the exact resolved scanner digest. Limitation: the SBOM's subject is the platform manifest, not the index; it is
  covered by the attested index digest through the attestation manifest, but it is not separately signed.
- **Private GHCR registry copy (closes P3).** Each package holds a Sigstore bundle manifest (`application/vnd.dev.sigstore.bundle.v0.3+json`,
  SLSA v1) whose `subject` is the image's index digest, and `gh attestation verify … --bundle-from-oci` with the full strict constraints
  passes for all three: private-GHCR lookup, OCI subject and verification **PASS** for Auth, Organization and Audit. GHCR does not serve
  the OCI referrers API; gh's fallback tag scheme works (a platform note, not a failure).
- **Wrong identity refused** (Auth digest unless stated; every case non-zero): another repository; another signer workflow
  (organization-service-image, core-ci); a feature-branch ref; another source digest (`38fa576`); the SPDX predicate; the Organization
  digest with the Auth signer; the platform manifest instead of the index.
- **Strict cutover (D4).** Documented pre-A14 artifacts exist in GHCR, carry pre-A14 revision labels, have no attestation and are refused
  by the strict verifier (the A13 one also through the registry path): Audit `sha-96e3aaf…` `sha256:436b0797…54c0`; Auth, Organization and
  Audit `sha-4979407…` `sha256:0bd9d84a…feace8`, `sha256:96bf9736…53c32`, `sha256:37a5a92b…142f2a`
  ([V2 A0 record](core-v2-a0-immutable-deployments.md)). **A pre-A14 unattested image cannot pass the current verifier**, so a redeploy
  or rollback through it needs a post-A14 attested digest.
- **No deployment.** The only non-Dependabot runs after the merge are Core CI and the three builds; the image workflows have no
  environment, no SSH and no secret beyond `GITHUB_TOKEN`; the latest runs of the three deploy workflows predate A14 (2026-09-28/30).
- **Notes, not failures.** Manual or local verification of a private package needs GHCR credentials (the canonical `verify` job logs in
  first); the repository is public, so the signatures are in the public Sigstore Rekor log (D1).

## 12. Certification

**Certified (2026-10-05):** A14 software supply-chain hardening. Its controls were implemented, validated locally, adversarially tested,
corrected where A14.3 found gaps, re-proved (A14.3a), merged through PR #196, exercised by real GitHub-hosted builds and verified against
the real private GHCR artifacts: real GitHub artifact attestations, SLSA source and workflow identity, exact artifact-digest binding,
SBOM production and strict refusal of pre-A14 unattested artifacts.

| Evidence | Identifier | Result |
|---|---|---|
| Implementation | PR #196, head `38fa576efbe44fda719d23062689a88a42741754`, merge `7527d532a7820c2c6c7eae02f458c72453c8a819` | merged by the owner, 2026-10-04 |
| PR Core CI | run 37242582178, attempt 1 | 24/24 passed |
| Post-merge Core CI | run 37242947436, attempt 1 | 24/24 passed, `core-ci-passed` passed |
| Post-merge images and attestations | runs 37242947448, 37242947465, 37242947534 | §11: all attested, verified, digest-bound. **BUILT / ATTESTED ≠ DEPLOYED** |
| Local proof | §8, §9 | `check:repo` PASS; `test:repo` 61/61; `test:deploy` 315/315, 0 skipped; `git diff --check` clean |
| Negative controls | A14.3, A14.3a (§9) | A14.3: three real gaps (V27, V28, SBOM4), corrected in A14.2a; A14.3a: 131/131 expected refusals, 7/7 positive controls accepted, 0 missed security mutations, 137/137 runs restored, 0 hash mismatches |
| Trust boundary | A14.4 (§10) | accepted: deliberate owner PR review; not independent or two-person review |

| Residual or not certified here | Status |
|---|---|
| Dockerfile frontend `# syntax=docker/dockerfile:1` is a mutable tag | LOW, outside the frozen scope (D2 and the image pins cover actions, Node and PostgreSQL); traceable, the resolved digest is in the attested provenance (§11); a future hardening change may pin it |
| policy-integrity independence | accepted governance residual (§10); revisit when another trusted maintainer exists |
| secret scanning, push protection, `sha_pinning_required` | designed, not enabled (§5); separately authorized |
| a production deployment of a post-A14 attested image; a real run of the new verifier | not performed; A3.6-class, separately authorized; production still runs pre-A14 images |
| the open Dependabot pull requests (#197–#203), including the attestation action v4.2.2 (#198) | separate maintenance; not reviewed or approved by this certification |

A14 certification does not complete A3.6, A3.7, G6 or Core V2. G6 stays deferred; G7, F6 and F7 stay locked; A13 stays closed;
Final Core Validation is the absolute last.
