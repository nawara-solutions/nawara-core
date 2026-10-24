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
