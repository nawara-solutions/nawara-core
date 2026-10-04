# Core production RabbitMQ runbook

Operational procedure for the Core V1 production broker and the services that depend on it ([ADR-0053](../adr/0053-core-v1-production-rabbitmq.md)).

- **Secrets.** Broker, database and service secrets are generated on the server and live in `$HOME/nawara-core/*/` (0700 / 0600). Never
  print, paste or copy one into a ticket, chat, workflow input or command line. Every command below prints names and counts only.
- **Every step is a production change** and needs its own approval. Nothing here runs automatically on merge.

**Never, as a recovery step:**
- publish 5672 or 15672, add a Traefik route to the broker, or attach it to `deploy_edge`;
- give a service the `nawara-admin` credentials, or enable `guest`;
- declare `audit-service.audit` (or any service queue) by hand: its arguments must be the ones audit-service declares, or audit-service
  cannot start;
- delete the broker volume `nawara-core-rabbitmq-data`, or delete / "republish" `outbox` rows;
- deploy Auth with the ordering guard bypassed.

## 1. Order (first introduction)

| Step | What | How | Done when |
|---|---|---|---|
| 1 | Provision the broker and the `audit-service` + `auth-service` identities | `gh workflow run core-rabbitmq-provision.yml --ref main -f services="audit-service auth-service"` | log ends `OK  nawara-core-rabbitmq is ready`; §2 checks pass |
| 2 | Deploy audit-service (database, migrations, private container) | `gh workflow run audit-service-deploy.yml --ref main` (as executed; today: by digest, see below) | log ends `OK ... audit-service.audit is declared, bound to audit.# and consumed`; §3 checks pass |
| 3 | Deploy auth-service (joins the private network; takes its identity from the broker) | `gh workflow run auth-service-deploy.yml --ref main` | log ends `OK  nawara-core-auth-service is running/healthy`; §4 checks pass |
| 4 | Certify `core-api.nawara-solutions.com` (and the temporary alias) | the domain certification | both hosts reach `/auth/health` |

**Since V2-A.3 / A3.5:** each of these workflows waits for the `production` environment approval before its production job starts
(see the [Auth deploy runbook](auth-service-deploy.md) §2, **Approval**). The table above is the first-introduction order as executed.
**Today (V2 A0)** audit-service and auth-service are deployed by exact index digest, never rebuilt at dispatch:
`gh workflow run audit-service-deploy.yml --ref main -f digest=sha256:<64 hex> -f confirm='deploy audit-service'` (and
`-f confirm='deploy auth-service'` for Auth), per the [digest deployment runbook](digest-deployments.md). The broker-topology
precondition, the order (audit-service before auth-service) and audit-service's `/ready` health gate (database, migrations, broker,
ingestion consumer) are unchanged.

The order is enforced, not only documented: audit-service's deploy fails unless its queue, dead-letter topology, consumer and binding
exist on the broker, and Auth's deploy refuses (before migrating or stopping anything) unless the binding exists. Why: the relay publishes
without `mandatory`, so an `audit.*` event with no bound queue is confirmed by the broker and dropped (ADR-0053, Context).

Production keeps `AUTH_EVENTS=off`. Auth's broker identity may publish `audit.*` only.

## 2. Verify the broker (read-only)

```bash
docker ps --filter name=nawara-core-rabbitmq --format '{{.Names}}\t{{.Status}}\t{{.Image}}'           # (healthy)
docker inspect -f 'ports={{len .HostConfig.PortBindings}} nets={{range $n,$_ := .NetworkSettings.Networks}}{{$n}} {{end}}' nawara-core-rabbitmq
#   expected: ports=0 nets=nawara-core-internal
docker network inspect -f 'internal={{.Internal}}' nawara-core-internal                                # internal=true
docker exec -u rabbitmq nawara-core-rabbitmq rabbitmqctl -q list_users --no-table-headers              # no guest; services have []
docker exec -u rabbitmq nawara-core-rabbitmq rabbitmqctl -q list_permissions -p nawara-core --no-table-headers
docker exec -u rabbitmq nawara-core-rabbitmq rabbitmqctl -q list_topic_permissions -p nawara-core --no-table-headers
sudo ss -ltnp | grep -E ':(5672|15672)\b' || echo "no host listener on 5672/15672"
```

Always run the broker CLI as `-u rabbitmq`: a CLI started as root during the node's boot can write a root-owned Erlang cookie and take the
node down.

## 3. Verify audit-service (read-only)

```bash
docker ps --filter name=nawara-core-audit --format '{{.Names}}\t{{.Status}}\t{{.Image}}'              # service + db (healthy)
docker exec -u rabbitmq nawara-core-rabbitmq rabbitmqctl -q list_queues -p nawara-core name durable messages consumers --no-table-headers
#   audit-service.audit true <n> 1   audit-service.audit.retry true 0 0   audit-service.audit.dead true 0 0
docker exec -u rabbitmq nawara-core-rabbitmq rabbitmqctl -q list_bindings -p nawara-core source_name destination_name routing_key --no-table-headers
#   nawara.events  audit-service.audit  audit.#
```

audit-service has no public route: it is reached by nothing but the broker until real readers exist (P-A8).

## 4. Verify Auth and the relay (read-only)

```bash
docker inspect -f 'nets={{range $n,$_ := .NetworkSettings.Networks}}{{$n}} {{end}}' nawara-core-auth-service   # deploy_edge nawara-core-internal
grep -c '^RABBITMQ_URL=' "$HOME/nawara-core/auth-service/.env"                                                  # 1 (never print it)
grep '^AUTH_EVENTS=' "$HOME/nawara-core/auth-service/.env"                                                      # AUTH_EVENTS=off
```

After the first audited Auth action (for example an owner factor change), the relay connects as `auth-service`
(`rabbitmqctl -q list_connections user`), the `audit-service.audit` depth returns to 0, and the Auth outbox has no unpublished row:
`SELECT count(*) FROM outbox WHERE "publishedAt" IS NULL;` run as the Auth database owner.

## 5. Failure behaviour

| Situation | What happens | Action |
|---|---|---|
| Broker down at runtime | Auth, Organization, File, Release keep serving; evidence waits in each outbox; audit-service `/ready` 503 | restore the broker; the relays drain on their own |
| Provisioning refuses (unknown service, non-internal network, published port, lost client file) | nothing changed | fix the cause named in the error; never force |
| audit-service deploy fails | new container removed, previous one restored (if any); database untouched | read the named check (queue, binding, consumer, `.dead`) |
| Auth deploy refuses at the guard | nothing changed | deploy audit-service first (§1 step 2) |
| Auth cannot join `nawara-core-internal` | new container removed, previous one restored | check the network (§2) |

Previous containers are kept stopped as `<name>-previous-<timestamp>`; remove them once satisfied.

## 6. Later changes

- **A new broker participant** (Notification, Organization, File, Release): add it to `RABBITMQ_SERVICES` and re-run step 1; deploy the
  consumer before any producer that feeds it. Billing and Payment need their grants defined first (the script refuses them).
- **Enabling `AUTH_EVENTS`** (Stage 21.x): widen `auth-service`'s topic write grant in `infra/rabbitmq/provision.sh`, deploy
  notification-service first, then flip the flag.
- **Rotating an identity**: a deliberate change; the scripts never rotate. Change the password with `rabbitmqctl change_password` (stdin),
  update `clients/<service>.env` and that service's `.env` together, then redeploy the service.
- **Upgrading RabbitMQ**: deliberate. The script never recreates an existing broker; it only reports an image mismatch.
