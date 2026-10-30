-- Core V2 S6g (register BIL-32; S0 §3.4 L-1 to L-6; ADR-0044 B14; DB-12; K-3 Option D; the Owner's R6G-1 to R6G-9 and the
-- obligation-history decision (Option A), 2026-10-30), for Core V2 DEVELOPMENT AND SIMULATION ONLY. L-1 to L-3 and L-5 are S5b / S6a-S6d
-- (unchanged); this migration adds L-4 / L-6, the Owner's exceptional application of one verified late assisted settlement as its request's
-- single purchase:
--   * cash-return obligation HISTORY (Option A): a request may keep several obligations, but at most ONE live (`open` / `return_reported`)
--     one at a time (a partial unique index replaces the absolute one); `superseded_by_settlement` is a new terminal state, reached only from
--     `open`, only for a deadline-origin obligation, only by an L-4 application in its own transaction; superseded rows are never rewritten;
--   * `assistance_late_settlement."settledAt"`: Payment's trusted original settlement instant, recorded from S6g on (earlier records read it
--     from `payment_event_origin`; when neither exists the instant is unknown and L-4 is refused, never invented);
--   * `late_settlement_attestation` (R6G-2 Path A): the beneficiary's own append-only statement, once per late settlement;
--   * `late_settlement_application` (R6G-1, R6G-3 to R6G-7): one per late settlement and per request, with every L-4 / L-6 condition re-checked
--     here under the Organization, request, obligation and payment-request locks; `late_settlement_evidence` (R6G-2 Path B): its File grants;
--   * `subscription_purchase."appliedAt"` (R6G-5, the narrow K-3 exception): an applied purchase keeps `settledAt` (Payment's instant) and
--     anchors its period at the application instant; every other purchase is unchanged (`appliedAt` NULL).

-- ─────────────────────────────────────────────────────────────────────────────────────────────── obligation history (Option A)

ALTER TABLE cash_return_obligation DROP CONSTRAINT "cash_return_obligation_assistanceRequestId_key";
-- at most one LIVE obligation per request (the only ones T2, discharge and refunds act on); terminal ones are history
CREATE UNIQUE INDEX cash_return_obligation_live_unique ON cash_return_obligation ("assistanceRequestId") WHERE status IN ('open', 'return_reported');
CREATE INDEX cash_return_obligation_request_idx ON cash_return_obligation ("assistanceRequestId", "openedAt");
ALTER TABLE cash_return_obligation DROP CONSTRAINT cash_return_obligation_status;
ALTER TABLE cash_return_obligation ADD CONSTRAINT cash_return_obligation_status CHECK (status IN ('open', 'return_reported', 'confirmed_returned', 'superseded_by_settlement'));
ALTER TABLE cash_return_obligation ADD COLUMN "supersededAt" timestamptz;
ALTER TABLE cash_return_obligation ADD COLUMN "supersededByApplicationId" uuid;
ALTER TABLE cash_return_obligation ADD CONSTRAINT cash_return_obligation_superseded_shape CHECK (
  (status = 'superseded_by_settlement') = ("supersededAt" IS NOT NULL AND "supersededByApplicationId" IS NOT NULL)
  AND (status = 'superseded_by_settlement' OR ("supersededAt" IS NULL AND "supersededByApplicationId" IS NULL)));
DROP TRIGGER cash_return_obligation_10_immutable ON cash_return_obligation;
CREATE TRIGGER cash_return_obligation_10_immutable BEFORE UPDATE ON cash_return_obligation
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('status', 'returnedAt', 'returnReportedAt', 'returnReportedBy', 'confirmedAt', 'confirmedBy', 'supersededAt', 'supersededByApplicationId');

-- the request's CURRENT obligation: the most recent one that was not superseded (live, or confirmed). Superseded obligations are only ever
-- reached from `open`, so they carry no return evidence; every request-based read of return evidence goes through this
CREATE FUNCTION billing_assistance_current_obligation(p_request uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT o.id FROM cash_return_obligation o
   WHERE o."assistanceRequestId" = p_request AND o.status <> 'superseded_by_settlement'
   ORDER BY o."openedAt" DESC, o.id DESC LIMIT 1;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the late settlement's original instant

ALTER TABLE assistance_late_settlement ADD COLUMN "settledAt" timestamptz; -- Payment's trusted instant; NULL only for records before S6g
CREATE OR REPLACE FUNCTION billing_assistance_late_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- the verified settlement it holds: an applied payment.succeeded of this invoice's request, which is paid
  IF NOT EXISTS (
    SELECT 1 FROM payment_event_receipt r JOIN payment_request pr ON pr.id = r."paymentRequestId"
     WHERE r.id = NEW."receiptId" AND r.outcome = 'applied' AND r."eventName" = 'payment.succeeded' AND pr.id = NEW."paymentRequestId"
       AND pr."invoiceId" = NEW."invoiceId" AND pr.status = 'paid')
     OR NOT EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."invoiceId" = NEW."invoiceId" AND c."assistanceRequestId" = NEW."assistanceRequestId") THEN
    RAISE EXCEPTION 'assistance_late_settlement: invoice % has no verified settlement of that request', NEW."invoiceId" USING ERRCODE = '23514', CONSTRAINT = 'assistance_late_settlement_verified';
  END IF;
  -- Core V2 S6g: every new record keeps Payment's original settlement instant (never the recording time)
  IF NEW."settledAt" IS NULL THEN
    RAISE EXCEPTION 'assistance_late_settlement: the original settlement instant is required' USING ERRCODE = '23514', CONSTRAINT = 'assistance_late_settlement_settled_at';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;

-- the original verified instant of a late settlement: its own record, else the trusted envelope of the event that applied it (S1e-2); NULL
-- when neither exists (a reconciliation receipt recorded before S6g): unknown, never invented
CREATE FUNCTION billing_late_settlement_settled_at(p_late uuid) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT coalesce(l."settledAt", (SELECT o."occurredAt"::timestamptz FROM payment_event_receipt r JOIN payment_event_origin o ON o."eventId" = r."eventId"
                                   WHERE r.id = l."receiptId" AND o."eventName" = 'payment.succeeded'))
    FROM assistance_late_settlement l WHERE l.id = p_late;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── R6G-2 Path A: beneficiary attestation

CREATE TABLE late_settlement_attestation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lateSettlementId"    uuid NOT NULL UNIQUE REFERENCES assistance_late_settlement (id),  -- once per late settlement
  "assistanceRequestId" uuid NOT NULL REFERENCES assistance_request (id),
  "beneficiaryUserId"   uuid NOT NULL,
  statement             text NOT NULL,
  "attestedAt"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT late_settlement_attestation_statement CHECK (statement IN ('cash_not_returned', 'cash_returned'))
);
CREATE FUNCTION billing_late_settlement_attestation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- only the beneficiary of the late settlement's own request (a statement, never a financial fact)
  IF NOT EXISTS (SELECT 1 FROM assistance_late_settlement l JOIN assistance_request a ON a.id = l."assistanceRequestId"
                  WHERE l.id = NEW."lateSettlementId" AND a.id = NEW."assistanceRequestId" AND a."beneficiaryUserId" = NEW."beneficiaryUserId") THEN
    RAISE EXCEPTION 'late settlement %: only its request''s beneficiary attests', NEW."lateSettlementId" USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_attestation_beneficiary';
  END IF;
  NEW."attestedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER late_settlement_attestation_05_guard BEFORE INSERT ON late_settlement_attestation FOR EACH ROW EXECUTE FUNCTION billing_late_settlement_attestation_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── L-4 application

