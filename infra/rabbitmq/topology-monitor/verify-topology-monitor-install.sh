#!/usr/bin/env bash
# Core V2 OD-BRK-2b-I: the READ-ONLY verification of the topology monitor's installation (docs/runbooks/rabbitmq-topology-containment.md
# §2). The Owner runs it as root at the console after an installation, an upgrade or a repair, and before any separately authorized
# enablement, and records its output. It creates, writes, moves and deletes no file, starts and enables no unit, and touches no broker.
#
# Its authority is the Owner-SIGNED manifest recorded by the installer (INSTALL_STATE/installed), verified against the installation
# trust key, never hashes kept on the server: every installed artifact must equal it. It checks the artifacts (hash, owner, mode, one
# link, no symbolic link, nothing extra), every ancestor directory, the units (content, hardening, no drop-in or same-named override in
# any unit directory systemd reads, enabled only under a signed activation authorization), the protected state (the marker, a valid
# state, the incident binding, the inbox, the latch), the recovery trust key if present, and the optional trigger (its sudoers rule and
# its forced-command key, separate from the scheduled-backup key) if present. Absent optional parts are reported as not configured.
#
# Output: one line per check (`ok`, `FAIL`, `UNKNOWN` (could not be determined) or `info`) with a reason code; no secret, no key, no
# authorized_keys line is printed (only fingerprints, hashes, modes). Exit: 0 PASS (every check passed); 1 FAIL (at least one failed);
# 3 UNKNOWN (none failed, at least one could not be determined; never PASS); 2 invalid invocation, not root or a tool missing.
set -euo pipefail
umask 077
export LC_ALL=C

# Pinned values (scripts/check-repo.mjs, checkTopologyMonitor; equal to the installer's).
readonly INSTALL_DIR='/usr/local/libexec/nawara-core-topology'
readonly STATE_DIR='/var/lib/nawara-core-topology-monitor'
readonly LATCH='/var/lib/nawara-core-topology/notification-service.containment'
readonly INCIDENT_FILE='/var/lib/nawara-core-topology/notification-service.incident'
readonly UNIT_DIR='/etc/systemd/system'
readonly INSTALL_STATE='/var/lib/nawara-core-topology-install'
readonly INSTALL_TRUST='/etc/nawara-core-topology/install-allowed-signers'
readonly TRUSTED_SIGNERS='/etc/nawara-core-topology/recovery-allowed-signers'
readonly PRINCIPAL='nawara-core-owner'
readonly INSTALL_NAMESPACE='nawara-core-topology-install'
readonly SYSTEMCTL='/usr/bin/systemctl'
readonly SSHD='/usr/sbin/sshd'
readonly SUDOERS='/etc/sudoers'
readonly SUDOERS_DIR='/etc/sudoers.d'
readonly TRIGGER_SUDOERS='/etc/sudoers.d/nawara-core-topology-trigger'
readonly UNIT_SEARCH='/etc/systemd/system.control /run/systemd/system.control /run/systemd/transient /run/systemd/generator.early /etc/systemd/system /etc/systemd/system.attached /run/systemd/system /run/systemd/system.attached /run/systemd/generator /usr/local/lib/systemd/system /usr/lib/systemd/system /lib/systemd/system /run/systemd/generator.late'
readonly OWNER_UID=0
readonly OWNER_GID=0
readonly RUN_AS_UID=0
readonly TRUST_ROOT='/'
readonly SAFE_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
readonly SCRIPTS='verify-and-contain.sh topology-watchdog.sh topology-trigger.sh recover-notification-topology.sh install-topology-monitor.sh verify-topology-monitor-install.sh'
readonly UNITS='nawara-core-topology-monitor.service nawara-core-topology-monitor.timer nawara-core-topology-watchdog.service nawara-core-topology-watchdog.timer'
readonly TRIGGER_OPTIONS='restrict,command="/usr/local/libexec/nawara-core-topology/topology-trigger.sh"'
readonly TRIGGER_COMMENT='nawara-core-topology-trigger'
readonly BACKUP_COMMENT='nawara-core-scheduled-backup'
readonly LATCH_INACTIVE=$'nawara-core-topology-containment v1\nservice=notification-service\nstate=inactive'
readonly LATCH_CONTAINED=$'nawara-core-topology-containment v1\nservice=notification-service\nstate=contained'
readonly STATE_RE=$'^nawara-core-topology-monitor-state v2\nservice=notification-service\ncontained=([01])\nincident=(none|[0-9a-f]{32})\nunknown_streak=([0-9]{1,3})\nlast_result=(NONE|PASS|FAIL|UNKNOWN)\nlast_run=([0-9]{1,12})$'
readonly INCIDENT_RE=$'^nawara-core-topology-incident v1\nservice=notification-service\nincident=(none|[0-9a-f]{32})$'
readonly MARKER_RE='^nawara-core-topology-monitor installed v1 at=[0-9]{1,12}$'
readonly INSTALL_SIGNER_RE='^nawara-core-owner namespaces="nawara-core-topology-install" (ssh-ed25519|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]{40,400}={0,2}$'
readonly RECOVERY_SIGNER_RE='^nawara-core-owner namespaces="nawara-core-topology-recovery" (ssh-ed25519|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]{40,400}={0,2}$'
readonly ACTIVATION_RE=$'^nawara-core-topology-monitor-activation v1\ncore_commit=([0-9a-f]{40})\nversion=([1-9][0-9]{0,5})\ntimers=nawara-core-topology-monitor\\.timer,nawara-core-topology-watchdog\\.timer\n$'
PATH=$SAFE_PATH
export PATH

