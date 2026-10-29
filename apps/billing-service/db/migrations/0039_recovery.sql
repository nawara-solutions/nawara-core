-- 0039 — billing-service: Organization recovery obligations, verified recovery payments, recovery surplus and T3 (Core V2 S6f; register
-- BIL-26 (T3), BIL-28 to BIL-31; ADR-0044 B8, B10; S0 §3.5 R-1 to R-5, FC-9, DB-6, DB-8, DB-9, DB-13; the Owner's R6F-1 to R6F-8,
-- 2026-10-29). DEVELOPMENT AND SIMULATION ONLY.
--
--   * recovery_obligation: opened once per verified FULL final lost chargeback of an ASSISTED purchase (S6e-D `payment_dispute_loss`)
--     whose payment had no completed refund (R6F-3 Option A, R6F-4), for the request's frozen BASE amount only (D5), owed by the request's
--     Organization; the beneficiary keeps the entitlement (B10). `open → recovered` once, when verified recoveries reach the base.
--   * recovery_settlement_channel (B8, DB-8, DB-13): one invoice of the reserved producer `billing-recovery` and its payment request, for the
--     outstanding amount at issue; at most one channel per obligation whose payment request is not final (open or uncertain).
--   * invoice_entitlement gains the `recovery_settlement` arm: target `none`, the Organization payer, the obligation (DB-6), no product.
--   * recovery_payment (DB-9): every verified success of a recovery invoice, once, split by the database into the principal it recovers and
--     the surplus beyond the base; recovery_surplus (R-1): that excess, owed to the Organization, never expiring, never offset.
--   * Surplus resolution, append-only: Path A, a completed full refund of an ENTIRELY surplus payment (a refund case of the new eligibility
--     `recovery_surplus`); Path B, the Owner's evidenced external repayment, then the receiving Organization's confirmation (R-3b).
--   * T3 (FC-9): an open recovery obligation restricts the Organization's NEW assistance requests; nothing else.
-- No purchase, entitlement, cash-return obligation, FinancialLoss or event is created here.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── recovery obligations

CREATE TABLE recovery_obligation (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "disputeId"            uuid NOT NULL UNIQUE REFERENCES payment_dispute_loss ("disputeId"),
  "assistanceRequestId"  uuid NOT NULL REFERENCES assistance_request (id),
  "purchaseId"           uuid NOT NULL REFERENCES subscription_purchase (id),
  "organizationId"       uuid NOT NULL,
  "companyId"            uuid NOT NULL,
  "platformId"           uuid NOT NULL,
  "baseAmount"           bigint NOT NULL,
  currency               char(3) NOT NULL,
  status                 text NOT NULL DEFAULT 'open',
  "openedAt"             timestamptz NOT NULL DEFAULT now(),
  "recoveredAt"          timestamptz,
  CONSTRAINT recovery_obligation_amount CHECK ("baseAmount" > 0 AND "baseAmount" <= 9007199254740991),
  CONSTRAINT recovery_obligation_status CHECK (status IN ('open', 'recovered') AND ((status = 'recovered') = ("recoveredAt" IS NOT NULL))),
  CONSTRAINT recovery_obligation_routing_key UNIQUE (id, "organizationId")
);
CREATE INDEX recovery_obligation_organization_idx ON recovery_obligation ("organizationId") WHERE status = 'open';

