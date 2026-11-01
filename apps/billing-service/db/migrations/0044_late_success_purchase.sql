-- 0044 — billing-service: Core V2 S0-C8 PR-2b, the L-4 purchase evidenced by Payment's verified LATE success (S0 §1.5 S0-C8 items 5 to 8;
-- S0 §3.4 L-4 to L-6, §3.2 DB-9, DB-10, DB-12, DB-14; register BIL-32 G, BIL-23 H; the Owner's LS-2, LS-3, LS-6, LS-7, LS-9, 2026-11-01).
-- DEVELOPMENT AND SIMULATION ONLY.
--
--   * subscription_purchase: a second, verified evidence for an L-4 purchase only: Payment's `lateSuccessId` (unique; its capture fact is
--     unique in `payment_late_success`), never a fabricated `payment.succeeded` receipt. Exactly one of `receiptId` and `lateSuccessId`; the
--     late-success one only for an applied (`appliedAt`) assisted purchase. The guard re-checks the evidence: this invoice's late assisted
--     settlement of that late success, the payment request still in Payment's own final unsuccessful state, the invoice paid, the full
--     amount and currency, and `settledAt` = Payment's `recordedAt` (LS-2). DB-9 (composite routing FK), DB-10 (`UNIQUE(invoiceId)`) and
--     DB-12 (one purchase per request) are unchanged.
--   * invoice (BI-14, LS-3): an assisted settlement invoice may also become `paid` through its late assisted settlement's L-4 application
--     from a late success for its full total (`paidAt` = Payment's `recordedAt`); the payment request and the closed channel never change.
--   * late_settlement_application: refused over a verified chargeback of the payment (`late_settlement_chargeback_recorded`, LS-7, an
--     Owner-approved POLICY ADDITION: S0-C8 item 8; both inputs); a late success's evidence re-checked; commits with its paid invoice.
--   * refund_case (BIL-23 H): such a purchase is refunded only as a `personal_purchase` case naming its capture (basis `late_capture`, no
--     receipt), executed by Payment's capture-specific refund, with S6d's effects; one live case per capture fact (0041) unchanged.
-- Expand only: one nullable column, one relaxed NOT NULL (by CHECK), replaced guards.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the purchase's evidence

ALTER TABLE subscription_purchase ALTER COLUMN "receiptId" DROP NOT NULL;
ALTER TABLE subscription_purchase ADD COLUMN "lateSuccessId" uuid UNIQUE REFERENCES payment_late_success ("lateSuccessId");
ALTER TABLE subscription_purchase ADD CONSTRAINT subscription_purchase_evidence CHECK (("receiptId" IS NULL) <> ("lateSuccessId" IS NULL));
ALTER TABLE subscription_purchase ADD CONSTRAINT subscription_purchase_late_success_shape
  CHECK ("lateSuccessId" IS NULL OR (purpose = 'assisted_settlement' AND "appliedAt" IS NOT NULL AND "assistanceRequestId" IS NOT NULL));

CREATE OR REPLACE FUNCTION billing_subscription_purchase_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE span record;
BEGIN
  NEW."transactionId" := pg_current_xact_id();
  IF NEW."lateSuccessId" IS NOT NULL THEN
    -- Core V2 S0-C8 item 5, 6 (PR-2b): an L-4 purchase evidenced by Payment's verified LATE success: the one recorded for exactly this invoice's
    -- late assisted settlement, whose payment request stays final in Payment's own unsuccessful state, the invoice paid by the application
    IF NOT EXISTS (
      SELECT 1 FROM payment_late_success s
        JOIN assistance_late_settlement l ON l."lateSuccessId" = s."lateSuccessId"
        JOIN payment_request pr ON pr.id = s."paymentRequestId"
        JOIN invoice i ON i.id = pr."invoiceId"
       WHERE s."lateSuccessId" = NEW."lateSuccessId" AND s."factId" IS NOT NULL AND l."invoiceId" = NEW."invoiceId" AND l."paymentRequestId" = NEW."paymentRequestId"
         AND s."paymentRequestId" = NEW."paymentRequestId" AND pr."invoiceId" = NEW."invoiceId" AND pr.status IN ('failed', 'cancelled', 'expired')
         AND pr.status = s."paymentStatus" AND i.status = 'paid' AND i.total = s.amount AND trim(i.currency) = trim(s.currency)
         AND NEW."settledAt" = s."recordedAt"
    ) THEN
      RAISE EXCEPTION 'subscription_purchase: invoice % has no verified late success of its late assisted settlement', NEW."invoiceId"
        USING ERRCODE = '23514', CONSTRAINT = 'subscription_purchase_verified';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM payment_event_receipt r
      JOIN payment_request pr ON pr.id = r."paymentRequestId"
      JOIN invoice i ON i.id = pr."invoiceId"
     WHERE r.id = NEW."receiptId" AND r.outcome = 'applied' AND r."eventName" = 'payment.succeeded'
       AND r."paymentRequestId" = NEW."paymentRequestId" AND pr."invoiceId" = NEW."invoiceId" AND pr.status = 'paid' AND i.status = 'paid'
  ) THEN
    RAISE EXCEPTION 'subscription_purchase: invoice % has no verified settlement (applied payment.succeeded, request and invoice paid)', NEW."invoiceId"
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_purchase_verified';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoice_line l WHERE l."invoiceId" = NEW."invoiceId" AND l."priceId" = NEW."priceId" AND l."productId" = NEW."productId") THEN
    RAISE EXCEPTION 'subscription_purchase: price % is not a line of invoice %', NEW."priceId", NEW."invoiceId"
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_purchase_line';
  END IF;
  SELECT * INTO span FROM billing_personal_spans(NEW."personalSubscriptionId", coalesce(NEW."appliedAt", NEW."settledAt"), NEW."priceId") s WHERE s."purchaseId" IS NULL;
  NEW."originalStart" := span."effectiveStart";
  NEW."originalEnd" := span."effectiveEnd";
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION billing_assisted_purchase_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF NEW.purpose <> 'assisted_settlement' OR NEW."assistanceRequestId" IS NULL THEN RETURN NEW; END IF; -- the CHECK refuses an assisted one without it
  SELECT * INTO r FROM assistance_request WHERE id = NEW."assistanceRequestId" FOR UPDATE;
  IF NEW."appliedAt" IS NOT NULL THEN
    -- Core V2 S6g (L-4): only this invoice's late settlement's application, in its transaction, after any live obligation was superseded,
    -- with Payment's original instant and the application instant
    IF r.status IS DISTINCT FROM 'cash_collected'
       OR EXISTS (SELECT 1 FROM cash_return_obligation o WHERE o."assistanceRequestId" = r.id AND o.status IN ('open', 'return_reported'))
       OR NOT EXISTS (SELECT 1 FROM late_settlement_application a JOIN assistance_late_settlement l ON l.id = a."lateSettlementId"
                       WHERE l."invoiceId" = NEW."invoiceId" AND a."assistanceRequestId" = r.id
                         AND ((NEW."receiptId" IS NOT NULL AND l."receiptId" = NEW."receiptId") OR (NEW."lateSuccessId" IS NOT NULL AND l."lateSuccessId" = NEW."lateSuccessId"))
                         AND a."appliedAt" = NEW."appliedAt" AND a."settledAt" = NEW."settledAt") THEN
      RAISE EXCEPTION 'assistance request %: an applied late purchase needs its late-settlement application', NEW."assistanceRequestId"
        USING ERRCODE = '23514', CONSTRAINT = 'subscription_purchase_assisted_applicable';
    END IF;
    RETURN NEW;
  END IF;
  IF r.status IS DISTINCT FROM 'cash_collected'
     OR EXISTS (SELECT 1 FROM cash_return_obligation o WHERE o."assistanceRequestId" = r.id)
     OR NOT EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."invoiceId" = NEW."invoiceId" AND c."assistanceRequestId" = r.id AND c.status IN ('open', 'uncertain')) THEN
    RAISE EXCEPTION 'assistance request %: no purchase after closure, a cash-return obligation or another purchase', NEW."assistanceRequestId"
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_purchase_assisted_applicable';
  END IF;
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── its invoice (BI-14, LS-3)

