-- Stage 15.8: the ExpirySweeper's scan (`"expiresAt" <= now() AND status IN ('created', 'pending')`, every 5 s) had no index and read
-- the whole `payment` table, terminal payments included (11 ms at 100 k payments, linear). This partial index holds only the payments
-- that can still expire, so the scan's cost follows the open payments, not the history. Index only: no lifecycle change.
CREATE INDEX payment_expiry_open_idx ON payment ("expiresAt") WHERE status IN ('created', 'pending') AND "expiresAt" IS NOT NULL;
