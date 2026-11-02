-- 0045 — billing-service: Core V2 S0-C9, the Billing consumer of late-capture dispute attribution (finding F-SINT-2; S0 §1.5 S0-C9 items 2,
-- 4 to 8; register EVT-03 (CB-2), BIL-32 H (CB-3), BIL-33 H (CB-4); the Owner's CB-1 to CB-6, 2026-11-01). DEVELOPMENT AND SIMULATION
-- ONLY. Billing first: Payment does not emit the new fields yet, and every loss recorded before this migration is a legacy loss.
--
--   * payment_dispute_loss (CB-2): the captured movement a loss names. `captureBasis` (`settling_capture` | `late_capture`) and
--     `captureFactId`. Every existing row, and every version-1 event or losses-read item without the fields, is `settling_capture` (the only
--     attribution that existed); a `late_capture` loss always names its fact. The insert takes the payment request's row lock, so a loss and
--     an L-4 application (or a refund case, or the loss effect) are serialized: either the loss is recorded first and L-4 is refused
--     (`chargeback_recorded`), or the application commits first and the loss then follows item 2 for that L-4 purchase. A late-capture loss of
--     a late success Billing already holds must name that late success's payment and request.
--   * dispute_loss_effect (CB-2): the loss affects only the purchase its capture evidences. `settling_capture`: the purchase evidenced by
--     Payment's `payment.succeeded` receipt (S6e rules unchanged); `late_capture`: only the L-4 purchase evidenced by the late success naming
--     that fact (B10 / FC-4 / S6f: preserved, base-only recovery, T3); any other late capture has no purchase effect (`late_capture_unsold`).
--     A late-capture loss before Billing holds its late success is `held` (non-terminal, re-checked), never applied to a purchase.
--   * The reversal cause, the recovery obligation and the direct chargeback write-off re-check the capture binding: a late-capture loss never
--     reverses or writes off a direct purchase, and opens a recovery obligation only for exactly its L-4 purchase.
--   * reconciliation_case_resolution (CB-4, an Owner-approved POLICY ADDITION): `chargeback_returned`, for `late_assisted_settlement` and
--     `late_success` cases only, evidenced by the verified late-capture loss (`disputeId`) of exactly the case's capture whose chargeback
--     equals the capture's full amount in its currency, with no purchase from that late success, no application and no live or completed
--     refund case of that capture. A capture whose case resolved so is never refunded afterwards.
-- Expand only: two columns, one widened CHECK, replaced guards, additive triggers. No existing row is rewritten (CB-6).

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the captured movement of a loss (CB-2)

-- the existing rows take the default without being rewritten (no row trigger fires): legacy = the settling capture; new rows state it
ALTER TABLE payment_dispute_loss ADD COLUMN "captureBasis" text NOT NULL DEFAULT 'settling_capture';
ALTER TABLE payment_dispute_loss ALTER COLUMN "captureBasis" DROP DEFAULT;
ALTER TABLE payment_dispute_loss ADD COLUMN "captureFactId" uuid;
ALTER TABLE payment_dispute_loss ADD CONSTRAINT payment_dispute_loss_capture
  CHECK ("captureBasis" IN ('settling_capture', 'late_capture') AND ("captureBasis" <> 'late_capture' OR "captureFactId" IS NOT NULL));
CREATE INDEX payment_dispute_loss_capture_idx ON payment_dispute_loss ("captureFactId") WHERE "captureFactId" IS NOT NULL;

CREATE OR REPLACE FUNCTION billing_payment_dispute_loss_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s payment_late_success%ROWTYPE;
BEGIN
  -- the payment request's own lock: the L-4 application, the refund case and the loss effect take it too (S0-C9 item 7)
  PERFORM 1 FROM payment_request WHERE id = NEW."paymentRequestId" FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM payment_request r WHERE r.id = NEW."paymentRequestId" AND r."paymentId" = NEW."paymentId") THEN
    RAISE EXCEPTION 'dispute loss: payment % is not this payment request''s', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_loss_payment';
  END IF;
  IF NEW."captureBasis" = 'late_capture' THEN
    SELECT * INTO s FROM payment_late_success WHERE "factId" = NEW."captureFactId";
    IF s."lateSuccessId" IS NOT NULL AND (s."paymentId" <> NEW."paymentId" OR s."paymentRequestId" <> NEW."paymentRequestId") THEN
      RAISE EXCEPTION 'dispute loss: capture % is another payment''s', NEW."captureFactId" USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_loss_capture_binding';
    END IF;
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the loss's effect binds its capture (CB-2)

