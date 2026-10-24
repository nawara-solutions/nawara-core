#!/usr/bin/env bash
# Core V2 OD-BRK-2b-1 (ADR-0057 §8 "OD-BRK-0" D2): the protected, scheduled verification of Notification's EFFECTIVE RabbitMQ topology,
# and its emergency containment (docs/runbooks/rabbitmq-topology-containment.md). Installed root-owned in INSTALL_DIR next to a pinned
# copy of infra/rabbitmq/verify-topology.sh, and started ONLY by nawara-core-topology-monitor.service (its timer, every 5 minutes, or a
# protected trigger: topology-trigger.sh). Never installed, enabled or started by repository tooling (OD-BRK-2b-2 installs it).
#
#   verify-and-contain.sh notification-service
#
# One run, serialized by a lock:
#   - CONTAINED already (the durable state or the containment latch says so): it re-applies and re-confirms the containment. It never
#     restores anything: a PASS never clears the latch, and only the Owner-authorized recovery (recover-notification-topology.sh) does.
#   - otherwise it runs the pinned verifier (pre-grant while the service holds no grant, post-grant once it does):
#       PASS     the consecutive UNKNOWN counter is reset (the latch is never touched);
#       FAIL     immediate containment (a definitive FAIL always wins over UNKNOWN);
#       UNKNOWN  #1 recorded and alerted, #2 escalated, #3 containment.
#   - a state file that is missing, corrupt, a symbolic link or weakly permissioned AFTER installation is never trusted or re-initialized:
#     it is set aside and the service is contained (fail closed).
# Containment: (1) the intent is persisted (state contained=1, then the latch `state=contained`) BEFORE any broker change; (2) the
# service's resource and topic permissions are cleared in every vhost that lists them; (3) all its connections are closed (unacked
# deliveries return to their queues; nothing is purged, deleted or re-created); (4) two read-backs, CONFIRM_INTERVAL apart, must both
# show no grant, no topic grant, no connection and the latch contained. Only then is the result CONTAINED; otherwise, after at most
# MAX_ATTEMPTS bounded attempts, CONTAINMENT_UNCONFIRMED. Command exit statuses are never taken as proof.
#
# Evidence: one bounded JSON line per run in STATE_DIR/evidence.jsonl, alerts in STATE_DIR/alerts.jsonl (a spool: delivery is a pending
# dependency, and containment never depends on it), and a summary line in the journal. Only closed codes, counters, timestamps and
# verifier check ids: never a message, a code, a credential, a policy definition or a broker address.
#
# It takes no input beyond the one fixed argument, runs nothing a client sends, uses no environment value except its own pins, and runs
# the verifier with `env -i`. Exit: 0 PASS; 10 UNKNOWN recorded (not contained); 20 CONTAINED (newly, or maintained); 21
# CONTAINMENT_UNCONFIRMED; 64 a client command or a wrong argument (refused, nothing done); 65 unsafe installation or not root; 66 the
# installed verifier does not match its pin; 69 a required tool is missing; 75 the lock could not be taken in time; 78 not installed.
set -euo pipefail
umask 077
export LC_ALL=C

