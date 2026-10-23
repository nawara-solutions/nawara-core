#!/usr/bin/env bash
# Provisions the Core V1 production RabbitMQ (ADR-0053) on the VPS: ONE node on the private, internal Docker network, a named volume,
# no published port, no management UI, no `guest`, and one least-privilege identity per service. Runs ON THE SERVER, as the deploy user:
#
#   bash -s < infra/rabbitmq/provision.sh                       (the core-rabbitmq-provision workflow streams it the same way)
#
# Idempotent: re-running converges users, passwords (to the stored ones) and permissions; it never recreates the broker container,
# never deletes the volume, never rotates a stored secret and never prints one (no `set -x`; only NAMES are echoed).
#
# State kept on the server (mode 0700 dir, 0600 files), default $HOME/nawara-core/rabbitmq:
#   rabbitmq.env            RABBITMQ_DEFAULT_USER / RABBITMQ_DEFAULT_PASS / RABBITMQ_DEFAULT_VHOST (the break-glass administrator)
#   clients/<service>.env   RABBITMQ_URL=amqp://<service>:<secret>@<broker>:5672/<vhost>  (read by that service's deploy script only)
#
# Which identities: RABBITMQ_SERVICES (space-separated, default "audit-service auth-service"). An identity only grants access; it
# does not make a service publish. Auth's deploy additionally refuses to start while the audit queue is not bound (the ordering rule).
# Billing and Payment identities are DEFINED (Core V2 S1d-2) but never selected by default: provisioning them is the S1-R rollout.
set -euo pipefail
umask 077

DIR="${BROKER_DIR:-$HOME/nawara-core/rabbitmq}"
NET="${CORE_NETWORK:-nawara-core-internal}"
BROKER="${RABBITMQ_CONTAINER:-nawara-core-rabbitmq}"
VOL="${RABBITMQ_VOLUME:-nawara-core-rabbitmq-data}"
# Pinned by digest (the multi-arch index of 3.13.7-alpine): the same 3.13.7 the local compose broker and the real-broker suites run.
# No management plugin: nothing in Core needs the UI, and an unused HTTP listener is attack surface. Upgrades are deliberate (runbook).
IMAGE="${RABBITMQ_IMAGE:-rabbitmq:3.13.7-alpine@sha256:d7af1c87c5f1eda13fcfca06db452bf3aeab6619fc3358b68535c0c02c4e52bc}"
VHOST=nawara-core
ADMIN=nawara-admin
EXCHANGE=nawara.events
SERVICES="${RABBITMQ_SERVICES:-audit-service auth-service}"
ENV_FILE="$DIR/rabbitmq.env"
CLIENTS="$DIR/clients"

log() { printf '[rabbitmq] %s\n' "$*"; }
die() { printf '[rabbitmq] ERROR: %s\n' "$*" >&2; exit 1; }
exists() { docker inspect "$1" >/dev/null 2>&1; }
# Append KEY=VALUE only when KEY is absent, so re-runs never rotate or overwrite a secret.
ensure() { grep -q "^$2=" "$1" 2>/dev/null || { printf '%s=%s\n' "$2" "$3" >>"$1"; log "  + $2 (new)"; }; }
# Every CLI call runs as the `rabbitmq` user: a CLI started as root before the node has written its Erlang cookie creates a root-owned
# cookie and the node then exits (reproduced with 3.13.7). The same user the image's own entrypoint drops to.
ctl() { docker exec -u rabbitmq "$BROKER" rabbitmqctl -q "$@"; }
# Without -q: in quiet mode add_user / change_password do not read the password from stdin and wait forever (3.13.7).
ctl_stdin() { docker exec -i -u rabbitmq "$BROKER" rabbitmqctl "$@"; }
diag() { docker exec -u rabbitmq "$BROKER" rabbitmq-diagnostics -q "$@" >/dev/null 2>&1; }
# Checks capture first, then grep a here-string: under pipefail, `cmd | grep -q` can report a spurious failure (grep exits, cmd gets SIGPIPE).
has_user() { local all; all=$(ctl list_users --no-table-headers | cut -f1); grep -qx "$1" <<<"$all"; }

