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
#   isolated_consumer (Core V2 OD-BRK-2a, ADR-0057 §8 "OD-BRK-0" D1; notification-service): a consumer whose subscription opted out of
#             broker dead-lettering (`noBrokerDeadLettering`): NO `<exchange>.dlx` (its `.dead` queue is never bound to the shared
#             fanout, its work queue has no broker dead-letter exchange); only its own three queues, the event exchange and the default
#             exchange. Granted ONLY behind the fail-closed gate below: the containment latch (owned by OD-BRK-2b) is inactive, and the
#             effective-topology verifier (infra/rabbitmq/verify-topology.sh, embedded below) passes before AND after the grant.
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
isolated_consumer() {
  local q="${1//./\\.}" x="${EXCHANGE//./\\.}"
  PERM_CONF="^(${x}|${q}|${q}\\.retry|${q}\\.dead)\$"
  PERM_WRITE="^(amq\\.default|${q}|${q}\\.retry|${q}\\.dead)\$"
  PERM_READ="$PERM_CONF"
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
    # OD-BRK-2a: isolated (no shared dead-letter fanout), and granted only behind the topology gate (below).
    notification-service) isolated_consumer notification.events ;;
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
# auth-service: write 31, read 0, domain events inactive
# billing-service: write 12, read 4, domain events active
# file-service: write 4, read 0, domain events none
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
      TOPIC_WRITE='^(audit\.account\.disabled|audit\.account\.enabled|audit\.admin_invitation\.created|audit\.admin_invitation\.revoked|audit\.authorization_receipt\.consumed|audit\.authorization_receipt\.issued|audit\.authorization_receipt\.voided|audit\.hierarchy\.reference_anchor_mismatch_detected|audit\.hierarchy\.reference_repair_denied|audit\.hierarchy\.reference_repair_unresolved|audit\.hierarchy\.reference_repaired|audit\.join_code\.created|audit\.join_code\.revoked|audit\.membership\.admin_granted|audit\.membership\.admin_provisioned|audit\.membership\.admin_revoked|audit\.membership\.approved|audit\.membership\.rejected|audit\.membership\.revoked|audit\.operator\.created|audit\.owner\.factor_enrolled|audit\.owner\.factor_removed|audit\.owner\.password_changed|audit\.owner\.recovery_cancelled|audit\.owner\.recovery_completed|audit\.owner\.recovery_started|audit\.owner\.secret_key_rotated|audit\.owner\.webauthn_clone_suspected|audit\.platform_assignment\.granted|audit\.platform_assignment\.revoked|audit\.session\.refresh_reuse_detected)$'
      TOPIC_READ='^(?!)$' ;;
    billing-service)
      TOPIC_WRITE='^(audit\.invoice\.discarded|audit\.invoice\.issued|audit\.invoice\.paid|audit\.payment_request\.cancelled|audit\.payment_request\.created|audit\.price\.created|audit\.price\.retired|audit\.product\.archived|audit\.product\.created|audit\.subscription\.activated|audit\.subscription\.renewed|invoice\.created)$'
      TOPIC_READ='^(payment\.cancelled|payment\.expired|payment\.failed|payment\.succeeded)$' ;;
    file-service)
      TOPIC_WRITE='^(audit\.file\.deleted|audit\.file\.grant_issued|audit\.file\.grant_revoked|audit\.file\.integrity_incident)$'
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

