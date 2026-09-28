#!/usr/bin/env bash
# Rotates the password of Auth's RUNTIME database role (`auth_app`) on the VPS, and nothing else. Runs ON THE SERVER, as the deploy
# user; the auth-db-credential-rotate workflow streams it there (it is never taken from an image, so no image is built or pulled):
#
#   bash -s < apps/auth-service/deploy/rotate-db-credential.sh
#
# The runtime password lives in THREE places that must always agree, and this script moves all three together:
#   PostgreSQL   ALTER ROLE auth_app PASSWORD ...
#   db.env       AUTH_APP_PASSWORD   (a normal deploy re-applies THIS value to the role on every run)
#   .env         DATABASE_URL        (what the running Auth container connects with; only its password part changes)
# Rotating only the role and .env would be undone by the next deploy, which would re-apply the old db.env value.
#
# Credential-only: it never runs migrations, never builds or pulls an image, never touches the broker, Audit, Traefik or DNS. Auth is
# recreated from the image ID it is running NOW (`--pull never`), with the configuration read from Docker's own metadata; any setting
# this script cannot reproduce exactly makes it refuse before changing anything.
#
# Secrets: generated here (openssl), never printed, never on a command line (psql and the login checks read them on stdin), never sent
# back to GitHub. The superseded password is kept only in the 0600 journal while the rotation runs, to prove it no longer authenticates.
#
# Maintenance window: Auth is stopped from the moment the role changes until the recreated container is healthy (typically < 1 min).
# Interrupted runs: the journal ($DIR/.rotation-journal) makes the next run RESUME by rolling forward to another fresh password; the
# superseded password is never restored. A normal deploy refuses while the journal exists.
set -euo pipefail
umask 077

DIR="${DEPLOY_DIR:-$HOME/nawara-core/auth-service}"
APP=nawara-core-auth-service
DB=nawara-core-auth-db
ROLE=auth_app
DB_ENV="$DIR/db.env"
APP_ENV="$DIR/.env"
JOURNAL="$DIR/.rotation-journal"
LOCK="$DIR/.rotation.lock"

