#!/usr/bin/env bash
# Core V2 OD-BRK-2b-I: the AUTHENTICATED installation lifecycle of Notification's topology monitor (docs/runbooks/rabbitmq-topology-
# containment.md §2). NOT executed by this repository: the Owner runs it, as root at the console, only under a separate installation
# authorization (OD-BRK-2b-2), then verifies with verify-topology-monitor-install.sh before any separately authorized enablement.
#
#   install-topology-monitor.sh install | upgrade | repair | status
#
# Trust model. The authority is an Owner-SIGNED manifest, never the on-server checkout:
#   - the manifest (generated OFF the server from Git objects at the approved commit: scripts/topology-monitor-manifest.mjs) lists the
#     commit, a monotonic package version, the state schema and the SHA-256 of every artifact; the Owner signs it off the server
#     (`ssh-keygen -Y sign -n nawara-core-topology-install`) and places it, with its signature, in INCOMING (root-only);
#   - the host verifies it against INSTALL_TRUST: one `allowed_signers` line for PRINCIPAL restricted to INSTALL_NAMESPACE, installed by
#     the Owner at the console from an authenticated channel (never from the checkout; its fingerprint is compared off the server);
#   - the checkout is only a SOURCE of bytes: each artifact is hashed and must equal the signed value, then copied to a private staging
#     area that every later step uses. Before running this script the Owner checks its own SHA-256 against the signed manifest with
#     system tools (runbook §2), so the code that verifies is itself approved.
# Lifecycle (one durable transaction at a time, TXN/transaction: staged -> applying -> applied -> verified -> recorded):
#   install  fresh only: refuses when any target, an installation record or a transaction exists; installs the artifacts, the INITIAL
#            state and the inactive latch; never enables or starts a unit.
#   upgrade  the installed record must verify and match the installed files; the new manifest's version must be HIGHER (a rollback is a
#            newly signed manifest with a higher version that names older artifacts) and its state schema the one this installer
#            supports; replaces ONLY the immutable artifacts (scripts, verifier, units), under the monitor's own lock (no monitor, watchdog
#            or recovery run in between). The state, the incident, the nonce ledger, the latch, the evidence and the trust keys are never
#            touched, so no upgrade or rollback can clear a containment or restore a broker permission.
#   repair   completes the recorded transaction from its staged, re-verified copies; creates what is missing, never deletes, never
#            replaces a state, a latch or an incident binding.
#   status   read-only.
# Locks, always in this order: the installation lock, then (upgrade, repair of an upgrade) the monitor's lock.
# Exit: 0 done; 1 refused (validation: nothing was changed by this invocation); 2 invalid invocation, not root or a tool missing;
# 65 an unsafe path, link, owner or trust anchor; 70 an incomplete transaction exists (run `repair`); 75 a lock could not be taken.
set -euo pipefail
umask 077
export LC_ALL=C

# Pinned values (scripts/check-repo.mjs, checkTopologyMonitor).
readonly INSTALL_DIR='/usr/local/libexec/nawara-core-topology'
readonly STATE_DIR='/var/lib/nawara-core-topology-monitor'
readonly LATCH='/var/lib/nawara-core-topology/notification-service.containment'
readonly INCIDENT_FILE='/var/lib/nawara-core-topology/notification-service.incident'
readonly UNIT_DIR='/etc/systemd/system'
readonly INSTALL_STATE='/var/lib/nawara-core-topology-install'
readonly INSTALL_TRUST='/etc/nawara-core-topology/install-allowed-signers'
readonly PRINCIPAL='nawara-core-owner'
readonly INSTALL_NAMESPACE='nawara-core-topology-install'
readonly STATE_SCHEMA=2
readonly RUN_AS_UID=0
readonly OWNER='0:0'
readonly TRUST_ROOT='/'
readonly SAFE_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
readonly LOCK_WAIT=60
readonly SCRIPTS='verify-and-contain.sh topology-watchdog.sh topology-trigger.sh recover-notification-topology.sh install-topology-monitor.sh verify-topology-monitor-install.sh'
readonly UNITS='nawara-core-topology-monitor.service nawara-core-topology-monitor.timer nawara-core-topology-watchdog.service nawara-core-topology-watchdog.timer'
readonly LATCH_INACTIVE=$'nawara-core-topology-containment v1\nservice=notification-service\nstate=inactive'
readonly SIGNER_RE='^nawara-core-owner namespaces="nawara-core-topology-install" (ssh-ed25519|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]{40,400}={0,2}$'
readonly SIG_RE=$'^-----BEGIN SSH SIGNATURE-----\n([A-Za-z0-9+/=]{1,76}\n){1,40}-----END SSH SIGNATURE-----\n$'
PATH=$SAFE_PATH
export PATH

