#!/usr/bin/env bash
# Applies the kit's migrations plus db/migrations/*.sql (in order) to a throwaway database and runs the invariant suite. Needs a
# reachable PostgreSQL >= 16 (psql/createdb on PATH); the connection comes from the usual PGHOST/PGPORT/PGUSER/PGPASSWORD variables.
# The scratch database is dropped on exit.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mig="$here/../migrations"
kitmig="$here/../../../../libs/service-kit/migrations"
db="organization_inv_$$"
cleanup() { dropdb --if-exists "$db" >/dev/null 2>&1 || true; }
trap cleanup EXIT

createdb "$db"
for f in "$kitmig"/*.sql "$mig"/[0-9]*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$f"; done
echo "== schema-level invariants (all migrations)"
(cd "$here" && psql -q -v ON_ERROR_STOP=1 -d "$db" -f invariants.sql)
echo "PASS: invariants.sql"
