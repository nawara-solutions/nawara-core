#!/usr/bin/env bash
# R3 operational alert carrier for auth-service readiness (ADR-0063 §4 item 10; docs/architecture/core-v2-a5-r3-alert-carrier.md).
#
# One cycle, run by auth-readiness-alert.timer every 60 s on the production host (never installed by this repository's tooling):
#   probe Auth's /ready inside its container (read-only) -> classify the state -> compare it with the durable state -> queue the
#   ALERT / CHANGED / REMINDER / RECOVERED / DEPLOYMENT / CARRIER_STARTED messages it implies -> deliver the queue, oldest first, to the
#   owner's receiver -> check in with the external heartbeat ONLY when the queue is empty and the cycle completed.
# Every /ready failure counts, not only hierarchy_authority. Nothing is suppressed, during G6/F6 windows included (O-R3-4).
#
# The carrier is READ-ONLY towards Auth: it runs `docker inspect`, `docker image inspect`, `docker logs` and one `docker exec … node -e`
# that reads /ready; it never restarts, stops or reconfigures anything and never reads a database or the marker directly.
#
# Configuration (environment; NON-secret values only):
#   RECEIVER_CONFIG   a curl config file (root-owned, mode 0600 or 0400, not a symlink) naming the receiver's URL and its credential
#   HEARTBEAT_CONFIG  the same for the heartbeat check-in (its secret URL is a credential too)
#   STATE_DIRECTORY   durable state, the delivery queue and the lock (systemd StateDirectory=; default /var/lib/nawara-auth-readiness-alert)
#   ALERT_HOST_LABEL  a non-secret label for this host        AUTH_CONTAINER   default nawara-core-auth-service
#   REMINDER_SECONDS  default 3600                            BOOT_ID_FILE     default /proc/sys/kernel/random/boot_id
# Credentials reach curl only through `--config <file>`: they are never in argv, the environment, the journal or a payload.
# Output (the journal) names states, message kinds and counts only: never a payload value beyond the allow-listed tokens, never a secret.
set -euo pipefail
umask 077
export LC_ALL=C
SECONDS=0   # the cycle's own clock (never inherited from the environment)

: "${RECEIVER_CONFIG:?RECEIVER_CONFIG is required (a protected curl config file for the receiver)}"
: "${HEARTBEAT_CONFIG:?HEARTBEAT_CONFIG is required (a protected curl config file for the heartbeat)}"
export -n RECEIVER_CONFIG HEARTBEAT_CONFIG   # paths only, but never handed to a child process
STATE_DIRECTORY=${STATE_DIRECTORY:-/var/lib/nawara-auth-readiness-alert}
STATE_DIRECTORY=${STATE_DIRECTORY%%:*}   # systemd may list several directories; the first is ours
CONTAINER=${AUTH_CONTAINER:-nawara-core-auth-service}
HOST_LABEL=${ALERT_HOST_LABEL:-unlabelled-host}
REMINDER_SECONDS=${REMINDER_SECONDS:-3600}
BOOT_ID_FILE=${BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}
RUNBOOK='docs/runbooks/auth-readiness-alerting.md'
INSPECT_TIMEOUT=5     # seconds for each of docker inspect, docker image inspect and docker logs
EXEC_TIMEOUT=15       # seconds for the docker exec that reads /ready
PROBE_TIMEOUT_MS=10000  # the in-container fetch deadline
CURL_TIMEOUT=8        # seconds for each delivery (the wrapping timeout allows 2 more)
HEARTBEAT_TIMEOUT=5   # seconds for the check-in (the wrapping timeout allows 2 more)
DELIVERY_DEADLINE=35  # no NEW delivery starts after this many seconds of the cycle: the rest stays queued for the next one
FIRST_WINDOW=15m      # the log window of a first cycle (no cursor yet)

