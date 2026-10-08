-- V2 A3M.3, finding G11 (A3M record §12): only an APPLIED outcome claims a Payment event id. Until now the unique index on "eventId"
-- (0007) let ANY first receipt (ignored, deferred, conflict) occupy the id, and a later delivery of that id was answered with the
-- recorded outcome. Payment's event ids, and the reconciler's, are deterministic, and a publisher can set any header (`source`
-- included), so a forged message carrying the genuine id could stop the genuine outcome from ever being applied. The de-duplication
-- that matters (an outcome is applied exactly once) is kept: at most one `applied` receipt per event id. Non-applied outcomes stay
-- recorded, append-only, one row per delivery (bounded by redeliveries; `payment_event_receipt_open_idx` still finds deferred and
-- conflict rows), and no longer block a later delivery, which is decided on its own merits under the invoice lock.
-- Existing rows are unchanged: 0007 allowed one row per event id, so the narrower unique index holds for them.
-- Indexes only: no column, constraint, trigger or data change.
DROP INDEX payment_event_receipt_event_unique;
CREATE UNIQUE INDEX payment_event_receipt_applied_event_unique ON payment_event_receipt ("eventId") WHERE "eventId" IS NOT NULL AND outcome = 'applied';
CREATE INDEX payment_event_receipt_event_idx ON payment_event_receipt ("eventId") WHERE "eventId" IS NOT NULL;