ALTER TABLE dispute_loss_effect DROP CONSTRAINT dispute_loss_effect_shape;
ALTER TABLE dispute_loss_effect ADD CONSTRAINT dispute_loss_effect_shape CHECK (
     (outcome = 'reversed_purchase' AND "purchaseId" IS NOT NULL AND reason IS NULL)
  OR (outcome = 'none' AND reason IN ('assisted_purchase_preserved', 'already_reversed', 'not_a_personal_purchase', 'late_capture_unsold')
      AND ((reason IN ('not_a_personal_purchase', 'late_capture_unsold')) = ("purchaseId" IS NULL))));

-- the purchase a loss may affect: the receipt-evidenced one (settling capture) or the L-4 purchase of the late success naming its fact
CREATE FUNCTION billing_dispute_loss_purchase_of_capture(p_dispute uuid, p_purchase uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM payment_dispute_loss l JOIN subscription_purchase s ON s."paymentRequestId" = l."paymentRequestId"
     WHERE l."disputeId" = p_dispute AND s.id = p_purchase
       AND CASE l."captureBasis"
             WHEN 'settling_capture' THEN s."lateSuccessId" IS NULL
             ELSE s."lateSuccessId" IS NOT NULL AND s."lateSuccessId" = (
               SELECT x."lateSuccessId" FROM payment_late_success x WHERE x."factId" = l."captureFactId" AND x."paymentRequestId" = l."paymentRequestId")
           END);
$$;

