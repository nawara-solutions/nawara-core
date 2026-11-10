-- 0028 — payment-service: a write-once refund-evidence index on each stored provider notification (Core V2 R3; the Owner's GO 2026-11-10; register
-- PAY-08 I). DEVELOPMENT AND SIMULATION ONLY. Expand only: two columns, one guard, two partial indexes. The signed evidence (`rawBody`, `eventType`,
-- `provider`, `providerEventId`, `receivedAt`) stays exactly as received under `webhook_event_immutable`; nothing here rewrites it.
--
--   * `evidenceIndex` states what Payment could read from a signature-verified notification, once:
--       `reference`            a `refund.succeeded` naming a provider transaction id, with a usable amount and currency;
--       `reference_malformed`  a `refund.succeeded` naming a provider transaction id, its amount or currency unusable (the named attempt is UNKNOWN, fail-closed);
--       `no_reference`         a parsed `refund.succeeded` with no provider transaction id (unattributable: no payment or Company scope is established);
--       `unparseable`          a signed body the adapter cannot parse (unattributable);
--       `not_applicable`       any other event type;
--       `pending`              not indexed yet (every row stored before this migration). A pending `refund.succeeded` of a provider makes every failed
--                              refund attempt of that provider read UNKNOWN: an incomplete index never reads as confirmed absence.
--   * `providerTransactionId` is present exactly for `reference` and `reference_malformed`.
--   * Write-once: a row leaves `pending` once and never changes again; the historical backfill (application job, resumable) sets only pending rows.
-- Nothing here attributes a notification to a payment or a Company, associates or allocates a fact, or holds anything: PAY-08 reads it (R3).

ALTER TABLE webhook_event ADD COLUMN "evidenceIndex" text NOT NULL DEFAULT 'pending';
ALTER TABLE webhook_event ADD COLUMN "providerTransactionId" text;
ALTER TABLE webhook_event ADD CONSTRAINT webhook_event_evidence_index CHECK ("evidenceIndex" IN ('pending', 'reference', 'reference_malformed', 'no_reference', 'unparseable', 'not_applicable'));
ALTER TABLE webhook_event ADD CONSTRAINT webhook_event_evidence_reference CHECK (("evidenceIndex" IN ('reference', 'reference_malformed')) = ("providerTransactionId" IS NOT NULL));
ALTER TABLE webhook_event ADD CONSTRAINT webhook_event_evidence_reference_length CHECK ("providerTransactionId" IS NULL OR char_length("providerTransactionId") BETWEEN 1 AND 256);

CREATE FUNCTION payment_webhook_evidence_index_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."evidenceIndex" <> 'pending' AND (NEW."evidenceIndex" IS DISTINCT FROM OLD."evidenceIndex" OR NEW."providerTransactionId" IS DISTINCT FROM OLD."providerTransactionId") THEN
    RAISE EXCEPTION 'webhook event %: its evidence index is written once', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'webhook_event_evidence_index_once';
  END IF;
  IF OLD."evidenceIndex" = 'pending' AND NEW."evidenceIndex" = 'pending' AND NEW."providerTransactionId" IS DISTINCT FROM OLD."providerTransactionId" THEN
    RAISE EXCEPTION 'webhook event %: a pending index names no reference', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'webhook_event_evidence_index_once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER webhook_event_evidence_index_once BEFORE UPDATE ON webhook_event FOR EACH ROW EXECUTE FUNCTION payment_webhook_evidence_index_once();

-- PAY-08's reads: the notifications naming one provider transaction id, and whether a provider still has unindexed refund notifications
CREATE INDEX webhook_event_refund_reference_idx ON webhook_event (provider, "providerTransactionId") WHERE "eventType" = 'refund.succeeded' AND "providerTransactionId" IS NOT NULL;
CREATE INDEX webhook_event_refund_pending_idx ON webhook_event (provider) WHERE "eventType" = 'refund.succeeded' AND "evidenceIndex" = 'pending';
