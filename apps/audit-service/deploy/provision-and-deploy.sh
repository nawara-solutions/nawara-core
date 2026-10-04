#!/usr/bin/env bash
# Provisions and (re)deploys audit-service on the VPS (ADR-0053). Runs ON THE SERVER, streamed out of the image being deployed, so the
# script and the migrations always match the code:
#
#   docker run --rm --entrypoint cat "$IMAGE" deploy/provision-and-deploy.sh | IMAGE="$IMAGE" bash -s
#
# audit-service is private: it is attached ONLY to the internal Core network (with its database and the broker), has no Traefik route
# and no published port. It consumes `audit-service.audit` (bound to `audit.#` on `nawara.events`) and DECLARES that topology itself when
# it attaches; the deploy succeeds only once the consumer is attached and the declared topology is verified on the broker. That is the
# precondition Auth's deploy checks before it lets its relay publish audit evidence (the ordering rule, ADR-0053 §5).
#
# Prerequisite: the broker, provisioned by infra/rabbitmq/provision.sh (the network, the broker, and the audit-service identity).
# Idempotent. Never deletes the database container/volume, never overwrites an existing secret, never prints a secret value.
#
# State kept on the server (mode 0700 dir, 0600 files), default $HOME/nawara-core/audit-service:
#   db.env     POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD  (the bootstrap superuser, consumed by the postgres container only)
#   roles.env  AUDIT_MIGRATOR_PASSWORD / AUDIT_APP_PASSWORD      (never passed to any container's environment)
#   .env       the audit-service environment
#
# Database roles (ADR-0032, as infra/postgres/init/01-service-databases.sh): `audit_migrator` owns the `audit` database and schema and
# applies the migrations; the service runs as `audit_app` (CONNECT, schema USAGE and the default privileges that migration 0001 then
# narrows to append-only). The retention role (P-A2 / Stage 18.8) is not created: retention durations are undecided and the policy
# ships empty (never purge).
set -euo pipefail
umask 077

: "${IMAGE:?IMAGE (full image reference to deploy) is required}"
DIR="${DEPLOY_DIR:-$HOME/nawara-core/audit-service}"
NET="${CORE_NETWORK:-nawara-core-internal}"
BROKER="${RABBITMQ_CONTAINER:-nawara-core-rabbitmq}"
BROKER_CLIENT="${BROKER_DIR:-$HOME/nawara-core/rabbitmq}/clients/audit-service.env"
DB=nawara-core-audit-db
VOL=nawara-core-audit-db-data
APP=nawara-core-audit-service
DB_ENV="$DIR/db.env"
ROLES_ENV="$DIR/roles.env"
APP_ENV="$DIR/.env"
DB_IMAGE=postgres:16-alpine
VHOST=nawara-core
QUEUE=audit-service.audit

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }
exists() { docker inspect "$1" >/dev/null 2>&1; }
# Append KEY=VALUE only when KEY is absent, so re-runs never rotate or overwrite a secret.
ensure() { grep -q "^$2=" "$1" 2>/dev/null || { printf '%s=%s\n' "$2" "$3" >>"$1"; log "  + $2 (new)"; }; }
# Broker CLI as the `rabbitmq` user (see infra/rabbitmq/provision.sh: a root CLI can take the node down during its boot).
broker() { docker exec -u rabbitmq "$BROKER" "$@"; }

# ---------------------------------------------------------------- preflight (nothing is changed before this passes)
[ "$(docker network inspect -f '{{.Internal}}' "$NET" 2>/dev/null)" = true ] \
  || die "the internal Core network '$NET' does not exist (or is not --internal); provision the broker first (infra/rabbitmq/provision.sh); nothing was changed"
broker rabbitmq-diagnostics -q check_running >/dev/null 2>&1 && broker rabbitmq-diagnostics -q check_port_connectivity >/dev/null 2>&1 \
  || die "the broker $BROKER is not running or not ready; provision it first (infra/rabbitmq/provision.sh); nothing was changed"