# BEGIN EMBEDDED TOPOLOGY VERIFIER
# Core V2 OD-BRK-2a: infra/rabbitmq/verify-topology.sh, embedded VERBATIM because the protected workflow streams this script alone to the
# server. Never edit here: `npm run check:repo` fails unless this block equals that file byte for byte.
verify_topology() {
  bash -s -- "$@" <<'NAWARA_TOPOLOGY_VERIFIER'
#!/usr/bin/env bash
# Core V2 OD-BRK-2a (ADR-0057 §8 "OD-BRK-0", D1 to D3): READ-ONLY verification of the broker's EFFECTIVE topology for a consumer that opted
# out of broker dead-lettering (`noBrokerDeadLettering`), run through the protected broker administration (`rabbitmqctl` inside the broker
# container, as infra/rabbitmq/provision.sh does). AMQP cannot see policies, bindings or permissions; this can. It never connects over
# AMQP, never reads a message and never changes the broker.
#   verify-topology.sh notification-service --phase pre-grant|post-grant
# Environment: RABBITMQ_CONTAINER (default nawara-core-rabbitmq); NOTIFICATION_CONTAINMENT_STATE (the OD-BRK-2b containment latch);
# PROPOSED_PERM_CONF / _WRITE / _READ (pre-grant: the role provisioning is about to apply); EXPECTED_TOPIC_WRITE / _READ (the generated
# topic grant).
# Output: ONE JSON line {"verifier","version","service","phase","result","completeness","checks":[{"id","status","reason"}],"at"}.
# result: PASS | FAIL | UNKNOWN (UNKNOWN is never PASS); a check may also be NOT_APPLICABLE_PRE_CREATION (its queue does not exist yet,
# which proves nothing about it: `completeness` is then `pre_creation`). Exit 0 PASS, 1 FAIL, 3 UNKNOWN, 2 usage. Only ids, names and
# closed reason codes are printed: never a credential, a message or a policy definition.
set -uo pipefail

VERSION=1
SERVICE="${1:-}"
[ "${2:-}" = "--phase" ] || { echo '{"verifier":"verify-topology","result":"UNKNOWN","reason":"usage"}'; exit 2; }
PHASE="${3:-}"
case "$PHASE" in pre-grant | post-grant) ;; *) echo '{"verifier":"verify-topology","result":"UNKNOWN","reason":"usage"}'; exit 2 ;; esac
[ "$SERVICE" = "notification-service" ] || { echo '{"verifier":"verify-topology","result":"UNKNOWN","reason":"unsupported_service"}'; exit 2; }

BROKER="${RABBITMQ_CONTAINER:-nawara-core-rabbitmq}"
VHOST=nawara-core
EXCHANGE=nawara.events
ADMIN=nawara-admin
Q=notification.events
QUEUES=("$Q" "$Q.retry" "$Q.dead")
LATCH="${NOTIFICATION_CONTAINMENT_STATE:-/var/lib/nawara-core-topology/notification-service.containment}"
# The approved isolated-consumer role (D1): its own three queues, the event exchange (declare, bind from), the default exchange (the kit's
# retry and dead-letter copies). Never `nawara.events.dlx`.
e() { printf '%s' "${1//./\\.}"; }
ROLE_CONF="^($(e "$EXCHANGE")|$(e "$Q")|$(e "$Q")\\.retry|$(e "$Q")\\.dead)\$"
ROLE_WRITE="^(amq\\.default|$(e "$Q")|$(e "$Q")\\.retry|$(e "$Q")\\.dead)\$"
ROLE_READ="$ROLE_CONF"
DENY_ALL='^(?!)$'
# The kit's declaration of an opted-in subscription (OD-BRK-1): the work and dead queues have NO argument; the retry queue returns its
# expired copies to the work queue through the default exchange. Exactly these, nothing else. Compared TYPED: the arguments of
# `rabbitmqctl list_queues --formatter json` (3.13.7: one record per line, each argument [name, AMQP type, value], sorted by name),
# because the text listing prints an empty longstr as `[]`, the same as an empty list.
declare -A EXPECTED_ARGS=(
  ["$Q"]='[]'
  ["$Q.retry"]="[[\"x-dead-letter-exchange\",\"longstr\",\"\"],[\"x-dead-letter-routing-key\",\"longstr\",\"$Q\"]]"
  ["$Q.dead"]='[]'
)

