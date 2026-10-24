#!/usr/bin/env bash
# Core V2 OD-BRK-2b-R: the guard of the Owner-authorized RECOVERY of Notification's containment, on a SIGNED, INCIDENT-BOUND
# authorization (docs/runbooks/rabbitmq-topology-containment.md §5). Installed root-owned in INSTALL_DIR by the separately authorized
# installation, and run as root on the host. Never run by a timer, a key or a workflow; never installed by repository tooling.
#
#   recover-notification-topology.sh          (no argument: nothing a caller passes selects a file, a service or a vhost)
#
# The authorization is two files the Owner places in the root-only inbox (INBOX): `authorization`, the canonical text below, and
# `authorization.sig`, its OpenSSH signature (`ssh-keygen -Y sign -n nawara-core-topology-recovery`). The private key never reaches the
# host; the host holds only TRUSTED_SIGNERS, one `allowed_signers` line for PRINCIPAL restricted to NAMESPACE. The canonical text, byte
# for byte (LF line ends, exactly these nine lines in this order, one final LF, at most 1024 bytes, nothing else):
#   nawara-core-topology-recovery-authorization v1
#   operation=notification.topology_recovery
#   service=notification-service
#   vhost=nawara-core
#   incident=<32 lowercase hex: the current containment incident>
#   nonce=<32 lowercase hex, single use>
#   issued_at=<unix seconds>
#   not_after=<unix seconds; at most MAX_VALIDITY after issued_at>
#   reason=<[A-Za-z0-9][A-Za-z0-9._-]{0,63}: an operational reference>
#
# Under the monitor's own lock it requires, in order, and refuses (changing nothing) at the first failure:
#   1. an intact installation and verifier pin; a valid v2 state that says contained, with an incident; the latch contained and the
#      incident bound next to it equal to the state's; the containment holding (two read-backs: no grant, no topic grant, no connection);
#   2. the trusted key: one exact line, root-owned, not writable by group or others, no symbolic link (a wildcard or another principal,
#      another namespace, an option or a second key is refused: `ssh-keygen -Y verify` would accept a wildcard principal);
#   3. the authorization: root-owned private copies of both files, the canonical text exactly, a good signature by PRINCIPAL in NAMESPACE;
#   4. its binding: this operation, service and vhost; the CURRENT incident; issued no later than CLOCK_SKEW from now, not expired, a
#      validity window of at most MAX_VALIDITY; a nonce never consumed;
#   5. a FRESH verification (the pinned OD-BRK-2a verifier, pre-grant) whose only non-passing check is L1 latch_contained.
# Then: the nonce is consumed (appended to STATE_DIR/recovery-consumed and flushed) BEFORE anything changes; the decision recorded; the
# state cleared (contained=0, no incident), then the latch `state=inactive`, then the incident binding; a full verification again (on any
# doubt the SAME incident is contained again). A crash at any point leaves the service contained or re-contained by the next monitor run,
# and the consumed nonce can never be used again. It NEVER grants: Notification is granted again only by protected provisioning, whose own
# gates run again. No replay, no queue deletion, no data change.
#
# Exit: 0 the latch was cleared (Notification still holds no grant); 1 refused after the checks (nothing changed, or the incident was
# contained again); 2 an invalid invocation, not root, or a tool missing (nothing was checked); 65 the installation, the trusted key or
# the inbox is unsafe; 66 the verifier does not match its pin; 75 the monitor's lock could not be taken.
set -euo pipefail
umask 077
export LC_ALL=C