# ---------------------------------------------------------------- identities (least privilege, ADR-0053 §4; P-A1)
# Permissions are regexes over resource NAMES in the vhost: configure (declare/delete), write (publish to an exchange, bind a queue),
# read (consume a queue, bind from an exchange). They follow exactly what the service-kit bus does (rabbitmq-event-bus.ts):
#   producer: declares the exchange (configure) and publishes to it (write); consumes nothing.
#   consumer: declares the exchange, the dead-letter exchange `<exchange>.dlx` and its queue Q, Q.retry and Q.dead; binds Q to the
#             exchange and Q.dead to the DLX; consumes Q; republishes retry / dead-letter copies through the default exchange.
#   producer_consumer: both, on ONE identity (billing-service, ADR-0057 S0-C5 H4): the consumer's grants plus write on the exchange.
# Topic permissions on the topic exchange constrain ROUTING KEYS: write = what a user may publish, read = what it may bind a queue to.
# Core V2 S1d-2 (ADR-0057 S0-C5): they are NOT written here. They are the generated block below (exact, escaped, anchored keys from the
# event contracts, the audit catalog and the reviewed infra/rabbitmq/topic-activation.json); an empty set is the deny-all '^(?!)$'.
# Known limits (runbook; register OD-BRK): configure on the exchange also allows deleting it; write on amq.default lets a consumer address
# any queue by name, and write on the shared fanout DLX reaches every dead-letter queue: topic permissions constrain neither, and consumer
# enforcement (S1e) is what protects against such an injection. The broker checks a `user_id` against the authenticated user but does not
# require one, and never compares it with the event's `source` header (consumers do, ADR-0057 §13.2).
producer() { PERM_CONF="^${EXCHANGE//./\\.}\$"; PERM_WRITE="$PERM_CONF"; PERM_READ='^$'; }
consumer() {
  local q="${1//./\\.}" x="${EXCHANGE//./\\.}"
  PERM_CONF="^(${x}|${x}\\.dlx|${q}|${q}\\.retry|${q}\\.dead)\$"
  PERM_WRITE="^(amq\\.default|${x}\\.dlx|${q}|${q}\\.retry|${q}\\.dead)\$"
  PERM_READ="$PERM_CONF"
}
producer_consumer() {
  local q="${1//./\\.}" x="${EXCHANGE//./\\.}"
  consumer "$1"
  PERM_WRITE="^(amq\\.default|${x}|${x}\\.dlx|${q}|${q}\\.retry|${q}\\.dead)\$"
}
# Every identity defined here. Defining one does NOT provision it: only RABBITMQ_SERVICES (below; the protected workflow's input) selects.
permissions_for() {
  case "$1" in
    # AUTH_EVENTS=off in production (topic-activation.json: inactive): Auth publishes audit evidence only. Activating its domain events is
    # a reviewed change of that file and a regenerated block, provisioned before the flag is flipped (S0-C5 H2).
    auth-service | organization-service | file-service | release-service) producer ;;
    # Payment: producer only (its events and its audit actions); defined for S1-R, provisioned only when that rollout selects it.
    payment-service) producer ;;
    audit-service) consumer audit-service.audit ;;
    # Exactly the intake bindings (apps/notification-service/src/intake/event-map.ts): a new binding needs a new grant.
    notification-service) consumer notification.events ;;
    # Billing: consumes Payment's events on billing.payment-events and publishes invoice.created and its audit actions (one identity).
    billing-service) producer_consumer billing.payment-events ;;
    *) return 1 ;;
  esac
  topic_grants_for "$1" || return 1
}

