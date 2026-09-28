# Organization Service production runbook

Production deployment of organization-service and the operator steps of the fresh-environment cutover (ADR-0040 A2.5 F1–F7). Design and
gate mapping: [Stage 21.x G1 record](../architecture/stage-21/stage-21-x-g1-organization-topology.md).

- **Every step below is a separate production change with its own approval.** Deploying never activates anything.
- **Secrets** (database, broker, caller tokens, the one-time owner password) are generated or entered on the server only. Never print,
  paste or copy one into a ticket, a workflow input or a command line. The commands below print names, phases and counts.
- **F6 is a hard boundary:** in a fresh environment there is **no authority rollback** after ACTIVATE AUTHORITY (ADR-0040 A2.6).
- **T1 gate:** the Auth → RabbitMQ → Audit relay evidence must be certified **before G7 and before F6**. Never create an audited
  action for it.

**Never:** publish a port for, or add a Traefik route to, organization-service or its database; give it `deploy_edge`; run an
`ownership` command from a deploy; set `OWNERSHIP_PRODUCTION_ACTIVATION` outside the approved F6 run; grant `organization_app` anything
beyond what the deploy asserts; rotate a caller token by deleting its file; restart a `-previous-` container.

## 1. Prerequisites

| Check | How |
|---|---|
| broker has the `organization-service` identity | `gh workflow run core-rabbitmq-provision.yml --ref main -f services="audit-service auth-service organization-service"` |
| audit-service deployed and bound | `docs/runbooks/core-rabbitmq-production.md` §3 |
| Auth healthy, `AUTH_EVENTS=off` | as the RabbitMQ runbook §4 |

## 2. Deploy (G1; the deployment part of F1)

```bash
gh workflow run organization-service-deploy.yml --ref main
```

Done when the log ends `OK  nawara-core-organization-service is running/healthy on nawara-core-internal; ownership phase PREPARED,
environment class undeclared (deploying never changes it)`. The deploy creates the database, the roles **before** migrating, applies the
migrations as `organization_migrator`, **asserts** the runtime role's privileges (fail closed), and starts the private service.

Read-only verification on the server:

```bash
docker ps --filter name=nawara-core-organization --format '{{.Names}}\t{{.Status}}\t{{.Image}}'
docker inspect -f 'ports={{len .HostConfig.PortBindings}} nets={{range $n,$_ := .NetworkSettings.Networks}}{{$n}} {{end}}' nawara-core-organization-service   # ports=0 nets=nawara-core-internal
docker exec nawara-core-organization-service wget -qO- http://127.0.0.1:3000/ready; echo
docker exec nawara-core-organization-db psql -U organization_admin -d organization -Atc "select phase, coalesce(environment_class,'undeclared') from ownership_state"
docker exec nawara-core-organization-db psql -U organization_admin -d organization -Atc "select has_table_privilege('organization_app','ownership_state','UPDATE'), has_table_privilege('organization_app','company','DELETE')"   # f|f
docker exec nawara-core-organization-db psql -U organization_admin -d organization -Atc "select has_table_privilege('organization_app','schema_migrations','SELECT'), has_table_privilege('organization_app','schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE')"   # t|f
```

## 3. The fresh path (ADR-0040 A2.5), step by step

Run each on the server as the deploy user. `IMG` is the image the service runs: `IMG=$(docker inspect -f '{{.Config.Image}}' nawara-core-organization-service)`.
The ownership CLI needs the migrator login; build it in a temporary 0600 file, never on a command line:

```bash
ownership() {   # usage: ownership <command> [flags]   (never the runtime role)
  local f; f=$(mktemp); chmod 600 "$f"
  printf 'NODE_ENV=production\nOWNERSHIP_ADMIN_DATABASE_URL=postgres://organization_migrator:%s@nawara-core-organization-db:5432/organization\n' \
    "$(sed -n 's/^ORGANIZATION_MIGRATOR_PASSWORD=//p' ~/nawara-core/organization-service/roles.env)" >"$f"
  docker run --rm --network nawara-core-internal --env-file "$f" --entrypoint node "$IMG" dist/cli/ownership.js "$@"; local rc=$?
  rm -f "$f"; return $rc
}
```

