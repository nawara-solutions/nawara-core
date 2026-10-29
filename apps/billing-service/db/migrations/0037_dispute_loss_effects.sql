-- 0037 — billing-service: final lost chargebacks of Payment disputes and their commercial effects (Core V2 S6e-D; register EVT-03, BIL-24;
-- ADR-0044 B5, B10; S0 FC-4, V-1, K-3 Option D; the Owner's R6E-5, R6E-6, 2026-10-29). DEVELOPMENT AND SIMULATION ONLY.
--
-- R6E-5 Option A, with evidence gates: Billing records Payment's VERIFIED final loss of a dispute only with its verified chargeback fact
-- (`payment_dispute_loss`, from `payment.dispute.lost` or Payment's losses read), once per dispute. The dispute loss worker then applies its
-- effect once (`dispute_loss_effect`):
--   * a DIRECT Personal purchase lost in full is reversed once (cause `final_lost_chargeback`, the dispute recorded as the cause); a purchase
--     already reversed (a completed refund) gets no second reversal: this cause is appended for S6h;
--   * an ASSISTED purchase keeps its entitlement: nothing is reversed, no obligation is opened (the Organization's base-only recovery
--     obligation and T3 are S6f); its verified loss stays recorded for S6f;
--   * anything else (no Personal purchase) has no commercial effect here.
-- A chargeback smaller than the payment (the full-loss threshold is not defined by the frozen rules) or any contradiction applies nothing and
-- stays a NON-terminal review in `dispute_loss_effect_attempt`. No FinancialLoss (S6h).

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the consumed event (EVT-03)

-- the verified-origin record of Payment's events admits its dispute loss too (the S6c widening pattern)
ALTER TABLE payment_event_origin DROP CONSTRAINT payment_event_origin_name;
ALTER TABLE payment_event_origin ADD CONSTRAINT payment_event_origin_name CHECK ("eventName" IN ('payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired',
  'refund.case_completed', 'payment.dispute.lost'));

-- ─────────────────────────────────────────────────────────────────────────────────────────────── verified final losses

CREATE TABLE payment_dispute_loss (
  "disputeId"           uuid PRIMARY KEY,                  -- Payment's dispute
  "paymentId"           uuid NOT NULL,
  "paymentRequestId"    uuid NOT NULL REFERENCES payment_request (id),
  "disputeAmount"       bigint NOT NULL,
  currency              text NOT NULL,
  "chargebackFactId"    uuid NOT NULL UNIQUE,              -- Payment's verified chargeback fact
  "chargebackAmount"    bigint NOT NULL,
  "chargebackCurrency"  text NOT NULL,
  "lostAt"              timestamptz NOT NULL,
  source                text NOT NULL,
  "eventId"             uuid UNIQUE,
  "recordedAt"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_dispute_loss_amounts CHECK ("disputeAmount" > 0 AND "disputeAmount" <= 9007199254740991 AND "chargebackAmount" > 0 AND "chargebackAmount" <= 9007199254740991),
  CONSTRAINT payment_dispute_loss_currency CHECK (currency ~ '^[A-Z]{3}$' AND char_length("chargebackCurrency") BETWEEN 1 AND 16),
  CONSTRAINT payment_dispute_loss_source CHECK (source IN ('event', 'reconciliation') AND ((source = 'event') = ("eventId" IS NOT NULL)))
);

CREATE FUNCTION billing_payment_dispute_loss_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payment_request r WHERE r.id = NEW."paymentRequestId" AND r."paymentId" = NEW."paymentId") THEN
    RAISE EXCEPTION 'dispute loss: payment % is not this payment request''s', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_loss_payment';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER payment_dispute_loss_05_guard BEFORE INSERT ON payment_dispute_loss FOR EACH ROW EXECUTE FUNCTION billing_payment_dispute_loss_guard();
CREATE TRIGGER payment_dispute_loss_10_append_only BEFORE UPDATE OR DELETE ON payment_dispute_loss FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER payment_dispute_loss_11_no_truncate BEFORE TRUNCATE ON payment_dispute_loss FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── reversal causes: the dispute

ALTER TABLE subscription_purchase_reversal_cause ADD COLUMN "disputeId" uuid REFERENCES payment_dispute_loss ("disputeId");
ALTER TABLE subscription_purchase_reversal_cause DROP CONSTRAINT subscription_purchase_reversal_cause_source;
ALTER TABLE subscription_purchase_reversal_cause ADD CONSTRAINT subscription_purchase_reversal_cause_source CHECK (
     (cause = 'refund_completion' AND "refundCaseId" IS NOT NULL AND "disputeId" IS NULL)
  OR (cause = 'final_lost_chargeback' AND "disputeId" IS NOT NULL AND "refundCaseId" IS NULL));
ALTER TABLE subscription_purchase_reversal_cause DROP CONSTRAINT subscription_purchase_reversal_cause_once;
ALTER TABLE subscription_purchase_reversal_cause ADD CONSTRAINT subscription_purchase_reversal_cause_once UNIQUE NULLS NOT DISTINCT ("purchaseId", cause, "refundCaseId", "disputeId");

-- a refund cause names the completed case of exactly this purchase (S6d, unchanged); a chargeback cause names the verified loss of exactly
-- this DIRECT purchase's payment request (an assisted purchase's loss never reverses it, FC-4)
CREATE OR REPLACE FUNCTION billing_reversal_cause_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."refundCaseId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM refund_case c JOIN refund_case_completion k ON k."refundCaseId" = c.id
     WHERE c.id = NEW."refundCaseId" AND c.status = 'completed' AND c.eligibility = 'personal_purchase' AND c."purchaseId" = NEW."purchaseId") THEN
    RAISE EXCEPTION 'reversal cause: case % did not complete a refund of purchase %', NEW."refundCaseId", NEW."purchaseId" USING ERRCODE = '23514', CONSTRAINT = 'subscription_purchase_reversal_cause_case';
  END IF;
  IF NEW."disputeId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payment_dispute_loss l JOIN subscription_purchase s ON s."paymentRequestId" = l."paymentRequestId"
     WHERE l."disputeId" = NEW."disputeId" AND s.id = NEW."purchaseId" AND s.purpose = 'direct_purchase') THEN
    RAISE EXCEPTION 'reversal cause: dispute % is not a verified loss of direct purchase %', NEW."disputeId", NEW."purchaseId" USING ERRCODE = '23514', CONSTRAINT = 'subscription_purchase_reversal_cause_dispute';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── effects

