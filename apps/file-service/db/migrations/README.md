# file-service migrations

Empty until Stage 17.3 (persistence and metadata: the `file` and `file_access_ticket` tables). The directory exists so the explicit
migration step (`npm run migrate`, as `file_migrator`) and the readiness check (`migrations`) already cover the service's own schema:
today they apply and verify the service-kit baseline only (`libs/service-kit/migrations`). Only `*.sql` files count; this README is
ignored by the runner.