-- B10 / D5 / R6F-3 / R6F-4: only a full verified final loss of an assisted purchase never refunded, for the request's frozen base
CREATE FUNCTION billing_recovery_obligation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l payment_dispute_loss%ROWTYPE; pr record; s record; a record;
BEGIN
  PERFORM billing_assistance_organization_lock(NEW."organizationId");
  SELECT * INTO l FROM payment_dispute_loss WHERE "disputeId" = NEW."disputeId";
  SELECT * INTO pr FROM payment_request WHERE id = l."paymentRequestId";
  SELECT * INTO s FROM subscription_purchase WHERE id = NEW."purchaseId";
  SELECT * INTO a FROM assistance_request WHERE id = NEW."assistanceRequestId";
  IF l."disputeId" IS NULL OR s."paymentRequestId" IS DISTINCT FROM l."paymentRequestId" OR s.purpose IS DISTINCT FROM 'assisted_settlement'
     OR s."assistanceRequestId" IS DISTINCT FROM NEW."assistanceRequestId" OR a."organizationId" IS DISTINCT FROM NEW."organizationId"
     OR a."platformId" IS DISTINCT FROM NEW."platformId"
     OR NOT EXISTS (SELECT 1 FROM billing_platform b WHERE b."platformId" = a."platformId" AND b."companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'recovery obligation: not the verified loss of this Organization''s assisted purchase' USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_basis';
  END IF;
  IF l."chargebackAmount" <> pr.amount OR l."chargebackCurrency" <> trim(pr.currency) OR l.currency <> trim(pr.currency) THEN
    RAISE EXCEPTION 'recovery obligation: only a FULL final lost chargeback (R6F-3)' USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_full_loss';
  END IF;
  IF EXISTS (SELECT 1 FROM refund_case c WHERE c."paymentRequestId" = pr.id AND c.status = 'completed') THEN
    RAISE EXCEPTION 'recovery obligation: the payment was refunded; reconciliation only (R6F-4)' USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_refunded';
  END IF;
  IF NEW."baseAmount" <> a."baseAmount" OR NEW.currency <> a.currency THEN
    RAISE EXCEPTION 'recovery obligation: the base amount only, in the request''s currency (D5)' USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_base';
  END IF;
  IF NEW.status <> 'open' OR NEW."recoveredAt" IS NOT NULL THEN
    RAISE EXCEPTION 'recovery obligation: opened open' USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_created_open';
  END IF;
  NEW."openedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_obligation_05_insert_guard BEFORE INSERT ON recovery_obligation FOR EACH ROW EXECUTE FUNCTION billing_recovery_obligation_insert_guard();

-- R6F-3 / R6F-4: an assisted verified loss that does NOT open a recovery obligation (a partial chargeback, or a payment already refunded in
-- full), kept for S6h review, once per loss; it opens no debt and no T3
CREATE TABLE recovery_review (
  "disputeId"    uuid PRIMARY KEY REFERENCES payment_dispute_loss ("disputeId"),
  reason         text NOT NULL,
  "recordedAt"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recovery_review_reason CHECK (reason IN ('partial_chargeback', 'refund_completed'))
);
CREATE TRIGGER recovery_review_10_append_only BEFORE UPDATE OR DELETE ON recovery_review FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER recovery_review_11_no_truncate BEFORE TRUNCATE ON recovery_review FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── settlement channels (B8, DB-8, DB-13)

CREATE TABLE recovery_settlement_channel (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "obligationId"       uuid NOT NULL REFERENCES recovery_obligation (id),
  "invoiceId"          uuid NOT NULL UNIQUE REFERENCES invoice (id),
  "paymentRequestId"   uuid UNIQUE REFERENCES payment_request (id),
  amount               bigint NOT NULL,                      -- the outstanding amount when the channel opened (DB-8)
  "startedBy"          uuid NOT NULL,                        -- the Organization administrator Auth verified
  "createdAt"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recovery_settlement_channel_amount CHECK (amount > 0 AND amount <= 9007199254740991)
);

-- an active channel: its payment request is missing (being opened) or not final (open, or uncertain while in flight)
CREATE FUNCTION billing_recovery_channel_active(p_channel uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT c."paymentRequestId" IS NULL OR EXISTS (
    SELECT 1 FROM payment_request pr WHERE pr.id = c."paymentRequestId" AND pr.status NOT IN ('paid', 'failed', 'cancelled', 'expired', 'rejected'))
    FROM recovery_settlement_channel c WHERE c.id = p_channel;
$$;

CREATE FUNCTION billing_recovery_channel_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o recovery_obligation%ROWTYPE;
BEGIN
  SELECT * INTO o FROM recovery_obligation WHERE id = NEW."obligationId";
  PERFORM billing_assistance_organization_lock(o."organizationId");
  PERFORM pg_advisory_xact_lock(hashtextextended('billing.recovery:' || NEW."obligationId", 0));
  IF o.status <> 'open' THEN
    RAISE EXCEPTION 'recovery channel: the obligation is recovered' USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_closed';
  END IF;
  IF EXISTS (SELECT 1 FROM recovery_settlement_channel c WHERE c."obligationId" = NEW."obligationId" AND billing_recovery_channel_active(c.id)) THEN
    RAISE EXCEPTION 'recovery channel: another channel is open or uncertain (DB-13)' USING ERRCODE = '23514', CONSTRAINT = 'settlement_channel_open';
  END IF;
  IF NEW.amount <> billing_recovery_outstanding(NEW."obligationId") THEN
    RAISE EXCEPTION 'recovery channel: for exactly the outstanding amount (DB-8)' USING ERRCODE = '23514', CONSTRAINT = 'recovery_channel_outstanding';
  END IF;
  IF NEW."paymentRequestId" IS NOT NULL THEN
    RAISE EXCEPTION 'recovery channel: created without its payment request' USING ERRCODE = '23514', CONSTRAINT = 'recovery_channel_created_open';
  END IF;
  -- the channel's invoice is the reserved producer's, paid by the obligation's Organization, for exactly this amount in its currency
  IF NOT EXISTS (SELECT 1 FROM invoice i WHERE i.id = NEW."invoiceId" AND i.producer = 'billing-recovery' AND i."payerType" = 'organization'
                   AND i."payerId" = o."organizationId"::text AND i.total = NEW.amount AND i.currency = o.currency) THEN
    RAISE EXCEPTION 'recovery channel: its invoice is not this obligation''s recovery invoice' USING ERRCODE = '23514', CONSTRAINT = 'recovery_channel_invoice';
  END IF;
  NEW."createdAt" := now();
  RETURN NEW;
END $$;
CREATE FUNCTION billing_recovery_channel_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW."obligationId", NEW."invoiceId", NEW.amount, NEW."startedBy", NEW."createdAt") IS DISTINCT FROM (OLD.id, OLD."obligationId", OLD."invoiceId", OLD.amount, OLD."startedBy", OLD."createdAt")
     OR (OLD."paymentRequestId" IS NOT NULL AND NEW."paymentRequestId" IS DISTINCT FROM OLD."paymentRequestId") THEN
    RAISE EXCEPTION 'recovery channel %: only its payment request, once', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'recovery_channel_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_settlement_channel_05_insert_guard BEFORE INSERT ON recovery_settlement_channel FOR EACH ROW EXECUTE FUNCTION billing_recovery_channel_insert_guard();
CREATE TRIGGER recovery_settlement_channel_10_update_guard BEFORE UPDATE ON recovery_settlement_channel FOR EACH ROW EXECUTE FUNCTION billing_recovery_channel_update_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── routing: the recovery arm (B2, DB-6)

ALTER TABLE invoice_entitlement ADD COLUMN "recoveryObligationId" uuid;
ALTER TABLE invoice_entitlement ADD CONSTRAINT invoice_entitlement_recovery_fk
  FOREIGN KEY ("recoveryObligationId", "organizationId") REFERENCES recovery_obligation (id, "organizationId");
ALTER TABLE invoice_entitlement ADD CONSTRAINT invoice_entitlement_recovery_key UNIQUE ("invoiceId", "recoveryObligationId");
ALTER TABLE invoice_entitlement DROP CONSTRAINT invoice_entitlement_combination;
ALTER TABLE invoice_entitlement ADD CONSTRAINT invoice_entitlement_combination CHECK (
     (purpose = 'organization_subscription' AND target = 'organization' AND "payerType" = 'user' AND "beneficiaryUserId" IS NULL
      AND "organizationId" IS NOT NULL AND "productId" IS NOT NULL AND "assistanceRequestId" IS NULL AND "recoveryObligationId" IS NULL)
  OR (purpose = 'direct_purchase' AND target = 'personal' AND "payerType" = 'user' AND "beneficiaryUserId" IS NOT NULL
      AND "beneficiaryUserId" = "payerId" AND "organizationId" IS NULL AND "productId" IS NOT NULL AND "assistanceRequestId" IS NULL AND "recoveryObligationId" IS NULL)
  OR (purpose = 'assisted_settlement' AND target = 'personal' AND "payerType" = 'organization' AND "beneficiaryUserId" IS NOT NULL
      AND "organizationId" IS NOT NULL AND "payerId" = "organizationId"::text AND "productId" IS NOT NULL AND "assistanceRequestId" IS NOT NULL AND "recoveryObligationId" IS NULL)
  OR (purpose = 'non_entitlement' AND target = 'none' AND "beneficiaryUserId" IS NULL AND "organizationId" IS NULL AND "productId" IS NULL
      AND "assistanceRequestId" IS NULL AND "recoveryObligationId" IS NULL)
  -- B8, DB-4, DB-6: the Organization repays its own obligation; no product, no beneficiary, never a subscription
  OR (purpose = 'recovery_settlement' AND target = 'none' AND "payerType" = 'organization' AND "beneficiaryUserId" IS NULL
      AND "organizationId" IS NOT NULL AND "payerId" = "organizationId"::text AND "productId" IS NULL AND "assistanceRequestId" IS NULL AND "recoveryObligationId" IS NOT NULL)
);

-- B-026 as narrowed by S5b: an Organization-payer request exists only for an assisted-settlement invoice of `billing-assistance` or (S6f) a
-- recovery-settlement invoice of `billing-recovery`
CREATE OR REPLACE FUNCTION billing_payment_request_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv record;
BEGIN
  IF NEW.status <> 'created' OR NEW."paymentId" IS NOT NULL OR NEW.revision <> 0 OR NEW."sendAttempts" <> 0
     OR NEW."sendingSince" IS NOT NULL OR NEW."cancelRequestedAt" IS NOT NULL OR NEW."closedAt" IS NOT NULL OR NEW."failureCode" IS NOT NULL THEN
    RAISE EXCEPTION 'a payment request is created as `created` with no lifecycle data' USING ERRCODE = '23514';
  END IF;
  SELECT status, total, "payerType", producer INTO inv FROM invoice WHERE id = NEW."invoiceId" FOR UPDATE;
  IF inv.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'a payment request needs an open invoice' USING ERRCODE = '23514';
  END IF;
  IF inv."payerType" <> 'user'
     AND NOT (inv."payerType" = 'organization' AND inv.producer = 'billing-assistance'
              AND EXISTS (SELECT 1 FROM invoice_entitlement e WHERE e."invoiceId" = NEW."invoiceId" AND e.purpose = 'assisted_settlement'))
     AND NOT (inv."payerType" = 'organization' AND inv.producer = 'billing-recovery'
              AND EXISTS (SELECT 1 FROM invoice_entitlement e WHERE e."invoiceId" = NEW."invoiceId" AND e.purpose = 'recovery_settlement')) THEN
    RAISE EXCEPTION 'payment requests are supported only for a user payer until B-026 is decided' USING ERRCODE = '23514';
  END IF;
  IF NEW.amount <> inv.total THEN
    RAISE EXCEPTION 'a payment request is for the full invoice total until B-010 is decided' USING ERRCODE = '23514';
  END IF;
  NEW."createdAt" := now();
  NEW."updatedAt" := now();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── verified recovery payments (B8, DB-9)

CREATE TABLE recovery_payment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "obligationId"       uuid NOT NULL REFERENCES recovery_obligation (id),
  "invoiceId"          uuid NOT NULL,
  "paymentRequestId"   uuid NOT NULL UNIQUE REFERENCES payment_request (id),
  "receiptId"          uuid NOT NULL UNIQUE REFERENCES payment_event_receipt (id),
  amount               bigint NOT NULL,                      -- the verified captured amount
  currency             char(3) NOT NULL,
  "principalAmount"    bigint NOT NULL,                      -- the part that recovered the base (computed by the database)
  "surplusAmount"      bigint NOT NULL,                      -- the part beyond the base (R-1)
  "recordedAt"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recovery_payment_routing FOREIGN KEY ("invoiceId", "obligationId") REFERENCES invoice_entitlement ("invoiceId", "recoveryObligationId"),
  CONSTRAINT recovery_payment_split CHECK (amount > 0 AND "principalAmount" >= 0 AND "surplusAmount" >= 0 AND "principalAmount" + "surplusAmount" = amount)
);