log() { printf '[rotate] %s\n' "$*"; }
die() { printf '[rotate] ERROR: %s\n' "$*" >&2; exit 1; }
exists() { docker inspect "$1" >/dev/null 2>&1; }
ins() { docker inspect -f "$1" "$2"; }
# The value of KEY in an env file (first occurrence). Only ever assigned to a variable, never printed.
val() { awk -v k="$2=" 'index($0, k) == 1 { print substr($0, length(k) + 1); exit }' "$1"; }
count() { grep -c "^$2=" "$1" || true; }
fresh() { openssl rand -hex 32; } # 256 bits, [0-9a-f]: nothing to URI-encode
tmpfiles=()
MUTATING=""
cleanup() {
  local rc=$?
  [ ${#tmpfiles[@]} -eq 0 ] || rm -f "${tmpfiles[@]}"
  if [ "$rc" != 0 ] && [ -n "$MUTATING" ]; then
    printf '[rotate] INTERRUPTED after changes began: the journal %s is kept. Re-run the rotation to roll forward to a fresh password; never restore the superseded one, and do not deploy Auth until it succeeds.\n' "$JOURNAL" >&2
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- DATABASE_URL (only the password component ever changes)
# scheme://user:password@rest  where rest (host, port, database, query) is kept byte for byte.
URL_RE='^(postgres(ql)?://)([^:@/?#]+):([^@/?#]*)@([^@]+)$'
parse_url() {
  [[ $1 =~ $URL_RE ]] || return 1
  U_SCHEME=${BASH_REMATCH[1]}; U_USER=${BASH_REMATCH[3]}; U_PASS=${BASH_REMATCH[4]}; U_REST=${BASH_REMATCH[5]}
}

# ---------------------------------------------------------------- PostgreSQL
# Role facts over the database container's local socket, as the bootstrap owner (no password involved, nothing secret in argv).
pg_local() { docker exec "$DB" psql -q -v ON_ERROR_STOP=1 -At -U "$PGUSER" -d "$PGDB" -c "$1"; }
# A REAL password login as auth_app over TCP (the container's network address, never loopback): prints `user|rolsuper` on success.
# The password is read from stdin inside the container; it is never on a command line.
pg_login() {
  printf '%s\n' "$1" | docker exec -i "$DB" sh -c \
    'IFS= read -r p; PGPASSWORD="$p" PGCONNECT_TIMEOUT=5 exec psql -h "$1" -p 5432 -U "$2" -d "$3" -w -At -c "SELECT current_user || chr(124) || rolsuper::text FROM pg_roles WHERE rolname = current_user"' \
    sh "$DBIP" "$ROLE" "$PGDB" 2>/dev/null
}
# The new password reaches PostgreSQL inside SQL on stdin. The session first turns off statement logging, so a failing statement
# cannot write the password to the server log either (the bootstrap owner is a superuser, so it may set these).
set_role_password() {
  { printf '%s\n' 'SET log_min_error_statement = panic;' "SET log_statement = 'none';"
    printf "ALTER ROLE %s WITH PASSWORD '%s';\n" "$ROLE" "$1"; } \
    | docker exec -i "$DB" psql -q -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" -f - >/dev/null
}

# ---------------------------------------------------------------- files (atomic: temp file in the same 0700 dir, then rename)
replace_line() { # FILE KEY VALUE: KEY must occur exactly once; every other line, the order, the mode and the owner are kept
  local file=$1 key=$2 value=$3 tmp line n=0 owner
  tmp=$(mktemp "$DIR/.rotate.XXXXXX"); tmpfiles+=("$tmp")
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line == "$key="* ]]; then printf '%s=%s\n' "$key" "$value"; n=$((n + 1)); else printf '%s\n' "$line"; fi
  done <"$file" >"$tmp"
  [ "$n" = 1 ] || die "$key must occur exactly once in $file (found $n)"
  owner=$(stat -c '%u:%g' "$file")
  chmod 600 "$tmp"; chown "$owner" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file"
}
write_journal() { # OLD, TARGET, SUPERSEDED, REF
  local tmp
  tmp=$(mktemp "$DIR/.rotate.XXXXXX"); tmpfiles+=("$tmp")
  printf 'OLD=%s\nTARGET=%s\nSUPERSEDED=%s\nREF=%s\n' "$OLD" "$TARGET" "$SUPERSEDED" "$REF" >"$tmp"
  chmod 600 "$tmp"; mv -f "$tmp" "$JOURNAL"
}

# ---------------------------------------------------------------- the Auth container, from Docker's own metadata
# Reads everything needed to recreate container $1 identically, and refuses any setting it could not reproduce (fail closed).
snapshot() {
  local c=$1 n got want line
  S_IMAGE_ID=$(ins '{{.Image}}' "$c"); S_IMAGE_REF=$(ins '{{.Config.Image}}' "$c")
  [[ $S_IMAGE_ID == sha256:* ]] || die "cannot read the image ID of $c; nothing was changed"
  S_NETMODE=$(ins '{{.HostConfig.NetworkMode}}' "$c")
  mapfile -t S_NETS < <(ins '{{range $n, $_ := .NetworkSettings.Networks}}{{$n}}{{"\n"}}{{end}}' "$c" | awk 'NF')
  mapfile -t S_LABELS < <(ins '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' "$c" | awk 'NF')
  n=$(ins '{{if .Config.Labels}}{{len .Config.Labels}}{{else}}0{{end}}' "$c")
  [ "${#S_LABELS[@]}" = "$n" ] || die "a label of $c spans several lines; refusing to reproduce it; nothing was changed"
  S_RESTART=$(ins '{{.HostConfig.RestartPolicy.Name}}:{{.HostConfig.RestartPolicy.MaximumRetryCount}}' "$c")
  # `index` makes Docker evaluate these on the raw JSON (a typed evaluation fails on it): absent keys are then empty rather than an
  # error, and durations are integers of nanoseconds (normalised below). Deterministic whatever the Docker version.
  S_STOP=$(ins '{{with index .Config "StopTimeout"}}{{.}}{{end}}' "$c")
  S_HC_KIND=$(ins '{{with index .Config "Healthcheck"}}{{index .Test 0}}:{{len .Test}}{{end}}' "$c")
  [ "$S_HC_KIND" = CMD-SHELL:2 ] || die "$c has no shell health check (got '${S_HC_KIND:-none}'); cannot verify or reproduce it; nothing was changed"
  S_HC_CMD=$(ins '{{index (index .Config "Healthcheck") "Test" 1}}' "$c")
  S_HC_TIMES=$(ins '{{with index .Config "Healthcheck"}}{{index . "Interval"}} {{index . "Timeout"}} {{index . "Retries"}} {{index . "StartPeriod"}}{{end}}' "$c")
  # The log driver and its options (Docker copies the daemon's defaults into every container): reproduced as they are.
  S_LOG_DRIVER=$(ins '{{.HostConfig.LogConfig.Type}}' "$c")
  mapfile -t S_LOG_OPTS < <(ins '{{with index .HostConfig.LogConfig "Config"}}{{range $k, $v := .}}{{$k}}={{$v}}{{"\n"}}{{end}}{{end}}' "$c" | awk 'NF')
  mapfile -t S_MOUNTS < <(ins '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Source}}|{{.Destination}}|{{.RW}}{{"\n"}}{{end}}' "$c" | awk 'NF')
  for line in "${S_MOUNTS[@]}"; do
    case "${line%%|*}" in volume | bind) ;; *) die "$c has a mount of type ${line%%|*}; refusing to reproduce it; nothing was changed" ;; esac
  done
  # Everything else a container can carry must be the default (`if`, not `len`: real Docker refuses `len` of a nil field), or the image's own (entrypoint, command, user, working directory).
  local h='index .HostConfig'
  got=$(ins "{{$h \"Privileged\"}}|{{if $h \"CapAdd\"}}cap-add{{end}}|{{if $h \"CapDrop\"}}cap-drop{{end}}|{{if $h \"ExtraHosts\"}}extra-hosts{{end}}|{{if $h \"Dns\"}}dns{{end}}|{{if $h \"SecurityOpt\"}}security-opt{{end}}|{{if $h \"Devices\"}}devices{{end}}|{{if $h \"PortBindings\"}}ports{{end}}|{{if $h \"PublishAllPorts\"}}publish-all{{end}}|{{if $h \"ReadonlyRootfs\"}}read-only{{end}}|{{$h \"Memory\"}}|{{$h \"NanoCpus\"}}|{{if $h \"Tmpfs\"}}tmpfs{{end}}||{{index .Config \"User\"}}|{{json (index .Config \"Entrypoint\")}}|{{json (index .Config \"Cmd\")}}|{{index .Config \"WorkingDir\"}}" "$c")
  want="false||||||||||0|0|||$(docker image inspect -f '{{index .Config "User"}}|{{json (index .Config "Entrypoint")}}|{{json (index .Config "Cmd")}}|{{index .Config "WorkingDir"}}' "$S_IMAGE_ID")"
  [ "$got" = "$want" ] || die "$c carries a setting this script does not reproduce (ports, capabilities, limits, overrides...); nothing was changed"
  # The environment: the container must run exactly .env (plus the image's own variables), apart from DATABASE_URL itself.
  # Compared inside the shell (associative arrays): no value ever becomes an argument of an external command (ps would show it).
  local -A CENV=() IENV=() FENV=()
  while IFS= read -r line; do [ -z "$line" ] || CENV["$line"]=1; done < <(ins '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}' "$c")
  while IFS= read -r line; do [ -z "$line" ] || IENV["$line"]=1; done < <(docker image inspect -f '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}' "$S_IMAGE_ID")
  while IFS= read -r line || [ -n "$line" ]; do [[ $line =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && FENV["$line"]=1; done <"$APP_ENV"
  S_URL=""
  for line in "${!CENV[@]}"; do
    if [[ $line == DATABASE_URL=* ]]; then S_URL=${line#DATABASE_URL=}; continue; fi
    [ -n "${IENV[$line]:-}" ] || [ -n "${FENV[$line]:-}" ] || die "the environment of $c differs from $APP_ENV (a variable is not in the file); nothing was changed"
  done
  for line in "${!FENV[@]}"; do
    [[ $line == DATABASE_URL=* ]] && continue
    [ -n "${CENV[$line]:-}" ] || die "the environment of $c differs from $APP_ENV (a variable was added or changed since it was created); nothing was changed"
  done
}

recreate() { # a new $APP from the snapshot: same image ID (never pulled), same networks, labels, mounts, restart and health settings
  local args=(run -d --pull never --name "$APP" --network "$S_NETMODE" --env-file "$APP_ENV") line n hc t
  case "$S_RESTART" in no:*) ;; on-failure:*) args+=(--restart "$S_RESTART") ;; *) args+=(--restart "${S_RESTART%%:*}") ;; esac
  [ -z "$S_STOP" ] || args+=(--stop-timeout "$S_STOP")
  for line in "${S_LABELS[@]}"; do args+=(--label "$line"); done
  [ -z "$S_LOG_DRIVER" ] || args+=(--log-driver "$S_LOG_DRIVER")
  for line in "${S_LOG_OPTS[@]}"; do args+=(--log-opt "$line"); done
  read -r -a hc <<<"$S_HC_TIMES"
  for t in 0 1 3; do case "${hc[$t]:-}" in '' | '<no value>') hc[t]=0s ;; *[!0-9]*) ;; *) hc[t]="${hc[t]}ns" ;; esac; done
  case "${hc[2]:-}" in '' | '<no value>') hc[2]=0 ;; esac
  args+=(--health-cmd "$S_HC_CMD" --health-interval "${hc[0]}" --health-timeout "${hc[1]}" --health-retries "${hc[2]}" --health-start-period "${hc[3]}")
  for line in "${S_MOUNTS[@]}"; do
    IFS='|' read -r t _name _src _dst _rw <<<"$line"
    if [ "$t" = volume ]; then args+=(-v "$_name:$_dst$([ "$_rw" = true ] || echo :ro)"); else args+=(-v "$_src:$_dst$([ "$_rw" = true ] || echo :ro)"); fi
  done
  args+=("$S_IMAGE_ID")
  docker "${args[@]}" >/dev/null
  for n in "${S_NETS[@]}"; do [ "$n" = "$S_NETMODE" ] || docker network connect "$n" "$APP" >/dev/null; done
}