CREATE OR REPLACE FUNCTION billing_invoice_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  issuing boolean := OLD.status = 'draft' AND NEW.status = 'open';
  paying  boolean := OLD.status = 'open' AND NEW.status = 'paid';
  voiding boolean := NEW.status = 'void' AND OLD.status <> 'void';
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- BI-16: exactly these moves. `open -> void` is NOT here: it needs B-015 (a migration adds it when decided).
    IF NOT ((OLD.status = 'draft' AND NEW.status IN ('open', 'void')) OR paying) THEN
      RAISE EXCEPTION 'invoice % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  END IF;

  IF issuing THEN
    NEW."issuedAt" := now();
    -- BI-10: the number is assigned ONLY here, by the counter, in this transaction (lock order: invoice, then the sequence row).
    -- Whatever number the caller supplied is discarded; a rollback returns the number.
    NEW.number := billing_allocate_invoice_number(NEW."sellerType", NEW."sellerId");
  ELSIF NEW.number IS DISTINCT FROM OLD.number OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt" THEN
    RAISE EXCEPTION 'invoice %: number and issuedAt are set once, at issue', OLD.id USING ERRCODE = '23514';
  END IF;

  -- BI-20: the presentation snapshot is set exactly once, by the issue transition
  IF NEW.presentation IS DISTINCT FROM OLD.presentation AND NOT (issuing AND OLD.presentation IS NULL) THEN
    RAISE EXCEPTION 'invoice %: presentation is set once, at issue', OLD.id USING ERRCODE = '23514';
  END IF;

  IF voiding THEN
    NEW."voidedAt" := now();
  ELSIF NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt" OR NEW."voidReasonCode" IS DISTINCT FROM OLD."voidReasonCode" THEN
    RAISE EXCEPTION 'invoice %: voidedAt and voidReasonCode are set only when voiding', OLD.id USING ERRCODE = '23514';
  END IF;

  IF paying THEN
    -- BI-14: `paid` only through a payment request that is `paid` for the full total, in this same transaction.
    -- Core V2 S0-C8 item 5 (LS-3): OR, for an assisted settlement invoice only, the Owner's L-4 application of its late assisted settlement
    -- evidenced by Payment's verified late success for the full total (the payment request stays in Payment's final unsuccessful state)
    IF NOT EXISTS (SELECT 1 FROM payment_request WHERE "invoiceId" = NEW.id AND status = 'paid' AND amount = NEW.total)
       AND NOT (NEW.producer = 'billing-assistance' AND EXISTS (
         SELECT 1 FROM late_settlement_application a JOIN assistance_late_settlement l ON l.id = a."lateSettlementId"
           JOIN payment_late_success s ON s."lateSuccessId" = l."lateSuccessId"
          WHERE l."invoiceId" = NEW.id AND s.amount = NEW.total AND trim(s.currency) = trim(NEW.currency) AND NEW."paidAt" = s."recordedAt")) THEN
      RAISE EXCEPTION 'invoice % can become paid only through a paid payment request for its full total', OLD.id USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."paidAt" IS DISTINCT FROM OLD."paidAt" THEN
    RAISE EXCEPTION 'invoice %: paidAt is set only when the invoice is paid', OLD.id USING ERRCODE = '23514';
  END IF;

  -- overdueAt only marks that invoice.overdue was emitted: set once, and only while the invoice is open
  IF NEW."overdueAt" IS DISTINCT FROM OLD."overdueAt" AND (OLD."overdueAt" IS NOT NULL OR OLD.status <> 'open') THEN
    RAISE EXCEPTION 'invoice %: overdueAt is set once, while open', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the application (LS-7) and its commit

