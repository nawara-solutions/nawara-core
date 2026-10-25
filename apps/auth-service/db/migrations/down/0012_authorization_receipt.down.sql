-- Rollback of 0012: drops the authorization receipts table, its trigger and its trigger function. Receipts are short-lived (10 minutes)
-- and nothing else references them; rolling back discards any receipt rows (no other table or row changes).
BEGIN;

DROP TRIGGER IF EXISTS authorization_receipt_guard ON authorization_receipt;
DROP TABLE IF EXISTS authorization_receipt;
DROP FUNCTION IF EXISTS authorization_receipt_guard();

COMMIT;
