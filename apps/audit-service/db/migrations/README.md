# audit-service migrations

Applied by the explicit migration step (`npm run migrate`, as `audit_migrator`) after the service-kit baseline
(`libs/service-kit/migrations`), never at startup; the readiness check (`migrations`) fails while any file here is unapplied. Forward
only: a change is a new numbered file. Only `*.sql` files count; this README is ignored by the runner.

| File | Stage | Adds |
|---|---|---|
| `0001_audit_record.sql` | 18.3 | the append-only `audit_record`: shapes, the actor / subject / changes invariants, the database clock, the unique (sourceService, eventId), the V1 indexes, append-only triggers, and `audit_restrict_to_append_only` ([record](../../../../docs/architecture/stage-18/stage-18-3-persistence-append-only.md)) |
| `0002_audit_record_time_idx.sql` | 18.6 | the platform-wide time index `("occurredAt" DESC, id DESC)`: an all-organizations platform read otherwise scanned the whole table (measured: 32–42 ms → 0.08–0.19 ms at 500 000 rows; [record](../../../../docs/architecture/stage-18/stage-18-6-query-authorization.md)) |

**Convention for every later append-only table:** default privileges give the runtime role UPDATE / DELETE on each new table; the
migration that creates one must call `SELECT audit_restrict_to_append_only('<table>');` and add the append-only triggers.
