-- Core V2 S6h R6H-5 (the Owner's decision, 2026-10-30; register BIL-23 G, PAY-13 G; Auth receipt contract §17f), for Core V2 DEVELOPMENT
-- AND SIMULATION ONLY: a CAPTURE-SPECIFIC refund case. It refunds, in full, exactly ONE verified captured money movement (Payment's
-- `capture` provider_transaction_fact, `captureFactId`) that the ordinary, success-based refund path of its payment cannot return:
--
--   * `late_capture`: Payment verified a capture after the payment ended (failed, expired or cancelled); the payment request is in the same
--     terminal state and nothing was sold;
--   * `duplicate_capture`: a further, distinct capture of a succeeded payment (another capture of the settling attempt, a capture of another
--     attempt, or an unmatched fact associated with the payment); the sale keeps its own capture and purchase;
--   * `unrouted_capture`: the settling capture of a paid request whose invoice has no routing record (S3a B9 `unrouted`: no purchase, no
--     ordinary refund basis); `receiptId` is its applied `payment.succeeded` receipt.
--
-- The amount and currency are the CAPTURE's, read by Billing from Payment's verified evidence (never a caller value); Payment re-verifies the
-- capture, its amount and its refund state under its own locks before it consumes the Owner's receipt, whose binding names the capture.
-- A capture-specific case has no purchase, late settlement or surplus and never produces a commercial effect: its completion records
-- `outcome = none, reason = capture_refunded` (no purchase reversal, no entitlement change, no cash-return obligation, no recovery debt).
--
-- Uniqueness, REPLACED scope-correctly (never relaxed): the S6a rule (one open-or-completed case per payment) now holds for ORDINARY cases
-- (same index name); a capture-specific case is unique per CAPTURE FACT. The insert guard, under the payment request's row lock, also keeps
-- the two kinds from returning the same money or overlapping unresolved exposure: no capture-specific case while an ordinary case of the
-- payment is open, and no ordinary case while a capture-specific case of the payment is open or an `unrouted_capture` case (the settling
-- capture itself) is open or completed.
-- Expand only: two nullable columns, one relaxed NOT NULL (only for the new basis, by CHECK), replaced guards and indexes.

ALTER TABLE refund_case ADD COLUMN "captureFactId" uuid;
ALTER TABLE refund_case ADD COLUMN "captureBasis" text;
ALTER TABLE refund_case ALTER COLUMN "receiptId" DROP NOT NULL;

ALTER TABLE refund_case DROP CONSTRAINT refund_case_eligibility;
ALTER TABLE refund_case ADD CONSTRAINT refund_case_eligibility CHECK (
  eligibility IN ('personal_purchase', 'late_assisted_settlement', 'non_entitlement', 'recovery_surplus', 'capture_specific'));
ALTER TABLE refund_case DROP CONSTRAINT refund_case_basis;
ALTER TABLE refund_case ADD CONSTRAINT refund_case_basis CHECK (
     (eligibility = 'personal_purchase' AND "purchaseId" IS NOT NULL AND "lateSettlementId" IS NULL AND "surplusId" IS NULL)
  OR (eligibility = 'late_assisted_settlement' AND "lateSettlementId" IS NOT NULL AND "purchaseId" IS NULL AND "surplusId" IS NULL)
  OR (eligibility = 'non_entitlement' AND "purchaseId" IS NULL AND "lateSettlementId" IS NULL AND "surplusId" IS NULL)
  OR (eligibility = 'recovery_surplus' AND "surplusId" IS NOT NULL AND "purchaseId" IS NULL AND "lateSettlementId" IS NULL)
  OR (eligibility = 'capture_specific' AND "purchaseId" IS NULL AND "lateSettlementId" IS NULL AND "surplusId" IS NULL));
ALTER TABLE refund_case ADD CONSTRAINT refund_case_capture_shape CHECK (
  CASE WHEN eligibility = 'capture_specific'
    THEN "captureFactId" IS NOT NULL AND "captureBasis" IN ('late_capture', 'duplicate_capture', 'unrouted_capture')
         AND ("receiptId" IS NOT NULL) = ("captureBasis" = 'unrouted_capture')
    ELSE "captureFactId" IS NULL AND "captureBasis" IS NULL AND "receiptId" IS NOT NULL END);

-- one live ORDINARY case per payment (the S6a rule, same name); one live case per CAPTURE FACT
DROP INDEX refund_case_payment_active_unique;
CREATE UNIQUE INDEX refund_case_payment_active_unique ON refund_case ("paymentId") WHERE status IN ('open', 'completed') AND eligibility <> 'capture_specific';
CREATE UNIQUE INDEX refund_case_capture_active_unique ON refund_case ("captureFactId") WHERE status IN ('open', 'completed');

CREATE OR REPLACE FUNCTION billing_refund_case_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pr record; inv record; routing record; platforms uuid[];
BEGIN
  IF NEW.status <> 'open' OR NEW."cancelledBy" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'a refund case is opened open' USING ERRCODE = '23514', CONSTRAINT = 'refund_case_created_open';
  END IF;
  IF NEW."surplusId" IS NOT NULL THEN -- Path A and Path B serialize on the surplus (the resolution guard's lock)
    PERFORM pg_advisory_xact_lock(hashtextextended('billing.recovery_surplus:' || NEW."surplusId", 0));
  END IF;
  SELECT * INTO pr FROM payment_request WHERE id = NEW."paymentRequestId" FOR UPDATE;
  SELECT * INTO inv FROM invoice WHERE id = pr."invoiceId";
  SELECT * INTO routing FROM invoice_entitlement WHERE "invoiceId" = pr."invoiceId";
  SELECT array_agg(DISTINCT p."platformId") INTO platforms FROM invoice_line l JOIN product p ON p.id = l."productId" WHERE l."invoiceId" = pr."invoiceId";
  IF inv."sellerType" IS DISTINCT FROM 'company' OR inv."sellerId" <> NEW."companyId"::text
     OR NEW."organizationId" IS DISTINCT FROM inv."organizationId"
     OR cardinality(platforms) <> 1 OR platforms[1] IS NULL OR platforms[1] <> NEW."platformId" THEN
    IF NEW.eligibility = 'capture_specific' THEN
      RAISE EXCEPTION 'refund case: the seller Company, Organization or Platform does not match' USING ERRCODE = '23514', CONSTRAINT = 'refund_case_seller';
    END IF;
  END IF;

  IF NEW.eligibility = 'capture_specific' THEN
    -- R6H-5: the payment request is Payment's payment, of this invoice; never an Organization subscription or a recovery payment
    IF pr.id IS NULL OR pr."paymentId" IS DISTINCT FROM NEW."paymentId" OR pr."invoiceId" <> NEW."invoiceId"
       OR routing.purpose IN ('organization_subscription', 'recovery_settlement') THEN
      RAISE EXCEPTION 'refund case: payment % is not eligible', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_not_eligible';
    END IF;
    IF (NEW."captureBasis" = 'late_capture' AND (pr.status NOT IN ('failed', 'expired', 'cancelled')
           OR EXISTS (SELECT 1 FROM subscription_purchase s WHERE s."paymentRequestId" = pr.id)))
       OR (NEW."captureBasis" = 'duplicate_capture' AND pr.status <> 'paid')
       OR (NEW."captureBasis" = 'unrouted_capture' AND (pr.status <> 'paid' OR routing."invoiceId" IS NOT NULL
           OR EXISTS (SELECT 1 FROM subscription_purchase s WHERE s."invoiceId" = pr."invoiceId")
           OR EXISTS (SELECT 1 FROM assistance_late_settlement l WHERE l."paymentRequestId" = pr.id)
           OR NOT EXISTS (SELECT 1 FROM payment_event_receipt r WHERE r.id = NEW."receiptId" AND r."paymentRequestId" = pr.id
                            AND r."eventName" = 'payment.succeeded' AND r.outcome = 'applied'))) THEN
      RAISE EXCEPTION 'refund case: payment % is not eligible for a % refund', NEW."paymentId", NEW."captureBasis" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_not_eligible';
    END IF;
    -- never overlapping an unresolved ordinary refund of the same payment
    IF EXISTS (SELECT 1 FROM refund_case c WHERE c."paymentId" = NEW."paymentId" AND c.eligibility <> 'capture_specific' AND c.status = 'open')
       OR (NEW."captureBasis" = 'unrouted_capture'
           AND EXISTS (SELECT 1 FROM refund_case c WHERE c."paymentId" = NEW."paymentId" AND c.eligibility <> 'capture_specific' AND c.status = 'completed')) THEN
      RAISE EXCEPTION 'refund case: payment % has an ordinary refund case', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_exposure';
    END IF;
    NEW."openedAt" := now();
    RETURN NEW;
  END IF;

  -- the ordinary refund (S6a, S6f), unchanged
  IF pr.id IS NULL OR pr.status <> 'paid' OR pr."paymentId" IS DISTINCT FROM NEW."paymentId" OR pr."invoiceId" <> NEW."invoiceId"
     OR NOT EXISTS (SELECT 1 FROM payment_event_receipt r WHERE r.id = NEW."receiptId" AND r."paymentRequestId" = pr.id
                      AND r."eventName" = 'payment.succeeded' AND r.outcome = 'applied') THEN
    RAISE EXCEPTION 'refund case: no verified capture of payment %', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_capture_unverified';
  END IF;
  IF NEW.amount <> pr.amount OR NEW.currency <> pr.currency THEN
    RAISE EXCEPTION 'refund case: the amount is the full captured amount, in its currency' USING ERRCODE = '23514', CONSTRAINT = 'refund_case_full_amount';
  END IF;
  IF inv."sellerType" <> 'company' OR inv."sellerId" <> NEW."companyId"::text
     OR NEW."organizationId" IS DISTINCT FROM inv."organizationId"
     OR cardinality(platforms) <> 1 OR platforms[1] IS NULL OR platforms[1] <> NEW."platformId" THEN
    RAISE EXCEPTION 'refund case: the seller Company, Organization or Platform does not match' USING ERRCODE = '23514', CONSTRAINT = 'refund_case_seller';
  END IF;
  IF routing."invoiceId" IS NULL OR routing.purpose = 'organization_subscription'
     OR (NEW.eligibility = 'personal_purchase' AND NOT EXISTS (
           SELECT 1 FROM subscription_purchase s WHERE s.id = NEW."purchaseId" AND s."invoiceId" = pr."invoiceId" AND s."paymentRequestId" = pr.id
              AND s."receiptId" = NEW."receiptId" AND s.purpose IN ('direct_purchase', 'assisted_settlement')
              AND NOT EXISTS (SELECT 1 FROM subscription_purchase_reversal v WHERE v."purchaseId" = s.id)))
     OR (NEW.eligibility = 'late_assisted_settlement' AND (NOT EXISTS (
           SELECT 1 FROM assistance_late_settlement l WHERE l.id = NEW."lateSettlementId" AND l."invoiceId" = pr."invoiceId" AND l."paymentRequestId" = pr.id
              AND l."receiptId" = NEW."receiptId")
           OR EXISTS (SELECT 1 FROM subscription_purchase s WHERE s."invoiceId" = pr."invoiceId")))
     OR (NEW.eligibility = 'non_entitlement' AND routing.purpose <> 'non_entitlement')
     -- Core V2 S6f (R6F-5 Path A): only a recovery payment that is ENTIRELY surplus, with no external repayment recorded for its surplus
     OR (NEW.eligibility = 'recovery_surplus' AND (routing.purpose <> 'recovery_settlement' OR NOT EXISTS (
           SELECT 1 FROM recovery_surplus su JOIN recovery_payment p ON p.id = su."recoveryPaymentId"
            WHERE su.id = NEW."surplusId" AND p."paymentRequestId" = pr.id AND p."receiptId" = NEW."receiptId" AND p."principalAmount" = 0
              AND su.amount = pr.amount AND NOT EXISTS (SELECT 1 FROM recovery_surplus_external x WHERE x."surplusId" = su.id))))
     OR (NEW.eligibility <> 'recovery_surplus' AND routing.purpose = 'recovery_settlement') THEN
    RAISE EXCEPTION 'refund case: payment % is not eligible', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_not_eligible';
  END IF;
  -- R6H-5: never overlapping an unresolved capture-specific refund of the payment, nor the settling capture's own capture-specific refund
  IF EXISTS (SELECT 1 FROM refund_case c WHERE c."paymentId" = NEW."paymentId" AND c.eligibility = 'capture_specific'
               AND (c.status = 'open' OR (c.status = 'completed' AND c."captureBasis" = 'unrouted_capture'))) THEN
    RAISE EXCEPTION 'refund case: payment % has a capture-specific refund case', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_exposure';
  END IF;
  NEW."openedAt" := now();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── no commercial effect

ALTER TABLE refund_case_effect DROP CONSTRAINT refund_case_effect_shape;
ALTER TABLE refund_case_effect ADD CONSTRAINT refund_case_effect_shape CHECK (
     (outcome = 'reversed_purchase' AND "purchaseId" IS NOT NULL AND "obligationId" IS NULL AND reason IS NULL)
  OR (outcome = 'reversed_purchase_and_obligation_opened' AND "purchaseId" IS NOT NULL AND "obligationId" IS NOT NULL AND reason IS NULL)
  OR (outcome = 'none' AND "obligationId" IS NULL
      AND reason IN ('no_entitlement_basis', 'late_assisted_settlement', 'already_reversed', 'recovery_surplus_refunded', 'capture_refunded')
      AND ((reason = 'already_reversed') = ("purchaseId" IS NOT NULL))));

CREATE OR REPLACE FUNCTION billing_refund_case_effect_basis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c refund_case%ROWTYPE;
BEGIN
  SELECT * INTO c FROM refund_case WHERE id = NEW."refundCaseId";
  -- R6H-5: a capture-specific case records exactly `none / capture_refunded`, and only it does
  IF (c.eligibility = 'capture_specific') <> (NEW.outcome = 'none' AND NEW.reason IS NOT DISTINCT FROM 'capture_refunded') THEN
    RAISE EXCEPTION 'refund case %: the effect does not match its eligibility basis', NEW."refundCaseId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_effect_basis';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_case_effect_06_capture_basis BEFORE INSERT ON refund_case_effect FOR EACH ROW EXECUTE FUNCTION billing_refund_case_effect_basis_guard();

-- Payment's new definitive refusal of a capture-specific attempt (the last capture backing the sale) is mirrored like the others
ALTER TABLE refund_authorization_relay DROP CONSTRAINT refund_authorization_relay_refusal;
ALTER TABLE refund_authorization_relay ADD CONSTRAINT refund_authorization_relay_refusal CHECK (("attemptStatus" = 'rejected') = (refusal IS NOT NULL)
  AND (refusal IS NULL OR refusal IN ('payment_not_refundable', 'refund_capture_unverified', 'refund_amount_not_full', 'refund_dispute_open',
    'refund_in_progress', 'refund_already_recorded', 'refund_capture_not_eligible')));