grep -q '^RABBITMQ_URL=amqp..*' "$BROKER_CLIENT" 2>/dev/null \
  || die "the broker identity for audit-service is missing ($BROKER_CLIENT); run infra/rabbitmq/provision.sh with audit-service; nothing was changed"
command -v openssl >/dev/null || die "openssl is required on the server to generate secrets; nothing was changed"

mkdir -p "$DIR"; chmod 700 "$DIR"

# ---------------------------------------------------------------- PostgreSQL (private: internal network only, no published port)
if exists "$DB"; then
  [ -f "$DB_ENV" ] || die "container $DB exists but $DB_ENV is missing; refusing to guess its password"
  [ -f "$ROLES_ENV" ] || die "container $DB exists but $ROLES_ENV is missing; refusing to guess the role passwords"
else
  log "creating PostgreSQL ($DB_IMAGE), volume $VOL, network $NET, no published port"
  touch "$DB_ENV"; chmod 600 "$DB_ENV"
  ensure "$DB_ENV" POSTGRES_USER audit_admin
  ensure "$DB_ENV" POSTGRES_DB postgres
  ensure "$DB_ENV" POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  docker run -d --name "$DB" --restart unless-stopped --network "$NET" \
    --env-file "$DB_ENV" -v "$VOL":/var/lib/postgresql/data \
    --health-cmd 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    --health-interval 5s --health-timeout 3s --health-retries 12 --health-start-period 10s \
    --label traefik.enable=false \
    "$DB_IMAGE" >/dev/null
fi
touch "$ROLES_ENV"; chmod 600 "$ROLES_ENV"
ensure "$ROLES_ENV" AUDIT_MIGRATOR_PASSWORD "$(openssl rand -hex 24)"
ensure "$ROLES_ENV" AUDIT_APP_PASSWORD "$(openssl rand -hex 24)"
docker start "$DB" >/dev/null 2>&1 || true

log "waiting for $DB to be healthy"
for _ in $(seq 1 40); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$DB")" = healthy ] && break
  sleep 3
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$DB")" = healthy ] || { docker logs --tail 30 "$DB" >&2; die "$DB is not healthy"; }