-- the outstanding amount of an obligation: its base minus the principal its verified recovery payments recovered
CREATE FUNCTION billing_recovery_outstanding(p_obligation uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT o."baseAmount" - COALESCE((SELECT sum(p."principalAmount") FROM recovery_payment p WHERE p."obligationId" = o.id), 0)
    FROM recovery_obligation o WHERE o.id = p_obligation;
$$;

CREATE FUNCTION billing_recovery_payment_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o recovery_obligation%ROWTYPE; pr record; outstanding bigint;
BEGIN
  SELECT * INTO o FROM recovery_obligation WHERE id = NEW."obligationId";
  PERFORM pg_advisory_xact_lock(hashtextextended('billing.recovery:' || NEW."obligationId", 0));
  SELECT * INTO pr FROM payment_request WHERE id = NEW."paymentRequestId";
  IF pr."invoiceId" IS DISTINCT FROM NEW."invoiceId" OR pr.status IS DISTINCT FROM 'paid' OR NEW.amount <> pr.amount OR NEW.currency <> pr.currency
     OR NOT EXISTS (SELECT 1 FROM payment_event_receipt r WHERE r.id = NEW."receiptId" AND r."paymentRequestId" = pr.id AND r."eventName" = 'payment.succeeded' AND r.outcome = 'applied') THEN
    RAISE EXCEPTION 'recovery payment: not the verified success of this recovery invoice' USING ERRCODE = '23514', CONSTRAINT = 'recovery_payment_verified';
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
CREATE TRIGGER recovery_payment_05_insert_guard BEFORE INSERT ON recovery_payment FOR EACH ROW EXECUTE FUNCTION billing_recovery_payment_insert_guard();

-- open → recovered once, only when the verified principal reaches the base
CREATE FUNCTION billing_recovery_obligation_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW."disputeId", NEW."assistanceRequestId", NEW."purchaseId", NEW."organizationId", NEW."companyId", NEW."platformId", NEW."baseAmount", NEW.currency, NEW."openedAt")
     IS DISTINCT FROM (OLD.id, OLD."disputeId", OLD."assistanceRequestId", OLD."purchaseId", OLD."organizationId", OLD."companyId", OLD."platformId", OLD."baseAmount", OLD.currency, OLD."openedAt") THEN
    RAISE EXCEPTION 'recovery obligation %: immutable except its recovery', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'open' OR NEW.status <> 'recovered' OR billing_recovery_outstanding(OLD.id) > 0 THEN
      RAISE EXCEPTION 'recovery obligation %: recovered once, when verified recoveries reach the base', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_recovered';
    END IF;
    NEW."recoveredAt" := now();
  ELSIF NEW."recoveredAt" IS DISTINCT FROM OLD."recoveredAt" THEN
    RAISE EXCEPTION 'recovery obligation %: immutable except its recovery', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_obligation_10_update_guard BEFORE UPDATE ON recovery_obligation FOR EACH ROW EXECUTE FUNCTION billing_recovery_obligation_update_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── surplus (R-1 to R-5)

