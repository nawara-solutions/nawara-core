#!/usr/bin/env bash
# Encrypted off-host database backups for the Core V1 authority cutover (Stage 21.x G5; ADR-0040 G5, production-readiness.md §3).
# Runs ON THE SERVER, streamed from the checkout by .github/workflows/core-backup.yml (base64 through the SSH environment):
#
#   printf '%s' "$BACKUP_B64" | base64 -d | BACKUP_SERVICES="auth-service" bash -s
#
# Scope (G5 decision D4, extended by V2 A13): the two databases of the cutover, organization-service and auth-service, and the evidence
# store, audit-service. Per service and run:
#   1. pg_dump -Fc INSIDE the database container (its own PostgreSQL major), over the local socket, as the least-privileged existing
#      identity that reads everything: organization_migrator and audit_migrator (the non-superuser owners) / auth_app (read-only use; no
#      privilege change);
#   2. the archive must be a custom-format dump that pg_restore --list can read and that holds the data of the cutover-critical tables;
#   3. the service's secret files (db.env, roles.env, .env, callers/) as a separate tar (modes kept), and restore facts (row counts,
#      structure, migration digest, owners, ACLs, authority state) as a third file: both business-sensitive, so both encrypted;
#   4. each file encrypted with `openssl cms` to the PUBLIC recipient certificate (D2): this host never holds the private key;
#   5. upload to private S3-compatible storage (D1; any provider, configured below), then a HEAD check of every object's size;
#      the plaintext manifest (sizes, sha256, no secret, no row count) is uploaded LAST, so its presence marks a complete set;
#   6. retention (D3): the newest 30 backup days per service are kept; only this service's own artifact names under the configured
#      prefix can ever be deleted, and only after the new backup succeeded.
# Plaintext exists only in a 0700 work directory under this script's state directory and is removed on every exit path. Nothing is
# uploaded unless it is encrypted. Never prints a secret, a credential, a row count or a file's contents.
#
# Server state (0700 dir; the operator creates the configuration, docs/runbooks/core-backup-restore.md §2):
#   $HOME/nawara-core/backup/destination.env      BACKUP_S3_ENDPOINT (https://…), BACKUP_S3_BUCKET, BACKUP_S3_REGION, BACKUP_S3_PREFIX,
#                                                 optional BACKUP_S3_DOCKER_NETWORK            (0600)
#   $HOME/nawara-core/backup/s3-credentials.env   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (read only as an env-file) (0600)
#   $HOME/nawara-core/backup/recipient.pem        the recipient X.509 CERTIFICATE (public); a private key here is refused
#   $HOME/nawara-core/backup/status/<service>.*   last attempt / last success (secret-safe; the G4-style staleness signal)
# Exit: 0 all backed up; 1 a backup failed or was refused (other services are still attempted); 3 backups succeeded, retention failed.
set -euo pipefail
umask 077

DIR="${BACKUP_DIR:-$HOME/nawara-core/backup}"
STATE_ROOT="${NAWARA_STATE_ROOT:-$HOME/nawara-core}"
DEST_ENV="$DIR/destination.env"
CRED_ENV="$DIR/s3-credentials.env"
RECIPIENT="$DIR/recipient.pem"
STATUS="$DIR/status"
# The S3 client: the official AWS CLI with an explicit endpoint (provider-neutral), pinned by digest like the broker image.
AWS_IMAGE='amazon/aws-cli:2.27.49@sha256:1b7003e3ecb737b7533d8e16a547b4bc36e912508c3532ae51003aad8d0cd41d'
RETAIN_DAYS=30

log() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] ERROR: %s\n' "$*" >&2; exit 1; }
conf() { sed -n "s/^$1=//p" "$DEST_ENV" | tail -n 1; }

