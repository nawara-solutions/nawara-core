#!/usr/bin/env bash
# Registers ONE service caller of organization-service (Stage 21.x G1.C; ADR-0040 A2.5). An explicit operator step, never part of a
# deploy. Runs ON THE SERVER, streamed out of the organization-service image:
#
#   docker run --rm --entrypoint cat "$IMAGE" deploy/register-caller.sh | CALLER=provisioning CONFIRM="register provisioning" bash -s
#
# The two callers and the fresh-path step that registers each:
#   provisioning   F1: the dedicated provisioning identity (hierarchy.provision alone, outside Platform scope; the F2 first Company)
#   auth-service   F4: Auth's read credential (hierarchy.read, no Platform yet: the Company read that `ensure` needs)
# Registering a caller token is itself a cutover step (in a fresh environment the credentials are registered before activation,
# A2.6); it is never done implicitly, and a registered token is never rotated here (that is a deliberate separate operation).
#
# Effect: a new random token in callers/<caller>.token (0600, server-side only, never printed), then SERVICE_TOKENS (sha-256 digests)
# and SERVICE_POLICY in .env are rebuilt from every registered caller. Nothing is restarted: the next organization-service deploy loads
# the new configuration (and, for auth-service, the next Auth deploy hands Auth its token). Nothing is ever activated.
set -euo pipefail
umask 077

DIR="${DEPLOY_DIR:-$HOME/nawara-core/organization-service}"
APP_ENV="$DIR/.env"
CALLERS="$DIR/callers"

log() { printf '[register-caller] %s\n' "$*"; }
die() { printf '[register-caller] ERROR: %s\n' "$*" >&2; exit 1; }

# The only callers and their exact, least-privilege policies (apps/organization-service/src/authorization/service-policy.ts).
policy_for() {
  case "$1" in
    provisioning) printf '{"capabilities":["hierarchy.provision"]}' ;;
    auth-service) printf '{"capabilities":["hierarchy.read"],"allowedPlatforms":[]}' ;;
    *) return 1 ;;
  esac
}

: "${CALLER:?CALLER is required (provisioning | auth-service)}"
policy_for "$CALLER" >/dev/null || die "unknown caller '$CALLER' (known: provisioning auth-service); nothing was changed"
[ "${CONFIRM:-}" = "register $CALLER" ] || die "CONFIRM must be exactly \"register $CALLER\"; nothing was changed"
[ -f "$APP_ENV" ] || die "$APP_ENV is missing: deploy organization-service first; nothing was changed"
command -v openssl >/dev/null || die "openssl is required; nothing was changed"
command -v sha256sum >/dev/null || die "sha256sum is required; nothing was changed"
mkdir -p "$CALLERS"; chmod 700 "$CALLERS"
for f in "$CALLERS"/*.token; do
  [ -e "$f" ] || continue
  c=$(basename "$f" .token)
  policy_for "$c" >/dev/null || die "unexpected caller file $f; refusing to guess its policy; nothing was changed"
done

token_file="$CALLERS/$CALLER.token"
if [ -f "$token_file" ]; then
  log "$CALLER is already registered (its token is kept; rotation is a separate, deliberate operation); re-converging the configuration"
else
  tmp=$(mktemp "$CALLERS/.token.XXXXXX")
  openssl rand -hex 32 >"$tmp"
  chmod 600 "$tmp"; mv -f "$tmp" "$token_file"
  log "  + $CALLER token generated (server-side, $token_file, never printed)"
fi

# Rebuild SERVICE_TOKENS / SERVICE_POLICY from every registered caller (deterministic order).
tokens=""; policy=""
for f in "$CALLERS"/*.token; do
  [ -e "$f" ] || continue
  c=$(basename "$f" .token)
  digest=$(tr -d '\n' <"$f" | sha256sum | cut -d' ' -f1)
  [[ $digest =~ ^[0-9a-f]{64}$ ]] || die "could not digest $c's token; nothing was changed"
  tokens="${tokens:+$tokens,}$c:$digest"
  policy="${policy:+$policy,}\"$c\":$(policy_for "$c")"
done
policy="{\"callers\":{$policy}}"

tmp=$(mktemp "$DIR/.env.XXXXXX")
{ grep -vE '^(SERVICE_TOKENS|SERVICE_POLICY)=' "$APP_ENV" || true; printf 'SERVICE_TOKENS=%s\nSERVICE_POLICY=%s\n' "$tokens" "$policy"; } >"$tmp"
chmod 600 "$tmp"; mv -f "$tmp" "$APP_ENV"
log "OK  registered callers: $(for f in "$CALLERS"/*.token; do [ -e "$f" ] && basename "$f" .token; done | tr '\n' ' ')"
log "    next: redeploy organization-service (organization-service-deploy.yml) to load them"
[ "$CALLER" != auth-service ] || log "    then (F4) redeploy auth-service so it receives ORGANIZATION_SERVICE_URL / ORGANIZATION_SERVICE_TOKEN"