CREATE TABLE recovery_surplus (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "recoveryPaymentId"   uuid NOT NULL UNIQUE REFERENCES recovery_payment (id),
  "obligationId"        uuid NOT NULL REFERENCES recovery_obligation (id),
  "organizationId"      uuid NOT NULL,
  amount                bigint NOT NULL,
  currency              char(3) NOT NULL,
  "recordedAt"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recovery_surplus_amount CHECK (amount > 0)
);
CREATE FUNCTION billing_recovery_surplus_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM recovery_payment p JOIN recovery_obligation o ON o.id = p."obligationId"
                  WHERE p.id = NEW."recoveryPaymentId" AND p."obligationId" = NEW."obligationId" AND p."surplusAmount" = NEW.amount AND p.currency = NEW.currency
                    AND o."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'recovery surplus: exactly the surplus of its recovery payment, owed to its Organization' USING ERRCODE = '23514', CONSTRAINT = 'recovery_surplus_payment';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_surplus_05_insert_guard BEFORE INSERT ON recovery_surplus FOR EACH ROW EXECUTE FUNCTION billing_recovery_surplus_insert_guard();

-- Path B (R-3b): the Owner's evidenced record of an external repayment, then the receiving Organization's confirmation
CREATE TABLE recovery_surplus_external (
  "surplusId"         uuid PRIMARY KEY REFERENCES recovery_surplus (id),
  "recordedByUserId"  uuid NOT NULL,
  "receiptId"         uuid NOT NULL UNIQUE,                  -- Auth's consumed `recovery_surplus_external` receipt
  "grantId"           uuid NOT NULL UNIQUE,                  -- File's `surplus_evidence` grant, verified live
  "fileId"            uuid NOT NULL,
  "recordedAt"        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE recovery_surplus_confirmation (
  "surplusId"          uuid PRIMARY KEY REFERENCES recovery_surplus_external ("surplusId"),
  "confirmedByUserId"  uuid NOT NULL,
  "confirmedAt"        timestamptz NOT NULL DEFAULT now()
);
-- Path A (R-3a): the completed full refund of an entirely surplus payment
CREATE TABLE recovery_surplus_refund (
  "surplusId"      uuid PRIMARY KEY REFERENCES recovery_surplus (id),
  "refundCaseId"   uuid NOT NULL UNIQUE REFERENCES refund_case_completion ("refundCaseId"),
  "recordedAt"     timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION billing_recovery_surplus_resolution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('billing.recovery_surplus:' || NEW."surplusId", 0));
  IF TG_TABLE_NAME = 'recovery_surplus_external' THEN
    -- one path: never an external record while a refund case for the surplus is open or completed
    IF EXISTS (SELECT 1 FROM refund_case c WHERE c."surplusId" = NEW."surplusId" AND c.status IN ('open', 'completed')) THEN
      RAISE EXCEPTION 'recovery surplus %: being refunded (Path A)', NEW."surplusId" USING ERRCODE = '23514', CONSTRAINT = 'recovery_surplus_one_path';
    END IF;
  ELSIF TG_TABLE_NAME = 'recovery_surplus_confirmation' THEN
    -- R-3b: the receiving Organization's administrator confirms, never the Owner who recorded it
    IF EXISTS (SELECT 1 FROM recovery_surplus_external x WHERE x."surplusId" = NEW."surplusId" AND x."recordedByUserId" = NEW."confirmedByUserId") THEN
      RAISE EXCEPTION 'recovery surplus %: the recorder cannot confirm', NEW."surplusId" USING ERRCODE = '23514', CONSTRAINT = 'recovery_surplus_self_confirmation';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM refund_case c JOIN refund_case_completion k ON k."refundCaseId" = c.id
                    WHERE c.id = NEW."refundCaseId" AND c.eligibility = 'recovery_surplus' AND c."surplusId" = NEW."surplusId" AND c.status = 'completed') THEN
      RAISE EXCEPTION 'recovery surplus %: resolved only by the completed refund of its own case', NEW."surplusId" USING ERRCODE = '23514', CONSTRAINT = 'recovery_surplus_refund_completed';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_surplus_external_05_guard BEFORE INSERT ON recovery_surplus_external FOR EACH ROW EXECUTE FUNCTION billing_recovery_surplus_resolution_guard();
