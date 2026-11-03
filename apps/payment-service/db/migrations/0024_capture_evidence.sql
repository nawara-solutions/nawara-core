-- Core V2 S0-C11 (register PAY-02 G, PAY-05 I; findings F-27, F-28): capture evidence for commercial effect. EXPAND ONLY.
--
-- The database's own statement of what the service checks, so that direct SQL cannot bypass it:
--   * A gateway payment becomes `succeeded` only with exactly one capture fact on its succeeded attempt, equal to the payment in amount and currency, with no
--     recorded contradiction (S0-C11 items 1 to 3). A contradiction recorded AFTER settlement reverses nothing (item 6, FC-4): no row is rechecked.
--   * A new late success must name an existing capture fact of its attempt and payment, equal to it in amount and currency, with no recorded
--     contradiction (items 4 to 6). Rows written earlier keep what they recorded, including NULL (nothing is backfilled or re-interpreted).
-- Cash for non-Company sellers stays what S0 D1 and ADR-0068 decision 4 say: deferred, with no route, governed by DB-16; a settlement with no method stays
-- refused by `payment_succeeded_has_method`.
-- No fact, contradiction or existing row changes. No automatic resolution or equivalence exists. Runtime privileges are unchanged.

CREATE FUNCTION payment_settlement_capture_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE facts integer; verified boolean;
BEGIN
  IF NEW.status = 'succeeded' AND NEW."settledMethod" IS NOT DISTINCT FROM 'gateway' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'succeeded') THEN
    SELECT count(*)::int,
           COALESCE(bool_and(f.amount = NEW.amount AND trim(f.currency) = trim(NEW.currency)
             AND NOT EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id)), false)
      INTO facts, verified
      FROM provider_transaction_fact f
     WHERE f."attemptId" = NEW."succeededAttemptId" AND f."paymentId" = NEW.id AND f.kind = 'capture';
    IF facts <> 1 OR NOT verified THEN
      RAISE EXCEPTION 'payment %: no single, equal, uncontested capture fact on its succeeded attempt', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'payment_settlement_capture_evidence';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_07_settlement_capture_evidence BEFORE INSERT OR UPDATE OF status ON payment
  FOR EACH ROW EXECUTE FUNCTION payment_settlement_capture_evidence_guard();

CREATE OR REPLACE FUNCTION payment_late_success_fact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."factId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM provider_transaction_fact f
     WHERE f.id = NEW."factId" AND f.kind = 'capture' AND f."attemptId" = NEW."attemptId" AND f."paymentId" = NEW."paymentId"
       AND f.amount = NEW.amount AND trim(f.currency) = trim(NEW.currency)
       AND NOT EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id)
  ) THEN
    RAISE EXCEPTION 'payment_late_success: its fact is missing, for another attempt or payment, different or contested'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_late_success_fact_binding';
  END IF;
  RETURN NEW;
END $$;
