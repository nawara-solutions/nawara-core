-- Core V2 S6d (register BIL-17, BIL-18, BIL-24, BIL-25, BIL-26; ADR-0044 B4, B5; S0 FC-4, V-1, K-3 Option D, §1.1, L-3; the Owner's R6D-1 to
-- R6D-6 with amendments, 2026-10-29), for Core V2 DEVELOPMENT AND SIMULATION ONLY. The commercial effects of a completed refund case, applied
-- once by Billing's refund effect worker from S6c's authoritative `refund_case_completion`. Expand only: three new tables, two new columns
-- on cash_return_obligation (existing rows: origin `deadline`, unchanged), one replaced insert guard, one replaced transition guard.
--
--   * R6D-1 (B5, FC-4): a refunded Personal purchase, direct OR assisted, is reversed: one `subscription_purchase_reversal` (cause
--     `refund_completion`, at most one per purchase, V-1); the purchase row is untouched; the entitlement is the K-3 Option D fold of the
--     ledger (`billing_personal_spans`), so later paid periods are re-laid at their full duration with no gap. The final-lost-chargeback
--     exception (an assisted purchase is never reversed) concerns chargebacks only.
--   * Every reversal cause is appended separately (B5): `subscription_purchase_reversal_cause`. A refund completion on a purchase already
--     reversed by ANOTHER cause changes no entitlement; its cause is recorded for S6h.
--   * R6D-2 (S0 §1.1, Option A): the refund of an assisted purchase also opens the Organization's obligation to the beneficiary for the
--     request's FULL FROZEN cash total (base + fee, never repriced), as a `cash_return_obligation` of origin `refund_completion`, bound to the
--     completed case. It has no deadline (none is manufactured); while unresolved it is a T2 restriction (S5d's unchanged model); it is
--     discharged by the existing report (BIL-17), confirmation (BIL-18) and dispute (BIL-20 to BIL-22) paths. Its confirmation returns the
--     SETTLED request (the one new origin-aware edge below). The electronic refund (base, to the Organization's card) and this cash
--     obligation are distinct movements, never netted.
--   * R6D-3: `refund_case_effect`, append-only, one per completed case: exactly what was committed (`reversed_purchase`,
--     `reversed_purchase_and_obligation_opened`, or `none` with a terminal reason). `refund_case_effect_attempt` is the worker's mutable,
--     NON-terminal bookkeeping: a technical retry (`retry`) or contradictory evidence kept visible for reconciliation (`review`), re-checked
--     later, never a suppression of a legitimate effect (R6D-6).

-- ─────────────────────────────────────────────────────────────────────────────────────────────── refund_case_effect

CREATE TABLE refund_case_effect (
  "refundCaseId"    uuid PRIMARY KEY REFERENCES refund_case_completion ("refundCaseId"),
  outcome           text NOT NULL,
  "purchaseId"      uuid REFERENCES subscription_purchase (id),
  "obligationId"    uuid,
  reason            text,
  "recordedAt"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_case_effect_outcome CHECK (outcome IN ('reversed_purchase', 'reversed_purchase_and_obligation_opened', 'none')),
  CONSTRAINT refund_case_effect_shape CHECK (
       (outcome = 'reversed_purchase' AND "purchaseId" IS NOT NULL AND "obligationId" IS NULL AND reason IS NULL)
    OR (outcome = 'reversed_purchase_and_obligation_opened' AND "purchaseId" IS NOT NULL AND "obligationId" IS NOT NULL AND reason IS NULL)
    OR (outcome = 'none' AND "obligationId" IS NULL AND reason IN ('no_entitlement_basis', 'late_assisted_settlement', 'already_reversed')
        AND ((reason = 'already_reversed') = ("purchaseId" IS NOT NULL))))
);

-- ─────────────────────────────────────────────────────────────────────────────────────────────── reversal causes (B5)

CREATE TABLE subscription_purchase_reversal_cause (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "purchaseId"     uuid NOT NULL REFERENCES subscription_purchase (id),
  cause            text NOT NULL,
  "refundCaseId"   uuid REFERENCES refund_case_completion ("refundCaseId"),
  "recordedAt"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_purchase_reversal_cause_cause CHECK (cause IN ('refund_completion', 'final_lost_chargeback')),
  CONSTRAINT subscription_purchase_reversal_cause_source CHECK ((cause = 'refund_completion') = ("refundCaseId" IS NOT NULL)),
  CONSTRAINT subscription_purchase_reversal_cause_once UNIQUE NULLS NOT DISTINCT ("purchaseId", cause, "refundCaseId")
);
CREATE INDEX subscription_purchase_reversal_cause_purchase_idx ON subscription_purchase_reversal_cause ("purchaseId");

-- a refund cause names the completed case of exactly this purchase
CREATE FUNCTION billing_reversal_cause_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."refundCaseId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM refund_case c JOIN refund_case_completion k ON k."refundCaseId" = c.id
     WHERE c.id = NEW."refundCaseId" AND c.status = 'completed' AND c.eligibility = 'personal_purchase' AND c."purchaseId" = NEW."purchaseId") THEN
    RAISE EXCEPTION 'reversal cause: case % did not complete a refund of purchase %', NEW."refundCaseId", NEW."purchaseId" USING ERRCODE = '23514', CONSTRAINT = 'subscription_purchase_reversal_cause_case';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_purchase_reversal_cause_05_guard BEFORE INSERT ON subscription_purchase_reversal_cause FOR EACH ROW EXECUTE FUNCTION billing_reversal_cause_insert_guard();
CREATE TRIGGER subscription_purchase_reversal_cause_10_append_only BEFORE UPDATE OR DELETE ON subscription_purchase_reversal_cause FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER subscription_purchase_reversal_cause_11_no_truncate BEFORE TRUNCATE ON subscription_purchase_reversal_cause FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- the reversal itself stays S3c's generic mechanism (one per purchase, any approved cause); the refund flow's cause is bound to its case by
-- the effect record's guard below (a refund effect needs its recorded cause)

-- ─────────────────────────────────────────────────────────────────────────────────────────────── cash_return_obligation: origin

ALTER TABLE cash_return_obligation ADD COLUMN origin text NOT NULL DEFAULT 'deadline';
ALTER TABLE cash_return_obligation ADD COLUMN "refundCaseId" uuid REFERENCES refund_case_completion ("refundCaseId");
ALTER TABLE cash_return_obligation ADD CONSTRAINT cash_return_obligation_origin CHECK (origin IN ('deadline', 'refund_completion')
  AND ((origin = 'refund_completion') = ("refundCaseId" IS NOT NULL)));
CREATE UNIQUE INDEX cash_return_obligation_refund_case_unique ON cash_return_obligation ("refundCaseId") WHERE "refundCaseId" IS NOT NULL;

-- the deadline origin is S5b/S5d's rule, unchanged (E-6); the refund origin is opened only for a completed refund of this request's purchase,
-- reversed in this transaction or before, for the request's frozen total, under the Organization lock then the request lock (S5D-5)
CREATE OR REPLACE FUNCTION billing_cash_return_obligation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  PERFORM billing_assistance_organization_lock(NEW."organizationId");
  SELECT * INTO r FROM assistance_request WHERE id = NEW."assistanceRequestId" FOR UPDATE;
  IF NEW.status <> 'open' OR NEW."returnedAt" IS NOT NULL OR NEW."returnReportedAt" IS NOT NULL OR NEW."returnReportedBy" IS NOT NULL THEN
    RAISE EXCEPTION 'a cash-return obligation is opened open' USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_created_open';
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
     OR EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."assistanceRequestId" = r.id AND c.status IN ('open', 'uncertain')) THEN
    RAISE EXCEPTION 'assistance request %: no cash-return obligation may open', NEW."assistanceRequestId" USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_not_due';
  END IF;
  IF NEW.amount <> r."totalAmount" OR NEW.currency <> r.currency OR NEW."cashCollectedAt" <> r."cashCollectedAt" THEN
    RAISE EXCEPTION 'cash-return obligation: the frozen total, currency and collection time of its request' USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_terms';
  END IF;
  NEW."openedAt" := now();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the request: settled -> returned (refund origin)