# Pinned values. Changed only by a reviewed commit; scripts/check-repo.mjs compares them with the repository (checkTopologyMonitor).
readonly SERVICE='notification-service'
readonly VHOST='nawara-core'
readonly INSTALL_DIR='/usr/local/libexec/nawara-core-topology'
readonly STATE_DIR='/var/lib/nawara-core-topology-monitor'
readonly LATCH='/var/lib/nawara-core-topology/notification-service.containment'
readonly BROKER='nawara-core-rabbitmq'
readonly SAFE_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
readonly OWNER_UID=0
readonly RUN_AS_UID=0
readonly VERIFIER_SHA256='b3bcc7f2f69f9bcf7ef2ee5a8877714169dcdc364d42c893b85f6f1e49548c9f'
readonly ROLE_CONF='^(nawara\.events|notification\.events|notification\.events\.retry|notification\.events\.dead)$'
readonly ROLE_WRITE='^(amq\.default|notification\.events|notification\.events\.retry|notification\.events\.dead)$'
readonly TOPIC_WRITE='^(?!)$'
readonly TOPIC_READ='^(admin\.operator_code_issued|admin\.operator_confirmation_code_issued|admin\.owner_login_from_new_device|admin\.owner_recovery_completed|admin\.owner_recovery_requested|member\.contact_verification_requested|membership\.approved|membership\.rejected|membership\.revoked)$'
readonly CONFIRM_INTERVAL=5
readonly MAX_ATTEMPTS=3
readonly CTL_TIMEOUT=30
readonly VERIFY_TIMEOUT=150
readonly LOCK_WAIT=60
readonly WATCHDOG_MAX_AGE=1200
readonly REMINDER_SECONDS=3600
readonly RECORD_MAX_LINES=2000
readonly LATCH_INACTIVE=$'nawara-core-topology-containment v1\nservice=notification-service\nstate=inactive'
readonly LATCH_CONTAINED=$'nawara-core-topology-containment v1\nservice=notification-service\nstate=contained'
readonly STATE_RE=$'^nawara-core-topology-monitor-state v1\nservice=notification-service\ncontained=([01])\nunknown_streak=([0-9]{1,3})\nlast_result=(NONE|PASS|FAIL|UNKNOWN)\nlast_run=([0-9]{1,12})$'
readonly MARKER_RE='^nawara-core-topology-monitor installed v1 at=[0-9]{1,12}$'
PATH=$SAFE_PATH
export PATH

log() { printf '[topology-monitor] %s\n' "$*"; }
refuse() { local code=$1; shift; printf '[topology-monitor] REFUSED: %s\n' "$*" >&2; exit "$code"; }

# ---------------------------------------------------------------- 1. the invocation: exactly the one fixed target, nothing from a client
[ -z "${SSH_ORIGINAL_COMMAND:-}" ] || refuse 64 "a client command was sent; it is never run (only the systemd unit starts this script)"
[ "$#" -eq 1 ] && [ "$1" = "$SERVICE" ] || refuse 64 "usage: verify-and-contain.sh $SERVICE (the only supported target); nothing was done"
[ "$EUID" -eq "$RUN_AS_UID" ] || refuse 65 "runs as root only (the broker's administration and the root-owned latch); nothing was done"
for c in bash docker flock timeout sha256sum stat readlink dirname mktemp mv sync date head tail grep awk sed sort paste cut tr wc sleep; do
  command -v "$c" >/dev/null 2>&1 || refuse 69 "$c is required; nothing was done"
done