CHECKS=()
add() { CHECKS+=("{\"id\":\"$1\",\"status\":\"$2\",\"reason\":\"$3\"}"); }
ctl() { timeout 30 docker exec -u rabbitmq "$BROKER" rabbitmqctl -q "$@" 2>/dev/null; }
# PCRE (the broker's own regex flavour) match of $1 against $2: 0 match, 1 no match, 2 the pattern could not be evaluated.
matches() { local r; grep -qP -- "$1" <<<"$2" 2>/dev/null; r=$?; [ $r -le 1 ] && return $r; return 2; }
# A policy row applies to a classic queue when its apply-to covers queues; to an exchange when it covers exchanges.
applies_to_queue() { case "$1" in all | queues | classic_queues) return 0 ;; *) return 1 ;; esac; }
applies_to_exchange() { case "$1" in all | exchanges) return 0 ;; *) return 1 ;; esac; }

# ---------------------------------------------------------------- L1: the containment latch (OD-BRK-2b owns it; absent = NOT verified)
latch() {
  local dir; dir=$(dirname -- "$LATCH")
  if [ -L "$LATCH" ] || [ ! -f "$LATCH" ]; then add L1 UNKNOWN latch_absent_or_not_a_file; return; fi
  if [ "$(stat -c '%u' -- "$LATCH" 2>/dev/null)" != 0 ] || [ "$(stat -c '%u' -- "$dir" 2>/dev/null)" != 0 ]; then add L1 UNKNOWN latch_not_root_owned; return; fi
  # group/other may never write the latch or its directory; a non-root caller (provisioning runs as the deploy user) may not either
  if [ "$(( 0$(stat -c '%a' -- "$LATCH") & 022 ))" -ne 0 ] || [ "$(( 0$(stat -c '%a' -- "$dir") & 022 ))" -ne 0 ] || { [ "$(id -u)" != 0 ] && [ -w "$LATCH" ]; }; then
    add L1 UNKNOWN latch_writable; return
  fi
  local content; content=$(head -c 512 -- "$LATCH" 2>/dev/null) || { add L1 UNKNOWN latch_unreadable; return; }
  case "$content" in
    $'nawara-core-topology-containment v1\nservice=notification-service\nstate=inactive') add L1 PASS latch_inactive ;;
    $'nawara-core-topology-containment v1\nservice=notification-service\nstate=contained') add L1 FAIL latch_contained ;;
    *) add L1 UNKNOWN latch_malformed ;;
  esac
}

# ---------------------------------------------------------------- R1: the role (proposed before the grant, installed after it)
role() {
  [ "${EXPECTED_TOPIC_WRITE:-}" = "$DENY_ALL" ] || { add R1 FAIL topic_write_not_deny_all; return; }
  local tr="${EXPECTED_TOPIC_READ:-}"
  # an anchored alternation of exact, escaped routing keys: no wildcard, no unescaped dot, no empty alternative
  if ! grep -qP '^\^\((?:(?:[a-z0-9_-]|\\\.)+)(?:\|(?:(?:[a-z0-9_-]|\\\.)+))*\)\$$' <<<"$tr"; then add R1 FAIL topic_read_not_exact_keys; return; fi
  if [ "$PHASE" = pre-grant ]; then
    [ "${PROPOSED_PERM_CONF:-}" = "$ROLE_CONF" ] && [ "${PROPOSED_PERM_WRITE:-}" = "$ROLE_WRITE" ] && [ "${PROPOSED_PERM_READ:-}" = "$ROLE_READ" ] \
      && add R1 PASS proposed_role_approved || add R1 FAIL proposed_role_not_approved
  else
    add R1 PASS expected_grant_well_formed
  fi
}