usage() { printf '[verify-topology-monitor] REFUSED: %s\nusage: verify-topology-monitor-install.sh\n' "$*" >&2; exit 2; }
[ "$#" -eq 0 ] || usage "takes no argument"
[ "$EUID" -eq "$RUN_AS_UID" ] || usage "run as root at the console (it reads the root-only state)"
for c in stat sha256sum ssh-keygen readlink find sort head dirname tr grep sed cut cat timeout env getent id; do command -v "$c" >/dev/null 2>&1 || usage "$c is required; nothing was checked"; done

FAILED=0; UNKNOWNS=0; CHECKS=0
ok() { CHECKS=$((CHECKS + 1)); printf 'ok       %s\n' "$*"; }
fail() { CHECKS=$((CHECKS + 1)); FAILED=$((FAILED + 1)); printf 'FAIL     %s\n' "$*"; }
unknown() { CHECKS=$((CHECKS + 1)); UNKNOWNS=$((UNKNOWNS + 1)); printf 'UNKNOWN  %s\n' "$*"; }
info() { printf 'info     %s\n' "$*"; }
sha() { local h; h=$(sha256sum -- "$1") || return 1; printf '%s' "${h%% *}"; }
node_ok() { # node_ok <path> <f|d> <exact mode>: that kind, no symbolic link, OWNER_UID:OWNER_GID, exactly that mode, one link (files)
  [ ! -L "$1" ] || return 1
  if [ "$2" = d ]; then [ -d "$1" ] || return 1; else [ -f "$1" ] && [ "$(stat -c %h -- "$1")" = 1 ] || return 1; fi
  [ "$(stat -c %u:%g -- "$1")" = "$OWNER_UID:$OWNER_GID" ] && [ "$(stat -c %a -- "$1")" = "$3" ]
}
exact() { # check <name> <path> <kind> <mode>
  if node_ok "$2" "$3" "$4"; then ok "$1: $2 is $OWNER_UID:$OWNER_GID $4"; else fail "$1 (mode_or_owner): $2 must be a $3 (no symbolic link, one link) owned by $OWNER_UID:$OWNER_GID with mode $4"; fi
}
ancestors() { # every ancestor of <path> up to TRUST_ROOT: a real directory, root-owned, not group/other-writable
  local p bad=0
  p=$(dirname -- "$1")
  while :; do
    if [ ! -L "$p" ] && [ -d "$p" ] && [ "$(stat -c %u -- "$p")" = "$OWNER_UID" ] && (( (8#$(stat -c %a -- "$p") & 8#022) == 0 )) && [ "$(readlink -f -- "$p")" = "$p" ]; then :; else bad=1; fi
    if [ "$p" = "$TRUST_ROOT" ] || [ "$p" = / ]; then break; fi
    p=$(dirname -- "$p")
  done
  if [ $bad = 0 ]; then ok "parents: every ancestor of $1 is a real root-owned directory nobody else may write"; else fail "parents (untrusted_parent): an ancestor of $1 is a symbolic link, not root-owned or writable by others"; fi
}
one_line() { # one_line <file> <regex>: exactly one non-comment line matching
  local lines
  lines=$(grep -vE '^[[:space:]]*(#|$)' -- "$1" 2>/dev/null || true)
  [ "$(printf '%s\n' "$lines" | grep -c '')" -eq 1 ] && [[ $lines =~ $2 ]]
}
fingerprint() { cut -d' ' -f3- <<<"$1" | ssh-keygen -l -f - 2>/dev/null | cut -d' ' -f2 || true; }

# 1. The installation trust key and the authenticated record of what is installed.
declare -A M_SHA=()
M_OK=0; M_VERSION=''; M_COMMIT=''
ancestors "$INSTALL_TRUST"
if node_ok "$INSTALL_TRUST" f 644 && one_line "$INSTALL_TRUST" "$INSTALL_SIGNER_RE"; then
  ok "trust: the installation key is exactly one line for $PRINCIPAL restricted to $INSTALL_NAMESPACE"
  info "installation key fingerprint: $(fingerprint "$(grep -vE '^[[:space:]]*(#|$)' -- "$INSTALL_TRUST")") (compare it off the server with the Owner's key)"
  TRUST_OK=1
else
  fail "trust (install_key_invalid): $INSTALL_TRUST must be root 0644, exactly one line '$PRINCIPAL namespaces=\"$INSTALL_NAMESPACE\" <ssh-ed25519 key>'"
  TRUST_OK=0
fi
if [ -e "$INSTALL_STATE/transaction" ] || [ -L "$INSTALL_STATE/transaction" ]; then
  fail "transaction (incomplete_transaction): an installation transaction is open; the installation is NOT complete (run install-topology-monitor.sh repair)"
else
  ok "transaction: none open"
fi
exact install-state "$INSTALL_STATE" d 700
if [ "$TRUST_OK" = 1 ] && node_ok "$INSTALL_STATE/installed/manifest" f 600 && node_ok "$INSTALL_STATE/installed/manifest.sig" f 600; then
  if env -i PATH="$SAFE_PATH" timeout 10 ssh-keygen -Y verify -f "$INSTALL_TRUST" -I "$PRINCIPAL" -n "$INSTALL_NAMESPACE" -s "$INSTALL_STATE/installed/manifest.sig" <"$INSTALL_STATE/installed/manifest" >/dev/null 2>&1; then
    text=$(cat -- "$INSTALL_STATE/installed/manifest")
    M_COMMIT=$(sed -nE 's/^core_commit=([0-9a-f]{40})$/\1/p' <<<"$text"); M_VERSION=$(sed -nE 's/^version=([1-9][0-9]{0,5})$/\1/p' <<<"$text")
    while IFS= read -r line; do if [[ $line =~ ^file=([0-9a-f]{64})\ (.+)$ ]]; then M_SHA[${BASH_REMATCH[2]}]=${BASH_REMATCH[1]}; fi; done <<<"$text"
    if [ -n "$M_COMMIT" ] && [ -n "$M_VERSION" ] && [ "${#M_SHA[@]}" -eq 11 ]; then
      ok "manifest: the installed record is signed by $PRINCIPAL (core $M_COMMIT, version $M_VERSION)"; M_OK=1
    else
      fail "manifest (manifest_invalid): the installed record is signed but not a complete manifest"
    fi
  else
    fail "manifest (manifest_signature): the installed record does not verify against the installation key"
  fi
else
  fail "manifest (manifest_missing): no authenticated installation record (root 0600 manifest and signature) exists"
fi

# 2. The installed artifacts: exactly the signed ones, nothing else.
ancestors "$INSTALL_DIR"
exact install-dir "$INSTALL_DIR" d 755
if [ -d "$INSTALL_DIR" ]; then
  contents=$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ')
  expected=$(for a in $SCRIPTS verify-topology.sh; do echo "$a"; done | LC_ALL=C sort | tr '\n' ' ')
  if [ "$contents" = "$expected" ]; then ok "install-dir: holds exactly the seven signed files"; else fail "install-dir (unexpected_file): it must hold exactly the signed files (found: ${contents:-nothing})"; fi
fi
artifact() { # artifact <name> <path> <mode>
  exact "artifact $1" "$2" f "$3"
  if [ "$M_OK" != 1 ]; then unknown "artifact $1 (no_manifest): its hash cannot be checked without an authenticated record"
  elif [ -f "$2" ] && [ ! -L "$2" ] && [ "$(sha "$2")" = "${M_SHA[$1]:-}" ]; then ok "artifact $1: sha256 equals the signed manifest"
  else fail "artifact $1 (hash_mismatch): $2 does not equal the signed manifest"; fi
}
for a in $SCRIPTS; do artifact "$a" "$INSTALL_DIR/$a" 555; done
artifact verify-topology.sh "$INSTALL_DIR/verify-topology.sh" 444

# 3. The units: the signed content, their hardening, no override, enabled only under a signed activation authorization.
ancestors "$UNIT_DIR/x"
for u in $UNITS; do artifact "$u" "$UNIT_DIR/$u" 644; done
for u in nawara-core-topology-monitor.service nawara-core-topology-watchdog.service; do
  if [ -f "$UNIT_DIR/$u" ]; then
    missing=''
    for d in 'NoNewPrivileges=yes' 'ProtectSystem=strict' 'ProtectHome=yes' 'CapabilityBoundingSet=' 'Type=oneshot'; do grep -qxF -- "$d" "$UNIT_DIR/$u" || missing+=" $d"; done
    if grep -qE '^(User|DynamicUser|Group)=' -- "$UNIT_DIR/$u"; then missing+=' (an execution identity other than root)'; fi
    if [ -z "$missing" ]; then ok "hardening: $u keeps its directives and runs as root"; else fail "hardening (unit_hardening): $u lacks:$missing"; fi
  fi
done
overrides=''
for d in $UNIT_SEARCH; do
  for u in $UNITS; do
    for cand in "$d/$u.d" "$d/$u"; do
      [ "$cand" = "$UNIT_DIR/$u" ] && continue
      if [ -e "$cand" ] || [ -L "$cand" ]; then overrides+=" $cand"; fi
    done
  done
done
if [ -z "$overrides" ]; then ok "overrides: no drop-in or same-named unit in any systemd unit directory"; else fail "overrides (unit_override): systemd would also read:$overrides"; fi
ENABLED=''
for u in nawara-core-topology-monitor.timer nawara-core-topology-watchdog.timer; do
  st=$("$SYSTEMCTL" is-enabled "$u" 2>/dev/null || true)
  case "$st" in
    enabled | enabled-runtime) ENABLED+=" $u" ;;
    disabled | static | indirect) ;;
    masked | masked-runtime) info "unit $u is masked" ;;
    *) unknown "enablement (systemctl_unavailable): the state of $u could not be read (${st:-no answer})" ;; # never taken as disabled
  esac
