#!/usr/bin/env bash
# Provisions and (re)deploys organization-service on the VPS (Stage 21.x G1; ADR-0040 G1, ADR-0053). Runs ON THE SERVER, streamed out
# of the image being deployed, so the script and the migrations always match the code:
#
#   docker run --rm --entrypoint cat "$IMAGE" deploy/provision-and-deploy.sh | IMAGE="$IMAGE" bash -s
#
# DEPLOYING IS NOT ACTIVATING. This script never runs an `ownership` command (declare-class, verify, approve, activate, retire), never
# sets OWNERSHIP_PRODUCTION_ACTIVATION, never registers a caller token (that is deploy/register-caller.sh, an F1/F4 operator step), and
# never touches Auth. It only reports the ownership phase, read-only. Authority stays where it is until the approved F6.
#
# organization-service is private: only the internal Core network (with its database, the broker and Auth), no Traefik route, no
# published port. Health is /ready (database + migrations); it does not depend on authority (PREPARED is healthy) nor on the broker
# (audit evidence waits in the outbox).
#
# Prerequisites: the broker (infra/rabbitmq/provision.sh) with the organization-service identity; audit-service deployed (it is the
# consumer that binds audit.#, ADR-0053 §5). Idempotent; never deletes the database container or volume; never overwrites a secret;
# never prints one.
#
# State kept on the server (mode 0700 dir, 0600 files), default $HOME/nawara-core/organization-service:
#   db.env     POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD         (the bootstrap superuser; the postgres container only)
#   roles.env  ORGANIZATION_MIGRATOR_PASSWORD / ORGANIZATION_APP_PASSWORD (never passed to any container's environment)
#   .env       the service environment (SERVICE_TOKENS / SERVICE_POLICY are written by register-caller.sh only)
#   callers/   raw caller tokens, written by register-caller.sh only (F1 provisioning, F4 auth-service)
#
# Database roles (ADR-0032, ADR-0040 G3; as infra/postgres/init): organization_migrator owns the database and schema, applies the
# migrations and is the ownership CLI's login; the service runs as organization_app. The roles and their default privileges are created
# BEFORE the migrations: 0004 and 0005 narrow organization_app only IF it exists, so migrating first would silently leave the runtime role
# able to write the ownership state. The migration history (schema_migrations) is the migrator's alone: organization_app may only read
# it (/ready). After migrating, the privileges are ASSERTED and the deploy fails closed on any deviation.
set -euo pipefail
umask 077

: "${IMAGE:?IMAGE (full image reference to deploy) is required}"
DIR="${DEPLOY_DIR:-$HOME/nawara-core/organization-service}"
NET="${CORE_NETWORK:-nawara-core-internal}"
BROKER="${RABBITMQ_CONTAINER:-nawara-core-rabbitmq}"
BROKER_CLIENT="${BROKER_DIR:-$HOME/nawara-core/rabbitmq}/clients/organization-service.env"
AUTH_URL=http://nawara-core-auth-service:3000
DB=nawara-core-organization-db
VOL=nawara-core-organization-db-data
APP=nawara-core-organization-service
DB_ENV="$DIR/db.env"
ROLES_ENV="$DIR/roles.env"
APP_ENV="$DIR/.env"
DB_IMAGE=postgres:16-alpine

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }
exists() { docker inspect "$1" >/dev/null 2>&1; }
# Append KEY=VALUE only when KEY is absent, so re-runs never rotate or overwrite a secret.
ensure() { grep -q "^$2=" "$1" 2>/dev/null || { printf '%s=%s\n' "$2" "$3" >>"$1"; log "  + $2 (new)"; }; }
broker() { docker exec -u rabbitmq "$BROKER" "$@"; }

# ---------------------------------------------------------------- preflight (nothing is changed before this passes)
[ "$(docker network inspect -f '{{.Internal}}' "$NET" 2>/dev/null)" = true ] \
  || die "the internal Core network '$NET' does not exist (or is not --internal); provision the broker first (infra/rabbitmq/provision.sh); nothing was changed"
