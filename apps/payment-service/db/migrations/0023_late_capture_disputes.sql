-- 0023 — payment-service: disputes attributed to a verified LATE capture (Core V2 S0-C9; register PAY-09 G, EVT-03 M, PAY-14 H; S0 FC-1,
-- FC-4, FC-5; the Owner's CB-1, CB-2, CB-5, CB-6, 2026-11-01). DEVELOPMENT AND SIMULATION ONLY: every dispute row stays `liveMode = false`.
--
-- Additive: one column on `payment_dispute` and replaced guard functions. No existing row is rewritten (CB-6): every dispute recorded before
-- this migration was bound to the capture of its payment's succeeded attempt, so it is a `settling_capture`, the column's default (a
-- constant default is catalog metadata: no row is rewritten; it is also EVT-03's legacy meaning). Payment states the basis explicitly on
-- every new dispute, and the guard below re-checks either basis. Preserved observations, conflicts included, are untouched.
--
-- CB-1: besides the settling capture (S6e, unchanged), a dispute may be bound to the referenced attempt's capture when the payment is final
-- `failed` / `cancelled` / `expired`, that attempt has exactly ONE capture fact, the fact is uncontested and Payment recorded a late success
-- naming it. The payment, its attempts and every fact are unchanged. The database re-checks the binding the service decided.

ALTER TABLE payment_dispute ADD COLUMN "captureBasis" text NOT NULL DEFAULT 'settling_capture';
ALTER TABLE payment_dispute ADD CONSTRAINT payment_dispute_capture_basis CHECK ("captureBasis" IN ('settling_capture', 'late_capture'));

-- the dispute's capture: the verified capture of exactly this payment, attempt and provider, never contested, the provider's exposure never
-- above it; and, by basis, the payment's settling capture (its succeeded attempt) or a late capture (CB-1)
CREATE OR REPLACE FUNCTION payment_dispute_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f record; p record;
BEGIN
  SELECT * INTO f FROM provider_transaction_fact WHERE id = NEW."captureFactId";
  IF f.kind IS DISTINCT FROM 'capture' OR f."paymentId" <> NEW."paymentId" OR f."attemptId" <> NEW."attemptId" OR f.provider <> NEW.provider
     OR EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id) THEN
    RAISE EXCEPTION 'payment dispute: its capture is not the verified capture of this payment and attempt' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_capture';
  END IF;
  IF NEW.currency <> f.currency OR NEW.amount > f.amount THEN
    RAISE EXCEPTION 'payment dispute: its exposure exceeds, or is in another currency than, the verified capture' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_exposure';
  END IF;
  SELECT status, "succeededAttemptId" INTO p FROM payment WHERE id = NEW."paymentId";
  IF NEW."captureBasis" = 'settling_capture' THEN
    IF p."succeededAttemptId" IS DISTINCT FROM NEW."attemptId" THEN
      RAISE EXCEPTION 'payment dispute: a settling capture is the capture of the payment''s succeeded attempt' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_capture_basis';
    END IF;
  ELSIF p.status NOT IN ('failed', 'cancelled', 'expired') OR p."succeededAttemptId" IS NOT NULL
     OR (SELECT count(*) FROM provider_transaction_fact g WHERE g."paymentId" = NEW."paymentId" AND g."attemptId" = NEW."attemptId" AND g.kind = 'capture') <> 1
     OR NOT EXISTS (SELECT 1 FROM payment_late_success l WHERE l."factId" = f.id AND l."attemptId" = NEW."attemptId" AND l."paymentId" = NEW."paymentId") THEN
    RAISE EXCEPTION 'payment dispute: a late capture is the single capture of an attempt of a final payment, named by a recorded late success'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_capture_basis';
  END IF;
  IF NEW."chargebackFactId" IS NOT NULL THEN
    RAISE EXCEPTION 'payment dispute: a chargeback fact is linked after the dispute exists' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_chargeback_order';
  END IF;
  NEW."recordedAt" := now();
  NEW."closedAt" := CASE WHEN NEW.status = 'open' THEN NULL ELSE now() END;
  RETURN NEW;
END $$;

-- unchanged rules, with the capture basis part of the immutable binding
CREATE OR REPLACE FUNCTION payment_dispute_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.provider, NEW."providerDisputeId", NEW."paymentId", NEW."attemptId", NEW."captureFactId", NEW."captureBasis", NEW.amount, NEW.currency,
      NEW.reason, NEW."liveMode", NEW."providerOpenedAt", NEW."recordedAt")
     IS DISTINCT FROM
     (OLD.id, OLD.provider, OLD."providerDisputeId", OLD."paymentId", OLD."attemptId", OLD."captureFactId", OLD."captureBasis", OLD.amount, OLD.currency,
      OLD.reason, OLD."liveMode", OLD."providerOpenedAt", OLD."recordedAt") THEN
    RAISE EXCEPTION 'payment dispute: identity, binding and stated exposure are immutable' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_immutable';
  END IF;
  IF OLD.status <> NEW.status THEN
    IF OLD.status <> 'open' THEN
      RAISE EXCEPTION 'payment dispute %: % is terminal', OLD.id, OLD.status USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_terminal';
    END IF;
    NEW."closedAt" := now();
  ELSIF (NEW."closedAt", NEW."providerClosedAt") IS DISTINCT FROM (OLD."closedAt", OLD."providerClosedAt") THEN
    RAISE EXCEPTION 'payment dispute: its closing is immutable' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_terminal';
  END IF;
  IF OLD."chargebackFactId" IS NOT NULL AND NEW."chargebackFactId" IS DISTINCT FROM OLD."chargebackFactId" THEN
    RAISE EXCEPTION 'payment dispute: its chargeback fact is linked once' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_chargeback_once';
  END IF;
  IF NEW."chargebackFactId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM provider_transaction_fact f WHERE f.id = NEW."chargebackFactId" AND f.kind = 'chargeback' AND f."disputeId" = NEW.id) THEN
    RAISE EXCEPTION 'payment dispute: its chargeback fact is another dispute''s' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_chargeback_fact';
  END IF;
  RETURN NEW;
END $$;

-- CB-5: a dispute notification held for its capture is a webhook event left `unmatched`; the exposure read finds it by its attempt
CREATE INDEX webhook_event_dispute_pending_idx ON webhook_event ("matchedAttemptId")
  WHERE "eventType" LIKE 'payment.dispute.%' AND state NOT IN ('processed', 'ignored', 'conflict');
