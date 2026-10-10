#!/usr/bin/env bash
# Isolated restore drill for a backup made by infra/backup/backup.sh (Stage 21.x G5; production-readiness.md §3 success criteria).
# Runs in the RECOVERY ENVIRONMENT, the only place the private key may be (D2), never against a production database:
#
#   SERVICE=auth-service STAMP=latest PRIVATE_KEY_FILE=… IMAGE=ghcr.io/…/nawara-core-auth-service@sha256:… \
#     BACKUP_DIR=<dir with destination.env + s3-credentials.env>   bash infra/backup/restore-drill.sh
#   (or SOURCE_DIR=<dir holding the four downloaded objects> instead of BACKUP_DIR)
#
# The target is ALWAYS a new pair of drill containers this script creates: `nawara-drill-<service>-<id>-db` on `--network none`
# (no route to anything: no broker, no Auth, no Organization, no internet) and `…-app` sharing only that namespace. It refuses a
# production container name, an existing drill name, and (unless RESTORE_ON_PRODUCTION_HOST=yes) a Docker host that runs the
# production databases. There is no mode that writes to a production database: production recovery is the runbook procedure,
# docs/runbooks/core-backup-restore.md §5.
#
# Sequence (the order proven in the G5 investigation):
#   verify the manifest and every encrypted object's sha256 (before decrypting) -> decrypt in a 0700 work directory -> dump sha256
#   -> drill database (the manifest's PostgreSQL major) -> roles and default privileges first (as the deploy), no migrations
#   -> pg_restore --exit-on-error inside the drill container -> the image's own migration runner (history kept; only later
#   migrations may apply) -> the deploy's schema_migrations narrowing -> fail-closed checks: runtime role attributes,
#   schema_migrations SELECT-only, the deploy's forbidden/required privileges (Organization), and EVERY restore fact recorded at
#   backup time (row counts, structure, migration digest, owners, ACLs, authority state) -> the service booted in the drill
#   namespace (never with a production broker URL) -> GET /ready -> the application-level read (organization-service: the known
#   Company through the API; auth-service: the hierarchy authority marker through the service's own CLI, compared with the value
#   recorded at the backup source; no user row is needed or read) -> remove the drill containers AND their volumes; remove all
#   plaintext. KEEP_DRILL=yes (local debugging only, never for G5 evidence) keeps the containers and the restored data.
# Prints states, counts of checks and PASS/FAIL only: never a secret, a row count or a restored value.
# audit-service (V2 A13) adds, in the same namespace: a DISPOSABLE broker (the production broker's pinned image, a drill-only user, never a
# production broker) so the real /ready (database, migrations, broker, ingestion consumer) can pass; facts compared BEFORE the deploy's
# schema_migrations narrowing (a source still at O3-B is reported); the deploy's privilege assertion; append-only and privilege controls
# (LOCAL / DISPOSABLE RESTORE MUTATION, rolled back); and the newest record recorded at backup time read back through the platform API
# with a drill-only reader. Audit production recovery never drops the live database: docs/runbooks/core-backup-restore.md §6A.
set -euo pipefail
umask 077

: "${SERVICE:?SERVICE is required (organization-service | auth-service | audit-service)}"
: "${STAMP:?STAMP is required (the backup timestamp, e.g. 20260929T021700Z, or latest)}"
: "${PRIVATE_KEY_FILE:?PRIVATE_KEY_FILE is required (the recovery private key, kept off the production host)}"
: "${IMAGE:?IMAGE is required (the service image to verify with: the release that made the backup, or a later one)}"

log() { printf '[restore-drill] %s\n' "$*"; }
die() { printf '[restore-drill] ERROR: %s\n' "$*" >&2; exit 1; }
PASS=0
ok() { PASS=$((PASS + 1)); log "  PASS  $*"; }

case "$SERVICE" in
  organization-service)
    DB_NAME=organization; BOOT_USER=organization_admin; BOOT_DB=postgres; OWNER=organization_migrator; RUNTIME=organization_app
    MIGRATE=(../../libs/service-kit/dist/cli/migrate.js --dir db/migrations); KNOWN_SQL='SELECT name FROM company WHERE id = '
    MIGRATE_SUMMARY='^migrations: ([0-9]+) applied, ([0-9]+) already applied$'  # libs/service-kit/src/cli/migrate.ts
    CONFIG_ALLOWED='^(db\.env|roles\.env|\.env|callers/?|callers/[a-z-]+\.token)$' ;;
  auth-service)
    DB_NAME=auth; BOOT_USER=auth; BOOT_DB=auth; OWNER=auth; RUNTIME=auth_app
    MIGRATE=(dist/cli/migrate.js)
    MIGRATE_SUMMARY='^migrations: ([0-9]+) applied, ([0-9]+) already applied, ([0-9]+) checksum\(s\) recorded$'  # apps/auth-service/src/cli/migrate.ts
    CONFIG_ALLOWED='^(db\.env|\.env)$' ;;
  audit-service)
    # V2 A13: the append-only evidence store. Its /ready needs a broker and the ingestion consumer, so the drill adds a DISPOSABLE broker
    # in the same no-network namespace (never a production one), and reads back the newest record recorded at backup time.
    DB_NAME=audit; BOOT_USER=audit_admin; BOOT_DB=postgres; OWNER=audit_migrator; RUNTIME=audit_app
    MIGRATE=(../../libs/service-kit/dist/cli/migrate.js --dir db/migrations)
    MIGRATE_SUMMARY='^migrations: ([0-9]+) applied, ([0-9]+) already applied$'  # libs/service-kit/src/cli/migrate.ts
    CONFIG_ALLOWED='^(db\.env|roles\.env|\.env)$' ;;
  *) die "unknown SERVICE '$SERVICE' (known: organization-service auth-service audit-service)" ;;