CREATE TABLE late_settlement_application (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lateSettlementId"    uuid NOT NULL UNIQUE REFERENCES assistance_late_settlement (id),
  "assistanceRequestId" uuid NOT NULL UNIQUE REFERENCES assistance_request (id),   -- L-5: one application per request
  "companyId"           uuid NOT NULL,
  "platformId"          uuid NOT NULL,
  "organizationId"      uuid NOT NULL,
  "beneficiaryUserId"   uuid NOT NULL,
  "reasonCode"          text NOT NULL,
  "attestationId"       uuid UNIQUE REFERENCES late_settlement_attestation (id),
  "obligationId"        uuid UNIQUE REFERENCES cash_return_obligation (id),         -- the deadline obligation it superseded, if one was live
  "appliedByUserId"     uuid NOT NULL,
  "receiptId"           uuid NOT NULL UNIQUE,                                         -- Auth's consumed `late_settlement_apply` receipt
  "settledAt"           timestamptz NOT NULL,                                         -- Payment's original instant, never rewritten
  "appliedAt"           timestamptz NOT NULL DEFAULT now(),                           -- the entitlement anchor (R6G-5)
  CONSTRAINT late_settlement_application_reason CHECK ("reasonCode" IN ('cash_not_returned_attested', 'cash_not_returned_evidenced')),
  CONSTRAINT late_settlement_application_attested CHECK (("reasonCode" = 'cash_not_returned_attested') = ("attestationId" IS NOT NULL)),
  CONSTRAINT late_settlement_application_order CHECK ("appliedAt" >= "settledAt")
);
ALTER TABLE cash_return_obligation ADD CONSTRAINT cash_return_obligation_superseded_by_fk FOREIGN KEY ("supersededByApplicationId") REFERENCES late_settlement_application (id);