# Audit's integrity facts (V2 A13), in place of an authority marker: the append-only triggers and their state, the owner and ACL of the
# privilege helpers and trigger functions, the default privileges, the schema ACL, a digest of every record's identity and clocks (so a
# restore that re-stamped `recordedAt` or lost a row cannot pass), and the newest record as the known record a drill reads back through
# the API (its instant truncated to the millisecond the API's from/to accept). Identifiers only (service names, UUIDs, instants); this file
# is encrypted like every facts file.
audit_facts_sql() {
  cat <<'SQL'
SELECT 'trigger|' || c.relname || '|' || t.tgname || '|' || t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal ORDER BY 1;
SELECT 'funcacl|' || p.proname || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(array_to_string(p.proacl, ' '), '') FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('audit_grant_retention', 'audit_restrict_to_append_only', 'audit_record_stamp',
    'audit_record_append_only', 'audit_retention_run_append_only', 'outbox_immutable') ORDER BY 1;
SELECT 'defacl|' || pg_get_userbyid(defaclrole) || '|' || defaclobjtype::text || '|' || array_to_string(defaclacl, ' ') FROM pg_default_acl
  WHERE defaclnamespace = 'public'::regnamespace ORDER BY 1;
SELECT 'nspacl|public|' || pg_get_userbyid(nspowner) || '|' || coalesce(array_to_string(nspacl, ' '), '') FROM pg_namespace WHERE nspname = 'public';
SELECT 'audit_digest|' || count(*) || '|' || coalesce(md5(string_agg(id::text || '|' || "sourceService" || '|' || "eventId"::text || '|'
  || extract(epoch FROM "occurredAt")::text || '|' || extract(epoch FROM "recordedAt")::text, ',' ORDER BY id)), '') FROM audit_record;
SELECT 'known|' || coalesce((SELECT "sourceService" || '|' || "eventId"::text || '|'
  || to_char(date_trunc('milliseconds', "occurredAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM audit_record ORDER BY id DESC LIMIT 1), 'none');
SQL
}

# The only services, and exactly what each backup contains. Nothing else is ever dumped, archived or deleted.
target_for() {
  case "$1" in
    organization-service)
      DB=nawara-core-organization-db; DB_NAME=organization; DB_USER=organization_migrator; REQUIRED_MIGRATION=
      STATE="$STATE_ROOT/organization-service"; CONFIG_FILES="db.env roles.env .env callers"; REQUIRED_CONFIG="db.env roles.env .env"
      REQUIRED_DATA="schema_migrations ownership_state ownership_event hierarchy_id_ledger company platform organization outbox"
      AUTHORITY_SQL="SELECT 'authority|' || phase || '|' || coalesce(environment_class, '') || '|' || authoritative FROM ownership_state;" ;;
    auth-service)
      DB=nawara-core-auth-db; DB_NAME=auth; DB_USER=auth_app; REQUIRED_MIGRATION=
      STATE="$STATE_ROOT/auth-service"; CONFIG_FILES="db.env .env"; REQUIRED_CONFIG="db.env .env"
      REQUIRED_DATA="schema_migrations hierarchy_authority company platform organization outbox"
      AUTHORITY_SQL="SELECT 'authority|' || mode FROM hierarchy_authority;" ;;
    audit-service)
      # V2 A13: the append-only evidence store. Dumped as its owner (audit_app cannot read the retention tables). Every table below has a
      # data section in the archive even when empty; kit_rate_limit (ephemeral counters) is covered by the row counts only.
      DB=nawara-core-audit-db; DB_NAME=audit; DB_USER=audit_migrator
      # V2 A13.4a: before 0004 an audit database cannot be restored with pg_restore (A13.3), so a backup of it is refused outright.
      REQUIRED_MIGRATION=0004_changes_validation_search_path.sql
      STATE="$STATE_ROOT/audit-service"; CONFIG_FILES="db.env roles.env .env"; REQUIRED_CONFIG="db.env roles.env .env"
      REQUIRED_DATA="schema_migrations audit_record audit_retention_policy audit_retention_run outbox inbox"
      AUTHORITY_SQL=$(audit_facts_sql) ;;
    *) return 1 ;;
  esac
}