# Pinned values (scripts/check-repo.mjs, checkTopologyMonitor; equal to verify-and-contain.sh where they overlap).
readonly SERVICE='notification-service'
readonly VHOST='nawara-core'
readonly OPERATION='notification.topology_recovery'
readonly INSTALL_DIR='/usr/local/libexec/nawara-core-topology'
readonly STATE_DIR='/var/lib/nawara-core-topology-monitor'
readonly LATCH='/var/lib/nawara-core-topology/notification-service.containment'
readonly INCIDENT_FILE='/var/lib/nawara-core-topology/notification-service.incident'
readonly TRUSTED_SIGNERS='/etc/nawara-core-topology/recovery-allowed-signers'
readonly PRINCIPAL='nawara-core-owner'
readonly NAMESPACE='nawara-core-topology-recovery'
readonly MAX_VALIDITY=3600
readonly CLOCK_SKEW=120
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
readonly STATE_RE=$'^nawara-core-topology-monitor-state v2\nservice=notification-service\ncontained=([01])\nincident=(none|[0-9a-f]{32})\nunknown_streak=([0-9]{1,3})\nlast_result=(NONE|PASS|FAIL|UNKNOWN)\nlast_run=([0-9]{1,12})$'
readonly INCIDENT_RE=$'^nawara-core-topology-incident v1\nservice=notification-service\nincident=(none|[0-9a-f]{32})$'
readonly AUTH_RE=$'^nawara-core-topology-recovery-authorization v1\noperation=([a-z._]{1,64})\nservice=([a-z-]{1,64})\nvhost=([a-z-]{1,64})\nincident=([0-9a-f]{32})\nnonce=([0-9a-f]{32})\nissued_at=([1-9][0-9]{8,11})\nnot_after=([1-9][0-9]{8,11})\nreason=([A-Za-z0-9][A-Za-z0-9._-]{0,63})\n$'
readonly SIG_RE=$'^-----BEGIN SSH SIGNATURE-----\n([A-Za-z0-9+/=]{1,76}\n){1,40}-----END SSH SIGNATURE-----\n$'
readonly SIGNER_RE='^nawara-core-owner namespaces="nawara-core-topology-recovery" (ssh-ed25519|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]{40,400}={0,2}$'
PATH=$SAFE_PATH
export PATH

usage() { printf '[topology-recovery] REFUSED: %s\nusage: recover-notification-topology.sh (no argument)\n' "$*" >&2; exit 2; }
stop() { printf '[topology-recovery] REFUSED (%s): %s; containment unchanged\n' "$1" "$2" >&2; exit 1; }
unsafe() { printf '[topology-recovery] REFUSED: %s; containment unchanged\n' "$*" >&2; exit 65; }
log() { printf '[topology-recovery] %s\n' "$*"; }

[ -z "${SSH_ORIGINAL_COMMAND:-}" ] || usage "never run through a forced command"
[ "$#" -eq 0 ] || usage "takes no argument (the authorization is read from the root-only inbox only)"
[ "$EUID" -eq "$RUN_AS_UID" ] || usage "run as root on the host"
for c in bash docker flock timeout sha256sum ssh-keygen stat readlink dirname mktemp mv cp sync date head tail grep awk cut tr sleep wc rm; do
  command -v "$c" >/dev/null 2>&1 || usage "$c is required; nothing was checked"
done

