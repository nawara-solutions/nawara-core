#!/usr/bin/env bash
# Provisions and (re)deploys auth-service on the VPS. Runs ON THE SERVER, streamed out of the image
# being deployed (so the script and db/migrations always match the code):
#
#   docker run --rm --entrypoint cat "$IMAGE" deploy/provision-and-deploy.sh | IMAGE="$IMAGE" bash -s
#
# Idempotent. Never deletes the database container/volume, never overwrites an existing secret,
# never prints a secret value (no `set -x`; only variable NAMES are ever echoed).
#
# State kept on the server (mode 0700 dir, 0600 files), default $HOME/nawara-core/auth-service:
#   db.env  POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD  (consumed by the postgres container)
#           AUTH_APP_PASSWORD  (the least-privilege runtime role's password, Stage 14.3)
#   .env    the auth-service environment, names as in apps/auth-service/.env.example
#
# Database roles (ADR-0032): POSTGRES_USER (`auth`) is the database's bootstrap owner. It applies the migrations below and
# nothing else. The service itself connects as `auth_app`: CONNECT plus DML on the application tables, no DDL, no role or
# database creation, not a superuser. auth-service refuses to start in production as `auth`, `postgres` or a *_migrator.
set -euo pipefail
umask 077

: "${IMAGE:?IMAGE (full image reference to deploy) is required}"
DIR="${DEPLOY_DIR:-$HOME/nawara-core/auth-service}"
NET="${DEPLOY_NETWORK:-deploy_edge}"
HOST_RULE="${AUTH_HOST:-core-api.hsalem-anwar.dev}"
DB=nawara-core-auth-db
VOL=nawara-core-auth-db-data
APP=nawara-core-auth-service
DB_ENV="$DIR/db.env"
APP_ENV="$DIR/.env"
DB_IMAGE=postgres:16-alpine

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }
exists() { docker inspect "$1" >/dev/null 2>&1; }
# Append KEY=VALUE only when KEY is absent, so re-runs never rotate or overwrite a secret.
ensure() { grep -q "^$2=" "$1" 2>/dev/null || { printf '%s=%s\n' "$2" "$3" >>"$1"; log "  + $2 (new)"; }; }

mkdir -p "$DIR"; chmod 700 "$DIR"
# Stage 18.7.5: the central audit relay publishes Auth's audit evidence to RabbitMQ, and the service refuses to start in production
# without RABBITMQ_URL (independent of AUTH_EVENTS). Checked BEFORE anything is migrated or stopped, so a missing broker can never turn
# a deploy into an outage. Supply it once (RABBITMQ_URL=amqps://... on the deploy command, or in "$APP_ENV"); the value is never echoed.
if [ -z "${RABBITMQ_URL:-}" ] && ! grep -q '^RABBITMQ_URL=..*' "$APP_ENV" 2>/dev/null; then
  die "RABBITMQ_URL is not set (neither in the deploy environment nor in $APP_ENV): auth-service needs a broker for its audit relay (Stage 18.7.5); nothing was changed"
fi
docker network inspect "$NET" >/dev/null 2>&1 || die "docker network '$NET' not found (Traefik's network); refusing to create it"
command -v openssl >/dev/null || die "openssl is required on the server to generate secrets"

# ---------------------------------------------------------------- PostgreSQL
if exists "$DB"; then
  [ -f "$DB_ENV" ] || die "container $DB exists but $DB_ENV is missing; refusing to guess its password"
else
  log "creating PostgreSQL ($DB_IMAGE), volume $VOL, no published port"
  touch "$DB_ENV"; chmod 600 "$DB_ENV"
  ensure "$DB_ENV" POSTGRES_USER auth
  ensure "$DB_ENV" POSTGRES_DB auth
  ensure "$DB_ENV" POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  docker run -d --name "$DB" --restart unless-stopped --network "$NET" \
    --env-file "$DB_ENV" -v "$VOL":/var/lib/postgresql/data \
    --health-cmd 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    --health-interval 5s --health-timeout 3s --health-retries 12 --health-start-period 10s \
    "$DB_IMAGE" >/dev/null
fi
docker start "$DB" >/dev/null 2>&1 || true

log "waiting for $DB to be healthy"
for _ in $(seq 1 40); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$DB")" = healthy ] && break
  sleep 3
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$DB")" = healthy ] || { docker logs --tail 30 "$DB" >&2; die "$DB is not healthy"; }

