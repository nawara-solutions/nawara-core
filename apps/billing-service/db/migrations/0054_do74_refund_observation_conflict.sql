-- 0054 — billing-service: a refund attempt's own provider observation that contradicts a refund fact which is NOT its payment's stays Owner-visible and
-- contested (Core V2 DO-74, observer side; S0 §1.5 DO-74; register BIL-33 Q; the Owner's GO 2026-11-10). DEVELOPMENT AND SIMULATION ONLY. Expand only:
-- one case type, one evidence table, new guard functions and two replaced S0-C15B functions. No existing row is written, rewritten or deleted; every
-- existing guard keeps refusing what it refused; S0-C14, S0-C15A, S0-C15B and DO-73 rules are unchanged.
--
--   * `refund_observation_conflict` (DO-74 R1): one case per refund attempt of Billing's own payment that Payment holds an observation for which
--     contradicts a refund fact NOT of that payment (an unmatched fact, or another payment's, possibly another Company's). Opened only when Payment's
--     producer `fact_conflict` item and its PAY-08 `observationConflicts` agree (the B-D6 pattern). Its identity is the observing attempt (Billing's own
--     relay), so repeated notifications and worker passes never open a second case. It holds NO figures, NO detail and nothing of the fact: the
--     fact's id, figures, provider reference, payment and Company stay at Payment and are not Billing's to hold.
--   * INTERIM FAIL-CLOSED CONDITION (the B-D3 pattern): no resolution kind names this type, so it can never be acknowledged or resolved in this
--     development and simulation phase. This is not a permanent business rule.
--   * Acknowledgement: it joins S0-C15B's contest rule (`billing_acknowledgement_refused_by_contest`, the ONE rule this database's guard and the service
--     call). `reviewed_no_financial_effect` is refused on the movement; `duplicate_evidence_reviewed` on the observing attempt's own `refund_discrepancy`
--     case; `provider_statement_reviewed` stays available. An acknowledgement recorded before the case opened stands.
--   * `reconciliation_observation_evidence` binds each case to its payment, the observing attempt (Billing's own relay of the same payment, required),
--     the Payment observation whose item opened it, and that relay's capture (derived). These constraints establish LOCAL referential integrity between
--     Billing's rows; they prove nothing about provider financial truth.
-- Nothing here records or associates a fact, an allocation, a loss, a debt or a liability, changes a purchase, an entitlement, an obligation or a
-- write-off, or resolves R3, O-2, F-29, D9, D15, FD-1 to FD-8, P-2 or the collection freeze.

ALTER TABLE reconciliation_case DROP CONSTRAINT reconciliation_case_type;
ALTER TABLE reconciliation_case ADD CONSTRAINT reconciliation_case_type CHECK ("caseType" IN ('late_assisted_settlement', 'recovery_surplus', 'late_success',
  'unmatched_capture', 'unrouted_settlement', 'over_return', 'refund_discrepancy', 'partial_chargeback', 'second_reversal_cause', 'contradictory_effect',
  'authorization_pending', 'chargeback_refund_overlap', 'capture_contradiction', 'chargeback_loss_review', 'chargeback_effect_waiting',
  'chargeback_refund_exposure', 'refund_fact_contested', 'dispute_conflict_observed', 'refund_fact_unallocated', 'refund_observation_conflict'));

-- the shape: its payment and nothing financial (no figures, no detail)
CREATE FUNCTION billing_reconciliation_observation_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."caseType" = 'refund_observation_conflict'
     AND (NEW."paymentId" IS NULL OR NEW.amount IS NOT NULL OR NEW.currency IS NOT NULL OR NEW.detail IS NOT NULL) THEN
    RAISE EXCEPTION 'reconciliation case: a refund observation conflict names its payment and no figures' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_observation_shape';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_case_08_observation BEFORE INSERT ON reconciliation_case FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_observation_case_guard();

-- the evidence of one observation-conflict case, written in the case's own transaction
CREATE TABLE reconciliation_observation_evidence (
  "caseId"           uuid PRIMARY KEY REFERENCES reconciliation_case (id),
  "paymentId"        uuid NOT NULL,
  "refundAttemptId"  uuid NOT NULL REFERENCES refund_authorization_relay (id), -- the observing attempt: Billing's own relay of the same payment
  "observationId"    uuid NOT NULL,                                          -- Payment's observation (conflict) of THIS payment whose item opened the case
  "captureFactId"    uuid,                                                   -- derived from the relay's refund case, never supplied
  "recordedAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_observation_evidence_attempt_once UNIQUE ("refundAttemptId")
);
CREATE FUNCTION billing_reconciliation_observation_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c reconciliation_case%ROWTYPE; relPayment uuid; cap uuid;
BEGIN
  SELECT * INTO c FROM reconciliation_case WHERE id = NEW."caseId";
  IF c."caseType" IS DISTINCT FROM 'refund_observation_conflict' OR c."paymentId" IS DISTINCT FROM NEW."paymentId" OR c."evidenceKey" IS DISTINCT FROM NEW."refundAttemptId" THEN
    RAISE EXCEPTION 'observation evidence: it belongs to exactly its case, payment and observing attempt' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_observation_evidence_case';
  END IF;
  IF NEW."captureFactId" IS NOT NULL THEN
    RAISE EXCEPTION 'observation evidence: the capture is derived from Billing''s own rows, never supplied' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_observation_evidence_supplied';
  END IF;
  SELECT x."paymentId", r."captureFactId" INTO relPayment, cap FROM refund_authorization_relay x JOIN refund_case r ON r.id = x."refundCaseId" WHERE x.id = NEW."refundAttemptId";
  IF relPayment IS DISTINCT FROM NEW."paymentId" THEN
    RAISE EXCEPTION 'observation evidence: the observing attempt is a relay of another payment' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_observation_evidence_attempt';
  END IF;
  NEW."captureFactId" := cap;
  IF NEW."captureFactId" IS DISTINCT FROM c."captureFactId" THEN
    RAISE EXCEPTION 'observation evidence: the case names another capture than its relay' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_observation_evidence_capture';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_observation_evidence_05_guard BEFORE INSERT ON reconciliation_observation_evidence FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_observation_evidence_guard();
CREATE TRIGGER reconciliation_observation_evidence_10_append_only BEFORE UPDATE OR DELETE ON reconciliation_observation_evidence FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER reconciliation_observation_evidence_11_no_truncate BEFORE TRUNCATE ON reconciliation_observation_evidence FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- no observation-conflict case commits without its evidence (checked at commit: the case and its evidence are one transaction)
CREATE FUNCTION billing_reconciliation_observation_evidence_present() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."caseType" = 'refund_observation_conflict' AND NOT EXISTS (SELECT 1 FROM reconciliation_observation_evidence e WHERE e."caseId" = NEW.id) THEN
    RAISE EXCEPTION 'reconciliation case %: a refund observation conflict commits with its evidence', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_observation_evidence_missing';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reconciliation_case_09_observation_evidence AFTER INSERT ON reconciliation_case DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_observation_evidence_present();

-- 0052's contested movement, plus the observation conflict (on the same payment and capture, as a refund contest; a case without a capture covers the payment)
CREATE OR REPLACE FUNCTION billing_case_movement_contested(p_case uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM reconciliation_case c JOIN reconciliation_case k
        ON k."caseType" IN ('refund_fact_contested', 'dispute_conflict_observed', 'refund_observation_conflict') AND k.id <> c.id
       AND k."paymentId" = coalesce(c."paymentId", (SELECT pr."paymentId" FROM payment_request pr WHERE pr.id = c."paymentRequestId"))
       AND (k."caseType" = 'dispute_conflict_observed' OR c."captureFactId" IS NULL OR k."captureFactId" IS NULL OR k."captureFactId" = c."captureFactId")
     WHERE c.id = p_case);
$$;

-- 0052's B-D4 rule, plus: "a duplicate" cannot be stated on the observing attempt's own discrepancy case either
CREATE OR REPLACE FUNCTION billing_acknowledgement_refused_by_contest(p_case uuid, p_reason text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT (p_reason = 'reviewed_no_financial_effect' AND billing_case_movement_contested(p_case))
      OR (p_reason = 'duplicate_evidence_reviewed' AND EXISTS (
            SELECT 1 FROM reconciliation_case c JOIN reconciliation_contest_evidence e ON e."paymentId" = c."paymentId" AND e."refundAttemptId" = c."evidenceKey"
             WHERE c.id = p_case AND c."caseType" = 'refund_discrepancy'))
      OR (p_reason = 'duplicate_evidence_reviewed' AND EXISTS (
            SELECT 1 FROM reconciliation_case c JOIN reconciliation_observation_evidence e ON e."paymentId" = c."paymentId" AND e."refundAttemptId" = c."evidenceKey"
             WHERE c.id = p_case AND c."caseType" = 'refund_discrepancy'));
$$;
