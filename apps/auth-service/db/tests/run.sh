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

echo "== M5: migration 0004 backfills an ACTIVE membership for every existing member =="
db="$(newdb mig4)"
for f in "$mig"/0001_*.sql "$mig"/0002_*.sql "$mig"/0003_*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$f" || fail "M5: could not apply $f"; done
psql -q -v ON_ERROR_STOP=1 -d "$db" <<'SQL'
INSERT INTO company(id,name) VALUES ('00000000-0000-0000-0000-0000000000c1','Nawara');
INSERT INTO platform(id,"companyId",name) VALUES ('00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-0000000000c1','School');
INSERT INTO organization(id,"platformId",name) VALUES ('00000000-0000-0000-0000-00000000b00a','00000000-0000-0000-0000-00000000a001','School A');
INSERT INTO "user"(id,kind,email,"passwordHash",role,"organizationId") VALUES
  ('00000000-0000-0000-0000-0000000000a1','member','m1@x.io','pw','student','00000000-0000-0000-0000-00000000b00a'),
  ('00000000-0000-0000-0000-0000000000a2','member','m2@x.io','pw','teacher','00000000-0000-0000-0000-00000000b00a');
SQL
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/0004_organization_join_codes_and_membership.sql" || fail "M5: 0004 did not apply on a database with data"
[ "$(psql -Atq -d "$db" -c "SELECT count(*) FROM organization_membership WHERE status='active' AND \"approvedBy\" IS NULL AND \"joinCodeId\" IS NULL AND \"isOrganizationAdmin\" = false")" = 2 ] || fail "M5: every existing member must get one active, non-admin membership"
[ "$(psql -Atq -d "$db" -c "SELECT count(*) FROM \"user\" WHERE kind='member'")" = 2 ] || fail "M5: existing users must survive"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/down/0004_organization_join_codes_and_membership.down.sql" || fail "M5: rollback must succeed when only backfilled rows exist"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/0004_organization_join_codes_and_membership.sql" || fail "M5: re-apply after rollback"
echo "PASS: M5 backfill gives every existing member an active membership; rollback then re-apply round-trips"
# rollback must REFUSE to destroy real onboarding data
psql -q -v ON_ERROR_STOP=1 -d "$db" -c "INSERT INTO organization_join_code(\"organizationId\",\"platformId\",\"codeHash\",audience,\"requiresApproval\",\"requiresSubscription\",\"createdBy\") SELECT '00000000-0000-0000-0000-00000000b00a','00000000-0000-0000-0000-00000000a001',repeat('a',64),'student',false,true,id FROM \"user\" LIMIT 1"
if psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/down/0004_organization_join_codes_and_membership.down.sql" >/dev/null 2>&1; then fail "M5: rollback must refuse when join codes exist"; fi
echo "PASS: M6 rollback refuses to destroy join codes"

echo "== M7: migration 0005 applies on a database with data; rollback refuses to destroy invitations =="
db="$(newdb mig5)"
for f in "$mig"/0001_*.sql "$mig"/0002_*.sql "$mig"/0003_*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$f" || fail "M7: could not apply $f"; done
psql -q -v ON_ERROR_STOP=1 -d "$db" <<'SQL'
INSERT INTO company(id,name) VALUES ('00000000-0000-0000-0000-0000000000c1','Nawara');
INSERT INTO platform(id,"companyId",name) VALUES ('00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-0000000000c1','School');
INSERT INTO organization(id,"platformId",name) VALUES ('00000000-0000-0000-0000-00000000b00a','00000000-0000-0000-0000-00000000a001','School A');
INSERT INTO "user"(id,kind,email,"passwordHash",role,"organizationId") VALUES ('00000000-0000-0000-0000-0000000000a1','member','m1@x.io','pw','student','00000000-0000-0000-0000-00000000b00a');
SQL
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/0004_organization_join_codes_and_membership.sql" || fail "M7: 0004 did not apply on a database with data"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/0005_organization_admin_invitations.sql" || fail "M7: 0005 did not apply on a database with data"
[ "$(psql -Atq -d "$db" -c "SELECT count(*) FROM organization_membership WHERE status='active' AND \"invitationId\" IS NULL")" = 1 ] || fail "M7: existing memberships must survive with no invitation"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/down/0005_organization_admin_invitations.down.sql" || fail "M7: rollback must succeed while empty"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/0005_organization_admin_invitations.sql" || fail "M7: re-apply after rollback"
echo "PASS: M7 applies on data, and rollback then re-apply round-trips"
psql -q -v ON_ERROR_STOP=1 -d "$db" -c "INSERT INTO organization_admin_invitation(\"organizationId\",\"platformId\",\"codeHash\",\"invitationType\",\"expiresAt\",\"createdBy\") VALUES ('00000000-0000-0000-0000-00000000b00a','00000000-0000-0000-0000-00000000a001',repeat('a',64),'org_admin',now()+interval '1 day','00000000-0000-0000-0000-0000000000a1')"
if psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/down/0005_organization_admin_invitations.down.sql" >/dev/null 2>&1; then fail "M7: rollback must refuse when invitations exist"; fi
echo "PASS: M8 rollback refuses to destroy invitations"