| Step | Action (each separately approved) | Result |
|---|---|---|
| **F1** | deploy (§2); `ownership declare-class --class fresh --actor <NAME>`; register the provisioning caller (§4); redeploy (§2) | `PREPARED`, class `fresh`; provisioning credential loaded |
| **F2** | create the first Company with the provisioning token (`POST /organization/companies`, from a one-off container on `nawara-core-internal`; the token read from `callers/provisioning.token` into a 0600 env file) | one Company |
| **F3** | nothing more: Platforms and Organizations are created **after** activation (ADR-0040 A2.5; OPEN-5) | — |
| **F4** | register the `auth-service` caller (§4); redeploy organization-service; redeploy Auth (it now receives `ORGANIZATION_SERVICE_URL`/`_TOKEN`; its source stays `local`); `bootstrap-owner` with `BOOTSTRAP_COMPANY_ID` (below) | the owner exists; Auth's reference row equals Organization's |
| **T1** | when the owner performs their first genuine audited action (e.g. enrolls a factor: `owner.factor_enrolled`), capture T1 with the read-only relay commands of the RabbitMQ runbook §4 | relay certified |
| **F5** | `ownership verify --expect-digest <D> --actor <NAME>` | `VERIFIED` |
| **G6** | production-like rehearsal of F1–F7 recorded | — |
| **G7** | only after G1–G6 **and T1**: `ownership approve --reference <G7 record> --actor <APPROVER>` | `ACTIVATABLE` |
| **F6** | `OWNERSHIP_PRODUCTION_ACTIVATION=enabled` for this one run, `ownership activate --confirm ACTIVATE-AUTHORITY --actor <NAME>`; mirror: Auth `AUTH_HIERARCHY_SOURCE=organization-service` and its marker | `ACTIVE`. **No rollback from here** |
| **F7** | retire Auth's hierarchy writes; post-activation verification; then open other callers | `RETIRED` |

F4's one-time owner password never touches a command line, a log or the shell history:

```bash
read -rs -p 'one-time owner password: ' P; echo
f=$(mktemp); chmod 600 "$f"
printf 'BOOTSTRAP_COMPANY_ID=%s\nBOOTSTRAP_OWNER_EMAIL=%s\nBOOTSTRAP_OWNER_PASSWORD=%s\n' "<company id>" "<owner email>" "$P" >"$f"; unset P
# The Auth CLI needs Auth's database (deploy_edge) AND organization-service for `ensure` (nawara-core-internal): create, attach, run.
c=$(docker create --network deploy_edge --env-file ~/nawara-core/auth-service/.env --env-file "$f" \
  --entrypoint node "$(docker inspect -f '{{.Config.Image}}' nawara-core-auth-service)" dist/cli/main.js bootstrap-owner)
docker network connect nawara-core-internal "$c"; docker start -a "$c"; docker rm "$c" >/dev/null
rm -f "$f"
```
(The exact F4 invocation is re-confirmed in the F4 task before it runs.)

## 4. Registering a caller (F1: `provisioning`; F4: `auth-service`)

```bash
docker run --rm --entrypoint cat "$IMG" deploy/register-caller.sh | CALLER=provisioning CONFIRM="register provisioning" bash -s
```

It writes `callers/<caller>.token` (0600, never printed) and rebuilds `SERVICE_TOKENS` / `SERVICE_POLICY` in `.env`; it restarts
nothing (redeploy to load). Policies: `provisioning` = `hierarchy.provision` alone; `auth-service` = `hierarchy.read`, no Platform.
An existing token is never rotated by the tool. After F7, add each new Platform id to `auth-service`'s `allowedPlatforms` before Auth
must `ensure` its Organizations.

## 5. Failure behaviour

| Situation | What happens | Action |
|---|---|---|
| preflight refuses (network, broker, broker identity) | nothing changed | fix the named prerequisite |
| migration fails or is refused | the running service is not touched | fix; redeploy |
| privilege assertion fails | nothing is started or swapped | investigate the role; never grant around it |
| replacement not ready, or it breaks the exposure contract | removed; the previous container restored | read its logs |
| Organization unreachable from Auth | Auth `ensure` / first touches answer `503 hierarchy_unavailable` (fail closed) | restore Organization |
| broker down | Organization mutations commit; audit waits in its outbox | restore the broker |

Previous containers are kept as `nawara-core-organization-service-previous-<time>`; remove them once satisfied.

## 6. What G4 and G5 will cover

- **G4 signals:** `/health`, `/ready`, the ownership phase, Auth's `hierarchy_unavailable` / `hierarchy_anchor_mismatch`,
  `hierarchy_source_mismatch`, the outbox relay (`outbox_relay_pass_failure`, `nawara-check-outbox-lag`).
- **G5 backup:** the `nawara-core-organization-db-data` volume, and `db.env`, `roles.env`, `.env`, `callers/`; off-host, with a
  restore drill.