# ---------------------------------------------------------------- 2. the installation: this script and the pinned verifier, root-owned
safe_node() { # safe_node <path> <d|f> <octal mask>: exists as that kind, no symbolic link, owned by OWNER_UID, (mode & mask) == 0
  local p=$1 kind=$2 mask=$3 owner mode
  [ ! -L "$p" ] || return 1
  if [ "$kind" = d ]; then [ -d "$p" ] || return 1; else [ -f "$p" ] || return 1; fi
  owner=$(stat -c %u -- "$p") && mode=$(stat -c %a -- "$p") || return 1
  [ "$owner" = "$OWNER_UID" ] && (( (8#$mode & 8#$mask) == 0 ))
}
SELF=$(readlink -f -- "${BASH_SOURCE[0]}")
[ "$(readlink -f -- "$INSTALL_DIR")" = "$INSTALL_DIR" ] || refuse 65 "$INSTALL_DIR must be a real directory path (no symbolic link); nothing was done"
[ "$(dirname -- "$SELF")" = "$INSTALL_DIR" ] || refuse 65 "this script must run from $INSTALL_DIR; nothing was done"
safe_node "$INSTALL_DIR" d 022 || refuse 65 "$INSTALL_DIR must be owned by uid $OWNER_UID and not writable by group or others; nothing was done"
safe_node "$SELF" f 022 || refuse 65 "$SELF must be owned by uid $OWNER_UID and not writable by group or others; nothing was done"
VERIFIER="$INSTALL_DIR/verify-topology.sh"
safe_node "$VERIFIER" f 022 || refuse 65 "$VERIFIER must be a regular file owned by uid $OWNER_UID, not writable by group or others; nothing was done"
got=$(sha256sum -- "$VERIFIER"); got=${got%% *}
[ "$got" = "$VERIFIER_SHA256" ] || refuse 66 "the installed verifier does not match the pinned SHA-256 $VERIFIER_SHA256; nothing was done"

# ---------------------------------------------------------------- 3. the state directory, the lock, the running marker
[ -e "$STATE_DIR" ] || [ -L "$STATE_DIR" ] || refuse 78 "$STATE_DIR does not exist: the control is not installed (OD-BRK-2b-2); nothing was done"
safe_node "$STATE_DIR" d 077 || refuse 65 "$STATE_DIR must be a directory owned by uid $OWNER_UID with no group or other access; nothing was done"
LOCK="$STATE_DIR/lock"
[ ! -L "$LOCK" ] || refuse 65 "$LOCK is a symbolic link; nothing was done"
exec 9>>"$LOCK"
flock -w "$LOCK_WAIT" 9 || refuse 75 "another run held the lock for more than ${LOCK_WAIT}s; nothing was done"

now() { date +%s; }
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
write_atomic() { # write_atomic <path> <content> <mode>: a temporary file in the same directory, flushed, then renamed over the path
  local tmp
  tmp=$(mktemp -- "$(dirname -- "$1")/.tmp.XXXXXXXX") || return 1
  if printf '%s' "$2" >"$tmp" && chmod "$3" -- "$tmp" && sync -- "$tmp" && mv -f -- "$tmp" "$1"; then return 0; fi
  rm -f -- "$tmp"
  return 1
}
RUNNING="$STATE_DIR/running"
[ ! -L "$RUNNING" ] || rm -f -- "$RUNNING"
write_atomic "$RUNNING" "started=$(now) pid=$$" 600 || refuse 65 "the running marker cannot be written; nothing was done"
trap 'rm -f -- "$RUNNING"' EXIT

ctl() { timeout "$CTL_TIMEOUT" docker exec -u rabbitmq "$BROKER" rabbitmqctl -q "$@" 2>/dev/null; }
blank() { [ -z "$(tr -d '[:space:]' <<<"$1")" ]; }

# ---------------------------------------------------------------- 4. the durable state (never initialized here: the installer writes it)
ST_CONTAINED=0; ST_STREAK=0; ST_LAST=NONE; STATE_PROBLEM=''
STATE="$STATE_DIR/state"
read_state() {
  local text
  if [ ! -e "$STATE_DIR/installed" ] || [ -L "$STATE_DIR/installed" ] || ! safe_node "$STATE_DIR/installed" f 077 \
    || ! [[ $(head -c 256 -- "$STATE_DIR/installed") =~ $MARKER_RE ]]; then STATE_PROBLEM=marker_invalid; return 1; fi
  if [ -L "$STATE" ]; then STATE_PROBLEM=state_symlink; return 1; fi
  [ -e "$STATE" ] || { STATE_PROBLEM=state_missing; return 1; }
  safe_node "$STATE" f 077 || { STATE_PROBLEM=state_unsafe; return 1; }
  text=$(head -c 4096 -- "$STATE") || { STATE_PROBLEM=state_unreadable; return 1; }
  [[ $text =~ $STATE_RE ]] || { STATE_PROBLEM=state_corrupt; return 1; }
  ST_CONTAINED=${BASH_REMATCH[1]}; ST_STREAK=$((10#${BASH_REMATCH[2]})); ST_LAST=${BASH_REMATCH[3]}
}
save_state() {
  write_atomic "$STATE" "$(printf 'nawara-core-topology-monitor-state v1\nservice=%s\ncontained=%s\nunknown_streak=%s\nlast_result=%s\nlast_run=%s\n' \
    "$SERVICE" "$ST_CONTAINED" "$ST_STREAK" "$1" "$(now)")" 600
}

# ---------------------------------------------------------------- 5. the containment latch (the OD-BRK-2a contract, read by provisioning)
latch_status() {
  local dir; dir=$(dirname -- "$LATCH")
  if [ -L "$LATCH" ] || [ -L "$dir" ]; then echo unsafe; return; fi
  [ -e "$LATCH" ] || { echo absent; return; }
  safe_node "$dir" d 022 && safe_node "$LATCH" f 022 || { echo unsafe; return; }
  case "$(head -c 512 -- "$LATCH" 2>/dev/null)" in
    "$LATCH_INACTIVE") echo inactive ;;
    "$LATCH_CONTAINED") echo contained ;;
    *) echo malformed ;;
  esac
}
persist_latch() {
  local dir; dir=$(dirname -- "$LATCH")
  [ ! -L "$dir" ] || return 1
  [ -d "$dir" ] || mkdir -m 755 -- "$dir" || return 1
  safe_node "$dir" d 022 || return 1
  [ ! -L "$LATCH" ] || rm -f -- "$LATCH"
  write_atomic "$LATCH" "$LATCH_CONTAINED" 644 || return 1
  [ "$(latch_status)" = contained ]
}

# ---------------------------------------------------------------- 6. records (bounded; never required for containment)
bound() {
  local f=$1 n
  n=$(wc -l <"$f") || return 0
  if [ "$n" -gt "$RECORD_MAX_LINES" ]; then write_atomic "$f" "$(tail -n $((RECORD_MAX_LINES / 2)) -- "$f")"$'\n' 600 || true; fi
}
append() { # append <file> <json line>
  local f="$STATE_DIR/$1"
  [ ! -L "$f" ] && { [ ! -e "$f" ] || [ -f "$f" ]; } || return 1
  printf '%s\n' "$2" >>"$f" 2>/dev/null || return 1
  bound "$f"
}
alert() { # alert <severity> <kind>: queued for the (pending) carrier; a spool failure is logged and never blocks anything
  append alerts.jsonl "{\"v\":1,\"at\":\"$(iso)\",\"at_epoch\":$(now),\"service\":\"$SERVICE\",\"severity\":\"$1\",\"kind\":\"$2\",\"unknown_streak\":$ST_STREAK,\"containment\":\"$CONTAINMENT\"}" \
    || log "alert spool unavailable (kind=$2); containment never depends on it"
  log "ALERT severity=$1 kind=$2"
}
last_alert_age() { # seconds since the last alert of a kind (a large number when none)
  local line at
  line=$( { grep -F "\"kind\":\"$1\"" -- "$STATE_DIR/alerts.jsonl" 2>/dev/null || true; } | tail -n 1)
  at=$(sed -nE 's/.*"at_epoch":([0-9]+).*/\1/p' <<<"$line")
  [ -n "$at" ] && echo $(( $(now) - at )) || echo 999999999
}
watchdog_status() { # the independent watchdog's last check-in (mutual monitoring: each one notices the other going quiet)
  local f="$STATE_DIR/watchdog" text at
  [ -e "$f" ] || { echo absent; return; }
  safe_node "$f" f 077 || { echo invalid; return; }
  text=$(head -c 512 -- "$f" 2>/dev/null) || { echo invalid; return; }
  at=$(sed -nE 's/^last_run=([0-9]{1,12})$/\1/p' <<<"$text")
  [ -n "$at" ] || { echo invalid; return; }
  [ $(( $(now) - at )) -le "$WATCHDOG_MAX_AGE" ] && echo ok || echo stale
}

# ---------------------------------------------------------------- 7. verification (the pinned OD-BRK-2a verifier, as provisioning runs it)
V_RESULT=UNKNOWN; V_REASON=''; V_IDS=''; V_PHASE=none
verify() {
  local users perms topics out line rc=0 re
  users=$(ctl list_users --no-table-headers) || { V_REASON=broker_listing_failed; return; }
  V_PHASE=pre-grant
  if awk -F'\t' -v u="$SERVICE" '$1 == u { f = 1 } END { exit !f }' <<<"$users"; then
    perms=$(ctl list_user_permissions "$SERVICE" --no-table-headers) && topics=$(ctl list_user_topic_permissions "$SERVICE" --no-table-headers) \
      || { V_REASON=broker_listing_failed; V_PHASE=none; return; }
    blank "$perms$topics" || V_PHASE=post-grant
  fi
  out=$(env -i PATH="$SAFE_PATH" LC_ALL=C RABBITMQ_CONTAINER="$BROKER" NOTIFICATION_CONTAINMENT_STATE="$LATCH" \
    PROPOSED_PERM_CONF="$ROLE_CONF" PROPOSED_PERM_WRITE="$ROLE_WRITE" PROPOSED_PERM_READ="$ROLE_CONF" \
    EXPECTED_TOPIC_WRITE="$TOPIC_WRITE" EXPECTED_TOPIC_READ="$TOPIC_READ" \
    timeout "$VERIFY_TIMEOUT" bash --noprofile --norc -- "$VERIFIER" "$SERVICE" --phase "$V_PHASE" 2>/dev/null) || rc=$?
  line=$(tail -n 1 <<<"$out")
  re="^\\{\"verifier\":\"verify-topology\",\"version\":1,\"service\":\"$SERVICE\",\"phase\":\"$V_PHASE\",\"result\":\"(PASS|FAIL|UNKNOWN)\",\"completeness\":\"(full|pre_creation)\",\"checks\":\\["
  if [[ $line =~ $re ]]; then
    case "${BASH_REMATCH[1]}:$rc" in
      PASS:0) V_RESULT=PASS; V_REASON=verified ;;
      FAIL:1) V_RESULT=FAIL; V_REASON=verifier_fail ;;
      UNKNOWN:3) V_RESULT=UNKNOWN; V_REASON=verifier_unknown ;;
      *) V_RESULT=UNKNOWN; V_REASON=verifier_inconsistent ;;
    esac
  else
    V_RESULT=UNKNOWN; V_REASON=verifier_output_invalid
  fi
  V_IDS=$( { grep -oE '"id":"[A-Z][0-9]","status":"(FAIL|UNKNOWN)"' <<<"$line" || true; } | cut -d'"' -f4 | sort -u | paste -sd, -)
}