# ---------------------------------------------------------------- U1/U2: identities and permissions
users() {
  local users perms topics tags line u t c w r found=0
  users=$(ctl list_users --no-table-headers) || { add U1 UNKNOWN list_users_failed; add U2 UNKNOWN list_users_failed; return; }
  perms=$(ctl list_permissions -p "$VHOST" --no-table-headers) || { add U1 UNKNOWN list_permissions_failed; add U2 UNKNOWN list_permissions_failed; return; }
  topics=$(ctl list_topic_permissions -p "$VHOST" --no-table-headers) || { add U1 UNKNOWN list_topic_permissions_failed; add U2 UNKNOWN list_topic_permissions_failed; return; }
  # U2: no other administrative identity, and no other identity can read or configure (declare, purge, delete) a Notification queue
  local u2=PASS u2r=no_other_access
  while IFS=$'\t' read -r u t; do
    [ -z "$u" ] && continue
    if [ "$u" = "$ADMIN" ]; then continue; fi
    if [ "$u" != "$SERVICE" ] && [ "$t" != "[]" ]; then u2=FAIL; u2r=unexpected_tagged_user; fi
    [ "$u" = "$SERVICE" ] && tags="$t"
  done <<<"$users"
  while IFS=$'\t' read -r u c w r; do
    [ -z "$u" ] && continue
    [ "$u" = "$ADMIN" ] || [ "$u" = "$SERVICE" ] && continue
    for name in "${QUEUES[@]}"; do
      for pat in "$c" "$r"; do
        matches "$pat" "$name"; case $? in 0) u2=FAIL; u2r=other_identity_reaches_notification_queue ;; 2) [ "$u2" = PASS ] && { u2=UNKNOWN; u2r=pattern_unevaluable; } ;; esac
      done
    done
  done <<<"$perms"
  add U2 "$u2" "$u2r"
  # U1: the service's own identity
  local mine; mine=$(awk -F'\t' -v u="$SERVICE" '$1==u' <<<"$perms")
  local mytopics; mytopics=$(awk -F'\t' -v u="$SERVICE" '$1==u' <<<"$topics")
  local exact_perm exact_topic
  [ "$mine" = "$SERVICE"$'\t'"$ROLE_CONF"$'\t'"$ROLE_WRITE"$'\t'"$ROLE_READ" ] && exact_perm=1 || exact_perm=0
  [ "$mytopics" = "$SERVICE"$'\t'"$EXCHANGE"$'\t'"${EXPECTED_TOPIC_WRITE:-}"$'\t'"${EXPECTED_TOPIC_READ:-}" ] && exact_topic=1 || exact_topic=0
  if [ -n "${tags:-}" ] && [ "$tags" != "[]" ]; then add U1 FAIL service_user_tagged; return; fi
  if [ "$PHASE" = pre-grant ]; then
    if [ -z "$mine" ] && [ -z "$mytopics" ]; then add U1 PASS no_existing_grant
    elif [ $exact_perm = 1 ] && [ $exact_topic = 1 ]; then add U1 PASS existing_grant_exactly_approved
    else add U1 FAIL existing_grant_differs; fi
  else
    if [ $exact_perm = 1 ] && [ $exact_topic = 1 ]; then add U1 PASS installed_grant_exactly_approved
    elif [ -z "$mine" ]; then add U1 FAIL grant_missing
    else add U1 FAIL installed_grant_differs; fi
  fi
}