echo "== M9: migrations 0006+0007 move the label to the membership, keep every membership, and round-trip =="
db="$(newdb mig7)"
for f in "$mig"/0001_*.sql "$mig"/0002_*.sql "$mig"/0003_*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$f" || fail "M9: could not apply $f"; done
psql -q -v ON_ERROR_STOP=1 -d "$db" <<'SQL'
INSERT INTO company(id,name) VALUES ('00000000-0000-0000-0000-0000000000c1','Nawara');
INSERT INTO platform(id,"companyId",name) VALUES ('00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-0000000000c1','P');
INSERT INTO organization(id,"platformId",name) VALUES ('00000000-0000-0000-0000-00000000b00a','00000000-0000-0000-0000-00000000a001','Org A');
INSERT INTO "user"(id,kind,email,"passwordHash",role,"organizationId") VALUES
  ('00000000-0000-0000-0000-0000000000a1','member','m1@x.io','pw','teacher','00000000-0000-0000-0000-00000000b00a'),
  ('00000000-0000-0000-0000-0000000000a2','member','m2@x.io','pw','student','00000000-0000-0000-0000-00000000b00a');
SQL
for f in "$mig"/0004_*.sql "$mig"/0005_*.sql "$mig"/0006_*.sql "$mig"/0007_*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$f" || fail "M9: could not apply $f on a database with data"; done
[ "$(psql -Atq -d "$db" -c "SELECT string_agg(audience, ',' ORDER BY audience) FROM organization_membership")" = "student,teacher" ] || fail "M9: the old role label must move to the membership audience"
[ "$(psql -Atq -d "$db" -c "SELECT string_agg(DISTINCT role, ',') FROM \"user\"")" = "member" ] || fail "M9: members must end with the neutral role"
[ "$(psql -Atq -d "$db" -c "SELECT count(*) FROM information_schema.columns WHERE table_name='user' AND column_name='organizationId'")" = 0 ] || fail "M9: user.organizationId must be gone"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/down/0007_multi_organization_membership.down.sql" || fail "M9: rollback of 0007 must succeed with one membership per user"
[ "$(psql -Atq -d "$db" -c "SELECT string_agg(role, ',' ORDER BY role) FROM \"user\"")" = "student,teacher" ] || fail "M9: rollback must restore the role label"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/0007_multi_organization_membership.sql" || fail "M9: re-apply after rollback"
echo "PASS: M9 label moves to the membership, memberships are kept, rollback then re-apply round-trips"

echo "== M10: rollback of 0007 refuses when the multi-organization model is in use =="
psql -q -v ON_ERROR_STOP=1 -d "$db" -c "INSERT INTO organization(id,\"platformId\",name) VALUES ('00000000-0000-0000-0000-00000000b00b','00000000-0000-0000-0000-00000000a001','Org B'); INSERT INTO organization_membership(\"userId\",\"organizationId\",status,audience) VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000b00b','pending','coach')"
if psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/down/0007_multi_organization_membership.down.sql" >/dev/null 2>&1; then fail "M10: rollback must refuse when a user has two memberships"; fi
psql -q -v ON_ERROR_STOP=1 -d "$db" -c "DELETE FROM organization_membership WHERE FALSE" >/dev/null
echo "PASS: M10 rollback refuses when a user has more than one membership"

echo "== M11: migration 0009 relaxes member membership to [0..N]; rollback refuses while a zero-membership member exists =="
db="$(newdb mig9)"; apply_all "$db"
psql -q -v ON_ERROR_STOP=1 -d "$db" -c "INSERT INTO company(id,name) VALUES ('00000000-0000-0000-0000-0000000000c1','Nawara')"
psql -q -v ON_ERROR_STOP=1 -d "$db" -c "INSERT INTO \"user\"(id,kind,email,\"passwordHash\",role) VALUES ('00000000-0000-0000-0000-0000000000f1','member','flow@x.io','pw','member')" \
  || fail "M11: a member with zero memberships must be insertable after 0009"
[ "$(psql -Atq -d "$db" -c "SELECT count(*) FROM organization_membership WHERE \"userId\"='00000000-0000-0000-0000-0000000000f1'")" = 0 ] || fail "M11: the new member must have zero memberships"
echo "PASS: M11a a member with zero memberships can be created once 0009 is applied"
if psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/down/0009_member_zero_membership.down.sql" >/dev/null 2>&1; then fail "M11: rollback of 0009 must refuse while a zero-membership member exists"; fi
echo "PASS: M11b rollback of 0009 refuses while a zero-membership member exists"
psql -q -v ON_ERROR_STOP=1 -d "$db" -c "DELETE FROM \"user\" WHERE id='00000000-0000-0000-0000-0000000000f1'"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/down/0009_member_zero_membership.down.sql" || fail "M11: rollback of 0009 must succeed once no zero-membership member exists"
if psql -q -v ON_ERROR_STOP=1 -d "$db" -c "INSERT INTO \"user\"(id,kind,email,\"passwordHash\",role) VALUES ('00000000-0000-0000-0000-0000000000f2','member','flow2@x.io','pw','member')" >/dev/null 2>&1; then fail "M11: after rollback, a member with zero memberships must be refused again"; fi
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/0009_member_zero_membership.sql" || fail "M11: re-apply after rollback"
echo "PASS: M11c rollback then re-apply round-trips, and the [1..N] rule is restored while rolled back"

