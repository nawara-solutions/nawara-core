-- 0049 — billing-service: repeated and excess chargeback losses (Core V2 S0-C10, adopted #480; register BIL-28 G, BIL-33 L, BIL-34 G; the Owner's
-- implementation decisions O-1 (Option B), O-2 (Option B), O-3, O-4, O-5, 2026-11-05). EXPAND ONLY. DEVELOPMENT AND SIMULATION ONLY.
--
--   * Preflight (S0-C10 item 13): an assisted purchase holding more than one recovery obligation, or a payment holding more than one direct
--     chargeback write-off, refuses this migration and changes nothing (the runner applies a file in one transaction). The Owner decides.
--   * payment_dispute_loss."beforeS0c10": TRUE for every loss that existed when this migration ran, FALSE for every later one (forced by a
--     trigger). The column is added with a constant default, so no existing row is written. It states a fact (recorded before S0-C10), never an
--     order: no historical ledger row is generated (O-1 Option B).
--   * capture_loss_cap: one append-only row per loss Billing decides after this migration, written FIRST and in its own transaction, whose
--     columns the database derives. It records the capture's cumulative verified loss before that loss (Constraint A, item 3):
--       - a loss recorded after this migration follows every historical loss of its capture, so its cumulative loss is the sum of all of them
--         plus the ledger rows of later losses written before it, serialized by a per-capture advisory lock (never by timestamps);
--       - a historical loss decided after this migration is first only when it is its capture's ONLY historical loss; with several, their
--         order cannot be proven, so its cumulative loss is unknown (NULL) and it is never a first full loss (fail-closed review).
--     A loss in another currency is never summed and never within the cap. Recorded provider figures are copied, never changed.
--   * recovery_obligation: at most ONE per assisted purchase, in any state (Constraint B, item 5), and only for the first full loss within the
--     cap (item 4).
--   * financial_loss: at most ONE direct chargeback write-off per capture (a direct write-off is always the settling capture, 0045), and only
--     for the loss whose effect reversed the purchase (item 4, O-4).
--   * recovery_review: the reasons `repeated_loss` and `chargeback_exceeds_capture` (item 6), each refused unless its evidence holds.
--   * reconciliation_case: the type `chargeback_loss_review` (item 7). No resolution kind names it, so the existing resolution guard refuses
--     every resolution: it is never acknowledged, closed or resolved.
-- No obligation, write-off, loss, review, case or provider figure recorded before this migration is changed, and nothing is backfilled.

DO $$
DECLARE obligations integer; write_offs integer;
BEGIN
  SELECT count(*) INTO obligations FROM (SELECT 1 FROM recovery_obligation GROUP BY "purchaseId" HAVING count(*) > 1) x;
  SELECT count(*) INTO write_offs FROM (SELECT 1 FROM financial_loss WHERE kind = 'direct_chargeback_write_off' GROUP BY "paymentId" HAVING count(*) > 1) x;
  IF obligations > 0 OR write_offs > 0 THEN
    RAISE EXCEPTION '0049 refused (S0-C10 item 13): % assisted purchase(s) hold more than one recovery obligation and % payment(s) more than one direct chargeback write-off; nothing was changed, the Owner decides',
      obligations, write_offs USING ERRCODE = 'P0001', HINT = 's0c10_historical_duplicates'; -- its own code: never confused with a constraint's
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── losses recorded before S0-C10 (O-1)

ALTER TABLE payment_dispute_loss ADD COLUMN "beforeS0c10" boolean NOT NULL DEFAULT true;
ALTER TABLE payment_dispute_loss ALTER COLUMN "beforeS0c10" SET DEFAULT false;

CREATE FUNCTION billing_payment_dispute_loss_after_s0c10() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."beforeS0c10" := false;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_dispute_loss_06_after_s0c10 BEFORE INSERT ON payment_dispute_loss FOR EACH ROW EXECUTE FUNCTION billing_payment_dispute_loss_after_s0c10();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the capture's cumulative loss (Constraint A)