CREATE TABLE dispute_loss_effect (
  "disputeId"      uuid PRIMARY KEY REFERENCES payment_dispute_loss ("disputeId"),
  outcome          text NOT NULL,
  "purchaseId"     uuid REFERENCES subscription_purchase (id),
  reason           text,
  "recordedAt"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispute_loss_effect_outcome CHECK (outcome IN ('reversed_purchase', 'none')),
  CONSTRAINT dispute_loss_effect_shape CHECK (
       (outcome = 'reversed_purchase' AND "purchaseId" IS NOT NULL AND reason IS NULL)
    OR (outcome = 'none' AND reason IN ('assisted_purchase_preserved', 'already_reversed', 'not_a_personal_purchase')
        AND ((reason = 'not_a_personal_purchase') = ("purchaseId" IS NULL))))
);

CREATE FUNCTION billing_dispute_loss_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l payment_dispute_loss%ROWTYPE; s subscription_purchase%ROWTYPE;
BEGIN
  SELECT * INTO l FROM payment_dispute_loss WHERE "disputeId" = NEW."disputeId";
  IF NEW."purchaseId" IS NOT NULL THEN
    SELECT * INTO s FROM subscription_purchase WHERE id = NEW."purchaseId";
    IF s."paymentRequestId" IS DISTINCT FROM l."paymentRequestId" THEN
      RAISE EXCEPTION 'dispute loss %: not this payment request''s purchase', NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'dispute_loss_effect_purchase';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."paymentRequestId" = l."paymentRequestId") THEN
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
CREATE TRIGGER dispute_loss_effect_05_guard BEFORE INSERT ON dispute_loss_effect FOR EACH ROW EXECUTE FUNCTION billing_dispute_loss_effect_guard();
CREATE TRIGGER dispute_loss_effect_10_append_only BEFORE UPDATE OR DELETE ON dispute_loss_effect FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER dispute_loss_effect_11_no_truncate BEFORE TRUNCATE ON dispute_loss_effect FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- the worker's bookkeeping (as `refund_case_effect_attempt`): `retry` (a technical failure) or `review` (evidence the frozen rules cannot
-- resolve: a partial chargeback, a contradiction), never terminal; re-checked and applied once resolved; never deleted
CREATE TABLE dispute_loss_effect_attempt (
  "disputeId"      uuid PRIMARY KEY REFERENCES payment_dispute_loss ("disputeId"),
  state            text NOT NULL,
  reason           text NOT NULL,
  attempts         integer NOT NULL DEFAULT 1,
  "firstSeenAt"    timestamptz NOT NULL DEFAULT now(),
  "lastSeenAt"     timestamptz NOT NULL DEFAULT now(),
  "workAfter"      timestamptz NOT NULL,
  CONSTRAINT dispute_loss_effect_attempt_state CHECK (state IN ('retry', 'review')),
  CONSTRAINT dispute_loss_effect_attempt_reason CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT dispute_loss_effect_attempt_attempts CHECK (attempts >= 1)
);
CREATE TRIGGER dispute_loss_effect_attempt_10_immutable BEFORE UPDATE ON dispute_loss_effect_attempt
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('state', 'reason', 'attempts', 'lastSeenAt', 'workAfter');
CREATE TRIGGER dispute_loss_effect_attempt_90_no_delete BEFORE DELETE ON dispute_loss_effect_attempt FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
CREATE TRIGGER dispute_loss_effect_attempt_91_no_truncate BEFORE TRUNCATE ON dispute_loss_effect_attempt FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── runtime grants

DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON payment_dispute_loss, dispute_loss_effect FROM PUBLIC;
  REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON dispute_loss_effect_attempt FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname IN ('payment_dispute_loss', 'dispute_loss_effect', 'dispute_loss_effect_attempt') AND a.grantee <> c.relowner AND a.grantee <> 0
       AND (a.privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') OR (a.privilege_type = 'UPDATE' AND c.relname <> 'dispute_loss_effect_attempt'))
  LOOP
    EXECUTE format('REVOKE %s ON %I FROM %s', r.priv, r.tbl, r.role);
  END LOOP;
END $$;
