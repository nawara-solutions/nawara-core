-- Core V2 S0-C11 item 7 and 7c capture provenance (register BIL-32 J; the Owner's approval 2026-11-03). EXPAND ONLY.
--
-- `late_settlement_application."captureFactId"`: the capture fact Payment verified for this application, written by its own insert and immutable
-- under the existing append-only trigger (`late_settlement_application_10_append_only`).
--   * NO foreign key: the fact lives in Payment's database (database per service). Billing can check only what it holds itself.
--   * Required for every NEW application. For input (b) it must equal the late success's `factId` Billing recorded; for input (a), the E-7 record,
--     Billing holds no copy, and its only source is Payment's verified PAY-16 answer in the same application.
--   * One capture fact evidences at most one L-4 application (partial unique index). Concurrent applications already serialize under the payment
--     request's lock (0040), and the loser is refused.
--   * Applications recorded before this migration keep NULL ("not recorded"): nothing is backfilled or inferred.
-- The guard runs after `late_settlement_application_05_guard`, so the existing refusals keep their order.

ALTER TABLE late_settlement_application ADD COLUMN "captureFactId" uuid;
CREATE UNIQUE INDEX late_settlement_application_capture_once ON late_settlement_application ("captureFactId") WHERE "captureFactId" IS NOT NULL;

CREATE FUNCTION billing_late_settlement_application_capture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_late uuid; v_fact uuid;
BEGIN
  IF NEW."captureFactId" IS NULL THEN
    RAISE EXCEPTION 'late settlement application: the verified capture fact it relies on is required (S0-C11)'
      USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_application_capture_required';
  END IF;
  SELECT l."lateSuccessId" INTO v_late FROM assistance_late_settlement l WHERE l.id = NEW."lateSettlementId";
  IF v_late IS NOT NULL THEN
    SELECT s."factId" INTO v_fact FROM payment_late_success s WHERE s."lateSuccessId" = v_late;
    IF v_fact IS DISTINCT FROM NEW."captureFactId" THEN
      RAISE EXCEPTION 'late settlement application: input (b) relies on its late success''s own capture fact'
        USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_application_capture_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER late_settlement_application_06_capture BEFORE INSERT ON late_settlement_application
  FOR EACH ROW EXECUTE FUNCTION billing_late_settlement_application_capture_guard();
