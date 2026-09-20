-- Stage 5 hardening: persists the correlation id a payment request was created under (SDD 21.5 gap noted in the
-- Stage 5 audit) so the dispatcher and reconciler can carry it across the HTTP hop to Payment, instead of losing it
-- the moment work moves off the originating request's AsyncLocalStorage context. Nullable and set-once: a request
-- created before this migration, or by a path with no ambient request context, simply has none, and the dispatcher/
-- reconciler already fall back to a deterministic per-request id in that case.

ALTER TABLE payment_request ADD COLUMN "correlationId" text;
ALTER TABLE payment_request ADD CONSTRAINT payment_request_correlation_id_length CHECK ("correlationId" IS NULL OR char_length("correlationId") <= 128);

-- Re-declare the immutability trigger with `correlationId` added to the deny-list: it is a creation-time field like
-- `invoiceId`/amount/currency, never a lifecycle column.
DROP TRIGGER payment_request_10_immutable ON payment_request;
CREATE TRIGGER payment_request_10_immutable BEFORE UPDATE ON payment_request
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('invoiceId', 'amount', 'currency', 'expiresAt', 'mappingVersion', 'createdAt', 'createdByType', 'createdById', 'correlationId');