CREATE TABLE capture_loss_cap (
  "disputeId"         uuid PRIMARY KEY REFERENCES payment_dispute_loss ("disputeId"),
  "captureKey"        text NOT NULL,
  "beforeS0c10"       boolean NOT NULL,
  gross               bigint NOT NULL,
  currency            char(3) NOT NULL,
  "chargebackAmount"  bigint NOT NULL,
  "sameCurrency"      boolean NOT NULL,
  "cumulativeBefore"  bigint,
  "withinCap"         boolean NOT NULL,
  "firstFull"         boolean NOT NULL,
  "recordedAt"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capture_loss_cap_amounts CHECK (gross > 0 AND "chargebackAmount" > 0 AND ("cumulativeBefore" IS NULL OR "cumulativeBefore" >= 0)),
  CONSTRAINT capture_loss_cap_first CHECK (NOT "firstFull" OR ("sameCurrency" AND "withinCap" AND "cumulativeBefore" = 0 AND "chargebackAmount" = gross))
);
CREATE INDEX capture_loss_cap_capture_idx ON capture_loss_cap ("captureKey");

-- Every column is derived here from Billing's own records; any value the caller supplies is replaced.
CREATE FUNCTION billing_capture_loss_cap_derive() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  l payment_dispute_loss%ROWTYPE;
  g bigint;
  cur text;
  k text;
  hist_n integer;
  hist_sum numeric;
  led_sum numeric;
BEGIN
  SELECT * INTO l FROM payment_dispute_loss WHERE "disputeId" = NEW."disputeId";
  IF l."disputeId" IS NULL THEN
    RAISE EXCEPTION 'capture loss cap: no recorded loss %', NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'capture_loss_cap_loss';
  END IF;
  IF l."captureBasis" = 'late_capture' THEN
    SELECT s.amount, trim(s.currency) INTO g, cur FROM payment_late_success s
     WHERE s."factId" = l."captureFactId" AND s."paymentId" = l."paymentId" AND s."paymentRequestId" = l."paymentRequestId";
    k := 'late:' || l."captureFactId"::text;
  ELSE
    SELECT r.amount, trim(r.currency) INTO g, cur FROM payment_request r WHERE r.id = l."paymentRequestId" AND r."paymentId" = l."paymentId";
    k := 'settling:' || l."paymentId"::text;
  END IF;
  IF g IS NULL THEN
    RAISE EXCEPTION 'capture loss cap: the capture of loss % is not recorded', NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'capture_loss_cap_capture';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing.capture_loss:' || k, 0));
  NEW."captureKey" := k;
  NEW."beforeS0c10" := l."beforeS0c10";
  NEW.gross := g;
  NEW.currency := cur;
  NEW."chargebackAmount" := l."chargebackAmount";
  NEW."sameCurrency" := l.currency = cur AND l."chargebackCurrency" = cur;
  -- every loss of this capture recorded before S0-C10, in its currency: all of them precede every later loss
  SELECT coalesce(sum(h."chargebackAmount"), 0), count(*) INTO hist_sum, hist_n FROM payment_dispute_loss h
   WHERE h."beforeS0c10" AND h.currency = cur AND h."chargebackCurrency" = cur
     AND CASE WHEN l."captureBasis" = 'late_capture' THEN h."captureBasis" = 'late_capture' AND h."captureFactId" = l."captureFactId"
              ELSE h."captureBasis" = 'settling_capture' AND h."paymentId" = l."paymentId" END;
  IF NOT NEW."sameCurrency" THEN
    NEW."cumulativeBefore" := NULL;
    NEW."withinCap" := false;
  ELSIF l."beforeS0c10" THEN
    IF hist_n = 1 THEN
      NEW."cumulativeBefore" := 0;
      NEW."withinCap" := l."chargebackAmount" <= g;
    ELSE
      NEW."cumulativeBefore" := NULL; -- several historical losses: their order cannot be proven
      NEW."withinCap" := hist_sum <= g;
    END IF;
  ELSE
    SELECT coalesce(sum(c."chargebackAmount"), 0) INTO led_sum FROM capture_loss_cap c WHERE c."captureKey" = k AND NOT c."beforeS0c10" AND c."sameCurrency";
    NEW."cumulativeBefore" := hist_sum + led_sum;
    NEW."withinCap" := hist_sum + led_sum + l."chargebackAmount" <= g;
  END IF;
  NEW."firstFull" := coalesce(NEW."sameCurrency" AND NEW."withinCap" AND NEW."cumulativeBefore" = 0 AND l."chargebackAmount" = g, false);
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER capture_loss_cap_05_derive BEFORE INSERT ON capture_loss_cap FOR EACH ROW EXECUTE FUNCTION billing_capture_loss_cap_derive();
CREATE TRIGGER capture_loss_cap_10_append_only BEFORE UPDATE OR DELETE ON capture_loss_cap FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER capture_loss_cap_11_no_truncate BEFORE TRUNCATE ON capture_loss_cap FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── one obligation per assisted purchase (Constraint B)