done
if [ -z "$ENABLED" ]; then
  ok "enablement: no timer is enabled (activation is a separately authorized step)"
else
  A="$INSTALL_STATE/activation"
  if [ "$TRUST_OK" = 1 ] && [ "$M_OK" = 1 ] && node_ok "$A" f 600 && node_ok "$A.sig" f 600 \
    && atext=$(cat -- "$A"; printf x) && atext=${atext%x} && [[ $atext =~ $ACTIVATION_RE ]] && [ "${BASH_REMATCH[1]}" = "$M_COMMIT" ] && [ "${BASH_REMATCH[2]}" = "$M_VERSION" ] \
    && env -i PATH="$SAFE_PATH" timeout 10 ssh-keygen -Y verify -f "$INSTALL_TRUST" -I "$PRINCIPAL" -n "$INSTALL_NAMESPACE" -s "$A.sig" <"$A" >/dev/null 2>&1; then
    ok "enablement:$ENABLED enabled under a signed activation authorization for version $M_VERSION"
  else
    fail "enablement (unauthorized_activation):$ENABLED enabled without a signed activation authorization for the installed version"
  fi
fi

# 4. The protected state: present and valid (a missing or corrupt state is never ready).
ancestors "$STATE_DIR"
exact state-dir "$STATE_DIR" d 700
exact marker "$STATE_DIR/installed" f 600
exact state "$STATE_DIR/state" f 600
exact inbox "$STATE_DIR/recovery" d 700
if [ -f "$STATE_DIR/installed" ] && [[ $(head -c 256 -- "$STATE_DIR/installed") =~ $MARKER_RE ]]; then ok "state: the installation marker is valid"; else fail "state (marker_invalid): the installation marker is missing or invalid"; fi
if [ -f "$STATE_DIR/state" ] && [ ! -L "$STATE_DIR/state" ] && [[ $(head -c 4096 -- "$STATE_DIR/state") =~ $STATE_RE ]]; then
  ok "state: valid (contained=${BASH_REMATCH[1]}, incident=${BASH_REMATCH[2]}, unknown_streak=${BASH_REMATCH[3]})"
  [ "${BASH_REMATCH[1]}" = 1 ] && info "Notification is CONTAINED (incident ${BASH_REMATCH[2]}): only a signed recovery ends it (runbook §5)"
