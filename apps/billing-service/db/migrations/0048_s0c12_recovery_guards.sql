-- Core V2 S0-C12 (S0 §1.5 S0-C12 items 3 and 4; register BIL-28 G and BIL-23 I; the Owner's D-1 and D-B, adopted by #467). EXPAND ONLY.
--
-- D-1: a late success of a `recovery_settlement` payment counts (a `recovery_payment`) only when its amount and currency equal the recovery
-- invoice's total and currency exactly. The existing guard (0042) checks only that the recovery payment equals the late success's own amount; a
-- separate trigger now refuses a late success that differs from the invoice (`recovery_payment_late_success_equal`). An ordinary success
-- (`receiptId`) is unchanged: 0039/0042 already require it to equal its payment request. Rows already recorded are unchanged (no backfill).
--
-- D-B: the capture-specific refund case (`late_capture`) becomes admissible for a `recovery_settlement` payment ONLY for a late capture that
-- S0-C12 item 3 excluded: Billing's own record of Payment's verified late success of that payment request names the fact, differs from the
-- recovery invoice's total or currency, and no `recovery_payment` names it; the case is for exactly that late success's amount and currency.
-- `billing_refund_case_insert_guard` is 0044's text with only that condition changed. Never a counted recovery payment, a surplus, a principal
-- or another capture; every other refund rule is unchanged.

CREATE FUNCTION billing_recovery_payment_late_success_equal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."lateSuccessId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payment_late_success l JOIN invoice i ON i.id = NEW."invoiceId"
     WHERE l."lateSuccessId" = NEW."lateSuccessId" AND l.amount = i.total AND trim(l.currency) = trim(i.currency)) THEN
    RAISE EXCEPTION 'recovery payment: a late success counts only for exactly the recovery invoice''s total and currency (S0-C12 D-1)'
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_payment_late_success_equal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_payment_06_late_success_equal BEFORE INSERT ON recovery_payment
  FOR EACH ROW EXECUTE FUNCTION billing_recovery_payment_late_success_equal_guard();

CREATE FUNCTION billing_recovery_capture_refundable(p_request uuid, p_fact uuid, p_basis text, p_amount bigint, p_currency text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_basis = 'late_capture' AND p_fact IS NOT NULL AND EXISTS (
    SELECT 1 FROM payment_late_success l JOIN payment_request pr ON pr.id = l."paymentRequestId" JOIN invoice i ON i.id = pr."invoiceId"
     WHERE l."paymentRequestId" = p_request AND l."factId" = p_fact
       AND (l.amount <> i.total OR trim(l.currency) <> trim(i.currency))
       AND l.amount = p_amount AND trim(l.currency) = trim(p_currency)
       AND NOT EXISTS (SELECT 1 FROM recovery_payment p WHERE p."lateSuccessId" = l."lateSuccessId"))
$$;

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
    -- R6H-5: the payment request is Payment's payment, of this invoice; never an Organization subscription; a recovery payment only under
    -- Core V2 S0-C12 D-B (BIL-23 I): exactly the late capture S0-C12 item 3 excluded from recovery, for exactly its own amount and currency
    IF pr.id IS NULL OR pr."paymentId" IS DISTINCT FROM NEW."paymentId" OR pr."invoiceId" <> NEW."invoiceId"
       OR routing.purpose = 'organization_subscription'
       OR (routing.purpose = 'recovery_settlement'
           AND NOT billing_recovery_capture_refundable(pr.id, NEW."captureFactId", NEW."captureBasis", NEW.amount, NEW.currency)) THEN
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

  -- Core V2 S0-C8 PR-2b (BIL-23 H): a purchase applied under L-4 from Payment's LATE success is refunded only as a Personal purchase of
  -- exactly that capture (its request stays final, so no ordinary refund can return it); completion applies S6d's effects
  IF NEW.eligibility = 'personal_purchase' AND NEW."captureFactId" IS NOT NULL THEN
    IF pr.id IS NULL OR pr."paymentId" IS DISTINCT FROM NEW."paymentId" OR pr."invoiceId" <> NEW."invoiceId" OR routing.purpose IS DISTINCT FROM 'assisted_settlement'
       OR inv."sellerType" <> 'company' OR inv."sellerId" <> NEW."companyId"::text OR NEW."organizationId" IS DISTINCT FROM inv."organizationId"
       OR cardinality(platforms) <> 1 OR platforms[1] IS NULL OR platforms[1] <> NEW."platformId"
       OR NOT EXISTS (
         SELECT 1 FROM subscription_purchase p JOIN payment_late_success s ON s."lateSuccessId" = p."lateSuccessId"
          WHERE p.id = NEW."purchaseId" AND p."invoiceId" = pr."invoiceId" AND p."paymentRequestId" = pr.id AND p.purpose = 'assisted_settlement'
            AND s."factId" = NEW."captureFactId" AND s.amount = NEW.amount AND trim(s.currency) = trim(NEW.currency)
            AND NOT EXISTS (SELECT 1 FROM subscription_purchase_reversal v WHERE v."purchaseId" = p.id)) THEN
      RAISE EXCEPTION 'refund case: payment % is not eligible', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_not_eligible';
    END IF;
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