# BEGIN GENERATED TOPIC GRANTS
# Generated by `node scripts/generate-topic-grants.mjs` from apps/*/contracts/events.json, libs/audit-contract/src/catalog.ts and
# infra/rabbitmq/topic-activation.json (ADR-0057 S0-C5, S1d-1). Never edit by hand: `npm run check:repo` fails on any difference.
# environment: production
# audit-service: write 0, read 1, domain events none, read binding exception audit-all-actions
# auth-service: write 28, read 0, domain events inactive
# billing-service: write 12, read 4, domain events active
# file-service: write 2, read 0, domain events none
# notification-service: write 0, read 9, domain events none
# organization-service: write 7, read 0, domain events none
# payment-service: write 10, read 0, domain events active
# release-service: write 4, read 0, domain events none
topic_grants_for() {
  case "$1" in
    audit-service)
      TOPIC_WRITE='^(?!)$'
      TOPIC_READ='^(audit\.#)$' ;;
    auth-service)
      TOPIC_WRITE='^(audit\.account\.disabled|audit\.account\.enabled|audit\.admin_invitation\.created|audit\.admin_invitation\.revoked|audit\.hierarchy\.reference_anchor_mismatch_detected|audit\.hierarchy\.reference_repair_denied|audit\.hierarchy\.reference_repair_unresolved|audit\.hierarchy\.reference_repaired|audit\.join_code\.created|audit\.join_code\.revoked|audit\.membership\.admin_granted|audit\.membership\.admin_provisioned|audit\.membership\.admin_revoked|audit\.membership\.approved|audit\.membership\.rejected|audit\.membership\.revoked|audit\.operator\.created|audit\.owner\.factor_enrolled|audit\.owner\.factor_removed|audit\.owner\.password_changed|audit\.owner\.recovery_cancelled|audit\.owner\.recovery_completed|audit\.owner\.recovery_started|audit\.owner\.secret_key_rotated|audit\.owner\.webauthn_clone_suspected|audit\.platform_assignment\.granted|audit\.platform_assignment\.revoked|audit\.session\.refresh_reuse_detected)$'
      TOPIC_READ='^(?!)$' ;;
    billing-service)
      TOPIC_WRITE='^(audit\.invoice\.discarded|audit\.invoice\.issued|audit\.invoice\.paid|audit\.payment_request\.cancelled|audit\.payment_request\.created|audit\.price\.created|audit\.price\.retired|audit\.product\.archived|audit\.product\.created|audit\.subscription\.activated|audit\.subscription\.renewed|invoice\.created)$'
      TOPIC_READ='^(payment\.cancelled|payment\.expired|payment\.failed|payment\.succeeded)$' ;;
    file-service)
      TOPIC_WRITE='^(audit\.file\.deleted|audit\.file\.integrity_incident)$'
      TOPIC_READ='^(?!)$' ;;
    notification-service)
      TOPIC_WRITE='^(?!)$'
      TOPIC_READ='^(admin\.operator_code_issued|admin\.operator_confirmation_code_issued|admin\.owner_login_from_new_device|admin\.owner_recovery_completed|admin\.owner_recovery_requested|member\.contact_verification_requested|membership\.approved|membership\.rejected|membership\.revoked)$' ;;
    organization-service)
      TOPIC_WRITE='^(audit\.company\.created|audit\.company\.updated|audit\.hierarchy\.admin_operation_denied|audit\.organization\.created|audit\.organization\.updated|audit\.platform\.created|audit\.platform\.updated)$'
      TOPIC_READ='^(?!)$' ;;
    payment-service)
      TOPIC_WRITE='^(audit\.payment\.cancelled|audit\.payment\.created|audit\.payment\.expired|audit\.payment\.failed|audit\.payment\.succeeded|payment\.cancelled|payment\.created|payment\.expired|payment\.failed|payment\.succeeded)$'
      TOPIC_READ='^(?!)$' ;;
    release-service)
      TOPIC_WRITE='^(audit\.compatibility_policy\.changed|audit\.release\.published|audit\.release\.registered|audit\.release\.withdrawn)$'
      TOPIC_READ='^(?!)$' ;;
    *) return 1 ;;
  esac
}
# END GENERATED TOPIC GRANTS

# ---------------------------------------------------------------- preflight (nothing is changed before this passes)
command -v openssl >/dev/null || die "openssl is required on the server to generate secrets; nothing was changed"
for s in $SERVICES; do
  permissions_for "$s" || die "no broker identity is defined for '$s' (known: auth-service organization-service file-service release-service payment-service billing-service audit-service notification-service); nothing was changed"
done
if docker network inspect "$NET" >/dev/null 2>&1; then
  [ "$(docker network inspect -f '{{.Internal}}' "$NET")" = true ] || die "network '$NET' exists but is not --internal; refusing to place the broker on it; nothing was changed"
fi

mkdir -p "$DIR" "$CLIENTS"; chmod 700 "$DIR" "$CLIENTS"

# ---------------------------------------------------------------- private network
if ! docker network inspect "$NET" >/dev/null 2>&1; then
  log "creating the internal network $NET (no route to or from the outside)"
  docker network create --internal "$NET" >/dev/null
fi

# ---------------------------------------------------------------- broker container
if exists "$BROKER"; then
  [ -f "$ENV_FILE" ] || die "container $BROKER exists but $ENV_FILE is missing; refusing to guess its administrator"
  running_image=$(docker inspect -f '{{.Config.Image}}' "$BROKER")
  [ "$running_image" = "$IMAGE" ] || log "note: $BROKER runs $running_image, not $IMAGE; upgrades are deliberate (runbook), nothing is recreated"