CREATE OR REPLACE FUNCTION billing_assistance_request_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap record;
BEGIN
  -- Core V2 S6d (R6D-2): a SETTLED request whose purchase a completed refund reversed is returned only by the beneficiary's confirmation of
  -- its refund-origin cash-return obligation, in that transaction; its collection evidence never changes
  IF OLD.status = 'settled' AND NEW.status = 'returned' THEN
    IF NOT EXISTS (SELECT 1 FROM cash_return_obligation o WHERE o."assistanceRequestId" = OLD.id AND o.status = 'confirmed_returned' AND o.origin = 'refund_completion') THEN
      RAISE EXCEPTION 'assistance request % is returned only by the beneficiary''s confirmation', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_returned_by_confirmation';
    END IF;
    IF NEW."cashCollectedAt" IS DISTINCT FROM OLD."cashCollectedAt" OR NEW."reportedAt" IS DISTINCT FROM OLD."reportedAt" OR NEW."reportedBy" IS DISTINCT FROM OLD."reportedBy"
       OR NEW."settleBy" IS DISTINCT FROM OLD."settleBy" OR NEW."collectionFeeCapVersion" IS DISTINCT FROM OLD."collectionFeeCapVersion" THEN
      RAISE EXCEPTION 'assistance request %: the collection evidence never changes', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_collection_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'cash_collected' AND NEW.status IN ('settled', 'returned') THEN
    -- E-12: only the purchase path settles a request, in the transaction that records its purchase
    IF NEW.status = 'settled' AND NOT EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."assistanceRequestId" = OLD.id) THEN
      RAISE EXCEPTION 'assistance request % is settled only by its purchase', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_settled_by_purchase';
    END IF;
    -- S5c J-6: only the beneficiary's confirmation returns a request, in the transaction that confirms its obligation
    IF NEW.status = 'returned' AND NOT EXISTS (SELECT 1 FROM cash_return_obligation o WHERE o."assistanceRequestId" = OLD.id AND o.status = 'confirmed_returned') THEN
      RAISE EXCEPTION 'assistance request % is returned only by the beneficiary''s confirmation', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_returned_by_confirmation';
    END IF;
    IF NEW."cashCollectedAt" IS DISTINCT FROM OLD."cashCollectedAt" OR NEW."reportedAt" IS DISTINCT FROM OLD."reportedAt" OR NEW."reportedBy" IS DISTINCT FROM OLD."reportedBy"
       OR NEW."settleBy" IS DISTINCT FROM OLD."settleBy" OR NEW."collectionFeeCapVersion" IS DISTINCT FROM OLD."collectionFeeCapVersion" THEN
      RAISE EXCEPTION 'assistance request %: the collection evidence never changes', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_collection_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('declined', 'cash_collected') THEN
    RAISE EXCEPTION 'assistance request % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_not_pending';
  END IF;
  IF NEW.status = 'declined' THEN
    NEW."declinedAt" := now();
    NEW."collectionFeeCapVersion" := NULL;
  ELSE
    NEW."reportedAt" := now();
    NEW."settleBy" := NEW."cashCollectedAt" + interval '72 hours';
    -- E-11: the frozen fee is validated against the Platform's CURRENT cap when the collection is recorded (never reduced or repriced)
    PERFORM billing_fee_lock(OLD."platformId");
    SELECT c.amount, c.version INTO cap FROM billing_current_fee_cap(OLD."platformId") c;
    IF OLD."feeAmount" > coalesce(cap.amount, 0) THEN
      RAISE EXCEPTION 'assistance request %: the frozen fee is above the platform''s current cap', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_fee_not_usable';
    END IF;
    NEW."collectionFeeCapVersion" := cap.version;
  END IF;
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── effect guards

