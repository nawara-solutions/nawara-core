#!/usr/bin/env bash
# Core V2 OD-BRK-2b-A: the EXTERNAL alert carrier of Notification's topology monitor (docs/runbooks/rabbitmq-topology-containment.md §7).
# One cycle, started ONLY by nawara-core-topology-alert.service (its timer, every 60 s). Installed root-owned in INSTALL_DIR by the
# signed installation and never installed, enabled or started by repository tooling.
#
# It reuses the A5-R3 carrier pattern (infra/alerting/auth-readiness-alert.sh; docs/architecture/core-v2-a5-r3-alert-carrier.md): the
# same providers (Pushover receives the alerts, Healthchecks.io is the independent heartbeat), credentials only from protected files and
# only through curl's stdin config, fixed HTTPS endpoints, certificate verification on, no redirect, the same acceptance rules. It is a
# SEPARATE instance with its own unit, its own state directory, its own credentials and its own queue: it never reads or writes the Auth
# carrier's state, so neither carrier can corrupt the other's evidence or positions.
#
# One cycle:
#   1. intake: the producers' local spool (STATE_DIR/alerts.jsonl, READ-ONLY here) after this carrier's own cursor: every line is
#      parsed strictly into the closed event contract below or rejected (oversized, malformed, unrecognized: a fixed alert, never its
#      content); each event gets a deterministic id, is deduplicated against a bounded ledger and coalesced with a pending one of the same
#      code, incident, reason and problems; a full queue overflows into counters that the next delivery reports (never silent).
#   2. sentinels of its own: the installed artifacts against the Owner-signed installed manifest (alerting only, never enforcement), the
#      cursor and the spool themselves.
#   3. delivery: the oldest critical events first, at most BATCH_MAX per message and MAX_BATCHES messages per cycle, each message within
#      MSG_MAX characters with every event line WHOLE (the trailing metadata reserved first; an event that does not fit stays queued for
#      the next message, never cut and never acknowledged in part); accepted only on
#      Pushover's HTTP 200 with "status":1; a temporary failure backs off exponentially, a rejection (4xx, 429) for an hour; nothing is
#      dropped while undelivered. Delivery is AT-LEAST-ONCE: a cycle killed after the provider accepted a message but before its queue
#      files are removed sends it again (bounded duplicates; never exactly-once).
#   4. heartbeats: the monitor's and the watchdog's OWN completed runs, each to its OWN Healthchecks.io check, with the run's exit status
#      (Healthchecks.io's /<exit-status> ping: 0 is a success, anything else a failure). Only a run that completed within HB_FRESH seconds
#      is pinged, once: a missed run is never fabricated and an old run never refreshes a check. PASS is the only success.
#
# The carrier is never on the containment path: the monitor, the watchdog and the recovery never call it or wait for it, it takes none
# of their locks and it writes nothing outside CARRIER_DIR. It holds no broker credential and never runs docker, rabbitmqctl or systemctl.
#
# Event contract (one canonical record per event; every field a closed code, a number or an id; no message, code, credential, signed
# payload, key, cookie, exception text or free-form metadata ever reaches it, the queue, the journal or a provider):
#   v, id (32 hex), code, severity (critical|warning|info, from the table below, never from the line), component
#   (monitor|watchdog|recovery|carrier), at, at_epoch, incident (none or 32 hex), reason (a closed token), problems (closed tokens),
#   count (coalesced occurrences), last_epoch, queued_epoch (when this carrier first queued it).
#
# Exit: 0 everything delivered and every due heartbeat sent; 3 events stay queued; 4 a heartbeat could not be sent; 64 an argument or a
# client command; 65 unsafe installation, state or not root; 69 a tool is missing; 78 a credential is missing or invalid (the intake and
# the local evidence still ran).
set -euo pipefail
umask 077
export LC_ALL=C
SECONDS=0

