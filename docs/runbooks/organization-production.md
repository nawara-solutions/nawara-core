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

## 6. Cutover monitoring and alert rules (G4)

ADR-0040 G4: the minimum monitoring and alerting for the cutover is readiness of both services, the authority state agreeing with
Auth's marker, a failed verification or digest mismatch, and the anchor-disagreement alert of decision 1.

- **Alerting model (owner decision, Core V1).** The cutover is **attended**. The named operator running each F1–F7 step (and the G6
  rehearsal) watches the signals below and treats every matching rule as an **immediate stop condition**. Routing alerts to a person
  (pager, chat, mail) is not a G4 prerequisite; it may come with a later observability platform. This is the minimum model for the
  controlled cutover, not the permanent production monitoring architecture.
- **Monitoring detects, the operator decides, this runbook governs the action.** Nothing here writes: no command changes the
  ownership state, Auth's marker or its configuration, and no signal triggers an automatic repair.
- **Thresholds and log retention** are set in the G6 rehearsal plan (ADR-0040 A2.8). A rule marked *immediately* needs no threshold.
- **Status:** defined here; **demonstrated in the G6 rehearsal: pending**.
- Everything is read from the server (internal network, `docker exec`); organization-service stays internal only. The commands print
  states, counts and signal names only: never a URL, password, token, header or event payload.

Record `T=$(date -u +%FT%TZ)` when each step starts; the log checks below read from `$T`.

### 6.1 Readiness (both services)

```bash
docker exec nawara-core-organization-service wget -qO- http://127.0.0.1:3000/ready || echo 'organization-service NOT READY'
docker exec nawara-core-auth-service wget -qO- http://127.0.0.1:3000/ready || echo 'auth-service NOT READY'   # {"status":"ready"} each
docker ps --filter name=nawara-core-organization-service --filter name=nawara-core-auth-service --format '{{.Names}}\t{{.Status}}'
```

`/ready` checks the database and the migrations (never the broker, never authority); `/health` is liveness only. A failing
readiness check is named in the service log as `readiness_check_failed check=<name>` with its error class and code (no host,
credential or message text).

### 6.2 Authority agreement (Organization's state ↔ Auth's marker)

```bash
org=$(docker exec nawara-core-organization-db psql -U organization_admin -d organization -Atc "select phase from ownership_state")
marker=$(docker exec nawara-core-auth-db psql -U auth -d auth -Atc "select mode from hierarchy_authority")
source=$(sed -n 's/^AUTH_HIERARCHY_SOURCE=//p' "$HOME/nawara-core/auth-service/.env")
echo "organization=$org auth_marker=$marker auth_source=${source:-local (unset)}"
```

Valid combinations on the fresh path (production is a fresh environment). F6 activates in organization-service first, then mirrors in
Auth (the `org_authoritative` marker via `hierarchy-retire --fresh`, and `AUTH_HIERARCHY_SOURCE=organization-service` with an Auth
redeploy); F7's `ownership retire` cites Auth's retirement.

| When | `ownership_state.phase` | `hierarchy_authority.mode` | `AUTH_HIERARCHY_SOURCE` | Verdict |
|---|---|---|---|---|
| F1 to F5, G7 (before `ownership activate`) | `PREPARED`, `VERIFIED`, `ACTIVATABLE` | `local` | unset (`local`) | **MATCH** |
| inside the attended F6 step, after `activate` and before the mirror is complete | `ACTIVE` | `local` or `org_authoritative` | unset or `organization-service` | **TRANSITIONAL**: expected only while the F6 step is running |
| F6 complete, before F7 | `ACTIVE` | `org_authoritative` | `organization-service` | **MATCH** |
| after F7 `ownership retire` | `RETIRED` | `org_authoritative` | `organization-service` | **MATCH** |

**MISMATCH** is every other combination, and a TRANSITIONAL one seen outside the F6 step. For example:
- `org_authoritative` while the phase is not `ACTIVE` or `RETIRED`;
- `frozen` (never used on the fresh path);
- `RETIRED` with `local`;
- a source that disagrees with the marker once F6 is complete.

