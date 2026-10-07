# Core service deployment by exact digest (auth-service, organization-service, audit-service)

- **Status:** current procedure for every Core service deployed to production from this repository (V2-A.2 for auth-service, V2 A0
  for organization-service and audit-service). Service-specific preconditions stay in each service's runbook:
  [auth-service](auth-service-deploy.md), [organization-service](organization-production.md) §2,
  [audit-service and the broker order](core-rabbitmq-production.md) §1.
- **Design:** [V2 A0 record](../architecture/core-v2-a0-immutable-deployments.md); history of the Auth transition:
  [V2-A.2 certification](../architecture/core-v2-a-2-certification.md).

## 1. Build ≠ deploy

```text
merge to main that changes an input of the image (the service, libs/service-kit, libs/audit-contract, package.json,
package-lock.json, .dockerignore or the image workflow itself)
   └─ <service> image workflow, job build-image (no environment, no production credentials, no SSH, not in the production queue)
        build once → push ghcr.io/<owner>/nawara-core-<service>:sha-<full commit>
        labels org.opencontainers.image.revision=<commit>, org.opencontainers.image.source=<repository>
        an SPDX SBOM and SLSA provenance inside the index (V2 A14)
        → a GitHub artifact attestation signed for that exact INDEX digest by this workflow on refs/heads/main (V2 A14)
        → the run summary records: revision, sha tag, INDEX digest
        ⇒ STOP. Nothing is deployed. Production is unchanged.

explicit, owner-authorized production mutation
   └─ <service>-deploy.yml (workflow_dispatch, main only, typed confirmation)
        job verify  (no environment, no production credentials)
            validate the digest → resolve <IMAGE_NAME>@<digest> in the service's own repository
            → revision label is a literal commit SHA → gh attestation verify: the trusted provenance of this exact digest, signed by
              the service's image workflow on refs/heads/main at that commit (V2 A14) → revision is an ancestor of main
        job deploy  (needs verify; environment `production`: WAITS for the required reviewer's approval;
                     production-deploy-core-api queue, cancel-in-progress: false)
            re-check the digest → SSH: pull exactly <IMAGE_NAME>@<digest> → run that image's provision-and-deploy.sh. Nothing is built.
```

| Service | Image workflow | Deploy workflow | Confirmation |
|---|---|---|---|
| auth-service | `auth-service-docker-build.yml` | `auth-service-deploy.yml` | `deploy auth-service` |
| organization-service | `organization-service-image.yml` | `organization-service-deploy.yml` | `deploy organization-service` |
| audit-service | `audit-service-image.yml` | `audit-service-deploy.yml` | `deploy audit-service` |

- **The INDEX digest is the deployment authority.** Provenance stays on, so each push is an image index; the run summary shows its
  digest. `sha-<commit>` is a human-readable handle only.
- **Repository checks** (`npm run check:repo`) refuse an image workflow that deploys, uses the production environment or credentials,
  publishes anything but `sha-<commit>`, lacks the labels or the digest check, or misses an image input in its trigger paths; and a
  deploy workflow that builds, deploys anything but `IMAGE_NAME@digest`, skips `verify`, or loses its confirmation.

## 2. Deploying an artifact (a production mutation: authorize each time)

1. Take the index digest from the summary of the image workflow run of the `main` commit to deploy (an earlier labelled `main`
   artifact may be selected).
   **Before dispatching (V2 A2.2, OD-A2.2-2):** confirm that this candidate image accepts the server's configuration: for
   organization-service the check in its [runbook](organization-production.md) §2; for audit-service the check below. Each prints only
   `OK` or `REFUSED`; on `REFUSED`, correct the configuration first.
2. Dispatch, for example:

   ```bash
   gh workflow run organization-service-deploy.yml --ref main -f digest=sha256:<64 hex> -f confirm='deploy organization-service'
   ```

3. `verify` refuses, before any approval and before any SSH: a malformed digest; a digest that is not in **this service's** repository;
   an image without the revision label (every image built before the service's immutable build, including what production runs today:
   see §4); **since V2 A14, an image without the trusted provenance** (no attestation, or one from another repository, workflow, ref or
   commit, or for another digest; every image built before A14 is unattested and therefore refused, with no exception); a revision that
   is not an ancestor of `main`. A confirmation other than the exact phrase skips both jobs.
   To check an artifact yourself (read-only): `gh attestation verify oci://<IMAGE_NAME>@<digest> --repo nawara-solutions/nawara-core
   --signer-workflow nawara-solutions/nawara-core/.github/workflows/<service image workflow> --source-ref refs/heads/main`.
4. **Approve** the `deploy` job when it waits for the `production` environment (the run → **Review deployments** → `production` →
   **Approve and deploy**). The reviewer is the owner; GitHub does not prevent self-approval here, so this is a deliberate second owner
   action, not independent review. **Reject** (or cancel) a run you no longer want instead of leaving it waiting: whether a waiting run
   holds the `production-deploy-core-api` queue has not been observed yet.
5. The server side is the service's unchanged `provision-and-deploy.sh`, streamed **from that same image**, with the service's own
   pre-checks (see its runbook).

**audit-service configuration check (V2 A2.1 / A2.2).** Newer images read the configuration more strictly (A2.1: surrounding whitespace
removed and a blank value unset, plain decimal integers, `NAME` and `NAME_FILE` not both set; A2.2: in production the database user may
not be a superuser, a `*_migrator` or a `*_admin` role; the caller policy as since A1.3). On the server, let the **candidate** image's own
loader read the `.env` the service runs with; it prints only `OK` or `REFUSED`, never a value, and opens no connection:

```bash
NEW=ghcr.io/<owner>/nawara-core-audit-service@sha256:<64 hex>   # the digest about to be deployed
docker run --rm --env-file "$HOME/nawara-core/audit-service/.env" --entrypoint node "$NEW" --input-type=module -e '
import { loadAuditConfig } from "./dist/config/audit-config.js";
try { loadAuditConfig(); console.log("OK  this image accepts the configuration"); }
catch { console.log("REFUSED  this image would not start with this configuration: fix it before deploying"); process.exit(1); }'
```

## 3. Migrations and rollback

- The migrations run **from the selected exact image (digest)**, as the service's migrator role, **before** the running service is
  replaced.
- A failed or refused migration **leaves the running service untouched** (the deploy stops).
- Successful migrations are **forward-only**.
- If the new container does not become healthy it is removed and the previous container (kept as `<service>-previous-<timestamp>`) is
  renamed back and started. **A container rollback does not undo database migrations.**

## 4. Legacy images

Images built before a service's immutable build carry no revision label, and every image built before V2 A14 carries no trusted
provenance attestation (V2 A14 D4, strict cutover), so the deploy workflow refuses them. Only an image built after the A14 merge is
deployable. This includes the images
production runs today (auth-service since the last automatic deployment; organization-service and audit-service since their last
rebuild-at-dispatch deployments). The running containers are not touched until a separately authorized deployment; returning to a
legacy image uses the retained-container procedure, never the workflow.

## 5. First build evidence

The first image of each service is built naturally by the merge that introduces (or changes) its image workflow. Record: the run id,
the source commit, the `sha-<commit>` tag, the index digest from the summary, a read-only `docker buildx imagetools inspect` of
`<IMAGE_NAME>@<digest>` showing the revision label, and that no SSH step, `production` approval request or deployment occurred.