-- the effect record says exactly what was committed: the reversal of the case's own purchase, and the refund-origin obligation of THIS case
CREATE FUNCTION billing_refund_case_effect_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR (NEW.outcome LIKE 'reversed_purchase%' AND c.eligibility <> 'personal_purchase') THEN
    RAISE EXCEPTION 'refund case %: the effect does not match its eligibility basis', NEW."refundCaseId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_effect_basis';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER refund_case_effect_05_guard BEFORE INSERT ON refund_case_effect FOR EACH ROW EXECUTE FUNCTION billing_refund_case_effect_insert_guard();
CREATE TRIGGER refund_case_effect_10_append_only BEFORE UPDATE OR DELETE ON refund_case_effect FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER refund_case_effect_11_no_truncate BEFORE TRUNCATE ON refund_case_effect FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the worker's bookkeeping (non-terminal)

CREATE TABLE refund_case_effect_attempt (
  "refundCaseId"   uuid PRIMARY KEY REFERENCES refund_case_completion ("refundCaseId"),
  state            text NOT NULL,                 -- retry: a technical failure; review: contradictory evidence kept for reconciliation
  reason           text NOT NULL,
  attempts         integer NOT NULL DEFAULT 1,
  "firstSeenAt"    timestamptz NOT NULL DEFAULT now(),
  "lastSeenAt"     timestamptz NOT NULL DEFAULT now(),
  "workAfter"      timestamptz NOT NULL,
  CONSTRAINT refund_case_effect_attempt_state CHECK (state IN ('retry', 'review')),
  CONSTRAINT refund_case_effect_attempt_reason CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT refund_case_effect_attempt_attempts CHECK (attempts >= 1)
);
-- bookkeeping, not evidence: its case and first sighting never change, and it is never deleted (kept as history once the effect exists)
CREATE TRIGGER refund_case_effect_attempt_10_immutable BEFORE UPDATE ON refund_case_effect_attempt
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('state', 'reason', 'attempts', 'lastSeenAt', 'workAfter');
CREATE TRIGGER refund_case_effect_attempt_90_no_delete BEFORE DELETE ON refund_case_effect_attempt FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
CREATE TRIGGER refund_case_effect_attempt_91_no_truncate BEFORE TRUNCATE ON refund_case_effect_attempt FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON refund_case_effect, subscription_purchase_reversal_cause FROM PUBLIC;
  REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON refund_case_effect_attempt FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname IN ('refund_case_effect', 'subscription_purchase_reversal_cause', 'refund_case_effect_attempt') AND a.grantee <> c.relowner AND a.grantee <> 0
       AND (a.privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') OR (a.privilege_type = 'UPDATE' AND c.relname <> 'refund_case_effect_attempt'))
  LOOP
    EXECUTE format('REVOKE %s ON %I FROM %s', r.priv, r.tbl, r.role);
  END LOOP;
END $$;
