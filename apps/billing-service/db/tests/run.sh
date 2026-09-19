#!/usr/bin/env bash
# Applies the kit's migrations plus db/migrations/*.sql (in order) to throwaway databases and runs the invariant suite and the
# concurrency races. Needs a reachable PostgreSQL >= 16 (psql/createdb on PATH); the connection comes from the usual
# PGHOST/PGPORT/PGUSER/PGPASSWORD variables. Every scratch database is dropped on exit.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mig="$here/../migrations"
kitmig="$here/../../../../libs/service-kit/migrations"
pid=$$
dbs=()
# Sets $DBNAME (not `echo`, which callers would capture in a subshell: array additions made there are lost, so the cleanup trap would
# never see the database and every run would leak it).
newdb() { DBNAME="billing_${1}_${pid}"; dbs+=("$DBNAME"); createdb "$DBNAME"; }
cleanup() { for d in "${dbs[@]:-}"; do [ -n "$d" ] && dropdb --if-exists "$d" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT
apply_all() { for f in "$kitmig"/*.sql "$mig"/[0-9]*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$1" -f "$f"; done; }
fail() { echo "FAIL: $*"; exit 1; }
q() { psql -Atq -v ON_ERROR_STOP=1 -d "$db" -c "$1"; }

echo "== schema-level invariants BI-01 .. BI-21 (all migrations)"
newdb inv; db="$DBNAME"; apply_all "$db"
(cd "$here" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f invariants.sql)
echo "PASS: invariants.sql"

# ---- races: separate connections, real contention -------------------------------------------------------------------------
racers=8
run_racers() { # $1 = SQL each racer runs; results in $outdir/N.out
  outdir="$(mktemp -d)"
  for i in $(seq 1 "$racers"); do ( psql -Atq -d "$db" >"$outdir/$i.out" 2>&1 -c "$1" ) & done
  wait
}

echo "== concurrency: $racers simultaneous issues for ONE seller get $racers distinct numbers (invoice, then counter)"
newdb issue; db="$DBNAME"; apply_all "$db"; psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$here/fixtures.sql" >/dev/null
ids=$(q "SELECT string_agg(t_mk_invoice()::text, ',') FROM generate_series(1, $racers)")
outdir="$(mktemp -d)"
n=0; for id in ${ids//,/ }; do n=$((n+1)); ( psql -Atq -d "$db" >"$outdir/$n.out" 2>&1 -c "SELECT t_try_issue('$id')" ) & done; wait
distinct=$(q "SELECT count(DISTINCT number) FROM invoice WHERE number IS NOT NULL")
mx=$(q "SELECT max(number::bigint) FROM invoice")
errs=$(cat "$outdir"/*.out | grep -ciE "error|deadlock" || true); rm -rf "$outdir"
[ "$distinct" -eq "$racers" ] && [ "$mx" -eq "$racers" ] && [ "$errs" -eq 0 ] || fail "parallel issues: distinct=$distinct max=$mx errors=$errs (want $racers, $racers, 0)"
echo "PASS: race — $racers parallel issues gave $racers distinct consecutive numbers, no deadlock"

echo "== concurrency: the SAME draft issued by $racers callers at once is issued exactly once"
inv=$(q "SELECT t_mk_invoice()")
run_racers "SELECT t_try_issue('$inv')"
won=$(cat "$outdir"/*.out | grep -c '^t$' || true); rm -rf "$outdir"
[ "$won" -eq 1 ] && [ "$(q "SELECT revision FROM invoice WHERE id = '$inv'")" -eq 1 ] || fail "one draft, $racers issuers: winners=$won (want 1)"
echo "PASS: race — exactly one of $racers concurrent transitions took effect (revision 1)"

echo "== concurrency: $racers concurrent creates with the same (producer, invoiceRequestId) give exactly one invoice"
newdb dup; db="$DBNAME"; apply_all "$db"; psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$here/fixtures.sql" >/dev/null
req="00000000-0000-4000-8000-0000000000d1"
run_racers "SELECT t_mk_invoice('user', 'user-1', 2, 1000, '$req'::uuid)"
ok=$(grep -L "invoice_request_unique" "$outdir"/*.out | wc -l); rows=$(q "SELECT count(*) FROM invoice WHERE \"invoiceRequestId\" = '$req'"); rm -rf "$outdir"
[ "$ok" -eq 1 ] && [ "$rows" -eq 1 ] || fail "duplicate creates: ok=$ok rows=$rows (want 1, 1)"
echo "PASS: race — $racers concurrent identical creates gave exactly one invoice row"

echo "== concurrency: $racers concurrent payment requests for one open invoice give exactly one active request"
newdb req; db="$DBNAME"; apply_all "$db"; psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$here/fixtures.sql" >/dev/null
inv=$(q "SELECT t_mk_open()")
run_racers "SELECT t_mk_request('$inv')"
ok=$(grep -L "payment_request_one_active" "$outdir"/*.out | wc -l); active=$(q "SELECT count(*) FROM payment_request WHERE \"invoiceId\" = '$inv' AND status IN ('created','sending','requested')"); rm -rf "$outdir"
[ "$ok" -eq 1 ] && [ "$active" -eq 1 ] || fail "concurrent payment requests: ok=$ok active=$active (want 1, 1)"
echo "PASS: race — one active payment request survives $racers concurrent creations"

echo "== concurrency: duplicate payment success x$racers applies once; success vs cancel races end in ONE terminal state"
newdb apply; db="$DBNAME"; apply_all "$db"; psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$here/fixtures.sql" >/dev/null
read -r inv req < <(psql -Atq -F ' ' -d "$db" -c "SELECT inv, req FROM t_mk_requested()")
run_racers "SELECT t_apply_terminal('$inv', '$req', 'paid')"
applied=$(cat "$outdir"/*.out | grep -c 'applied:paid' || true); errs=$(cat "$outdir"/*.out | grep -ciE "error|deadlock" || true); rm -rf "$outdir"
inv_status=$(q "SELECT status || ':' || revision FROM invoice WHERE id = '$inv'")
[ "$applied" -eq 1 ] && [ "$errs" -eq 0 ] && [ "$inv_status" = "paid:2" ] || fail "duplicate success: applied=$applied errors=$errs invoice=$inv_status (want 1, 0, paid:2)"
read -r inv req < <(psql -Atq -F ' ' -d "$db" -c "SELECT inv, req FROM t_mk_requested()")
outdir="$(mktemp -d)"
for i in 1 2 3 4; do ( psql -Atq -d "$db" >"$outdir/s$i.out" 2>&1 -c "SELECT t_apply_terminal('$inv', '$req', 'paid')" ) & ( psql -Atq -d "$db" >"$outdir/c$i.out" 2>&1 -c "SELECT t_apply_terminal('$inv', '$req', 'cancelled')" ) & done; wait
applied=$(cat "$outdir"/*.out | grep -c 'applied:' || true); errs=$(cat "$outdir"/*.out | grep -ciE "error|deadlock" || true); rm -rf "$outdir"
rstat=$(q "SELECT status FROM payment_request WHERE id = '$req'"); istat=$(q "SELECT status FROM invoice WHERE id = '$inv'")
{ [ "$applied" -eq 1 ] && [ "$errs" -eq 0 ] && { { [ "$rstat" = paid ] && [ "$istat" = paid ]; } || { [ "$rstat" = cancelled ] && [ "$istat" = open ]; }; }; } \
  || fail "success vs cancel: applied=$applied errors=$errs request=$rstat invoice=$istat (want exactly one terminal state, consistent)"
echo "PASS: race — payment success x$racers applied once; success vs cancel ended $rstat/$istat with no deadlock"
