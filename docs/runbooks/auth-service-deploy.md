# auth-service: build and deploy by digest (V2-A.2)

- **Status:** current procedure from the merge of the V2-A.2 transition onward. Decisions: [V2-A record](../architecture/core-v2-a-baseline-and-change-safety.md)
  §6 and the V2-A.2 owner decisions OD-1 to OD-7.
- **Scope:** how an auth-service image is built, how it reaches production, and the one-time transition from automatic deployment.
  Organization and audit-service deployments are unchanged (they still rebuild `main` at dispatch).
- **Later status (V2 A0):** organization-service and audit-service now follow the same model. The shared procedure for all three
  services is the [digest deployment runbook](digest-deployments.md); this runbook keeps the auth-service specifics and the V2-A.2
  transition history.

## 1. Build ≠ deploy

```text
merge to main touching apps/auth-service/**, libs/service-kit/**, package.json, package-lock.json
or .github/workflows/auth-service-docker-build.yml
   └─ auth-service-docker-build.yml, job build-image  (not in the production queue)
        build once → push <IMAGE_NAME>:sha-<full commit>, labelled org.opencontainers.image.revision=<commit>
        → the job summary records: revision, sha tag, INDEX digest
        ⇒ STOP. No SSH, no deployment, :production and :latest are not touched. Production is unchanged.

explicit, owner-authorized production mutation
   └─ auth-service-deploy.yml (workflow_dispatch, main only, typed confirmation)
        job verify  (no environment, no production credentials)
            validate the digest → resolve <IMAGE_NAME>@<digest> → revision label present and an ancestor of main
        job deploy  (needs verify; environment `production`: WAITS for the required reviewer's approval;
                     production-deploy-core-api queue, cancel-in-progress: false)
            re-check the digest → SSH: pull exactly <IMAGE_NAME>@<digest> → run that image's provision-and-deploy.sh. Nothing is built.
```

- **The INDEX digest is the deployment authority.** `docker/build-push-action` keeps provenance, so the push is an image index and its
  `outputs.digest` is the **index** digest (not a per-platform image manifest digest). Records name it "index digest".
- **Tags.** `sha-<commit>` is a human-readable handle only. `:production` and `:latest` are **frozen and deprecated**: no workflow moves
  them any more, they are not deleted, and they do not say what production runs. Never deploy or pull by them.
- **What production runs** is recorded in the deploy run's summary (index digest, revision, `main` at dispatch). A live answer needs a
  read-only server inspection of the running container.

## 2. Deploying an artifact (a production mutation: authorize each time)

1. Take the index digest from the summary of the `build-image` run of the commit to deploy (it must be a `main` commit; an earlier
   labelled `main` artifact is allowed, OD-4).
   **Before dispatching (V2 A2.3, OD-A2.3-3): confirm the candidate image accepts the server's configuration.** Images from A2.3 on
   read it more strictly: `AUTH_EVENTS` only `on` / `off`, `REQUIRE_CONTACT_VERIFICATION` only `true` / `false`, an unset `NODE_ENV`
   is production, `JWT_SECRET`, the four peppers and each `TOTP_ENCRYPTION_KEYS` entry canonical base64 (in production neither
   published in `.env.example` nor non-random), no repeated TOTP key id, and in production a `DATABASE_URL` user that is not `auth`,
   a superuser, a `*_migrator` or a `*_admin` role. Values the deploy script generates pass; a hand edit may not. On the server, let
   the **candidate** image's own loader read the `.env` the service runs with; it prints only `OK` or `REFUSED`, never a value, and
   opens no connection:

   ```bash
   NEW=ghcr.io/<owner>/nawara-core-auth-service@sha256:<64 hex>   # the digest about to be deployed
   docker run --rm --env-file "$HOME/nawara-core/auth-service/.env" --entrypoint node "$NEW" --input-type=module -e '
   import { loadConfig } from "./dist/config/app-config.js";
   try { loadConfig(); console.log("OK  this image accepts the configuration"); }
   catch { console.log("REFUSED  this image would not start with this configuration: fix it before deploying"); process.exit(1); }'
   ```

   On `REFUSED`, do not deploy: correct the `.env` (or regenerate the value the way `provision-and-deploy.sh` does) and run it again.

   **From A4.8 on, the candidate image carries the check as a command** (`dist/cli/check-config.js`, the service's own loader, every
   setting and key rule including the JWT key ring; no network, no database, nothing generated or written). It prints one line,
   `configuration valid; JWT: <mode and key counts>` or `configuration invalid: <rule>`, never a value or a ring id, and exits 1 on a
   refusal. The deploy script runs exactly this before any migration; running it first on the server shows the result without
   dispatching:

   ```bash
   docker run --rm --network none --env-file "$HOME/nawara-core/auth-service/.env" --entrypoint node "$NEW" dist/cli/check-config.js
   ```

   The earlier `loadConfig` snippet stays for a candidate image older than A4.8 (it has no `check-config.js`).

   **Compatibility review before the first deployment of an A4 image** (A4 record §11; every Auth change since the last automatic
   deployment ships together): the check passes on the server's `.env` (strict parsing: exact `NODE_ENV`, `AUTH_EVENTS` `on` / `off`,
   `REQUIRE_CONTACT_VERIFICATION` `true` / `false`, no published development key, the runtime database role); no variable is set both
   as `NAME` and `NAME_FILE`; `TRUST_PROXY=true` still means one hop; unknown or stale keys (`PAYMENT_SERVICE_*`) stay ignored; the
   existing `JWT_SECRET` is accepted unchanged (`JWT: legacy only`); `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGINS` keep the production values.
   A names-only audit of the server `.env`, run by the owner: `sed 's/=.*//' "$HOME/nawara-core/auth-service/.env" | sort`, never the
   values. JWT key changes follow the [rotation runbook](secret-rotation.md) §4: one owner-authorized deploy per step, never a
   `docker restart` (it does not apply an edited `.env`).