CREATE TRIGGER recovery_surplus_confirmation_05_guard BEFORE INSERT ON recovery_surplus_confirmation FOR EACH ROW EXECUTE FUNCTION billing_recovery_surplus_resolution_guard();
CREATE TRIGGER recovery_surplus_refund_05_guard BEFORE INSERT ON recovery_surplus_refund FOR EACH ROW EXECUTE FUNCTION billing_recovery_surplus_resolution_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── Path A: the refund case eligibility

ALTER TABLE refund_case ADD COLUMN "surplusId" uuid REFERENCES recovery_surplus (id);
ALTER TABLE refund_case DROP CONSTRAINT refund_case_eligibility;
ALTER TABLE refund_case ADD CONSTRAINT refund_case_eligibility CHECK (eligibility IN ('personal_purchase', 'late_assisted_settlement', 'non_entitlement', 'recovery_surplus'));
ALTER TABLE refund_case DROP CONSTRAINT refund_case_basis;
ALTER TABLE refund_case ADD CONSTRAINT refund_case_basis CHECK (
     (eligibility = 'personal_purchase' AND "purchaseId" IS NOT NULL AND "lateSettlementId" IS NULL AND "surplusId" IS NULL)
  OR (eligibility = 'late_assisted_settlement' AND "lateSettlementId" IS NOT NULL AND "purchaseId" IS NULL AND "surplusId" IS NULL)
  OR (eligibility = 'non_entitlement' AND "purchaseId" IS NULL AND "lateSettlementId" IS NULL AND "surplusId" IS NULL)
  OR (eligibility = 'recovery_surplus' AND "surplusId" IS NOT NULL AND "purchaseId" IS NULL AND "lateSettlementId" IS NULL));
