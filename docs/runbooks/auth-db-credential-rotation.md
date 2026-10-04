# Auth runtime database credential rotation runbook

Rotating the password of Auth's runtime PostgreSQL role, `auth_app`, in production:
`apps/auth-service/deploy/rotate-db-credential.sh`, run by the manual workflow `auth-db-credential-rotate.yml`.

- **Scope.** `auth_app` only. The bootstrap owner (`POSTGRES_PASSWORD`, role `auth`), the other services and the broker are not touched.
- **Secrets.** The new password is generated on the server and never leaves it: it is not printed, not placed on a command line, not
  sent to GitHub and not committed. Never paste `db.env`, `.env` or a `DATABASE_URL` anywhere; every check below prints names only.
- **This is a production change** and needs its own approval.

## 1. Why three places move together

The runtime password exists in three places, and they must always agree:

| Place | Role |
|---|---|
| PostgreSQL role `auth_app` | what the database accepts |
| `$HOME/nawara-core/auth-service/db.env` → `AUTH_APP_PASSWORD` | what **every normal Auth deploy re-applies** to the role (`ALTER ROLE ... PASSWORD`) |
| `$HOME/nawara-core/auth-service/.env` → `DATABASE_URL` | what the running Auth container connects with |

Changing only the role and `.env` is undone by the next deploy: it re-applies the old `db.env` value, which restores the exposed password
and breaks Auth. The tool moves all three, and the normal deploy refuses to run while a rotation is unfinished.

## 2. What the tool does

1. **Preflight, read-only** (any failure: `nothing was changed`):
   - Auth and its database are running and Auth is healthy;
   - both files exist, are 0600 and hold `AUTH_APP_PASSWORD` / `DATABASE_URL` exactly once, and the URL connects as `auth_app`;
   - `auth_app` exists and is not a superuser;
   - the running container was started with exactly `.env`, and its configuration can be reproduced (no published port, no extra
     capability, no override);
   - a random password is refused over TCP, which proves the database really checks passwords;
   - `db.env`, `.env`, the container and PostgreSQL all hold the same working credential. If not, it stops with
     `PRE-ROTATION CREDENTIAL STATE INCONSISTENT` and guesses nothing.
2. **Journal** (`.rotation-journal`, 0600) is written, then the **maintenance window** starts. Auth is stopped and kept, renamed
   `nawara-core-auth-service-pre-rotation-<time>`, as the reference for its configuration.
3. **Rotate:** `ALTER ROLE auth_app PASSWORD` (on stdin, with statement logging off for the session), then `db.env` and `.env` are each
   replaced atomically. In `.env` only the password part of the URL changes.
4. **Recreate** Auth from the **same image ID** it was running (`--pull never`, never `:production`), with the networks, labels, log
   settings, mounts, restart policy, stop timeout and health check read from Docker's own metadata.
5. **Verify:** Auth is healthy (`/auth/health` is database-backed), the new password logs in as `auth_app` (not a superuser), the
   container runs the new `.env`, and **every superseded password is refused**. Only then is the journal removed and `OK` printed.

No migration, no image pull or build, no broker, Audit, Traefik, DNS or `.env` change beyond `DATABASE_URL`.

## 3. Run it

Preconditions: nothing else is deploying (the workflow shares the production queue anyway), and you accept a short Auth outage.

```bash
gh workflow run auth-db-credential-rotate.yml --ref main -f confirm="rotate auth_app"
gh run watch "$(gh run list --workflow auth-db-credential-rotate.yml -L 1 --json databaseId --jq '.[0].databaseId')"
```

**Approval (V2-A.3 / A3.5).** The production job of this workflow (`rotate`) is bound to the protected GitHub environment `production`. After the
dispatch the run **waits**: approve it in GitHub (the run → **Review deployments** → `production` → **Approve and deploy**). Only then
does the job start and receive the production SSH credentials (environment secrets). The reviewer is the owner; GitHub does not
prevent self-approval here, so this is a deliberate second owner action, not independent review. **Reject** (or cancel) a run you no
longer want instead of leaving it waiting: whether a waiting run holds the `production-deploy-core-api` queue has not been observed yet.

