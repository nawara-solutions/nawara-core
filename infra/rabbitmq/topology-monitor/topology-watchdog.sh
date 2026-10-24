#!/usr/bin/env bash
# Core V2 OD-BRK-2b-1: the watchdog of Notification's topology monitor (docs/runbooks/rabbitmq-topology-containment.md §4). Installed
# root-owned in INSTALL_DIR and started ONLY by nawara-core-topology-watchdog.service, on its OWN timer (a second systemd timer, offset
# from the monitor's): a check that runs inside the monitor could never notice that the monitor stopped running. Never installed,
# enabled or started by repository tooling.
#
# It detects, without touching the broker, the latch or the monitor's state:
#   not_installed      the monitor's state directory or its installation marker is missing
#   state_invalid      the monitor's state file is missing, corrupt, a symbolic link or weakly permissioned
#   monitor_overdue    no completed monitor run for more than MAX_AGE seconds (or none since installation)
#   monitor_stalled    a monitor run still holds the lock after STALL_SECONDS
#   monitor_killed     a run marker survives with no run holding the lock (a run was killed, e.g. by its systemd timeout)
#   timer_inactive     the monitor's timer is not active
#   service_failed     the monitor's service is in the failed state
#   contained          (informational) the monitor reports Notification contained
# Response policy (bounded): a durable record of every check (STATE_DIR/watchdog.jsonl), an alert on every change of status and a
# reminder every REMINDER_SECONDS while a problem lasts (STATE_DIR/alerts.jsonl, the same pending-carrier spool as the monitor), and its
# own check-in (STATE_DIR/watchdog), which the monitor reads in turn. It never contains, grants or restarts anything: autonomous
# containment on a silent monitor is a separate Owner decision. Its independence is bounded: it shares the host and systemd with the
# monitor, so a dead host or a stopped systemd silences both; only an external heartbeat (a pending dependency) covers that.
#
# Exit: 0 every check passed (or contained, informational); 1 at least one problem; 64 an argument or a client command; 65 unsafe
# installation or not root; 69 a tool is missing; 75 another watchdog run holds its lock.
set -euo pipefail
umask 077
export LC_ALL=C

# Pinned values (scripts/check-repo.mjs, checkTopologyMonitor).
readonly SERVICE='notification-service'
readonly INSTALL_DIR='/usr/local/libexec/nawara-core-topology'
readonly STATE_DIR='/var/lib/nawara-core-topology-monitor'
readonly SAFE_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
readonly SYSTEMCTL='/usr/bin/systemctl'
readonly MONITOR_TIMER='nawara-core-topology-monitor.timer'
readonly MONITOR_SERVICE='nawara-core-topology-monitor.service'
readonly OWNER_UID=0
readonly RUN_AS_UID=0
readonly MAX_AGE=900
readonly STALL_SECONDS=300
readonly REMINDER_SECONDS=3600
readonly RECORD_MAX_LINES=2000
readonly STATE_RE=$'^nawara-core-topology-monitor-state v1\nservice=notification-service\ncontained=([01])\nunknown_streak=([0-9]{1,3})\nlast_result=(NONE|PASS|FAIL|UNKNOWN)\nlast_run=([0-9]{1,12})$'
readonly MARKER_RE='^nawara-core-topology-monitor installed v1 at=([0-9]{1,12})$'
PATH=$SAFE_PATH
export PATH

log() { printf '[topology-watchdog] %s\n' "$*"; }
refuse() { local code=$1; shift; printf '[topology-watchdog] REFUSED: %s\n' "$*" >&2; exit "$code"; }

[ -z "${SSH_ORIGINAL_COMMAND:-}" ] && [ "$#" -eq 0 ] || refuse 64 "takes no argument and runs no client command; nothing was done"
[ "$EUID" -eq "$RUN_AS_UID" ] || refuse 65 "runs as root only (it reads the monitor's root-only state); nothing was done"
for c in flock stat readlink dirname mktemp mv sync date head tail grep sed wc tr; do
  command -v "$c" >/dev/null 2>&1 || refuse 69 "$c is required; nothing was done"