ALTER TABLE refund_case DROP CONSTRAINT refund_case_reason;
ALTER TABLE refund_case ADD CONSTRAINT refund_case_reason CHECK (
  reason IN ('duplicate_charge', 'service_not_provided', 'customer_request', 'late_settlement_unapplied', 'legal_requirement', 'recovery_surplus')
  AND ((reason = 'recovery_surplus') = (eligibility = 'recovery_surplus')));

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
  NEW."openedAt" := now();
  RETURN NEW;
END $$;

-- the S6d effect of a completed recovery-surplus refund: no purchase, no obligation; the surplus resolved (R-3a)
ALTER TABLE refund_case_effect DROP CONSTRAINT refund_case_effect_shape;
ALTER TABLE refund_case_effect ADD CONSTRAINT refund_case_effect_shape CHECK (
     (outcome = 'reversed_purchase' AND "purchaseId" IS NOT NULL AND "obligationId" IS NULL AND reason IS NULL)
  OR (outcome = 'reversed_purchase_and_obligation_opened' AND "purchaseId" IS NOT NULL AND "obligationId" IS NOT NULL AND reason IS NULL)
  OR (outcome = 'none' AND "obligationId" IS NULL AND reason IN ('no_entitlement_basis', 'late_assisted_settlement', 'already_reversed', 'recovery_surplus_refunded')
      AND ((reason = 'already_reversed') = ("purchaseId" IS NOT NULL))));