CREATE OR REPLACE FUNCTION billing_dispute_loss_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l payment_dispute_loss%ROWTYPE; s subscription_purchase%ROWTYPE; ls payment_late_success%ROWTYPE;
BEGIN
  SELECT * INTO l FROM payment_dispute_loss WHERE "disputeId" = NEW."disputeId";
  IF NEW."purchaseId" IS NOT NULL THEN
    SELECT * INTO s FROM subscription_purchase WHERE id = NEW."purchaseId";
    IF s."paymentRequestId" IS DISTINCT FROM l."paymentRequestId" OR NOT billing_dispute_loss_purchase_of_capture(NEW."disputeId", NEW."purchaseId") THEN
      RAISE EXCEPTION 'dispute loss %: not the purchase of its captured movement', NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'dispute_loss_effect_purchase';
    END IF;
  ELSIF NEW.reason = 'late_capture_unsold' THEN
    -- S0-C9 item 2: a late capture that evidences no purchase (yet recorded as Payment's late success of this request): no purchase effect
    SELECT * INTO ls FROM payment_late_success WHERE "factId" = l."captureFactId";
    IF l."captureBasis" <> 'late_capture' OR ls."lateSuccessId" IS NULL OR ls."paymentRequestId" <> l."paymentRequestId"
       OR EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."lateSuccessId" = ls."lateSuccessId") THEN
      RAISE EXCEPTION 'dispute loss %: not an unsold late capture of its request', NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'dispute_loss_effect_purchase';
    END IF;
  ELSIF l."captureBasis" <> 'settling_capture' OR EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."paymentRequestId" = l."paymentRequestId") THEN
    RAISE EXCEPTION 'dispute loss %: its payment request has a purchase', NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'dispute_loss_effect_purchase';
  END IF;
  -- a reversal is the direct purchase's one reversal, by THIS loss, with its recorded cause
  IF NEW.outcome = 'reversed_purchase' AND (s.purpose <> 'direct_purchase'
       OR NOT EXISTS (SELECT 1 FROM subscription_purchase_reversal v WHERE v."purchaseId" = s.id AND v.cause = 'final_lost_chargeback')
       OR NOT EXISTS (SELECT 1 FROM subscription_purchase_reversal_cause k WHERE k."purchaseId" = s.id AND k."disputeId" = NEW."disputeId")) THEN
    RAISE EXCEPTION 'dispute loss %: the reversal does not match the direct purchase and its recorded cause', NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'dispute_loss_effect_reversal';
  END IF;
  IF NEW.reason = 'already_reversed' AND (s.purpose <> 'direct_purchase'
       OR NOT EXISTS (SELECT 1 FROM subscription_purchase_reversal v WHERE v."purchaseId" = s.id AND v.cause <> 'final_lost_chargeback')
       OR NOT EXISTS (SELECT 1 FROM subscription_purchase_reversal_cause k WHERE k."purchaseId" = s.id AND k."disputeId" = NEW."disputeId")) THEN
    RAISE EXCEPTION 'dispute loss %: not a purchase already reversed by another cause, with this cause appended', NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'dispute_loss_effect_reversal';
  END IF;
  -- an assisted purchase's entitlement is preserved: it is never reversed for a chargeback (FC-4; S6f recovers the base)
  IF NEW.reason = 'assisted_purchase_preserved' AND (s.purpose <> 'assisted_settlement'
       OR EXISTS (SELECT 1 FROM subscription_purchase_reversal v WHERE v."purchaseId" = s.id AND v.cause = 'final_lost_chargeback')) THEN
    RAISE EXCEPTION 'dispute loss %: not an assisted purchase kept intact', NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'dispute_loss_effect_reversal';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;

