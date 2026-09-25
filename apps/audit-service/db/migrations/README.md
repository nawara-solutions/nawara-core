# audit-service migrations

Empty until Stage 18.3 (persistence: the append-only `audit_record` table, its privileges and triggers). The directory exists so the
explicit migration step (`npm run migrate`, as `audit_migrator`) and the readiness check (`migrations`) already cover the service's own
schema: today they apply and verify the service-kit baseline only (`libs/service-kit/migrations`). Only `*.sql` files count; this README
is ignored by the runner.