else
  log "creating $BROKER ($IMAGE), volume $VOL, network $NET, no published port"
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  # A non-guest default user means the broker never creates `guest`; this administrator is break-glass only (no service uses it).
  ensure "$ENV_FILE" RABBITMQ_DEFAULT_USER "$ADMIN"
  ensure "$ENV_FILE" RABBITMQ_DEFAULT_PASS "$(openssl rand -hex 32)"
  ensure "$ENV_FILE" RABBITMQ_DEFAULT_VHOST "$VHOST"
  # --hostname is fixed: the node's data directory in the volume is keyed by `rabbit@<hostname>`, so a recreated container with a
  # random hostname would silently start EMPTY next to the old data.
  docker run -d --name "$BROKER" --hostname "$BROKER" --restart unless-stopped --stop-timeout 60 \
    --network "$NET" --env-file "$ENV_FILE" -v "$VOL":/var/lib/rabbitmq \
    --health-cmd 'su-exec rabbitmq rabbitmq-diagnostics -q check_running && su-exec rabbitmq rabbitmq-diagnostics -q check_port_connectivity && su-exec rabbitmq rabbitmq-diagnostics -q check_local_alarms' \
    --health-interval 30s --health-timeout 20s --health-retries 3 --health-start-period 60s \
    --label traefik.enable=false \
    "$IMAGE" >/dev/null
fi
docker start "$BROKER" >/dev/null 2>&1 || true

# ---------------------------------------------------------------- exposure invariants (checked on every run, new or existing)
[ "$(docker inspect -f '{{len .HostConfig.PortBindings}}' "$BROKER")" = 0 ] || die "$BROKER publishes a host port; the broker must stay private"
[ "$(docker inspect -f '{{.HostConfig.PublishAllPorts}}' "$BROKER")" = false ] || die "$BROKER publishes all ports; the broker must stay private"
nets=$(docker inspect -f '{{range $n, $_ := .NetworkSettings.Networks}}{{$n}} {{end}}' "$BROKER")
[ "$nets" = "$NET " ] || die "$BROKER must be attached to $NET only (attached: $nets)"
mounts=$(docker inspect -f '{{range .Mounts}}{{.Name}}={{.Destination}} {{end}}' "$BROKER")
grep -q "$VOL=/var/lib/rabbitmq" <<<"$mounts" || die "$BROKER does not keep /var/lib/rabbitmq on the volume $VOL"

# ---------------------------------------------------------------- readiness (the rabbit app and its AMQP listener, not "running")
log "waiting for $BROKER to be ready"
ready=""
for _ in $(seq 1 60); do
  if diag check_running && diag check_port_connectivity && diag check_local_alarms; then ready=1; break; fi
  [ "$(docker inspect -f '{{.State.Running}}' "$BROKER")" = true ] || break
  sleep 3
done
[ -n "$ready" ] || { docker logs --tail 30 "$BROKER" >&2 || true; die "$BROKER is not ready"; }

# ---------------------------------------------------------------- vhost, no guest
vhosts=$(ctl list_vhosts name --no-table-headers)
grep -qx "$VHOST" <<<"$vhosts" || { log "creating vhost $VHOST"; ctl add_vhost "$VHOST" >/dev/null; }
if has_user guest; then log "deleting the default guest user"; ctl delete_user guest >/dev/null; fi

# ---------------------------------------------------------------- service identities
for s in $SERVICES; do
  permissions_for "$s"
  file="$CLIENTS/$s.env"
  if [ ! -f "$file" ]; then
    has_user "$s" && die "broker user $s exists but $file is missing; refusing to guess or reset its password"
    pass=$(openssl rand -hex 32)
    touch "$file"; chmod 600 "$file"
    printf 'RABBITMQ_URL=amqp://%s:%s@%s:5672/%s\n' "$s" "$pass" "$BROKER" "$VHOST" >"$file"
    log "  + identity $s (new)"
  fi
  pass=$(sed -n 's|^RABBITMQ_URL=amqp://[^:]*:\([^@]*\)@.*$|\1|p' "$file")
  [ -n "$pass" ] || die "$file does not hold a RABBITMQ_URL with a password"
  # The password travels on stdin, never on a command line (a process list or `docker inspect` would show it).
  if has_user "$s"; then
    printf '%s\n' "$pass" | ctl_stdin change_password "$s" >/dev/null
  else
    printf '%s\n' "$pass" | ctl_stdin add_user "$s" >/dev/null
  fi
  ctl set_user_tags "$s" >/dev/null
  ctl set_permissions -p "$VHOST" "$s" "$PERM_CONF" "$PERM_WRITE" "$PERM_READ" >/dev/null
  ctl set_topic_permissions -p "$VHOST" "$s" "$EXCHANGE" "$TOPIC_WRITE" "$TOPIC_READ" >/dev/null
  log "  = $s: configure $PERM_CONF write $PERM_WRITE read $PERM_READ; topic $EXCHANGE write $TOPIC_WRITE read $TOPIC_READ"
done

log "OK  $BROKER is ready on $NET (vhost $VHOST; identities: $SERVICES)"
log "the exchange and the queues are declared by their services: audit-service must be deployed (and ready) before auth-service"
