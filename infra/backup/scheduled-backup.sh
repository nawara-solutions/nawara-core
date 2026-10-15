#!/usr/bin/env bash
# Core V2 M2 B1: the forced-command entry of the scheduled backup (docs/architecture/stage-21/stage-21-x-m2-pre-g7-backup-design.md §5,
# §14; docs/runbooks/core-backup-restore.md §2). It is installed root-owned in INSTALL_DIR together with a pinned copy of
# infra/backup/backup.sh, and it is the `command=` of the scheduled-backup key's `restrict` line in the runtime user's authorized_keys
# (infra/backup/scheduled-backup.authorized_keys.template). The scheduled workflow (.github/workflows/core-backup-scheduled.yml) sends no
# command: it only opens the session that starts this script.
#
# It never runs anything the client sends, takes no input, and passes no client environment on. After it has verified the installation
# (its own location, outside the backup working directory, owner, modes, no symbolic link), the pinned SHA-256 of the installed backup.sh,
# and taken a non-blocking lock, it runs exactly:
#   env -i HOME=… PATH=<fixed> BACKUP_SERVICES="auth-service organization-service" bash INSTALL_DIR/backup.sh
#
# Exit: backup.sh's own 0 / 1 / 3 (runbook §3); 64 a client command was sent (refused, never run); 65 the installation is unsafe
# (location, owner, mode, symbolic link); 66 the installed backup.sh does not match the pin; 69 a required tool is missing; 75 another run
# holds the lock (nothing was done).
#
# NOT isolation by itself: root-owned files stop this key and the other job paths from changing what runs, but a runtime user with Docker
# or sudo access is root-equivalent and can replace them. The runtime user's effective privileges are verified in production before the
# schedule is activated (runbook §2); nothing here claims that verification.
set -euo pipefail
umask 077
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH

# Pinned values. Changed only by a reviewed commit; scripts/check-repo.mjs compares them with the repository (checkScheduledBackupEntry).
readonly INSTALL_DIR='/usr/local/libexec/nawara-core-backup'
readonly OWNER_UID=0
readonly BACKUP_SH_SHA256='50be3c2b2eb98978ce3bb6c038c921c55914f3dc75fd0bc52ba0db4bb206d193'
readonly SERVICES='auth-service organization-service'

log() { printf '[scheduled-backup] %s\n' "$*"; }
refuse() { local code=$1; shift; printf '[scheduled-backup] REFUSED: %s\n' "$*" >&2; exit "$code"; }

# 1. The key starts this script only. A command sent with it is refused and never run, and its text is never printed.
[ -z "${SSH_ORIGINAL_COMMAND:-}" ] && [ "$#" -eq 0 ] || refuse 64 "a command or argument was sent with the scheduled-backup key; it is never run (the key only starts the scheduled backup)"

for c in bash env flock sha256sum stat readlink dirname; do
  command -v "$c" >/dev/null 2>&1 || refuse 69 "$c is required on the server; nothing was done"
done
[ -n "${HOME:-}" ] && [ -d "$HOME" ] || refuse 65 "HOME is not set to an existing directory; nothing was done"

# 2. The installation: this script runs from INSTALL_DIR, which is no symbolic link and lies outside the backup working directory
#    (backup.sh refuses any file there that contains a private-key marker, which its own text does).
SELF=$(readlink -f -- "${BASH_SOURCE[0]}")
[ "$(readlink -f -- "$INSTALL_DIR")" = "$INSTALL_DIR" ] || refuse 65 "$INSTALL_DIR must be a real directory path (no symbolic link); nothing was done"
[ "$(dirname -- "$SELF")" = "$INSTALL_DIR" ] || refuse 65 "this script must run from $INSTALL_DIR; nothing was done"
WORK_DIR=$(readlink -m -- "$HOME/nawara-core/backup")
case "$INSTALL_DIR/" in
  "$WORK_DIR"/*) refuse 65 "$INSTALL_DIR lies inside the backup working directory $WORK_DIR; install it outside; nothing was done" ;;
esac

safe() { # safe <path> <d|f>: exists as that kind, no symbolic link, owned by OWNER_UID, not writable by group or others
  local p=$1 kind=$2 owner mode
  [ ! -L "$p" ] || refuse 65 "$p is a symbolic link; nothing was done"
  if [ "$kind" = d ]; then [ -d "$p" ] || refuse 65 "$p is not a directory; nothing was done"
  else [ -f "$p" ] || refuse 65 "$p is not a regular file; nothing was done"; fi
  owner=$(stat -c %u -- "$p"); mode=$(stat -c %a -- "$p")
  [ "$owner" = "$OWNER_UID" ] || refuse 65 "$p must be owned by uid $OWNER_UID (found $owner); nothing was done"
  (( (8#$mode & 8#022) == 0 )) || refuse 65 "$p must not be writable by group or others (mode $mode); nothing was done"
}
safe "$INSTALL_DIR" d
safe "$SELF" f
safe "$INSTALL_DIR/backup.sh" f

# 3. The pinned backup.sh: exactly the reviewed revision, never a script from the client or from the repository's current main.
got=$(sha256sum -- "$INSTALL_DIR/backup.sh"); got=${got%% *}
[ "$got" = "$BACKUP_SH_SHA256" ] || refuse 66 "the installed backup.sh does not match the pinned SHA-256 $BACKUP_SH_SHA256; nothing was done"

# 4. One run at a time (a scheduled run and a console run never overlap). The lock lies outside the backup working directory.
[ -d "$HOME/nawara-core" ] || refuse 65 "$HOME/nawara-core is missing; nothing was done"
exec 9>>"$HOME/nawara-core/.scheduled-backup.lock"
flock -n 9 || refuse 75 "another scheduled-backup run holds the lock; nothing was done"

# 5. The backup, with no inherited environment.
log "starting: services=$SERVICES backup.sh sha256=$BACKUP_SH_SHA256"
rc=0
env -i HOME="$HOME" PATH="$PATH" BACKUP_SERVICES="$SERVICES" bash --noprofile --norc -- "$INSTALL_DIR/backup.sh" || rc=$?
log "finished: exit $rc"
exit "$rc"
