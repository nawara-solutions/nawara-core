-- 0043 — billing-service: Core V2 S0-C8 PR-2a, a late assisted settlement from Payment's verified LATE success (S0 §1.5 S0-C8 items 1 to
-- 4, 6, 7 and 9; S0 §3.4 L-1 to L-3, L-5; register BIL-23 H, BIL-32 G (input only), BIL-33 G, EVT-10; the Owner's LS-1 to LS-6 and LS-8,
-- 2026-11-01). DEVELOPMENT AND SIMULATION ONLY. CLASSIFICATION ONLY: nothing here creates, allows or activates a purchase (PR-2b).
--
--   * assistance_late_settlement: a second, verified evidence (S0-C8 item 1 b). Besides the S5b E-7 record of an applied `payment.succeeded`
--     (unchanged), a record of ONE `payment_late_success` (`lateSuccessId`, unique), with `receiptId` NULL, reason `channel_closed` and
--     `settledAt` = Payment's `recordedAt` (LS-2). The database re-checks every eligibility condition (LS-4): the late success is of this
--     payment request and names its capture fact; Payment's payment and Billing's request ended in the SAME `failed` / `cancelled` /
--     `expired` state; the request's channel for this invoice is definitively `closed`; the routing is this request's `assisted_settlement`;
--     the captured amount and currency equal the invoice's total; `invoiceId` stays unique (the first late settlement of the invoice).
--   * One effect per late success (S0-C8 item 6): a late success that evidences a late assisted settlement never also becomes a recovery
--     payment or a `late_success` case, nor the reverse; checked under the payment request's row lock by each insert.
--   * refund_case (BIL-23 H, LS-6): such a late settlement is refunded (L-3) by a `late_assisted_settlement` case naming its capture
--     (`captureFactId`, basis `late_capture`, no receipt), executed by Payment's capture-specific refund; that capture is never refunded by
--     a capture-specific case. One live case per capture fact (`refund_case_capture_active_unique`, 0041) is unchanged.
--   * subscription_purchase is NOT changed: its `receiptId` stays NOT NULL with its applied `payment.succeeded` guard, so no purchase can be
--     evidenced by a late success until PR-2b.
-- Expand only: one nullable column, one relaxed NOT NULL (only for the new evidence, by CHECK), replaced guards.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the late assisted settlement's evidence

ALTER TABLE assistance_late_settlement ALTER COLUMN "receiptId" DROP NOT NULL;
ALTER TABLE assistance_late_settlement ADD COLUMN "lateSuccessId" uuid UNIQUE REFERENCES payment_late_success ("lateSuccessId");
ALTER TABLE assistance_late_settlement ADD CONSTRAINT assistance_late_settlement_evidence CHECK (("receiptId" IS NULL) <> ("lateSuccessId" IS NULL));
ALTER TABLE assistance_late_settlement ADD CONSTRAINT assistance_late_settlement_late_success_shape
  CHECK ("lateSuccessId" IS NULL OR (reason = 'channel_closed' AND "settledAt" IS NOT NULL));