done
[ -x "$SYSTEMCTL" ] || refuse 69 "$SYSTEMCTL is required; nothing was done"

safe_node() {
  local p=$1 kind=$2 mask=$3 owner mode
  [ ! -L "$p" ] || return 1
  if [ "$kind" = d ]; then [ -d "$p" ] || return 1; else [ -f "$p" ] || return 1; fi
  owner=$(stat -c %u -- "$p") && mode=$(stat -c %a -- "$p") || return 1
  [ "$owner" = "$OWNER_UID" ] && (( (8#$mode & 8#$mask) == 0 ))
}
SELF=$(readlink -f -- "${BASH_SOURCE[0]}")
[ "$(readlink -f -- "$INSTALL_DIR")" = "$INSTALL_DIR" ] && [ "$(dirname -- "$SELF")" = "$INSTALL_DIR" ] \
  && safe_node "$INSTALL_DIR" d 022 && safe_node "$SELF" f 022 || refuse 65 "the watchdog must run root-owned from $INSTALL_DIR; nothing was done"

now() { date +%s; }
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
NOW=$(now)
PROBLEMS=()
problem() { PROBLEMS+=("$1"); }

if [ ! -d "$STATE_DIR" ] || [ -L "$STATE_DIR" ]; then
  # Nothing to record into: the journal (and the failed unit) is the evidence.
  log "status=not_installed problems=not_installed"
  exit 1
fi
safe_node "$STATE_DIR" d 077 || refuse 65 "$STATE_DIR must be owned by uid $OWNER_UID with no group or other access; nothing was done"
WLOCK="$STATE_DIR/watchdog.lock"
[ ! -L "$WLOCK" ] || refuse 65 "$WLOCK is a symbolic link; nothing was done"
exec 8>>"$WLOCK"
flock -n 8 || refuse 75 "another watchdog run holds its lock; nothing was done"

write_atomic() {
  local tmp
  tmp=$(mktemp -- "$STATE_DIR/.tmp.XXXXXXXX") || return 1
  if printf '%s' "$2" >"$tmp" && chmod 600 -- "$tmp" && sync -- "$tmp" && mv -f -- "$tmp" "$1"; then return 0; fi
  rm -f -- "$tmp"
  return 1
}
append() {
  local f="$STATE_DIR/$1" n
  [ ! -L "$f" ] && { [ ! -e "$f" ] || [ -f "$f" ]; } || return 1
  printf '%s\n' "$2" >>"$f" 2>/dev/null || return 1
  n=$(wc -l <"$f") || return 0
  if [ "$n" -gt "$RECORD_MAX_LINES" ]; then write_atomic "$f" "$(tail -n $((RECORD_MAX_LINES / 2)) -- "$f")"$'\n' || true; fi
}

# 1. installation marker and the monitor's state
INSTALLED_AT=''
if [ -f "$STATE_DIR/installed" ] && safe_node "$STATE_DIR/installed" f 077 && [[ $(head -c 256 -- "$STATE_DIR/installed") =~ $MARKER_RE ]]; then
  INSTALLED_AT=${BASH_REMATCH[1]}
else
  problem not_installed
fi
LAST_RUN=''; CONTAINED=0
if [ -f "$STATE_DIR/state" ] && safe_node "$STATE_DIR/state" f 077 && [[ $(head -c 4096 -- "$STATE_DIR/state") =~ $STATE_RE ]]; then
  CONTAINED=${BASH_REMATCH[1]}; LAST_RUN=${BASH_REMATCH[4]}
else
  problem state_invalid
fi
# 2. a completed run within MAX_AGE (a fresh installation is given MAX_AGE from its installation time)
REF=${LAST_RUN:-0}
[ "$REF" -eq 0 ] && [ -n "$INSTALLED_AT" ] && REF=$INSTALLED_AT
if [ "$REF" -eq 0 ] || [ $((NOW - REF)) -gt "$MAX_AGE" ]; then problem monitor_overdue; fi
# 3. a run that holds the lock too long, or a marker left by a killed run
if [ -e "$STATE_DIR/running" ] || [ -L "$STATE_DIR/running" ]; then
  started=$(sed -nE 's/^started=([0-9]{1,12}) pid=[0-9]+$/\1/p' -- "$STATE_DIR/running" 2>/dev/null | head -n 1 || true)
  busy=0
  if [ -e "$STATE_DIR/lock" ] && [ ! -L "$STATE_DIR/lock" ]; then
    flock -n -E 99 "$STATE_DIR/lock" true || busy=$?
  fi
  if [ "$busy" -eq 99 ]; then
    if [ -z "$started" ] || [ $((NOW - started)) -gt "$STALL_SECONDS" ]; then problem monitor_stalled; fi
  else
    problem monitor_killed
  fi
fi
# 4. the units (read-only queries)
"$SYSTEMCTL" is-active --quiet "$MONITOR_TIMER" 2>/dev/null || problem timer_inactive
if "$SYSTEMCTL" is-failed --quiet "$MONITOR_SERVICE" 2>/dev/null; then problem service_failed; fi

STATUS=ok
[ "$CONTAINED" = 1 ] && STATUS=contained
[ "${#PROBLEMS[@]}" -eq 0 ] || STATUS=${PROBLEMS[0]}
LIST=$(IFS=,; echo "${PROBLEMS[*]:-}")

# 5. records, alerts on a change of status (and reminders), and the check-in the monitor reads
PREV_STATUS=none; PREV_ALERT=0
if [ -f "$STATE_DIR/watchdog" ] && safe_node "$STATE_DIR/watchdog" f 077; then
  PREV_STATUS=$(sed -nE 's/^status=([a-z_]{1,32})$/\1/p' -- "$STATE_DIR/watchdog" | head -n 1 || true); PREV_STATUS=${PREV_STATUS:-none}
  PREV_ALERT=$(sed -nE 's/^last_alert=([0-9]{1,12})$/\1/p' -- "$STATE_DIR/watchdog" | head -n 1 || true); PREV_ALERT=${PREV_ALERT:-0}
fi
LAST_ALERT=$PREV_ALERT
severity=info
[ "${#PROBLEMS[@]}" -gt 0 ] && severity=critical
if [ "$STATUS" != "$PREV_STATUS" ] || { [ "${#PROBLEMS[@]}" -gt 0 ] && [ $((NOW - PREV_ALERT)) -gt "$REMINDER_SECONDS" ]; }; then
  append alerts.jsonl "{\"v\":1,\"at\":\"$(iso)\",\"at_epoch\":$NOW,\"service\":\"$SERVICE\",\"severity\":\"$severity\",\"kind\":\"watchdog_$STATUS\",\"problems\":\"$LIST\"}" \
    || log "alert spool unavailable (kind=watchdog_$STATUS)"
  LAST_ALERT=$NOW
  log "ALERT severity=$severity kind=watchdog_$STATUS"
fi
append watchdog.jsonl "{\"v\":1,\"at\":\"$(iso)\",\"at_epoch\":$NOW,\"service\":\"$SERVICE\",\"status\":\"$STATUS\",\"problems\":\"$LIST\"}" || log "watchdog record unavailable"
write_atomic "$STATE_DIR/watchdog" "$(printf 'nawara-core-topology-watchdog v1\nlast_run=%s\nstatus=%s\nlast_alert=%s\n' "$NOW" "$STATUS" "$LAST_ALERT")" \
  || log "watchdog check-in unavailable"
log "status=$STATUS problems=${LIST:-none}"
[ "${#PROBLEMS[@]}" -eq 0 ] && exit 0
exit 1