Success ends with:

```
[rotate] OK  auth_app rotated: PostgreSQL, db.env and .env hold the new password; nawara-core-auth-service is running/healthy on the same image (...)
[rotate]     new password: authenticates as auth_app (not a superuser); superseded password(s): REJECTED
```

The maintenance window lasts from Auth's stop until the recreated container is healthy: a few seconds plus Auth's shutdown (grace up to
60 s) and start (about 1 to 2 s locally).

## 4. Verify (read-only, on the server)

```bash
docker ps --filter name=nawara-core-auth --format '{{.Names}}\t{{.Status}}\t{{.Image}}'   # auth-service (healthy); the IMAGE column now shows the image ID
docker exec nawara-core-auth-service wget -qO- http://127.0.0.1:3000/auth/health            # {"status":"ok"}
docker exec nawara-core-auth-db psql -U auth -d auth -Atc "select rolsuper from pg_roles where rolname = 'auth_app'"   # f
ls -la "$HOME/nawara-core/auth-service/.rotation-journal" 2>/dev/null || echo "no journal"      # no journal
```

The image column shows the ID because Auth is recreated from the image it runs, not from a tag. The local `:production` tag may already
point to a newer image (every deploy attempt pulls it), and recreating from the tag would silently upgrade Auth.

## 5. If it fails

| Point of failure | State | Action |
|---|---|---|
| Preflight | nothing changed | fix what the error names; re-run |
| After the journal, before or while Auth is stopped / renamed | Auth possibly stopped; journal kept | re-run: it stops and renames Auth if needed, then continues |
| After the role changed, before the files | role new, files old; journal kept | re-run |
| After `db.env`, before `.env` | files disagree; journal kept | re-run |
| After the files, before or while recreating | Auth down; journal kept | re-run |
| After recreating, before verification | journal kept | re-run |
| First attempt does not verify | the same run rolls forward once with another fresh password | none, if the second attempt verifies |
| Two attempts fail | Auth **stopped**; journal kept | investigate (Auth logs, database), then re-run |
| `SECURITY FAILURE: a superseded ... still authenticates` | not complete; journal kept | stop and investigate `pg_hba` / roles; do not call the rotation done |

A re-run with a journal present always **rolls forward** to a new, fresh password, sets all three places and recreates Auth from the
reference container. Every superseded password, including the original exposed one, must then be refused. The exposed password is never a
recovery target: do not restart the `-pre-rotation-` container, because its metadata still holds the dead password.

**While a journal exists, the normal Auth deploy refuses** (`an auth_app credential rotation was interrupted`). Finish the rotation first.

## 6. After a successful rotation

- The next normal Auth deploy re-applies `db.env`, which now holds the new password, so it keeps the rotation. This is tested in
  `scripts/deploy-tests/auth-rotation.test.mjs` ("FUTURE DEPLOY"), including a control showing that a role-and-`.env`-only rotation
  would be undone.
- **Stale metadata (separate cleanup):** the `nawara-core-auth-service-pre-rotation-*` container, and any older
  `nawara-core-auth-service-previous-*` container, still carry the old `DATABASE_URL` in their Docker metadata. That password no longer
  works, so they are harmless, but remove them once satisfied (`docker rm <name>`). The tool never deletes containers.

## 7. Validation

- `npm run test:deploy`: `auth-rotation.test.mjs` runs the script against a fake Docker CLI and a simulated PostgreSQL. It covers every
  preflight refusal, same-image and same-config recreation, URL preservation, secret safety, concurrency, every interruption point, the
  roll-forward, the security-failure path and future-deploy consistency.
- Rehearsed for real on local Docker against the production-era image (`f6199dd`), deployed by that commit's own deploy script: rotation;
  independent logins from a separate container (old refused, new accepted); identical image ID and configuration; an interruption during
  recreation followed by a roll-forward resume; a concurrent run refused; the normal deploy afterwards keeping the rotated password.