CREATE OR REPLACE FUNCTION billing_late_settlement_application_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l record; r record; o record; settled timestamptz;
BEGIN
  SELECT * INTO l FROM assistance_late_settlement WHERE id = NEW."lateSettlementId";
  SELECT * INTO r FROM assistance_request WHERE id = NEW."assistanceRequestId";
  IF l.id IS NULL OR r.id IS NULL OR l."assistanceRequestId" <> r.id THEN
    RAISE EXCEPTION 'late settlement %: not this request''s', NEW."lateSettlementId" USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_application_basis';
  END IF;
  PERFORM billing_assistance_organization_lock(r."organizationId");
  SELECT * INTO r FROM assistance_request WHERE id = NEW."assistanceRequestId" FOR UPDATE;
  IF r."organizationId" <> NEW."organizationId" OR r."platformId" <> NEW."platformId" OR r."beneficiaryUserId" <> NEW."beneficiaryUserId"
     OR NOT EXISTS (SELECT 1 FROM billing_platform b WHERE b."platformId" = r."platformId" AND b."companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'late settlement %: another Organization, Platform, beneficiary or Company', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_application_basis';
  END IF;
  -- L-6 and L-5
  IF EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."assistanceRequestId" = r.id) THEN
    RAISE EXCEPTION 'late settlement % refused: purchase exists', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_purchase_exists';
  END IF;
  IF EXISTS (SELECT 1 FROM cash_return_obligation c WHERE c."assistanceRequestId" = r.id AND c.status = 'confirmed_returned') THEN
    RAISE EXCEPTION 'late settlement % refused: cash return confirmed', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_cash_return_confirmed';
  END IF;
  IF r.status <> 'cash_collected' THEN
    RAISE EXCEPTION 'late settlement % refused: request not settleable', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_request_not_settleable';
  END IF;
  SELECT * INTO o FROM cash_return_obligation c WHERE c."assistanceRequestId" = r.id AND c.status IN ('open', 'return_reported') FOR UPDATE;
  IF o.status = 'return_reported' THEN -- R6G-2: the Organization's report contradicts the attestation or evidence
    RAISE EXCEPTION 'late settlement % refused: cash return reported', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_cash_return_reported';
  END IF;
  IF NEW."obligationId" IS DISTINCT FROM o.id OR (o.id IS NOT NULL AND o.origin <> 'deadline') THEN
    RAISE EXCEPTION 'late settlement %: not the request''s live deadline obligation', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_application_basis';
  END IF;
  IF EXISTS (SELECT 1 FROM assistance_dispute d WHERE d."assistanceRequestId" = r.id AND d.status = 'open') THEN
    RAISE EXCEPTION 'late settlement % refused: dispute open', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_dispute_open';
  END IF;
  IF EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."assistanceRequestId" = r.id AND c."invoiceId" <> l."invoiceId" AND c.status IN ('open', 'uncertain')) THEN
    RAISE EXCEPTION 'late settlement % refused: another settlement in progress', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_channel_open';
  END IF;
  -- R6G-7: no refund case on this payment that is open, completed, or that ever relayed an authorization (a cancelled case is not proof
  -- that no provider refund attempt is unresolved); the payment request lock is the refund case's own lock
  PERFORM 1 FROM payment_request WHERE id = l."paymentRequestId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM refund_case c WHERE c."paymentRequestId" = l."paymentRequestId"
              AND (c.status <> 'cancelled' OR EXISTS (SELECT 1 FROM refund_authorization_relay x WHERE x."refundCaseId" = c.id))) THEN
    RAISE EXCEPTION 'late settlement % refused: refund exists', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_refund_exists';
  END IF;
  -- Core V2 S0-C8 item 8 (LS-7, an Owner-approved policy addition): never over a verified chargeback of that payment (both inputs)
  IF EXISTS (SELECT 1 FROM payment_dispute_loss d WHERE d."paymentRequestId" = l."paymentRequestId") THEN
    RAISE EXCEPTION 'late settlement % refused: chargeback recorded', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_chargeback_recorded';
  END IF;
  -- Core V2 S0-C8 item 1 (b): its late success is still exactly what was classified (append-only evidence; re-checked, never trusted)
  IF l."lateSuccessId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payment_late_success s JOIN payment_request pr ON pr.id = s."paymentRequestId"
     WHERE s."lateSuccessId" = l."lateSuccessId" AND s."paymentRequestId" = l."paymentRequestId" AND s."factId" IS NOT NULL
       AND pr.status = s."paymentStatus" AND pr.status IN ('failed', 'cancelled', 'expired')
       AND EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."invoiceId" = l."invoiceId" AND c."paymentRequestId" = pr.id AND c.status = 'closed')) THEN
    RAISE EXCEPTION 'late settlement %: its late success is not verified evidence', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_application_basis';
  END IF;
  -- R6G-2, R6G-3: the matching evidence path; any contrary statement by the beneficiary refuses both paths
  IF EXISTS (SELECT 1 FROM late_settlement_attestation a WHERE a."lateSettlementId" = l.id AND a.statement = 'cash_returned') THEN
    RAISE EXCEPTION 'late settlement % refused: contradictory attestation', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_evidence_contradictory';
  END IF;
  IF NEW."reasonCode" = 'cash_not_returned_attested' AND NOT EXISTS (
    SELECT 1 FROM late_settlement_attestation a WHERE a.id = NEW."attestationId" AND a."lateSettlementId" = l.id AND a.statement = 'cash_not_returned') THEN
    RAISE EXCEPTION 'late settlement % refused: no attestation', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_evidence_insufficient';
  END IF;
  settled := billing_late_settlement_settled_at(l.id);
  IF settled IS NULL OR NEW."settledAt" IS DISTINCT FROM settled THEN
    RAISE EXCEPTION 'late settlement % refused: original settlement instant unavailable', l.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_time_unavailable';
  END IF;
  NEW."appliedAt" := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION billing_late_settlement_application_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."reasonCode" = 'cash_not_returned_evidenced' AND NOT EXISTS (SELECT 1 FROM late_settlement_evidence e WHERE e."applicationId" = NEW.id) THEN
    RAISE EXCEPTION 'late settlement application %: evidence is required', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_evidence_insufficient';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscription_purchase p JOIN assistance_late_settlement l ON l."invoiceId" = p."invoiceId"
                  WHERE l.id = NEW."lateSettlementId" AND p."assistanceRequestId" = NEW."assistanceRequestId" AND p."appliedAt" = NEW."appliedAt")
     OR NOT EXISTS (SELECT 1 FROM assistance_request a WHERE a.id = NEW."assistanceRequestId" AND a.status = 'settled')
     -- Core V2 S0-C8 (LS-3): an application from a late success also commits its invoice `paid`
     OR NOT EXISTS (SELECT 1 FROM assistance_late_settlement l JOIN invoice i ON i.id = l."invoiceId" WHERE l.id = NEW."lateSettlementId" AND i.status = 'paid')
     OR (NEW."obligationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cash_return_obligation c WHERE c.id = NEW."obligationId" AND c.status = 'superseded_by_settlement'
                                                        AND c."supersededByApplicationId" = NEW.id)) THEN
    RAISE EXCEPTION 'late settlement application %: its purchase, settled request and superseded obligation commit together', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_application_atomic';
  END IF;
  RETURN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── its refund (BIL-23 H)

ALTER TABLE refund_case DROP CONSTRAINT refund_case_capture_shape;
ALTER TABLE refund_case ADD CONSTRAINT refund_case_capture_shape CHECK (
  CASE WHEN eligibility = 'capture_specific'
    THEN "captureFactId" IS NOT NULL AND "captureBasis" IN ('late_capture', 'duplicate_capture', 'unrouted_capture')
         AND ("receiptId" IS NOT NULL) = ("captureBasis" = 'unrouted_capture')
  WHEN eligibility IN ('recovery_surplus', 'late_assisted_settlement', 'personal_purchase') AND "captureFactId" IS NOT NULL
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
