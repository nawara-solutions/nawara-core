# file-service migrations

Applied by the explicit migration step (`npm run migrate`, as `file_migrator`) after the service-kit baseline
(`libs/service-kit/migrations`), never at startup; the readiness check (`migrations`) fails while any file here is unapplied. Forward
only: a change is a new numbered file. Only `*.sql` files count; this README is ignored by the runner.

| File | Stage | Adds |
|---|---|---|
| `0001_file_schema.sql` | 17.3 | `file` and `file_access_ticket`: shapes, the lifecycle state machine, set-once content, immutability, ticket bindings, single use, no hard delete, the sweep and redemption indexes ([record](../../../../docs/architecture/stage-17/stage-17-3-persistence-metadata.md)) |
