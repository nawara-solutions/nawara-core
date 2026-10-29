-- Core V2 S6f (the Owner's R6F-5 Path A, 2026-10-29): a recovery settlement that is entirely surplus owed to the Organization is refunded in
-- full through the existing refund machinery (S6b / S6c). Its reason code is `recovery_surplus`. Expand only: one widened CHECK, and the refund-attempt
-- insert guard (0017) admits a `recovery_settlement` payment (Billing decides which: only an entirely-surplus one).
ALTER TABLE refund_attempt DROP CONSTRAINT refund_attempt_reason;
ALTER TABLE refund_attempt ADD CONSTRAINT refund_attempt_reason CHECK (reason IN ('duplicate_charge', 'service_not_provided', 'customer_request', 'late_settlement_unapplied', 'legal_requirement', 'recovery_surplus'));

CREATE OR REPLACE FUNCTION refund_attempt_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payment%ROWTYPE;
BEGIN
  IF NEW.status <> 'authorization_pending' OR NEW."workAfter" IS NOT NULL THEN
    RAISE EXCEPTION 'refund_attempt: a new attempt starts as authorization_pending' USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_insert_state';
  END IF;
  SELECT * INTO p FROM payment WHERE id = NEW."paymentId";
  IF p.status <> 'succeeded' OR p."settledMethod" IS DISTINCT FROM 'gateway' OR p."sellerType" <> 'company' OR p."sellerId" <> NEW."companyId"::text
     OR p."succeededAttemptId" IS DISTINCT FROM NEW."capturedAttemptId" OR p.amount <> NEW.amount OR p.currency <> NEW.currency
     OR p.producer <> NEW.producer OR p."liveMode" IS DISTINCT FROM false
     OR p.purpose IS NULL OR p.purpose NOT IN ('direct_purchase', 'assisted_settlement', 'non_entitlement', 'recovery_settlement') THEN
    RAISE EXCEPTION 'refund_attempt: payment % is not refundable as requested', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_payment_refundable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM provider_transaction_fact f WHERE f.id = NEW."captureFactId" AND f.amount = p.amount AND f.currency = p.currency)
     OR EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = NEW."captureFactId") THEN
    RAISE EXCEPTION 'refund_attempt: the capture is not verified for the full amount' USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_capture_verified';
  END IF;
  IF EXISTS (SELECT 1 FROM provider_transaction_fact f WHERE f."paymentId" = NEW."paymentId" AND f.kind = 'refund') THEN
    RAISE EXCEPTION 'refund_attempt: payment % already has refund evidence', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_no_refund_fact';
  END IF;
  IF EXISTS (SELECT 1 FROM refund_attempt_refusal r WHERE r.id = NEW.id) THEN
    RAISE EXCEPTION 'refund_attempt: % was refused' , NEW.id USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_refused_id';
  END IF;
  NEW."requestedAt" := now();
  RETURN NEW;
END $$;