esac
# The disposable drill broker: the production broker's pinned image (infra/rabbitmq/provision.sh), nothing else of production.
MQ_IMAGE='rabbitmq:3.13.7-alpine@sha256:d7af1c87c5f1eda13fcfca06db452bf3aeab6619fc3358b68535c0c02c4e52bc'
MQ_VHOST=nawara-core
[[ $STAMP =~ ^([0-9]{8}T[0-9]{6}Z|latest)$ ]] || die "STAMP must be YYYYmmddTHHMMSSZ or latest"
# The application-level read differs per service: Organization reads a known Company through its API (KNOWN_ID: a Company id written
# before the backup); Auth reads its hierarchy authority marker (a structural singleton: no user row, no personal data), so a fresh
# Auth database with no user at all can be drilled.
if [ "$SERVICE" = organization-service ]; then
  : "${KNOWN_ID:?KNOWN_ID is required for organization-service (the id of a Company written before the backup)}"
  [[ $KNOWN_ID =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "KNOWN_ID must be a lowercase UUID"
elif [ "$SERVICE" = auth-service ]; then
  [ -z "${KNOWN_ID:-}" ] || die "KNOWN_ID is not used for auth-service (its application-level check reads the hierarchy authority marker); unset it"
else
  [ -z "${KNOWN_ID:-}" ] || die "KNOWN_ID is not used for audit-service (its application-level check reads back the record recorded at backup time); unset it"
fi
for c in docker openssl sha256sum tar; do command -v "$c" >/dev/null || die "$c is required"; done
[ -f "$PRIVATE_KEY_FILE" ] || die "PRIVATE_KEY_FILE does not exist"
[ "$(stat -c %a "$PRIVATE_KEY_FILE")" = 600 ] || [ "$(stat -c %a "$PRIVATE_KEY_FILE")" = 400 ] || die "PRIVATE_KEY_FILE must be mode 0600 or 0400"
if [ -n "${SOURCE_DIR:-}" ]; then [ -d "$SOURCE_DIR" ] || die "SOURCE_DIR does not exist"
else
  : "${BACKUP_DIR:?BACKUP_DIR (with destination.env and s3-credentials.env) or SOURCE_DIR is required}"
  for f in destination.env s3-credentials.env; do [ -f "$BACKUP_DIR/$f" ] || die "$BACKUP_DIR/$f is missing"; done
fi

# ---------------------------------------------------------------- the target: never production, never ambiguous
for prod in nawara-core-organization-db nawara-core-auth-db nawara-core-audit-db; do
  if docker inspect "$prod" >/dev/null 2>&1 && [ "${RESTORE_ON_PRODUCTION_HOST:-}" != yes ]; then
    die "this Docker host runs $prod: a drill belongs in the recovery environment (the private key stays off the production host); set RESTORE_ON_PRODUCTION_HOST=yes only for an approved on-host drill"
  fi
done
DRILL_ID="${DRILL_ID:-$(date -u +%Y%m%d%H%M%S)}"
[[ $DRILL_ID =~ ^[a-z0-9-]{1,32}$ ]] || die "DRILL_ID must be [a-z0-9-]{1,32}"
DDB="nawara-drill-$SERVICE-$DRILL_ID-db"; DAPP="nawara-drill-$SERVICE-$DRILL_ID-app"; DMQ="nawara-drill-$SERVICE-$DRILL_ID-mq"
DRILL_CONTAINERS=("$DAPP" "$DDB")
[ "$SERVICE" != audit-service ] || DRILL_CONTAINERS=("$DAPP" "$DMQ" "$DDB")
for n in "${DRILL_CONTAINERS[@]}"; do
  case "$n" in nawara-core-*) die "refusing a production container name ($n)" ;; esac
  ! docker inspect "$n" >/dev/null 2>&1 || die "$n already exists: a drill always starts from nothing (choose another DRILL_ID)"
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/nawara-restore-drill.XXXXXX")
cleanup() {
  # -v: the postgres image keeps its data in an anonymous volume; without it the restored data would outlive the drill.
  if [ "${KEEP_DRILL:-}" != yes ]; then docker rm -f -v "${DRILL_CONTAINERS[@]}" >/dev/null 2>&1 || true
  else log "KEEP_DRILL=yes: ${DRILL_CONTAINERS[*]} are kept WITH the restored data; remove them with: docker rm -f -v ${DRILL_CONTAINERS[*]}"; fi
  rm -rf -- "$WORK"
}
STARTED=$SECONDS
trap cleanup EXIT

# ---------------------------------------------------------------- 1. the backup set (downloaded, then checked before decryption)
if [ -z "${SOURCE_DIR:-}" ]; then
  conf() { sed -n "s/^$1=//p" "$BACKUP_DIR/destination.env" | tail -n 1; }
  ENDPOINT=$(conf BACKUP_S3_ENDPOINT); BUCKET=$(conf BACKUP_S3_BUCKET); REGION=$(conf BACKUP_S3_REGION); PREFIX=$(conf BACKUP_S3_PREFIX)
  S3_NET=$(conf BACKUP_S3_DOCKER_NETWORK)
  [[ $PREFIX =~ ^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$ && $PREFIX != *..* ]] || die "BACKUP_S3_PREFIX is invalid"
  s3() {
    local net=(); [ -z "$S3_NET" ] || net=(--network "$S3_NET")
    docker run --rm "${net[@]}" --user "$(id -u):$(id -g)" --env-file "$BACKUP_DIR/s3-credentials.env" -e HOME=/tmp -e AWS_DEFAULT_REGION="$REGION" \
      -e AWS_PAGER= -e AWS_REQUEST_CHECKSUM_CALCULATION=when_required -e AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
      -v "$WORK:/work" 'amazon/aws-cli:2.27.49@sha256:1b7003e3ecb737b7533d8e16a547b4bc36e912508c3532ae51003aad8d0cd41d' \
      --endpoint-url "$ENDPOINT" "$@"
  }
  if [ "$STAMP" = latest ]; then
    STAMP=$(s3 s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/$SERVICE/" --query 'Contents[].[Key]' --output text 2>/dev/null \
      | grep -E "/$SERVICE-[0-9]{8}T[0-9]{6}Z\.manifest$" | sed -E 's/.*-([0-9]{8}T[0-9]{6}Z)\.manifest$/\1/' | sort -r | head -n 1 || true)
    [ -n "$STAMP" ] || die "no complete backup set (manifest) for $SERVICE under the prefix"
  fi
  for s in manifest db.dump.cms config.tar.cms facts.cms; do
    s3 s3api get-object --bucket "$BUCKET" --key "$PREFIX/$SERVICE/$SERVICE-$STAMP.$s" "/work/$s" >/dev/null 2>&1 || die "could not download $SERVICE-$STAMP.$s"
  done
else
  if [ "$STAMP" = latest ]; then
    STAMP=$(find "$SOURCE_DIR" -maxdepth 1 -name "$SERVICE-*.manifest" -printf '%f\n' | sed -E 's/.*-([0-9]{8}T[0-9]{6}Z)\.manifest$/\1/' | sort -r | head -n 1)
    [ -n "$STAMP" ] || die "no manifest for $SERVICE in SOURCE_DIR"
  fi
  for s in manifest db.dump.cms config.tar.cms facts.cms; do
    [ -f "$SOURCE_DIR/$SERVICE-$STAMP.$s" ] || die "$SERVICE-$STAMP.$s is missing from SOURCE_DIR"
    cp "$SOURCE_DIR/$SERVICE-$STAMP.$s" "$WORK/$s"
  done
fi
log "drill of $SERVICE backup $STAMP into $DDB (network none)"

mf() { sed -n "s/^$1=//p" "$WORK/manifest" | head -n 1; }
[ "$(mf format)" = nawara-core-backup/1 ] || die "unknown manifest format"
[ "$(mf service)" = "$SERVICE" ] && [ "$(mf stamp)" = "$STAMP" ] || die "the manifest does not describe $SERVICE $STAMP"
[ "$(mf cipher)" = cms-aes-256-cbc ] || die "unknown cipher in the manifest"
PG_MAJOR=$(mf postgres | cut -d. -f1); [[ $PG_MAJOR =~ ^[0-9]{2}$ ]] || die "the manifest names no PostgreSQL major"
for a in db:db.dump.cms config:config.tar.cms facts:facts.cms; do
  read -r _ size sha <<<"$(mf "artifact.${a%%:*}")"
  [ "$(stat -c %s "$WORK/${a#*:}")" = "$size" ] && [ "$(sha256sum "$WORK/${a#*:}" | cut -d' ' -f1)" = "$sha" ] \
    || die "${a#*:} does not match its manifest (size or sha256): corrupted or substituted; nothing was decrypted"
done
ok "manifest and encrypted objects match (sha256), before decryption"

# ---------------------------------------------------------------- 2. decrypt (private key from custody; passphrase via env only)
pass=(); [ -z "${BACKUP_KEY_PASSPHRASE:-}" ] || pass=(-passin env:BACKUP_KEY_PASSPHRASE)
for f in db.dump config.tar facts.txt; do
  if [ "$f" = facts.txt ]; then src=facts.cms; else src=$f.cms; fi
  openssl cms -decrypt -binary -inform DER -in "$WORK/$src" -inkey "$PRIVATE_KEY_FILE" "${pass[@]}" -out "$WORK/$f" 2>/dev/null \
    || die "decryption of $src failed (wrong key or damaged object)"
done
[ "$(sha256sum "$WORK/db.dump" | cut -d' ' -f1)" = "$(mf dump_sha256)" ] || die "the decrypted dump does not match the manifest's sha256"
[ "$(head -c 5 "$WORK/db.dump")" = PGDMP ] || die "the decrypted dump is not a custom-format archive"
ok "decrypted; the dump matches its recorded sha256"
while read -r perm _ _ _ _ name; do   # GNU tar -tv: mode owner size date time name
  name=${name#./}
  [[ $name =~ $CONFIG_ALLOWED ]] || die "unexpected entry in the secret-file archive: refusing"
  case "$perm" in -rw-------|drwx------) ;; *) die "a secret file in the archive is not 0600 (or its directory 0700)" ;; esac
done < <(tar -tvf "$WORK/config.tar")
ok "secret-file archive: only the expected names, modes 0600/0700 (contents not printed)"

# ---------------------------------------------------------------- 3. the drill database: no network, roles before the restore
secret() { openssl rand -hex 24; }
BOOT_PASS=$(secret); OWNER_PASS=$(secret); RUNTIME_PASS=$(secret)
printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n' "$BOOT_USER" "$BOOT_PASS" "$BOOT_DB" >"$WORK/db.env"
docker run -d --name "$DDB" --network none --env-file "$WORK/db.env" "postgres:$PG_MAJOR-alpine" >/dev/null
# Over TCP loopback (V2 A13.3b): the image's temporary init server listens on the socket only and is stopped and restarted before the
# final server, so a socket probe can pass during init and the next step hit the restart.
for _ in $(seq 1 60); do docker exec "$DDB" pg_isready -h 127.0.0.1 -U "$BOOT_USER" -d "$BOOT_DB" -q >/dev/null 2>&1 && break; sleep 1; done
docker exec "$DDB" pg_isready -h 127.0.0.1 -U "$BOOT_USER" -d "$BOOT_DB" -q >/dev/null 2>&1 || die "the drill database did not start"
sql() { docker exec -i "$DDB" psql -X -q -v ON_ERROR_STOP=1 -U "$BOOT_USER" -d "$1" -f - >/dev/null; }
q() { docker exec "$DDB" psql -X -q -At -v ON_ERROR_STOP=1 -U "$BOOT_USER" -d "$DB_NAME" -c "$1"; }
ROLE_ATTRS='LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
if [ "$SERVICE" = organization-service ]; then
  # As apps/organization-service/deploy/provision-and-deploy.sh step 1: roles, database, schema owner, default privileges.
  printf '%s\n' "CREATE ROLE organization_migrator WITH $ROLE_ATTRS PASSWORD '$OWNER_PASS';" \
    "CREATE ROLE organization_app WITH $ROLE_ATTRS PASSWORD '$RUNTIME_PASS';" \
    'CREATE DATABASE organization OWNER organization_migrator;' 'REVOKE ALL ON DATABASE organization FROM PUBLIC;' \
    'GRANT CONNECT ON DATABASE organization TO organization_app;' | sql postgres
  printf '%s\n' 'REVOKE ALL ON SCHEMA public FROM PUBLIC;' 'ALTER SCHEMA public OWNER TO organization_migrator;' 'GRANT USAGE ON SCHEMA public TO organization_app;' \
    'ALTER DEFAULT PRIVILEGES FOR ROLE organization_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO organization_app;' \
    'ALTER DEFAULT PRIVILEGES FOR ROLE organization_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO organization_app;' | sql organization
elif [ "$SERVICE" = audit-service ]; then
  # As apps/audit-service/deploy/provision-and-deploy.sh: roles, database, schema owner, default privileges (never ON ALL TABLES).
  printf '%s\n' "CREATE ROLE audit_migrator WITH $ROLE_ATTRS PASSWORD '$OWNER_PASS';" \
    "CREATE ROLE audit_app WITH $ROLE_ATTRS PASSWORD '$RUNTIME_PASS';" \
    'CREATE DATABASE audit OWNER audit_migrator;' 'REVOKE ALL ON DATABASE audit FROM PUBLIC;' \
    'GRANT CONNECT ON DATABASE audit TO audit_app;' | sql postgres
  printf '%s\n' 'REVOKE ALL ON SCHEMA public FROM PUBLIC;' 'ALTER SCHEMA public OWNER TO audit_migrator;' 'GRANT USAGE ON SCHEMA public TO audit_app;' \
    'ALTER DEFAULT PRIVILEGES FOR ROLE audit_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO audit_app;' \
    'ALTER DEFAULT PRIVILEGES FOR ROLE audit_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO audit_app;' | sql audit
else
  # auth: the bootstrap owner is the image's POSTGRES_USER (as production); auth_app must exist before the restore (its grants).
  printf '%s\n' "CREATE ROLE auth_app WITH $ROLE_ATTRS PASSWORD '$RUNTIME_PASS';" | sql auth
  OWNER_PASS=$BOOT_PASS
fi
ok "drill database (postgres:$PG_MAJOR-alpine, network none) with its roles, before the restore"

docker exec -i "$DDB" pg_restore -U "$BOOT_USER" -d "$DB_NAME" --exit-on-error <"$WORK/db.dump" >/dev/null 2>"$WORK/restore.err" \
  || die "pg_restore --exit-on-error failed: $(grep -m1 -oE 'ERROR: +[^\"]{0,120}' "$WORK/restore.err" | sed 's/[0-9a-f]\{32,\}/<redacted>/g' || true)"
rm -f "$WORK/db.dump"
ok "pg_restore --exit-on-error (the container's own PostgreSQL $PG_MAJOR tooling)"

# ---------------------------------------------------------------- 4. the release's own migrations, then the deploy's narrowing
printf 'MIGRATION_DATABASE_URL=postgres://%s:%s@127.0.0.1:5432/%s\n' "$OWNER" "$OWNER_PASS" "$DB_NAME" >"$WORK/migrate.env"
# The runner's own exit status decides first (never hidden behind a filter); only a successful run's summary line is then read, and
# it must match the service's runner contract exactly. On failure the runner's text is never printed: its first
# `migration failed:` line is matched against the kit runner's own refusal templates (libs/service-kit/src/db/migrations.ts) and
# reported as a fixed category, plus migration file names that match the runner's file-name rule. Anything else (a PostgreSQL
# error, a value, a URL) is only "unclassified".
migration_failure() {
  local line cat='' n names=() shown=() re_name='[A-Za-z0-9][A-Za-z0-9_.-]*\.sql'
  local re_list="\\(($re_name(, $re_name)*)\\)"
  line=$(grep -m1 -E '^migration failed: ' <<<"$1" || true); line=${line#migration failed: }
  if [ -z "$line" ]; then echo "no reason reported"; return; fi
  if [[ $line == 'MIGRATION_DATABASE_URL '* ]]; then echo "configuration: the runner was given no migration database URL"; return; fi
  if [[ $line =~ ^($re_name)\ was\ modified\ after\ it\ was\ applied$ ]]; then
    echo "history: an applied migration was modified: ${BASH_REMATCH[1]}"; return; fi
  if [[ $line =~ ^($re_name)\ failed\ and\ was\ rolled\ back:\  ]]; then
    echo "a later migration failed and was rolled back (database error withheld): ${BASH_REMATCH[1]}"; return; fi
  if [[ $line =~ ^the\ database\ records\ migrations\ this\ release\ does\ not\ contain\ $re_list:\ it\ was\ migrated\ by\ a\ newer\ or\ a\ different\ release\;\ refusing\ to\ continue$ ]]; then
    cat="history: the database records migrations this image does not contain (a newer or different release)"
  elif [[ $line =~ ^pending\ migrations\ sort\ before\ already-applied\ ones\ $re_list:\ the\ history\ cannot\ be\ ordered\;\ refusing\ to\ continue$ ]]; then
    cat="history: pending migrations sort before applied ones"
  elif [[ $line =~ ^(invalid|duplicate)\ migration\ file\ name:\  || $line =~ ^$re_name\ must\ (be\ exactly\ one|not\ contain\ BEGIN/COMMIT)\  ]]; then
    echo "image: its migration files are invalid"; return
  elif [[ $line =~ (password\ authentication\ failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Connection\ terminated|the\ database\ system\ is) ]]; then
    echo "database: connection or login refused (details withheld)"; return
  else echo "unclassified (details withheld)"; return; fi
  IFS=', ' read -r -a names <<<"${BASH_REMATCH[1]}"
  for n in "${names[@]}"; do [[ $n =~ ^$re_name$ ]] && shown+=("$n"); done
  [ "${#shown[@]}" -le 5 ] || shown=("${shown[@]:0:5}" "+$((${#shown[@]} - 5)) more")
  echo "$cat: ${shown[*]}"
}
rc=0; migrate_out=$(docker run --rm --network "container:$DDB" --env-file "$WORK/migrate.env" --entrypoint node "$IMAGE" "${MIGRATE[@]}" 2>&1) || rc=$?
rm -f "$WORK/migrate.env"
if [ "$rc" != 0 ]; then
  reason=$(migration_failure "$migrate_out"); unset migrate_out
  die "the image's migration runner refused the restored history (exit $rc): $reason"
fi
summary=$(grep -E '^migrations: ' <<<"$migrate_out" || true); unset migrate_out
[[ $summary =~ $MIGRATE_SUMMARY ]] || die "the image's migration runner exited 0 without its expected summary line (unsupported output contract)"
LATER=${BASH_REMATCH[1]}
ok "migration runner: ${BASH_REMATCH[2]} already applied (history restored), $LATER later migration(s) applied${BASH_REMATCH[3]:+, ${BASH_REMATCH[3]} checksum(s) recorded}"
if [ "$SERVICE" = auth-service ]; then
  printf '%s\n' 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO auth_app;' 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO auth_app;' | sql auth
fi

# The append-only and privilege controls of an audit-service drill (V2 A13): LOCAL / DISPOSABLE RESTORE MUTATION. They run only against the
# drill's own restored database (this script refuses a production host), each inside a block that is rolled back.
controls_sql() {
  cat <<'SQL'
-- nawara-drill-controls: LOCAL / DISPOSABLE RESTORE MUTATION (every block is rolled back)
CREATE FUNCTION pg_temp.refused(code text, as_role text, stmts text[], expected text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE s text;
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', as_role);
    FOREACH s IN ARRAY stmts LOOP EXECUTE s; END LOOP;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE expected THEN RAISE EXCEPTION 'nawara-control % failed (refused for another reason)', code; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'nawara-control % failed (not refused)', code;
END $f$;
DO $c$
DECLARE
  r text := (SELECT max(id)::text FROM audit_record);
  run_row text := $s$INSERT INTO audit_retention_run (category, "retainDays", cutoff, deleted) VALUES ('security', 1, now(), 1)$s$;
  stamped timestamptz;
BEGIN
  PERFORM pg_temp.refused('N1', 'audit_app', ARRAY['UPDATE audit_record SET outcome = outcome WHERE id = ' || r], 'permission denied%');
  PERFORM pg_temp.refused('N2', 'audit_migrator', ARRAY['UPDATE audit_record SET outcome = outcome WHERE id = ' || r], '%append-only%');
  PERFORM pg_temp.refused('N3', 'audit_migrator', ARRAY['DELETE FROM audit_retention_policy', 'DELETE FROM audit_record WHERE id = ' || r], '%append-only%');
  PERFORM pg_temp.refused('N4', 'audit_migrator', ARRAY['TRUNCATE audit_record'], '%append-only%');
  PERFORM pg_temp.refused('N5', 'audit_migrator', ARRAY[run_row, 'UPDATE audit_retention_run SET deleted = deleted + 1'], '%append-only%');
  PERFORM pg_temp.refused('N6', 'audit_migrator', ARRAY[run_row, 'DELETE FROM audit_retention_run'], '%append-only%');
  PERFORM pg_temp.refused('N7', 'audit_migrator', ARRAY['TRUNCATE audit_retention_run'], '%append-only%');
  PERFORM pg_temp.refused('N8', 'audit_app', ARRAY[
    $s$INSERT INTO outbox (id, name, payload) VALUES ('00000000-0000-4000-8000-0000000d4111', 'drill.control_checked', '{}')$s$,
    $s$UPDATE outbox SET name = 'drill.control_changed' WHERE id = '00000000-0000-4000-8000-0000000d4111'$s$], '%immutable%');
  PERFORM pg_temp.refused('N9a', 'audit_app', ARRAY[$s$INSERT INTO schema_migrations (name) VALUES ('9999_drill_control.sql')$s$], 'permission denied%');
  PERFORM pg_temp.refused('N9b', 'audit_app', ARRAY['UPDATE schema_migrations SET name = name'], 'permission denied%');
  PERFORM pg_temp.refused('N9c', 'audit_app', ARRAY['DELETE FROM schema_migrations'], 'permission denied%');
  PERFORM pg_temp.refused('N10', 'audit_app', ARRAY[$s$SELECT audit_grant_retention('audit_app')$s$], 'permission denied%');
  -- P1: the database clock: a supplied recordedAt is replaced by the transaction timestamp (a copy of the newest record, new eventId).
  BEGIN
    SET LOCAL ROLE audit_app;
    INSERT INTO audit_record ("eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "userKind", "organizationId",
        "resourceType", "resourceId", "subjectType", "subjectId", outcome, changes, "correlationId", "causationId", "occurredAt", "recordedAt")
      SELECT '00000000-0000-4000-8000-0000000d4112', "sourceService", action, category, "schemaVersion", "actorType", "actorId", "userKind",
        "organizationId", "resourceType", "resourceId", "subjectType", "subjectId", outcome, changes, "correlationId", "causationId", "occurredAt",
        '2000-01-01T00:00:00Z'
        FROM audit_record WHERE id = r::bigint
      RETURNING "recordedAt" INTO stamped;
    IF stamped IS DISTINCT FROM now() THEN RAISE EXCEPTION 'nawara-control P1 failed (recordedAt not stamped by the database)'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'NWRA1', MESSAGE = 'rolled back';
  EXCEPTION WHEN SQLSTATE 'NWRA1' THEN NULL;
  END;
END $c$;
SQL
}

# Every fact recorded at backup time must hold after the restore. Later migrations may only ADD tables (and change the migration
# digest); then the history must still contain the backup's migrations.
compare_facts() {
  grep -qxF -- '-- nawara-backup-facts-results' "$WORK/facts.txt" || die "the facts file carries no results section"
  sed '/^-- nawara-backup-facts-results$/,$d' "$WORK/facts.txt" >"$WORK/facts.sql"
  sed '1,/^-- nawara-backup-facts-results$/d' "$WORK/facts.txt" >"$WORK/facts.expected"
  AUTHORITY_FACT=$(grep -m1 '^authority|' "$WORK/facts.expected" || true)
  KNOWN_FACT=$(grep -m1 '^known|' "$WORK/facts.expected" || true)
  facts_now=$(docker exec -i "$DDB" psql -X -q -At -v ON_ERROR_STOP=1 -U "$BOOT_USER" -d "$DB_NAME" -f - <"$WORK/facts.sql" 2>/dev/null) || die "the restore facts could not be read"
  checked=0
  while IFS= read -r line; do
    case "$line" in
      migrations\|*)
        if [ "$LATER" = 0 ]; then grep -qxF -- "$line" <<<"$facts_now" || die "the migration history differs from the backup"
        else [ "$(q 'SELECT count(*) FROM schema_migrations')" -ge "$(cut -d'|' -f2 <<<"$line")" ] || die "the restored migration history is shorter than the backup's"; fi ;;
      structure\|*) [ "$LATER" != 0 ] || grep -qxF -- "$line" <<<"$facts_now" || die "the restored structure differs from the backup (${line%|*})" ;;
      *) grep -qxF -- "$line" <<<"$facts_now" || die "a restored fact differs from the backup ($(cut -d'|' -f1-2 <<<"$line"))" ;;
    esac
    checked=$((checked + 1))
  done <"$WORK/facts.expected"
  rm -f "$WORK/facts.txt" "$WORK/facts.expected" "$WORK/facts.sql"
  if [ "$SERVICE" = audit-service ]; then
    ok "$checked restore facts equal the backup's (row counts, structure, migration history, owners, ACLs, append-only triggers, function and default ACLs, record digest)"
  else
    ok "$checked restore facts equal the backup's (row counts, structure, migration history, owners, ACLs, authority state)"
  fi
}

if [ "$SERVICE" = audit-service ]; then
  # V2 A13: Audit's facts are compared BEFORE the narrowing below, so they prove the restore equals the backup SOURCE as it was (its
  # ACLs included). The intended secure state is then applied and asserted; a source that still let audit_app write the migration history
  # (O3-B) is reported, never silently normalized.
  compare_facts
  [[ $KNOWN_FACT =~ ^known\|([a-z][a-z0-9-]{1,62})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)$ ]] \
    || die "the backup recorded no audit record to read back (known record missing or malformed)"
  KNOWN_SOURCE=${BASH_REMATCH[1]}; KNOWN_EVENT=${BASH_REMATCH[2]}; KNOWN_AT=${BASH_REMATCH[3]}
  source_writes=$(q "SELECT concat_ws(',', CASE WHEN has_table_privilege('audit_app','public.schema_migrations','INSERT') THEN 'INSERT' END, CASE WHEN has_table_privilege('audit_app','public.schema_migrations','UPDATE') THEN 'UPDATE' END, CASE WHEN has_table_privilege('audit_app','public.schema_migrations','DELETE') THEN 'DELETE' END, CASE WHEN has_table_privilege('audit_app','public.schema_migrations','TRUNCATE') THEN 'TRUNCATE' END) /* source-history */")
  if [ -n "$source_writes" ]; then
    log "  NOTICE  backup source: audit_app could $source_writes schema_migrations (O3-B present at the source); the drill applies and asserts the intended state"
  fi
fi
printf '%s\n' "REVOKE ALL ON TABLE schema_migrations FROM $RUNTIME;" "GRANT SELECT ON TABLE schema_migrations TO $RUNTIME;" | sql "$DB_NAME"

# ---------------------------------------------------------------- 5. fail-closed verification
[ "$(q "SELECT concat_ws('|', rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls) FROM pg_roles WHERE rolname = '$RUNTIME'")" = 't|f|f|f|f|f' ] \
  || die "$RUNTIME is not LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
[ "$(q "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.schema_migrations'::regclass")" = "$OWNER" ] || die "schema_migrations is not owned by $OWNER"
[ "$(q "SELECT concat_ws('|', has_table_privilege('$RUNTIME','public.schema_migrations','SELECT'), has_table_privilege('$RUNTIME','public.schema_migrations','INSERT'), has_table_privilege('$RUNTIME','public.schema_migrations','UPDATE'), has_table_privilege('$RUNTIME','public.schema_migrations','DELETE'), has_table_privilege('$RUNTIME','public.schema_migrations','TRUNCATE'))")" = 't|f|f|f|f' ] \
  || die "$RUNTIME must hold SELECT only on schema_migrations"
ok "$RUNTIME: LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; schema_migrations owned by $OWNER, runtime SELECT only"
if [ "$SERVICE" = organization-service ]; then
  # The deploy's own fail-closed privilege assertion (provision-and-deploy.sh step 3), unchanged.
  forbidden=$(q "SELECT coalesce(string_agg(t || ':' || p, ',' ORDER BY t, p), '') FROM (VALUES
    ('ownership_state','INSERT'),('ownership_state','UPDATE'),('ownership_state','DELETE'),('ownership_state','TRUNCATE'),
    ('ownership_event','INSERT'),('ownership_event','UPDATE'),('ownership_event','DELETE'),('ownership_event','TRUNCATE'),
    ('ownership_import_run','INSERT'),('ownership_import_run','UPDATE'),('ownership_import_run','DELETE'),('ownership_import_run','TRUNCATE'),
    ('hierarchy_id_ledger','INSERT'),('hierarchy_id_ledger','UPDATE'),('hierarchy_id_ledger','DELETE'),('hierarchy_id_ledger','TRUNCATE'),
    ('company','DELETE'),('company','TRUNCATE'),('platform','DELETE'),('platform','TRUNCATE'),('organization','DELETE'),('organization','TRUNCATE'),
    ('admin_actor_event','UPDATE'),('admin_actor_event','DELETE'),('admin_actor_event','TRUNCATE'),
    ('schema_migrations','INSERT'),('schema_migrations','UPDATE'),('schema_migrations','DELETE'),('schema_migrations','TRUNCATE')
  ) AS v(t, p) WHERE has_table_privilege('organization_app', 'public.' || t, p)")
  [ -z "$forbidden" ] || die "organization_app holds forbidden privileges after the restore ($forbidden)"
  missing=$(q "SELECT coalesce(string_agg(t || ':' || p, ',' ORDER BY t, p), '') FROM (VALUES
    ('ownership_state','SELECT'),('admin_actor_event','INSERT'),('company','SELECT'),('company','INSERT'),('schema_migrations','SELECT')
  ) AS v(t, p) WHERE NOT has_table_privilege('organization_app', 'public.' || t, p)")
  [ -z "$missing" ] || die "organization_app lacks required privileges after the restore ($missing)"
  ok "the deploy's privilege assertion (forbidden none, required present)"
fi

if [ "$SERVICE" != audit-service ]; then
  compare_facts
else
  # The deploy's own fail-closed privilege assertion (apps/audit-service/deploy/provision-and-deploy.sh), unchanged.
  forbidden=$(q "SELECT coalesce(string_agg(x, ',' ORDER BY x), '') FROM (
  SELECT t || ':' || p AS x FROM (VALUES
    ('schema_migrations','INSERT'),('schema_migrations','UPDATE'),('schema_migrations','DELETE'),('schema_migrations','TRUNCATE'),
    ('audit_record','UPDATE'),('audit_record','DELETE'),('audit_record','TRUNCATE'),
    ('audit_retention_run','INSERT'),('audit_retention_run','UPDATE'),('audit_retention_run','DELETE'),('audit_retention_run','TRUNCATE'),
    ('audit_retention_policy','INSERT'),('audit_retention_policy','UPDATE'),('audit_retention_policy','DELETE'),('audit_retention_policy','TRUNCATE')
  ) AS v(t, p) WHERE has_table_privilege('audit_app', 'public.' || t, p)
  UNION ALL
  SELECT f || ':EXECUTE' FROM (VALUES ('audit_grant_retention(regrole)'),('audit_restrict_to_append_only(regclass)')) AS g(f)
   WHERE has_function_privilege('audit_app', 'public.' || f, 'EXECUTE')
) AS forbidden_privileges")
  [ -z "$forbidden" ] || die "audit_app holds forbidden privileges after the restore ($forbidden)"
  missing=$(q "SELECT coalesce(string_agg(t || ':' || p, ',' ORDER BY t, p), '') FROM (VALUES
  ('schema_migrations','SELECT'),('audit_record','SELECT'),('audit_record','INSERT')
) AS v(t, p) WHERE NOT has_table_privilege('audit_app', 'public.' || t, p)")
  [ -z "$missing" ] || die "audit_app lacks required privileges after the restore ($missing)"
  ok "the deploy's privilege assertion (forbidden none, required present)"

  # The append-only and privilege controls: LOCAL / DISPOSABLE RESTORE MUTATION, against this drill's own restored database only, every
  # statement inside a block that is rolled back. Never a production mutation: this script refuses a production host above. Each control
  # must be REFUSED for the stated reason (the error text is matched, never printed); P1 must show the database clock replacing a
  # supplied recordedAt. A control that unexpectedly succeeds stops the drill and names the control, never a value.
  enabled=$(q "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND t.tgenabled = 'O'
    AND (c.relname, t.tgname) IN (('audit_record','audit_record_stamp'),('audit_record','audit_record_no_update_delete'),('audit_record','audit_record_no_truncate'),
      ('audit_retention_run','audit_retention_run_no_update_delete'),('audit_retention_run','audit_retention_run_no_truncate'),('outbox','outbox_immutable'))")
  [ "$enabled" = 6 ] || die "the append-only and immutability triggers are not all present and enabled after the restore (P2)"
  controls_err=$(controls_sql | docker exec -i "$DDB" psql -X -q -v ON_ERROR_STOP=1 -U "$BOOT_USER" -d "$DB_NAME" -f - 2>&1 >/dev/null) \
    || die "an append-only or privilege control was not refused as expected ($(grep -m1 -oE 'nawara-control [NP][0-9]+[a-z]?' <<<"$controls_err" || echo 'unidentified control'))"
  unset controls_err
  ok "append-only and privilege controls: 12 refusals (N1-N10) and the database clock (P1), all rolled back; triggers present and enabled (P2)"
fi

# ---------------------------------------------------------------- 6. the application, in the drill namespace only
# The restored .env with every network-facing value replaced: the drill namespace has no route anyway (network none), and no
# production broker URL is ever handed to the drill (the relay would re-publish restored pending rows).
if [ "$SERVICE" = audit-service ]; then
  # O1: Audit's /ready needs a broker and its ingestion consumer, so the drill adds a DISPOSABLE broker in the drill database's own network
  # namespace (network none: loopback only, no route, no DNS). It is never a production broker: the production broker's pinned image, a
  # fresh node, a drill-only vhost user and password generated here. The CLI always runs as `rabbitmq` (a root CLI before the node has
  # written its Erlang cookie makes the node exit, infra/rabbitmq/provision.sh).
  MQ_PASS=$(secret)
  printf 'RABBITMQ_NODENAME=rabbit@localhost\nRABBITMQ_DEFAULT_USER=drill\nRABBITMQ_DEFAULT_PASS=%s\nRABBITMQ_DEFAULT_VHOST=%s\n' "$MQ_PASS" "$MQ_VHOST" >"$WORK/mq.env"
  docker run -d --name "$DMQ" --network "container:$DDB" --env-file "$WORK/mq.env" "$MQ_IMAGE" >/dev/null
  rm -f "$WORK/mq.env"
  mq_ready=""
  for _ in $(seq 1 60); do
    if docker exec -u rabbitmq "$DMQ" rabbitmq-diagnostics -q check_running >/dev/null 2>&1 \
      && docker exec -u rabbitmq "$DMQ" rabbitmq-diagnostics -q check_port_connectivity >/dev/null 2>&1; then mq_ready=1; break; fi
    [ "$(docker inspect -f '{{.State.Running}}' "$DMQ" 2>/dev/null)" = true ] || break
    sleep 2
  done
  [ -n "$mq_ready" ] || die "the disposable drill broker did not become ready"
  # Isolation, proven before the service starts: the database has no network at all, and the broker only shares its namespace.
  DDB_ID=$(docker inspect -f '{{.Id}}' "$DDB")
  [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$DDB")" = none ] || die "the drill database is not on --network none; refusing"
  case "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$DMQ")" in "container:$DDB" | "container:$DDB_ID") ;; *) die "the drill broker is not confined to the drill namespace; refusing" ;; esac
  ok "disposable drill broker ready in the drill namespace (no network; a drill-only vhost user; never a production broker)"
fi

mkdir -m 700 "$WORK/config"; tar -C "$WORK/config" -xpf "$WORK/config.tar"; rm -f "$WORK/config.tar"
DRILL_TOKEN=$(secret)
{
  if [ "$SERVICE" = audit-service ]; then
    grep -vE '^(DATABASE_URL|RABBITMQ_URL|AUTH_SERVICE_URL|SERVICE_TOKENS|AUDIT_SERVICE_POLICY|SWAGGER_PASSWORD|PORT)=' "$WORK/config/.env" || true
  else
    grep -vE '^(DATABASE_URL|RABBITMQ_URL|AUTH_SERVICE_URL|ORGANIZATION_SERVICE_URL|ORGANIZATION_SERVICE_TOKEN|PAYMENT_SERVICE_URL|SERVICE_TOKENS|SERVICE_POLICY|PORT)=' "$WORK/config/.env" || true
  fi
  printf 'DATABASE_URL=postgres://%s:%s@127.0.0.1:5432/%s\n' "$RUNTIME" "$RUNTIME_PASS" "$DB_NAME"
  if [ "$SERVICE" = audit-service ]; then
    printf 'RABBITMQ_URL=amqp://drill:%s@127.0.0.1:5672/%s\n' "$MQ_PASS" "$MQ_VHOST"   # the disposable drill broker only
  else
    printf 'RABBITMQ_URL=amqp://127.0.0.1:1/drill\n'   # unreachable (no network, port 1); carries no credential
  fi
  # Outbound service URLs keep their presence (configuration validation) but point nowhere; a real token is never reused.
  grep -q '^PAYMENT_SERVICE_URL=' "$WORK/config/.env" && printf 'PAYMENT_SERVICE_URL=http://127.0.0.1:1\n'
  grep -q '^ORGANIZATION_SERVICE_URL=' "$WORK/config/.env" && printf 'ORGANIZATION_SERVICE_URL=http://127.0.0.1:1\nORGANIZATION_SERVICE_TOKEN=%s\n' "$(secret)"
  if [ "$SERVICE" = organization-service ]; then
    printf 'AUTH_SERVICE_URL=http://127.0.0.1:1\nDRILL_READ_TOKEN=%s\n' "$DRILL_TOKEN"
    printf 'SERVICE_TOKENS=drill-reader:%s\n' "$(printf '%s' "$DRILL_TOKEN" | sha256sum | cut -d' ' -f1)"
    printf '%s\n' 'SERVICE_POLICY={"callers":{"drill-reader":{"capabilities":["hierarchy.read"],"allowedPlatforms":[]}}}'
  fi
  if [ "$SERVICE" = audit-service ]; then
    # O4: a drill-only reader that exists only in this file (production's .env is never written): its token is generated here, and its
    # policy is the existing AUDIT_SERVICE_POLICY mechanism (read_platform, every category).
    printf 'DRILL_READ_TOKEN=%s\n' "$DRILL_TOKEN"
    printf 'SERVICE_TOKENS=drill-reader:%s\n' "$(printf '%s' "$DRILL_TOKEN" | sha256sum | cut -d' ' -f1)"
    printf '%s\n' 'AUDIT_SERVICE_POLICY={"callers":{"drill-reader":{"operations":["read_platform"],"categories":["security","business","commercial","administrative"]}}}'
  fi
} >"$WORK/app.env"
rm -rf "$WORK/config"
grep -q 'nawara-core-rabbitmq' "$WORK/app.env" && die "a production broker address reached the drill environment; refusing"
if [ "$SERVICE" = audit-service ]; then
  [ "$(grep -c '^RABBITMQ_URL=' "$WORK/app.env")" = 1 ] && grep -qxF "RABBITMQ_URL=amqp://drill:$MQ_PASS@127.0.0.1:5672/$MQ_VHOST" "$WORK/app.env" \
    || die "the drill service would not be pointed at the disposable drill broker only; refusing"
fi
docker run -d --name "$DAPP" --network "container:$DDB" --env-file "$WORK/app.env" "$IMAGE" >/dev/null
if [ "$SERVICE" = audit-service ]; then
  case "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$DAPP")" in "container:$DDB" | "container:$DDB_ID") ;; *) die "the drill service is not confined to the drill namespace; refusing" ;; esac
fi
# R2 (ADR-0063 §4 item 9; the A5.4-A5 design §9): an Auth backup taken under a freeze stays a valid backup. Its restored marker is
# `frozen`, which an image with the A5.4-A5 readiness check reports as not ready (`marker_frozen`, R1). The exception below applies ONLY
# when the backup's own authority fact, already proven equal to the restored database by compare_facts, is exactly `authority|frozen`;
# it is derived here and never read from the caller's environment. Every other backup keeps the exact ready gate below.
FROZEN_BACKUP=no
if [ "$SERVICE" = auth-service ] && [ "$AUTHORITY_FACT" = 'authority|frozen' ]; then FROZEN_BACKUP=yes; fi
READY_GATE=ready
if [ "$FROZEN_BACKUP" = yes ]; then
  # D1: the image's own capability, read from its packaged build (WORKDIR /app/apps/auth-service): `absent` (an image built before
  # A5.4-A5, which answers ready while frozen), `capable` (the module exports the check's name), anything else fails the drill.
  capability=$(docker exec "$DAPP" node -e 'const f = "dist/hierarchy/authority-readiness.js"; if (!require("fs").existsSync(f)) { console.log("absent"); } else { import(require("url").pathToFileURL(require("path").resolve(f)).href).then((m) => console.log(m.HIERARCHY_AUTHORITY_CHECK === "hierarchy_authority" ? "capable" : "unknown")).catch(() => console.log("unknown")); }' 2>/dev/null || true)
  case "$capability" in
    absent) READY_GATE=ready ;;
    capable) READY_GATE=frozen ;;
    *) die "the image's hierarchy authority readiness capability could not be determined; refusing" ;;
  esac