# ---------------------------------------------------------------- P1-P3: regular and operator policies (any applicable one: FAIL)
policies() {
  local kind id rows v name pattern applyto def prio st rs
  for kind in regular operator; do
    [ $kind = regular ] && id=P1 || id=P2
    if [ $kind = regular ]; then rows=$(ctl list_policies -p "$VHOST" --no-table-headers); else rows=$(ctl list_operator_policies -p "$VHOST" --no-table-headers); fi
    [ $? -eq 0 ] || { add $id UNKNOWN "list_${kind}_policies_failed"; [ $kind = regular ] && add P3 UNKNOWN list_regular_policies_failed; continue; }
    st=PASS; rs=none_applicable
    local ex_st=PASS ex_rs=none_applicable
    while IFS=$'\t' read -r v name pattern applyto def prio; do
      [ -z "$name" ] && continue
      if applies_to_queue "$applyto"; then
        for q in "${QUEUES[@]}"; do
          matches "$pattern" "$q"; case $? in 0) st=FAIL; rs="${kind}_policy_applies" ;; 2) [ $st = PASS ] && { st=UNKNOWN; rs=pattern_unevaluable; } ;; esac
        done
      fi
      if applies_to_exchange "$applyto"; then
        matches "$pattern" "$EXCHANGE"; case $? in 0) ex_st=FAIL; ex_rs="${kind}_policy_applies_to_exchange" ;; 2) [ $ex_st = PASS ] && { ex_st=UNKNOWN; ex_rs=pattern_unevaluable; } ;; esac
      fi
    done <<<"$rows"
    add $id $st $rs
    if [ $kind = regular ]; then P3_REG="$ex_st:$ex_rs"; else P3_OP="$ex_st:$ex_rs"; fi
  done
  local a="${P3_REG:-UNKNOWN:list_regular_policies_failed}" b="${P3_OP:-UNKNOWN:list_operator_policies_failed}"
  if [ "${a%%:*}" = FAIL ] || [ "${b%%:*}" = FAIL ]; then add P3 FAIL "$( [ "${a%%:*}" = FAIL ] && echo "${a#*:}" || echo "${b#*:}")"
  elif [ "${a%%:*}" = UNKNOWN ] || [ "${b%%:*}" = UNKNOWN ]; then add P3 UNKNOWN "$( [ "${a%%:*}" = UNKNOWN ] && echo "${a#*:}" || echo "${b#*:}")"
  else add P3 PASS none_applicable; fi
}

# ---------------------------------------------------------------- X1: the event exchange has no alternate exchange or other argument
exchange() {
  local rows line; rows=$(ctl list_exchanges -p "$VHOST" name type durable internal arguments policy --no-table-headers) || { add X1 UNKNOWN list_exchanges_failed; return; }
  line=$(awk -F'\t' -v x="$EXCHANGE" '$1==x' <<<"$rows")
  if [ -z "$line" ]; then add X1 NOT_APPLICABLE_PRE_CREATION exchange_absent; return; fi
  [ "$line" = "$EXCHANGE"$'\t'topic$'\t'true$'\t'false$'\t''[]'$'\t' ] && add X1 PASS exchange_as_declared || add X1 FAIL exchange_differs
}

# ---------------------------------------------------------------- Q1-Q3, B1, C1: the queues themselves, their bindings and consumers
queues() {
  local rows typed bind cons chans present=0 n
  rows=$(ctl list_queues -p "$VHOST" name durable type arguments policy operator_policy effective_policy_definition --no-table-headers) \
    && typed=$(ctl list_queues -p "$VHOST" name arguments --formatter json) || { for n in Q1 Q2 Q3 B1 C1; do add $n UNKNOWN list_queues_failed; done; QUEUES_PRESENT=unknown; return; }
  local i=0 ids=(Q1 Q2 Q3)
  for q in "${QUEUES[@]}"; do
    local line rec
    line=$(awk -F'\t' -v q="$q" '$1==q' <<<"$rows")
    rec=$(sed 's/^,//' <<<"$typed" | awk -v p="{\"name\":\"$q\"," 'index($0, p) == 1')
    if [ -z "$line" ] && [ -z "$rec" ]; then add "${ids[$i]}" NOT_APPLICABLE_PRE_CREATION queue_absent
    else
      present=$((present + 1))
      # both listings must name the queue exactly once, the text row must have its 7 columns: otherwise nothing is established
      if [ "$(grep -c '' <<<"$line")" != 1 ] || [ "$(grep -c '' <<<"$rec")" != 1 ] || [ -z "$line" ] || [ -z "$rec" ] || [ "$(awk -F'\t' '{print NF}' <<<"$line")" != 7 ]; then
        add "${ids[$i]}" UNKNOWN queue_listing_unparseable
      elif [ "$(cut -f2,3,5- <<<"$line")" = true$'\t'classic$'\t'$'\t'$'\t''[]' ] && [ "$rec" = "{\"name\":\"$q\",\"arguments\":${EXPECTED_ARGS[$q]}}" ]; then
        add "${ids[$i]}" PASS queue_as_declared_no_policy
      else add "${ids[$i]}" FAIL queue_arguments_or_effective_policy_differ; fi
    fi
    i=$((i + 1))
  done
  if [ $present -ne 0 ] && [ $present -ne 3 ]; then add Q0 FAIL partial_topology; fi
  QUEUES_PRESENT=$present
  # B1: the work queue is bound only from the event exchange (exact intake keys within the topic grant) and the default exchange; the
  # retry and dead queues only from the default exchange: in particular never from `nawara.events.dlx`
  local bind_ok=1
  bind=$(ctl list_bindings -p "$VHOST" source_name destination_name destination_kind routing_key --no-table-headers) || { bind_ok=0; add B1 UNKNOWN list_bindings_failed; }
  if [ $bind_ok = 1 ] && [ $present -eq 0 ]; then
    # before creation: nothing may already be bound to these names (a binding needs the queue; any row would mean something odd)
    grep -qP "^[^\t]*\t($(e "$Q")|$(e "$Q")\\.retry|$(e "$Q")\\.dead)\tqueue\t" <<<"$bind" && add B1 FAIL unexpected_binding || add B1 NOT_APPLICABLE_PRE_CREATION queues_absent
  elif [ $bind_ok = 1 ]; then
    local b1=PASS b1r=bindings_as_declared src dst kind key
    while IFS=$'\t' read -r src dst kind key; do
      [ "$kind" = queue ] || continue
      case "$dst" in "$Q" | "$Q.retry" | "$Q.dead") ;; *) continue ;; esac
      if [ -z "$src" ]; then [ "$key" = "$dst" ] || { b1=FAIL; b1r=unexpected_default_binding; }; continue; fi
      if [ "$dst" = "$Q" ] && [ "$src" = "$EXCHANGE" ] && [[ "$key" != *[\*\#]* ]]; then
        matches "${EXPECTED_TOPIC_READ:-^(?!)$}" "$key"; case $? in 0) ;; 1) b1=FAIL; b1r=binding_outside_topic_grant ;; 2) b1=UNKNOWN; b1r=pattern_unevaluable ;; esac
        continue
      fi
      b1=FAIL; b1r=unexpected_binding
    done <<<"$bind"
    add B1 "$b1" "$b1r"
  fi
  # C1: consumers of these queues belong only to the service's own connections (before the grant: none at all)
  cons=$(ctl list_consumers -p "$VHOST" queue_name channel_pid --no-table-headers) && chans=$(ctl list_channels pid user --no-table-headers) || { add C1 UNKNOWN list_consumers_failed; return; }
  local c1=PASS c1r=consumers_ok qn pid user
  while IFS=$'\t' read -r qn pid; do
    case "$qn" in "$Q" | "$Q.retry" | "$Q.dead") ;; *) continue ;; esac
    user=$(awk -F'\t' -v p="$pid" '$1==p {print $2}' <<<"$chans")
    if [ "$PHASE" = pre-grant ]; then c1=FAIL; c1r=consumer_before_grant
    elif [ "$user" != "$SERVICE" ]; then c1=FAIL; c1r=foreign_consumer; fi
  done <<<"$cons"
  add C1 "$c1" "$c1r"
}