CREATE OR REPLACE FUNCTION billing_refund_case_effect_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c refund_case%ROWTYPE;
BEGIN
  SELECT * INTO c FROM refund_case WHERE id = NEW."refundCaseId";
  IF c.status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'refund case % is not completed', NEW."refundCaseId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_effect_completed';
  END IF;
  IF NEW."purchaseId" IS NOT NULL AND (NEW."purchaseId" IS DISTINCT FROM c."purchaseId"
       OR NOT EXISTS (SELECT 1 FROM subscription_purchase_reversal v WHERE v."purchaseId" = NEW."purchaseId")
       OR NOT EXISTS (SELECT 1 FROM subscription_purchase_reversal_cause k WHERE k."purchaseId" = NEW."purchaseId" AND k."refundCaseId" = NEW."refundCaseId")) THEN
    RAISE EXCEPTION 'refund case %: the effect does not match its purchase and recorded cause', NEW."refundCaseId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_effect_purchase';
  END IF;
  IF NEW.outcome LIKE 'reversed_purchase%' AND EXISTS (SELECT 1 FROM subscription_purchase_reversal v WHERE v."purchaseId" = NEW."purchaseId" AND v.cause <> 'refund_completion') THEN
    RAISE EXCEPTION 'refund case %: the purchase was reversed by another cause', NEW."refundCaseId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_effect_purchase';
  END IF;
  IF NEW."obligationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cash_return_obligation o WHERE o.id = NEW."obligationId" AND o."refundCaseId" = NEW."refundCaseId" AND o.origin = 'refund_completion') THEN
    RAISE EXCEPTION 'refund case %: the obligation is not this case''s', NEW."refundCaseId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_effect_obligation';
  END IF;
  IF (NEW.reason = 'no_entitlement_basis' AND c.eligibility <> 'non_entitlement') OR (NEW.reason = 'late_assisted_settlement' AND c.eligibility <> 'late_assisted_settlement')
     OR (NEW.outcome LIKE 'reversed_purchase%' AND c.eligibility <> 'personal_purchase')
     OR ((NEW.reason = 'recovery_surplus_refunded') <> (c.eligibility = 'recovery_surplus'))
     OR (NEW.reason = 'recovery_surplus_refunded' AND NOT EXISTS (SELECT 1 FROM recovery_surplus_refund r WHERE r."refundCaseId" = c.id AND r."surplusId" = c."surplusId")) THEN
    RAISE EXCEPTION 'refund case %: the effect does not match its eligibility basis', NEW."refundCaseId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_effect_basis';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── T3 (FC-9; R-5)

