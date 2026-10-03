# auth-service: build and deploy by digest (V2-A.2)

- **Status:** current procedure from the merge of the V2-A.2 transition onward. Decisions: [V2-A record](../architecture/core-v2-a-baseline-and-change-safety.md)
  §6 and the V2-A.2 owner decisions OD-1 to OD-7.
- **Scope:** how an auth-service image is built, how it reaches production, and the one-time transition from automatic deployment.
  Organization and audit-service deployments are unchanged (they still rebuild `main` at dispatch).

## 1. Build ≠ deploy

```text
merge to main touching apps/auth-service/**, libs/service-kit/**, package.json, package-lock.json
or .github/workflows/auth-service-docker-build.yml
   └─ auth-service-docker-build.yml, job build-image  (not in the production queue)
        build once → push <IMAGE_NAME>:sha-<full commit>, labelled org.opencontainers.image.revision=<commit>
        → the job summary records: revision, sha tag, INDEX digest
        ⇒ STOP. No SSH, no deployment, :production and :latest are not touched. Production is unchanged.

explicit, owner-authorized production mutation
   └─ auth-service-deploy.yml (workflow_dispatch, main only, production-deploy-core-api queue, cancel-in-progress: false)
        validate the digest → resolve <IMAGE_NAME>@<digest> → revision label present and an ancestor of main
        → SSH: pull exactly <IMAGE_NAME>@<digest> → run that image's provision-and-deploy.sh. Nothing is built.
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
2. Dispatch:

   ```bash
   gh workflow run auth-service-deploy.yml --ref main -f digest=sha256:<64 hex> -f confirm='deploy auth-service'
   ```

3. The run refuses, before any SSH: a malformed digest; a digest not in the auth-service repository; an image without the revision label
   (every image built before V2-A.2, OD-3); a revision that is not an ancestor of `main` (pull-request builds such as `:develop`); a
   confirmation other than exactly `deploy auth-service` (the job is skipped).
4. The server side is the unchanged `provision-and-deploy.sh` from that same image: its pre-checks (rotation journal, broker, networks,
   the ADR-0053 audit-binding ordering rule), migrations before the running service is touched, the previous container retained as
   `nawara-core-auth-service-previous-<timestamp>`, and the health gate that restores the previous container on failure.

**The typed confirmation is not a reviewer gate.** Until a `production` GitHub environment with a required reviewer exists (V2-A.3 or a
separate settings checkpoint), the only controls are write access to the repository, the `main` guard, the confirmation and the
artifact validation. The workflow deliberately does not reference `environment:` (referencing a missing environment would create one).

## 3. Rollback

- To an earlier **labelled** `main` artifact: deploy its index digest (section 2).
- To a **legacy unlabelled** image (anything built before V2-A.2, including the image production ran before the transition): not
  through the workflow (OD-3). Use the retained-container procedure (rename a `-previous-*` container back) or a separately
  owner-authorized emergency procedure.
- Migrations are forward-only: a container rollback does not undo an applied migration.

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
