#!/usr/bin/env bash
# Smoke-checks one built Core service image (Stage 14.2):  scripts/smoke-core-image.sh <service> <image>
#
# Starts the image with its PRODUCTION configuration (NODE_ENV=production, every required setting present and valid;
# secrets are random, generated here, never printed and never baked into an image) and proves:
#   1. the process runs as a non-root user;
#   2. the application boots and `GET /health` (process liveness, which touches no dependency) answers 200;
#   3. the process is still alive, and still live, a few seconds later (no crash after boot);
#   4. `GET /ready` is wired and answers 200 or 503. It is NOT required to pass: readiness depends on the database and its
#      migrations, which this smoke deliberately does not provision (the /health vs /ready distinction is preserved).
# Needs a RabbitMQ broker on 127.0.0.1:5672 (billing-service's consumer attaches at startup in production). PostgreSQL is
# deliberately unreachable. Uses host networking (Linux, as in CI). Exits non-zero, with the container's log, on any failure.
set -euo pipefail

service="${1:?usage: smoke-core-image.sh <service> <image>}"
image="${2:?usage: smoke-core-image.sh <service> <image>}"
name="smoke-${service}-$$"
port=3000
env_file="$(mktemp)"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -f "$env_file"' EXIT

b64() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
db_url() { echo "postgres://$1:$(hex 16)@127.0.0.1:5432/$2"; } # nothing listens there: liveness must not depend on it

{
  echo "NODE_ENV=production"
  echo "PORT=$port"
  case "$service" in
    auth-service)
      echo "DATABASE_URL=$(db_url auth_app auth)"
      echo "JWT_SECRET=$(b64 48)"
      echo "TOTP_ENCRYPTION_KEYS=k1:$(b64 32)"
      echo "TOTP_ENCRYPTION_ACTIVE_KEY_ID=k1"
      echo "OPERATOR_CODE_PEPPER=$(b64 48)"
      echo "SECRET_KEY_PEPPER=$(b64 48)"
      echo "THROTTLE_KEY_PEPPER=$(b64 48)"
      echo "JOIN_CODE_PEPPER=$(b64 48)"
      echo "WEBAUTHN_RP_ID=smoke.invalid"
      echo "WEBAUTHN_ORIGINS=https://smoke.invalid"
      echo "AUTH_EVENTS=off" # as the production deploy (apps/auth-service/deploy/provision-and-deploy.sh)
      ;;
    billing-service)
      echo "DATABASE_URL=$(db_url billing_app billing)"
      echo "RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672"
      echo "BILLING_SUPPORTED_CURRENCIES=TND"
      echo "AUTH_SERVICE_URL=http://127.0.0.1:9"
      echo "PAYMENT_SERVICE_URL=http://127.0.0.1:9"
      echo "PAYMENT_SERVICE_TOKEN=$(hex 32)"
      ;;
    payment-service)
      echo "DATABASE_URL=$(db_url payment_app payment)"
      echo "RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672"
      echo "AUTH_SERVICE_URL=http://127.0.0.1:9"
      ;;
    organization-service)
      echo "DATABASE_URL=$(db_url organization_app organization)"
      echo "AUTH_SERVICE_URL=http://127.0.0.1:9"
      ;;
    notification-service)
      # Stage 16.3: the foundation has no required setting (no database, broker or provider yet). A registered caller proves the
      # service-token configuration is parsed in production.
      echo "SERVICE_TOKENS=smoke-caller:$(hex 32)"
      ;;
    *)
      echo "unknown service: $service" >&2
      exit 2
      ;;
  esac
} >"$env_file"

fail() {
  echo "SMOKE FAILED ($service): $1" >&2
  echo "--- container log ---" >&2
  docker logs "$name" >&2 2>&1 || true
  exit 1
}

status() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$port$1" || true; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ]; }

docker run -d --name "$name" --network host --env-file "$env_file" "$image" >/dev/null

uid="$(docker exec "$name" id -u 2>/dev/null || true)"
[ -n "$uid" ] || fail "the container exited before it could be inspected"
[ "$uid" != 0 ] || fail "the process runs as root"

live=""
for _ in $(seq 1 30); do
  running || fail "the container exited during startup"
  [ "$(status /health)" = 200 ] && { live=1; break; }
  sleep 1
done
[ -n "$live" ] || fail "GET /health did not answer 200 within 30s"

sleep 5
running || fail "the container exited after startup"
[ "$(status /health)" = 200 ] || fail "GET /health stopped answering 200 after startup"

ready="$(status /ready)"
case "$ready" in
  200 | 503) ;;
  *) fail "GET /ready answered '$ready' (expected 200 or 503)" ;;
esac

echo "SMOKE PASSED ($service): uid=$uid /health=200 (stable) /ready=$ready"
