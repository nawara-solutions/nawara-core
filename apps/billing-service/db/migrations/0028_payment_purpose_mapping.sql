-- Core V2 S4a (register PAY-01; the Owner's S4a decisions P-1 and P-2; ADR-0044 B2 and B7; S-6, DB-15), for Core V2 DEVELOPMENT AND
-- SIMULATION ONLY. Billing's half of the Payment purpose: Payment now requires the producer's settlement purpose and beneficiary, and
-- Billing derives both from the invoice's immutable routing record (`invoice_entitlement`), never from a request.
--
--   * Mapping version 2 (P-2): every NEW payment request pins mapping version 2 (the request body carries `purpose` and, for a direct
--     purchase, `beneficiaryUserId`) and needs its invoice's routing record. A legacy invoice (issued before S3a, without a routing
--     record) cannot start a new payment request. Requests already made keep version 1 and their bodies (never rewritten).
--   * The prospective B2 narrowing (P-1): a NEW `non_entitlement` routing record is never paid by an Organization (an Organization pays
--     only assisted or recovery settlements: B7, DB-15). NOT VALID: existing routing records are immutable and are not re-judged.
-- Expand only: a default, a CHECK and one insert guard. No existing row changes.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── payment_request: mapping version 2

ALTER TABLE payment_request ALTER COLUMN "mappingVersion" SET DEFAULT 2;
ALTER TABLE payment_request ADD CONSTRAINT payment_request_mapping_version_known CHECK ("mappingVersion" IN (1, 2));

CREATE FUNCTION billing_payment_request_mapping_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."mappingVersion" <> 2 THEN
    RAISE EXCEPTION 'payment request %: a new request uses mapping version 2', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'payment_request_mapping_v2';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoice_entitlement e WHERE e."invoiceId" = NEW."invoiceId") THEN
    RAISE EXCEPTION 'payment request %: its invoice has no routing record', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'payment_request_routing_required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_request_05_mapping_v2 BEFORE INSERT ON payment_request FOR EACH ROW EXECUTE FUNCTION billing_payment_request_mapping_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── invoice_entitlement: B2 narrowed

ALTER TABLE invoice_entitlement ADD CONSTRAINT invoice_entitlement_non_entitlement_payer
  CHECK (purpose <> 'non_entitlement' OR "payerType" <> 'organization') NOT VALID;