log() { printf '[auth-readiness-alert] %s\n' "$*"; }
die() { printf '[auth-readiness-alert] ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------------------------- inputs, fail closed
TOKEN='^[A-Za-z0-9_.-]{1,64}$'
[[ $CONTAINER =~ ^[a-z0-9][a-z0-9_.-]{0,62}$ ]] || die "AUTH_CONTAINER is not a container name"
[[ $HOST_LABEL =~ $TOKEN ]] || die "ALERT_HOST_LABEL must be a short token ([A-Za-z0-9_.-])"
[[ $REMINDER_SECONDS =~ ^[0-9]{2,6}$ ]] || die "REMINDER_SECONDS must be a number of seconds"
protected() { # a credential file: present, regular, not a symlink, owned by us, no group/other access
  local f=$1 owner mode
  [ -f "$f" ] && [ ! -L "$f" ] || die "a credential file is missing or not a regular file ($2)"
  owner=$(stat -c '%u' "$f"); mode=$(stat -c '%a' "$f")
  [ "$owner" = "$(id -u)" ] || die "a credential file is not owned by the carrier's user ($2)"
  [[ $mode =~ ^[46]00$ ]] || die "a credential file is readable by others (mode $mode; $2): refusing"
}
protected "$RECEIVER_CONFIG" receiver
protected "$HEARTBEAT_CONFIG" heartbeat
mkdir -p "$STATE_DIRECTORY/queue"
chmod 700 "$STATE_DIRECTORY" "$STATE_DIRECTORY/queue"

# One cycle at a time: a cycle still running when the timer fires again makes the new one exit at once (no heartbeat from it).
exec 9>"$STATE_DIRECTORY/lock"
flock -n 9 || { log "another cycle is running; this one does nothing"; exit 0; }

STATE="$STATE_DIRECTORY/state"
NOW=$(date -u +%s)
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
NOW_ISO=$(iso "$NOW")

# ---------------------------------------------------------------------------------------------------------------- durable state
# key=value lines; every key is known and every value matches its pattern, else the whole state is "unknown" (never assumed ready).
declare -A P=( [state]='^(ready|not_ready|probe_failed)$' [failed]='^[a-z0-9_,-]{0,400}$' [probe_failure]='^(|container|unreachable|timeout|unparseable)$'
  [reason]='^(|source_ahead_of_marker|marker_ahead_of_source|marker_frozen|marker_missing|marker_invalid|marker_unreadable)$'
  [last_reported_reason]='^(|unknown|source_ahead_of_marker|marker_ahead_of_source|marker_frozen|marker_missing|marker_invalid|marker_unreadable)$'
  [source]='^(|local|organization-service)$' [marker]='^(|local|frozen|org_authoritative|missing|invalid|unreadable)$'
  [registry_code]='^[A-Za-z0-9_.-]{0,64}$' [diag_container]='^([0-9a-f]{64})?$' [container_id]='^([0-9a-f]{64})?$'
  [image]='^(|sha256:[0-9a-f]{64})$' [index_digest]='^(|none|sha256:[0-9a-f]{64})$' [revision]='^(|unlabelled|unrecognized|[0-9a-f]{7,40})$'
  [since]='^[0-9]{0,12}$' [last_message_at]='^[0-9]{0,12}$' [cursor]='^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)?$'
  [boot_id]='^[0-9a-f-]{0,40}$' [seq]='^[0-9]{1,12}$' )
declare -A S=()
STATE_KNOWN=no
if [ -f "$STATE" ]; then
  STATE_KNOWN=yes
  while IFS= read -r line; do
    [[ $line =~ ^([a-z_]+)=(.*)$ ]] || { STATE_KNOWN=no; break; }
    k=${BASH_REMATCH[1]}; v=${BASH_REMATCH[2]}
    [ -n "${P[$k]:-}" ] && [[ $v =~ ${P[$k]} ]] || { STATE_KNOWN=no; break; }
    S[$k]=$v
  done <"$STATE"
  [ -n "${S[state]:-}" ] || STATE_KNOWN=no
  [ "$STATE_KNOWN" = yes ] || { S=(); log "the state file is unreadable or invalid: treated as unknown"; }
fi
SEQ=${S[seq]:-0}
# The queue's own numbering continues after the highest queued file, whatever the state says.
# Only the carrier's own files count (twelve digits, a kind): anything else in the queue directory is ignored, never parsed.
QUEUE_RE='/[0-9]{12}-[A-Z_]{1,20}\.json$'
for f in "$STATE_DIRECTORY"/queue/*.json; do [[ $f =~ $QUEUE_RE ]] || continue; n=${f##*/}; n=$((10#${n%%-*})); [ "$n" -le "$SEQ" ] || SEQ=$n; done

# ---------------------------------------------------------------------------------------------------------------- probe (read-only)
BOOT_ID=$(tr -dc '0-9a-f-' <"$BOOT_ID_FILE" 2>/dev/null | head -c 40 || true)
CUR=no_container; CONTAINER_ID=''; IMAGE=''; REVISION=''; INDEX_DIGEST=''
info=$(timeout -k 2 "$INSPECT_TIMEOUT" docker container inspect -f '{{.Id}}|{{.State.Running}}|{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' "$CONTAINER" 2>/dev/null || true)
if [[ $info =~ ^([0-9a-f]{64})\|(true|false)\|(sha256:[0-9a-f]{64})\|(.*)$ ]]; then
  CONTAINER_ID=${BASH_REMATCH[1]}; running=${BASH_REMATCH[2]}; IMAGE=${BASH_REMATCH[3]}; label=${BASH_REMATCH[4]}
  if [ -z "$label" ] || [ "$label" = '<no value>' ]; then REVISION=unlabelled
  elif [[ $label =~ ^[0-9a-f]{7,40}$ ]]; then REVISION=$label
  else REVISION=unrecognized; fi
  digests=$(timeout -k 2 "$INSPECT_TIMEOUT" docker image inspect -f '{{range .RepoDigests}}{{.}} {{end}}' "$IMAGE" 2>/dev/null || true)
  INDEX_DIGEST=none
  if [[ $digests =~ @(sha256:[0-9a-f]{64}) ]]; then INDEX_DIGEST=${BASH_REMATCH[1]}; fi
  [ "$running" = true ] && CUR=running || CUR=stopped
fi

NEW_STATE=''; FAILED=''; PROBE_FAILURE=''; probe=''; probed=''
if [ "$CUR" != running ]; then
  NEW_STATE=probe_failed; PROBE_FAILURE=container
else
  # The abort timer is cleared as soon as the answer is read, so the in-container process exits at once (it never idles to the deadline).
  probe=$(timeout -k 2 "$EXEC_TIMEOUT" docker exec "$CONTAINER" node -e "const c = new AbortController(); const t = setTimeout(() => c.abort(), $PROBE_TIMEOUT_MS);
fetch('http://127.0.0.1:3000/ready', { signal: c.signal }).then(async (r) => console.log(r.status + ' ' + (await r.text()))).catch((e) => console.log(e && e.name === 'AbortError' ? 'timeout' : 'unreachable')).finally(() => clearTimeout(t))" 2>/dev/null) || probed=$?
  probed=${probed:-0}
  if [ "$probed" = 124 ] || [ "$probe" = timeout ]; then NEW_STATE=probe_failed; PROBE_FAILURE=timeout
  elif [ "$probed" != 0 ] || [ "$probe" = unreachable ]; then NEW_STATE=probe_failed; PROBE_FAILURE=unreachable
  elif [ "$probe" = '200 {"status":"ready"}' ]; then NEW_STATE=ready
  elif [[ $probe =~ ^503\ \{\"status\":\"unavailable\",\"failed\":\[(\"[a-z][a-z0-9_-]{0,40}\"(,\"[a-z][a-z0-9_-]{0,40}\"){0,31})\]\}$ ]]; then
    NEW_STATE=not_ready; FAILED=$(tr -d '"' <<<"${BASH_REMATCH[1]}")
  else NEW_STATE=probe_failed; PROBE_FAILURE=unparseable; fi
fi
unset probe

# ---------------------------------------------------------------------------------------------------------------- diagnostics
# Carried forward per container: Auth writes its reason line only when the reason changes, the registry its line only on a flip.
# Nothing is carried once Auth is ready again (Auth clears its own remembered reason then): a later failure whose line is lost reads
# `unknown`, never a stale reason.
REASON=''; SOURCE=''; MARKER=''; REG=''
if [ -n "$CONTAINER_ID" ] && [ "${S[diag_container]:-}" = "$CONTAINER_ID" ] && [ "$NEW_STATE" != ready ]; then
  REASON=${S[reason]:-}; SOURCE=${S[source]:-}; MARKER=${S[marker]:-}; REG=${S[registry_code]:-}
fi
LOGS_READ=no
if [ "$CUR" = running ]; then
  since=${S[cursor]:-}; [ -n "$since" ] || since=$FIRST_WINDOW
  ENV_RE='^\{"ts":"[0-9T:.Z-]{10,40}","level":"warn","service":"auth-service","msg":"'
  REASON_RE="${ENV_RE}"'hierarchy_authority_not_ready reason=([a-z_]+) source=([a-z-]+) marker=([a-z_]+)","context":"HierarchyAuthorityReadiness"[,}]'
  REG_RE="${ENV_RE}"'readiness_check_failed check=hierarchy_authority error=[A-Za-z][A-Za-z0-9_]{0,63}( code=([A-Za-z0-9_.-]{1,64}))?( kind=[a-z_]{1,40})? — /ready answers 503 until it recovers","context":"Readiness"[,}]'
  r_reason=''; r_source=''; r_marker=''; r_reg=''; r_reg_seen=no; r_after=''; r_after_seen=no
  logs=$(timeout -k 2 "$INSPECT_TIMEOUT" docker logs --since "$since" --tail 5000 "$CONTAINER" 2>&1) && LOGS_READ=yes || logs=''
  while IFS= read -r line; do
    [ "${#line}" -le 2000 ] || continue
    if [[ $line =~ $REASON_RE ]]; then
      # Copy the groups first: every later =~ test resets BASH_REMATCH.
      g_reason=${BASH_REMATCH[1]}; g_source=${BASH_REMATCH[2]}; g_marker=${BASH_REMATCH[3]}
      if [ "$g_reason" != unknown ] && [[ $g_reason =~ ${P[reason]} ]] && [[ $g_source =~ ^(local|organization-service)$ ]] \
        && [[ $g_marker =~ ^(local|frozen|org_authoritative|missing|invalid|unreadable)$ ]]; then
        r_reason=$g_reason; r_source=$g_source; r_marker=$g_marker
        r_after=''; r_after_seen=no   # only a registry line written AFTER this reason line is compared with it
      fi
    elif [[ $line =~ $REG_RE ]]; then
      r_reg_seen=yes; r_reg=${BASH_REMATCH[2]:-}; r_after_seen=yes; r_after=$r_reg
    fi
  done < <(tail -n 5000 <<<"$logs")
  unset logs
  # A newer recognized line replaces the carried one. A reason must agree with the registry code of a registry line that FOLLOWS it
  # (the registry logs only when the check flips, so an earlier registry line may legitimately carry the previous reason).
  if [ -n "$r_reason" ] && { [ "$r_after_seen" = no ] || [ -z "$r_after" ] || [ "$r_after" = "$r_reason" ]; }; then
    REASON=$r_reason; SOURCE=$r_source; MARKER=$r_marker
  fi
  [ "$r_reg_seen" = no ] || REG=$r_reg
  # A ready Auth has no reason: lines still inside the window belong to the failure that ended.
  [ "$NEW_STATE" != ready ] || { REASON=''; SOURCE=''; MARKER=''; REG=''; }
fi
# Reported only while /ready lists hierarchy_authority; `unknown` is a report value only (the state keeps recognized values alone).
RP_REASON=''; RP_SOURCE=''; RP_MARKER=''; RP_REG=''
if [ "$NEW_STATE" = not_ready ] && [[ ",$FAILED," == *,hierarchy_authority,* ]]; then
  RP_REASON=${REASON:-unknown}; RP_SOURCE=$SOURCE; RP_MARKER=$MARKER; RP_REG=$REG
fi

# ---------------------------------------------------------------------------------------------------------------- lifecycle
PREV=${S[state]:-unknown}
key_of() { printf '%s|%s|%s|%s' "$1" "$2" "$3" "$4"; }   # state | failed | probe_failure | reason
PREV_KEY=$(key_of "$PREV" "${S[failed]:-}" "${S[probe_failure]:-}" "${S[last_reported_reason]:-}")
SINCE_TS=${S[since]:-$NOW}; LAST_MSG=${S[last_message_at]:-0}
json_list() { local out='' x; IFS=',' read -ra xs <<<"$1"; for x in "${xs[@]}"; do [ -z "$x" ] || out+="${out:+,}\"$x\""; done; printf '[%s]' "$out"; }
enqueue() { # kind severity [previous]
  local kind=$1 sev=$2 prev=${3:-} f tmp dur=$((NOW - SINCE_TS))
  SEQ=$((SEQ + 1)); f=$(printf '%s/queue/%012d-%s.json' "$STATE_DIRECTORY" "$SEQ" "$kind"); tmp="$f.tmp"
  {
    printf '{"kind":"%s","severity":"%s","service":"auth-service","host":"%s","container":"%s"' "$kind" "$sev" "$HOST_LABEL" "$CONTAINER"
    printf ',"image":"%s","index_digest":"%s","revision":"%s"' "${IMAGE:-none}" "${INDEX_DIGEST:-none}" "${REVISION:-none}"
    printf ',"state":"%s","failed":%s' "$NEW_STATE" "$(json_list "$FAILED")"
    [ -z "$RP_REASON" ] || printf ',"reason":"%s","source":"%s","marker":"%s"' "$RP_REASON" "${RP_SOURCE:-unknown}" "${RP_MARKER:-unknown}"
    [ -z "$RP_REG" ] || printf ',"registry_code":"%s"' "$RP_REG"
    [ -z "$PROBE_FAILURE" ] || printf ',"probe_failure":"%s"' "$PROBE_FAILURE"
    [ -z "$prev" ] || printf ',"previous":"%s"' "$prev"
    if [ "$kind" = DEPLOYMENT ]; then printf ',"previous_image":"%s","previous_revision":"%s"' "${S[image]:-none}" "${S[revision]:-none}"; fi
    printf ',"since":"%s","duration_s":%d,"created_at":"%s","runbook":"%s"}\n' "$(iso "$SINCE_TS")" "$dur" "$NOW_ISO" "$RUNBOOK"
  } >"$tmp"
  sync "$tmp"; mv "$tmp" "$f"   # flushed before it is renamed: a power loss never leaves an empty queued message
  LAST_MSG=$NOW; QUEUED=$((QUEUED + 1))
}
QUEUED=0
NEW_KEY=$(key_of "$NEW_STATE" "$FAILED" "$PROBE_FAILURE" "$RP_REASON")
# "unknown" is never a change: compared as the previous reason.
if [ "$RP_REASON" = unknown ] && [ "${S[state]:-}" = not_ready ]; then
  NEW_KEY=$(key_of "$NEW_STATE" "$FAILED" "$PROBE_FAILURE" "${S[last_reported_reason]:-unknown}")
fi

if [ "$STATE_KNOWN" = no ] || [ "${S[boot_id]:-}" != "$BOOT_ID" ]; then
  enqueue CARRIER_STARTED info
fi
if [ -n "${S[image]:-}" ] && [ -n "$IMAGE" ] && [ "${S[image]}" != "$IMAGE" ]; then
  enqueue DEPLOYMENT info
fi
if [ "$NEW_STATE" = ready ]; then
  if [ "$PREV" = not_ready ] || [ "$PREV" = probe_failed ]; then enqueue RECOVERED info "$PREV"; fi
  SINCE_TS=$NOW
elif [ "$PREV" != not_ready ] && [ "$PREV" != probe_failed ]; then
  SINCE_TS=$NOW; enqueue ALERT critical "$PREV"
elif [ "$NEW_KEY" != "$PREV_KEY" ]; then
  enqueue CHANGED critical "$PREV"
elif [ $((NOW - ${S[last_message_at]:-0})) -ge "$REMINDER_SECONDS" ]; then
  enqueue REMINDER critical
fi

# The reason the lifecycle compares with next time: a reported "unknown" never replaces a known one for the same failure.
LAST_REPORTED=$RP_REASON
if [ "$RP_REASON" = unknown ] && [ "${S[state]:-}" = not_ready ] && [ -n "${S[last_reported_reason]:-}" ]; then LAST_REPORTED=${S[last_reported_reason]}; fi

# Persist BEFORE delivering: a crash during delivery loses nothing (the queue is on disk). Delivery is AT-LEAST-ONCE: a cycle killed
# after the receiver accepted a message but before its file is removed sends that message again.
write_state() {
  local tmp="$STATE.tmp" k
  {
    printf 'state=%s\nfailed=%s\nprobe_failure=%s\n' "$NEW_STATE" "$FAILED" "$PROBE_FAILURE"
    printf 'reason=%s\nsource=%s\nmarker=%s\nregistry_code=%s\ndiag_container=%s\n' "$REASON" "$SOURCE" "$MARKER" "$REG" "$CONTAINER_ID"
    printf 'container_id=%s\nimage=%s\nindex_digest=%s\nrevision=%s\n' "$CONTAINER_ID" "$IMAGE" "$INDEX_DIGEST" "$REVISION"
    printf 'last_reported_reason=%s\n' "$LAST_REPORTED"
    printf 'since=%s\nlast_message_at=%s\ncursor=%s\nboot_id=%s\nseq=%s\n' "$SINCE_TS" "$LAST_MSG" "$CURSOR" "$BOOT_ID" "$SEQ"
  } >"$tmp"
  sync "$tmp"; mv "$tmp" "$STATE"
}
# The next cycle reads the logs from THIS cycle's probe start, so a line written meanwhile (by this probe or an operator's) is not missed.
# The cursor advances only when the logs were actually read: a failed or timed-out read is retried over the same window next cycle.
CURSOR=$NOW_ISO
[ "$CUR" = running ] && [ "$LOGS_READ" = yes ] || CURSOR=${S[cursor]:-}
# Keep the stored image when the container is gone, so its return is still compared with the last one seen.
[ -n "$IMAGE" ] || { IMAGE=${S[image]:-}; INDEX_DIGEST=${S[index_digest]:-}; REVISION=${S[revision]:-}; }
write_state

# ---------------------------------------------------------------------------------------------------------------- delivery
DELIVERED=0; PENDING=0
for f in "$STATE_DIRECTORY"/queue/*.json; do
  [[ $f =~ $QUEUE_RE ]] || continue
  [ "$SECONDS" -lt "$DELIVERY_DEADLINE" ] || break   # the cycle's time budget: the rest stays queued (exit 3, no check-in)
  if timeout -k 2 $((CURL_TIMEOUT + 2)) curl -q --config "$RECEIVER_CONFIG" --fail --silent --show-error --max-time "$CURL_TIMEOUT" \
      --proto '=https' --proto-redir '=https' --max-redirs 0 -H 'Content-Type: application/json' --data-binary "@$f" -o /dev/null >/dev/null 2>&1; then
    rm -f "$f"; DELIVERED=$((DELIVERED + 1))
  else
    break   # keep the order: nothing after an undelivered message is sent before it
  fi
done
for f in "$STATE_DIRECTORY"/queue/*.json; do [[ $f =~ $QUEUE_RE ]] && PENDING=$((PENDING + 1)); done

# ---------------------------------------------------------------------------------------------------------------- heartbeat
HB=withheld
if [ "$PENDING" = 0 ]; then
  if timeout -k 2 $((HEARTBEAT_TIMEOUT + 2)) curl -q --config "$HEARTBEAT_CONFIG" --fail --silent --show-error --max-time "$HEARTBEAT_TIMEOUT" \
      --proto '=https' --proto-redir '=https' --max-redirs 0 -o /dev/null >/dev/null 2>&1; then HB=sent; else HB=failed; fi
fi
log "cycle state=$NEW_STATE failed=${FAILED:-none} probe_failure=${PROBE_FAILURE:-none} reason=${RP_REASON:-none} queued=$QUEUED delivered=$DELIVERED pending=$PENDING heartbeat=$HB logs=$LOGS_READ"
[ "$PENDING" = 0 ] || exit 3      # undelivered alerts: the unit fails, the heartbeat stays silent, the queue is retried next cycle
[ "$HB" = sent ] || exit 4