CREATE TABLE late_settlement_evidence (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "applicationId"       uuid NOT NULL REFERENCES late_settlement_application (id),
  "lateSettlementId"    uuid NOT NULL REFERENCES assistance_late_settlement (id),
  "grantId"             uuid NOT NULL UNIQUE,                                         -- File's `settlement_evidence` grant, verified live
  "fileId"              uuid NOT NULL,
  "verifiedAt"          timestamptz NOT NULL DEFAULT now()
);

-- L-4 / L-6, re-checked by the database (lock order: Organization -> request -> live obligation -> late payment request)
CREATE FUNCTION billing_late_settlement_application_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER late_settlement_application_05_guard BEFORE INSERT ON late_settlement_application FOR EACH ROW EXECUTE FUNCTION billing_late_settlement_application_guard();

-- R6G-2 Path B: an evidenced application commits only with its verified File grants; and every application commits with its purchase,
-- its settled request and (when one was live) its superseded obligation, in its own transaction
CREATE FUNCTION billing_late_settlement_application_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."reasonCode" = 'cash_not_returned_evidenced' AND NOT EXISTS (SELECT 1 FROM late_settlement_evidence e WHERE e."applicationId" = NEW.id) THEN
    RAISE EXCEPTION 'late settlement application %: evidence is required', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_evidence_insufficient';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscription_purchase p JOIN assistance_late_settlement l ON l."invoiceId" = p."invoiceId"
                  WHERE l.id = NEW."lateSettlementId" AND p."assistanceRequestId" = NEW."assistanceRequestId" AND p."appliedAt" = NEW."appliedAt")
     OR NOT EXISTS (SELECT 1 FROM assistance_request a WHERE a.id = NEW."assistanceRequestId" AND a.status = 'settled')
     OR (NEW."obligationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cash_return_obligation c WHERE c.id = NEW."obligationId" AND c.status = 'superseded_by_settlement'
                                                        AND c."supersededByApplicationId" = NEW.id)) THEN
    RAISE EXCEPTION 'late settlement application %: its purchase, settled request and superseded obligation commit together', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_application_atomic';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER late_settlement_application_95_commit AFTER INSERT ON late_settlement_application DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billing_late_settlement_application_commit();