ALTER TABLE recovery_obligation ADD CONSTRAINT recovery_obligation_purchase UNIQUE ("purchaseId");

CREATE FUNCTION billing_recovery_obligation_loss_cap_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM capture_loss_cap c WHERE c."disputeId" = NEW."disputeId" AND c."firstFull") THEN
    RAISE EXCEPTION 'recovery obligation: loss % is not its capture''s first full loss within the cap (S0-C10 items 3, 4)', NEW."disputeId"
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_loss_cap';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_obligation_07_loss_cap BEFORE INSERT ON recovery_obligation FOR EACH ROW EXECUTE FUNCTION billing_recovery_obligation_loss_cap_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── one direct write-off per capture (item 4, O-4)

CREATE UNIQUE INDEX financial_loss_direct_write_off_capture ON financial_loss ("paymentId") WHERE kind = 'direct_chargeback_write_off';

CREATE FUNCTION billing_financial_loss_reversal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'direct_chargeback_write_off' AND NOT EXISTS (
    SELECT 1 FROM dispute_loss_effect e WHERE e."disputeId" = NEW."disputeId" AND e.outcome = 'reversed_purchase') THEN
    RAISE EXCEPTION 'financial loss: the loss of dispute % did not reverse its direct purchase (S0-C10 item 4)', NEW."disputeId"
      USING ERRCODE = '23514', CONSTRAINT = 'financial_loss_reversal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_loss_07_reversal BEFORE INSERT ON financial_loss FOR EACH ROW EXECUTE FUNCTION billing_financial_loss_reversal_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── reviews and their visibility (items 6, 7)

ALTER TABLE recovery_review DROP CONSTRAINT recovery_review_reason;
ALTER TABLE recovery_review ADD CONSTRAINT recovery_review_reason
  CHECK (reason IN ('partial_chargeback', 'refund_completed', 'repeated_loss', 'chargeback_exceeds_capture'));

CREATE FUNCTION billing_recovery_review_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- repeated: the purchase holds an obligation from another loss, or another loss of it is its capture's first full loss (the one that opens it)
  IF NEW.reason = 'repeated_loss' AND NOT EXISTS (
    SELECT 1 FROM dispute_loss_effect e JOIN recovery_obligation o ON o."purchaseId" = e."purchaseId"
     WHERE e."disputeId" = NEW."disputeId" AND o."disputeId" <> NEW."disputeId") AND NOT EXISTS (
    SELECT 1 FROM dispute_loss_effect e JOIN dispute_loss_effect x ON x."purchaseId" = e."purchaseId" JOIN capture_loss_cap c ON c."disputeId" = x."disputeId"
     WHERE e."disputeId" = NEW."disputeId" AND x."disputeId" <> NEW."disputeId" AND c."firstFull") THEN
    RAISE EXCEPTION 'recovery review: the purchase of loss % has no obligation and no first full loss from another loss', NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'recovery_review_evidence';
  END IF;
  IF NEW.reason = 'chargeback_exceeds_capture' AND NOT EXISTS (
    SELECT 1 FROM capture_loss_cap c WHERE c."disputeId" = NEW."disputeId" AND NOT c."firstFull" AND NOT (c."withinCap" AND c."chargebackAmount" < c.gross)) THEN
    RAISE EXCEPTION 'recovery review: loss % is within its capture''s cap', NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'recovery_review_evidence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_review_05_evidence BEFORE INSERT ON recovery_review FOR EACH ROW EXECUTE FUNCTION billing_recovery_review_evidence_guard();

ALTER TABLE reconciliation_case DROP CONSTRAINT reconciliation_case_type;
ALTER TABLE reconciliation_case ADD CONSTRAINT reconciliation_case_type CHECK ("caseType" IN ('late_assisted_settlement', 'recovery_surplus', 'late_success',
  'unmatched_capture', 'unrouted_settlement', 'over_return', 'refund_discrepancy', 'partial_chargeback', 'second_reversal_cause', 'contradictory_effect',
  'authorization_pending', 'chargeback_refund_overlap', 'capture_contradiction', 'chargeback_loss_review'));

-- ─────────────────────────────────────────────────────────────────────────────────────────────── privileges: the ledger is append-only for everyone

DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON capture_loss_cap FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'capture_loss_cap' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE %s ON capture_loss_cap FROM %s', r.priv, r.role);
  END LOOP;
END $$;
