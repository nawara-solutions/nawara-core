#!/usr/bin/env bash
# Applies the kit's migrations plus db/migrations/*.sql (in order) to throwaway databases and runs the invariant
# suite. Needs a reachable PostgreSQL >= 16 (psql/createdb on PATH); connection comes from the usual
# PGHOST/PGPORT/PGUSER/PGPASSWORD env vars. Every scratch database is dropped on exit.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mig="$here/../migrations"
kitmig="$here/../../../../libs/service-kit/migrations"
pid=$$
dbs=()
# Sets $DBNAME (not `echo`, which callers would capture in a subshell: array additions made there are lost, so the
# cleanup trap would never see the database and every run would leak it).
newdb() { DBNAME="payment_${1}_${pid}"; dbs+=("$DBNAME"); createdb "$DBNAME"; }
cleanup() { for d in "${dbs[@]:-}"; do [ -n "$d" ] && dropdb --if-exists "$d" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT
apply_all() { for f in "$kitmig"/*.sql "$mig"/[0-9]*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$1" -f "$f"; done; }
fail() { echo "FAIL: $*"; exit 1; }

echo "== schema-level invariants (all migrations) =="
newdb inv; db="$DBNAME"; apply_all "$db"
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$here/invariants.sql"
echo "PASS: invariants.sql"

echo "== concurrency: only one open attempt per payment survives a race =="
newdb race; db="$DBNAME"; apply_all "$db"
psql -q -v ON_ERROR_STOP=1 -d "$db" -c "
INSERT INTO payment(id, producer, \"paymentRequestId\", \"sourceType\", \"sourceId\", \"payerType\", \"payerId\", \"sellerType\", \"sellerId\", \"organizationId\", amount, currency)
VALUES ('00000000-0000-0000-0000-000000000001', 'billing-service', gen_random_uuid(), 'invoice', 'inv-1', 'user', 'u1', 'organization', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 1000, 'TND');
"
racers=8
outdir="$(mktemp -d)"
for i in $(seq 1 "$racers"); do
  ( psql -q -d "$db" >"$outdir/$i.out" 2>&1 -c "INSERT INTO payment_attempt(id, \"paymentId\", \"attemptNumber\", provider) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', $i, 'test');" ) &
done
wait
ok=$(grep -L "payment_attempt_one_open" "$outdir"/*.out | wc -l)
open_count=$(psql -Atq -d "$db" -c "SELECT count(*) FROM payment_attempt WHERE \"paymentId\"='00000000-0000-0000-0000-000000000001' AND status IN ('initiated','submitted','unknown')")
rm -rf "$outdir"
[ "$ok" -eq 1 ] && [ "$open_count" -eq 1 ] || fail "one open attempt per payment race: ok=$ok open_count=$open_count (want ok=1 open_count=1)"
echo "PASS: race — one open attempt per payment survives $racers concurrent inserts"

echo "== concurrency: concurrent identical payment creates give exactly one row =="
newdb dup; db="$DBNAME"; apply_all "$db"
reqid="00000000-0000-0000-0000-0000000000d1"
racers=8
outdir="$(mktemp -d)"
for i in $(seq 1 "$racers"); do
  ( psql -q -d "$db" >"$outdir/$i.out" 2>&1 -c "
    INSERT INTO payment(producer, \"paymentRequestId\", \"sourceType\", \"sourceId\", \"payerType\", \"payerId\", \"sellerType\", \"sellerId\", \"organizationId\", amount, currency)
    VALUES ('billing-service', '$reqid', 'invoice', 'inv-1', 'user', 'u1', 'organization', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 1000, 'TND');
  " ) &
done
wait
ok=$(grep -L "payment_request_id_unique" "$outdir"/*.out | wc -l)
row_count=$(psql -Atq -d "$db" -c "SELECT count(*) FROM payment WHERE \"paymentRequestId\"='$reqid'")
rm -rf "$outdir"
[ "$ok" -eq 1 ] && [ "$row_count" -eq 1 ] || fail "concurrent identical creates: ok=$ok row_count=$row_count (want ok=1 row_count=1)"
echo "PASS: race — $racers concurrent identical creates give exactly one payment row"