fi
if [ "$READY_GATE" = frozen ]; then
  # The expected answer, and nothing else: 503 naming ONLY hierarchy_authority, AND the service's own diagnostics naming marker_frozen
  # (its reason line and the registry's line, matched as JSON `msg` values; never printed). The marker itself is confirmed again below
  # through the service's CLI. A check-capable image answering ready while frozen is a broken check: the drill fails.
  frozen_ok=""
  for _ in $(seq 1 60); do
    probe=$(docker exec "$DAPP" node -e 'fetch("http://127.0.0.1:3000/ready").then(async (r) => console.log(r.status + " " + (await r.text()))).catch(() => console.log("unreachable"))' 2>/dev/null || true)
    [ "$probe" = '200 {"status":"ready"}' ] && die "GET /ready answered ready for a frozen backup although the image has the hierarchy authority readiness check; refusing"
    if [ "$probe" = '503 {"status":"unavailable","failed":["hierarchy_authority"]}' ]; then
      logs=$(docker logs "$DAPP" 2>&1 || true)
      reason=$(grep -oE '(^|[{,])"msg":"hierarchy_authority_not_ready reason=[a-z_]+ source=(local|organization-service) marker=[a-z_]+"' <<<"$logs" | tail -n 1 || true)
      registry=$(grep -oE '(^|[{,])"msg":"readiness_check_failed check=hierarchy_authority error=[A-Za-z]+ code=[a-z_]+ ' <<<"$logs" | tail -n 1 || true)
      unset logs
      if [[ $reason =~ \"msg\":\"hierarchy_authority_not_ready\ reason=marker_frozen\ source=(local|organization-service)\ marker=frozen\"$ ]] \
        && [[ $registry =~ \"msg\":\"readiness_check_failed\ check=hierarchy_authority\ error=HierarchyAuthorityNotReady\ code=marker_frozen\ $ ]]; then
        frozen_ok=yes; break
      fi
    fi
    sleep 1
  done
  [ -n "$frozen_ok" ] || die "GET /ready did not give the expected answer for a frozen backup (only hierarchy_authority failing, reason marker_frozen)"
  ok "GET /ready -> 503, only hierarchy_authority failing, reason marker_frozen: the expected answer for a backup taken under a freeze (R2)"
else
ready=""
for _ in $(seq 1 60); do
  ready=$(docker exec "$DAPP" wget -qO- http://127.0.0.1:3000/ready 2>/dev/null || true)
  [ "$ready" = '{"status":"ready"}' ] && break
  sleep 1
done
[ "$ready" = '{"status":"ready"}' ] || { docker logs --tail 20 "$DAPP" 2>&1 | grep -oE '"msg":"[a-z_]+' | sort | uniq -c >&2 || true; die "GET /ready did not answer ready against the restored database"; }
[ "$FROZEN_BACKUP" = no ] || log "  NOTE  the image predates the hierarchy authority readiness check (A5.4-A5): a frozen backup answers ready (D1)"
fi
if [ "$READY_GATE" = frozen ]; then
  :
elif [ "$SERVICE" = audit-service ]; then
  ok "GET /ready -> {\"status\":\"ready\"} (the real contract: the restored database, its migrations, the drill broker and the ingestion consumer)"
  # The consumer Audit attached is on the DISPOSABLE broker: the only broker its namespace can reach.
  consumers=$(docker exec -u rabbitmq "$DMQ" rabbitmqctl -q list_consumers -p "$MQ_VHOST" queue_name --no-table-headers 2>/dev/null || true)
  grep -qx 'audit-service.audit' <<<"$consumers" || die "the ingestion consumer is not attached to the disposable drill broker"
  ok "the ingestion consumer is attached to the disposable drill broker (audit-service.audit)"
else
  ok "GET /ready -> {\"status\":\"ready\"} (the service against the restored database, no broker)"
fi

if [ "$SERVICE" = organization-service ]; then
  expected=$(q "$KNOWN_SQL'$KNOWN_ID'")
  [ -n "$expected" ] || die "KNOWN_ID is not in the restored database"
  got=$(docker exec "$DAPP" node -e 'fetch("http://127.0.0.1:3000/organization/companies/" + process.argv[1], { headers: { authorization: "Bearer " + process.env.DRILL_READ_TOKEN } }).then(async (r) => { if (r.status !== 200) { console.log("status=" + r.status); return; } console.log((await r.json()).name); }).catch(() => console.log("unreachable"))' "$KNOWN_ID")
  [ "$got" = "$expected" ] || die "the known-id read through the API does not match the restored row ($(grep -oE '^status=[0-9]+' <<<"$got" || echo mismatch))"
  ok "application read: GET /organization/companies/<KNOWN_ID> returns the restored row (value not printed)"
elif [ "$SERVICE" = audit-service ]; then
  # O4: the newest record recorded at the backup SOURCE, read back through the service's own platform read with the drill-only reader:
  # the window is that record's millisecond, and the record must be returned with its eventId and sourceService. Nothing is printed.
  got=$(docker exec "$DAPP" node -e 'const [, at, src, ev] = process.argv; const to = new Date(Date.parse(at) + 1).toISOString();
fetch("http://127.0.0.1:3000/audit/platform/records?limit=100&from=" + encodeURIComponent(at) + "&to=" + encodeURIComponent(to), { headers: { authorization: "Bearer " + process.env.DRILL_READ_TOKEN } })
  .then(async (r) => { if (r.status !== 200) { console.log("status=" + r.status); return; } const b = await r.json();
    console.log((b.items || []).some((i) => i.eventId === ev && i.sourceService === src && new Date(i.occurredAt).toISOString() === at) ? "match" : "mismatch"); })
  .catch(() => console.log("unreachable"))' "$KNOWN_AT" "$KNOWN_SOURCE" "$KNOWN_EVENT")
  [ "$got" = match ] || die "the known record read through the API does not match the record recorded at backup time ($(grep -oE '^status=[0-9]+' <<<"$got" || echo mismatch))"
  ok "application read: GET /audit/platform/records returns the newest record recorded at backup time (drill-only reader; values not printed)"
else
  # The service's own CLI (its configuration, its runtime identity, no broker) reads the marker; only `mode` is extracted, the rest of
  # its output (actor names, evidence) is never printed. It must equal the value recorded at the backup SOURCE.
  [[ $AUTHORITY_FACT =~ ^authority\|(local|frozen|org_authoritative)$ ]] || die "the backup recorded no hierarchy authority state"
  want=${BASH_REMATCH[1]}
  status_out=$(docker exec "$DAPP" node dist/cli/main.js hierarchy-status 2>/dev/null) || die "the service could not read its hierarchy authority state"
  mode=$(grep -m1 -oE '"mode": "[a-z_]+"' <<<"$status_out" | cut -d'"' -f4 || true); unset status_out
  [ "$mode" = "$want" ] || die "the hierarchy authority state the service reads differs from the backup source"
  ok "application read: the service reads its hierarchy authority marker ($mode), equal to the backup source"
fi

KEPT="$DDB $DAPP"; [ "$SERVICE" != audit-service ] || KEPT="$DDB $DMQ $DAPP"
log "OK  drill of $SERVICE $STAMP passed: $PASS checks; $([ "${KEEP_DRILL:-}" = yes ] && echo "containers kept WITH restored data: $KEPT" || echo 'drill containers and their volumes removed'); plaintext removed"
# A secret-free summary for the evidence record (and a later status signal): the measured drill duration is the local RTO evidence.
log "DRILL_RESULT service=$SERVICE stamp=$STAMP checks=$PASS duration_s=$((SECONDS - STARTED))"
