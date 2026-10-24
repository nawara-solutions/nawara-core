#!/usr/bin/env bash
# Core V2 OD-BRK-2b-1: the forced-command entry of the topology trigger key (docs/runbooks/rabbitmq-topology-containment.md §3). An
# ADDITIONAL verification after an authorized topology change (for example after protected provisioning); never a replacement for the
# server's own timer. Installed root-owned in INSTALL_DIR and named by the `command=` of the trigger key's `restrict` line in the
# runtime user's authorized_keys (topology-trigger.authorized_keys.template). Not installed by repository tooling; the key, the
# authorized_keys line, the sudoers rule and any dispatching workflow are separately authorized (OD-BRK-2b-2).
#
# It never runs anything the client sends, takes no input, passes no client environment on, and can do exactly one thing: start the
# root-owned monitor unit, through the ONE sudoers rule of topology-trigger.sudoers.template (that exact command, no argument
# substitution). The unit runs the pinned, root-owned verify-and-contain.sh; nothing reaches it from this session but the start.
#
# Exit: the start's own status (0: the run completed; non-zero: the unit failed, see the journal); 64 a client command or an argument was
# sent (refused, never run); 65 the installation is unsafe or it runs as root (the key belongs to the runtime user only); 69 a tool is
# missing.
set -euo pipefail
umask 077
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH

# Pinned values (scripts/check-repo.mjs, checkTopologyMonitor).
readonly INSTALL_DIR='/usr/local/libexec/nawara-core-topology'
readonly OWNER_UID=0
readonly SUDO='/usr/bin/sudo'
readonly MONITOR_SERVICE='nawara-core-topology-monitor.service'

refuse() { local code=$1; shift; printf '[topology-trigger] REFUSED: %s\n' "$*" >&2; exit "$code"; }

# 1. The key starts this script only. A command sent with it is refused and never run, and its text is never printed.
[ -z "${SSH_ORIGINAL_COMMAND:-}" ] && [ "$#" -eq 0 ] || refuse 64 "a command or argument was sent with the topology trigger key; it is never run (the key only starts one verification)"
[ "$EUID" -ne 0 ] || refuse 65 "the trigger never runs as root; its key belongs in the runtime user's authorized_keys; nothing was done"
for c in env stat readlink dirname; do command -v "$c" >/dev/null 2>&1 || refuse 69 "$c is required; nothing was done"; done
[ -x "$SUDO" ] || refuse 69 "$SUDO is required; nothing was done"

# 2. The installation: this script runs from INSTALL_DIR, root-owned, no symbolic link, not writable by group or others.
safe() {
  local p=$1 kind=$2 owner mode
  [ ! -L "$p" ] || refuse 65 "$p is a symbolic link; nothing was done"
  if [ "$kind" = d ]; then [ -d "$p" ] || refuse 65 "$p is not a directory; nothing was done"
  else [ -f "$p" ] || refuse 65 "$p is not a regular file; nothing was done"; fi
  owner=$(stat -c %u -- "$p"); mode=$(stat -c %a -- "$p")
  [ "$owner" = "$OWNER_UID" ] || refuse 65 "$p must be owned by uid $OWNER_UID (found $owner); nothing was done"
  (( (8#$mode & 8#022) == 0 )) || refuse 65 "$p must not be writable by group or others (mode $mode); nothing was done"
}
SELF=$(readlink -f -- "${BASH_SOURCE[0]}")
[ "$(readlink -f -- "$INSTALL_DIR")" = "$INSTALL_DIR" ] || refuse 65 "$INSTALL_DIR must be a real directory path (no symbolic link); nothing was done"
[ "$(dirname -- "$SELF")" = "$INSTALL_DIR" ] || refuse 65 "this script must run from $INSTALL_DIR; nothing was done"
safe "$INSTALL_DIR" d
safe "$SELF" f

# 3. Exactly one start of the monitor unit, with no inherited environment.
printf '[topology-trigger] starting %s\n' "$MONITOR_SERVICE"
rc=0
env -i PATH="$PATH" "$SUDO" -n /usr/bin/systemctl start "$MONITOR_SERVICE" || rc=$?
printf '[topology-trigger] finished: exit %s\n' "$rc"
exit "$rc"
