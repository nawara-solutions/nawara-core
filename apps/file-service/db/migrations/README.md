# file-service migrations

Applied by the explicit migration step (`npm run migrate`, as `file_migrator`) after the service-kit baseline
(`libs/service-kit/migrations`), never at startup; the readiness check (`migrations`) fails while any file here is unapplied. Forward
only: a change is a new numbered file. Only `*.sql` files count; this README is ignored by the runner.

| File | Stage | Adds |
|---|---|---|
| `0001_file_schema.sql` | 17.3 | `file` and `file_access_ticket`: shapes, the lifecycle state machine, set-once content, immutability, ticket bindings, single use, no hard delete, the sweep and redemption indexes ([record](../../../../docs/architecture/stage-17/stage-17-3-persistence-metadata.md)) |
| `0002_file_deletion_worker.sql` | 17.7 | the delete worker's lease, fence and retry schedule (`deleteAttempts`, `deleteNextAttemptAt`, `deleteLeaseUntil`, `deleteLastError`), the claim index ([record](../../../../docs/architecture/stage-17/stage-17-7-delete-cleanup-lifecycle.md)) |
| `0003_file_name_marks.sql` | 17.8 | `file_original_name_no_marks` (`NOT VALID`): no bidi mark, line / paragraph separator or BOM in a stored name ([record](../../../../docs/architecture/stage-17/stage-17-8-security-integrity.md) §4.5) |

**Upgrade precondition for `0003` (Stage 17.10):** a `NOT VALID` CHECK is still enforced on every UPDATE of an existing row, so a row
written before `0003` whose name holds one of those marks could never change state again and would fail every worker batch it joins.
No deployed database can hold one (production was never enabled before `0003`). Before applying `0003` to any database that predates
it, run (as the migrator) `SELECT count(*) FROM file WHERE "originalName" ~ '[\u061c\u200e\u200f\u2028\u2029\ufeff]'`: it must be `0`;
otherwise it is a development database: recreate it. Never `VALIDATE` the constraint over such rows, and never rewrite a checksummed
migration (the runner refuses an edited `0001`).