safe_node() { # safe_node <path> <d|f> <octal mask>: exists as that kind, no symbolic link, owned by OWNER_UID, (mode & mask) == 0
  local p=$1 kind=$2 mask=$3 owner mode
  [ ! -L "$p" ] || return 1
  if [ "$kind" = d ]; then [ -d "$p" ] || return 1; else [ -f "$p" ] || return 1; fi
  owner=$(stat -c %u -- "$p") && mode=$(stat -c %a -- "$p") || return 1
  [ "$owner" = "$OWNER_UID" ] && (( (8#$mode & 8#$mask) == 0 ))
}
VERIFIER="$INSTALL_DIR/verify-topology.sh"
[ "$(readlink -f -- "$INSTALL_DIR")" = "$INSTALL_DIR" ] && safe_node "$INSTALL_DIR" d 022 && safe_node "$VERIFIER" f 022 \
  || unsafe "the installation in $INSTALL_DIR is unsafe"
got=$(sha256sum -- "$VERIFIER"); got=${got%% *}
[ "$got" = "$VERIFIER_SHA256" ] || { printf '[topology-recovery] REFUSED: the installed verifier does not match its pin; containment unchanged\n' >&2; exit 66; }
safe_node "$STATE_DIR" d 077 || unsafe "$STATE_DIR is unsafe or missing"
[ ! -L "$STATE_DIR/lock" ] || unsafe "$STATE_DIR/lock is a symbolic link"
exec 9>>"$STATE_DIR/lock"
flock -w "$LOCK_WAIT" 9 || { printf '[topology-recovery] REFUSED: the monitor holds its lock; containment unchanged\n' >&2; exit 75; }

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
exact() { # exact <variable> <file>: the file's bytes into the variable, trailing newlines kept; fails on a NUL byte or over 4096 bytes
  local f=$2 text size
  size=$(stat -c %s -- "$f") || return 1
  [ "$size" -le 4096 ] || return 1
  text=$(cat -- "$f" 2>/dev/null; printf x) || return 1
  text=${text%x}
  [ "${#text}" -eq "$size" ] || return 1
  printf -v "$1" '%s' "$text"
}
latch_is() { # latch_is <inactive|contained>
  safe_node "$(dirname -- "$LATCH")" d 022 && safe_node "$LATCH" f 022 || return 1
  case "$1" in inactive) [ "$(head -c 512 -- "$LATCH")" = "$LATCH_INACTIVE" ] ;; *) [ "$(head -c 512 -- "$LATCH")" = "$LATCH_CONTAINED" ] ;; esac
}
bound_incident() {
  local text
  safe_node "$INCIDENT_FILE" f 022 || { echo invalid; return; }
  text=$(head -c 256 -- "$INCIDENT_FILE" 2>/dev/null) || { echo invalid; return; }
  [[ $text =~ $INCIDENT_RE ]] && echo "${BASH_REMATCH[1]}" || echo invalid
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
record() { # record <kind> <extra json>: the evidence (never required for the decision)
  printf '%s\n' "{\"v\":1,\"at\":\"$(iso)\",\"at_epoch\":$(now),\"service\":\"$SERVICE\",\"kind\":\"$1\",\"incident\":\"$INCIDENT\"$2}" >>"$STATE_DIR/evidence.jsonl" 2>/dev/null \
    || log "evidence record unavailable"
}
contain_again() { # the SAME incident, contained again (state, binding, latch), after a doubt once the latch was touched
  write_atomic "$STATE_DIR/state" "$(printf 'nawara-core-topology-monitor-state v2\nservice=%s\ncontained=1\nincident=%s\nunknown_streak=0\nlast_result=UNKNOWN\nlast_run=%s\n' "$SERVICE" "$INCIDENT" "$(now)")" 600 || true
  write_atomic "$INCIDENT_FILE" "$(printf 'nawara-core-topology-incident v1\nservice=%s\nincident=%s' "$SERVICE" "$INCIDENT")" 644 || true
  write_atomic "$LATCH" "$LATCH_CONTAINED" 644 || true
  latch_is contained || printf '[topology-recovery] CRITICAL: the latch could not be put back to contained; the monitor re-contains on its next run\n' >&2
}

# 1. The containment this recovery would end.
INCIDENT=none
text=$(head -c 4096 -- "$STATE_DIR/state" 2>/dev/null || true)
safe_node "$STATE_DIR/state" f 077 && [[ $text =~ $STATE_RE ]] || stop state_invalid "the monitor's state is missing, invalid or of an older schema (a containment without an incident is never recovered)"
[ "${BASH_REMATCH[1]}" = 1 ] && [ "${BASH_REMATCH[2]}" != none ] || stop not_contained "the monitor's state does not record a contained incident: there is nothing to recover"
INCIDENT=${BASH_REMATCH[2]}
latch_is contained || stop latch_invalid "the containment latch is not a valid, root-owned 'contained' latch"
[ "$(bound_incident)" = "$INCIDENT" ] || stop incident_binding "the incident bound next to the latch is not the state's incident"
held && { sleep "$CONFIRM_INTERVAL"; held; } || stop containment_not_holding "the containment does not hold (a grant or a connection of $SERVICE exists): investigate first"

# 2. The trusted key (the only one the host holds; a separately authorized key-lifecycle operation installs or replaces it).
safe_node "$(dirname -- "$TRUSTED_SIGNERS")" d 022 && safe_node "$TRUSTED_SIGNERS" f 022 || unsafe "the trusted key $TRUSTED_SIGNERS is missing or unsafe (recovery is impossible until a separately authorized key installation)"
exact signers "$TRUSTED_SIGNERS" || unsafe "the trusted key file is unreadable, too large or not text"
lines=$(grep -vE '^[[:space:]]*(#|$)' <<<"$signers" || true)
[ "$(grep -c '' <<<"$lines")" -eq 1 ] && [[ $lines =~ $SIGNER_RE ]] || unsafe "the trusted key file must hold exactly one line: $PRINCIPAL namespaces=\"$NAMESPACE\" <ssh-ed25519 key>"

# 3. The authorization: private, root-owned copies (no later substitution), then the canonical text and the signature.
INBOX="$STATE_DIR/recovery"
safe_node "$INBOX" d 077 || unsafe "the inbox $INBOX is missing or unsafe"
for f in authorization authorization.sig; do
  safe_node "$INBOX/$f" f 022 || stop authorization_file "$INBOX/$f is missing, not a regular root-owned file, or writable by group or others"
done
WORK=$(mktemp -d -- "$STATE_DIR/.recovery.XXXXXXXX") || unsafe "no private work directory"
trap 'rm -rf -- "$WORK"' EXIT
cp -- "$INBOX/authorization" "$WORK/authorization" && cp -- "$INBOX/authorization.sig" "$WORK/authorization.sig" || stop authorization_file "the authorization could not be copied"
exact auth "$WORK/authorization" || stop authorization_format "the authorization is unreadable, too large or contains a NUL byte"
[ "$(stat -c %s -- "$WORK/authorization")" -le 1024 ] || stop authorization_format "the authorization exceeds 1024 bytes"
if [[ $auth =~ ^nawara-core-topology-recovery-authorization\ v([0-9]{1,4})$'\n' ]] && [ "${BASH_REMATCH[1]}" != 1 ]; then stop authorization_version "unsupported authorization version"; fi
[[ $auth =~ $AUTH_RE ]] || stop authorization_format "the authorization is not exactly the canonical nine lines (order, fields, encoding, one final newline)"
A_OPERATION=${BASH_REMATCH[1]}; A_SERVICE=${BASH_REMATCH[2]}; A_VHOST=${BASH_REMATCH[3]}; A_INCIDENT=${BASH_REMATCH[4]}; A_NONCE=${BASH_REMATCH[5]}
A_ISSUED=${BASH_REMATCH[6]}; A_NOT_AFTER=${BASH_REMATCH[7]}; A_REASON=${BASH_REMATCH[8]}
exact sig "$WORK/authorization.sig" || stop signature_format "the signature is unreadable or too large"
[[ $sig =~ $SIG_RE ]] || stop signature_format "the signature is not one armored OpenSSH signature"
verdict=$(env -i PATH="$SAFE_PATH" timeout 10 ssh-keygen -Y verify -f "$TRUSTED_SIGNERS" -I "$PRINCIPAL" -n "$NAMESPACE" -s "$WORK/authorization.sig" <"$WORK/authorization" 2>/dev/null) \
  || stop signature_invalid "the signature does not verify for $PRINCIPAL in $NAMESPACE against the trusted key"
[[ $verdict =~ ^Good\ \"$NAMESPACE\"\ signature\ for\ $PRINCIPAL\ with\ (ED25519|ED25519-SK)\ key\ (SHA256:[A-Za-z0-9+/]{43})$ ]] || stop signature_invalid "an unexpected verification answer"
FINGERPRINT=${BASH_REMATCH[2]}

# 4. The binding.
[ "$A_OPERATION" = "$OPERATION" ] || stop authorization_operation "the authorization is not for $OPERATION"
[ "$A_SERVICE" = "$SERVICE" ] && [ "$A_VHOST" = "$VHOST" ] || stop authorization_target "the authorization is not for $SERVICE in $VHOST"
[ "$A_INCIDENT" = "$INCIDENT" ] || stop authorization_incident "the authorization names another incident"
NOW=$(now)
[ "$A_NOT_AFTER" -gt "$A_ISSUED" ] && [ $((A_NOT_AFTER - A_ISSUED)) -le "$MAX_VALIDITY" ] || stop authorization_window "the validity window is empty or longer than ${MAX_VALIDITY}s"
[ "$A_ISSUED" -le $((NOW + CLOCK_SKEW)) ] || stop authorization_window "the authorization is issued in the future"
[ "$NOW" -le "$A_NOT_AFTER" ] || stop authorization_expired "the authorization has expired"
CONSUMED="$STATE_DIR/recovery-consumed"
if [ -e "$CONSUMED" ] || [ -L "$CONSUMED" ]; then
  safe_node "$CONSUMED" f 077 || unsafe "$CONSUMED is unsafe"
  ! grep -qF " nonce=$A_NONCE " -- "$CONSUMED" || stop authorization_replay "this authorization's nonce was already consumed"
fi

# 5. A fresh verification: the latch must be the ONLY non-passing check.
rc=0; line=$(verify_pre_grant) || rc=$?
others=$( { grep -oE '"id":"[A-Z][0-9]","status":"[A-Z_]+","reason":"[a-z_]+"' <<<"$line" || true; } \
  | grep -vE '"status":"(PASS|NOT_APPLICABLE_PRE_CREATION)"' | grep -vxF '"id":"L1","status":"FAIL","reason":"latch_contained"' || true)
[ "$rc" -eq 1 ] && grep -qF '"id":"L1","status":"FAIL","reason":"latch_contained"' <<<"$line" && blank "$others" \
  || stop topology_unsafe "the fresh verification does not pass apart from the latch (exit $rc; failing: $( { grep -oE '"id":"[A-Z][0-9]"' <<<"$others" || true; } | cut -d'"' -f4 | tr '\n' ' '))"

# 6. Consume the nonce (durably, BEFORE any change); then the decision.
printf 'v1 nonce=%s incident=%s at=%s\n' "$A_NONCE" "$INCIDENT" "$NOW" >>"$CONSUMED" && chmod 600 -- "$CONSUMED" && sync -- "$CONSUMED" \
  || stop consumption_failed "the authorization could not be durably consumed"
grep -qF " nonce=$A_NONCE incident=$INCIDENT " -- "$CONSUMED" || stop consumption_failed "the consumption could not be read back"
record recovery_authorized ",\"nonce\":\"$A_NONCE\",\"reason\":\"$A_REASON\",\"issued_at\":$A_ISSUED,\"not_after\":$A_NOT_AFTER,\"signer\":\"$FINGERPRINT\""

# 7. Clear: the state, then the latch, then the binding (a crash in between leaves a contained latch, or a state the monitor re-contains).
write_atomic "$STATE_DIR/state" "$(printf 'nawara-core-topology-monitor-state v2\nservice=%s\ncontained=0\nincident=none\nunknown_streak=0\nlast_result=PASS\nlast_run=%s\n' "$SERVICE" "$(now)")" 600 \
  || { contain_again; stop state_write "the monitor's state could not be written; the incident stays contained"; }
write_atomic "$LATCH" "$LATCH_INACTIVE" 644 || { contain_again; stop latch_write "the latch could not be written; the incident stays contained"; }
write_atomic "$INCIDENT_FILE" "$(printf 'nawara-core-topology-incident v1\nservice=%s\nincident=none' "$SERVICE")" 644 || log "the incident binding could not be cleared (it is rewritten by the next containment)"

# 8. A full verification with the latch cleared; on any doubt the same incident is contained again.
rc=0; line=$(verify_pre_grant) || rc=$?
if [ "$rc" -ne 0 ] || ! latch_is inactive; then
  contain_again
  record recovery_reverted ",\"nonce\":\"$A_NONCE\""
  printf '[topology-recovery] REFUSED: the verification with the latch cleared did not pass (exit %s); incident %s is contained again (the authorization is consumed)\n' "$rc" "$INCIDENT" >&2
  exit 1
fi
rm -f -- "$INBOX/authorization" "$INBOX/authorization.sig"
record recovered ",\"nonce\":\"$A_NONCE\",\"reason\":\"$A_REASON\",\"signer\":\"$FINGERPRINT\""
printf '%s\n' "{\"v\":1,\"at\":\"$(iso)\",\"at_epoch\":$(now),\"service\":\"$SERVICE\",\"severity\":\"info\",\"kind\":\"recovered\",\"incident\":\"$INCIDENT\"}" >>"$STATE_DIR/alerts.jsonl" 2>/dev/null || log "alert spool unavailable"
log "incident $INCIDENT recovered (signed by $FINGERPRINT, reference $A_REASON). $SERVICE holds NO grant: grant it only through protected provisioning, whose gates run again."
exit 0
