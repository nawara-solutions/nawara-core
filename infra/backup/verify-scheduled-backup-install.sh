#!/usr/bin/env bash
# Core V2 M2 E2: the READ-ONLY verification of the scheduled-backup installation (docs/runbooks/core-backup-scheduled-install.md;
# docs/architecture/stage-21/stage-21-x-m2-pre-g7-backup-design.md §5, §14, §15). The owner runs it as root at the console, after the
# E2 installation and before E3, and records its output. It changes nothing: it creates, writes, moves and deletes no file, starts no
# backup, touches no container and reaches no network.
#
# Usage: verify-scheduled-backup-install.sh <runtime-user> <entry-sha256>
#   <runtime-user>  the account whose authorized_keys holds the scheduled-backup line (the runtime user, OD-M2-4)
#   <entry-sha256>  the SHA-256 of infra/backup/scheduled-backup.sh at the merged revision, computed OFF the server
#
# It verifies: the install directory and every ancestor (real paths, root-owned, not writable by group or others); exactly the two
# installed files, their owner and exact modes (0755 / 0555 / 0444); the entry's SHA-256 against <entry-sha256> and the installed
# backup.sh against the entry's own pin; the effective sshd settings for the runtime user (key authentication on, no ForceCommand, no
# AuthorizedKeysCommand, no user environment, OpenSSH 7.2 or later for `restrict`); that across every AuthorizedKeysFile exactly one
# line names the scheduled backup, that it is exactly the restricted ed25519 line of the template, and that its key appears on no other
# line; the owner and modes of those files; and, only once the installed entry matches the reviewed revision, that the entry run as the
# runtime user refuses a client command and an argument (64) without running anything.
#
# It prints no key, no other authorized_keys line and no address: only the key's SHA-256 fingerprint, the hashes, the modes and the
# runtime user's uid and groups (docker membership is root-equivalent: design §14). The fingerprint is matched off the server against
# the private key that E3 puts in the production-backup environment.
#
# Exit: 0 every check passed; 1 at least one check failed (STOP: runbook stop conditions); 2 an invalid invocation, not root, or a
# required tool missing (nothing was checked).
set -euo pipefail
umask 077
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH

# Pinned values. Changed only by a reviewed commit; scripts/check-repo.mjs compares them with the entry script and the template.
readonly INSTALL_DIR='/usr/local/libexec/nawara-core-backup'
readonly OWNER_UID=0
readonly OWNER_GID=0
readonly RUN_AS_UID=0
readonly TRUST_ROOT='/'
readonly KEY_COMMENT='nawara-core-scheduled-backup'
readonly FORCED_OPTIONS='restrict,command="/usr/local/libexec/nawara-core-backup/scheduled-backup.sh"'

usage() { printf '[verify-scheduled-backup] REFUSED: %s\nusage: verify-scheduled-backup-install.sh <runtime-user> <entry-sha256>\n' "$*" >&2; exit 2; }