# Pinned values (scripts/check-repo.mjs, checkTopologyMonitor).
readonly SERVICE='notification-service'
readonly INSTALL_DIR='/usr/local/libexec/nawara-core-topology'
readonly STATE_DIR='/var/lib/nawara-core-topology-monitor'
readonly CARRIER_DIR='/var/lib/nawara-core-topology-alert'
readonly CRED_DIR='/run/credentials/nawara-core-topology-alert.service'
readonly UNIT_DIR='/etc/systemd/system'
readonly INSTALL_STATE='/var/lib/nawara-core-topology-install'
readonly INSTALL_TRUST='/etc/nawara-core-topology/install-allowed-signers'
readonly PRINCIPAL='nawara-core-owner'
readonly INSTALL_NAMESPACE='nawara-core-topology-install'
readonly SCRIPTS='verify-and-contain.sh topology-watchdog.sh topology-trigger.sh recover-notification-topology.sh install-topology-monitor.sh verify-topology-monitor-install.sh topology-alert-carrier.sh'
readonly UNITS='nawara-core-topology-monitor.service nawara-core-topology-monitor.timer nawara-core-topology-watchdog.service nawara-core-topology-watchdog.timer nawara-core-topology-alert.service nawara-core-topology-alert.timer'
readonly PUSHOVER_URL='https://api.pushover.net/1/messages.json'
readonly HC_URL_RE='^https://hc-ping\.com/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{22}/[a-z0-9_-]{1,100})$'
readonly CA_FILE=''
readonly OWNER_UID=0
readonly RUN_AS_UID=0
readonly SAFE_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
readonly CURL_TIMEOUT=8
readonly HEARTBEAT_TIMEOUT=5
readonly DELIVERY_DEADLINE=35
readonly QUEUE_MAX=256
readonly BATCH_MAX=8
readonly MSG_MAX=1000
readonly MAX_BATCHES=3
readonly LEDGER_MAX=4000
readonly REPLAY_WINDOW=86400
readonly SPOOL_MAX_BYTES=1048576
readonly LINE_MAX=1024
readonly HB_FRESH=360
readonly HB_WINDOW=900
readonly STALL_SECONDS=600
readonly REMINDER_SECONDS=3600
readonly RECORD_MAX_LINES=2000
readonly RUNBOOK='docs/runbooks/rabbitmq-topology-containment.md'
readonly ISO_RE='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
readonly MON_RE='^\{"v":1,"at":"'"$ISO_RE"'","at_epoch":([0-9]{1,12}),"service":"notification-service","severity":"(info|warning|critical)","kind":"([a-z_]{1,40})","unknown_streak":[0-9]{1,3},"containment":"(none|unconfirmed|confirmed)","incident":"(none|[0-9a-f]{32})"(,"reason":"([a-z0-9_]{1,40})")?\}$'
# the watchdog's closed problem codes (topology-watchdog.sh, its `problem` calls): a comma-separated list of at most seven
readonly WD_PROBLEMS='not_installed|state_invalid|monitor_overdue|monitor_stalled|monitor_killed|timer_inactive|service_failed'
readonly WD_RE='^\{"v":1,"at":"'"$ISO_RE"'","at_epoch":([0-9]{1,12}),"service":"notification-service","severity":"(info|critical)","kind":"watchdog_([a-z_]{1,32})","problems":"((('"$WD_PROBLEMS"')(,('"$WD_PROBLEMS"')){0,6})?)"\}$'
readonly REC_RE='^\{"v":1,"at":"'"$ISO_RE"'","at_epoch":([0-9]{1,12}),"service":"notification-service","severity":"(info|warning|critical)","kind":"(recovered|recovery_[a-z_]{1,30})","incident":"(none|[0-9a-f]{32})"(,"reason":"([a-z0-9_]{1,40})")?\}$'
readonly RUN_RE='^\{"v":1,"at":"'"$ISO_RE"'","at_epoch":([0-9]{1,12}),"service":"notification-service","mode":"(monitor|contained|integrity)","phase":"[a-z-]{1,20}","result":"(NONE|PASS|FAIL|UNKNOWN)",.*,"containment":"(none|unconfirmed|confirmed)",'
readonly WATCHDOG_RE=$'^nawara-core-topology-watchdog v1\nlast_run=([0-9]{1,12})\nstatus=([a-z_]{1,32})\nlast_alert=[0-9]{1,12}$'
readonly QRE='^\{"v":1,"id":"([0-9a-f]{32})","code":"([a-z_]{1,40})","severity":"(critical|warning|info)","component":"(monitor|watchdog|recovery|carrier)","at":"('"$ISO_RE"')","at_epoch":([0-9]{1,12}),"incident":"(none|[0-9a-f]{32})","reason":"([a-z0-9_]{0,40})","problems":"([a-z_,]{0,200})","count":([0-9]{1,6}),"last_epoch":([0-9]{1,12}),"queued_epoch":([0-9]{1,12})\}$'
readonly STATE_RE=$'^nawara-core-topology-alert-state v1\ncursor_epoch=([0-9]{1,12})\nseq=([0-9]{1,12})\nbackoff_until=([0-9]{1,12})\nfailures=([0-9]{1,3})\nhb_monitor_sent=([0-9]{1,12})\nhb_watchdog_sent=([0-9]{1,12})\nhb_monitor_missed=([0-9]{1,12})\nhb_watchdog_missed=([0-9]{1,12})\nhb_fail_monitor=([0-9]{1,12})\nhb_fail_watchdog=([0-9]{1,12})\noverflow_critical=([0-9]{1,9})\noverflow_other=([0-9]{1,9})\nintegrity=([a-z_]{1,32})\nintegrity_alert_at=([0-9]{1,12})$'
PATH=$SAFE_PATH
export PATH

log() { printf '[topology-alert] %s\n' "$*"; }
refuse() { local code=$1; shift; printf '[topology-alert] REFUSED: %s\n' "$*" >&2; exit "$code"; }

# The event contract: the producers' kinds (unchanged names) mapped to the canonical codes, and each code's severity (the carrier's,
# never the line's). Anything else is rejected as unrecognized.
declare -A CODE=(
  [monitor:unknown_first]=topology_verification_unknown [monitor:unknown_escalated]=topology_unknown_escalated
  [monitor:unknown_cleared]=topology_unknown_cleared [monitor:verification_fail]=topology_verification_fail
  [monitor:containment_started]=containment_started [monitor:contained]=containment_confirmed
  [monitor:containment_unconfirmed]=containment_unconfirmed [monitor:latch_restored_by_monitor]=containment_latch_restored
  [monitor:incident_binding_restored]=containment_incident_rebound [monitor:watchdog_quiet]=watchdog_quiet
  [watchdog:ok]=watchdog_ok [watchdog:contained]=watchdog_contained [watchdog:not_installed]=watchdog_not_installed
  [watchdog:state_invalid]=watchdog_state_invalid [watchdog:monitor_overdue]=monitor_overdue [watchdog:monitor_stalled]=monitor_stalled
  [watchdog:monitor_killed]=monitor_killed [watchdog:timer_inactive]=monitor_timer_inactive [watchdog:service_failed]=monitor_service_failed
  [recovery:recovery_authorized]=recovery_authorized [recovery:recovery_refused]=recovery_refused
  [recovery:recovery_reverted]=recovery_reverted [recovery:recovered]=recovery_completed
)
declare -A SEVERITY=(
  [topology_verification_unknown]=warning [topology_unknown_escalated]=critical [topology_unknown_cleared]=info
  [topology_verification_fail]=critical [containment_started]=critical [containment_confirmed]=critical [containment_unconfirmed]=critical
  [containment_latch_restored]=critical [containment_incident_rebound]=critical [watchdog_quiet]=warning
  [watchdog_ok]=info [watchdog_contained]=info [watchdog_not_installed]=critical [watchdog_state_invalid]=critical
  [monitor_overdue]=critical [monitor_stalled]=critical [monitor_killed]=critical [monitor_timer_inactive]=critical [monitor_service_failed]=critical
  [recovery_authorized]=critical [recovery_refused]=critical [recovery_reverted]=critical [recovery_completed]=warning
  [installation_integrity_failed]=critical [installation_integrity_restored]=info [heartbeat_delivery_failed]=warning
  [spool_event_rejected]=critical [spool_gap]=critical [spool_unreadable]=critical [spool_cursor_invalid]=critical [carrier_started]=info
)

# ---------------------------------------------------------------- 1. the invocation and the installation
[ -z "${SSH_ORIGINAL_COMMAND:-}" ] && [ "$#" -eq 0 ] || refuse 64 "takes no argument and runs no client command; nothing was done"
[ "$EUID" -eq "$RUN_AS_UID" ] || refuse 65 "runs as root only (it reads the monitor's root-only spool); nothing was done"
for c in curl timeout flock sha256sum ssh-keygen stat readlink dirname mktemp mv cp rm sync date head tail grep sed sort cut tr wc od env; do
  command -v "$c" >/dev/null 2>&1 || refuse 69 "$c is required; nothing was done"