broker rabbitmq-diagnostics -q check_running >/dev/null 2>&1 && broker rabbitmq-diagnostics -q check_port_connectivity >/dev/null 2>&1 \
  || die "the broker $BROKER is not running or not ready; nothing was changed"
grep -q '^RABBITMQ_URL=amqp..*' "$BROKER_CLIENT" 2>/dev/null \
  || die "the broker identity for organization-service is missing ($BROKER_CLIENT); run infra/rabbitmq/provision.sh with organization-service; nothing was changed"
command -v openssl >/dev/null || die "openssl is required on the server to generate secrets; nothing was changed"

mkdir -p "$DIR"; chmod 700 "$DIR"

# ---------------------------------------------------------------- PostgreSQL (private: internal network only, no published port)
if exists "$DB"; then
  [ -f "$DB_ENV" ] || die "container $DB exists but $DB_ENV is missing; refusing to guess its password"
  [ -f "$ROLES_ENV" ] || die "container $DB exists but $ROLES_ENV is missing; refusing to guess the role passwords"
else
  log "creating PostgreSQL ($DB_IMAGE), volume $VOL, network $NET, no published port"
  touch "$DB_ENV"; chmod 600 "$DB_ENV"
  ensure "$DB_ENV" POSTGRES_USER organization_admin
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
ensure "$ROLES_ENV" ORGANIZATION_MIGRATOR_PASSWORD "$(openssl rand -hex 24)"
ensure "$ROLES_ENV" ORGANIZATION_APP_PASSWORD "$(openssl rand -hex 24)"
docker start "$DB" >/dev/null 2>&1 || true

log "waiting for $DB to be healthy"
for _ in $(seq 1 40); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$DB")" = healthy ] && break
  sleep 3
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$DB")" = healthy ] || { docker logs --tail 30 "$DB" >&2; die "$DB is not healthy"; }