[ "$#" -eq 2 ] || usage "exactly two arguments are required"
RUNTIME_USER=$1
ENTRY_SHA256=$2
[[ $RUNTIME_USER =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || usage "the runtime user must be a plain account name"
[[ $ENTRY_SHA256 =~ ^[0-9a-f]{64}$ ]] || usage "the entry SHA-256 must be 64 lowercase hexadecimal characters"
[ "$EUID" -eq "$RUN_AS_UID" ] || usage "run as root at the console (it reads the runtime user's authorized_keys and sshd's effective settings)"
for c in getent id stat sha256sum readlink find sort grep sshd ssh ssh-keygen runuser env flock; do
  command -v "$c" >/dev/null 2>&1 || usage "$c is required; nothing was checked"
done

FAILED=0
CHECKS=0
ok() { CHECKS=$((CHECKS + 1)); printf 'ok    %s\n' "$*"; }
fail() { CHECKS=$((CHECKS + 1)); FAILED=$((FAILED + 1)); printf 'FAIL  %s\n' "$*"; }
info() { printf 'info  %s\n' "$*"; }

# 1. The runtime user: an existing, non-root account with an existing home.
IFS=: read -r _ _ RUNTIME_UID _ _ RUNTIME_HOME _ < <(getent passwd "$RUNTIME_USER" || true)
if [ -z "${RUNTIME_UID:-}" ]; then
  fail "runtime user: no such account"
  printf 'RESULT: FAIL (%d of %d checks failed)\n' "$FAILED" "$CHECKS"
  exit 1
fi
[ "$RUNTIME_UID" != 0 ] && ok "runtime user: uid $RUNTIME_UID, not root" || fail "runtime user: uid 0; the scheduled backup never runs as root"
[ -d "$RUNTIME_HOME" ] && [ ! -L "$RUNTIME_HOME" ] && ok "runtime user: home directory exists" || fail "runtime user: home directory missing or a symbolic link"
info "runtime user groups: $(id -nG -- "$RUNTIME_USER" 2>/dev/null || echo unknown) (docker/sudo membership is root-equivalent; not isolation, design §14)"

# 2. The installation: every ancestor and the directory are real, root-owned and not writable by group or others.
owned_safe() { # owned_safe <path> <uid>: no symbolic link, owned by <uid>, not writable by group or others
  [ ! -L "$1" ] && [ -e "$1" ] || return 1
  [ "$(stat -c %u -- "$1")" = "$2" ] || return 1
  local mode; mode=$(stat -c %a -- "$1")
  (( (8#$mode & 8#022) == 0 ))
}
p=$INSTALL_DIR
while :; do
  if owned_safe "$p" "$OWNER_UID"; then ok "install path: $p is root-owned, no symbolic link, not group/other-writable"
  else fail "install path: $p must exist, be no symbolic link, be owned by uid $OWNER_UID and not be writable by group or others"; fi
  [ "$p" = "$TRUST_ROOT" ] || [ "$p" = / ] && break
  p=$(dirname -- "$p")
done
[ "$(readlink -f -- "$INSTALL_DIR" 2>/dev/null)" = "$INSTALL_DIR" ] && ok "install path: resolves to itself" || fail "install path: does not resolve to $INSTALL_DIR"

if [ -d "$INSTALL_DIR" ]; then
  contents=$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ')
  [ "$contents" = 'backup.sh scheduled-backup.sh ' ] && ok "install directory: holds exactly backup.sh and scheduled-backup.sh" \
    || fail "install directory: must hold exactly backup.sh and scheduled-backup.sh (found: ${contents:-nothing})"
fi
exact() { # exact <path> <kind f|d> <mode>
  local kind=file; [ "$2" = d ] && kind=directory
  if [ ! -L "$1" ] && { { [ "$2" = f ] && [ -f "$1" ]; } || { [ "$2" = d ] && [ -d "$1" ]; }; } \
    && [ "$(stat -c %u:%g -- "$1")" = "$OWNER_UID:$OWNER_GID" ] && [ "$(stat -c %a -- "$1")" = "$3" ]; then
    ok "mode: $1 is $OWNER_UID:$OWNER_GID $3"
  else
    fail "mode: $1 must be a $kind (no symbolic link) owned by $OWNER_UID:$OWNER_GID with mode $3"
  fi
}
exact "$INSTALL_DIR" d 755
exact "$INSTALL_DIR/scheduled-backup.sh" f 555
exact "$INSTALL_DIR/backup.sh" f 444

# 3. The reviewed revision: the entry against the hash computed off the server, backup.sh against the entry's own pin.
ENTRY_OK=0
if [ -f "$INSTALL_DIR/scheduled-backup.sh" ] && [ ! -L "$INSTALL_DIR/scheduled-backup.sh" ]; then
  got=$(sha256sum -- "$INSTALL_DIR/scheduled-backup.sh"); got=${got%% *}
  if [ "$got" = "$ENTRY_SHA256" ]; then ok "entry: sha256 $got matches the reviewed revision"; ENTRY_OK=1
  else fail "entry: sha256 $got does not match the reviewed revision $ENTRY_SHA256"; fi
  pin=$(grep -E -m1 "^readonly BACKUP_SH_SHA256='[0-9a-f]{64}'$" -- "$INSTALL_DIR/scheduled-backup.sh" | grep -Eo '[0-9a-f]{64}' || true)
  if [ -f "$INSTALL_DIR/backup.sh" ] && [ ! -L "$INSTALL_DIR/backup.sh" ] && [ -n "$pin" ]; then
    got=$(sha256sum -- "$INSTALL_DIR/backup.sh"); got=${got%% *}
    [ "$got" = "$pin" ] && ok "backup.sh: sha256 $got matches the entry's pin" || { fail "backup.sh: sha256 $got does not match the entry's pin $pin"; ENTRY_OK=0; }
  else
    fail "backup.sh: missing, a symbolic link, or the entry carries no pin"; ENTRY_OK=0
  fi
else
  fail "entry: $INSTALL_DIR/scheduled-backup.sh is missing or a symbolic link"
fi

# 4. sshd's effective settings for the runtime user (a neutral client address: Match blocks for GitHub's runners cannot be known).
SSHD=$(sshd -T -C "user=$RUNTIME_USER,host=scheduled-backup.invalid,addr=192.0.2.1" 2>/dev/null || true)
setting() { printf '%s\n' "$SSHD" | grep -i -m1 "^$1 " | cut -d' ' -f2- || true; }
if [ -z "$SSHD" ]; then
  fail "sshd: sshd -T printed nothing (configuration error?)"
else
  [ "$(setting pubkeyauthentication)" = yes ] && ok "sshd: pubkeyauthentication yes" || fail "sshd: pubkeyauthentication must be yes"
  for s in forcecommand authorizedkeyscommand; do
    v=$(setting "$s"); [ -z "$v" ] || [ "$v" = none ] && ok "sshd: $s none (the key's command= is not overridden or supplemented)" || fail "sshd: $s must be none"
  done
  [ "$(setting permituserenvironment)" = no ] && ok "sshd: permituserenvironment no" || fail "sshd: permituserenvironment must be no"
  [ "$(setting strictmodes)" = yes ] && ok "sshd: strictmodes yes" || fail "sshd: strictmodes must be yes"
fi
version=$(ssh -V 2>&1 | grep -Eo 'OpenSSH_[0-9]+\.[0-9]+' | head -1 || true); version=${version#OpenSSH_}
if [[ $version =~ ^([0-9]+)\.([0-9]+)$ ]] && { [ "${BASH_REMATCH[1]}" -gt 7 ] || { [ "${BASH_REMATCH[1]}" -eq 7 ] && [ "${BASH_REMATCH[2]}" -ge 2 ]; }; }; then
  ok "openssh: $version supports restrict (7.2 or later)"
else
  fail "openssh: version ${version:-unknown} does not support restrict (7.2 or later)"
fi

# 5. The authorized_keys files sshd reads for the runtime user: the one restricted line, its key on no other line.
FILES=()
set -f
for token in $(setting authorizedkeysfile); do
  [ "$token" = none ] && continue
  token=${token//%%/$'\x01'}; token=${token//%h/$RUNTIME_HOME}; token=${token//%u/$RUNTIME_USER}; token=${token//%U/$RUNTIME_UID}
  token=${token//$'\x01'/%}
  case "$token" in /*) ;; *) token="$RUNTIME_HOME/$token" ;; esac
  FILES+=("$token")
done
set +f
[ "${#FILES[@]}" -gt 0 ] || fail "authorized_keys: sshd names no AuthorizedKeysFile"
LINES=()
for f in "${FILES[@]}"; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  if owned_safe "$f" "$RUNTIME_UID" || owned_safe "$f" 0; then ok "authorized_keys: $f is no symbolic link, owned by the user or root, not group/other-writable"
  else fail "authorized_keys: $f must be no symbolic link, owned by the runtime user or root, and not writable by group or others"; continue; fi
  owned_safe "$(dirname -- "$f")" "$RUNTIME_UID" || owned_safe "$(dirname -- "$f")" 0 \
    && ok "authorized_keys: $(dirname -- "$f") is not group/other-writable" || fail "authorized_keys: $(dirname -- "$f") must be owned by the runtime user or root and not group/other-writable"
  grep -q 'PRIVATE KEY' -- "$f" && fail "authorized_keys: $f contains a private-key marker" || true
  while IFS= read -r line; do LINES+=("$line"); done < <(grep -v -E '^[[:space:]]*(#|$)' -- "$f" || true)
done
named=()
for line in "${LINES[@]}"; do
  case "$line" in *"$KEY_COMMENT"*|*"$INSTALL_DIR"*) named+=("$line") ;; esac
done
if [ "${#named[@]}" -ne 1 ]; then
  fail "authorized_keys: exactly one line must name the scheduled backup (found ${#named[@]})"
else
  re="^${FORCED_OPTIONS//./\\.} ssh-ed25519 (AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]+={0,2}) $KEY_COMMENT\$"
  if [[ ${named[0]} =~ $re ]]; then
    blob=${BASH_REMATCH[1]}
    ok "authorized_keys: the scheduled line is exactly '$FORCED_OPTIONS ssh-ed25519 <key> $KEY_COMMENT'"
    uses=0
    for line in "${LINES[@]}"; do case "$line" in *"$blob"*) uses=$((uses + 1)) ;; esac; done
    [ "$uses" -eq 1 ] && ok "authorized_keys: the scheduled key appears on no other line" || fail "authorized_keys: the scheduled key appears on $uses lines (another line would bypass the forced command)"
    fp=$(printf 'ssh-ed25519 %s\n' "$blob" | ssh-keygen -l -f - 2>/dev/null | cut -d' ' -f2 || true)
    [ -n "$fp" ] && info "scheduled key fingerprint: $fp (match it off the server against the E3 private key)" || fail "authorized_keys: the scheduled key does not parse"
  else
    fail "authorized_keys: the scheduled line must be exactly the template's restricted ed25519 line (options, key type and comment); it is not printed"
  fi
fi

# 6. The forced command refuses, as the runtime user: only once the installed entry is the reviewed revision (nothing else is run).
if [ "$ENTRY_OK" -eq 1 ] && [ "${RUNTIME_UID:-0}" != 0 ]; then
  probe() { runuser -u "$RUNTIME_USER" -- env -i HOME="$RUNTIME_HOME" PATH="$PATH" "$@" >/dev/null 2>&1 && echo 0 || echo $?; }
  [ "$(probe SSH_ORIGINAL_COMMAND=nawara-e2-refusal-probe "$INSTALL_DIR/scheduled-backup.sh")" = 64 ] \
    && ok "forced command: a client command is refused (64) and not run" || fail "forced command: a client command was not refused with 64"
  [ "$(probe "$INSTALL_DIR/scheduled-backup.sh" --refusal-probe)" = 64 ] \
    && ok "forced command: an argument is refused (64) and not run" || fail "forced command: an argument was not refused with 64"
else
  fail "forced command: refusal not probed (the installed entry is not the reviewed revision, or the runtime user is root)"
fi

if [ "$FAILED" -eq 0 ]; then
  printf 'RESULT: PASS (%d checks); nothing was changed\n' "$CHECKS"
  exit 0
fi
printf 'RESULT: FAIL (%d of %d checks failed); nothing was changed; STOP (runbook)\n' "$FAILED" "$CHECKS"
exit 1
