-- 0042 — billing-service: reconciliation cases, Payment late successes, real recovery surplus and FinancialLoss (Core V2 S6h-B; register
-- BIL-33, BIL-34, EVT-10, PAY-12; S0 FC-1, FC-4, FC-5, FC-6, §3.4 L-1 to L-6, §3.5 R-1 to R-5; ADR-0044 B5, B9, B11; the Owner's R6H-1 to
-- R6H-12, 2026-10-30). DEVELOPMENT AND SIMULATION ONLY.
--
--   * payment_late_success (R6H-4, EVT-10): Payment's VERIFIED success of a payment after it ended, once per late success and per provider
--     fact, from `payment.late_success.recorded` or (event lost) Payment's reconciliation read. Never a `payment.succeeded`; the payment
--     request keeps its terminal state. Classified by the request's OWN routing purpose:
--       - recovery_settlement: a `recovery_payment` (every distinct verified success counts once, R6H-4), split by the database into the
--         principal still outstanding and the surplus beyond the base (R-1); T3 clears only when verified principal reaches the base;
--       - anything else: a reconciliation case (L-1, L-2: no purchase, no entitlement), resolved only by a completed capture-specific refund.
--   * reconciliation_case (R6H-1, R6H-2): one durable case per (type, evidence), deterministic, opened by the sweeper from Billing's records
--     and Payment's reconciliation read, new and historical alike; APPEND-ONLY. Its resolution is a separate, append-only row, checked by the
--     database against the evidence its kind names: a completed refund, an applied late settlement, a resolved surplus, a recognized loss, an
--     applied effect, a definitive authorization outcome, or (review-only types only) the Owner's acknowledgement. No generic close.
--   * financial_loss (R6H-7, FC-6): only from recorded evidence, keyed per (kind, evidence): `over_return` (the verified allocation EXCESS
--     Payment reports, never the whole refund), `direct_chargeback_write_off` (a FULL final-lost chargeback of a DIRECT purchase with its
--     verified chargeback fact and no completed refund of that payment), `recovery_write_off` (the Owner's write-off of an open obligation's
--     outstanding principal, with Auth's dedicated receipt; accounting only: the obligation and T3 stay). Corrections are append-only
--     `financial_loss_adjustment` rows (a later verified recovery reduces a write-off), never an edit.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── Payment's late successes

-- the verified origin of Payment's late-success event is recorded like every other consumed Payment event
ALTER TABLE payment_event_origin DROP CONSTRAINT payment_event_origin_name;
ALTER TABLE payment_event_origin ADD CONSTRAINT payment_event_origin_name CHECK ("eventName" IN ('payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired',
  'refund.case_completed', 'payment.dispute.lost', 'payment.late_success.recorded'));

CREATE TABLE payment_late_success (
  "lateSuccessId"      uuid PRIMARY KEY,                                  -- Payment's late success
  "paymentId"          uuid NOT NULL,
  "paymentRequestId"   uuid NOT NULL REFERENCES payment_request (id),
  "factId"             uuid UNIQUE,                                       -- Payment's verified capture fact: never counted twice
  amount               bigint NOT NULL,                                   -- the verified captured amount
  currency             char(3) NOT NULL,
  "paymentStatus"      text NOT NULL,                                     -- the payment's terminal state, unchanged
  "recordedAt"         timestamptz NOT NULL,                              -- Payment's instant
  source               text NOT NULL,
  "eventId"            uuid UNIQUE,
  "receivedAt"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_late_success_amount CHECK (amount > 0 AND amount <= 9007199254740991 AND currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payment_late_success_status CHECK ("paymentStatus" IN ('succeeded', 'failed', 'expired', 'cancelled')),
  CONSTRAINT payment_late_success_source CHECK (source IN ('event', 'reconciliation') AND ((source = 'event') = ("eventId" IS NOT NULL)))
);
CREATE FUNCTION billing_payment_late_success_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payment_request r WHERE r.id = NEW."paymentRequestId" AND r."paymentId" = NEW."paymentId") THEN
    RAISE EXCEPTION 'late success: payment % is not this payment request''s', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'payment_late_success_payment';
  END IF;
  NEW."receivedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER payment_late_success_05_guard BEFORE INSERT ON payment_late_success FOR EACH ROW EXECUTE FUNCTION billing_payment_late_success_guard();
CREATE TRIGGER payment_late_success_10_append_only BEFORE UPDATE OR DELETE ON payment_late_success FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER payment_late_success_11_no_truncate BEFORE TRUNCATE ON payment_late_success FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── a late success recovers (R6H-4, §3.5)

-- a recovery payment is EITHER the applied `payment.succeeded` of its request (S6f) OR one late success; one ordinary success per request,
-- one recovery payment per late success (so per provider fact)
ALTER TABLE recovery_payment ALTER COLUMN "receiptId" DROP NOT NULL;
ALTER TABLE recovery_payment ADD COLUMN "lateSuccessId" uuid UNIQUE REFERENCES payment_late_success ("lateSuccessId");
ALTER TABLE recovery_payment ADD CONSTRAINT recovery_payment_evidence CHECK (("receiptId" IS NULL) <> ("lateSuccessId" IS NULL));
ALTER TABLE recovery_payment DROP CONSTRAINT "recovery_payment_paymentRequestId_key";
CREATE UNIQUE INDEX recovery_payment_request_success ON recovery_payment ("paymentRequestId") WHERE "receiptId" IS NOT NULL;
CREATE INDEX recovery_payment_request_idx ON recovery_payment ("paymentRequestId");

CREATE OR REPLACE FUNCTION billing_recovery_payment_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o recovery_obligation%ROWTYPE; pr record; l payment_late_success%ROWTYPE; outstanding bigint;
BEGIN
  SELECT * INTO o FROM recovery_obligation WHERE id = NEW."obligationId";
  PERFORM pg_advisory_xact_lock(hashtextextended('billing.recovery:' || NEW."obligationId", 0));
  SELECT * INTO pr FROM payment_request WHERE id = NEW."paymentRequestId";
  IF NEW."receiptId" IS NOT NULL THEN
    IF pr."invoiceId" IS DISTINCT FROM NEW."invoiceId" OR pr.status IS DISTINCT FROM 'paid' OR NEW.amount <> pr.amount OR NEW.currency <> pr.currency
       OR NOT EXISTS (SELECT 1 FROM payment_event_receipt r WHERE r.id = NEW."receiptId" AND r."paymentRequestId" = pr.id AND r."eventName" = 'payment.succeeded' AND r.outcome = 'applied') THEN
      RAISE EXCEPTION 'recovery payment: not the verified success of this recovery invoice' USING ERRCODE = '23514', CONSTRAINT = 'recovery_payment_verified';
    END IF;
  ELSE
    -- S6h-B (R6H-4): Payment's verified late success of this recovery invoice's payment, for exactly its captured amount
    SELECT * INTO l FROM payment_late_success WHERE "lateSuccessId" = NEW."lateSuccessId";
    IF l."lateSuccessId" IS NULL OR l."paymentRequestId" <> NEW."paymentRequestId" OR pr."invoiceId" IS DISTINCT FROM NEW."invoiceId"
       OR l.amount <> NEW.amount OR l.currency <> NEW.currency THEN
      RAISE EXCEPTION 'recovery payment: not the verified late success of this recovery invoice' USING ERRCODE = '23514', CONSTRAINT = 'recovery_payment_verified';
    END IF;
  END IF;
  IF NEW.currency <> o.currency THEN
    RAISE EXCEPTION 'recovery payment: in the obligation''s currency' USING ERRCODE = '23514', CONSTRAINT = 'recovery_payment_currency';
  END IF;
  outstanding := GREATEST(0, billing_recovery_outstanding(NEW."obligationId"));
  NEW."principalAmount" := LEAST(NEW.amount, outstanding);
  NEW."surplusAmount" := NEW.amount - NEW."principalAmount";
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the late surplus is refundable (R-3a)

ALTER TABLE refund_case DROP CONSTRAINT refund_case_capture_shape;
ALTER TABLE refund_case ADD CONSTRAINT refund_case_capture_shape CHECK (
  CASE WHEN eligibility = 'capture_specific'
    THEN "captureFactId" IS NOT NULL AND "captureBasis" IN ('late_capture', 'duplicate_capture', 'unrouted_capture')
         AND ("receiptId" IS NOT NULL) = ("captureBasis" = 'unrouted_capture')
  WHEN eligibility = 'recovery_surplus' AND "captureFactId" IS NOT NULL
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
    -- never overlapping an unresolved ordinary refund of the same payment
    IF EXISTS (SELECT 1 FROM refund_case c WHERE c."paymentId" = NEW."paymentId" AND c.eligibility <> 'capture_specific' AND c.status = 'open')
       OR (NEW."captureBasis" = 'unrouted_capture'
           AND EXISTS (SELECT 1 FROM refund_case c WHERE c."paymentId" = NEW."paymentId" AND c.eligibility <> 'capture_specific' AND c.status = 'completed')) THEN
      RAISE EXCEPTION 'refund case: payment % has an ordinary refund case', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_exposure';
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

-- ─────────────────────────────────────────────────────────────────────────────────────────────── FinancialLoss (R6H-7, R6H-8, FC-6)

CREATE TABLE financial_loss (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL,
  "evidenceKey"      uuid NOT NULL,                                     -- the refund fact, the chargeback fact, or the obligation
  "companyId"        uuid NOT NULL,
  "organizationId"   uuid,
  "paymentId"        uuid,
  "disputeId"        uuid REFERENCES payment_dispute_loss ("disputeId"),
  "obligationId"     uuid REFERENCES recovery_obligation (id),
  amount             bigint NOT NULL,
  currency           char(3) NOT NULL,
  "recordedByUserId" uuid,                                              -- the Owner (write-off); NULL: the reconciliation worker
  "receiptId"        uuid UNIQUE,                                       -- Auth's consumed `recovery_write_off` receipt
  "consumeRef"       uuid UNIQUE,                                       -- its deterministic consume reference (a replay is answered, never re-consumed)
  "recordedAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_loss_kind CHECK (kind IN ('over_return', 'direct_chargeback_write_off', 'recovery_write_off')),
  CONSTRAINT financial_loss_once UNIQUE (kind, "evidenceKey"),
  CONSTRAINT financial_loss_amount CHECK (amount > 0 AND amount <= 9007199254740991 AND currency ~ '^[A-Z]{3}$'),
  CONSTRAINT financial_loss_shape CHECK ((
       (kind = 'over_return' AND "paymentId" IS NOT NULL AND "disputeId" IS NULL AND "obligationId" IS NULL AND "recordedByUserId" IS NULL AND "receiptId" IS NULL)
    OR (kind = 'direct_chargeback_write_off' AND "paymentId" IS NOT NULL AND "disputeId" IS NOT NULL AND "obligationId" IS NULL AND "recordedByUserId" IS NULL AND "receiptId" IS NULL)
    OR (kind = 'recovery_write_off' AND "obligationId" = "evidenceKey" AND "disputeId" IS NULL AND "recordedByUserId" IS NOT NULL AND "receiptId" IS NOT NULL))
    AND (("consumeRef" IS NOT NULL) = (kind = 'recovery_write_off')))
);
CREATE INDEX financial_loss_company_idx ON financial_loss ("companyId", "recordedAt");

CREATE FUNCTION billing_financial_loss_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l payment_dispute_loss%ROWTYPE; pr record; inv record; o recovery_obligation%ROWTYPE; outstanding bigint;
BEGIN
  IF NEW.kind = 'over_return' THEN
    -- the payment is one Billing requested, sold by this Company; the amount is Payment's reported excess (never the whole refund)
    SELECT r.*, i."sellerType", i."sellerId" INTO pr FROM payment_request r JOIN invoice i ON i.id = r."invoiceId" WHERE r."paymentId" = NEW."paymentId" LIMIT 1;
    IF pr.id IS NULL OR pr."sellerType" <> 'company' OR pr."sellerId" <> NEW."companyId"::text OR NEW.currency <> pr.currency THEN
      RAISE EXCEPTION 'financial loss: the over-return is not of this Company''s payment' USING ERRCODE = '23514', CONSTRAINT = 'financial_loss_evidence';
    END IF;
  ELSIF NEW.kind = 'direct_chargeback_write_off' THEN
    -- FC-6: a FULL final-lost chargeback of a DIRECT Personal purchase, its verified chargeback fact, and no completed refund of the payment
    SELECT * INTO l FROM payment_dispute_loss WHERE "disputeId" = NEW."disputeId";
    SELECT * INTO pr FROM payment_request WHERE id = l."paymentRequestId";
    SELECT * INTO inv FROM invoice WHERE id = pr."invoiceId";
    IF l."disputeId" IS NULL OR l."chargebackFactId" <> NEW."evidenceKey" OR l."paymentId" <> NEW."paymentId"
       OR l."chargebackAmount" <> pr.amount OR l."chargebackCurrency" <> trim(pr.currency) OR NEW.amount <> l."chargebackAmount" OR NEW.currency <> pr.currency
       OR inv."sellerType" <> 'company' OR inv."sellerId" <> NEW."companyId"::text
       OR NOT EXISTS (SELECT 1 FROM subscription_purchase s WHERE s."paymentRequestId" = pr.id AND s.purpose = 'direct_purchase')
       OR EXISTS (SELECT 1 FROM refund_case c WHERE c."paymentId" = l."paymentId" AND c.status = 'completed') THEN
      RAISE EXCEPTION 'financial loss: not a full final-lost chargeback of a direct purchase without a completed refund' USING ERRCODE = '23514', CONSTRAINT = 'financial_loss_evidence';
    END IF;
  ELSE
    -- R6H-8: an OPEN obligation of this Company, written off once for exactly its outstanding principal, in its currency
    SELECT * INTO o FROM recovery_obligation WHERE id = NEW."obligationId" FOR UPDATE;
    PERFORM pg_advisory_xact_lock(hashtextextended('billing.recovery:' || NEW."obligationId", 0));
    outstanding := billing_recovery_outstanding(NEW."obligationId");
    IF o.id IS NULL OR o.status <> 'open' OR o."companyId" <> NEW."companyId" OR o."organizationId" IS DISTINCT FROM NEW."organizationId"
       OR o.currency <> NEW.currency OR outstanding IS NULL OR outstanding <= 0 OR NEW.amount <> outstanding THEN
      RAISE EXCEPTION 'financial loss: not the outstanding principal of an open recovery obligation' USING ERRCODE = '23514', CONSTRAINT = 'financial_loss_write_off';
    END IF;
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER financial_loss_05_guard BEFORE INSERT ON financial_loss FOR EACH ROW EXECUTE FUNCTION billing_financial_loss_guard();
CREATE TRIGGER financial_loss_10_append_only BEFORE UPDATE OR DELETE ON financial_loss FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER financial_loss_11_no_truncate BEFORE TRUNCATE ON financial_loss FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- a later verified recovery of a written-off obligation reduces the recognized loss, once per recovery payment, never below zero
CREATE TABLE financial_loss_adjustment (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lossId"              uuid NOT NULL REFERENCES financial_loss (id),
  reason                text NOT NULL,
  amount                bigint NOT NULL,                                -- signed: negative reduces the loss
  "recoveryPaymentId"   uuid UNIQUE REFERENCES recovery_payment (id),
  "recordedAt"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_loss_adjustment_reason CHECK (reason IN ('recovered_after_write_off')),
  CONSTRAINT financial_loss_adjustment_shape CHECK (amount < 0 AND amount >= -9007199254740991
    AND ((reason = 'recovered_after_write_off') = ("recoveryPaymentId" IS NOT NULL)))
);
CREATE FUNCTION billing_financial_loss_adjustment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f financial_loss%ROWTYPE; p recovery_payment%ROWTYPE; remaining bigint;
BEGIN
  SELECT * INTO f FROM financial_loss WHERE id = NEW."lossId" FOR UPDATE;
  SELECT * INTO p FROM recovery_payment WHERE id = NEW."recoveryPaymentId";
  remaining := f.amount + COALESCE((SELECT sum(a.amount) FROM financial_loss_adjustment a WHERE a."lossId" = f.id), 0);
  IF f.kind IS DISTINCT FROM 'recovery_write_off' OR p."obligationId" IS DISTINCT FROM f."obligationId" OR p."recordedAt" < f."recordedAt"
     OR -NEW.amount <> LEAST(p."principalAmount", remaining) OR remaining <= 0 THEN
    RAISE EXCEPTION 'financial loss adjustment: not this write-off''s later recovered principal' USING ERRCODE = '23514', CONSTRAINT = 'financial_loss_adjustment_evidence';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER financial_loss_adjustment_05_guard BEFORE INSERT ON financial_loss_adjustment FOR EACH ROW EXECUTE FUNCTION billing_financial_loss_adjustment_guard();
CREATE TRIGGER financial_loss_adjustment_10_append_only BEFORE UPDATE OR DELETE ON financial_loss_adjustment FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER financial_loss_adjustment_11_no_truncate BEFORE TRUNCATE ON financial_loss_adjustment FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── reconciliation cases (R6H-1, R6H-2)

CREATE TABLE reconciliation_case (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "caseType"          text NOT NULL,
  "evidenceKey"       uuid NOT NULL,                                    -- the one record the case is about (deterministic identity)
  "companyId"         uuid NOT NULL,
  "platformId"        uuid,
  "organizationId"    uuid,
  "paymentId"         uuid,
  "paymentRequestId"  uuid REFERENCES payment_request (id),
  "captureFactId"     uuid,
  amount              bigint,
  currency            char(3),
  detail              text,                                             -- a bounded code from the evidence (never free text)
  "openedAt"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_case_type CHECK ("caseType" IN ('late_assisted_settlement', 'recovery_surplus', 'late_success', 'unmatched_capture',
    'unrouted_settlement', 'over_return', 'refund_discrepancy', 'partial_chargeback', 'second_reversal_cause', 'contradictory_effect',
    'authorization_pending', 'chargeback_refund_overlap')),
  CONSTRAINT reconciliation_case_once UNIQUE ("caseType", "evidenceKey"),
  CONSTRAINT reconciliation_case_amount CHECK ((amount IS NULL) = (currency IS NULL) AND (amount IS NULL OR (amount > 0 AND amount <= 9007199254740991))),
  CONSTRAINT reconciliation_case_detail CHECK (detail IS NULL OR detail ~ '^[a-z][a-z0-9_]{0,63}$')
);
CREATE INDEX reconciliation_case_company_idx ON reconciliation_case ("companyId", "openedAt", id);
CREATE FUNCTION billing_reconciliation_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."openedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_case_05_guard BEFORE INSERT ON reconciliation_case FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_case_guard();
CREATE TRIGGER reconciliation_case_10_append_only BEFORE UPDATE OR DELETE ON reconciliation_case FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER reconciliation_case_11_no_truncate BEFORE TRUNCATE ON reconciliation_case FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

CREATE TABLE reconciliation_case_resolution (
  "caseId"            uuid PRIMARY KEY REFERENCES reconciliation_case (id),
  kind                text NOT NULL,
  "refundCaseId"      uuid REFERENCES refund_case (id),
  "lossId"            uuid REFERENCES financial_loss (id),
  "recoveryPaymentId" uuid REFERENCES recovery_payment (id),
  "resolvedByUserId"  uuid,                                             -- the Owner (acknowledgement); NULL: the evidence itself, by the worker
  reason              text,
  "resolvedAt"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_case_resolution_kind CHECK (kind IN ('refund_completed', 'late_settlement_applied', 'surplus_refunded', 'surplus_repaid',
    'recovery_counted', 'loss_recognized', 'effect_applied', 'authorization_resolved', 'acknowledged')),
  CONSTRAINT reconciliation_case_resolution_acknowledged CHECK ((kind = 'acknowledged') = ("resolvedByUserId" IS NOT NULL AND reason IS NOT NULL)
    AND (reason IS NULL OR reason IN ('reviewed_no_financial_effect', 'provider_statement_reviewed', 'duplicate_evidence_reviewed')))
);

-- the database checks that the resolution's evidence exists and fits the case: nothing is resolved while its financial exposure remains
CREATE FUNCTION billing_reconciliation_resolution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c reconciliation_case%ROWTYPE; ok boolean;
BEGIN
  SELECT * INTO c FROM reconciliation_case WHERE id = NEW."caseId";
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
    ELSE false END;
  IF ok IS NOT TRUE OR (NEW.kind <> 'refund_completed' AND NEW."refundCaseId" IS NOT NULL) OR (NEW.kind <> 'loss_recognized' AND NEW."lossId" IS NOT NULL)
     OR (NEW.kind <> 'recovery_counted' AND NEW."recoveryPaymentId" IS NOT NULL) THEN
    RAISE EXCEPTION 'reconciliation case %: % is not a resolution its evidence supports', NEW."caseId", NEW.kind USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_resolution_evidence';
  END IF;
  NEW."resolvedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_case_resolution_05_guard BEFORE INSERT ON reconciliation_case_resolution FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_resolution_guard();
CREATE TRIGGER reconciliation_case_resolution_10_append_only BEFORE UPDATE OR DELETE ON reconciliation_case_resolution FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER reconciliation_case_resolution_11_no_truncate BEFORE TRUNCATE ON reconciliation_case_resolution FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- the Owner's acknowledgement is an idempotent command
ALTER TABLE refund_command_idempotency DROP CONSTRAINT refund_command_idempotency_operation;
ALTER TABLE refund_command_idempotency ADD CONSTRAINT refund_command_idempotency_operation CHECK (operation IN ('refund_case.open', 'refund_case.cancel',
  'reconciliation_case.acknowledge'));

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY['payment_late_success', 'financial_loss', 'financial_loss_adjustment', 'reconciliation_case', 'reconciliation_case_resolution']) AS tbl LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM PUBLIC', r.tbl);
  END LOOP;
END $$;
