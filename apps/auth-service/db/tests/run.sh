#!/usr/bin/env bash
# Applies db/migrations/*.sql (in order) to throwaway databases and runs the invariant suites.
# Needs a reachable PostgreSQL >= 14 (psql/createdb on PATH); connection comes from the usual
# PGHOST/PGPORT/PGUSER/PGPASSWORD env vars. Every scratch database is dropped on exit.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mig="$here/../migrations"
pid=$$
dbs=()
newdb() { local d="auth_${1}_${pid}"; dbs+=("$d"); createdb "$d"; echo "$d"; }
cleanup() { for d in "${dbs[@]:-}"; do [ -n "$d" ] && dropdb --if-exists "$d" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT
apply_all() { for f in "$mig"/[0-9]*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$1" -f "$f"; done; }
fail() { echo "FAIL: $*"; exit 1; }

echo "== schema-level invariants (all migrations) =="
db="$(newdb inv)"; apply_all "$db"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$here/invariants.sql"

echo "== N: concurrent grants for one (operator, platform) =="
db="$(newdb race)"; apply_all "$db"
psql -q -v ON_ERROR_STOP=1 -d "$db" <<'SQL'
INSERT INTO company(id,name) VALUES ('00000000-0000-0000-0000-0000000000c1','Nawara');
INSERT INTO platform(id,"companyId",name) VALUES ('00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-0000000000c1','School');
WITH o AS (INSERT INTO "user"(id,kind,email,"passwordHash",role) VALUES ('00000000-0000-0000-0000-0000000000e1','owner','o@x.io','pw','admin') RETURNING id),
     p AS (INSERT INTO "user"(id,kind,email,role) VALUES ('00000000-0000-0000-0000-0000000000e2','operator','p@x.io','admin') RETURNING id),
     a AS (INSERT INTO owner("userId","companyId") SELECT id,'00000000-0000-0000-0000-0000000000c1' FROM o)
INSERT INTO operator("userId","companyId") SELECT id,'00000000-0000-0000-0000-0000000000c1' FROM p;
SQL
racers=12
outdir="$(mktemp -d)"
for i in $(seq 1 "$racers"); do
  ( psql -q -v ON_ERROR_STOP=1 -d "$db" >"$outdir/$i.out" 2>&1 <<'SQL'
BEGIN;
-- Every racer first does the "check -> none found" step, exactly like a naive service would.
SELECT count(*) FROM platform_assignment WHERE "operatorId"='00000000-0000-0000-0000-0000000000e2' AND "platformId"='00000000-0000-0000-0000-00000000a001' AND active;
SELECT pg_sleep(0.3);
INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy")
  VALUES ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000e1');
COMMIT;
SQL
  ) &
done
wait
ok=$(grep -L "unique constraint" "$outdir"/*.out | wc -l)
dup=$(grep -l "platform_assignment_one_active" "$outdir"/*.out | wc -l)
active=$(psql -Atq -d "$db" -c "SELECT count(*) FROM platform_assignment WHERE active")
echo "racers=$racers succeeded=$ok rejected_by_unique_index=$dup active_rows=$active"
rm -rf "$outdir"
[ "$ok" -eq 1 ] && [ "$dup" -eq $((racers-1)) ] && [ "$active" -eq 1 ] || fail "N (concurrent assignment)"
echo "PASS: N"

echo "== M: migration 0002 safety (detect, report, abort; explicit ack; rollback) =="
db="$(newdb mig)"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/0001_identity_tenancy_platform_assignment.sql"
psql -q -v ON_ERROR_STOP=1 -d "$db" <<'SQL'
INSERT INTO company(id,name) VALUES ('00000000-0000-0000-0000-0000000000c1','Nawara');
INSERT INTO platform(id,"companyId",name) VALUES ('00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-0000000000c1','School');
INSERT INTO organization(id,"platformId",name) VALUES ('00000000-0000-0000-0000-00000000b00a','00000000-0000-0000-0000-00000000a001','School A');
INSERT INTO "user"(id,kind,email,"passwordHash",role,"organizationId","trialEndsAt") VALUES ('00000000-0000-0000-0000-0000000000a1','member','m@x.io','pw','student','00000000-0000-0000-0000-00000000b00a', now()+interval '30 days');
WITH u AS (INSERT INTO "user"(id,kind,email,role) VALUES ('00000000-0000-0000-0000-0000000000b1','operator','op@x.io','admin') RETURNING id)
INSERT INTO operator("userId","companyId") SELECT id,'00000000-0000-0000-0000-0000000000c1' FROM u;
-- legacy-shaped violations: plaintext 6-digit code hash, operator token without a session ceiling
INSERT INTO admin_operator_code("userId",purpose,"codeHash","expiresAt") VALUES ('00000000-0000-0000-0000-0000000000b1','login','123456',now()+interval '1 hour');
INSERT INTO refresh_token("userId","tokenHash","familyId","expiresAt") VALUES ('00000000-0000-0000-0000-0000000000b1','t1',gen_random_uuid(),now()+interval '1 hour');
SQL
out="$(psql -q -d "$db" -f "$mig/0002_owner_operator_hardening_and_owner_step_up.sql" 2>&1 || true)"
for needle in "0002 refused" "trialEndsAt" "codeHash" "sessionExpiresAt"; do
  echo "$out" | grep -q "$needle" || fail "M: preflight report is missing '$needle'"
done
[ "$(psql -Atq -d "$db" -c "SELECT count(*) FROM information_schema.columns WHERE table_name='user' AND column_name='trialEndsAt'")" = 1 ] \
  || fail "M: a refused migration must leave the schema untouched"
echo "PASS: M1 refuses with a full report and changes nothing"
psql -q -d "$db" -c "DELETE FROM admin_operator_code; DELETE FROM refresh_token;"
out="$(psql -q -d "$db" -f "$mig/0002_owner_operator_hardening_and_owner_step_up.sql" 2>&1 || true)"
echo "$out" | grep -q "trialEndsAt" || fail "M: trialEndsAt data must still block without an explicit acknowledgement"
echo "PASS: M2 trialEndsAt data blocks the drop until acknowledged"
psql -q -v ON_ERROR_STOP=1 -d "$db" <<SQL
SET auth.ack_trial_ends_at_moved = 'on';
\i $mig/0002_owner_operator_hardening_and_owner_step_up.sql
SQL
[ "$(psql -Atq -d "$db" -c "SELECT count(*) FROM information_schema.columns WHERE table_name='user' AND column_name='trialEndsAt'")" = 0 ] || fail "M: acknowledged migration should drop trialEndsAt"
[ "$(psql -Atq -d "$db" -c "SELECT count(*) FROM \"user\"")" = 2 ] || fail "M: existing users must survive the migration"
echo "PASS: M3 acknowledged migration succeeds and preserves existing rows"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/down/0002_owner_operator_hardening_and_owner_step_up.down.sql"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/0002_owner_operator_hardening_and_owner_step_up.sql"
echo "PASS: M4 rollback then re-apply round-trips"