2. Dispatch:

   ```bash
   gh workflow run auth-service-deploy.yml --ref main -f digest=sha256:<64 hex> -f confirm='deploy auth-service'
   ```

3. Approve the `deploy` job when it waits for the `production` environment (see **Approval** below).
4. The run refuses, before any approval and before any SSH (in `verify`): a malformed digest; a digest not in the auth-service repository; an image without the revision label
   (every image built before V2-A.2, OD-3); a revision that is not an ancestor of `main` (pull-request builds such as `:develop`); a
   confirmation other than exactly `deploy auth-service` (the job is skipped).
5. The server side is `apps/auth-service/deploy/provision-and-deploy.sh` from that same image: its pre-checks (rotation journal,
   broker, networks, the ADR-0053 audit-binding ordering rule); from A4.8 on, the `.env` completed (the legacy `JWT_SECRET` generated
   only when no JWT key variable of any form is present) and the configuration check above **before any migration** (a refusal stops
   the deploy: no migration, the running service untouched); migrations before the running service is touched; the previous container
   retained as `nawara-core-auth-service-previous-<timestamp>`; and the health gate that restores the previous container on failure.

**Approval (V2-A.3 / A3.5).** The production job of this workflow is bound to the protected GitHub environment `production`. After the
dispatch the run **waits**: approve it in GitHub (the run → **Review deployments** → `production` → **Approve and deploy**). Only then
does the job start and receive the production SSH credentials (environment secrets). The reviewer is the owner; GitHub does not
prevent self-approval here, so this is a deliberate second owner action, not independent review. **Reject** (or cancel) a run you no
longer want instead of leaving it waiting: whether a waiting run holds the `production-deploy-core-api` queue has not been observed yet.

The typed confirmation, the `main` guard and the artifact validation stay as independent layers. *Before V2-A.3 / A3.5 there was no
reviewer gate and the deployment was one job.* **Known limitation until A3.7:** the organization-level `DEPLOY_SSH_*` secrets still
exist and are readable by a workflow that does not declare the environment.

## 3. Rollback

- To an earlier **labelled** `main` artifact: deploy its index digest (section 2).
- To a **legacy unlabelled** image (anything built before V2-A.2, including the image production ran before the transition): not
  through the workflow (OD-3). Use the retained-container procedure (rename a `-previous-*` container back) or a separately
  owner-authorized emergency procedure.
- Migrations are forward-only: a container rollback does not undo an applied migration.
- **JWT keys (ADR-0058).** A retained container runs the keys and the active key **it was created with**; an image older than A4.7
  cannot verify ring-signed tokens; an image older than A4.8 brings its own deploy script, which regenerates `JWT_SECRET` when it is
  absent. Once a JWT key ring is configured, deploy only images from A4.8 on and check the limits in the
  [rotation runbook](secret-rotation.md) §4.6 and §4.11 before any rollback.

## 4. The transition merge (one time)

> **Later status (2026-10-03).** The transition merged as PR #187 (`7295e8e`) and is certified. The merge preceded the verification
> of P1, P2, P4 and P5, which were established afterwards; production Auth was not changed. The history is in the
> [V2-A.2 certification record](../architecture/core-v2-a-2-certification.md). The text below is kept as written.

### 4.1 Mandatory pre-merge checks (all required; the owner merges manually)

| # | Check | How |
|---|---|---|
| **P1** | No `auth-service-docker-build` run queued or in progress, immediately before the merge (a waiting run uses its own commit's workflow definition and would still deploy) | `gh run list --workflow auth-service-docker-build.yml --limit 5` |
| **P2** | No competing Auth-path PR merges between approval and post-merge verification | PR list review |
| **P3** | The transition PR changes no `apps/`, `libs/` or package file | the PR's file list |
| **P4** | **Read-only VPS check:** no automation on the server depends on the mutable `:production` / `:latest` tags (Watchtower, cron, a custom updater, any other automated `docker pull`). Repository evidence cannot prove this. | owner, read-only, on the server: running containers and their images, crontabs, systemd timers, any updater container |
| **P5** | PR CI green | the PR checks |

### 4.2 Expected post-merge behaviour

```text
transition merge → push run of auth-service-docker-build.yml (the merged definition)
  → build-image only → sha-<merge commit> → index digest recorded in the summary
  → NO SSH → NO deployment → production Auth unchanged
```

Verify: the run's only job is `build-image`; no `auth-service-deploy` run exists; the recorded digest's revision label equals the merge
commit (read-only `docker buildx imagetools inspect`); the owner confirms read-only that production Auth's container, start time and
image are unchanged.

**Any SSH or deployment job after the transition merge: STOP and escalate. No automatic corrective action.**