# Restore facts, compared by restore-drill.sh after a restore. Counts and ACLs are business-sensitive: this file is encrypted.
facts_sql() {
  cat <<'SQL'
-- nawara-backup-facts
SELECT 'table|' || c.relname || '|' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY 1;
SELECT 'structure|constraints|' || count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace;
SELECT 'structure|triggers|' || count(*) FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid WHERE r.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal;
SELECT 'structure|indexes|' || count(*) FROM pg_indexes WHERE schemaname = 'public';
SELECT 'structure|sequences|' || count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'S';
SELECT 'migrations|' || count(*) || '|' || md5(string_agg(name || ':' || coalesce(checksum, ''), ',' ORDER BY name)) FROM schema_migrations;
SELECT 'outbox|' || count(*) || '|' || count(*) FILTER (WHERE "publishedAt" IS NULL) || '|' || coalesce(max(attempts), 0) FROM outbox;
SELECT 'owner|' || c.relname || '|' || pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'S') ORDER BY 1;
-- the ACL in canonical form (V2 A13.3b): a NULL ACL is the type's default, so it is written out with acldefault(); pg_dump does not
-- serialize an explicit ACL equal to the default, so a restore has NULL where the source had it explicit: same privileges, same fact.
SELECT 'acl|' || c.relname || '|' || array_to_string(coalesce(c.relacl, acldefault(CASE c.relkind WHEN 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner)), ' ')
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'S') ORDER BY 1;
SQL
  printf '%s\n' "$AUTHORITY_SQL"
}

# ---------------------------------------------------------------- preflight (nothing is dumped or uploaded before this passes)
: "${BACKUP_SERVICES:?BACKUP_SERVICES is required (space-separated: organization-service auth-service audit-service)}"
for s in $BACKUP_SERVICES; do target_for "$s" || die "unknown service '$s' (known: organization-service auth-service audit-service); nothing was backed up"; done
for c in docker openssl sha256sum tar; do command -v "$c" >/dev/null || die "$c is required on the server; nothing was backed up"; done
[ -d "$DIR" ] || die "$DIR is missing: configure the backup destination first (docs/runbooks/core-backup-restore.md §2); nothing was backed up"
for f in "$DEST_ENV" "$CRED_ENV"; do
  [ -f "$f" ] || die "$f is missing; nothing was backed up"
  [ "$(stat -c %a "$f")" = 600 ] || die "$f must be mode 0600; nothing was backed up"
done
[ -f "$RECIPIENT" ] || die "$RECIPIENT (the recipient certificate) is missing; nothing was backed up"
# D2: the backup host holds the PUBLIC half only. A private key anywhere in the backup state is refused outright.
if grep -rlsq -- 'PRIVATE KEY' "$DIR" --exclude-dir=work; then die "a private key is present under $DIR: the backup host must hold the public certificate only; remove it; nothing was backed up"; fi
openssl x509 -in "$RECIPIENT" -noout 2>/dev/null || die "$RECIPIENT is not an X.509 certificate; nothing was backed up"
RECIPIENT_SHA=$(openssl x509 -in "$RECIPIENT" -noout -fingerprint -sha256 | sed 's/^.*=//; s/://g' | tr 'A-F' 'a-f')