# ---------------------------------------------------------------- 8. containment (persist, revoke, close, confirm twice)
CONTAINMENT=none
user_present() { awk -F'\t' -v u="$SERVICE" '$1 == u { f = 1 } END { exit !f }' <<<"$1"; }
revoke() {
  local perms topics v
  perms=$(ctl list_user_permissions "$SERVICE" --no-table-headers || true)
  topics=$(ctl list_user_topic_permissions "$SERVICE" --no-table-headers || true)
  for v in $( { cut -f1 <<<"$perms"; cut -f1 <<<"$topics"; echo "$VHOST"; } | { grep -E '^[A-Za-z0-9._/-]{1,64}$' || true; } | sort -u); do
    ctl clear_permissions -p "$v" "$SERVICE" >/dev/null || true
    ctl clear_topic_permissions -p "$v" "$SERVICE" >/dev/null || true
  done
}
confirm() { # one read-back: no grant, no topic grant, no connection of the service, and the latch persisted as contained
  local users perms topics conns
  users=$(ctl list_users --no-table-headers) || return 1
  if user_present "$users"; then
    perms=$(ctl list_user_permissions "$SERVICE" --no-table-headers) || return 1
    topics=$(ctl list_user_topic_permissions "$SERVICE" --no-table-headers) || return 1
    blank "$perms$topics" || return 1
  fi
  conns=$(ctl list_connections user --no-table-headers) || return 1
  ! grep -qxF -- "$SERVICE" <<<"$conns" || return 1
  [ "$(latch_status)" = contained ]
}
contain() { # contain <reason>
  local attempt=0
  ST_CONTAINED=1
  save_state "${LAST_RESULT:-NONE}" || log "the containment intent could not be written to the state file (the latch still records it)"
  persist_latch || log "the containment latch could not be persisted (containment cannot be confirmed)"
  CONTAINMENT=unconfirmed
  while [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    revoke
    timeout "$CTL_TIMEOUT" docker exec -u rabbitmq "$BROKER" rabbitmqctl -q close_all_user_connections "$SERVICE" "nawara-core topology containment" >/dev/null 2>&1 || true
    if confirm; then
      sleep "$CONFIRM_INTERVAL"
      if confirm; then CONTAINMENT=confirmed; break; fi
    fi
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then sleep "$CONFIRM_INTERVAL"; fi
  done
  REASON=$1
  ATTEMPTS=$attempt
}

# ---------------------------------------------------------------- 9. the run
LAST_RESULT=NONE; REASON=''; ATTEMPTS=0; MODE=monitor; NEW_CONTAINMENT=0
if ! read_state; then
  # Installed (STATE_DIR exists) but the state cannot be trusted: never re-initialized, set aside for the record, and contained.
  if [ -e "$STATE" ] || [ -L "$STATE" ]; then mv -f -- "$STATE" "$STATE_DIR/state.rejected" 2>/dev/null || rm -f -- "$STATE"; fi
  ST_CONTAINED=0; ST_STREAK=0; MODE=integrity; NEW_CONTAINMENT=1
  contain "$STATE_PROBLEM"
else
  LATCH_NOW=$(latch_status)
  if [ "$ST_CONTAINED" = 1 ] || [ "$LATCH_NOW" = contained ]; then
    MODE=contained
    LAST_RESULT=$ST_LAST
    reason=containment_maintained
    if [ "$ST_CONTAINED" = 1 ] && [ "$LATCH_NOW" != contained ]; then reason=latch_not_contained; fi
    if [ "$ST_CONTAINED" = 0 ]; then reason=latch_contained; fi
    contain "$reason"
  else
    verify
    LAST_RESULT=$V_RESULT
    case "$V_RESULT" in
      PASS)
        previous=$ST_STREAK; ST_STREAK=0
        save_state PASS || log "the state file could not be written"
        REASON=$V_REASON
        if [ "$previous" -gt 0 ]; then alert info unknown_cleared; fi ;;
      FAIL)
        NEW_CONTAINMENT=1
        contain verifier_fail ;;
      *)
        ST_STREAK=$((ST_STREAK + 1)); if [ "$ST_STREAK" -gt 999 ]; then ST_STREAK=999; fi
        if [ "$ST_STREAK" -ge 3 ]; then
          NEW_CONTAINMENT=1
          contain "unknown_${ST_STREAK}"
        else
          save_state UNKNOWN || log "the state file could not be written"
          REASON=$V_REASON
          if [ "$ST_STREAK" -eq 1 ]; then alert warning unknown_first; else alert critical unknown_escalated; fi
        fi ;;
    esac
  fi