# ---------------------------------------------------------------- A1/A2: no copying plugin or parameter (shovel, federation, management)
alternates() {
  local plugins params
  plugins=$(timeout 30 docker exec -u rabbitmq "$BROKER" rabbitmq-plugins list -e -m -q 2>/dev/null) || { add A1 UNKNOWN list_plugins_failed; plugins=__failed__; }
  if [ "$plugins" != __failed__ ]; then
    # federation is enabled implicitly by the pinned image and is inert without upstreams (A2); shovel and the management UI are never approved
    grep -qxE 'rabbitmq_shovel|rabbitmq_shovel_management|rabbitmq_management|rabbitmq_federation_management' <<<"$plugins" && add A1 FAIL copying_or_management_plugin_enabled || add A1 PASS no_copying_plugin
  fi
  params=$(ctl list_parameters -p "$VHOST" --no-table-headers) || { add A2 UNKNOWN list_parameters_failed; return; }
  grep -qE '^(shovel|federation-upstream|federation-upstream-set)'$'\t' <<<"$params" && add A2 FAIL shovel_or_federation_parameter || add A2 PASS no_copying_parameter
}

# ---------------------------------------------------------------- run
if ! timeout 30 docker exec -u rabbitmq "$BROKER" rabbitmq-diagnostics -q check_running >/dev/null 2>&1; then
  add B0 UNKNOWN broker_not_reachable