else
  fail "state (state_invalid): missing or invalid (the control is not operational)"
fi
for f in recovery-consumed incidents.jsonl evidence.jsonl alerts.jsonl; do
  if [ -e "$STATE_DIR/$f" ] || [ -L "$STATE_DIR/$f" ]; then exact "record $f" "$STATE_DIR/$f" f 600; fi
done
ancestors "$LATCH"
exact latch-dir "$(dirname -- "$LATCH")" d 755
exact latch "$LATCH" f 644
exact incident-binding "$INCIDENT_FILE" f 644
if [ -f "$LATCH" ] && [ ! -L "$LATCH" ]; then
  case "$(head -c 512 -- "$LATCH")" in
    "$LATCH_INACTIVE") ok "latch: valid, state=inactive" ;;
    "$LATCH_CONTAINED") ok "latch: valid, state=contained" ;;
    *) fail "latch (latch_malformed): it would refuse every grant" ;;
  esac
fi
if [ -f "$INCIDENT_FILE" ] && [[ $(head -c 256 -- "$INCIDENT_FILE") =~ $INCIDENT_RE ]]; then ok "incident binding: valid (incident=${BASH_REMATCH[1]})"; else fail "incident binding (binding_invalid): missing or invalid"; fi

# 5. The recovery trust key (installed by a separate key-lifecycle operation).
if [ -e "$TRUSTED_SIGNERS" ] || [ -L "$TRUSTED_SIGNERS" ]; then
  ancestors "$TRUSTED_SIGNERS"
  if node_ok "$TRUSTED_SIGNERS" f 644 && one_line "$TRUSTED_SIGNERS" "$RECOVERY_SIGNER_RE"; then
    ok "recovery key: exactly one line for $PRINCIPAL restricted to nawara-core-topology-recovery"
    info "recovery key fingerprint: $(fingerprint "$(grep -vE '^[[:space:]]*(#|$)' -- "$TRUSTED_SIGNERS")")"
  else
    fail "recovery key (recovery_key_invalid): $TRUSTED_SIGNERS must be root 0644, exactly one restricted line"
  fi