fi

if [ "$ST_CONTAINED" = 1 ]; then
  save_state "$LAST_RESULT" || log "the state file could not be written"
  if [ "$CONTAINMENT" = confirmed ]; then
    if [ "$NEW_CONTAINMENT" = 1 ]; then alert critical contained; fi
    if [ "$REASON" = latch_not_contained ]; then alert critical latch_restored_by_monitor; fi
  else
    alert critical containment_unconfirmed
  fi
fi
WD=$(watchdog_status)
if [ "$WD" != ok ] && [ "$(last_alert_age watchdog_quiet)" -gt "$REMINDER_SECONDS" ]; then alert warning watchdog_quiet; fi

append evidence.jsonl "{\"v\":1,\"at\":\"$(iso)\",\"at_epoch\":$(now),\"service\":\"$SERVICE\",\"mode\":\"$MODE\",\"phase\":\"$V_PHASE\",\"result\":\"$LAST_RESULT\",\"reason\":\"$REASON\",\"checks\":\"$V_IDS\",\"unknown_streak\":$ST_STREAK,\"containment\":\"$CONTAINMENT\",\"attempts\":$ATTEMPTS,\"watchdog\":\"$WD\"}" \
  || log "evidence record unavailable"
log "service=$SERVICE mode=$MODE phase=$V_PHASE result=$LAST_RESULT reason=$REASON checks=${V_IDS:-none} unknown_streak=$ST_STREAK containment=$CONTAINMENT attempts=$ATTEMPTS watchdog=$WD"

if [ "$ST_CONTAINED" = 1 ]; then
  if [ "$CONTAINMENT" = confirmed ]; then log "CONTAINED"; exit 20; fi
  log "CONTAINMENT_UNCONFIRMED"
  exit 21
fi
if [ "$LAST_RESULT" = PASS ]; then exit 0; fi
exit 10