else
  latch; role; users; policies; exchange; queues; alternates
fi

result=PASS; completeness=full
for c in "${CHECKS[@]}"; do
  case "$c" in *'"status":"FAIL"'*) result=FAIL ;; esac
done
if [ $result = PASS ]; then for c in "${CHECKS[@]}"; do case "$c" in *'"status":"UNKNOWN"'*) result=UNKNOWN ;; esac; done; fi
for c in "${CHECKS[@]}"; do case "$c" in *NOT_APPLICABLE_PRE_CREATION*) completeness=pre_creation ;; esac; done
[ ${#CHECKS[@]} -gt 0 ] || result=UNKNOWN
printf '{"verifier":"verify-topology","version":%s,"service":"%s","phase":"%s","result":"%s","completeness":"%s","checks":[%s],"at":"%s"}\n' \
  "$VERSION" "$SERVICE" "$PHASE" "$result" "$completeness" "$(IFS=,; echo "${CHECKS[*]}")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
case $result in PASS) exit 0 ;; FAIL) exit 1 ;; *) exit 3 ;; esac
NAWARA_TOPOLOGY_VERIFIER
}
# END EMBEDDED TOPOLOGY VERIFIER

# Core V2 OD-BRK-2a: the first-activation gate of notification-service. Fail closed: the grant happens only when the containment latch is
# inactive and the effective topology passes; a grant this run made is withdrawn (permissions cleared, connections closed) when the
# post-grant verification does not pass. An existing grant that differs from the approved role is never changed here (it may be a live
# consumer): the run stops and reports instead.
notification_verify() {
  local out rc=0
  out=$(RABBITMQ_CONTAINER="$BROKER" PROPOSED_PERM_CONF="$PERM_CONF" PROPOSED_PERM_WRITE="$PERM_WRITE" PROPOSED_PERM_READ="$PERM_READ" \
    EXPECTED_TOPIC_WRITE="$TOPIC_WRITE" EXPECTED_TOPIC_READ="$TOPIC_READ" verify_topology notification-service --phase "$1") || rc=$?
  log "  topology $1 notification-service: $out"
  NOTIFICATION_TOPOLOGY="$out"
  return $rc
}

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
  had_grant=0
  if [ "$s" = notification-service ]; then
    perms_now=$(ctl list_user_permissions "$s" --no-table-headers 2>/dev/null || true)
    grep -q "^$VHOST"$'\t' <<<"$perms_now" && had_grant=1
    notification_verify pre-grant || die "notification-service NOT provisioned: the pre-grant topology verification did not pass (containment latch, policies, existing grants or topology; see the line above); nothing was granted"
  fi
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
  if [ "$s" = notification-service ]; then
    if ! notification_verify post-grant; then
      if [ "$had_grant" = 0 ]; then
        ctl clear_permissions -p "$VHOST" "$s" >/dev/null || true
        ctl clear_topic_permissions -p "$VHOST" "$s" >/dev/null || true
        ctl close_all_user_connections "$s" "post-grant topology verification did not pass" >/dev/null || true
        die "notification-service NOT provisioned: the post-grant topology verification did not pass; the grant made by this run was withdrawn"
      fi
      die "notification-service: the post-grant topology verification did not pass on an EXISTING grant; nothing was changed (a live consumer needs a separately authorized action)"
    fi
    case "$NOTIFICATION_TOPOLOGY" in
      *'"completeness":"pre_creation"'*) log "  ! notification-service: granted, but its queues do not exist yet: the live topology is NOT certified; consumption is NOT authorized until a post-declaration verification passes (OD-BRK-2b / S1-R)" ;;
      *) log "  ! notification-service: topology verified on the live queues; production activation still requires OD-BRK-2b (scheduled verification and containment) and S1-R" ;;
    esac
  fi
done

log "OK  $BROKER is ready on $NET (vhost $VHOST; identities: $SERVICES)"
log "the exchange and the queues are declared by their services: audit-service must be deployed (and ready) before auth-service"
