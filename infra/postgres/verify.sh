#!/usr/bin/env bash
# Proves the least-privilege setup on a running local compose PostgreSQL (docker compose --profile db up -d --wait postgres).
# Exits non-zero on the first violated expectation. Optional: --with-kit-migrations also applies the service-kit migrations as
# each migrator role and checks the runtime role can use (but not change) the outbox/inbox tables. Needs a built service-kit.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; [ -f .env ] && . ./.env; set +a
: "${POSTGRES_ADMIN_PASSWORD:?}"
PORT=${POSTGRES_LOCAL_PORT:-5433}
fail=0
pass() { echo "  ok    $1"; }
bad() { echo "  FAIL  $1"; fail=1; }
# run SQL as <role>@<db>; prints the psql error (if any) to stdout, empty string on success
sql() { PGPASSWORD="$3" psql -h 127.0.0.1 -p "$PORT" -U "$1" -d "$2" -v ON_ERROR_STOP=1 -qAt -c "$4" 2>&1 || true; }
expect_ok()   { local out; out=$(sql "$2" "$3" "$4" "$5"); if echo "$out" | grep -qiE 'error|denied|fatal'; then bad "$1 (got: ${out%%$'\n'*})"; else pass "$1"; fi; }
expect_reject() { local out; out=$(sql "$2" "$3" "$4" "$5"); if echo "$out" | grep -qi "$6"; then pass "$1"; else bad "$1 (expected an error matching '$6', got: $out)"; fi; }
expect_deny() { local out; out=$(sql "$2" "$3" "$4" "$5"); if echo "$out" | grep -qiE 'permission denied|must be owner|not permitted|no pg_hba|FATAL'; then pass "$1"; else bad "$1 (was allowed: $out)"; fi; }

pw_of() { local v="$1"; echo "${!v}"; }
for svc in billing payment accounting organization notification file; do
  up=$(echo "$svc" | tr a-z A-Z)
  MIG=$(pw_of "${up}_MIGRATOR_PASSWORD"); APP=$(pw_of "${up}_APP_PASSWORD")
  echo "== $svc"
  expect_ok   "migrator can create a table"                         "${svc}_migrator" "$svc" "$MIG" "CREATE TABLE IF NOT EXISTS verify_t(id int PRIMARY KEY, v text)"
  expect_deny "runtime role cannot create a table"                  "${svc}_app"      "$svc" "$APP" "CREATE TABLE app_made(id int)"
  expect_ok   "runtime role can insert and read (default grants)"   "${svc}_app"      "$svc" "$APP" "INSERT INTO verify_t VALUES (1,'x'); SELECT * FROM verify_t"
  expect_ok   "runtime role can update and delete"                  "${svc}_app"      "$svc" "$APP" "UPDATE verify_t SET v='y'; DELETE FROM verify_t"
  expect_deny "runtime role cannot alter a table"                   "${svc}_app"      "$svc" "$APP" "ALTER TABLE verify_t ADD COLUMN c int"
  expect_deny "runtime role cannot drop a table"                    "${svc}_app"      "$svc" "$APP" "DROP TABLE verify_t"
  expect_deny "runtime role cannot truncate"                        "${svc}_app"      "$svc" "$APP" "TRUNCATE verify_t"
  expect_deny "runtime role cannot create a role"                   "${svc}_app"      "$svc" "$APP" "CREATE ROLE evil LOGIN"
  expect_deny "runtime role cannot create a database"               "${svc}_app"      "$svc" "$APP" "CREATE DATABASE evil"
  for other in billing payment accounting organization notification file; do
    [ "$other" = "$svc" ] && continue
    expect_deny "runtime role cannot connect to the $other database"  "${svc}_app"      "$other" "$APP" "SELECT 1"
    expect_deny "migrator cannot connect to the $other database"      "${svc}_migrator" "$other" "$MIG" "SELECT 1"
  done
  sup=$(sql "${svc}_app" "$svc" "$APP" "SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
  [ "$sup" = "f" ] && pass "runtime role is not a superuser" || bad "runtime role superuser flag: $sup"
  sup=$(sql "${svc}_migrator" "$svc" "$MIG" "SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
  [ "$sup" = "f" ] && pass "migrator is not a superuser" || bad "migrator superuser flag: $sup"
  sql "${svc}_migrator" "$svc" "$MIG" "DROP TABLE IF EXISTS verify_t" >/dev/null
done

if [ "${1:-}" = "--with-kit-migrations" ]; then
  echo "== service-kit migrations under least privilege"
  for svc in billing payment accounting organization notification file; do
    up=$(echo "$svc" | tr a-z A-Z); MIG=$(pw_of "${up}_MIGRATOR_PASSWORD"); APP=$(pw_of "${up}_APP_PASSWORD")
    MIGRATION_DATABASE_URL="postgres://${svc}_migrator:${MIG}@127.0.0.1:${PORT}/${svc}" node libs/service-kit/dist/cli/migrate.js >/dev/null \
      && pass "$svc: migrations applied as the migrator" || bad "$svc: migration run failed"
    expect_ok   "$svc: runtime role can enqueue an event"          "${svc}_app" "$svc" "$APP" "INSERT INTO outbox(id,name,payload) VALUES (gen_random_uuid(),'x.created','{}')"
    expect_ok   "$svc: runtime role can stamp delivery bookkeeping" "${svc}_app" "$svc" "$APP" "UPDATE outbox SET attempts = attempts + 1"
    expect_reject "$svc: outbox content stays immutable (trigger)"  "${svc}_app" "$svc" "$APP" "UPDATE outbox SET name = 'y.changed'" "immutable"
    expect_deny "$svc: runtime role cannot alter the outbox table" "${svc}_app" "$svc" "$APP" "ALTER TABLE outbox ADD COLUMN c int"
    expect_ok   "$svc: runtime role can record an inbox row"       "${svc}_app" "$svc" "$APP" "INSERT INTO inbox(\"eventId\",source,name) VALUES (gen_random_uuid(),'s','x.created')"
  done
fi
[ "$fail" = 0 ] && echo "all least-privilege checks passed" || { echo "SOME CHECKS FAILED"; exit 1; }
