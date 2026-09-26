-- Rollback of 0011: drops the partial index only (no data). The purge keeps working without it, by scanning the outbox.
BEGIN;

DROP INDEX IF EXISTS outbox_code_event_purge_idx;

COMMIT;
