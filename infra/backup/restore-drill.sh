#!/usr/bin/env bash
# Isolated restore drill for a backup made by infra/backup/backup.sh (Stage 21.x G5; production-readiness.md §3 success criteria).
# Runs in the RECOVERY ENVIRONMENT, the only place the private key may be (D2), never against a production database:
#
#   SERVICE=auth-service STAMP=latest PRIVATE_KEY_FILE=… IMAGE=ghcr.io/…/nawara-core-auth-service@sha256:… KNOWN_ID=<uuid> \
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
#   namespace (never with a production broker URL) -> GET /ready -> the known-id read -> remove the drill; remove all plaintext.
# Prints states, counts of checks and PASS/FAIL only: never a secret, a row count or a restored value.
set -euo pipefail
umask 077

: "${SERVICE:?SERVICE is required (organization-service | auth-service)}"
: "${STAMP:?STAMP is required (the backup timestamp, e.g. 20260929T021700Z, or latest)}"
: "${PRIVATE_KEY_FILE:?PRIVATE_KEY_FILE is required (the recovery private key, kept off the production host)}"
: "${IMAGE:?IMAGE is required (the service image to verify with: the release that made the backup, or a later one)}"
: "${KNOWN_ID:?KNOWN_ID is required (the id of a row written before the backup: a Company for organization-service, a user for auth-service)}"

log() { printf '[restore-drill] %s\n' "$*"; }
die() { printf '[restore-drill] ERROR: %s\n' "$*" >&2; exit 1; }
PASS=0
ok() { PASS=$((PASS + 1)); log "  PASS  $*"; }

case "$SERVICE" in
  organization-service)
    DB_NAME=organization; BOOT_USER=organization_admin; BOOT_DB=postgres; OWNER=organization_migrator; RUNTIME=organization_app
    MIGRATE=(../../libs/service-kit/dist/cli/migrate.js --dir db/migrations); KNOWN_SQL='SELECT name FROM company WHERE id = '
    CONFIG_ALLOWED='^(db\.env|roles\.env|\.env|callers/?|callers/[a-z-]+\.token)$' ;;
  auth-service)
    DB_NAME=auth; BOOT_USER=auth; BOOT_DB=auth; OWNER=auth; RUNTIME=auth_app
    MIGRATE=(dist/cli/migrate.js); KNOWN_SQL='SELECT id::text FROM "user" WHERE id = '
    CONFIG_ALLOWED='^(db\.env|\.env)$' ;;
  *) die "unknown SERVICE '$SERVICE' (known: organization-service auth-service)" ;;
