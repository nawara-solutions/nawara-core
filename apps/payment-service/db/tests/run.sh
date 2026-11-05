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
INSERT INTO payment(id, producer, \"paymentRequestId\", \"sourceType\", \"sourceId\", \"payerType\", \"payerId\", \"sellerType\", \"sellerId\", \"organizationId\", amount, currency, purpose)
VALUES ('00000000-0000-0000-0000-000000000001', 'billing-service', gen_random_uuid(), 'invoice', 'inv-1', 'user', 'u1', 'organization', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 1000, 'TND', 'non_entitlement');
"
racers=8
outdir="$(mktemp -d)"
for i in $(seq 1 "$racers"); do
  ( psql -q -d "$db" >"$outdir/$i.out" 2>&1 -c "INSERT INTO payment_attempt(id, \"paymentId\", \"attemptNumber\", provider) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', $i, 'test');" ) &
done
wait
ok=$(grep -L -E "payment_attempt_one_open|no new attempt while" "$outdir"/*.out | wc -l) # S4c: the uncertainty guard (serialized on the payment row) refuses first
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
    INSERT INTO payment(producer, \"paymentRequestId\", \"sourceType\", \"sourceId\", \"payerType\", \"payerId\", \"sellerType\", \"sellerId\", \"organizationId\", amount, currency, purpose)
    VALUES ('billing-service', '$reqid', 'invoice', 'inv-1', 'user', 'u1', 'organization', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 1000, 'TND', 'non_entitlement');
  " ) &
done
wait
ok=$(grep -L "payment_request_id_unique" "$outdir"/*.out | wc -l)
row_count=$(psql -Atq -d "$db" -c "SELECT count(*) FROM payment WHERE \"paymentRequestId\"='$reqid'")
rm -rf "$outdir"
[ "$ok" -eq 1 ] && [ "$row_count" -eq 1 ] || fail "concurrent identical creates: ok=$ok row_count=$row_count (want ok=1 row_count=1)"
echo "PASS: race — $racers concurrent identical creates give exactly one payment row"

echo "== concurrency: Core V2 S6b — one potentially effective refund attempt per payment survives a race =="
newdb refundrace; db="$DBNAME"; apply_all "$db"
psql -q -v ON_ERROR_STOP=1 -d "$db" -c "
INSERT INTO payment(id, producer, \"paymentRequestId\", \"sourceType\", \"sourceId\", \"payerType\", \"payerId\", \"sellerType\", \"sellerId\", amount, currency, purpose, \"liveMode\")
VALUES ('00000000-0000-0000-0000-0000000006b0', 'billing-service', gen_random_uuid(), 'invoice', 'inv-r', 'user', 'u1', 'company', '00000000-0000-4000-8000-00000000c6b0', 1000, 'TND', 'non_entitlement', false);
INSERT INTO payment_attempt(id, \"paymentId\", \"attemptNumber\", provider, \"liveMode\") VALUES ('00000000-0000-0000-0000-0000000006a0', '00000000-0000-0000-0000-0000000006b0', 1, 'test', false);
UPDATE payment SET status = 'pending' WHERE id = '00000000-0000-0000-0000-0000000006b0';
UPDATE payment_attempt SET status = 'submitted', \"providerTransactionId\" = 'ptx-race', \"submittedAt\" = now() WHERE id = '00000000-0000-0000-0000-0000000006a0';
UPDATE payment_attempt SET status = 'succeeded', \"completedAt\" = now() WHERE id = '00000000-0000-0000-0000-0000000006a0';
INSERT INTO provider_transaction_fact (id, provider, \"providerTxnId\", kind, \"paymentId\", \"attemptId\", amount, currency, \"liveMode\", source)
VALUES ('00000000-0000-0000-0000-0000000006f0', 'test', 'ptx-race', 'capture', '00000000-0000-0000-0000-0000000006b0', '00000000-0000-0000-0000-0000000006a0', 1000, 'TND', false, 'status_check');
UPDATE payment SET status = 'succeeded', \"settledMethod\" = 'gateway', \"succeededAttemptId\" = '00000000-0000-0000-0000-0000000006a0', \"closedAt\" = now() WHERE id = '00000000-0000-0000-0000-0000000006b0';
"
racers=8
outdir="$(mktemp -d)"
for i in $(seq 1 "$racers"); do
  ( psql -q -d "$db" >"$outdir/$i.out" 2>&1 -c "
    INSERT INTO refund_attempt (id, \"paymentId\", producer, \"refundCaseId\", \"companyId\", amount, currency, reason, \"legalOverride\", \"captureFactId\", \"capturedAttemptId\", provider, \"liveMode\", \"receiptDigest\")
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000006b0', 'billing-service', gen_random_uuid(), '00000000-0000-4000-8000-00000000c6b0', 1000, 'TND', 'customer_request', false,
      '00000000-0000-0000-0000-0000000006f0', '00000000-0000-0000-0000-0000000006a0', 'test', false, repeat('a', 64));
  " ) &
done
wait
ok=$(grep -L "refund_attempt_one_effective" "$outdir"/*.out | wc -l)
live=$(psql -Atq -d "$db" -c "SELECT count(*) FROM refund_attempt WHERE \"paymentId\"='00000000-0000-0000-0000-0000000006b0'")
rm -rf "$outdir"
[ "$ok" -eq 1 ] && [ "$live" -eq 1 ] || fail "one effective refund attempt race: ok=$ok live=$live (want ok=1 live=1)"
echo "PASS: race — one potentially effective refund attempt per payment survives $racers concurrent intents"

echo "== concurrency: Core V2 S0-C12 correction — one late success per capture fact survives distinct concurrent observations =="
newdb lsrace; db="$DBNAME"; apply_all "$db"
c12_fixture() { # payment, attempt and one capture fact; then the given number of stored notifications of it
  psql -q -v ON_ERROR_STOP=1 -d "$1" -c "
  INSERT INTO payment(id, producer, \"paymentRequestId\", \"sourceType\", \"sourceId\", \"payerType\", \"payerId\", \"sellerType\", \"sellerId\", amount, currency, purpose, \"liveMode\")
  VALUES ('00000000-0000-0000-0000-000000000c12', 'billing-service', gen_random_uuid(), 'invoice', 'inv-c12', 'user', 'u1', 'company', '00000000-0000-4000-8000-00000000c120', 1000, 'TND', 'non_entitlement', false);
  INSERT INTO payment_attempt(id, \"paymentId\", \"attemptNumber\", provider, \"liveMode\") VALUES ('00000000-0000-0000-0000-000000000ca1', '00000000-0000-0000-0000-000000000c12', 1, 'test', false);
  INSERT INTO provider_transaction_fact (id, provider, \"providerTxnId\", kind, \"paymentId\", \"attemptId\", amount, currency, \"liveMode\", source)
  VALUES ('00000000-0000-0000-0000-000000000cf1', 'test', 'ptx-c12', 'capture', '00000000-0000-0000-0000-000000000c12', '00000000-0000-0000-0000-000000000ca1', 1100, 'TND', false, 'status_check');
  INSERT INTO webhook_event (provider, \"providerEventId\", \"eventType\", \"rawBody\") SELECT 'test', 'evt-c12-' || i, 'payment.succeeded', '\x7b7d' FROM generate_series(1, $2) i;
  "
}
c12_late() { # one late success of the fact under notification evt-c12-<n> (the fact id may be NULL: a row written before S4d)
  echo "INSERT INTO payment_late_success (\"paymentId\", \"attemptId\", source, \"webhookEventId\", amount, currency, \"paymentStatus\", \"factId\")
    SELECT '00000000-0000-0000-0000-000000000c12', '00000000-0000-0000-0000-000000000ca1', 'webhook', id, 1100, 'TND', 'cancelled', $2 FROM webhook_event WHERE \"providerEventId\" = 'evt-c12-$1';"
}
c12_fixture "$db" 8
# FN-2 (0026): a late success needs the payment's own terminal status
psql -q -v ON_ERROR_STOP=1 -d "$db" -c "UPDATE payment_attempt SET status = 'submitted' WHERE id = '00000000-0000-0000-0000-000000000ca1'" -c "UPDATE payment SET status = 'pending' WHERE id = '00000000-0000-0000-0000-000000000c12'" \
  -c "UPDATE payment_attempt SET status = 'failed', \"failureCode\" = 'x', \"failureClass\" = 'terminal', \"completedAt\" = now() WHERE id = '00000000-0000-0000-0000-000000000ca1'" -c "UPDATE payment SET status = 'cancelled', \"closedAt\" = now() WHERE id = '00000000-0000-0000-0000-000000000c12'"
outdir="$(mktemp -d)"
for i in $(seq 1 8); do ( psql -q -d "$db" >"$outdir/$i.out" 2>&1 -c "$(c12_late "$i" "'00000000-0000-0000-0000-000000000cf1'")" ) & done
wait
ok=$(grep -L "payment_late_success_one_per_fact" "$outdir"/*.out | wc -l)
rows=$(psql -Atq -d "$db" -c "SELECT count(*) FROM payment_late_success WHERE \"factId\" = '00000000-0000-0000-0000-000000000cf1'")
rm -rf "$outdir"
[ "$ok" -eq 1 ] && [ "$rows" -eq 1 ] || fail "one late success per fact race: ok=$ok rows=$rows (want ok=1 rows=1)"
echo "PASS: race — one late success per capture fact survives 8 concurrent distinct observations"

echo "== migration: Core V2 S0-C12 correction — 0025 refuses existing per-fact duplicates (nothing changed) and keeps fact-less history =="
apply_until_0024() { for f in "$kitmig"/*.sql "$mig"/[0-9]*.sql; do case "$(basename "$f")" in 0025_*|0026_*|0027_*|0028_*|0029_*) continue ;; esac; psql -q -v ON_ERROR_STOP=1 -d "$1" -f "$f"; done; }
# (a) a database that already holds two late successes of one fact: 0025 refuses; both rows stay; no constraint is added
newdb lsdup; db="$DBNAME"; apply_until_0024 "$db"; c12_fixture "$db" 2
psql -q -v ON_ERROR_STOP=1 -d "$db" -c "$(c12_late 1 "'00000000-0000-0000-0000-000000000cf1'")" -c "$(c12_late 2 "'00000000-0000-0000-0000-000000000cf1'")"
if out=$(psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/0025_late_success_one_per_fact.sql" 2>&1); then fail "0025 applied over existing per-fact duplicates"; fi
echo "$out" | grep -q "1 capture fact(s) already have more than one late success (1 extra row(s)); nothing changed" || fail "0025 refusal message: $out"
rows=$(psql -Atq -d "$db" -c "SELECT count(*) FROM payment_late_success")
con=$(psql -Atq -d "$db" -c "SELECT count(*) FROM pg_constraint WHERE conname = 'payment_late_success_one_per_fact'")
[ "$rows" -eq 2 ] && [ "$con" -eq 0 ] || fail "0025 refusal changed something: rows=$rows constraint=$con (want 2, 0)"
echo "PASS: 0025 refuses existing per-fact duplicates; both historical rows kept, no constraint added"
# (b) fact-less rows written before S4d (NULL factId, the 0024 guard was not yet there): 0025 applies; they stay exactly as recorded
newdb lsnull; db="$DBNAME"
for f in "$kitmig"/*.sql "$mig"/[0-9]*.sql; do case "$(basename "$f")" in 0024_*|0025_*|0026_*|0027_*|0028_*|0029_*) continue ;; esac; psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$f"; done
c12_fixture "$db" 2
psql -q -v ON_ERROR_STOP=1 -d "$db" -c "$(c12_late 1 NULL)" -c "$(c12_late 2 NULL)"
before=$(psql -Atq -d "$db" -c "SELECT md5(string_agg(to_jsonb(l)::text, ',' ORDER BY id)) FROM payment_late_success l")
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/0024_capture_evidence.sql" -f "$mig/0025_late_success_one_per_fact.sql"
after=$(psql -Atq -d "$db" -c "SELECT md5(string_agg(to_jsonb(l)::text, ',' ORDER BY id)) FROM payment_late_success l")
[ "$before" = "$after" ] || fail "0025 changed fact-less history"
echo "PASS: 0025 applies over fact-less historical rows and leaves them exactly as recorded"

echo "== migration: Core V2 S0-C12 items 14, 15, FN-2 — 0026 leaves history exactly as recorded and rewrites nothing =="
newdb ls26; db="$DBNAME"
for f in "$kitmig"/*.sql "$mig"/[0-9]*.sql; do case "$(basename "$f")" in 0026_*|0027_*|0028_*|0029_*) continue ;; esac; psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$f"; done
c12_fixture "$db" 2
# a late success recorded before 0026 with a non-final status, and a sibling that made its attempt ambiguous afterwards: both legal then, both kept
psql -q -v ON_ERROR_STOP=1 -d "$db" -c "$(c12_late 1 "'00000000-0000-0000-0000-000000000cf1'" | sed "s/'cancelled'/'created'/")" \
  -c "INSERT INTO provider_transaction_fact (provider, \"providerTxnId\", kind, \"paymentId\", \"attemptId\", amount, currency, \"liveMode\", source) VALUES ('test', 'ptx-c12-b', 'capture', '00000000-0000-0000-0000-000000000c12', '00000000-0000-0000-0000-000000000ca1', 1200, 'TND', false, 'status_check')"
before=$(psql -Atq -d "$db" -c "SELECT md5(string_agg(to_jsonb(l)::text, ',' ORDER BY id)) FROM payment_late_success l")
psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$mig/0026_multiple_captures_and_recovery.sql"
after=$(psql -Atq -d "$db" -c "SELECT md5(string_agg(to_jsonb(l)::text, ',' ORDER BY id)) FROM payment_late_success l")
[ "$before" = "$after" ] || fail "0026 changed a historical late success"
state=$(psql -Atq -d "$db" -c "SELECT count(*) FROM capture_recovery_state")
[ "$state" -eq 0 ] || fail "0026 backfilled recovery state: $state"
perm=$(psql -Atq -d "$db" -c "SELECT string_agg(provider, ',' ORDER BY provider) FROM provider_capture_permission")
[ "$perm" = "simulation,test" ] || fail "0026 seeded another permission: $perm"
echo "PASS: 0026 applies over a non-final and an ambiguous historical record, leaves them exactly as recorded, backfills nothing, seeds only simulation and test"