CREATE FUNCTION billing_late_settlement_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM late_settlement_application a WHERE a.id = NEW."applicationId" AND a."lateSettlementId" = NEW."lateSettlementId"
                   AND a."reasonCode" = 'cash_not_returned_evidenced') THEN
    RAISE EXCEPTION 'late settlement evidence: not an evidenced application of this late settlement' USING ERRCODE = '23514', CONSTRAINT = 'late_settlement_evidence_application';
  END IF;
  NEW."verifiedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER late_settlement_evidence_05_guard BEFORE INSERT ON late_settlement_evidence FOR EACH ROW EXECUTE FUNCTION billing_late_settlement_evidence_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── obligation transitions and inserts

CREATE OR REPLACE FUNCTION billing_cash_return_obligation_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Core V2 S6g (L-4): a live deadline obligation is superseded, once, only by its request's L-4 application in that transaction
  IF NEW.status = 'superseded_by_settlement' AND OLD.status IS DISTINCT FROM 'superseded_by_settlement' THEN
    IF OLD.status <> 'open' OR OLD.origin <> 'deadline' OR NOT EXISTS (
      SELECT 1 FROM late_settlement_application a WHERE a.id = NEW."supersededByApplicationId" AND a."obligationId" = OLD.id) THEN
      RAISE EXCEPTION 'cash-return obligation %: superseded only by its request''s late-settlement application', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_supersession';
    END IF;
    NEW."supersededAt" := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'return_reported' THEN
    -- E-9 (and J-5: also while a dispute is open; the report is evidence, it closes no dispute and discharges nothing)
    IF NEW."confirmedAt" IS NOT NULL OR NEW."confirmedBy" IS NOT NULL THEN
      RAISE EXCEPTION 'cash-return obligation %: a report is not a confirmation', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'cash_return_not_open';
    END IF;
    NEW."returnReportedAt" := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'return_reported' AND NEW.status = 'confirmed_returned' THEN
    PERFORM 1 FROM assistance_request WHERE id = OLD."assistanceRequestId" FOR UPDATE; -- H-7: the request first (a no-op when already held)
    IF NEW."returnedAt" IS DISTINCT FROM OLD."returnedAt" OR NEW."returnReportedAt" IS DISTINCT FROM OLD."returnReportedAt" OR NEW."returnReportedBy" IS DISTINCT FROM OLD."returnReportedBy" THEN
      RAISE EXCEPTION 'cash-return obligation %: the return evidence never changes', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_report_immutable';
    END IF;
    -- J-4: an open dispute blocks the confirmation
    IF EXISTS (SELECT 1 FROM assistance_dispute d WHERE d."assistanceRequestId" = OLD."assistanceRequestId" AND d.status = 'open') THEN
      RAISE EXCEPTION 'cash-return obligation %: a dispute of its request is open', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_dispute_open';
    END IF;
    NEW."confirmedAt" := clock_timestamp(); -- after the request lock (see the dispute guard)
    RETURN NEW;
  END IF;
  IF OLD.status = 'open' THEN
    RAISE EXCEPTION 'cash-return obligation % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'cash_return_not_reported';
  END IF;
  RAISE EXCEPTION 'cash-return obligation % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'cash_return_not_open';
END $$;