ARTIFACTS="$SCRIPTS verify-topology.sh $UNITS"
INCOMING="$INSTALL_STATE/incoming"
INSTALLED="$INSTALL_STATE/installed"
TXN="$INSTALL_STATE/transaction"
OUID=${OWNER%%:*}; OGID=${OWNER##*:}

usage() { printf '[topology-install] REFUSED: %s\nusage: install-topology-monitor.sh install|upgrade|repair|status\n' "$*" >&2; exit 2; }
refuse() { printf '[topology-install] REFUSED (%s): %s\n' "$1" "$2" >&2; exit 1; }
unsafe() { printf '[topology-install] REFUSED (unsafe): %s\n' "$*" >&2; exit 65; }
log() { printf '[topology-install] %s\n' "$*"; }

[ "$#" -eq 1 ] || usage "exactly one subcommand"
CMD=$1
case "$CMD" in install | upgrade | repair | status) ;; *) usage "unknown subcommand" ;; esac
[ -z "${SSH_ORIGINAL_COMMAND:-}" ] || usage "never run through a forced command"
[ "$EUID" -eq "$RUN_AS_UID" ] || usage "run as root at the console"
for c in install sha256sum ssh-keygen stat readlink dirname mktemp mv cp rm mkdir chmod sync date grep sed head find sort tr flock cat timeout env; do
  command -v "$c" >/dev/null 2>&1 || usage "$c is required"
done

# ---------------------------------------------------------------- trust and substitution primitives
safe_node() { # safe_node <path> <d|f> <octal mask>: that kind, no symbolic link, owned by the owner uid, (mode & mask) == 0, one link
  local p=$1 kind=$2 mask=$3 owner mode
  [ ! -L "$p" ] || return 1
  if [ "$kind" = d ]; then [ -d "$p" ] || return 1; else [ -f "$p" ] || return 1; [ "$(stat -c %h -- "$p")" = 1 ] || return 1; fi
  owner=$(stat -c %u -- "$p") && mode=$(stat -c %a -- "$p") || return 1
  [ "$owner" = "$OUID" ] && (( (8#$mode & 8#$mask) == 0 ))
}
trusted_path() { # every existing ancestor of <path> up to TRUST_ROOT: a real, root-owned directory nobody else may write
  local p
  p=$(dirname -- "$1")
  while :; do
    if [ -e "$p" ] || [ -L "$p" ]; then
      safe_node "$p" d 022 || return 1
      [ "$(readlink -f -- "$p")" = "$p" ] || return 1
    fi
    if [ "$p" = "$TRUST_ROOT" ] || [ "$p" = / ]; then break; fi
    p=$(dirname -- "$p")
  done
}
absent() { [ ! -e "$1" ] && [ ! -L "$1" ]; }
exact() { # exact <variable> <file>: the bytes (trailing newlines kept); fails on a NUL byte or over 8192 bytes
  local __exact_f=$2 __exact_t __exact_n   # names no caller uses (printf -v must reach the caller's variable)
  __exact_n=$(stat -c %s -- "$__exact_f") || return 1
  [ "$__exact_n" -le 8192 ] || return 1
  __exact_t=$(cat -- "$__exact_f" 2>/dev/null; printf x) || return 1
  __exact_t=${__exact_t%x}
  [ "${#__exact_t}" -eq "$__exact_n" ] || return 1
  printf -v "$1" '%s' "$__exact_t"
}
sha() { local h; h=$(sha256sum -- "$1") || return 1; printf '%s' "${h%% *}"; }
write_atomic() { # write_atomic <path> <content> <mode>
  local tmp
  tmp=$(mktemp -- "$(dirname -- "$1")/.tmp.XXXXXXXX") || return 1
  if printf '%s' "$2" >"$tmp" && chmod "$3" -- "$tmp" && sync -- "$tmp" && mv -f -- "$tmp" "$1"; then return 0; fi
  rm -f -- "$tmp"
  return 1
}
copy_atomic() { # copy_atomic <src> <dest> <mode>: a flushed copy renamed over the destination
  cp -- "$1" "$2.txn-new" && chmod "$3" -- "$2.txn-new" && sync -- "$2.txn-new" && mv -f -- "$2.txn-new" "$2"
}
dest_of() { case " $UNITS " in *" $1 "*) printf '%s/%s' "$UNIT_DIR" "$1" ;; *) printf '%s/%s' "$INSTALL_DIR" "$1" ;; esac; }
mode_of() { case "$1" in verify-topology.sh) echo 444 ;; *.service | *.timer) echo 644 ;; *) echo 555 ;; esac; }