ENDPOINT=$(conf BACKUP_S3_ENDPOINT); BUCKET=$(conf BACKUP_S3_BUCKET); REGION=$(conf BACKUP_S3_REGION); PREFIX=$(conf BACKUP_S3_PREFIX)
S3_NET=$(conf BACKUP_S3_DOCKER_NETWORK)
if [[ ! $ENDPOINT =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]]; then
  # Plain HTTP only for a disposable local test double; never in production (credentials and ciphertext would travel unencrypted).
  [[ $ENDPOINT =~ ^http://[A-Za-z0-9.-]+(:[0-9]+)?/?$ && "${BACKUP_S3_ALLOW_INSECURE_HTTP:-}" = local-test ]] \
    || die "BACKUP_S3_ENDPOINT must be an https:// endpoint; nothing was backed up"
fi
[[ $BUCKET =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "BACKUP_S3_BUCKET is not a valid bucket name; nothing was backed up"
[[ $REGION =~ ^[a-z0-9-]+$ ]] || die "BACKUP_S3_REGION is required (the provider's region name, e.g. its documented default); nothing was backed up"
[[ $PREFIX =~ ^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$ && $PREFIX != *..* ]] \
  || die "BACKUP_S3_PREFIX must be a non-empty relative path of [a-z0-9._-] segments (no leading or trailing slash, no ..); nothing was backed up"
[ -z "$S3_NET" ] || [[ $S3_NET =~ ^[A-Za-z0-9_.-]+$ ]] || die "BACKUP_S3_DOCKER_NETWORK is not a valid network name; nothing was backed up"
grep -q '^AWS_ACCESS_KEY_ID=.' "$CRED_ENV" && grep -q '^AWS_SECRET_ACCESS_KEY=.' "$CRED_ENV" \
  || die "$CRED_ENV must define AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY; nothing was backed up"
PREFIX_RE=${PREFIX//./\\.}

mkdir -p "$DIR/work" "$STATUS"; chmod 700 "$DIR" "$DIR/work" "$STATUS"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

WORK=""
cleanup() { [ -z "$WORK" ] || rm -rf -- "$WORK"; WORK=""; }
trap cleanup EXIT

# The S3 client: credentials only through the env-file (never argv), no pager, checksum headers only where required (some
# S3-compatible providers reject the newer default ones), the host user's uid so every file it writes stays removable.
s3() {
  local net=(); [ -z "$S3_NET" ] || net=(--network "$S3_NET")
  docker run --rm "${net[@]}" --user "$(id -u):$(id -g)" --env-file "$CRED_ENV" -e HOME=/tmp -e AWS_DEFAULT_REGION="$REGION" -e AWS_PAGER= \
    -e AWS_REQUEST_CHECKSUM_CALCULATION=when_required -e AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    -v "$WORK:/work:ro" "$AWS_IMAGE" --endpoint-url "$ENDPOINT" "$@"
}

status() { # status <service> <file> <key=value lines...>
  local f="$STATUS/$1.$2"; shift 2
  printf '%s\n' "$@" >"$f.tmp"; chmod 600 "$f.tmp"; mv -f "$f.tmp" "$f"
}

upload() { # upload <key> <file in WORK>: PUT, then HEAD must report exactly the local size
  local size remote
  size=$(stat -c %s "$WORK/$2")
  s3 s3api put-object --bucket "$BUCKET" --key "$1" --body "/work/$2" >/dev/null 2>&1 || return 1
  remote=$(s3 s3api head-object --bucket "$BUCKET" --key "$1" --query ContentLength --output text 2>/dev/null) || return 2
  [ "$remote" = "$size" ] || return 2
}

retention() { # retention <service>: keep the newest $RETAIN_DAYS backup days; delete only this service's own artifact names
  local svc=$1 listing key day cutoff n=0 deleted=0
  local re="^${PREFIX_RE}/${svc}/${svc}-([0-9]{8})T[0-9]{6}Z\.(db\.dump\.cms|config\.tar\.cms|facts\.cms|manifest)$"
  listing=$(s3 s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/$svc/" --query 'Contents[].[Key]' --output text 2>/dev/null) || return 1
  [ "$listing" != None ] || listing=""
  local days
  days=$(grep -E "^${PREFIX_RE}/${svc}/${svc}-[0-9]{8}T[0-9]{6}Z\.manifest$" <<<"$listing" | sed -E 's/.*-([0-9]{8})T[0-9]{6}Z\.manifest$/\1/' | sort -ru || true)
  n=$(grep -c . <<<"$days" || true)
  if [ "$n" -le "$RETAIN_DAYS" ]; then log "  = retention: $n backup day(s) held, nothing to delete (keeps $RETAIN_DAYS)"; return 0; fi
  cutoff=$(sed -n "${RETAIN_DAYS}p" <<<"$days")
  while IFS= read -r key; do
    [[ $key =~ $re ]] || continue           # never anything but this service's own artifact names under the prefix
    day=${BASH_REMATCH[1]}
    [[ $day < $cutoff ]] || continue
    s3 s3api delete-object --bucket "$BUCKET" --key "$key" >/dev/null 2>&1 || return 1
    deleted=$((deleted + 1))
  done <<<"$listing"
  log "  = retention: $n backup days held; kept the newest $RETAIN_DAYS (from $cutoff); deleted $deleted older object(s)"
}

backup_one() {
  local svc=$1 base dump_sha toc pgv f
  target_for "$svc"
  status "$svc" last-attempt "stamp=$STAMP" "result=started"
  fail() { status "$svc" last-attempt "stamp=$STAMP" "result=failed" "stage=$1"; printf '[backup] ERROR: %s: %s\n' "$svc" "$2" >&2; cleanup; return 1; }

  docker inspect "$DB" >/dev/null 2>&1 || { fail preflight "database container $DB not found; nothing was backed up"; return 1; }
  [ -d "$STATE" ] || { fail preflight "$STATE is missing; nothing was backed up"; return 1; }
  for f in $REQUIRED_CONFIG; do [ -f "$STATE/$f" ] || { fail preflight "$STATE/$f is missing; nothing was backed up"; return 1; }; done
  # A migration the backup must find applied (the target table's constant, never an input), read as the dump identity before anything
  # is dumped: without it the backup could not be restored, so nothing is made that would look like coverage.
  if [ -n "$REQUIRED_MIGRATION" ]; then
    local applied
    applied=$(docker exec "$DB" psql -X -q -At -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
      -c "SELECT count(*) FROM schema_migrations WHERE name = '$REQUIRED_MIGRATION'" 2>/dev/null) \
      || { fail preflight "the migration history of $DB_NAME could not be read; nothing was backed up"; return 1; }
    [ "$applied" = 1 ] || { fail preflight "required migration $REQUIRED_MIGRATION is not applied in $DB_NAME (deploy it first); nothing was backed up"; return 1; }
  fi
  # Runs inside `if backup_one`, where `set -e` does not apply: every step that matters is checked explicitly.
  WORK=$(mktemp -d "$DIR/work/$svc.XXXXXX") || { fail preflight "no work directory under $DIR/work; nothing was backed up"; return 1; }
  base="$PREFIX/$svc/$svc-$STAMP"
  log "$svc: dumping $DB_NAME as $DB_USER inside $DB (custom format, the container's own pg_dump)"

  docker exec "$DB" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc >"$WORK/db.dump" 2>/dev/null || { fail dump "pg_dump failed; nothing was uploaded"; return 1; }
  [ -s "$WORK/db.dump" ] || { fail dump "the dump is empty; nothing was uploaded"; return 1; }
  [ "$(head -c 5 "$WORK/db.dump")" = PGDMP ] || { fail dump "the dump is not a custom-format archive; nothing was uploaded"; return 1; }
  pgv=$(docker exec "$DB" pg_dump --version | sed -n 's/^pg_dump (PostgreSQL) \([0-9][0-9.]*\).*/\1/p')
  docker exec -i "$DB" pg_restore --list <"$WORK/db.dump" >"$WORK/db.toc" 2>/dev/null || { fail verify "pg_restore cannot read the archive; nothing was uploaded"; return 1; }
  toc=$(grep -cE '^[0-9]+;' "$WORK/db.toc" || true)
  for f in $REQUIRED_DATA; do
    grep -qE "^[0-9]+; [0-9]+ [0-9]+ TABLE DATA public $f " "$WORK/db.toc" || { fail verify "the archive holds no data for table $f; nothing was uploaded"; return 1; }
  done
  # The facts file carries its own query, so a drill recomputes exactly the same facts after the restore.
  facts_sql >"$WORK/facts.sql"
  docker exec -i "$DB" psql -X -q -At -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -f - <"$WORK/facts.sql" >"$WORK/facts.out" 2>/dev/null \
    || { fail facts "the restore facts could not be read; nothing was uploaded"; return 1; }
  [ -s "$WORK/facts.out" ] || { fail facts "the restore facts are empty; nothing was uploaded"; return 1; }
  { cat "$WORK/facts.sql"; printf '%s\n' '-- nawara-backup-facts-results'; cat "$WORK/facts.out"; } >"$WORK/facts.txt"
  local files=(); for f in $CONFIG_FILES; do [ -e "$STATE/$f" ] && files+=("$f"); done
  tar -C "$STATE" --numeric-owner -cpf "$WORK/config.tar" -- "${files[@]}" 2>/dev/null || { fail config "the secret files could not be archived; nothing was uploaded"; return 1; }
  dump_sha=$(sha256sum "$WORK/db.dump" | cut -d' ' -f1)

  for f in db.dump config.tar facts.txt; do
    openssl cms -encrypt -binary -stream -aes-256-cbc -outform DER -in "$WORK/$f" -out "$WORK/$f.cms" "$RECIPIENT" 2>/dev/null \
      && [ -s "$WORK/$f.cms" ] && openssl cms -cmsout -inform DER -in "$WORK/$f.cms" -noout 2>/dev/null \
      || { fail encrypt "encryption of $f failed; nothing was uploaded"; return 1; }
  done
  rm -f "$WORK/db.dump" "$WORK/config.tar" "$WORK/facts.txt" "$WORK/facts.sql" "$WORK/facts.out" "$WORK/db.toc"   # no plaintext from here on

  local a key sz sha lines=()
  for a in db.dump:db.dump.cms config.tar:config.tar.cms facts.txt:facts.cms; do
    key="$base.${a#*:}"; sz=$(stat -c %s "$WORK/${a%%:*}.cms"); sha=$(sha256sum "$WORK/${a%%:*}.cms" | cut -d' ' -f1)
    lines+=("artifact.${a%%.*}=$key $sz $sha")
  done
  {
    printf '%s\n' 'format=nawara-core-backup/1' "service=$svc" "stamp=$STAMP" "database=$DB_NAME" "postgres=$pgv" 'dump_format=custom' \
      "toc_entries=$toc" "dump_sha256=$dump_sha" 'cipher=cms-aes-256-cbc' "recipient_sha256=$RECIPIENT_SHA" "config_files=${files[*]}" "${lines[@]}"
  } >"$WORK/manifest"

  local rc=0
  for a in db.dump.cms:db.dump.cms facts.txt.cms:facts.cms config.tar.cms:config.tar.cms manifest:manifest; do
    upload "$base.${a#*:}" "${a%%:*}" || rc=$?
    [ "$rc" = 0 ] || { fail upload "$([ "$rc" = 1 ] && echo 'the upload' || echo 'the remote size check') of $base.${a#*:} failed; the set is incomplete (no manifest)"; return 1; }
  done
  status "$svc" last-success "stamp=$STAMP" "manifest=$base.manifest" "postgres=$pgv" "toc_entries=$toc" "${lines[@]}"
  status "$svc" last-attempt "stamp=$STAMP" "result=succeeded"
  log "OK  $svc: $base.{db.dump.cms,facts.cms,config.tar.cms,manifest} uploaded and verified (PostgreSQL $pgv, $toc archive entries)"
  cleanup
}

failed=0; retention_failed=0
for s in $BACKUP_SERVICES; do
  if backup_one "$s"; then
    WORK=$(mktemp -d "$DIR/work/retention.XXXXXX")
    retention "$s" || { retention_failed=1; printf '[backup] ERROR: %s: retention failed; the new backup is intact and nothing else was changed after the failure\n' "$s" >&2; }
    cleanup
  else
    failed=1
  fi
done
[ "$failed" = 0 ] || exit 1
[ "$retention_failed" = 0 ] || exit 3
log "all backups succeeded ($BACKUP_SERVICES) at $STAMP"