CREATE OR REPLACE FUNCTION billing_assistance_late_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_pr record; v_ls record;
BEGIN
  IF NEW."lateSuccessId" IS NULL THEN
    -- S5b E-7 (unchanged): the verified settlement it holds: an applied payment.succeeded of this invoice's request, which is paid
    IF NOT EXISTS (
      SELECT 1 FROM payment_event_receipt r JOIN payment_request pr ON pr.id = r."paymentRequestId"
       WHERE r.id = NEW."receiptId" AND r.outcome = 'applied' AND r."eventName" = 'payment.succeeded' AND pr.id = NEW."paymentRequestId"
         AND pr."invoiceId" = NEW."invoiceId" AND pr.status = 'paid')
       OR NOT EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."invoiceId" = NEW."invoiceId" AND c."assistanceRequestId" = NEW."assistanceRequestId") THEN
      RAISE EXCEPTION 'assistance_late_settlement: invoice % has no verified settlement of that request', NEW."invoiceId" USING ERRCODE = '23514', CONSTRAINT = 'assistance_late_settlement_verified';
    END IF;
  ELSE
    -- Core V2 S0-C8 item 1 (b): Payment's verified late success of this request, after BOTH sides ended unsuccessfully on a closed channel
    SELECT * INTO v_pr FROM payment_request WHERE id = NEW."paymentRequestId" FOR UPDATE;
    SELECT * INTO v_ls FROM payment_late_success WHERE "lateSuccessId" = NEW."lateSuccessId";
    IF v_pr.id IS NULL OR v_ls."lateSuccessId" IS NULL OR v_ls."paymentRequestId" <> v_pr.id OR v_ls."paymentId" IS DISTINCT FROM v_pr."paymentId" OR v_pr."invoiceId" <> NEW."invoiceId"
       OR v_ls."factId" IS NULL OR v_ls."paymentStatus" NOT IN ('failed', 'cancelled', 'expired') OR v_pr.status IS DISTINCT FROM v_ls."paymentStatus"
       OR NOT EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."invoiceId" = NEW."invoiceId" AND c."assistanceRequestId" = NEW."assistanceRequestId"
                        AND c."paymentRequestId" = v_pr.id AND c.status = 'closed')
       OR NOT EXISTS (SELECT 1 FROM invoice_entitlement e WHERE e."invoiceId" = NEW."invoiceId" AND e.purpose = 'assisted_settlement'
                        AND e."assistanceRequestId" = NEW."assistanceRequestId")
       OR NOT EXISTS (SELECT 1 FROM invoice i WHERE i.id = NEW."invoiceId" AND i.total = v_ls.amount AND trim(i.currency) = trim(v_ls.currency))
       OR NEW."settledAt" IS DISTINCT FROM v_ls."recordedAt" THEN
      RAISE EXCEPTION 'assistance_late_settlement: late success % is not eligible for invoice %', NEW."lateSuccessId", NEW."invoiceId"
        USING ERRCODE = '23514', CONSTRAINT = 'assistance_late_settlement_late_success';
    END IF;
    IF EXISTS (SELECT 1 FROM recovery_payment p WHERE p."lateSuccessId" = NEW."lateSuccessId")
       OR EXISTS (SELECT 1 FROM reconciliation_case c WHERE c."caseType" = 'late_success' AND c."evidenceKey" = NEW."lateSuccessId") THEN
      RAISE EXCEPTION 'late success %: already has an effect', NEW."lateSuccessId" USING ERRCODE = '23514', CONSTRAINT = 'late_success_one_effect';
    END IF;
  END IF;
  -- Core V2 S6g: every new record keeps Payment's original settlement instant (never the recording time)
  IF NEW."settledAt" IS NULL THEN
    RAISE EXCEPTION 'assistance_late_settlement: the original settlement instant is required' USING ERRCODE = '23514', CONSTRAINT = 'assistance_late_settlement_settled_at';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── one effect per late success (S0-C8 item 6)