else
  info "recovery key: not installed (recovery is impossible until the separately authorized key-lifecycle operation)"
fi

# 6. The optional trigger: its exact sudoers rule and its forced-command key (absent = not configured, never verified).
if [ -e "$TRIGGER_SUDOERS" ] || [ -L "$TRIGGER_SUDOERS" ]; then
  exact trigger-sudoers "$TRIGGER_SUDOERS" f 440
  rule=$(grep -vE '^[[:space:]]*(#|$)' -- "$TRIGGER_SUDOERS" 2>/dev/null || true)
  RUNTIME_USER=''
  if [[ $rule =~ ^Defaults!/usr/bin/systemctl\ env_reset$'\n'([a-z_][a-z0-9_-]{0,31})\ ALL=\(root\)\ NOPASSWD:\ /usr/bin/systemctl\ start\ nawara-core-topology-monitor\.service$ ]]; then
    RUNTIME_USER=${BASH_REMATCH[1]}
    ok "trigger sudoers: exactly the one rule (start the monitor unit) for $RUNTIME_USER"
  else
    fail "trigger sudoers (sudoers_rule): $TRIGGER_SUDOERS must hold exactly the template's Defaults line and its one rule"
  fi
  if [ -n "$RUNTIME_USER" ]; then
    # any other rule that reaches the runtime user: by name, through one of its groups, or for ALL users
    who="$RUNTIME_USER|ALL"
    for g in $(id -nG -- "$RUNTIME_USER" 2>/dev/null || true); do who+="|%${g//./\\.}"; done
    broad=$( { cat -- "$SUDOERS" 2>/dev/null; for f in "$SUDOERS_DIR"/*; do [ "$f" = "$TRIGGER_SUDOERS" ] || cat -- "$f" 2>/dev/null; done; } \
      | grep -vE '^[[:space:]]*(#|$)' | grep -vE '^[[:space:]]*(Defaults|@include|#include)' | grep -E "^[[:space:]]*($who)[[:space:]]" || true)
    if [ -z "$broad" ]; then ok "trigger sudoers: no other rule reaches $RUNTIME_USER (by name, its groups or ALL)"; else fail "trigger sudoers (broad_sudo): another sudoers rule reaches $RUNTIME_USER (by name, one of its groups or ALL): it would not be limited to the trigger"; fi
    if ! sshd_t=$("$SSHD" -T -C "user=$RUNTIME_USER,host=trigger.invalid,addr=192.0.2.1" 2>/dev/null) || [ -z "$sshd_t" ]; then
      unknown "trigger key (sshd_unavailable): sshd's effective settings for $RUNTIME_USER could not be read"
    else
      setting() { printf '%s\n' "$sshd_t" | grep -i -m1 "^$1 " | cut -d' ' -f2- || true; }
      [ "$(setting pubkeyauthentication)" = yes ] && [ "$(setting permituserenvironment)" = no ] && { [ -z "$(setting forcecommand)" ] || [ "$(setting forcecommand)" = none ]; } \
        && ok "trigger sshd: key authentication on, no user environment, no ForceCommand override" || fail "trigger sshd (sshd_settings): pubkeyauthentication yes, permituserenvironment no and no ForceCommand are required"
      home=$(getent passwd "$RUNTIME_USER" 2>/dev/null | cut -d: -f6 || true)
      lines=''
      for tok in $(setting authorizedkeysfile); do
        [ "$tok" = none ] && continue
        tok=${tok//%h/$home}; tok=${tok//%u/$RUNTIME_USER}
        case "$tok" in /*) ;; *) tok="$home/$tok" ;; esac
        [ -f "$tok" ] && lines+=$(grep -vE '^[[:space:]]*(#|$)' -- "$tok" 2>/dev/null || true)$'\n'
      done
      named=$(printf '%s' "$lines" | grep -F -- "$TRIGGER_COMMENT" || true)
      if [ "$(printf '%s\n' "$named" | grep -c .)" -eq 1 ] && [[ $named =~ ^${TRIGGER_OPTIONS//./\\.}\ ssh-ed25519\ (AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]+={0,2})\ $TRIGGER_COMMENT$ ]]; then
        blob=${BASH_REMATCH[1]}
        uses=$(printf '%s' "$lines" | grep -cF -- "$blob" || true)
        backup=$(printf '%s' "$lines" | grep -F -- "$BACKUP_COMMENT" | grep -cF -- "$blob" || true)
        if [ "$uses" -eq 1 ] && [ "$backup" -eq 0 ]; then ok "trigger key: exactly the restricted forced-command line, on no other line, not the scheduled-backup key"
        else fail "trigger key (key_reuse): the trigger key appears on another line or is the scheduled-backup key"; fi
      elif [ -z "$named" ]; then
        fail "trigger key (key_missing): the sudoers rule exists but no restricted trigger key line does"
      else
        fail "trigger key (forced_command): the trigger line must be exactly '$TRIGGER_OPTIONS ssh-ed25519 <key> $TRIGGER_COMMENT' (no shell, forwarding or other option)"
      fi
    fi
  fi
else
  info "trigger: not configured (no sudoers rule; the forced-command trigger is optional and absent)"
fi

if [ "$FAILED" -gt 0 ]; then printf 'RESULT: FAIL (%d of %d checks failed, %d unknown); nothing was changed; STOP (runbook)\n' "$FAILED" "$CHECKS" "$UNKNOWNS"; exit 1; fi
if [ "$UNKNOWNS" -gt 0 ]; then printf 'RESULT: UNKNOWN (%d of %d checks could not be determined); nothing was changed; not a PASS\n' "$UNKNOWNS" "$CHECKS"; exit 3; fi
printf 'RESULT: PASS (%d checks); nothing was changed\n' "$CHECKS"
exit 0