esac
[[ $STAMP =~ ^([0-9]{8}T[0-9]{6}Z|latest)$ ]] || die "STAMP must be YYYYmmddTHHMMSSZ or latest"
[[ $KNOWN_ID =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "KNOWN_ID must be a lowercase UUID"
for c in docker openssl sha256sum tar; do command -v "$c" >/dev/null || die "$c is required"; done
[ -f "$PRIVATE_KEY_FILE" ] || die "PRIVATE_KEY_FILE does not exist"
[ "$(stat -c %a "$PRIVATE_KEY_FILE")" = 600 ] || [ "$(stat -c %a "$PRIVATE_KEY_FILE")" = 400 ] || die "PRIVATE_KEY_FILE must be mode 0600 or 0400"
if [ -n "${SOURCE_DIR:-}" ]; then [ -d "$SOURCE_DIR" ] || die "SOURCE_DIR does not exist"
else
  : "${BACKUP_DIR:?BACKUP_DIR (with destination.env and s3-credentials.env) or SOURCE_DIR is required}"
  for f in destination.env s3-credentials.env; do [ -f "$BACKUP_DIR/$f" ] || die "$BACKUP_DIR/$f is missing"; done
fi

# ---------------------------------------------------------------- the target: never production, never ambiguous
for prod in nawara-core-organization-db nawara-core-auth-db; do
  if docker inspect "$prod" >/dev/null 2>&1 && [ "${RESTORE_ON_PRODUCTION_HOST:-}" != yes ]; then
    die "this Docker host runs $prod: a drill belongs in the recovery environment (the private key stays off the production host); set RESTORE_ON_PRODUCTION_HOST=yes only for an approved on-host drill"
  fi
done
DRILL_ID="${DRILL_ID:-$(date -u +%Y%m%d%H%M%S)}"
[[ $DRILL_ID =~ ^[a-z0-9-]{1,32}$ ]] || die "DRILL_ID must be [a-z0-9-]{1,32}"
DDB="nawara-drill-$SERVICE-$DRILL_ID-db"; DAPP="nawara-drill-$SERVICE-$DRILL_ID-app"
for n in "$DDB" "$DAPP"; do
  case "$n" in nawara-core-*) die "refusing a production container name ($n)" ;; esac
  ! docker inspect "$n" >/dev/null 2>&1 || die "$n already exists: a drill always starts from nothing (choose another DRILL_ID)"
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/nawara-restore-drill.XXXXXX")
cleanup() {
  if [ "${KEEP_DRILL:-}" != yes ]; then docker rm -f "$DAPP" "$DDB" >/dev/null 2>&1 || true; fi
  rm -rf -- "$WORK"
}
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
for _ in $(seq 1 60); do docker exec "$DDB" pg_isready -U "$BOOT_USER" -d "$BOOT_DB" -q >/dev/null 2>&1 && break; sleep 1; done
docker exec "$DDB" pg_isready -U "$BOOT_USER" -d "$BOOT_DB" -q >/dev/null 2>&1 || die "the drill database did not start"
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
migrated=$(docker run --rm --network "container:$DDB" --env-file "$WORK/migrate.env" --entrypoint node "$IMAGE" "${MIGRATE[@]}" 2>&1 | grep -E '^migrations: ' || true)
[[ $migrated =~ ^migrations:\ ([0-9]+)\ applied,\ ([0-9]+)\ already\ applied ]] || die "the image's migration runner refused the restored history"
LATER=${BASH_REMATCH[1]}
ok "migration runner: ${BASH_REMATCH[2]} already applied (history restored), $LATER later migration(s) applied"
if [ "$SERVICE" = auth-service ]; then
  printf '%s\n' 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO auth_app;' 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO auth_app;' | sql auth
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

# Every fact recorded at backup time must hold after the restore. Later migrations may only ADD tables (and change the migration
# digest); then the history must still contain the backup's migrations.
grep -qxF -- '-- nawara-backup-facts-results' "$WORK/facts.txt" || die "the facts file carries no results section"
sed '/^-- nawara-backup-facts-results$/,$d' "$WORK/facts.txt" >"$WORK/facts.sql"
sed '1,/^-- nawara-backup-facts-results$/d' "$WORK/facts.txt" >"$WORK/facts.expected"
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
ok "$checked restore facts equal the backup's (row counts, structure, migration history, owners, ACLs, authority state)"

# ---------------------------------------------------------------- 6. the application, in the drill namespace only
# The restored .env with every network-facing value replaced: the drill namespace has no route anyway (network none), and no
# production broker URL is ever handed to the drill (the relay would re-publish restored pending rows).
mkdir -m 700 "$WORK/config"; tar -C "$WORK/config" -xpf "$WORK/config.tar"; rm -f "$WORK/config.tar"
DRILL_TOKEN=$(secret)
{
  grep -vE '^(DATABASE_URL|RABBITMQ_URL|AUTH_SERVICE_URL|ORGANIZATION_SERVICE_URL|ORGANIZATION_SERVICE_TOKEN|PAYMENT_SERVICE_URL|SERVICE_TOKENS|SERVICE_POLICY|PORT)=' "$WORK/config/.env" || true
  printf 'DATABASE_URL=postgres://%s:%s@127.0.0.1:5432/%s\n' "$RUNTIME" "$RUNTIME_PASS" "$DB_NAME"
  printf 'RABBITMQ_URL=amqp://127.0.0.1:1/drill\n'   # unreachable (no network, port 1); carries no credential
  # Outbound service URLs keep their presence (configuration validation) but point nowhere; a real token is never reused.
  grep -q '^PAYMENT_SERVICE_URL=' "$WORK/config/.env" && printf 'PAYMENT_SERVICE_URL=http://127.0.0.1:1\n'
  grep -q '^ORGANIZATION_SERVICE_URL=' "$WORK/config/.env" && printf 'ORGANIZATION_SERVICE_URL=http://127.0.0.1:1\nORGANIZATION_SERVICE_TOKEN=%s\n' "$(secret)"
  if [ "$SERVICE" = organization-service ]; then
    printf 'AUTH_SERVICE_URL=http://127.0.0.1:1\nDRILL_READ_TOKEN=%s\n' "$DRILL_TOKEN"
    printf 'SERVICE_TOKENS=drill-reader:%s\n' "$(printf '%s' "$DRILL_TOKEN" | sha256sum | cut -d' ' -f1)"
    printf '%s\n' 'SERVICE_POLICY={"callers":{"drill-reader":{"capabilities":["hierarchy.read"],"allowedPlatforms":[]}}}'
  fi
} >"$WORK/app.env"
rm -rf "$WORK/config"
grep -q 'nawara-core-rabbitmq' "$WORK/app.env" && die "a production broker address reached the drill environment; refusing"
docker run -d --name "$DAPP" --network "container:$DDB" --env-file "$WORK/app.env" "$IMAGE" >/dev/null
ready=""
for _ in $(seq 1 60); do
  ready=$(docker exec "$DAPP" wget -qO- http://127.0.0.1:3000/ready 2>/dev/null || true)
  [ "$ready" = '{"status":"ready"}' ] && break
  sleep 1
done
[ "$ready" = '{"status":"ready"}' ] || { docker logs --tail 20 "$DAPP" 2>&1 | grep -oE '"msg":"[a-z_]+' | sort | uniq -c >&2 || true; die "GET /ready did not answer ready against the restored database"; }
ok "GET /ready -> {\"status\":\"ready\"} (the service against the restored database, no broker)"

expected=$(q "$KNOWN_SQL'$KNOWN_ID'")
[ -n "$expected" ] || die "KNOWN_ID is not in the restored database"
if [ "$SERVICE" = organization-service ]; then
  got=$(docker exec "$DAPP" node -e 'fetch("http://127.0.0.1:3000/organization/companies/" + process.argv[1], { headers: { authorization: "Bearer " + process.env.DRILL_READ_TOKEN } }).then(async (r) => { if (r.status !== 200) { console.log("status=" + r.status); return; } console.log((await r.json()).name); }).catch(() => console.log("unreachable"))' "$KNOWN_ID")
  [ "$got" = "$expected" ] || die "the known-id read through the API does not match the restored row ($(grep -oE '^status=[0-9]+' <<<"$got" || echo mismatch))"
  ok "known-id read: GET /organization/companies/<KNOWN_ID> returns the restored row (value not printed)"
else
  got=$(docker exec "$DDB" psql -X -q -At -U "$RUNTIME" -d "$DB_NAME" -c "$KNOWN_SQL'$KNOWN_ID'")
  [ "$got" = "$expected" ] || die "the known-id read as $RUNTIME does not match"
  ok "known-id read as $RUNTIME (the runtime identity) returns the restored row (value not printed)"
fi

log "OK  drill of $SERVICE $STAMP passed: $PASS checks; $([ "${KEEP_DRILL:-}" = yes ] && echo "containers kept: $DDB $DAPP" || echo 'drill containers removed'); plaintext removed"