PGUSER=$(sed -n 's/^POSTGRES_USER=//p' "$DB_ENV"); PGDB=$(sed -n 's/^POSTGRES_DB=//p' "$DB_ENV")
PGPASS=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$DB_ENV")
# The script itself arrives on stdin (`bash -s`), so only the file-piping variant may read stdin.
psql_db() { docker exec "$DB" psql -q -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" "$@"; }
psql_stdin() { docker exec -i "$DB" psql -q -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" -f -; }

# ---------------------------------------------------------------- migrations (tracked)
# Stage 14.5: the service-kit migration runner, run FROM THIS EXACT IMAGE as the database owner ($PGUSER), never as auth_app:
# one advisory lock for the whole run (released by PostgreSQL if the runner dies), each migration and its bookkeeping row in ONE
# transaction, a stored checksum that must match on every later run, and a refusal of any history this release cannot explain
# (an unknown or out-of-order applied migration). Rows recorded by the previous runner get their checksum recorded once (logged).
# A refusal or failure stops the deploy BEFORE the running service is touched.
log "applying pending migrations from the image"
MIG_ENV=$(mktemp "$DIR/.migrate.XXXXXX")
trap 'rm -f "$MIG_ENV"' EXIT
printf 'MIGRATION_DATABASE_URL=postgres://%s:%s@%s:5432/%s\n' "$PGUSER" "$PGPASS" "$DB" "$PGDB" >"$MIG_ENV"
docker run --rm --network "$NET" --env-file "$MIG_ENV" --entrypoint node "$IMAGE" dist/cli/migrate.js \
  || die "migrations failed or were refused; the running service was not touched"
rm -f "$MIG_ENV"

# ---------------------------------------------------------------- runtime role (least privilege)
# Re-applied on every deploy, after the migrations, so a table a new migration created is covered too. The password is
# generated once and fed to psql on stdin (never on a command line, never printed).
APP_ROLE=auth_app
ensure "$DB_ENV" AUTH_APP_PASSWORD "$(openssl rand -hex 24)"
APP_PASS=$(sed -n 's/^AUTH_APP_PASSWORD=//p' "$DB_ENV")
log "ensuring the least-privilege runtime role $APP_ROLE"
{
  printf '%s\n' 'DO $role$ BEGIN'
  printf "  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %s; END IF;\n" "$APP_ROLE" "$APP_ROLE"
  printf '%s\n' 'END $role$;'
  printf "ALTER ROLE %s WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" "$APP_ROLE" "$APP_PASS"
  printf 'REVOKE ALL ON DATABASE %s FROM PUBLIC;\n' "$PGDB"
  printf 'GRANT CONNECT ON DATABASE %s TO %s;\n' "$PGDB" "$APP_ROLE"
  printf 'REVOKE ALL ON SCHEMA public FROM PUBLIC;\n'
  printf 'GRANT USAGE ON SCHEMA public TO %s;\n' "$APP_ROLE"
  printf 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %s;\n' "$APP_ROLE"
  printf 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %s;\n' "$APP_ROLE"
  # the deploy's own migration bookkeeping is not application data: READ-only, so /ready can see whether this release's
  # migrations are applied (Stage 14.5); never written by the runtime role
  printf 'REVOKE ALL ON TABLE schema_migrations FROM %s;\n' "$APP_ROLE"
  printf 'GRANT SELECT ON TABLE schema_migrations TO %s;\n' "$APP_ROLE"
  printf 'ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %s;\n' "$PGUSER" "$APP_ROLE"
  printf 'ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %s;\n' "$PGUSER" "$APP_ROLE"
} | psql_stdin

# ---------------------------------------------------------------- application environment
log "ensuring $APP_ENV (existing values are never overwritten, except below)"
touch "$APP_ENV"; chmod 600 "$APP_ENV"
b64() { openssl rand -base64 32; }
ensure "$APP_ENV" NODE_ENV production
RUNTIME_DB_URL="postgres://$APP_ROLE:$APP_PASS@$DB:5432/$PGDB"
if grep -q "^DATABASE_URL=postgres://$PGUSER:" "$APP_ENV"; then
  # The one value this script ever rewrites: an existing install that still runs as the database OWNER (before Stage 14.3)
  # is moved to the runtime role. Any other DATABASE_URL an operator set is left alone.
  tmp=$(mktemp "$DIR/.env.XXXXXX")
  grep -v '^DATABASE_URL=' "$APP_ENV" >"$tmp" || true
  printf 'DATABASE_URL=%s\n' "$RUNTIME_DB_URL" >>"$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$APP_ENV"
  log "  ~ DATABASE_URL (moved from the database owner to the runtime role $APP_ROLE)"
fi
ensure "$APP_ENV" DATABASE_URL "$RUNTIME_DB_URL"
ensure "$APP_ENV" JWT_SECRET "$(b64)"
ensure "$APP_ENV" OPERATOR_CODE_PEPPER "$(b64)"
ensure "$APP_ENV" SECRET_KEY_PEPPER "$(b64)"
ensure "$APP_ENV" THROTTLE_KEY_PEPPER "$(b64)"
ensure "$APP_ENV" JOIN_CODE_PEPPER "$(b64)"
ensure "$APP_ENV" TOTP_ENCRYPTION_KEYS "k1:$(b64)"
ensure "$APP_ENV" TOTP_ENCRYPTION_ACTIVE_KEY_ID k1
ensure "$APP_ENV" PAYMENT_SERVICE_TOKEN "$(openssl rand -hex 32)"
# NOTE: WebAuthn origins are the *browser* origins that talk to this API (the admin front-end),
# and must be edited here once that front-end is wired (https only, comma-separated).
ensure "$APP_ENV" WEBAUTHN_RP_ID "${WEBAUTHN_RP_ID:-hsalem-anwar.dev}"
ensure "$APP_ENV" WEBAUTHN_ORIGINS "${WEBAUTHN_ORIGINS:-https://$HOST_RULE}"
ensure "$APP_ENV" WEBAUTHN_RP_NAME Nawara
ensure "$APP_ENV" PAYMENT_SERVICE_URL "${PAYMENT_SERVICE_URL:-http://nawara-core-payment-service:3000}"
ensure "$APP_ENV" TRUST_PROXY true
ensure "$APP_ENV" AUTH_EVENTS off
# Stage 18.7.5: the audit relay's broker (AUTH_EVENTS=off above still disables only the legacy fire-and-forget events).
[ -n "${RABBITMQ_URL:-}" ] && ensure "$APP_ENV" RABBITMQ_URL "$RABBITMQ_URL"
ensure "$APP_ENV" WORK_TIMEZONE Africa/Tunis
# No channel delivers verification codes yet, so it stays off in production until one exists.
ensure "$APP_ENV" REQUIRE_CONTACT_VERIFICATION false
# Swagger UI at /auth/docs (basic auth). Read the password on the server:  grep ^SWAGGER_ "$APP_ENV"
ensure "$APP_ENV" SWAGGER_USERNAME docs
ensure "$APP_ENV" SWAGGER_PASSWORD "$(openssl rand -hex 24)"

# ---------------------------------------------------------------- application container
PREV=""
if exists "$APP"; then
  PREV="$APP-previous-$(date +%Y%m%d%H%M%S)"
  log "stopping current $APP and keeping it as $PREV (not deleted)"
  # Stage 15.5: an explicit stop grace (not Docker's 10 s default). A Core service's graceful shutdown is bounded at about 40 s by its own
  # settings (HTTP drain 5 s, worker drain 5 s, broker closes ~3 x RABBITMQ_HEARTBEAT_S, database DB_QUERY_TIMEOUT_MS); 60 s leaves a margin.
  docker stop -t 60 "$APP" >/dev/null
  docker rename "$APP" "$PREV"
fi

log "starting $APP from $IMAGE"
docker run -d --name "$APP" --restart unless-stopped --stop-timeout 60 --network "$NET" --env-file "$APP_ENV" \
  --label traefik.enable=true \
  --label "traefik.http.routers.$APP.rule=Host(\`$HOST_RULE\`) && PathPrefix(\`/auth\`)" \
  --label "traefik.http.routers.$APP.entrypoints=websecure" \
  --label "traefik.http.routers.$APP.tls.certresolver=le" \
  --label "traefik.http.services.$APP.loadbalancer.server.port=3000" \
  --health-cmd 'wget -qO- http://127.0.0.1:3000/auth/health >/dev/null || exit 1' \
  --health-interval 15s --health-timeout 5s --health-retries 3 --health-start-period 15s \
  "$IMAGE" >/dev/null

ok=""
for _ in $(seq 1 30); do
  st=$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$APP")
  [ "$st" = running/healthy ] && { ok=1; break; }
  [ "${st%%/*}" = running ] || break
  sleep 3
done

if [ -z "$ok" ]; then
  log "new container did not become healthy (state: $st); last logs follow"
  docker logs --tail 40 "$APP" >&2 || true
  docker rm -f "$APP" >/dev/null 2>&1 || true
  if [ -n "$PREV" ]; then log "rolling back to $PREV"; docker rename "$PREV" "$APP"; docker start "$APP" >/dev/null; fi
  die "deploy failed"
fi

log "OK  $APP is running/healthy"
[ -z "$PREV" ] || log "previous container kept stopped as $PREV; remove it manually once satisfied"
docker ps --filter "name=nawara-core-auth" --format '  {{.Names}}\t{{.Status}}\t{{.Image}}'
log "env var names configured: $(sed 's/=.*//' "$APP_ENV" | tr '\n' ' ')"