CREATE OR REPLACE FUNCTION billing_cash_return_obligation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  PERFORM billing_assistance_organization_lock(NEW."organizationId");
  SELECT * INTO r FROM assistance_request WHERE id = NEW."assistanceRequestId" FOR UPDATE;
  IF NEW.status <> 'open' OR NEW."returnedAt" IS NOT NULL OR NEW."returnReportedAt" IS NOT NULL OR NEW."returnReportedBy" IS NOT NULL THEN
    RAISE EXCEPTION 'a cash-return obligation is opened open' USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_created_open';
  END IF;
  -- Core V2 S6g (Option A): never a second live obligation for a request (the partial unique index enforces it too)
  IF EXISTS (SELECT 1 FROM cash_return_obligation o WHERE o."assistanceRequestId" = r.id AND o.status IN ('open', 'return_reported')) THEN
    RAISE EXCEPTION 'assistance request %: a cash-return obligation is already live', NEW."assistanceRequestId" USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_live_exists';
  END IF;
  IF NEW.origin = 'refund_completion' THEN
    IF r.status IS DISTINCT FROM 'settled' OR NOT EXISTS (
      SELECT 1 FROM refund_case c
        JOIN refund_case_completion k ON k."refundCaseId" = c.id
        JOIN subscription_purchase p ON p.id = c."purchaseId"
        JOIN subscription_purchase_reversal v ON v."purchaseId" = p.id
       WHERE c.id = NEW."refundCaseId" AND c.status = 'completed' AND c.eligibility = 'personal_purchase' AND p.purpose = 'assisted_settlement'
         AND p."assistanceRequestId" = r.id AND p."beneficiaryUserId" = r."beneficiaryUserId"::text AND c."organizationId" IS NOT DISTINCT FROM r."organizationId") THEN
      RAISE EXCEPTION 'assistance request %: no completed refund of its reversed purchase', NEW."assistanceRequestId" USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_refund_not_due';
    END IF;
  ELSIF r.status IS DISTINCT FROM 'cash_collected' OR NOT (now() > r."settleBy")
     OR EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."assistanceRequestId" = r.id)
     OR EXISTS (SELECT 1 FROM cash_return_obligation o WHERE o."assistanceRequestId" = r.id) -- E-8: one deadline obligation per request, ever
     OR EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."assistanceRequestId" = r.id AND c.status IN ('open', 'uncertain')) THEN
    RAISE EXCEPTION 'assistance request %: no cash-return obligation may open', NEW."assistanceRequestId" USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_not_due';
  END IF;
  IF NEW.amount <> r."totalAmount" OR NEW.currency <> r.currency OR NEW."cashCollectedAt" <> r."cashCollectedAt" THEN
    RAISE EXCEPTION 'cash-return obligation: the frozen total, currency and collection time of its request' USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_terms';
  END IF;
  NEW."openedAt" := now();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── request-based reads use the CURRENT obligation

CREATE OR REPLACE FUNCTION billing_assistance_effective_time(p_request uuid, p_field text) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT c."correctedValue" FROM assistance_correction c WHERE c."assistanceRequestId" = p_request AND c.field = p_field ORDER BY c.sequence DESC LIMIT 1),
    CASE p_field
      WHEN 'cashCollectedAt' THEN (SELECT a."cashCollectedAt" FROM assistance_request a WHERE a.id = p_request)
      WHEN 'returnedAt' THEN (SELECT o."returnedAt" FROM cash_return_obligation o WHERE o.id = billing_assistance_current_obligation(p_request))
    END);
$$;