done
safe_node() { # safe_node <path> <d|f> <octal mask>: that kind, no symbolic link, owned by OWNER_UID, (mode & mask) == 0, one link (files)
  local p=$1 kind=$2 mask=$3 owner mode
  [ ! -L "$p" ] || return 1
  if [ "$kind" = d ]; then [ -d "$p" ] || return 1; else [ -f "$p" ] && [ "$(stat -c %h -- "$p")" = 1 ] || return 1; fi
  owner=$(stat -c %u -- "$p") && mode=$(stat -c %a -- "$p") || return 1
  [ "$owner" = "$OWNER_UID" ] && (( (8#$mode & 8#$mask) == 0 ))
}
SELF=$(readlink -f -- "${BASH_SOURCE[0]}")
[ "$(readlink -f -- "$INSTALL_DIR")" = "$INSTALL_DIR" ] && [ "$(dirname -- "$SELF")" = "$INSTALL_DIR" ] \
  && safe_node "$INSTALL_DIR" d 022 && safe_node "$SELF" f 022 || refuse 65 "the carrier must run root-owned from $INSTALL_DIR; nothing was done"
# Its own directory (systemd StateDirectory=): never the monitor's, never the Auth carrier's.
safe_node "$CARRIER_DIR" d 077 || refuse 65 "$CARRIER_DIR must be a directory owned by uid $OWNER_UID with no group or other access; nothing was done"
[ ! -L "$CARRIER_DIR/lock" ] || refuse 65 "$CARRIER_DIR/lock is a symbolic link; nothing was done"
exec 9>>"$CARRIER_DIR/lock"
flock -n 9 || { log "another cycle is running; this one does nothing"; exit 0; }
for d in queue work; do
  if [ -L "$CARRIER_DIR/$d" ]; then refuse 65 "$CARRIER_DIR/$d is a symbolic link; nothing was done"; fi
  [ -d "$CARRIER_DIR/$d" ] || mkdir -m 700 -- "$CARRIER_DIR/$d"
  safe_node "$CARRIER_DIR/$d" d 077 || refuse 65 "$CARRIER_DIR/$d is unsafe; nothing was done"
done
WORK=$(mktemp -d -- "$CARRIER_DIR/work/cycle.XXXXXXXX")
trap 'rm -rf -- "$WORK"' EXIT

NOW=$(date +%s)
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
write_atomic() { # write_atomic <path> <content>: a flushed temporary file in the same directory, renamed over the path (mode 0600)
  local tmp
  tmp=$(mktemp -- "$(dirname -- "$1")/.tmp.XXXXXXXX") || return 1
  if printf '%s' "$2" >"$tmp" && sync -- "$tmp" && mv -f -- "$tmp" "$1"; then return 0; fi
  rm -f -- "$tmp"
  return 1
}
record() { # record <file> <json line>: bounded local evidence in CARRIER_DIR (never required for delivery)
  local f="$CARRIER_DIR/$1" n
  [ ! -L "$f" ] && { [ ! -e "$f" ] || [ -f "$f" ]; } || return 0
  printf '%s\n' "$2" >>"$f" 2>/dev/null || return 0
  n=$(wc -l <"$f") || return 0
  if [ "$n" -gt "$RECORD_MAX_LINES" ]; then write_atomic "$f" "$(tail -n $((RECORD_MAX_LINES / 2)) -- "$f")"$'\n' || true; fi
}
hash32() { local h; h=$(printf '%s' "$1" | sha256sum); printf '%s' "${h:0:32}"; }

# ---------------------------------------------------------------- 2. the credentials (systemd LoadCredential=; never the environment)
# Only the token, the user key and the two ping URLs, each a root-owned file (0400/0600, one link, no symbolic link) in CRED_DIR. A value
# is never printed, even when it is refused. A missing or invalid credential disables only what it serves; the intake still runs.
CONFIG_OK=1; PO_OK=0; HC_M_OK=0; HC_W_OK=0; PO_TOKEN=''; PO_USER=''; HC_MONITOR=''; HC_WATCHDOG=''
credential() { # credential <variable> <file name>
  local f="$CRED_DIR/$2" mode
  safe_node "$f" f 077 || return 1
  mode=$(stat -c %a -- "$f"); [[ $mode =~ ^[46]00$ ]] || return 1
  IFS= read -r "$1" <"$f" || [ -n "${!1}" ]
}
if safe_node "$CRED_DIR" d 022; then
  if credential PO_TOKEN pushover.token && credential PO_USER pushover.user && [[ $PO_TOKEN =~ ^[A-Za-z0-9]{30}$ ]] && [[ $PO_USER =~ ^[A-Za-z0-9]{30}$ ]]; then PO_OK=1
  else CONFIG_OK=0; PO_TOKEN=''; PO_USER=''; log "credential: the Pushover token or user key is missing or invalid (value not shown): alerts stay queued"; fi
  if credential HC_MONITOR healthchecks-monitor.url && [[ $HC_MONITOR =~ $HC_URL_RE ]]; then HC_M_OK=1
  else CONFIG_OK=0; HC_MONITOR=''; log "credential: the monitor's Healthchecks.io ping URL is missing or invalid (value not shown)"; fi
  if credential HC_WATCHDOG healthchecks-watchdog.url && [[ $HC_WATCHDOG =~ $HC_URL_RE ]]; then HC_W_OK=1
  else CONFIG_OK=0; HC_WATCHDOG=''; log "credential: the watchdog's Healthchecks.io ping URL is missing or invalid (value not shown)"; fi
  if [ "$HC_M_OK" = 1 ] && [ "$HC_W_OK" = 1 ] && [ "$HC_MONITOR" = "$HC_WATCHDOG" ]; then
    CONFIG_OK=0; HC_M_OK=0; HC_W_OK=0; HC_MONITOR=''; HC_WATCHDOG=''
    log "credential: the monitor and the watchdog must have two DIFFERENT checks; no heartbeat is sent"
  fi
else
  CONFIG_OK=0; log "credential: $CRED_DIR is missing or unsafe: nothing is delivered (the intake still runs)"
fi

# ---------------------------------------------------------------- 3. the carrier's durable state (strict; never assumed)
STATE="$CARRIER_DIR/state"; CURSOR_LINE="$CARRIER_DIR/cursor.line"; LEDGER="$CARRIER_DIR/ledger"
S_CURSOR=0; S_SEQ=0; S_BACKOFF=0; S_FAILURES=0; S_HB_M=0; S_HB_W=0; S_MISS_M=0; S_MISS_W=0; S_HBF_M=0; S_HBF_W=0; S_OVF_C=0; S_OVF_O=0
S_INTEGRITY=ok; S_INTEGRITY_AT=0; STATE_MODE=fresh
if [ -e "$STATE" ] || [ -L "$STATE" ]; then
  text=''
  if safe_node "$STATE" f 077; then text=$(head -c 4096 -- "$STATE" 2>/dev/null || true); fi
  if [[ $text =~ $STATE_RE ]]; then
    S_CURSOR=${BASH_REMATCH[1]}; S_SEQ=${BASH_REMATCH[2]}; S_BACKOFF=${BASH_REMATCH[3]}; S_FAILURES=$((10#${BASH_REMATCH[4]}))
    S_HB_M=${BASH_REMATCH[5]}; S_HB_W=${BASH_REMATCH[6]}; S_MISS_M=${BASH_REMATCH[7]}; S_MISS_W=${BASH_REMATCH[8]}
    S_HBF_M=${BASH_REMATCH[9]}; S_HBF_W=${BASH_REMATCH[10]}; S_OVF_C=${BASH_REMATCH[11]}; S_OVF_O=${BASH_REMATCH[12]}
    S_INTEGRITY=${BASH_REMATCH[13]}; S_INTEGRITY_AT=${BASH_REMATCH[14]}; STATE_MODE=known
  else
    STATE_MODE=invalid
    mv -f -- "$STATE" "$CARRIER_DIR/state.rejected" 2>/dev/null || rm -f -- "$STATE"
  fi
fi
declare -A SEEN=()
if [ -e "$LEDGER" ] || [ -L "$LEDGER" ]; then
  if safe_node "$LEDGER" f 077; then
    while IFS= read -r l; do
      if [[ $l =~ ^[0-9a-f]{32}$ ]]; then SEEN[$l]=1; else STATE_MODE=invalid; fi
    done < <(tail -n "$LEDGER_MAX" -- "$LEDGER")
  else
    STATE_MODE=invalid; rm -f -- "$LEDGER"
  fi
fi
CURSOR_OK=0
if [ "$STATE_MODE" = known ] && [ -f "$CURSOR_LINE" ] && safe_node "$CURSOR_LINE" f 077 && [ -s "$CURSOR_LINE" ] && [ "$(wc -l <"$CURSOR_LINE")" = 1 ]; then CURSOR_OK=1
elif [ "$STATE_MODE" = known ] && { [ -e "$CURSOR_LINE" ] || [ -L "$CURSOR_LINE" ] || [ "$S_CURSOR" != 0 ]; }; then
  # unsafe, empty or several lines, or MISSING although a position was recorded: never a silent restart
  STATE_MODE=invalid; rm -f -- "$CURSOR_LINE"
fi

# ---------------------------------------------------------------- 4. the queue (one file per pending event; coalesced; bounded)
QUEUE="$CARRIER_DIR/queue"
QFILE_RE='/([0-2])-([0-9]{12})-([0-9a-f]{16})\.json$'
queued() { local n=0 f; for f in "$QUEUE"/*.json; do [[ $f =~ $QFILE_RE ]] && n=$((n + 1)); done; echo "$n"; }
QUEUED=0; COALESCED=0; OVERFLOWED=0; INTAKE=0; REJECTED=0
enqueue() { # enqueue <id> <code> <component> <at_epoch> <incident> <reason> <problems>
  local id=$1 code=$2 comp=$3 at=$4 inc=$5 reason=$6 prob=$7 sev key prio f old count first line
  sev=${SEVERITY[$code]}
  case "$sev" in critical) prio=0 ;; warning) prio=1 ;; *) prio=2 ;; esac
  key=$(hash32 "$code|$inc|$reason|$prob"); key=${key:0:16}
  for f in "$QUEUE"/*-"$key".json; do
    [[ $f =~ $QFILE_RE ]] || continue
    old=$(head -c 2048 -- "$f" 2>/dev/null || true)
    if [[ $old =~ $QRE ]]; then
      count=$((10#${BASH_REMATCH[10]} + 1)); [ "$count" -le 999999 ] || count=999999
      first=${BASH_REMATCH[1]}
      line=$(printf '{"v":1,"id":"%s","code":"%s","severity":"%s","component":"%s","at":"%s","at_epoch":%s,"incident":"%s","reason":"%s","problems":"%s","count":%s,"last_epoch":%s,"queued_epoch":%s}' \
        "$first" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}" "${BASH_REMATCH[5]}" "${BASH_REMATCH[6]}" "${BASH_REMATCH[7]}" "${BASH_REMATCH[8]}" "${BASH_REMATCH[9]}" "$count" "$at" "${BASH_REMATCH[12]}")
      write_atomic "$f" "$line"$'\n' && { COALESCED=$((COALESCED + 1)); return 0; }
    fi
  done
  if [ "$(queued)" -ge "$QUEUE_MAX" ]; then
    # Saturated: counted (by severity) and reported in the next delivery; the spool on the host keeps the line.
    if [ "$sev" = critical ]; then S_OVF_C=$((S_OVF_C + 1)); else S_OVF_O=$((S_OVF_O + 1)); fi
    OVERFLOWED=$((OVERFLOWED + 1))
    return 0
  fi
  S_SEQ=$((S_SEQ + 1))
  f=$(printf '%s/%s-%012d-%s.json' "$QUEUE" "$prio" "$S_SEQ" "$key")
  line=$(printf '{"v":1,"id":"%s","code":"%s","severity":"%s","component":"%s","at":"%s","at_epoch":%s,"incident":"%s","reason":"%s","problems":"%s","count":1,"last_epoch":%s,"queued_epoch":%s}' \
    "$id" "$code" "$sev" "$comp" "$(iso "$at")" "$at" "$inc" "$reason" "$prob" "$at" "$NOW")
  write_atomic "$f" "$line"$'\n' || refuse 65 "the queue cannot be written"
  QUEUED=$((QUEUED + 1))
}
carrier_event() { # carrier_event <code> <reason> [bucket]: an event of the carrier itself; its id is deterministic per code, reason and
  # bucket (by default the hour), so a lasting condition is reported at most once an hour, never once a cycle
  local id
  id=$(hash32 "carrier|$1|$2|${3:-$((NOW / 3600))}")
  [ -z "${SEEN[$id]:-}" ] || return 0
  enqueue "$id" "$1" carrier "$NOW" none "$2" ''
  SEEN[$id]=1; NEW_IDS+=("$id")
}
NEW_IDS=()

# ---------------------------------------------------------------- 5. intake: the producers' spool, read-only, after the cursor
case "$STATE_MODE" in
  fresh) carrier_event carrier_started first_cycle ;;
  invalid) carrier_event spool_cursor_invalid cursor_invalid; log "the carrier's state, cursor or ledger was invalid: set aside; replaying the last ${REPLAY_WINDOW}s with deduplication" ;;
esac
SPOOL="$STATE_DIR/alerts.jsonl"; SNAP="$WORK/spool"; LAST_LINE=''; SPOOL_READ=0
if [ ! -e "$SPOOL" ] && [ ! -L "$SPOOL" ]; then
  SPOOL_READ=1   # nothing recorded yet
elif ! safe_node "$STATE_DIR" d 077 || ! safe_node "$SPOOL" f 077; then
  carrier_event spool_unreadable spool_unsafe
elif ! cp -- "$SPOOL" "$SNAP" 2>/dev/null; then
  carrier_event spool_unreadable spool_unreadable
elif [ "$(stat -c %s -- "$SNAP")" -gt "$SPOOL_MAX_BYTES" ]; then
  carrier_event spool_unreadable spool_oversized
else
  SPOOL_READ=1
  # Only complete lines: a line still being appended is read on the next cycle.
  if [ -s "$SNAP" ] && [ "$(tail -c 1 -- "$SNAP" | od -An -tx1 | tr -d ' \n')" != 0a ]; then
    head -n "$(($(wc -l <"$SNAP")))" -- "$SNAP" >"$SNAP.complete"; mv -f -- "$SNAP.complete" "$SNAP"
  fi
  mapfile -t LINES <"$SNAP"
  start=0; replay=0
  if [ "$CURSOR_OK" = 1 ]; then
    n=$( { grep -nxF -f "$CURSOR_LINE" -- "$SNAP" || true; } | tail -n 1 | cut -d: -f1)
    if [ -n "$n" ]; then start=$n; else replay=1; fi
  else
    replay=1
  fi
  if [ "$replay" = 1 ]; then
    floor=$((NOW - REPLAY_WINDOW))
    if [ "$CURSOR_OK" = 1 ]; then
      floor=$((S_CURSOR - 300))
      first=$(sed -nE 's/.*"at_epoch":([0-9]{1,12}).*/\1/p' <<<"${LINES[0]:-}")
      # The cursor's line is gone: the producer's bounded spool dropped lines this carrier never read (possible loss: say so).
      if [ "${#LINES[@]}" -gt 0 ] && [ -n "$first" ] && [ "$first" -gt "$S_CURSOR" ]; then carrier_event spool_gap cursor_line_dropped; fi
    fi
  fi
  # one sha256sum for every candidate line (the deterministic event id), never one process per line
  ids=()
  if [ "${#LINES[@]}" -gt "$start" ]; then
    i=$start
    while [ "$i" -lt "${#LINES[@]}" ]; do printf '%s' "${LINES[$i]}" >"$WORK/l.$i"; i=$((i + 1)); done
    mapfile -t ids < <(cd -- "$WORK" && for ((i = start; i < ${#LINES[@]}; i++)); do printf 'l.%s\n' "$i"; done | xargs -r sha256sum -- | cut -c1-32)
  fi
  k=0
  for ((i = start; i < ${#LINES[@]}; i++)); do
    line=${LINES[$i]}; id=${ids[$k]:-}; k=$((k + 1))
    [ -n "$line" ] || continue
    LAST_LINE=$line
    [[ $id =~ ^[0-9a-f]{32}$ ]] || continue
    if [ -n "${SEEN[$id]:-}" ]; then continue; fi
    if [ "$replay" = 1 ]; then
      at=$(sed -nE 's/.*"at_epoch":([0-9]{1,12}).*/\1/p' <<<"${line:0:$LINE_MAX}")
      if [ -n "$at" ] && [ "$at" -lt "$floor" ]; then SEEN[$id]=1; NEW_IDS+=("$id"); continue; fi
    fi
    INTAKE=$((INTAKE + 1))
    code=''; comp=''; at=$NOW; inc=none; reason=''; prob=''
    if [ "${#line}" -gt "$LINE_MAX" ]; then
      code=spool_event_rejected; comp=carrier; reason=oversized
    elif [[ $line =~ $MON_RE ]]; then
      at=${BASH_REMATCH[1]}; comp=monitor; code=${CODE[monitor:${BASH_REMATCH[3]}]:-}; inc=${BASH_REMATCH[5]}; reason=${BASH_REMATCH[7]:-}
    elif [[ $line =~ $WD_RE ]]; then
      at=${BASH_REMATCH[1]}; comp=watchdog; code=${CODE[watchdog:${BASH_REMATCH[3]}]:-}; prob=${BASH_REMATCH[4]}
    elif [[ $line =~ $REC_RE ]]; then
      at=${BASH_REMATCH[1]}; comp=recovery; code=${CODE[recovery:${BASH_REMATCH[3]}]:-}; inc=${BASH_REMATCH[4]}; reason=${BASH_REMATCH[6]:-}
    else
      code=spool_event_rejected; comp=carrier; reason=malformed
    fi
    if [ -z "$code" ]; then code=spool_event_rejected; comp=carrier; at=$NOW; inc=none; reason=unrecognized; prob=''; fi
    if [ "$at" -gt $((NOW + 300)) ]; then at=$NOW; fi   # a clock ahead never schedules an event into the future
    [ "$code" != spool_event_rejected ] || REJECTED=$((REJECTED + 1))
    enqueue "$id" "$code" "$comp" "$at" "$inc" "$reason" "$prob"
    SEEN[$id]=1; NEW_IDS+=("$id")
  done
fi

# ---------------------------------------------------------------- 6. sentinel: the installed artifacts against the signed record
# Alerting only (the read-only verifier and the monitor's own pins enforce): a change of status, then a reminder every REMINDER_SECONDS.
integrity() {
  local text a dest got
  declare -A sums=()
  if [ -e "$INSTALL_STATE/transaction" ] || [ -L "$INSTALL_STATE/transaction" ]; then echo transaction_open; return; fi
  safe_node "$(dirname -- "$INSTALL_TRUST")" d 022 && safe_node "$INSTALL_TRUST" f 022 || { echo trust_unsafe; return; }
  safe_node "$INSTALL_STATE/installed/manifest" f 077 && safe_node "$INSTALL_STATE/installed/manifest.sig" f 077 || { echo manifest_missing; return; }
  env -i PATH="$SAFE_PATH" timeout 10 ssh-keygen -Y verify -f "$INSTALL_TRUST" -I "$PRINCIPAL" -n "$INSTALL_NAMESPACE" -s "$INSTALL_STATE/installed/manifest.sig" <"$INSTALL_STATE/installed/manifest" >/dev/null 2>&1 \
    || { echo manifest_signature; return; }
  text=$(head -c 8192 -- "$INSTALL_STATE/installed/manifest")
  while IFS= read -r l; do if [[ $l =~ ^file=([0-9a-f]{64})\ (.+)$ ]]; then sums[${BASH_REMATCH[2]}]=${BASH_REMATCH[1]}; fi; done <<<"$text"
  for a in $SCRIPTS verify-topology.sh $UNITS; do
    case " $UNITS " in *" $a "*) dest="$UNIT_DIR/$a" ;; *) dest="$INSTALL_DIR/$a" ;; esac
    safe_node "$dest" f 022 || { echo artifact_unsafe; return; }
    got=$(sha256sum -- "$dest"); got=${got%% *}
    [ "$got" = "${sums[$a]:-}" ] || { echo hash_mismatch; return; }
  done
  echo ok
}
INTEGRITY=$(integrity)
if [ "$INTEGRITY" != ok ]; then
  if [ "$INTEGRITY" != "$S_INTEGRITY" ] || [ $((NOW - S_INTEGRITY_AT)) -ge "$REMINDER_SECONDS" ]; then
    carrier_event installation_integrity_failed "$INTEGRITY" "$NOW"; S_INTEGRITY_AT=$NOW
  fi
elif [ "$S_INTEGRITY" != ok ]; then
  carrier_event installation_integrity_restored ok "$NOW"; S_INTEGRITY_AT=$NOW
fi
S_INTEGRITY=$INTEGRITY

# ---------------------------------------------------------------- 7. the intake is durable BEFORE anything is sent
save() {
  local ids_text
  write_atomic "$STATE" "$(printf 'nawara-core-topology-alert-state v1\ncursor_epoch=%s\nseq=%s\nbackoff_until=%s\nfailures=%s\nhb_monitor_sent=%s\nhb_watchdog_sent=%s\nhb_monitor_missed=%s\nhb_watchdog_missed=%s\nhb_fail_monitor=%s\nhb_fail_watchdog=%s\noverflow_critical=%s\noverflow_other=%s\nintegrity=%s\nintegrity_alert_at=%s\n' \
    "$S_CURSOR" "$S_SEQ" "$S_BACKOFF" "$S_FAILURES" "$S_HB_M" "$S_HB_W" "$S_MISS_M" "$S_MISS_W" "$S_HBF_M" "$S_HBF_W" "$S_OVF_C" "$S_OVF_O" "$S_INTEGRITY" "$S_INTEGRITY_AT")" \
    || refuse 65 "the carrier's state cannot be written"
}
if [ "${#NEW_IDS[@]}" -gt 0 ]; then
  ids_text=$( { if [ -f "$LEDGER" ]; then tail -n "$LEDGER_MAX" -- "$LEDGER"; fi; printf '%s\n' "${NEW_IDS[@]}"; } | tail -n "$LEDGER_MAX")
  write_atomic "$LEDGER" "$ids_text"$'\n' || refuse 65 "the ledger cannot be written"
fi
if [ -n "$LAST_LINE" ]; then
  write_atomic "$CURSOR_LINE" "$LAST_LINE"$'\n' || refuse 65 "the cursor cannot be written"
  c=$(sed -nE 's/.*"at_epoch":([0-9]{1,12}).*/\1/p' <<<"${LAST_LINE:0:$LINE_MAX}")
  S_CURSOR=${c:-$NOW}
fi
save
[ "$INTAKE" = 0 ] && [ "$OVERFLOWED" = 0 ] || record events.jsonl "{\"v\":1,\"at_epoch\":$NOW,\"intake\":$INTAKE,\"queued\":$QUEUED,\"coalesced\":$COALESCED,\"rejected\":$REJECTED,\"overflowed\":$OVERFLOWED}"
[ "$OVERFLOWED" = 0 ] || log "queue saturated: $OVERFLOWED event(s) counted, not queued (reported with the next delivery; the spool keeps them)"

# ---------------------------------------------------------------- 8. delivery (Pushover; the A5-R3 acceptance rules)
RESP="$WORK/response"
curl_tls() { [ -z "$CA_FILE" ] || printf 'cacert = "%s"\n' "$CA_FILE"; }
DELIVERED=0; RESULT=none; BATCHES=0
deliver_batch() { # one message of the oldest pending events, critical first; every included event line is WHOLE, never cut
  local files=() f text title='' msg='' pri=0 first='' n=0 more=0 code='' rc=0 body='' request='' batch='' idlist='' extra='' line='' sep=0 full=0
  local overflow='' reserve='' budget=0
  # The trailing metadata is reserved first, at its largest: the overflow counters, the remaining-events indicator (at most every queued
  # event) and the runbook. Lengths are of the escaped form ("\n" is two characters), never shorter than what the provider receives.
  if [ "$S_OVF_C" != 0 ] || [ "$S_OVF_O" != 0 ]; then
    overflow="OVERFLOW queue full: $S_OVF_C critical and $S_OVF_O other event(s) not queued individually; see alerts.jsonl on the host"
  fi
  reserve="\\n${overflow:+$overflow\\n}+$(queued) more queued\\nrunbook=$RUNBOOK"
  budget=$((MSG_MAX - ${#reserve}))
  for f in "$QUEUE"/*.json; do
    [[ $f =~ $QFILE_RE ]] || continue
    text=$(head -c 2048 -- "$f" 2>/dev/null || true)
    if ! [[ $text =~ $QRE ]]; then mv -f -- "$f" "$f.invalid" 2>/dev/null || rm -f -- "$f"; carrier_event spool_event_rejected queue_invalid; continue; fi
    extra=''
    [ -z "${BASH_REMATCH[8]}" ] || extra+=" reason=${BASH_REMATCH[8]}"
    [ -z "${BASH_REMATCH[9]}" ] || extra+=" problems=${BASH_REMATCH[9]}"
    [ "${BASH_REMATCH[7]}" = none ] || extra+=" incident=${BASH_REMATCH[7]}"
    [ "${BASH_REMATCH[10]}" = 1 ] || extra+=" x${BASH_REMATCH[10]}"
    line="${BASH_REMATCH[3]^^} ${BASH_REMATCH[2]}$extra at=${BASH_REMATCH[5]}"
    sep=0; [ -z "$msg" ] || sep=2
    # the first event that does not fit ends the batch (the order is kept): it and every later one stay queued for the next message
    if [ "$full" = 1 ] || [ "$n" -ge "$BATCH_MAX" ] || [ $((${#msg} + sep + ${#line})) -gt "$budget" ]; then full=1; more=$((more + 1)); continue; fi
    msg+="${msg:+\\n}$line"
    [ "${BASH_REMATCH[3]}" != critical ] || pri=1
    [ -n "$first" ] || first=${BASH_REMATCH[2]}
    idlist+=${BASH_REMATCH[1]}
    files+=("$f"); n=$((n + 1))
  done
  if [ "$n" = 0 ] && [ "$more" = 0 ] && [ -z "$overflow" ]; then RESULT=empty; return; fi
  if [ -n "$overflow" ]; then
    msg+="${msg:+\\n}$overflow"
    [ "$S_OVF_C" = 0 ] || pri=1
    first=${first:-queue_saturated}
  fi
  [ "$more" = 0 ] || msg+="\\n+$more more queued"
  msg+="\\nrunbook=$RUNBOOK"
  # Never sent cut or without an event: the queue stays exactly as it is (the stall check escalates a waiting critical event).
  if { [ "$n" = 0 ] && [ "$more" != 0 ]; } || [ "${#msg}" -gt "$MSG_MAX" ]; then
    RESULT=oversized
    log "delivery: the message would exceed ${MSG_MAX} characters or carry no event; nothing sent, every event stays queued"
    record deliveries.jsonl "{\"v\":1,\"at_epoch\":$(date +%s),\"outcome\":\"oversized\",\"events\":$n,\"remaining\":$more,\"length\":${#msg}}"
    return
  fi
  title="Nawara topology: ${first}"
  [ "$n" -le 1 ] || title+=" (+$((n - 1)))"
  batch=$(hash32 "$idlist|$S_OVF_C|$S_OVF_O"); batch=${batch:0:16}
  record deliveries.jsonl "{\"v\":1,\"at_epoch\":$(date +%s),\"outcome\":\"submitted\",\"batch\":\"$batch\",\"events\":$n,\"priority\":$pri}"
  rm -f -- "$RESP"
  code=$( {
    printf 'url = "%s"\n' "$PUSHOVER_URL"
    curl_tls
    printf 'data-urlencode = "token=%s"\ndata-urlencode = "user=%s"\n' "$PO_TOKEN" "$PO_USER"
    printf 'data-urlencode = "title=%s"\ndata-urlencode = "message=%s"\ndata-urlencode = "priority=%s"\n' "${title:0:250}" "$msg" "$pri"
  } | env -i PATH="$SAFE_PATH" timeout -k 2 $((CURL_TIMEOUT + 2)) curl -q --config - --silent --max-time "$CURL_TIMEOUT" \
      --proto '=https' --proto-redir '=https' --max-redirs 0 -o "$RESP" -w '%{http_code}' 2>/dev/null) || rc=$?
  body=$(head -c 2000 -- "$RESP" 2>/dev/null || true); rm -f -- "$RESP"
  request=''; [[ $body =~ \"request\":\"([0-9a-f-]{36})\" ]] && request=${BASH_REMATCH[1]}
  if [ "$rc" = 0 ] && [ "$code" = 200 ] && [[ $body =~ \"status\":1[,}] ]]; then
    RESULT=accepted
    rm -f -- "${files[@]}"
    S_OVF_C=0; S_OVF_O=0; S_FAILURES=0; S_BACKOFF=0
    DELIVERED=$((DELIVERED + n))
    record deliveries.jsonl "{\"v\":1,\"at_epoch\":$(date +%s),\"outcome\":\"accepted\",\"batch\":\"$batch\",\"events\":$n,\"http\":200,\"request\":\"$request\"}"
    return
  fi
  S_FAILURES=$((S_FAILURES + 1)); [ "$S_FAILURES" -le 999 ] || S_FAILURES=999
  if [ "$code" = 429 ] || [[ $code =~ ^4[0-9]{2}$ ]]; then
    RESULT=rejected; S_BACKOFF=$(($(date +%s) + 3600))
    log "receiver: Pushover rejected the request (HTTP $code; check the token, the user key and the quota): retrying in 3600 s"
  elif [ "$code" = 200 ] || [[ $code =~ ^3[0-9]{2}$ ]]; then
    RESULT=backoff; S_BACKOFF=$(($(date +%s) + 900))
    log "receiver: Pushover did not accept the message (HTTP $code): retrying in 900 s"
  else
    RESULT=retry; local wait=$((30 << (S_FAILURES < 5 ? S_FAILURES : 5))); [ "$wait" -le 900 ] || wait=900
    S_BACKOFF=$(($(date +%s) + wait))
    log "receiver: Pushover unreachable or failing (HTTP ${code:-none}, curl $rc): retrying in ${wait} s"
  fi
  record deliveries.jsonl "{\"v\":1,\"at_epoch\":$(date +%s),\"outcome\":\"$RESULT\",\"batch\":\"$batch\",\"events\":$n,\"http\":\"${code:-none}\",\"curl\":$rc}"
}
[ "$S_BACKOFF" -le $((NOW + 3600)) ] || S_BACKOFF=0   # a clock stepped backwards or a damaged value never stalls delivery
deliver_all() {
  if [ "$PO_OK" != 1 ]; then
    RESULT=no_credentials
  elif [ "$(date +%s)" -lt "$S_BACKOFF" ]; then
    RESULT=backing_off; log "receiver: backing off until $(iso "$S_BACKOFF"); queued events stay pending"
  else
    while [ "$BATCHES" -lt "$MAX_BATCHES" ] && [ "$SECONDS" -lt "$DELIVERY_DEADLINE" ]; do
      deliver_batch; BATCHES=$((BATCHES + 1))
      [ "$RESULT" = accepted ] || break
    done
  fi
}
deliver_all
save
PENDING=$(queued)
[ "$S_OVF_C" = 0 ] && [ "$S_OVF_O" = 0 ] || PENDING=$((PENDING + 1))
# Stalled: a critical event has waited more than STALL_SECONDS (escalated through the OTHER provider: the monitor's check fails).
STALLED=0
for f in "$QUEUE"/0-*.json; do
  [[ $f =~ $QFILE_RE ]] || continue
  if [[ $(head -c 2048 -- "$f" 2>/dev/null) =~ $QRE ]] && [ $((NOW - BASH_REMATCH[12])) -gt "$STALL_SECONDS" ]; then STALLED=1; break; fi
done
[ "$S_OVF_C" = 0 ] || STALLED=1

# ---------------------------------------------------------------- 9. the two independent heartbeats (Healthchecks.io)
# Healthchecks.io answers HTTP 200 even when it did NOT record a ping ("OK (not found)", "OK (rate limited)"): a ping counts only on
# HTTP 200 with the body exactly "OK". A bare GET to <check>/<exit status>; no body, nothing else sent.
HB_FAILED=0
ping_check() { # ping_check <base url> <exit status>: 0 recorded, 1 not
  local code rc=0 body
  rm -f -- "$RESP"
  code=$( { printf 'url = "%s/%s"\n' "$1" "$2"; curl_tls; } | env -i PATH="$SAFE_PATH" timeout -k 2 $((HEARTBEAT_TIMEOUT + 2)) curl -q --config - --silent \
      --max-time "$HEARTBEAT_TIMEOUT" --proto '=https' --proto-redir '=https' --max-redirs 0 -o "$RESP" -w '%{http_code}' 2>/dev/null) || rc=$?
  body=$(head -c 200 -- "$RESP" 2>/dev/null | tr -d '\r\n' || true); rm -f -- "$RESP"
  HB_HTTP=${code:-none}; HB_CURL=$rc
  [ "$rc" = 0 ] && [ "$code" = 200 ] && [ "$body" = OK ]
}
heartbeat() { # heartbeat <monitor|watchdog> <ok> <base url> <run epoch or empty> <exit status> <sent var> <missed var> <fail-alert var>
  local check=$1 ok=$2 url=$3 run=$4 status=$5 sent=$6 missed=$7 failv=$8
  [ -n "$run" ] || return 0
  if [ "$run" -gt $((NOW + 60)) ]; then record heartbeats.jsonl "{\"v\":1,\"at_epoch\":$NOW,\"check\":\"$check\",\"outcome\":\"future_run\",\"run_epoch\":$run}"; return 0; fi
  if [ "$run" -le "${!sent}" ]; then
    # nothing new: a run missing for longer than the window is recorded locally once (the external check alerts by itself)
    if [ $((NOW - run)) -gt "$HB_WINDOW" ] && [ "${!missed}" != "$run" ]; then
      printf -v "$missed" '%s' "$run"
      record heartbeats.jsonl "{\"v\":1,\"at_epoch\":$NOW,\"check\":\"$check\",\"outcome\":\"missed\",\"last_run_epoch\":$run}"
    fi
    return 0
  fi
  if [ $((NOW - run)) -gt "$HB_FRESH" ]; then
    # a completed run too old to stand for "now": never pinged (it would hide a gap); recorded once
    printf -v "$sent" '%s' "$run"
    record heartbeats.jsonl "{\"v\":1,\"at_epoch\":$NOW,\"check\":\"$check\",\"outcome\":\"stale_run_not_pinged\",\"run_epoch\":$run,\"status\":$status}"
    return 0
  fi
  if [ "$ok" != 1 ]; then HB_FAILED=1; return 0; fi
  if ping_check "$url" "$status"; then
    printf -v "$sent" '%s' "$run"
    record heartbeats.jsonl "{\"v\":1,\"at_epoch\":$NOW,\"check\":\"$check\",\"outcome\":\"sent\",\"run_epoch\":$run,\"status\":$status}"
  else
    HB_FAILED=1
    record heartbeats.jsonl "{\"v\":1,\"at_epoch\":$NOW,\"check\":\"$check\",\"outcome\":\"failed\",\"run_epoch\":$run,\"status\":$status,\"http\":\"$HB_HTTP\",\"curl\":$HB_CURL}"
    log "heartbeat: the $check check-in failed (HTTP $HB_HTTP, curl $HB_CURL); retried next cycle while the run is fresh"
    if [ $((NOW - ${!failv})) -ge "$REMINDER_SECONDS" ]; then printf -v "$failv" '%s' "$NOW"; carrier_event heartbeat_delivery_failed "$check"; fi
  fi
}
# The monitor: its last COMPLETED run (the evidence line it writes at the very end of a run).
M_RUN=''; M_STATUS=1
if safe_node "$STATE_DIR" d 077 && [ -f "$STATE_DIR/evidence.jsonl" ] && safe_node "$STATE_DIR/evidence.jsonl" f 077; then
  last=$( { tail -n 400 -- "$STATE_DIR/evidence.jsonl" | grep -F '"mode":"' || true; } | tail -n 1)
  if [ "${#last}" -le 2048 ] && [[ $last =~ $RUN_RE ]]; then
    M_RUN=${BASH_REMATCH[1]}
    case "${BASH_REMATCH[4]}:${BASH_REMATCH[3]}" in
      confirmed:*) M_STATUS=20 ;;      # contained: the control worked, but this is never a healthy PASS
      unconfirmed:*) M_STATUS=21 ;;
      none:PASS) M_STATUS=0 ;;
      none:UNKNOWN) M_STATUS=10 ;;
      *) M_STATUS=1 ;;
    esac
    if [ "$M_STATUS" = 0 ] && [ "$STALLED" = 1 ]; then M_STATUS=75; fi   # PASS, but its alerts cannot reach the Owner
  fi
fi
heartbeat monitor "$HC_M_OK" "$HC_MONITOR" "$M_RUN" "$M_STATUS" S_HB_M S_MISS_M S_HBF_M
# The watchdog: its own check-in (written at the very end of each watchdog run).
W_RUN=''; W_STATUS=1
if [ -f "$STATE_DIR/watchdog" ] && safe_node "$STATE_DIR/watchdog" f 077 && [[ $(head -c 512 -- "$STATE_DIR/watchdog") =~ $WATCHDOG_RE ]]; then
  W_RUN=${BASH_REMATCH[1]}
  case "${BASH_REMATCH[2]}" in ok | contained) W_STATUS=0 ;; *) W_STATUS=1 ;; esac
fi
heartbeat watchdog "$HC_W_OK" "$HC_WATCHDOG" "$W_RUN" "$W_STATUS" S_HB_W S_MISS_W S_HBF_W
save
# a heartbeat failure is an alert through the OTHER provider: delivered in this same cycle when the receiver is available
if [ "$HB_FAILED" = 1 ] && [ "$(queued)" -gt 0 ] && { [ "$RESULT" = accepted ] || [ "$RESULT" = empty ]; }; then deliver_all; save; fi
PENDING=$(queued)
[ "$S_OVF_C" = 0 ] && [ "$S_OVF_O" = 0 ] || PENDING=$((PENDING + 1))

log "cycle intake=$INTAKE queued=$QUEUED coalesced=$COALESCED rejected=$REJECTED overflowed=$OVERFLOWED delivered=$DELIVERED pending=$PENDING receiver=$RESULT monitor_run=${M_RUN:-none} monitor_status=$M_STATUS watchdog_run=${W_RUN:-none} watchdog_status=$W_STATUS integrity=$INTEGRITY"
[ "$CONFIG_OK" = 1 ] || exit 78
[ "$PENDING" = 0 ] || exit 3
[ "$HB_FAILED" = 0 ] || exit 4
exit 0
