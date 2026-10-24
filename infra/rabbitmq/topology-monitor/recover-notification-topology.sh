#!/usr/bin/env bash
# Core V2 OD-BRK-2b-1: the guard of the Owner-authorized RECOVERY of Notification's containment (docs/runbooks/rabbitmq-topology-
# containment.md §5). CONTRACT ONLY in this slice: installed root-owned in INSTALL_DIR by the separately authorized installation, and run
# by the Owner, as root, at an interactive console, under an explicit recovery authorization. Never run by a timer, a key or a workflow.
#
#   recover-notification-topology.sh <authorization-reference>
#
# It clears the containment latch, and only the latch, when ALL of the following hold, and changes nothing otherwise:
#   - it runs as root on a terminal (no forced-command or scheduled session), under the monitor's own lock (no run in between);
#   - the installation and the pinned verifier are intact, and the monitor's state is valid and says contained;
#   - the containment holds: no grant, no topic grant and no connection of the service (two read-backs);
#   - a FRESH verification (the pinned OD-BRK-2a verifier, pre-grant) finds exactly one non-passing check: L1 latch_contained;
#   - the operator types the exact confirmation, naming the service and the authorization reference.
# Then: latch `state=inactive`, verified again in full (PASS, or the latch is put back to contained and it fails), and the monitor's
# state reset (contained=0, no UNKNOWN). It NEVER grants: the service is granted again only through protected provisioning, whose own
# pre-grant and post-grant gates run again. No replay, no queue deletion, no data change.
#
# The authorization reference is recorded in the evidence, not verified cryptographically here: how the Owner's recovery authorization
# is issued and checked is a separate decision (runbook §5).
#
# Exit: 0 the latch was cleared (Notification still holds no grant); 1 refused after the checks (nothing changed, or the latch was put
# back); 2 an invalid invocation, not root, no terminal, or a tool missing (nothing was checked); 65 the installation is unsafe; 66 the
# verifier does not match its pin; 75 the monitor's lock could not be taken.
set -euo pipefail
umask 077
export LC_ALL=C

# Pinned values (scripts/check-repo.mjs, checkTopologyMonitor; equal to verify-and-contain.sh).
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
readonly CTL_TIMEOUT=30
readonly VERIFY_TIMEOUT=150
readonly LOCK_WAIT=60
readonly LATCH_INACTIVE=$'nawara-core-topology-containment v1\nservice=notification-service\nstate=inactive'
readonly LATCH_CONTAINED=$'nawara-core-topology-containment v1\nservice=notification-service\nstate=contained'
readonly STATE_RE=$'^nawara-core-topology-monitor-state v1\nservice=notification-service\ncontained=([01])\nunknown_streak=([0-9]{1,3})\nlast_result=(NONE|PASS|FAIL|UNKNOWN)\nlast_run=([0-9]{1,12})$'
PATH=$SAFE_PATH
export PATH

usage() { printf '[topology-recovery] REFUSED: %s\nusage: recover-notification-topology.sh <authorization-reference>\n' "$*" >&2; exit 2; }
stop() { printf '[topology-recovery] REFUSED: %s; nothing was changed\n' "$*" >&2; exit 1; }
log() { printf '[topology-recovery] %s\n' "$*"; }

[ -z "${SSH_ORIGINAL_COMMAND:-}" ] || usage "never run through a forced command"
[ "$#" -eq 1 ] || usage "exactly one argument is required"
REF=$1
[[ $REF =~ ^[A-Z][A-Z0-9-]{2,63}$ ]] || usage "the authorization reference must be 3 to 64 characters [A-Z0-9-], starting with a letter"
[ "$EUID" -eq "$RUN_AS_UID" ] || usage "run as root at the console"
[ -t 0 ] && [ -t 1 ] || usage "run at an interactive terminal (the confirmation is typed, never piped)"
for c in bash docker flock timeout sha256sum stat readlink dirname mktemp mv sync date head tail grep awk cut tr sleep; do
  command -v "$c" >/dev/null 2>&1 || usage "$c is required; nothing was checked"
done