CREATE FUNCTION billing_late_success_one_effect(p_late uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE prid uuid;
BEGIN
  SELECT "paymentRequestId" INTO prid FROM payment_late_success WHERE "lateSuccessId" = p_late;
  IF prid IS NOT NULL THEN PERFORM 1 FROM payment_request WHERE id = prid FOR UPDATE; END IF; -- the classification's own lock
  IF EXISTS (SELECT 1 FROM assistance_late_settlement l WHERE l."lateSuccessId" = p_late) THEN
    RAISE EXCEPTION 'late success %: already a late assisted settlement', p_late USING ERRCODE = '23514', CONSTRAINT = 'late_success_one_effect';
  END IF;
END $$;
CREATE FUNCTION billing_recovery_payment_one_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."lateSuccessId" IS NOT NULL THEN PERFORM billing_late_success_one_effect(NEW."lateSuccessId"); END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION billing_reconciliation_case_one_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."caseType" = 'late_success' THEN PERFORM billing_late_success_one_effect(NEW."evidenceKey"); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_payment_04_one_effect BEFORE INSERT ON recovery_payment FOR EACH ROW EXECUTE FUNCTION billing_recovery_payment_one_effect_guard();
CREATE TRIGGER reconciliation_case_04_one_effect BEFORE INSERT ON reconciliation_case FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_case_one_effect_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── its full refund (L-3, BIL-23 H)

ALTER TABLE refund_case DROP CONSTRAINT refund_case_capture_shape;
ALTER TABLE refund_case ADD CONSTRAINT refund_case_capture_shape CHECK (
  CASE WHEN eligibility = 'capture_specific'
    THEN "captureFactId" IS NOT NULL AND "captureBasis" IN ('late_capture', 'duplicate_capture', 'unrouted_capture')
         AND ("receiptId" IS NOT NULL) = ("captureBasis" = 'unrouted_capture')
  WHEN eligibility IN ('recovery_surplus', 'late_assisted_settlement') AND "captureFactId" IS NOT NULL
    THEN "captureBasis" = 'late_capture' AND "receiptId" IS NULL
  ELSE "captureFactId" IS NULL AND "captureBasis" IS NULL AND "receiptId" IS NOT NULL END);

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
    -- Core V2 S0-C8 (LS-6): the capture that evidences a late assisted settlement is refunded by that settlement's own case (L-3), never as
    -- a capture-specific one: its reconciliation case resolves only by a `late_assisted_settlement` refund of exactly that capture
    IF EXISTS (SELECT 1 FROM assistance_late_settlement l JOIN payment_late_success s ON s."lateSuccessId" = l."lateSuccessId"
                WHERE s."factId" = NEW."captureFactId") THEN
      RAISE EXCEPTION 'refund case: capture % evidences a late assisted settlement', NEW."captureFactId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_not_eligible';
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

  -- Core V2 S0-C8 (L-3, LS-6): a late assisted settlement recorded from Payment's LATE success (its request stays failed, cancelled or
  -- expired, so no ordinary refund can return it) is refunded in full as exactly its captured movement: a `late_assisted_settlement` case
  -- naming the late success's capture fact, with no `payment.succeeded` receipt; completion is `none` (the request keeps its obligation)
  IF NEW.eligibility = 'late_assisted_settlement' AND NEW."captureFactId" IS NOT NULL THEN
    IF pr.id IS NULL OR pr."paymentId" IS DISTINCT FROM NEW."paymentId" OR pr."invoiceId" <> NEW."invoiceId" OR routing.purpose IS DISTINCT FROM 'assisted_settlement'
       OR inv."sellerType" <> 'company' OR inv."sellerId" <> NEW."companyId"::text OR NEW."organizationId" IS DISTINCT FROM inv."organizationId"
       OR cardinality(platforms) <> 1 OR platforms[1] IS NULL OR platforms[1] <> NEW."platformId"
       OR NOT EXISTS (
         SELECT 1 FROM assistance_late_settlement l JOIN payment_late_success s ON s."lateSuccessId" = l."lateSuccessId"
          WHERE l.id = NEW."lateSettlementId" AND l."invoiceId" = pr."invoiceId" AND l."paymentRequestId" = pr.id
            AND s."factId" = NEW."captureFactId" AND s.amount = NEW.amount AND trim(s.currency) = trim(NEW.currency))
       OR EXISTS (SELECT 1 FROM subscription_purchase s WHERE s."invoiceId" = pr."invoiceId") THEN
      RAISE EXCEPTION 'refund case: payment % is not eligible', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_not_eligible';
    END IF;
    -- R6H-5: never overlapping an unresolved capture-specific refund of the payment
    IF EXISTS (SELECT 1 FROM refund_case c WHERE c."paymentId" = NEW."paymentId" AND c.eligibility = 'capture_specific' AND c.status = 'open') THEN
      RAISE EXCEPTION 'refund case: payment % has a capture-specific refund case', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_exposure';
    END IF;
    NEW."openedAt" := now();
    RETURN NEW;
  END IF;

  -- Core V2 S6h-B (R6H-4, R-3a with R6H-5): an ENTIRELY surplus recovery payment that came from Payment's LATE success (its request stays
  -- failed or cancelled, so no ordinary refund can return it) is refunded as exactly its captured movement: a `recovery_surplus` case naming
  -- the late success's capture fact; completion resolves the surplus (S6f Path A), no purchase, no obligation
  IF NEW.eligibility = 'recovery_surplus' AND NEW."captureFactId" IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('billing.recovery_surplus:' || NEW."surplusId", 0));
    IF pr.id IS NULL OR pr."paymentId" IS DISTINCT FROM NEW."paymentId" OR pr."invoiceId" <> NEW."invoiceId" OR routing.purpose IS DISTINCT FROM 'recovery_settlement'
       OR inv."sellerType" <> 'company' OR inv."sellerId" <> NEW."companyId"::text OR NEW."organizationId" IS DISTINCT FROM inv."organizationId"
       OR NOT EXISTS (
         SELECT 1 FROM recovery_surplus su JOIN recovery_payment p ON p.id = su."recoveryPaymentId" JOIN payment_late_success l ON l."lateSuccessId" = p."lateSuccessId"
          WHERE su.id = NEW."surplusId" AND p."paymentRequestId" = pr.id AND p."principalAmount" = 0 AND su.amount = NEW.amount AND trim(su.currency) = trim(NEW.currency)
            AND l."factId" = NEW."captureFactId"
            AND NOT EXISTS (SELECT 1 FROM recovery_surplus_external x WHERE x."surplusId" = su.id)) THEN
      RAISE EXCEPTION 'refund case: payment % is not eligible', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_not_eligible';
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