PGUSER=$(sed -n 's/^POSTGRES_USER=//p' "$DB_ENV")
MIG_PASS=$(sed -n 's/^ORGANIZATION_MIGRATOR_PASSWORD=//p' "$ROLES_ENV")
APP_PASS=$(sed -n 's/^ORGANIZATION_APP_PASSWORD=//p' "$ROLES_ENV")
# SQL with a password is piped (stdin), never on a command line; read-only facts are single queries over the local socket.
psql_stdin() { docker exec -i "$DB" psql -q -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$1" -f -; }
pg_facts() { docker exec "$DB" psql -q -v ON_ERROR_STOP=1 -At -U "$PGUSER" -d "$1" -c "$2"; }

# ---------------------------------------------------------------- 1. roles and default privileges, BEFORE any migration
log "ensuring the organization database and its roles (organization_migrator owns, organization_app runs) before migrating"
{
  printf '%s\n' 'DO $role$ BEGIN'
  printf '%s\n' "  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'organization_migrator') THEN CREATE ROLE organization_migrator; END IF;"
  printf '%s\n' "  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'organization_app') THEN CREATE ROLE organization_app; END IF;"
  printf '%s\n' 'END $role$;'
  printf "ALTER ROLE organization_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" "$MIG_PASS"
  printf "ALTER ROLE organization_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" "$APP_PASS"
  printf '%s\n' "SELECT 'CREATE DATABASE organization OWNER organization_migrator' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'organization')\\gexec"
  printf '%s\n' 'ALTER DATABASE organization OWNER TO organization_migrator;'
  printf '%s\n' 'REVOKE ALL ON DATABASE organization FROM PUBLIC;'
  printf '%s\n' 'GRANT CONNECT ON DATABASE organization TO organization_app;'
} | psql_stdin postgres
# Only DEFAULT privileges (as infra/postgres/init): never `GRANT ... ON ALL TABLES`, which would hand organization_app back what 0004 and
# 0005 revoke. The migrations then narrow these defaults on the ownership, hierarchy and admin-record tables.
{
  printf '%s\n' 'REVOKE ALL ON SCHEMA public FROM PUBLIC;'
  printf '%s\n' 'ALTER SCHEMA public OWNER TO organization_migrator;'
  printf '%s\n' 'GRANT USAGE ON SCHEMA public TO organization_app;'
  printf '%s\n' 'ALTER DEFAULT PRIVILEGES FOR ROLE organization_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO organization_app;'
  printf '%s\n' 'ALTER DEFAULT PRIVILEGES FOR ROLE organization_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO organization_app;'
} | psql_stdin organization

# ---------------------------------------------------------------- 2. migrations (the kit runner, from THIS image, as organization_migrator)
log "applying pending migrations from the image"
MIG_ENV=$(mktemp "$DIR/.migrate.XXXXXX")
trap 'rm -f "$MIG_ENV"' EXIT
printf 'MIGRATION_DATABASE_URL=postgres://organization_migrator:%s@%s:5432/organization\n' "$MIG_PASS" "$DB" >"$MIG_ENV"
docker run --rm --network "$NET" --env-file "$MIG_ENV" --entrypoint node "$IMAGE" ../../libs/service-kit/dist/cli/migrate.js --dir db/migrations \
  || die "migrations failed or were refused; the running service was not touched"
rm -f "$MIG_ENV"

# The runner creates schema_migrations as organization_migrator, so the default privileges above give organization_app DML on it. The
# runtime only reads it (/ready); writing it could mark a future migration as applied (the runner would then skip it), null a checksum
# (no drift detection) or erase the history. Narrowed on every deploy, as Auth's deploy does, and asserted below.
log "making the migration history read-only for organization_app"
printf '%s\n' 'REVOKE ALL ON TABLE schema_migrations FROM organization_app;' 'GRANT SELECT ON TABLE schema_migrations TO organization_app;' \
  | psql_stdin organization

# ---------------------------------------------------------------- 3. the runtime role's privileges, ASSERTED (fail closed)
# Exactly what migrations 0004 and 0005 establish: the runtime may never write the ownership state or its records, never delete or
# truncate the hierarchy, and only append to the admin actor record; it must still read the state and append the record. It never writes
# the migration history (read-only, above), which it must still read for /ready.
log "asserting the runtime role's privileges"
attrs=$(pg_facts postgres "SELECT concat_ws('|', rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls) FROM pg_roles WHERE rolname = 'organization_app'")
[ "$attrs" = 'f|f|f|f|f' ] || die "organization_app has an elevated attribute (superuser, createdb, createrole, replication or bypassrls); the running service was not touched"
forbidden=$(pg_facts organization "SELECT coalesce(string_agg(t || ':' || p, ',' ORDER BY t, p), '') FROM (VALUES
  ('ownership_state','INSERT'),('ownership_state','UPDATE'),('ownership_state','DELETE'),('ownership_state','TRUNCATE'),
  ('ownership_event','INSERT'),('ownership_event','UPDATE'),('ownership_event','DELETE'),('ownership_event','TRUNCATE'),
  ('ownership_import_run','INSERT'),('ownership_import_run','UPDATE'),('ownership_import_run','DELETE'),('ownership_import_run','TRUNCATE'),
  ('hierarchy_id_ledger','INSERT'),('hierarchy_id_ledger','UPDATE'),('hierarchy_id_ledger','DELETE'),('hierarchy_id_ledger','TRUNCATE'),
  ('company','DELETE'),('company','TRUNCATE'),('platform','DELETE'),('platform','TRUNCATE'),('organization','DELETE'),('organization','TRUNCATE'),
  ('admin_actor_event','UPDATE'),('admin_actor_event','DELETE'),('admin_actor_event','TRUNCATE'),
  ('schema_migrations','INSERT'),('schema_migrations','UPDATE'),('schema_migrations','DELETE'),('schema_migrations','TRUNCATE')
) AS v(t, p) WHERE has_table_privilege('organization_app', 'public.' || t, p)")
[ -z "$forbidden" ] || die "organization_app holds forbidden privileges ($forbidden): the runtime could write authority state or the migration history, or delete the hierarchy; the running service was not touched"
missing=$(pg_facts organization "SELECT coalesce(string_agg(t || ':' || p, ',' ORDER BY t, p), '') FROM (VALUES
  ('ownership_state','SELECT'),('admin_actor_event','INSERT'),('company','SELECT'),('company','INSERT'),('schema_migrations','SELECT')
) AS v(t, p) WHERE NOT has_table_privilege('organization_app', 'public.' || t, p)")
[ -z "$missing" ] || die "organization_app lacks privileges the service needs ($missing); the running service was not touched"

# ---------------------------------------------------------------- 4. application environment
log "ensuring $APP_ENV (existing values are never overwritten)"
touch "$APP_ENV"; chmod 600 "$APP_ENV"
ensure "$APP_ENV" NODE_ENV production
ensure "$APP_ENV" DATABASE_URL "postgres://organization_app:$APP_PASS@$DB:5432/organization"
ensure "$APP_ENV" RABBITMQ_URL "$(sed -n 's/^RABBITMQ_URL=//p' "$BROKER_CLIENT")"
# Only for the admin/ routes, which forward the human's own bearer; Organization holds no Auth credential.
ensure "$APP_ENV" AUTH_SERVICE_URL "$AUTH_URL"
# SERVICE_TOKENS / SERVICE_POLICY are absent until register-caller.sh adds a caller: every service-token call is refused (deny by default).

# ---------------------------------------------------------------- 5. application container
PREV=""
if exists "$APP"; then
  PREV="$APP-previous-$(date +%Y%m%d%H%M%S)"
  log "stopping current $APP and keeping it as $PREV (not deleted)"
  docker stop -t 60 "$APP" >/dev/null
  docker rename "$APP" "$PREV"
fi

log "starting $APP from $IMAGE (internal network only, no Traefik route, no published port)"
docker run -d --name "$APP" --restart unless-stopped --stop-timeout 60 --network "$NET" --env-file "$APP_ENV" \
  --label traefik.enable=false \
  --health-cmd 'wget -qO- http://127.0.0.1:3000/ready >/dev/null || exit 1' \
  --health-interval 10s --health-timeout 5s --health-retries 3 --health-start-period 20s \
  "$IMAGE" >/dev/null

ok=""
st="unknown"
for _ in $(seq 1 40); do
  st=$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$APP")
  [ "$st" = running/healthy ] && { ok=1; break; }
  [ "${st%%/*}" = running ] || break
  sleep 3
done

# The exposure contract, checked on the running container itself.
if [ -n "$ok" ]; then
  [ "$(docker inspect -f '{{len .HostConfig.PortBindings}}' "$APP")" = 0 ] || { ok=""; st="publishes a host port"; }
  [ "$(docker inspect -f '{{.HostConfig.PublishAllPorts}}' "$APP")" = false ] || { ok=""; st="publishes all ports"; }
  [ "$(docker inspect -f '{{range $n, $_ := .NetworkSettings.Networks}}{{$n}} {{end}}' "$APP")" = "$NET " ] || { ok=""; st="attached to a network other than $NET"; }
fi

if [ -z "$ok" ]; then
  log "new container is not ready or breaks the exposure contract (state: $st); last logs follow"
  docker logs --tail 40 "$APP" >&2 || true
  docker rm -f "$APP" >/dev/null 2>&1 || true
  if [ -n "$PREV" ]; then log "rolling back to $PREV"; docker rename "$PREV" "$APP"; docker start "$APP" >/dev/null; fi
  die "deploy failed"
fi

# ---------------------------------------------------------------- 6. read-only report (never changes the ownership state)
phase=$(pg_facts organization "SELECT phase || '|' || coalesce(environment_class, 'undeclared') FROM ownership_state")
log "OK  $APP is running/healthy on $NET; ownership phase ${phase%%|*}, environment class ${phase##*|} (deploying never changes it)"
[ -z "$PREV" ] || log "previous container kept stopped as $PREV; remove it manually once satisfied"
docker ps --filter "name=nawara-core-organization" --format '  {{.Names}}\t{{.Status}}\t{{.Image}}'
log "env var names configured: $(sed 's/=.*//' "$APP_ENV" | tr '\n' ' ')"
