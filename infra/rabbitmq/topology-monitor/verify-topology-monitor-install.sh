#!/usr/bin/env bash
# Core V2 OD-BRK-2b-1: the READ-ONLY verification of the topology monitor's installation (docs/runbooks/rabbitmq-topology-containment.md
# §2). The Owner runs it as root at the console, from a checkout of the reviewed revision, after install-topology-monitor.sh and before
# enabling any timer, and records its output. It creates, writes, moves and deletes no file, starts and enables no unit, and touches no
# container or broker.
#
# It verifies: the install directory and every ancestor (real paths, root-owned, not writable by group or others); exactly the five
# installed files, their owner and exact modes, and their SHA-256 against the pins below; the state directory (0700), the installation
# marker and a valid state (0600); the latch directory (0755) and a valid, root-owned latch (0644; it reports whether it says contained);
# and the four units (root-owned 0644, SHA-256 against the pins). It prints only paths, modes, hashes and closed results.
#
# Exit: 0 every check passed; 1 at least one check failed (STOP: runbook); 2 an invalid invocation, not root, or a tool missing.
set -euo pipefail
umask 077
export LC_ALL=C
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH

# Pinned values. Changed only by a reviewed commit; scripts/check-repo.mjs compares every hash with the repository (checkTopologyMonitor).
readonly INSTALL_DIR='/usr/local/libexec/nawara-core-topology'
readonly STATE_DIR='/var/lib/nawara-core-topology-monitor'
readonly LATCH='/var/lib/nawara-core-topology/notification-service.containment'
readonly UNIT_DIR='/etc/systemd/system'
readonly OWNER_UID=0
readonly OWNER_GID=0
readonly RUN_AS_UID=0
readonly TRUST_ROOT='/'
readonly SHA_VERIFY_AND_CONTAIN='e08dfd7cd00f4bd4e3aefead3c3340fe6446703de60d1214b8c59b70b0f59fd5'
readonly SHA_TOPOLOGY_WATCHDOG='0a463da60b95f5f53f55b574ce96357d3b8e5518543c334c480553bef7518f59'
readonly SHA_TOPOLOGY_TRIGGER='a7ea87198477cbe072e06f6a2f021de358ae67ff5596a0eac339ffa310c7617f'
readonly SHA_RECOVER_NOTIFICATION_TOPOLOGY='8b87793fee10e6f5bea0e3c7ed9000aa6d561d49aa18d7c69a473c34b5fbf491'
readonly SHA_VERIFY_TOPOLOGY='b3bcc7f2f69f9bcf7ef2ee5a8877714169dcdc364d42c893b85f6f1e49548c9f'
readonly SHA_MONITOR_SERVICE='858e8f5d171fd641ee06d96c98d8adccfbc5043bd35e469f496160c050c6b8ad'
readonly SHA_MONITOR_TIMER='9d6deb45a6255bd62cb79c7d45aee97822898f2eb252e5a7b830d942b2bc4978'
readonly SHA_WATCHDOG_SERVICE='00f558d1583266254a25eabbdf45a9f0144eed885b35e297ce6aca80c1aa67cf'
readonly SHA_WATCHDOG_TIMER='1e5f9b4e26f5c535aa02698c2347274c06e2b7d299a8aaf0479e49b3b3970a4e'
readonly LATCH_INACTIVE=$'nawara-core-topology-containment v1\nservice=notification-service\nstate=inactive'
readonly LATCH_CONTAINED=$'nawara-core-topology-containment v1\nservice=notification-service\nstate=contained'
readonly STATE_RE=$'^nawara-core-topology-monitor-state v1\nservice=notification-service\ncontained=([01])\nunknown_streak=([0-9]{1,3})\nlast_result=(NONE|PASS|FAIL|UNKNOWN)\nlast_run=([0-9]{1,12})$'
readonly MARKER_RE='^nawara-core-topology-monitor installed v1 at=[0-9]{1,12}$'

usage() { printf '[verify-topology-monitor] REFUSED: %s\nusage: verify-topology-monitor-install.sh\n' "$*" >&2; exit 2; }
[ "$#" -eq 0 ] || usage "takes no argument"
[ "$EUID" -eq "$RUN_AS_UID" ] || usage "run as root at the console (it reads the root-only state)"
for c in stat sha256sum readlink find sort head dirname tr; do command -v "$c" >/dev/null 2>&1 || usage "$c is required; nothing was checked"; done

