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
#   .env    the auth-service environment, names as in apps/auth-service/.env.example
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
log "applying pending migrations from the image"
psql_db -c 'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
for f in $(docker run --rm --entrypoint sh "$IMAGE" -c 'cd db/migrations && ls 0*.sql' | sort); do
  if [ "$(psql_db -tA -c "SELECT count(*) FROM schema_migrations WHERE name='$f'")" = 1 ]; then
    log "  = $f (already applied)"
  else
    log "  > $f"
    docker run --rm --entrypoint cat "$IMAGE" "db/migrations/$f" | psql_stdin
    psql_db -c "INSERT INTO schema_migrations(name) VALUES ('$f')"
  fi
done

# ---------------------------------------------------------------- application environment
log "ensuring $APP_ENV (existing values are never overwritten)"
touch "$APP_ENV"; chmod 600 "$APP_ENV"
b64() { openssl rand -base64 32; }
ensure "$APP_ENV" NODE_ENV production
ensure "$APP_ENV" DATABASE_URL "postgres://$PGUSER:$PGPASS@$DB:5432/$PGDB"
ensure "$APP_ENV" JWT_SECRET "$(b64)"
ensure "$APP_ENV" OPERATOR_CODE_PEPPER "$(b64)"
ensure "$APP_ENV" SECRET_KEY_PEPPER "$(b64)"
ensure "$APP_ENV" THROTTLE_KEY_PEPPER "$(b64)"
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
ensure "$APP_ENV" WORK_TIMEZONE Africa/Tunis

# ---------------------------------------------------------------- application container
PREV=""
if exists "$APP"; then
  PREV="$APP-previous-$(date +%Y%m%d%H%M%S)"
  log "stopping current $APP and keeping it as $PREV (not deleted)"
  docker stop "$APP" >/dev/null
  docker rename "$APP" "$PREV"
fi

log "starting $APP from $IMAGE"
docker run -d --name "$APP" --restart unless-stopped --network "$NET" --env-file "$APP_ENV" \
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