safe_node() {
  local p=$1 kind=$2 mask=$3 owner mode
  [ ! -L "$p" ] || return 1
  if [ "$kind" = d ]; then [ -d "$p" ] || return 1; else [ -f "$p" ] || return 1; fi
  owner=$(stat -c %u -- "$p") && mode=$(stat -c %a -- "$p") || return 1
  [ "$owner" = "$OWNER_UID" ] && (( (8#$mode & 8#$mask) == 0 ))
}
VERIFIER="$INSTALL_DIR/verify-topology.sh"
[ "$(readlink -f -- "$INSTALL_DIR")" = "$INSTALL_DIR" ] && safe_node "$INSTALL_DIR" d 022 && safe_node "$VERIFIER" f 022 \
  || { printf '[topology-recovery] REFUSED: the installation in %s is unsafe; nothing was changed\n' "$INSTALL_DIR" >&2; exit 65; }
got=$(sha256sum -- "$VERIFIER"); got=${got%% *}
[ "$got" = "$VERIFIER_SHA256" ] || { printf '[topology-recovery] REFUSED: the installed verifier does not match its pin; nothing was changed\n' >&2; exit 66; }
safe_node "$STATE_DIR" d 077 || { printf '[topology-recovery] REFUSED: %s is unsafe or missing; nothing was changed\n' "$STATE_DIR" >&2; exit 65; }
[ ! -L "$STATE_DIR/lock" ] || exit 65
exec 9>>"$STATE_DIR/lock"
flock -w "$LOCK_WAIT" 9 || { printf '[topology-recovery] REFUSED: the monitor holds its lock; nothing was changed\n' >&2; exit 75; }

ctl() { timeout "$CTL_TIMEOUT" docker exec -u rabbitmq "$BROKER" rabbitmqctl -q "$@" 2>/dev/null; }
blank() { [ -z "$(tr -d '[:space:]' <<<"$1")" ]; }
now() { date +%s; }
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
write_atomic() {
  local tmp
  tmp=$(mktemp -- "$(dirname -- "$1")/.tmp.XXXXXXXX") || return 1
  if printf '%s' "$2" >"$tmp" && chmod "$3" -- "$tmp" && sync -- "$tmp" && mv -f -- "$tmp" "$1"; then return 0; fi
  rm -f -- "$tmp"
  return 1
}
latch_is() { # latch_is <inactive|contained>
  local dir; dir=$(dirname -- "$LATCH")
  safe_node "$dir" d 022 && safe_node "$LATCH" f 022 || return 1
  case "$1" in inactive) [ "$(head -c 512 -- "$LATCH")" = "$LATCH_INACTIVE" ] ;; *) [ "$(head -c 512 -- "$LATCH")" = "$LATCH_CONTAINED" ] ;; esac
}
held() { # one read-back of the containment: no grant, no topic grant, no connection of the service
  local users perms topics conns
  users=$(ctl list_users --no-table-headers) || return 1
  if awk -F'\t' -v u="$SERVICE" '$1 == u { f = 1 } END { exit !f }' <<<"$users"; then
    perms=$(ctl list_user_permissions "$SERVICE" --no-table-headers) || return 1
    topics=$(ctl list_user_topic_permissions "$SERVICE" --no-table-headers) || return 1
    blank "$perms$topics" || return 1
  fi
  conns=$(ctl list_connections user --no-table-headers) || return 1
  ! grep -qxF -- "$SERVICE" <<<"$conns"
}
verify_pre_grant() { # prints the verifier's JSON line; returns its exit status
  env -i PATH="$SAFE_PATH" LC_ALL=C RABBITMQ_CONTAINER="$BROKER" NOTIFICATION_CONTAINMENT_STATE="$LATCH" \
    PROPOSED_PERM_CONF="$ROLE_CONF" PROPOSED_PERM_WRITE="$ROLE_WRITE" PROPOSED_PERM_READ="$ROLE_CONF" \
    EXPECTED_TOPIC_WRITE="$TOPIC_WRITE" EXPECTED_TOPIC_READ="$TOPIC_READ" \
    timeout "$VERIFY_TIMEOUT" bash --noprofile --norc -- "$VERIFIER" "$SERVICE" --phase pre-grant 2>/dev/null | tail -n 1
  return "${PIPESTATUS[0]}"
}

# 1. The containment this recovery would end: valid state, contained, latch contained, and holding.
text=$(head -c 4096 -- "$STATE_DIR/state" 2>/dev/null || true)
safe_node "$STATE_DIR/state" f 077 && [[ $text =~ $STATE_RE ]] || stop "the monitor's state is missing or invalid (reinstallation is a separate, authorized step)"
[ "${BASH_REMATCH[1]}" = 1 ] || stop "the monitor's state does not say contained: there is nothing to recover"
latch_is contained || stop "the containment latch is not a valid, root-owned 'contained' latch"
held && { sleep "$CONFIRM_INTERVAL"; held; } || stop "the containment does not hold (a grant or a connection of $SERVICE exists): investigate first"

# 2. A fresh verification: the latch must be the ONLY non-passing check.
rc=0; line=$(verify_pre_grant) || rc=$?
others=$( { grep -oE '"id":"[A-Z][0-9]","status":"[A-Z_]+","reason":"[a-z_]+"' <<<"$line" || true; } \
  | grep -vE '"status":"(PASS|NOT_APPLICABLE_PRE_CREATION)"' | grep -vxF '"id":"L1","status":"FAIL","reason":"latch_contained"' || true)
[ "$rc" -eq 1 ] && grep -qF '"id":"L1","status":"FAIL","reason":"latch_contained"' <<<"$line" && blank "$others" \
  || stop "the fresh verification does not pass apart from the latch (exit $rc; failing: $( { grep -oE '"id":"[A-Z][0-9]"' <<<"$others" || true; } | cut -d'"' -f4 | tr '\n' ' '))"

# 3. The Owner's typed confirmation.
expected="RECOVER $SERVICE $REF"
printf '[topology-recovery] The topology passes apart from the latch, and the containment holds.\n'
printf '[topology-recovery] This clears the latch only; %s stays WITHOUT any grant until protected provisioning runs.\n' "$SERVICE"
printf '[topology-recovery] Type exactly: %s\n> ' "$expected"
IFS= read -r typed || typed=''
[ "$typed" = "$expected" ] || stop "the confirmation did not match"

# 4. The latch, then a full verification; on any doubt the latch is put back.
write_atomic "$LATCH" "$LATCH_INACTIVE" 644 || stop "the latch could not be written"
rc=0; line=$(verify_pre_grant) || rc=$?
if [ "$rc" -ne 0 ] || ! latch_is inactive; then
  write_atomic "$LATCH" "$LATCH_CONTAINED" 644 || true
  latch_is contained || printf '[topology-recovery] CRITICAL: the latch could not be put back to contained; the monitor re-contains on its next run\n' >&2
  printf '[topology-recovery] REFUSED: the verification with the latch cleared did not pass (exit %s); the latch was put back to contained\n' "$rc" >&2
  exit 1
fi
write_atomic "$STATE_DIR/state" "$(printf 'nawara-core-topology-monitor-state v1\nservice=%s\ncontained=0\nunknown_streak=0\nlast_result=PASS\nlast_run=%s\n' "$SERVICE" "$(now)")" 600 \
  || { write_atomic "$LATCH" "$LATCH_CONTAINED" 644 || true; stop "the monitor's state could not be written; the latch was put back to contained"; }
record="{\"v\":1,\"at\":\"$(iso)\",\"at_epoch\":$(now),\"service\":\"$SERVICE\",\"severity\":\"info\",\"kind\":\"recovered\",\"authorization\":\"$REF\"}"
printf '%s\n' "$record" >>"$STATE_DIR/evidence.jsonl" 2>/dev/null || log "evidence record unavailable"
printf '%s\n' "$record" >>"$STATE_DIR/alerts.jsonl" 2>/dev/null || log "alert spool unavailable"
log "the latch is cleared (authorization $REF). $SERVICE holds NO grant: grant it only through protected provisioning, whose gates run again."
exit 0
