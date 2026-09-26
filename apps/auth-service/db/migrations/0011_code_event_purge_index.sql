-- Stage 21.C.2 (ADR-0052 decision 5, Q3): Auth's domain events now travel through this service's outbox (0010), and three of them carry a
-- one-time code for delivery. Those rows are sensitive, short-lived data: the service deletes them once published or once the code has
-- expired (CodeEventPurge, every few seconds, in bounded batches). EXPAND ONLY: one partial index, no table, column or data change.
--
-- Why it is needed (measured, Stage 21.C.2 record): published rows are never deleted for any other event (audit evidence stays), so the
-- outbox only grows; without this index each purge pass scans the WHOLE table (200 020 rows: 19 ms, growing without bound), and
-- `outbox_unpublished_idx` cannot serve it because the purge must also find PUBLISHED code rows. The partial index holds only the live
-- code rows (they are deleted), so it stays a few kilobytes and the pass is an index scan (0.045 ms at the same volume). The purge query
-- names these three events as literals, which is what lets PostgreSQL match the index predicate.
BEGIN;

CREATE INDEX outbox_code_event_purge_idx ON outbox ("occurredAt")
  WHERE name IN ('member.contact_verification_requested', 'admin.operator_code_issued', 'admin.operator_confirmation_code_issued');

COMMIT;
