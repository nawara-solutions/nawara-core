-- Supports the reconciler's keyset scan of `requested` payment requests (audit finding H-02). The scan walks
-- `(updatedAt, id)` in order over the rows still awaiting a terminal Payment outcome; the existing partial indexes cover only
-- `created`/`sending` (dispatch) and one active/paid row per invoice, so without this the scan reads the whole table on every
-- pass. Index only: no column, constraint or trigger changes, and no change to any request's lifecycle.
CREATE INDEX payment_request_reconcile_idx ON payment_request ("updatedAt", id) WHERE status = 'requested' AND "paymentId" IS NOT NULL;
