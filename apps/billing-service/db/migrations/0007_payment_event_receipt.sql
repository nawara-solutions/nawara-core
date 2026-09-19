-- How each consumed Payment event was applied (SDD 21.4, 27). Append-only: an outcome is a fact. The `inbox` (kit) only records that an
-- event id was seen; this records WHAT HAPPENED, so a `conflict` or a `deferred` event is visible to an operator and to the reconciler.
-- No consumer exists yet (Stage 4); this is the durable state it will write.

CREATE TABLE payment_event_receipt (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "eventId"          uuid,                                    -- null for a settlement made by the reconciler, which has no event
  "eventName"        text NOT NULL,
  -- the id a payment event carries; NOT a foreign key: an event about another producer's payment names a request Billing never had
  "paymentRequestId" uuid,
  "paymentId"        uuid,
  outcome            text NOT NULL,
  "detailCode"       text,
  "paymentRevision"  integer,
  "causeType"        text NOT NULL,
  "receivedAt"       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_event_receipt_event_name_valid CHECK ("eventName" IN ('payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired')),
  -- `deferred`: the request has no paymentId yet, so nothing is applied and nothing is BOUND from an event; the reconciler settles it
  CONSTRAINT payment_event_receipt_outcome_valid CHECK (outcome IN ('applied', 'ignored', 'conflict', 'deferred')),
  CONSTRAINT payment_event_receipt_cause_valid CHECK ("causeType" IN ('payment_event', 'reconciliation')),
  CONSTRAINT payment_event_receipt_detail_length CHECK ("detailCode" IS NULL OR char_length("detailCode") BETWEEN 1 AND 64),
  CONSTRAINT payment_event_receipt_event_iff_event CHECK (("causeType" = 'payment_event') = ("eventId" IS NOT NULL)),
  CONSTRAINT payment_event_receipt_revision_nonnegative CHECK ("paymentRevision" IS NULL OR "paymentRevision" >= 0)
);
-- one receipt per event: the durable twin of the inbox's dedupe
CREATE UNIQUE INDEX payment_event_receipt_event_unique ON payment_event_receipt ("eventId") WHERE "eventId" IS NOT NULL;
CREATE INDEX payment_event_receipt_request_idx ON payment_event_receipt ("paymentRequestId", "receivedAt");
CREATE INDEX payment_event_receipt_open_idx ON payment_event_receipt ("receivedAt") WHERE outcome IN ('deferred', 'conflict');

CREATE TRIGGER payment_event_receipt_10_append_only BEFORE UPDATE OR DELETE ON payment_event_receipt
  FOR EACH ROW EXECUTE FUNCTION billing_append_only();
