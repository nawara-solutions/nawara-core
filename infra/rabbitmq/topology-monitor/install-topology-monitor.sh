#!/usr/bin/env bash
# Core V2 OD-BRK-2b-1: the FRESH installation of Notification's topology monitor (docs/runbooks/rabbitmq-topology-containment.md §2).
# NOT executed by this slice: the Owner runs it, as root at the console, from a checkout of the reviewed revision, only under the separate
# OD-BRK-2b-2 installation authorization; then verifies it with verify-topology-monitor-install.sh before enabling anything.
#
#   install-topology-monitor.sh
#
# It installs, root-owned and with exact modes, and changes nothing else:
#   INSTALL_DIR  (0755)  verify-and-contain.sh, topology-watchdog.sh, topology-trigger.sh, recover-notification-topology.sh (0555) and
#                        the pinned copy of infra/rabbitmq/verify-topology.sh (0444; its SHA-256 must equal verify-and-contain.sh's pin)
#   STATE_DIR    (0700)  the installation marker and the INITIAL state (not contained, no UNKNOWN), both 0600: this is the only place
#                        a state is ever initialized (the monitor treats a missing state after installation as corruption)
#   the latch directory (0755) and the latch `state=inactive` (0644): the OD-BRK-2a contract that lets protected provisioning run
#   UNIT_DIR     (0644)  the monitor and watchdog services and timers: copied, NOT enabled, NOT started (no daemon-reload either)
# It refuses (and changes nothing) when any of these already exists: it never overwrites a state, a unit or a latch, so it can never
# clear a containment. The trigger key, its authorized_keys line and its sudoers rule are not installed here.
#
# Exit: 0 installed; 1 refused (an existing installation, latch or unit; a source that is missing or does not match its pin); 2 not root
# or a tool missing.
set -euo pipefail
umask 077
export LC_ALL=C
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH

# Pinned values (scripts/check-repo.mjs, checkTopologyMonitor; equal to the monitor's).
readonly INSTALL_DIR='/usr/local/libexec/nawara-core-topology'
readonly STATE_DIR='/var/lib/nawara-core-topology-monitor'
readonly LATCH='/var/lib/nawara-core-topology/notification-service.containment'
readonly UNIT_DIR='/etc/systemd/system'
readonly RUN_AS_UID=0
readonly OWNER='0:0'
readonly LATCH_INACTIVE=$'nawara-core-topology-containment v1\nservice=notification-service\nstate=inactive'
readonly SCRIPTS='verify-and-contain.sh topology-watchdog.sh topology-trigger.sh recover-notification-topology.sh'
readonly UNITS='nawara-core-topology-monitor.service nawara-core-topology-monitor.timer nawara-core-topology-watchdog.service nawara-core-topology-watchdog.timer'

refuse() { printf '[topology-install] REFUSED: %s; nothing was changed\n' "$*" >&2; exit 1; }
[ "$#" -eq 0 ] || { printf '[topology-install] REFUSED: takes no argument\n' >&2; exit 2; }
[ "$EUID" -eq "$RUN_AS_UID" ] || { printf '[topology-install] REFUSED: run as root at the console\n' >&2; exit 2; }
for c in install sha256sum readlink dirname grep date sync cut; do command -v "$c" >/dev/null 2>&1 || { printf '[topology-install] REFUSED: %s is required\n' "$c" >&2; exit 2; }; done

SRC=$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")
VERIFIER_SRC=$(readlink -f -- "$SRC/../verify-topology.sh")
for f in $SCRIPTS $UNITS; do [ -f "$SRC/$f" ] && [ ! -L "$SRC/$f" ] || refuse "the source $SRC/$f is missing or a symbolic link"; done
[ -f "$VERIFIER_SRC" ] || refuse "the source infra/rabbitmq/verify-topology.sh is missing"
pin=$(grep -E -m1 "^readonly VERIFIER_SHA256='[0-9a-f]{64}'$" -- "$SRC/verify-and-contain.sh" | grep -Eo '[0-9a-f]{64}' || true)
got=$(sha256sum -- "$VERIFIER_SRC"); got=${got%% *}
[ -n "$pin" ] && [ "$got" = "$pin" ] || refuse "verify-topology.sh ($got) does not match verify-and-contain.sh's pin (${pin:-none})"

# Fresh only: nothing may exist yet.
for p in "$INSTALL_DIR" "$STATE_DIR" "$LATCH" $(for u in $UNITS; do echo "$UNIT_DIR/$u"; done); do
  [ ! -e "$p" ] && [ ! -L "$p" ] || refuse "$p already exists (a fresh installation only; never over an existing state, unit or latch)"
done
[ -d "$UNIT_DIR" ] || refuse "$UNIT_DIR does not exist"

install -d -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 0755 -- "$INSTALL_DIR"
for f in $SCRIPTS; do install -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 0555 -- "$SRC/$f" "$INSTALL_DIR/$f"; done
install -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 0444 -- "$VERIFIER_SRC" "$INSTALL_DIR/verify-topology.sh"

install -d -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 0700 -- "$STATE_DIR"
printf 'nawara-core-topology-monitor-state v1\nservice=notification-service\ncontained=0\nunknown_streak=0\nlast_result=NONE\nlast_run=0\n' >"$STATE_DIR/state"
printf 'nawara-core-topology-monitor installed v1 at=%s\n' "$(date +%s)" >"$STATE_DIR/installed"
chmod 0600 -- "$STATE_DIR/state" "$STATE_DIR/installed"
sync -- "$STATE_DIR/state" "$STATE_DIR/installed"

LATCH_DIR=$(dirname -- "$LATCH")
[ -d "$LATCH_DIR" ] || install -d -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 0755 -- "$LATCH_DIR"
printf '%s' "$LATCH_INACTIVE" >"$LATCH"
chmod 0644 -- "$LATCH"
sync -- "$LATCH"

for u in $UNITS; do install -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 0644 -- "$SRC/$u" "$UNIT_DIR/$u"; done

printf '[topology-install] installed (NOT enabled, NOT started):\n'
for f in $SCRIPTS verify-topology.sh; do printf '  %s  %s\n' "$(sha256sum -- "$INSTALL_DIR/$f" | cut -d' ' -f1)" "$INSTALL_DIR/$f"; done
for u in $UNITS; do printf '  %s  %s\n' "$(sha256sum -- "$UNIT_DIR/$u" | cut -d' ' -f1)" "$UNIT_DIR/$u"; done
printf '[topology-install] next: verify-topology-monitor-install.sh (read-only), then the separately authorized enablement (runbook §2)\n'