-- a late-capture loss waiting for Billing to record its late success (event or Payment's read) is `held`: non-terminal, re-checked
ALTER TABLE dispute_loss_effect_attempt DROP CONSTRAINT dispute_loss_effect_attempt_state;
ALTER TABLE dispute_loss_effect_attempt ADD CONSTRAINT dispute_loss_effect_attempt_state CHECK (state IN ('retry', 'review', 'held'));

-- a chargeback cause reverses only the receipt-evidenced direct purchase of its settling capture (never through a late capture)
CREATE FUNCTION billing_reversal_cause_capture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."disputeId" IS NOT NULL AND NOT billing_dispute_loss_purchase_of_capture(NEW."disputeId", NEW."purchaseId") THEN
    RAISE EXCEPTION 'reversal cause: dispute % does not name the captured movement of purchase %', NEW."disputeId", NEW."purchaseId"
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_purchase_reversal_cause_dispute';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_purchase_reversal_cause_06_capture BEFORE INSERT ON subscription_purchase_reversal_cause
  FOR EACH ROW EXECUTE FUNCTION billing_reversal_cause_capture_guard();

-- B10 / S6f: a recovery obligation only for the assisted purchase its loss's capture evidences (a late capture: exactly its L-4 purchase)
CREATE FUNCTION billing_recovery_obligation_capture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT billing_dispute_loss_purchase_of_capture(NEW."disputeId", NEW."purchaseId") THEN
    RAISE EXCEPTION 'recovery obligation: the loss does not name the captured movement of purchase %', NEW."purchaseId"
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_basis';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_obligation_06_capture BEFORE INSERT ON recovery_obligation FOR EACH ROW EXECUTE FUNCTION billing_recovery_obligation_capture_guard();

-- FC-6: the direct chargeback write-off is a loss of the direct purchase's own settling capture
CREATE FUNCTION billing_financial_loss_capture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'direct_chargeback_write_off' AND EXISTS (
    SELECT 1 FROM payment_dispute_loss l WHERE l."disputeId" = NEW."disputeId" AND l."captureBasis" <> 'settling_capture') THEN
    RAISE EXCEPTION 'financial loss: a late capture''s chargeback is not a direct purchase''s loss' USING ERRCODE = '23514', CONSTRAINT = 'financial_loss_evidence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_loss_06_capture BEFORE INSERT ON financial_loss FOR EACH ROW EXECUTE FUNCTION billing_financial_loss_capture_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── chargeback_returned (CB-4, BIL-33 H)

ALTER TABLE reconciliation_case_resolution ADD COLUMN "disputeId" uuid REFERENCES payment_dispute_loss ("disputeId");
ALTER TABLE reconciliation_case_resolution DROP CONSTRAINT reconciliation_case_resolution_kind;
ALTER TABLE reconciliation_case_resolution ADD CONSTRAINT reconciliation_case_resolution_kind CHECK (kind IN ('refund_completed', 'late_settlement_applied',
  'surplus_refunded', 'surplus_repaid', 'recovery_counted', 'loss_recognized', 'effect_applied', 'authorization_resolved', 'acknowledged', 'chargeback_returned'));

-- a refund case that ever counts against a capture: live or completed, or cancelled after it relayed an authorization (not proof, R6G-7)
CREATE FUNCTION billing_capture_refund_exists(p_payment uuid, p_fact uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM refund_case r WHERE r."paymentId" = p_payment AND (r."captureFactId" = p_fact OR r."captureFactId" IS NULL)
                   AND (r.status <> 'cancelled' OR EXISTS (SELECT 1 FROM refund_authorization_relay x WHERE x."refundCaseId" = r.id)));
$$;

CREATE OR REPLACE FUNCTION billing_reconciliation_resolution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c reconciliation_case%ROWTYPE; ok boolean;
BEGIN
  SELECT * INTO c FROM reconciliation_case WHERE id = NEW."caseId";
  IF NEW.kind = 'chargeback_returned' AND c."paymentRequestId" IS NOT NULL THEN
    -- serialized with the L-4 application and every refund case of the payment (they take the same lock)
    PERFORM 1 FROM payment_request WHERE id = c."paymentRequestId" FOR UPDATE;
  END IF;
  ok := CASE NEW.kind
    WHEN 'refund_completed' THEN c."caseType" IN ('late_assisted_settlement', 'late_success', 'unmatched_capture', 'unrouted_settlement')
      AND EXISTS (SELECT 1 FROM refund_case r WHERE r.id = NEW."refundCaseId" AND r.status = 'completed' AND r."paymentId" = c."paymentId"
                   AND (c."captureFactId" IS NULL OR r."captureFactId" = c."captureFactId")
                   AND (c."caseType" <> 'late_assisted_settlement' OR r.eligibility = 'late_assisted_settlement'))
    WHEN 'late_settlement_applied' THEN c."caseType" = 'late_assisted_settlement'
      AND EXISTS (SELECT 1 FROM late_settlement_application a WHERE a."lateSettlementId" = c."evidenceKey")
    WHEN 'surplus_refunded' THEN c."caseType" = 'recovery_surplus' AND EXISTS (SELECT 1 FROM recovery_surplus_refund r WHERE r."surplusId" = c."evidenceKey")
    WHEN 'surplus_repaid' THEN c."caseType" = 'recovery_surplus' AND EXISTS (SELECT 1 FROM recovery_surplus_confirmation r WHERE r."surplusId" = c."evidenceKey")
    WHEN 'recovery_counted' THEN c."caseType" = 'late_success'
      AND EXISTS (SELECT 1 FROM recovery_payment p WHERE p.id = NEW."recoveryPaymentId" AND p."lateSuccessId" = c."evidenceKey")
    WHEN 'loss_recognized' THEN c."caseType" = 'over_return'
      AND EXISTS (SELECT 1 FROM financial_loss f WHERE f.id = NEW."lossId" AND f.kind = 'over_return' AND f."evidenceKey" = c."evidenceKey")
    WHEN 'effect_applied' THEN c."caseType" = 'contradictory_effect'
      AND (EXISTS (SELECT 1 FROM refund_case_effect e WHERE e."refundCaseId" = c."evidenceKey") OR EXISTS (SELECT 1 FROM dispute_loss_effect e WHERE e."disputeId" = c."evidenceKey"))
    WHEN 'authorization_resolved' THEN c."caseType" = 'authorization_pending'
      AND EXISTS (SELECT 1 FROM refund_authorization_relay r WHERE r.id = c."evidenceKey" AND r."attemptStatus" IS NOT NULL AND r."attemptStatus" <> 'authorization_pending')
    -- R6H-2: only review-only cases, whose evidence moves no money Billing could act on, may be acknowledged; the evidence stays
    WHEN 'acknowledged' THEN c."caseType" IN ('refund_discrepancy', 'partial_chargeback', 'second_reversal_cause')
    -- Core V2 S0-C9 item 5 (CB-4): the provider returned the WHOLE unsold late capture; nothing else is refunded, sold or changed
    WHEN 'chargeback_returned' THEN c."caseType" IN ('late_assisted_settlement', 'late_success') AND c."captureFactId" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM payment_dispute_loss l JOIN payment_late_success s ON s."factId" = l."captureFactId"
         WHERE l."disputeId" = NEW."disputeId" AND l."captureBasis" = 'late_capture' AND l."captureFactId" = c."captureFactId"
           AND l."paymentId" = c."paymentId" AND s."paymentId" = c."paymentId" AND s."paymentRequestId" = l."paymentRequestId"
           AND l."chargebackAmount" = s.amount AND l."chargebackCurrency" = trim(s.currency) AND l.currency = trim(s.currency)
           AND NOT EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."lateSuccessId" = s."lateSuccessId"))
      AND NOT billing_capture_refund_exists(c."paymentId", c."captureFactId")
      AND (c."caseType" <> 'late_assisted_settlement' OR NOT EXISTS (SELECT 1 FROM late_settlement_application a WHERE a."lateSettlementId" = c."evidenceKey"))
    ELSE false END;
  IF ok IS NOT TRUE OR (NEW.kind <> 'refund_completed' AND NEW."refundCaseId" IS NOT NULL) OR (NEW.kind <> 'loss_recognized' AND NEW."lossId" IS NOT NULL)
     OR (NEW.kind <> 'recovery_counted' AND NEW."recoveryPaymentId" IS NOT NULL) OR (NEW.kind <> 'chargeback_returned' AND NEW."disputeId" IS NOT NULL) THEN
    RAISE EXCEPTION 'reconciliation case %: % is not a resolution its evidence supports', NEW."caseId", NEW.kind USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_resolution_evidence';
  END IF;
  NEW."resolvedAt" := now();
  RETURN NEW;
END $$;

-- S0-C9 item 6: one return per captured movement. A capture the provider returned in full (its case resolved `chargeback_returned`) is never
-- refunded afterwards; the case's resolution and this refusal take the payment request's lock (refund_case_05_insert_guard took it)
CREATE FUNCTION billing_refund_case_chargeback_returned_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM reconciliation_case c JOIN reconciliation_case_resolution x ON x."caseId" = c.id
              WHERE x.kind = 'chargeback_returned' AND c."paymentId" = NEW."paymentId" AND (NEW."captureFactId" IS NULL OR c."captureFactId" = NEW."captureFactId")) THEN
    RAISE EXCEPTION 'refund case: the provider already returned capture % by chargeback', NEW."captureFactId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_exposure';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_case_06_chargeback_returned BEFORE INSERT ON refund_case FOR EACH ROW EXECUTE FUNCTION billing_refund_case_chargeback_returned_guard();