wait_healthy() {
  local st=""
  for _ in $(seq 1 40); do
    st=$(ins '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$APP" 2>/dev/null || true)
    [ "$st" = running/healthy ] && return 0
    [ "${st%%/*}" = running ] || [ "${st%%/*}" = created ] || break
    sleep 3
  done
  log "  $APP did not become healthy (state: ${st:-missing})"
  return 1
}

# ---------------------------------------------------------------- preflight (nothing is changed before this passes)
[ -f "$DB_ENV" ] || die "$DB_ENV is missing; nothing was changed"
[ -f "$APP_ENV" ] || die "$APP_ENV is missing; nothing was changed"
for f in "$DB_ENV" "$APP_ENV"; do
  [ $((8#$(stat -c '%a' "$f") & 077)) = 0 ] || die "$f is readable by group or others (mode $(stat -c '%a' "$f")); fix it to 0600 first; nothing was changed"
done
command -v openssl >/dev/null || die "openssl is required; nothing was changed"
command -v flock >/dev/null || die "flock is required (util-linux); nothing was changed"
exec 9>"$LOCK"
flock -n 9 || die "another credential rotation is running (lock $LOCK); nothing was changed"

PGUSER=$(val "$DB_ENV" POSTGRES_USER); PGDB=$(val "$DB_ENV" POSTGRES_DB)
[ -n "$PGUSER" ] && [ -n "$PGDB" ] || die "POSTGRES_USER / POSTGRES_DB missing from $DB_ENV; nothing was changed"
[ "$(count "$DB_ENV" AUTH_APP_PASSWORD)" = 1 ] || die "AUTH_APP_PASSWORD must occur exactly once in $DB_ENV; nothing was changed"
[ "$(count "$APP_ENV" DATABASE_URL)" = 1 ] || die "DATABASE_URL must occur exactly once in $APP_ENV; nothing was changed"
exists "$DB" || die "the database container $DB does not exist; nothing was changed"
[ "$(ins '{{.State.Running}}' "$DB")" = true ] || die "the database container $DB is not running; nothing was changed"
DBIP=$(ins '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{"\n"}}{{end}}' "$DB" | awk 'NF { print; exit }')
[ -n "$DBIP" ] || die "cannot find the network address of $DB; nothing was changed"
[ "$(pg_local "SELECT rolsuper FROM pg_roles WHERE rolname = '$ROLE'")" = f ] \
  || die "the role $ROLE does not exist or is a superuser; nothing was changed"
# Control: a random password MUST be refused, or the checks below would prove nothing (a trust rule would accept anything).
if pg_login "$(fresh)" >/dev/null; then die "PostgreSQL accepted a random password for $ROLE over TCP: authentication is not password-based, credentials cannot be verified; nothing was changed"; fi

url=$(val "$APP_ENV" DATABASE_URL)
parse_url "$url" || die "DATABASE_URL in $APP_ENV is not of the form postgres://user:password@host...; nothing was changed"
[ "$U_USER" = "$ROLE" ] || die "DATABASE_URL in $APP_ENV does not connect as $ROLE; nothing was changed"

if [ -f "$JOURNAL" ]; then
  # ---------------------------------------------------------------- resume an interrupted rotation: roll FORWARD
  OLD=$(val "$JOURNAL" OLD); TARGET=$(val "$JOURNAL" TARGET); SUPERSEDED=$(val "$JOURNAL" SUPERSEDED); REF=$(val "$JOURNAL" REF)
  [ -n "$OLD" ] && [ -n "$TARGET" ] && [ -n "$REF" ] || die "the journal $JOURNAL is incomplete; refusing to guess; nothing was changed"
  log "resuming an interrupted rotation: rolling forward to a fresh password (the superseded one is never restored)"
  if ! exists "$REF"; then
    exists "$APP" || die "neither $REF nor $APP exists: the Auth configuration cannot be reconstructed; nothing was changed"
    docker stop -t 60 "$APP" >/dev/null; docker rename "$APP" "$REF"
  elif exists "$APP"; then
    docker rm -f "$APP" >/dev/null # the container of the interrupted attempt
  fi
  snapshot "$REF"
  SUPERSEDED="${SUPERSEDED:+$SUPERSEDED }$TARGET"; TARGET=$(fresh); write_journal; MUTATING=1
else
  # ---------------------------------------------------------------- a fresh rotation
  exists "$APP" || die "the Auth container $APP does not exist; nothing was changed"
  [ "$(ins '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$APP")" = running/healthy ] \
    || die "$APP is not running/healthy; nothing was changed"
  snapshot "$APP"
  OLD=$(val "$DB_ENV" AUTH_APP_PASSWORD)
  [ -n "$OLD" ] || die "AUTH_APP_PASSWORD is empty in $DB_ENV; nothing was changed"
  if [ "$OLD" != "$U_PASS" ] || [ "$S_URL" != "$url" ]; then
    die "PRE-ROTATION CREDENTIAL STATE INCONSISTENT: db.env, .env and the running container do not hold the same credential; nothing was changed"
  fi
  [ "$(pg_login "$OLD")" = "$ROLE|false" ] \
    || die "PRE-ROTATION CREDENTIAL STATE INCONSISTENT: the credential in db.env/.env does not authenticate as $ROLE; nothing was changed"
  REF="$APP-pre-rotation-$(date +%Y%m%d%H%M%S)"; SUPERSEDED=""; TARGET=$(fresh)
  log "preflight OK: $APP runs image $S_IMAGE_REF ($S_IMAGE_ID); $ROLE is not a superuser; db.env, .env, the container and PostgreSQL agree"
  write_journal; MUTATING=1
  log "maintenance window begins: stopping $APP (kept as $REF for its configuration)"
  docker stop -t "${S_STOP:-60}" "$APP" >/dev/null
  docker rename "$APP" "$REF"
fi

# ---------------------------------------------------------------- apply TARGET to all three places, recreate, verify
attempt=1
while :; do
  set_role_password "$TARGET"
  replace_line "$DB_ENV" AUTH_APP_PASSWORD "$TARGET"
  parse_url "$(val "$APP_ENV" DATABASE_URL)" || die "DATABASE_URL in $APP_ENV became unreadable; journal kept, re-run to roll forward"
  replace_line "$APP_ENV" DATABASE_URL "${U_SCHEME}${U_USER}:${TARGET}@${U_REST}"
  ! exists "$APP" || docker rm -f "$APP" >/dev/null
  log "recreating $APP from the same image ($S_IMAGE_ID, never pulled)"
  recreate
  if wait_healthy && [ "$(pg_login "$TARGET")" = "$ROLE|false" ] && [ "$(ins '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}' "$APP" | grep -c '^DATABASE_URL=')" = 1 ] \
    && [ "$(ins '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}' "$APP" | awk 'index($0, "DATABASE_URL=") == 1 { print substr($0, 14); exit }')" = "$(val "$APP_ENV" DATABASE_URL)" ]; then
    break
  fi
  [ "$attempt" -lt 2 ] || die "ROTATION FAILED after a roll-forward retry. Auth is stopped (maintenance); $REF is kept for its configuration; the journal is kept: re-run to roll forward again (never restore the superseded password)"
  log "attempt $attempt did not verify; rolling forward to another fresh password"
  SUPERSEDED="${SUPERSEDED:+$SUPERSEDED }$TARGET"; TARGET=$(fresh); write_journal
  attempt=$((attempt + 1))
done

# Every superseded password must now be refused by PostgreSQL. If one still authenticates, this is NOT a successful rotation.
for s in $OLD $SUPERSEDED; do
  if pg_login "$s" >/dev/null; then
    die "SECURITY FAILURE: a superseded $ROLE password still authenticates. The journal is kept; do not declare the rotation complete"
  fi
done
[ "$(val "$DB_ENV" AUTH_APP_PASSWORD)" = "$TARGET" ] || die "db.env does not hold the new password; journal kept"
[ "$(pg_local "SELECT rolsuper FROM pg_roles WHERE rolname = '$ROLE'")" = f ] || die "$ROLE is a superuser after rotation; journal kept"

rm -f "$JOURNAL"; MUTATING=""
log "OK  $ROLE rotated: PostgreSQL, db.env and .env hold the new password; $APP is running/healthy on the same image ($S_IMAGE_ID)"
log "    new password: authenticates as $ROLE (not a superuser); superseded password(s): REJECTED"
log "    $REF is kept stopped for reference; it still carries the dead password in its metadata: remove it once satisfied"