FAILED=0
CHECKS=0
ok() { CHECKS=$((CHECKS + 1)); printf 'ok    %s\n' "$*"; }
fail() { CHECKS=$((CHECKS + 1)); FAILED=$((FAILED + 1)); printf 'FAIL  %s\n' "$*"; }
info() { printf 'info  %s\n' "$*"; }
owned_safe() { # owned_safe <path>: no symbolic link, owned by OWNER_UID, not writable by group or others
  [ ! -L "$1" ] && [ -e "$1" ] || return 1
  [ "$(stat -c %u -- "$1")" = "$OWNER_UID" ] || return 1
  local mode; mode=$(stat -c %a -- "$1")
  (( (8#$mode & 8#022) == 0 ))
}
exact() { # exact <path> <f|d> <mode>
  local kind=file; [ "$2" = d ] && kind=directory
  if [ ! -L "$1" ] && { { [ "$2" = f ] && [ -f "$1" ]; } || { [ "$2" = d ] && [ -d "$1" ]; }; } \
    && [ "$(stat -c %u:%g -- "$1")" = "$OWNER_UID:$OWNER_GID" ] && [ "$(stat -c %a -- "$1")" = "$3" ]; then
    ok "mode: $1 is $OWNER_UID:$OWNER_GID $3"
  else
    fail "mode: $1 must be a $kind (no symbolic link) owned by $OWNER_UID:$OWNER_GID with mode $3"
  fi
}
hash_is() { # hash_is <path> <pin>
  local got
  if [ -f "$1" ] && [ ! -L "$1" ]; then
    got=$(sha256sum -- "$1"); got=${got%% *}
    [ "$got" = "$2" ] && ok "sha256: $1 $got" || fail "sha256: $1 is $got, the reviewed revision pins $2"
  else
    fail "sha256: $1 is missing or a symbolic link"
  fi
}
ancestors() { # every ancestor of a path, up to TRUST_ROOT, is root-owned and not group/other-writable
  local p=$1
  while :; do
    if owned_safe "$p"; then ok "path: $p is root-owned, no symbolic link, not group/other-writable"
    else fail "path: $p must exist, be no symbolic link, be owned by uid $OWNER_UID and not be writable by group or others"; fi
    [ "$p" = "$TRUST_ROOT" ] || [ "$p" = / ] && break
    p=$(dirname -- "$p")
  done
}

# 1. The installation directory and its five files.
ancestors "$INSTALL_DIR"
[ "$(readlink -f -- "$INSTALL_DIR" 2>/dev/null)" = "$INSTALL_DIR" ] && ok "path: $INSTALL_DIR resolves to itself" || fail "path: $INSTALL_DIR does not resolve to itself"
if [ -d "$INSTALL_DIR" ]; then
  contents=$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ')
  [ "$contents" = 'recover-notification-topology.sh topology-trigger.sh topology-watchdog.sh verify-and-contain.sh verify-topology.sh ' ] \
    && ok "install directory: holds exactly the five reviewed files" || fail "install directory: must hold exactly the five reviewed files (found: ${contents:-nothing})"
fi
exact "$INSTALL_DIR" d 755
for f in verify-and-contain.sh topology-watchdog.sh topology-trigger.sh recover-notification-topology.sh; do exact "$INSTALL_DIR/$f" f 555; done
exact "$INSTALL_DIR/verify-topology.sh" f 444
hash_is "$INSTALL_DIR/verify-and-contain.sh" "$SHA_VERIFY_AND_CONTAIN"
hash_is "$INSTALL_DIR/topology-watchdog.sh" "$SHA_TOPOLOGY_WATCHDOG"
hash_is "$INSTALL_DIR/topology-trigger.sh" "$SHA_TOPOLOGY_TRIGGER"
hash_is "$INSTALL_DIR/recover-notification-topology.sh" "$SHA_RECOVER_NOTIFICATION_TOPOLOGY"
hash_is "$INSTALL_DIR/verify-topology.sh" "$SHA_VERIFY_TOPOLOGY"

# 2. The state directory, the marker and the state (initialized only by the installer).
ancestors "$(dirname -- "$STATE_DIR")"
exact "$STATE_DIR" d 700
exact "$STATE_DIR/installed" f 600
exact "$STATE_DIR/state" f 600
if [ -f "$STATE_DIR/installed" ] && [ ! -L "$STATE_DIR/installed" ] && [[ $(head -c 256 -- "$STATE_DIR/installed") =~ $MARKER_RE ]]; then
  ok "state: the installation marker is valid"
else
  fail "state: the installation marker is missing or invalid"
fi
if [ -f "$STATE_DIR/state" ] && [ ! -L "$STATE_DIR/state" ] && [[ $(head -c 4096 -- "$STATE_DIR/state") =~ $STATE_RE ]]; then
  ok "state: valid (contained=${BASH_REMATCH[1]}, unknown_streak=${BASH_REMATCH[2]}, last_result=${BASH_REMATCH[3]})"
else
  fail "state: missing or invalid"
fi

# 3. The containment latch (the OD-BRK-2a contract).
ancestors "$(dirname -- "$LATCH")"
exact "$(dirname -- "$LATCH")" d 755
exact "$LATCH" f 644
if [ -f "$LATCH" ] && [ ! -L "$LATCH" ]; then
  case "$(head -c 512 -- "$LATCH")" in
    "$LATCH_INACTIVE") ok "latch: valid, state=inactive" ;;
    "$LATCH_CONTAINED") ok "latch: valid, state=contained"; info "Notification is CONTAINED: only the Owner-authorized recovery clears it (runbook §5)" ;;
    *) fail "latch: malformed (it would refuse every grant)" ;;
  esac
fi

# 4. The units: present, root-owned 0644, the reviewed content (enabling them is a separate, authorized step).
for u in nawara-core-topology-monitor.service nawara-core-topology-monitor.timer nawara-core-topology-watchdog.service nawara-core-topology-watchdog.timer; do
  exact "$UNIT_DIR/$u" f 644
done
hash_is "$UNIT_DIR/nawara-core-topology-monitor.service" "$SHA_MONITOR_SERVICE"
hash_is "$UNIT_DIR/nawara-core-topology-monitor.timer" "$SHA_MONITOR_TIMER"
hash_is "$UNIT_DIR/nawara-core-topology-watchdog.service" "$SHA_WATCHDOG_SERVICE"
hash_is "$UNIT_DIR/nawara-core-topology-watchdog.timer" "$SHA_WATCHDOG_TIMER"

if [ "$FAILED" -eq 0 ]; then
  printf 'RESULT: PASS (%d checks); nothing was changed\n' "$CHECKS"
  exit 0
fi
printf 'RESULT: FAIL (%d of %d checks failed); nothing was changed; STOP (runbook)\n' "$FAILED" "$CHECKS"
exit 1