# ---------------------------------------------------------------- the Owner-signed manifest
trust_anchor() {
  local signers lines
  trusted_path "$INSTALL_TRUST" && safe_node "$(dirname -- "$INSTALL_TRUST")" d 022 && safe_node "$INSTALL_TRUST" f 022 \
    || unsafe "the installation trust key $INSTALL_TRUST is missing or unsafe (install it at the console first; runbook §2)"
  exact signers "$INSTALL_TRUST" || unsafe "the installation trust key is unreadable or not text"
  lines=$(grep -vE '^[[:space:]]*(#|$)' <<<"$signers" || true)
  [ "$(grep -c '' <<<"$lines")" -eq 1 ] && [[ $lines =~ $SIGNER_RE ]] || unsafe "the installation trust key must be exactly one line: $PRINCIPAL namespaces=\"$INSTALL_NAMESPACE\" <ssh-ed25519 key>"
}
manifest_re() { # the canonical manifest: these lines, in this order, one final newline
  local re a
  re=$'^nawara-core-topology-monitor-manifest v1\ncore_commit=([0-9a-f]{40})\nversion=([1-9][0-9]{0,5})\nstate_schema=([1-9])\n'
  for a in $ARTIFACTS; do re+="file=[0-9a-f]{64} ${a//./\\.}"$'\n'; done
  printf '%s$' "$re"
}
M_COMMIT=''; M_VERSION=0; M_SCHEMA=0; M_FINGERPRINT=''
declare -A M_SHA=()
verify_manifest() { # verify_manifest <dir holding manifest and manifest.sig>: authenticated and parsed into M_*, or refused
  local dir=$1 text sig verdict re a line f
  for f in manifest manifest.sig; do
    safe_node "$dir/$f" f 022 || refuse manifest_file "$dir/$f is missing, not a regular root-owned file with one link, or writable by others"
  done
  exact text "$dir/manifest" || refuse manifest_format "the manifest is unreadable, too large or contains a NUL byte"
  re=$(manifest_re)
  [[ $text =~ $re ]] || refuse manifest_format "the manifest is not exactly the canonical schema (version, fields, artifact set and order, one final newline)"
  M_COMMIT=${BASH_REMATCH[1]}; M_VERSION=$((10#${BASH_REMATCH[2]})); M_SCHEMA=${BASH_REMATCH[3]}
  exact sig "$dir/manifest.sig" || refuse manifest_signature "the signature is unreadable"
  [[ $sig =~ $SIG_RE ]] || refuse manifest_signature "the signature is not one armored OpenSSH signature"
  verdict=$(env -i PATH="$SAFE_PATH" timeout 10 ssh-keygen -Y verify -f "$INSTALL_TRUST" -I "$PRINCIPAL" -n "$INSTALL_NAMESPACE" -s "$dir/manifest.sig" <"$dir/manifest" 2>/dev/null) \
    || refuse manifest_signature "the manifest is not signed by $PRINCIPAL in $INSTALL_NAMESPACE with the installation trust key"
  [[ $verdict =~ ^Good\ \"$INSTALL_NAMESPACE\"\ signature\ for\ $PRINCIPAL\ with\ (ED25519|ED25519-SK)\ key\ (SHA256:[A-Za-z0-9+/]{43})$ ]] || refuse manifest_signature "an unexpected verification answer"
  M_FINGERPRINT=${BASH_REMATCH[2]}
  M_SHA=()
  while IFS= read -r line; do
    if [[ $line =~ ^file=([0-9a-f]{64})\ (.+)$ ]]; then M_SHA[${BASH_REMATCH[2]}]=${BASH_REMATCH[1]}; fi
  done <<<"$text"
  for a in $ARTIFACTS; do [ -n "${M_SHA[$a]:-}" ] || refuse manifest_format "no hash for $a"; done
}

# ---------------------------------------------------------------- the transaction
txn_field() { sed -nE "s/^$1=([A-Za-z0-9_.:-]{1,80})$/\1/p" -- "$TXN/transaction" 2>/dev/null | head -n 1; }
txn_phase() { # txn_phase <phase>: the durable marker (written, flushed, renamed)
  write_atomic "$TXN/transaction" "$(printf 'nawara-core-topology-install-transaction v1\nkind=%s\nfrom_version=%s\nto_version=%s\nmanifest_sha256=%s\nphase=%s\nupdated=%s\n' \
    "$TXN_KIND" "$TXN_FROM" "$M_VERSION" "$(sha "$TXN/manifest")" "$1" "$(date +%s)")" 600 || unsafe "the transaction marker could not be written"
}
stage() { # stage <dir>: the checkout's artifacts, each equal to its signed hash, copied into <dir>/staging (private)
  local into=$1/staging src a f got
  src=$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")
  mkdir -m 700 -- "$into"
  for a in $ARTIFACTS; do
    if [ "$a" = verify-topology.sh ]; then f=$(dirname -- "$src")/verify-topology.sh; else f="$src/$a"; fi
    if [ ! -f "$f" ] || [ -L "$f" ] || [ "$(stat -c %h -- "$f")" != 1 ]; then refuse source_file "the source $f is missing, a symbolic link or a hard link"; fi
    got=$(sha "$f")
    [ "$got" = "${M_SHA[$a]}" ] || refuse source_hash "the source $a ($got) is not the signed artifact (${M_SHA[$a]})"
    cp -- "$f" "$into/$a"
    chmod 0400 -- "$into/$a"
    [ "$(sha "$into/$a")" = "${M_SHA[$a]}" ] || refuse source_hash "the staged copy of $a changed while it was copied"
  done
}
staged_ok() { local a; for a in $ARTIFACTS; do safe_node "$TXN/staging/$a" f 077 && [ "$(sha "$TXN/staging/$a")" = "${M_SHA[$a]}" ] || return 1; done; }
apply_artifacts() { # each artifact atomically: a new root-owned file next to its destination, renamed over it
  local a dest
  for a in $ARTIFACTS; do
    dest=$(dest_of "$a")
    if [ -L "$dest" ] || { [ -e "$dest" ] && [ ! -f "$dest" ]; }; then unsafe "$dest is not a regular file"; fi
    rm -f -- "$dest.txn-new"
    install -o "$OUID" -g "$OGID" -m "0$(mode_of "$a")" -- "$TXN/staging/$a" "$dest.txn-new"
    sync -- "$dest.txn-new"
    mv -f -- "$dest.txn-new" "$dest"
  done
}
verify_installed() { # every installed artifact equals the manifest; owner, group, mode, one link; the install directory holds nothing else
  local a dest contents expected
  safe_node "$INSTALL_DIR" d 022 || return 1
  for a in $ARTIFACTS; do
    dest=$(dest_of "$a")
    safe_node "$dest" f 022 && [ "$(stat -c %a -- "$dest")" = "$(mode_of "$a")" ] && [ "$(stat -c %g -- "$dest")" = "$OGID" ] \
      && [ "$(sha "$dest")" = "${M_SHA[$a]}" ] || return 1
  done
  expected=$(for a in $SCRIPTS verify-topology.sh; do echo "$a"; done | LC_ALL=C sort | tr '\n' ' ')
  contents=$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ')
  [ "$contents" = "$expected" ]
}
record() { # the authenticated record of what is installed, then the history; the transaction ends last
  [ -d "$INSTALLED" ] || mkdir -m 700 -- "$INSTALLED"
  copy_atomic "$TXN/manifest" "$INSTALLED/manifest" 600
  copy_atomic "$TXN/manifest.sig" "$INSTALLED/manifest.sig" 600
  printf '{"v":1,"at_epoch":%s,"kind":"%s","from_version":%s,"to_version":%s,"core_commit":"%s","signer":"%s"}\n' \
    "$(date +%s)" "$TXN_KIND" "${TXN_FROM:-0}" "$M_VERSION" "$M_COMMIT" "$M_FINGERPRINT" >>"$INSTALL_STATE/history.jsonl"
  chmod 600 -- "$INSTALL_STATE/history.jsonl"
  sync -- "$INSTALL_STATE/history.jsonl"
  rm -rf -- "$TXN"
}
fresh_operational_state() { # the INITIAL protected state of a fresh installation: created only when absent, never replaced
  [ -d "$STATE_DIR" ] || install -d -o "$OUID" -g "$OGID" -m 0700 -- "$STATE_DIR"
  [ -d "$STATE_DIR/recovery" ] || install -d -o "$OUID" -g "$OGID" -m 0700 -- "$STATE_DIR/recovery"
  if absent "$STATE_DIR/state"; then
    write_atomic "$STATE_DIR/state" "$(printf 'nawara-core-topology-monitor-state v2\nservice=notification-service\ncontained=0\nincident=none\nunknown_streak=0\nlast_result=NONE\nlast_run=0\n')" 600 || unsafe "the initial state could not be written"
  fi
  if absent "$STATE_DIR/installed"; then
    write_atomic "$STATE_DIR/installed" "$(printf 'nawara-core-topology-monitor installed v1 at=%s\n' "$(date +%s)")" 600 || unsafe "the installation marker could not be written"
  fi
  [ -d "$(dirname -- "$LATCH")" ] || install -d -o "$OUID" -g "$OGID" -m 0755 -- "$(dirname -- "$LATCH")"
  if absent "$LATCH"; then write_atomic "$LATCH" "$LATCH_INACTIVE" 644 || unsafe "the latch could not be written"; fi
  if absent "$INCIDENT_FILE"; then write_atomic "$INCIDENT_FILE" "$(printf 'nawara-core-topology-incident v1\nservice=notification-service\nincident=none')" 644 || unsafe "the incident binding could not be written"; fi
}
installed_schema() { # the schema of the protected state that exists (it is never migrated here)
  local first
  first=$(head -n 1 -- "$STATE_DIR/state" 2>/dev/null || true)
  if [[ $first =~ ^nawara-core-topology-monitor-state\ v([0-9]+)$ ]]; then echo "${BASH_REMATCH[1]}"; else echo 0; fi
}
monitor_lock() { # the monitor's own lock: no monitor, watchdog or recovery run while artifacts are replaced
  [ ! -L "$STATE_DIR/lock" ] || unsafe "$STATE_DIR/lock is a symbolic link"
  exec 9>>"$STATE_DIR/lock"
  flock -w "$LOCK_WAIT" 9 || { printf '[topology-install] REFUSED: a monitor, watchdog or recovery run holds the lock; nothing was changed\n' >&2; exit 75; }
}

# ---------------------------------------------------------------- the run
[ -d "$INSTALL_STATE" ] && [ ! -L "$INSTALL_STATE" ] || unsafe "$INSTALL_STATE (with the Owner's signed manifest in incoming/) does not exist"
trusted_path "$INSTALL_STATE" && safe_node "$INSTALL_STATE" d 077 || unsafe "$INSTALL_STATE must be a root-owned directory with no group or other access, under trusted parents"
[ ! -L "$INSTALL_STATE/lock" ] || unsafe "$INSTALL_STATE/lock is a symbolic link"
exec 8>>"$INSTALL_STATE/lock"
flock -w "$LOCK_WAIT" 8 || { printf '[topology-install] REFUSED: another installation step holds the lock\n' >&2; exit 75; }

if [ "$CMD" = status ]; then
  if [ -e "$TXN" ]; then log "transaction: OPEN (kind=$(txn_field kind) phase=$(txn_field phase) to_version=$(txn_field to_version)); run repair"; else log "transaction: none"; fi
  if [ -f "$INSTALLED/manifest" ]; then log "installed: $(sed -nE 's/^(core_commit|version|state_schema)=/\1 /p' -- "$INSTALLED/manifest" | tr '\n' ' ')"; else log "installed: nothing recorded"; fi
  exit 0
fi

trust_anchor
for p in "$INSTALL_DIR" "$STATE_DIR" "$LATCH" "$INCIDENT_FILE" "$UNIT_DIR/x" "$INSTALL_TRUST"; do
  trusted_path "$p" || unsafe "an ancestor of $p is not a real, root-owned directory that only root may write"
done

if [ "$CMD" = repair ]; then
  [ -d "$TXN" ] && [ -f "$TXN/transaction" ] || refuse no_transaction "there is no transaction to repair"
  safe_node "$TXN" d 077 || unsafe "$TXN is unsafe"
  verify_manifest "$TXN"
  TXN_KIND=$(txn_field kind); TXN_FROM=$(txn_field from_version)
  [ "$(txn_field manifest_sha256)" = "$(sha "$TXN/manifest")" ] && [ "$(txn_field to_version)" = "$M_VERSION" ] || refuse transaction_mismatch "the transaction does not record this manifest"
  case "$TXN_KIND" in install | upgrade) ;; *) refuse transaction_mismatch "unknown transaction kind" ;; esac
  if [ "$(txn_field phase)" = staged ] && ! staged_ok; then
    # interrupted while staging: nothing was applied yet; staging again from the checkout, against the same signed hashes
    rm -rf -- "$TXN/staging"
    stage "$TXN"
  fi
  staged_ok || refuse staging_invalid "the staged artifacts are missing or do not equal the signed manifest (nothing was changed)"
  if [ "$TXN_KIND" = upgrade ]; then monitor_lock; fi
  txn_phase applying
  if [ "$TXN_KIND" = install ] && [ ! -d "$INSTALL_DIR" ]; then install -d -o "$OUID" -g "$OGID" -m 0755 -- "$INSTALL_DIR"; fi
  apply_artifacts
  if [ "$TXN_KIND" = install ]; then fresh_operational_state; fi
  txn_phase applied
  verify_installed || refuse post_verification "the installed artifacts do not equal the signed manifest after repair (the transaction stays open)"
  txn_phase verified
  record
  log "repaired: the $TXN_KIND transaction to version $M_VERSION is complete; no unit was enabled or started"
  exit 0
fi

if [ -e "$TXN" ] || [ -L "$TXN" ]; then
  printf '[topology-install] REFUSED (incomplete_transaction): a %s transaction is open (phase %s); run repair\n' "$(txn_field kind)" "$(txn_field phase)" >&2
  exit 70
fi
safe_node "$INCOMING" d 077 || unsafe "$INCOMING must be a root-owned directory with no group or other access"

if [ "$CMD" = install ]; then
  absent "$INSTALLED/manifest" || refuse already_installed "an installation is recorded: use upgrade"
  for p in "$INSTALL_DIR" "$STATE_DIR" "$LATCH" "$INCIDENT_FILE" $(for u in $UNITS; do echo "$UNIT_DIR/$u"; done); do
    absent "$p" || refuse target_exists "$p already exists (fresh installation only: never over an existing state, latch, incident or unit)"
  done
  [ -d "$UNIT_DIR" ] || refuse unit_dir "$UNIT_DIR does not exist"
  TXN_KIND=install; TXN_FROM=0
else
  # upgrade: the current installation must be the authenticated, intact one
  safe_node "$INSTALLED" d 077 || refuse not_installed "no authenticated installation is recorded"
  verify_manifest "$INSTALLED"
  CUR_VERSION=$M_VERSION
  verify_installed || refuse installation_not_intact "the installed artifacts do not equal the recorded manifest (tampering or an interrupted change: investigate)"
  TXN_KIND=upgrade; TXN_FROM=$CUR_VERSION
fi

# the new manifest: a private copy, authenticated, then checked against what may be installed over what
TMPM=$(mktemp -d -- "$INSTALL_STATE/.incoming.XXXXXXXX")
trap 'rm -rf -- "$TMPM"' EXIT
for f in manifest manifest.sig; do
  safe_node "$INCOMING/$f" f 022 || refuse manifest_file "$INCOMING/$f is missing, not a regular root-owned file with one link, or writable by others"
  cp -- "$INCOMING/$f" "$TMPM/$f"
done
verify_manifest "$TMPM"
[ "$M_SCHEMA" = "$STATE_SCHEMA" ] || refuse schema "the manifest is for state schema $M_SCHEMA; this installer installs schema $STATE_SCHEMA only (a migration is a separate, explicit procedure)"
if [ "$TXN_KIND" = upgrade ]; then
  [ "$M_VERSION" -gt "$CUR_VERSION" ] || refuse downgrade "version $M_VERSION is not higher than the installed $CUR_VERSION (a rollback is a newly signed, higher version)"
  [ "$(installed_schema)" = "$STATE_SCHEMA" ] || refuse schema "the protected state is not schema $STATE_SCHEMA (never migrated by an upgrade)"
  monitor_lock
fi

# the artifacts, verified and staged privately BEFORE anything is recorded or changed (a bad source refuses with nothing to repair)
stage "$TMPM"
# the transaction: recorded BEFORE any destination changes
mkdir -m 700 -- "$TXN"
cp -- "$TMPM/manifest" "$TXN/manifest"
cp -- "$TMPM/manifest.sig" "$TXN/manifest.sig"
chmod 600 -- "$TXN/manifest" "$TXN/manifest.sig"
mv -- "$TMPM/staging" "$TXN/staging"
txn_phase staged
txn_phase applying
if [ "$TXN_KIND" = install ]; then install -d -o "$OUID" -g "$OGID" -m 0755 -- "$INSTALL_DIR"; fi
apply_artifacts
if [ "$TXN_KIND" = install ]; then fresh_operational_state; fi
txn_phase applied
verify_installed || refuse post_verification "the installed artifacts do not equal the signed manifest (the transaction stays open: run repair)"
txn_phase verified
record
rm -f -- "$INCOMING/manifest" "$INCOMING/manifest.sig"
log "$TXN_KIND complete: version $M_VERSION (core $M_COMMIT, signed by $M_FINGERPRINT); units copied, NOT enabled, NOT started"
if [ "$TXN_KIND" = upgrade ]; then log "units may have changed: a daemon-reload is a separately authorized operational step"; fi
exit 0