PGUSER=$(sed -n 's/^POSTGRES_USER=//p' "$DB_ENV")
MIG_PASS=$(sed -n 's/^AUDIT_MIGRATOR_PASSWORD=//p' "$ROLES_ENV")
APP_PASS=$(sed -n 's/^AUDIT_APP_PASSWORD=//p' "$ROLES_ENV")
# The script itself arrives on stdin (`bash -s`), so SQL is piped to psql explicitly; passwords travel in that SQL, never on a command line.
psql_stdin() { docker exec -i "$DB" psql -q -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$1" -f -; }
pg_facts() { docker exec "$DB" psql -q -v ON_ERROR_STOP=1 -At -U "$PGUSER" -d "$1" -c "$2"; }

# ---------------------------------------------------------------- database and roles (re-applied every deploy; idempotent)
log "ensuring the audit database and its roles (audit_migrator owns, audit_app runs)"
{
  printf '%s\n' 'DO $role$ BEGIN'
  printf '%s\n' "  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_migrator') THEN CREATE ROLE audit_migrator; END IF;"
  printf '%s\n' "  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_app') THEN CREATE ROLE audit_app; END IF;"
  printf '%s\n' 'END $role$;'
  printf "ALTER ROLE audit_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" "$MIG_PASS"
  printf "ALTER ROLE audit_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" "$APP_PASS"
  printf '%s\n' "SELECT 'CREATE DATABASE audit OWNER audit_migrator' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'audit')\\gexec"
  printf '%s\n' 'ALTER DATABASE audit OWNER TO audit_migrator;'
  printf '%s\n' 'REVOKE ALL ON DATABASE audit FROM PUBLIC;'
  printf '%s\n' 'GRANT CONNECT ON DATABASE audit TO audit_app;'
} | psql_stdin postgres
# Only DEFAULT privileges, exactly as the local init script: never `GRANT ... ON ALL TABLES` here, which would hand audit_app back the
# UPDATE / DELETE that migration 0001 (audit_restrict_to_append_only) revokes from the append-only tables.
{
  printf '%s\n' 'REVOKE ALL ON SCHEMA public FROM PUBLIC;'
  printf '%s\n' 'ALTER SCHEMA public OWNER TO audit_migrator;'
  printf '%s\n' 'GRANT USAGE ON SCHEMA public TO audit_app;'
  printf '%s\n' 'ALTER DEFAULT PRIVILEGES FOR ROLE audit_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO audit_app;'
  printf '%s\n' 'ALTER DEFAULT PRIVILEGES FOR ROLE audit_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO audit_app;'
} | psql_stdin audit

# ---------------------------------------------------------------- migrations (the kit runner, from THIS image, as audit_migrator)
# The kit baseline (outbox / inbox) first, then audit's own; one advisory lock, per-migration transactions, stored checksums. A refusal
# or failure stops the deploy BEFORE the running service is touched.
log "applying pending migrations from the image"
MIG_ENV=$(mktemp "$DIR/.migrate.XXXXXX")
trap 'rm -f "$MIG_ENV"' EXIT
printf 'MIGRATION_DATABASE_URL=postgres://audit_migrator:%s@%s:5432/audit\n' "$MIG_PASS" "$DB" >"$MIG_ENV"
docker run --rm --network "$NET" --env-file "$MIG_ENV" --entrypoint node "$IMAGE" ../../libs/service-kit/dist/cli/migrate.js --dir db/migrations \
  || die "migrations failed or were refused; the running service was not touched"
rm -f "$MIG_ENV"

# V2 A13 (O3-B): the runner creates schema_migrations as audit_migrator, so the default privileges above give audit_app DML on it. The
# runtime only reads it (/ready); writing it could mark a future migration as applied, null a checksum or erase the history. Narrowed on
# every deploy (idempotent), as Auth's and Organization's deploys do; the general default privileges stay as they are (the runtime needs
# them on inbox, outbox and kit_rate_limit).
log "making the migration history read-only for audit_app"
printf '%s\n' 'REVOKE ALL ON TABLE schema_migrations FROM audit_app;' 'GRANT SELECT ON TABLE schema_migrations TO audit_app;' \
  | psql_stdin audit

# ---------------------------------------------------------------- the runtime role's privileges, ASSERTED (fail closed)
# The runtime never writes the migration history, never rewrites or removes evidence (migrations 0001 and 0003 make audit_record and
# audit_retention_run append-only and audit_retention_policy owner-only) and never runs the owner's privilege helpers. It must still read
# the history (/ready) and read and append audit records.
log "asserting the runtime role's privileges"
attrs=$(pg_facts postgres "SELECT concat_ws('|', rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls) FROM pg_roles WHERE rolname = 'audit_app'")
[ "$attrs" = 'f|f|f|f|f' ] || die "audit_app has an elevated attribute (superuser, createdb, createrole, replication or bypassrls); the running service was not touched"
forbidden=$(pg_facts audit "SELECT coalesce(string_agg(x, ',' ORDER BY x), '') FROM (
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
[ -z "$forbidden" ] || die "audit_app holds forbidden privileges ($forbidden): the runtime could write the migration history or rewrite evidence; the running service was not touched"
missing=$(pg_facts audit "SELECT coalesce(string_agg(t || ':' || p, ',' ORDER BY t, p), '') FROM (VALUES
  ('schema_migrations','SELECT'),('audit_record','SELECT'),('audit_record','INSERT')
) AS v(t, p) WHERE NOT has_table_privilege('audit_app', 'public.' || t, p)")
[ -z "$missing" ] || die "audit_app lacks privileges the service needs ($missing); the running service was not touched"

# ---------------------------------------------------------------- application environment
log "ensuring $APP_ENV (existing values are never overwritten)"
touch "$APP_ENV"; chmod 600 "$APP_ENV"
ensure "$APP_ENV" NODE_ENV production
ensure "$APP_ENV" DATABASE_URL "postgres://audit_app:$APP_PASS@$DB:5432/audit"
ensure "$APP_ENV" RABBITMQ_URL "$(sed -n 's/^RABBITMQ_URL=//p' "$BROKER_CLIENT")"
# No SERVICE_TOKENS / AUDIT_SERVICE_POLICY: every read is refused (deny by default) until real readers exist (P-A8). Ingestion needs none.

# ---------------------------------------------------------------- application container
PREV=""
if exists "$APP"; then
  PREV="$APP-previous-$(date +%Y%m%d%H%M%S)"
  log "stopping current $APP and keeping it as $PREV (not deleted)"
  docker stop -t 60 "$APP" >/dev/null
  docker rename "$APP" "$PREV"
fi

log "starting $APP from $IMAGE (internal network only, no Traefik route)"
# Health is /ready: database + migrations + broker + the ingestion consumer attached (Stage 18.5). Healthy therefore means the consumer
# has declared and bound its queue.
docker run -d --name "$APP" --restart unless-stopped --stop-timeout 60 --network "$NET" --env-file "$APP_ENV" \
  --label traefik.enable=false \
  --health-cmd 'wget -qO- http://127.0.0.1:3000/ready >/dev/null || exit 1' \
  --health-interval 10s --health-timeout 5s --health-retries 3 --health-start-period 20s \
  "$IMAGE" >/dev/null

ok=""
for _ in $(seq 1 60); do
  st=$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$APP")
  [ "$st" = running/healthy ] && { ok=1; break; }
  [ "${st%%/*}" = running ] || break
  sleep 3
done

# ---------------------------------------------------------------- the topology Auth's relay depends on, verified on the broker itself
if [ -n "$ok" ]; then
  T=$'\t'; Q='audit-service\.audit'
  queues=$(broker rabbitmqctl -q list_queues -p "$VHOST" name durable arguments consumers --no-table-headers 2>/dev/null || true)
  bindings=$(broker rabbitmqctl -q list_bindings -p "$VHOST" source_name destination_name routing_key --no-table-headers 2>/dev/null || true)
  grep -qE "^${Q}${T}true${T}.*nawara\.events\.dlx.*${T}[1-9][0-9]*\$" <<<"$queues" || { ok=""; st="$QUEUE not declared as expected or has no consumer"; }
  grep -qE "^${Q}\.retry${T}true${T}" <<<"$queues" || { ok=""; st="$QUEUE.retry missing"; }
  grep -qE "^${Q}\.dead${T}true${T}" <<<"$queues" || { ok=""; st="$QUEUE.dead missing"; }
  grep -qxF "nawara.events${T}${QUEUE}${T}audit.#" <<<"$bindings" || { ok=""; st="binding nawara.events -> $QUEUE (audit.#) missing"; }
fi

if [ -z "$ok" ]; then
  log "new container is not ready (state: $st); last logs follow"
  docker logs --tail 40 "$APP" >&2 || true
  docker rm -f "$APP" >/dev/null 2>&1 || true
  if [ -n "$PREV" ]; then log "rolling back to $PREV"; docker rename "$PREV" "$APP"; docker start "$APP" >/dev/null; fi
  die "deploy failed"
fi

log "OK  $APP is running/healthy; $QUEUE is declared, bound to audit.# and consumed"
[ -z "$PREV" ] || log "previous container kept stopped as $PREV; remove it manually once satisfied"
docker ps --filter "name=nawara-core-audit" --format '  {{.Names}}\t{{.Status}}\t{{.Image}}'
log "env var names configured: $(sed 's/=.*//' "$APP_ENV" | tr '\n' ' ')"