CREATE OR REPLACE FUNCTION billing_assistance_correction_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; o record; collected timestamptz; returned timestamptz;
BEGIN
  IF NEW.field IS NULL OR NEW.field NOT IN ('cashCollectedAt', 'returnedAt') THEN -- H-2: nothing monetary, nothing else, is correctable
    RAISE EXCEPTION 'assistance correction: % is not correctable', NEW.field USING ERRCODE = '23514', CONSTRAINT = 'assistance_correction_field';
  END IF;
  SELECT * INTO r FROM assistance_request WHERE id = NEW."assistanceRequestId" FOR UPDATE;
  IF r.id IS NULL OR r.status NOT IN ('cash_collected', 'settled', 'returned') THEN
    RAISE EXCEPTION 'assistance request %: no Organization-asserted time to correct', NEW."assistanceRequestId" USING ERRCODE = '23514', CONSTRAINT = 'assistance_correction_not_permitted';
  END IF;
  SELECT * INTO o FROM cash_return_obligation WHERE id = billing_assistance_current_obligation(r.id); -- Core V2 S6g: the current obligation
  IF NEW.field = 'returnedAt' AND o."returnedAt" IS NULL THEN
    RAISE EXCEPTION 'assistance request %: no reported cash return to correct', r.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_correction_not_permitted';
  END IF;
  IF NEW."correctedBy" = r."beneficiaryUserId" OR NEW."correctedBy" = r."reportedBy" OR NEW."correctedBy" IS NOT DISTINCT FROM o."returnReportedBy" THEN
    RAISE EXCEPTION 'a correction is never made by a party to the request' USING ERRCODE = '23514', CONSTRAINT = 'assistance_correction_not_permitted';
  END IF;
  collected := billing_assistance_effective_time(r.id, 'cashCollectedAt');
  returned := billing_assistance_effective_time(r.id, 'returnedAt');
  NEW."supersededValue" := CASE NEW.field WHEN 'cashCollectedAt' THEN collected ELSE returned END;
  IF NEW.field = 'cashCollectedAt' THEN collected := NEW."correctedValue"; ELSE returned := NEW."correctedValue"; END IF;
  IF NOT (r."consentAt" <= collected AND collected <= r."reportedAt") OR (returned IS NOT NULL AND NOT (collected <= returned AND returned <= o."returnReportedAt")) THEN
    RAISE EXCEPTION 'assistance request %: the corrected time breaks the recorded time order', r.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_correction_time_order';
  END IF;
  NEW.sequence := coalesce((SELECT max(c.sequence) FROM assistance_correction c WHERE c."assistanceRequestId" = r.id), 0) + 1;
  NEW."correctedAt" := clock_timestamp(); -- after the request lock: the recorded order is the commit order (never the transaction's start)
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION billing_assistance_dispute_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; o record;
BEGIN
  SELECT * INTO r FROM assistance_request WHERE id = NEW."assistanceRequestId" FOR UPDATE;
  IF NEW.status <> 'open' OR NEW."resolvedAt" IS NOT NULL OR NEW."resolvedBy" IS NOT NULL OR NEW.outcome IS NOT NULL OR NEW."correctionId" IS NOT NULL THEN
    RAISE EXCEPTION 'a dispute is opened open' USING ERRCODE = '23514', CONSTRAINT = 'assistance_dispute_created_open';
  END IF;
  SELECT * INTO o FROM cash_return_obligation WHERE id = billing_assistance_current_obligation(r.id); -- Core V2 S6g: the current obligation
  IF r.status NOT IN ('cash_collected', 'settled', 'returned')
     OR (NEW."reasonCode" = 'cash_not_returned' AND o.id IS NULL)
     OR (NEW."reasonCode" = 'return_time_incorrect' AND o."returnedAt" IS NULL) THEN
    RAISE EXCEPTION 'assistance request %: the % dispute concerns no recorded evidence', r.id, NEW."reasonCode" USING ERRCODE = '23514', CONSTRAINT = 'assistance_dispute_not_permitted';
  END IF;
  NEW."openedAt" := clock_timestamp(); -- after the request lock: a dispute serialized after a confirmation is recorded after it
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── R6G-5: the narrow K-3 exception

ALTER TABLE subscription_purchase ADD COLUMN "appliedAt" timestamptz;
ALTER TABLE subscription_purchase ADD CONSTRAINT subscription_purchase_applied CHECK (
  "appliedAt" IS NULL OR (purpose = 'assisted_settlement' AND "appliedAt" >= "settledAt"));

-- K-3 Option D, unchanged except the anchor of an L-4-applied purchase: its application instant (never backdated; `settledAt` kept)
CREATE OR REPLACE FUNCTION billing_personal_spans(p_personal uuid, p_settled_at timestamptz DEFAULT NULL, p_price uuid DEFAULT NULL)
RETURNS TABLE ("purchaseId" uuid, "effectiveStart" timestamptz, "effectiveEnd" timestamptz) LANGUAGE plpgsql STABLE AS $$
DECLARE r record; prev_end timestamptz; prev_unit text; anchor timestamptz; s timestamptz;
BEGIN
  FOR r IN
    SELECT * FROM (
      SELECT sp.id, sp."ledgerSeq" AS seq, coalesce(sp."appliedAt", sp."settledAt") AS settled, pr."intervalUnit" AS unit, pr."intervalCount" AS cnt
        FROM subscription_purchase sp JOIN price pr ON pr.id = sp."priceId"
       WHERE sp."personalSubscriptionId" = p_personal
         AND NOT EXISTS (SELECT 1 FROM subscription_purchase_reversal v WHERE v."purchaseId" = sp.id)
      UNION ALL
      SELECT NULL::uuid, 9223372036854775807, p_settled_at, pr."intervalUnit", pr."intervalCount"
        FROM price pr WHERE p_price IS NOT NULL AND pr.id = p_price
    ) l ORDER BY l.seq
  LOOP
    IF prev_end IS NOT NULL AND r.settled <= prev_end THEN
      s := prev_end; -- continues the previous kept period, with no gap
      IF NOT (r.unit IN ('month', 'year') AND prev_unit IN ('month', 'year')) THEN anchor := s; END IF;
    ELSE
      s := r.settled; -- the first period, or one after a lapse: a new chain anchored on its own settlement (or application)
      anchor := s;
    END IF;
    "purchaseId" := r.id;
    "effectiveStart" := s;
    "effectiveEnd" := billing_subscription_period_end(s, anchor, r.unit, r."cnt");
    RETURN NEXT;
    prev_end := "effectiveEnd";
    prev_unit := r.unit;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION billing_subscription_purchase_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE span record;
BEGIN
  NEW."transactionId" := pg_current_xact_id();
  IF NOT EXISTS (
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
                       WHERE l."invoiceId" = NEW."invoiceId" AND l."receiptId" = NEW."receiptId" AND a."assistanceRequestId" = r.id
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

-- ─────────────────────────────────────────────────────────────────────────────────────────────── command idempotency (permanent, class K)

ALTER TABLE assistance_command_idempotency DROP CONSTRAINT assistance_command_idempotency_operation;
ALTER TABLE assistance_command_idempotency ADD CONSTRAINT assistance_command_idempotency_operation CHECK (operation IN (
  'assistance_request.create', 'assistance_request.decline', 'assistance_request.cash_collection', 'assistance_request.settlement', 'cash_return_obligation.return',
  'cash_return_obligation.confirm', 'assistance_request.dispute', 'assistance_dispute.respond', 'assistance_request.correct', 'assistance_dispute.resolve',
  'recovery_obligation.settlement', 'recovery_surplus.confirm', 'assistance_late_settlement.attest', 'assistance_late_settlement.apply'));

-- ─────────────────────────────────────────────────────────────────────────────────────────────── append-only, grants

CREATE TRIGGER late_settlement_attestation_10_append_only BEFORE UPDATE OR DELETE ON late_settlement_attestation FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER late_settlement_attestation_11_no_truncate BEFORE TRUNCATE ON late_settlement_attestation FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER late_settlement_application_10_append_only BEFORE UPDATE OR DELETE ON late_settlement_application FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER late_settlement_application_11_no_truncate BEFORE TRUNCATE ON late_settlement_application FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER late_settlement_evidence_10_append_only BEFORE UPDATE OR DELETE ON late_settlement_evidence FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER late_settlement_evidence_11_no_truncate BEFORE TRUNCATE ON late_settlement_evidence FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON late_settlement_attestation, late_settlement_application, late_settlement_evidence FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname IN ('late_settlement_attestation', 'late_settlement_application', 'late_settlement_evidence')
       AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE %s ON %I FROM %s', r.priv, r.tbl, r.role);
  END LOOP;
END $$;