-- one model: T1 and T2 unchanged; T3 while a recovery obligation of the Organization is open (a surplus never re-opens or extends it)
CREATE OR REPLACE FUNCTION billing_assistance_restrictions(p_organization uuid, p_at timestamptz)
  RETURNS TABLE (kind text, "sourceId" uuid, since timestamptz) LANGUAGE sql STABLE AS $$
  SELECT r.kind, r."sourceId", r.since FROM (
    SELECT 'T1'::text AS kind, a.id AS "sourceId", a."settleBy" AS since
      FROM assistance_request a
     WHERE a."organizationId" = p_organization AND a.status = 'cash_collected' AND a."settleBy" IS NOT NULL AND p_at > a."settleBy"
    UNION ALL
    SELECT 'T2'::text, o.id, o."openedAt"
      FROM cash_return_obligation o
     WHERE o."organizationId" = p_organization AND o.status IN ('open', 'return_reported')
    UNION ALL
    SELECT 'T3'::text, ro.id, ro."openedAt"
      FROM recovery_obligation ro
     WHERE ro."organizationId" = p_organization AND ro.status = 'open'
  ) r
  ORDER BY r.kind, r.since, r."sourceId";
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── command idempotency (permanent)

-- BIL-29 (class M) and BIL-31 (class K): the assistance command record, never deleted
ALTER TABLE assistance_command_idempotency DROP CONSTRAINT assistance_command_idempotency_operation;
ALTER TABLE assistance_command_idempotency ADD CONSTRAINT assistance_command_idempotency_operation CHECK (operation IN (
  'assistance_request.create', 'assistance_request.decline', 'assistance_request.cash_collection', 'assistance_request.settlement', 'cash_return_obligation.return',
  'cash_return_obligation.confirm', 'assistance_request.dispute', 'assistance_dispute.respond', 'assistance_request.correct', 'assistance_dispute.resolve',
  'recovery_obligation.settlement', 'recovery_surplus.confirm'));

-- ─────────────────────────────────────────────────────────────────────────────────────────────── append-only, grants

CREATE TRIGGER recovery_obligation_90_no_delete BEFORE DELETE ON recovery_obligation FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
CREATE TRIGGER recovery_obligation_91_no_truncate BEFORE TRUNCATE ON recovery_obligation FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER recovery_settlement_channel_90_no_delete BEFORE DELETE ON recovery_settlement_channel FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
CREATE TRIGGER recovery_settlement_channel_91_no_truncate BEFORE TRUNCATE ON recovery_settlement_channel FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER recovery_payment_10_append_only BEFORE UPDATE OR DELETE ON recovery_payment FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER recovery_payment_11_no_truncate BEFORE TRUNCATE ON recovery_payment FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER recovery_surplus_10_append_only BEFORE UPDATE OR DELETE ON recovery_surplus FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER recovery_surplus_11_no_truncate BEFORE TRUNCATE ON recovery_surplus FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER recovery_surplus_external_10_append_only BEFORE UPDATE OR DELETE ON recovery_surplus_external FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER recovery_surplus_external_11_no_truncate BEFORE TRUNCATE ON recovery_surplus_external FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER recovery_surplus_confirmation_10_append_only BEFORE UPDATE OR DELETE ON recovery_surplus_confirmation FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER recovery_surplus_confirmation_11_no_truncate BEFORE TRUNCATE ON recovery_surplus_confirmation FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER recovery_surplus_refund_10_append_only BEFORE UPDATE OR DELETE ON recovery_surplus_refund FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER recovery_surplus_refund_11_no_truncate BEFORE TRUNCATE ON recovery_surplus_refund FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

DO $$
DECLARE r record;
BEGIN
  REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON recovery_obligation, recovery_settlement_channel FROM PUBLIC;
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON recovery_review, recovery_payment, recovery_surplus, recovery_surplus_external, recovery_surplus_confirmation, recovery_surplus_refund FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname IN ('recovery_obligation', 'recovery_review', 'recovery_settlement_channel', 'recovery_payment', 'recovery_surplus', 'recovery_surplus_external',
                         'recovery_surplus_confirmation', 'recovery_surplus_refund')
       AND a.grantee <> c.relowner AND a.grantee <> 0
       AND (a.privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
            OR (a.privilege_type = 'UPDATE' AND c.relname NOT IN ('recovery_obligation', 'recovery_settlement_channel')))
  LOOP
    EXECUTE format('REVOKE %s ON %I FROM %s', r.priv, r.tbl, r.role);
  END LOOP;
END $$;