A mismatch is an **alert: stop the cutover, investigate, never edit either side to make them agree.** After `activate` there is no
authority rollback (A2.6).

### 6.3 Alert rules

| Signal | Level | Alert when | Operator action |
|---|---|---|---|
| organization-service `/ready` (§6.1), Docker health | critical | not `{"status":"ready"}` / not `healthy`, at any check of any step | stop progression; read `readiness_check_failed check=<name>`; restore the dependency (database, or migrations through the deploy workflow); continue only once ready |
| auth-service `/ready` (§6.1), `/auth/health`, Docker health | critical | not ready / not `healthy` | same; Organization being ready says nothing about Auth |
| authority agreement (§6.2) | critical | a MISMATCH: **immediately** | stop; run no further ownership or mirror command; keep the evidence (both rows, the event records below); investigate; after F6 escalate to the owner (no rollback exists) |
| failed verification or digest mismatch: `ownership` exits 1; an `ownership_event` row with outcome `rejected` or `failed` (codes such as `verification_mismatch`, `nothing_to_verify`, `not_activatable`); the CLI's JSON log `ownership_import_failed` with `code: verification_mismatch` (the fresh-path `verify` logs under this name); `ownership_activation_rejected` | critical | any rejected or failed ownership operation during the cutover: **immediately** | stop; do not approve or activate; compare the expected digest with what the service holds; rerun `verify` only once the cause is understood |
| anchor disagreement (decision 1): Auth `hierarchy_anchor_mismatch` (error level) | critical | any occurrence: **immediately** | the request already failed closed and nothing was overwritten; stop; keep the logs; investigate (a reused id or tampered data); do not proceed |
| Auth `hierarchy_source_mismatch` (at Auth start) | critical outside F6 | any occurrence outside the F6 step | stop; the source is changed only by F6's own configuration step, never by editing the marker |
| Auth `hierarchy_reference_unavailable reason=…` / `hierarchy_reference_denied status=…` | warning | from F4 on (Auth's `ensure`), any occurrence | check organization-service readiness and the `auth-service` caller registration (§4); retry the first touch once restored |
| Organization `outbox_relay_pass_failure` / `outbox_publish_failure`, `nawara-check-outbox-lag` | warning | failures or a pending backlog older than the rehearsal-plan threshold | the broker is asynchronous: `/ready` stays 200 and the audit evidence waits in the outbox; restore the broker or the Audit binding; never delete outbox rows |

Evidence, read-only (no payload, no evidence text):

```bash
docker exec nawara-core-organization-db psql -U organization_admin -d organization -Atc "select at, operation, outcome, from_phase, to_phase, detail->>'code' from ownership_event where outcome <> 'succeeded' order by id desc limit 10"
docker exec nawara-core-auth-db psql -U auth -d auth -Atc "select at, operation, from_mode, to_mode from hierarchy_authority_event order by id desc limit 5"
docker logs --since "$T" nawara-core-auth-service 2>&1 | grep -oE 'hierarchy_(anchor_mismatch|source_mismatch|reference_unavailable|reference_denied)' | sort | uniq -c
docker logs --since "$T" nawara-core-organization-service 2>&1 | grep -oE '(readiness_check_failed check=[a-z_]+|outbox_relay_pass_failure|outbox_publish_failure)' | sort | uniq -c
docker exec nawara-core-organization-service node ../../libs/service-kit/dist/cli/check-outbox-lag.js --max-age-seconds "$THRESHOLD"   # the rehearsal-plan threshold, seconds; counts and ages only
```

## 7. Backup and restore (G5)

The database and `db.env`, `roles.env`, `.env`, `callers/`, encrypted and off-host, daily: [core backup and restore
runbook](core-backup-restore.md). Add `organization-service` to `CORE_BACKUP_SERVICES` after F1; the real-volume restore drill runs
after F1 and before G7/F6. Never restore a pre-F6 backup after F6 (that runbook §7).
