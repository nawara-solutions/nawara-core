-- 0053 — billing-service: verified refund facts Payment cannot allocate stay Owner-visible (Core V2 DO-73 safety contract; S0 §1.5 DO-73; register
-- BIL-33 P; the Owner's decisions U-1 to U-7, 2026-11-08). DEVELOPMENT AND SIMULATION ONLY. Expand only: one case type, one evidence table, new functions,
-- guards and two replaced functions. No existing row is written, rewritten or deleted; every existing guard keeps refusing what it refused; S0-C14,
-- S0-C15A and S0-C15B rules are unchanged.
--
--   * `refund_fact_unallocated` (DO-73): one case per verified refund fact Payment permanently BLOCKED from allocation for `currency_mismatch` or
--     `no_authorization` (never `contested`: that is S0-C15B's `refund_fact_contested`; a fact that is both may hold both cases, U-1). Opened only when
--     Payment's producer item and its PAY-08 refunds read agree (the B-D6 pattern). Its figures are the VERIFIED fact's, exactly as Payment states them,
--     never converted (U-4): a currency that is not three capital letters cannot be held here without truncation, so such a case holds NO figures and
--     Payment stays authoritative for them.
--   * INTERIM FAIL-CLOSED CONDITION (the B-D3 pattern): no resolution kind names this type, so it can never be acknowledged or resolved in this
--     development and simulation phase, until FD-1 to FD-8 define the evidence that may close it. This is not a permanent business rule.
--   * Acknowledgement: `billing_acknowledgement_refused_by_unallocated` is the ONE rule, called by this database's guard and by the service.
--     `reviewed_no_financial_effect` is refused on the movement; `duplicate_evidence_reviewed` only on the blocked attempt's own `refund_discrepancy`
--     case; `provider_statement_reviewed` stays available. An acknowledgement recorded before the case opened stands (U-6).
--   * Cancellation (U-2, O1): a refund case cannot be cancelled while an unallocated-refund case names one of its relays. This is LOCAL: Payment can
--     record a refund fact at any time, so a cancellation that committed before Billing learned of the fact stands, and the case still opens later,
--     linked to that relay. No cross-service atomicity is claimed.
--   * `reconciliation_unallocated_evidence` binds each case to its payment, refund fact (once), Payment's refund attempt, Billing's own relay of that
--     attempt when Billing holds one (derived, of the same payment) and that relay's capture (derived). These constraints establish LOCAL referential
--     integrity between Billing's rows; they prove nothing about provider financial truth.
-- Nothing here records a fact, an allocation, a loss, a debt or a liability, changes a purchase, an entitlement or an obligation, or resolves D9, D15,
-- FD-1 to FD-8, P-2 or the collection freeze.

ALTER TABLE reconciliation_case DROP CONSTRAINT reconciliation_case_type;
ALTER TABLE reconciliation_case ADD CONSTRAINT reconciliation_case_type CHECK ("caseType" IN ('late_assisted_settlement', 'recovery_surplus', 'late_success',
  'unmatched_capture', 'unrouted_settlement', 'over_return', 'refund_discrepancy', 'partial_chargeback', 'second_reversal_cause', 'contradictory_effect',
  'authorization_pending', 'chargeback_refund_overlap', 'capture_contradiction', 'chargeback_loss_review', 'chargeback_effect_waiting',
  'chargeback_refund_exposure', 'refund_fact_contested', 'dispute_conflict_observed', 'refund_fact_unallocated'));

-- the shape: its payment, one of the two closed reasons, and either the verified figures (an ISO-shaped currency) or none at all (U-4)
CREATE FUNCTION billing_reconciliation_unallocated_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."caseType" = 'refund_fact_unallocated'
     AND (NEW."paymentId" IS NULL OR NEW.detail IS NULL OR NEW.detail NOT IN ('currency_mismatch', 'no_authorization')
          OR (NEW.currency IS NOT NULL AND NEW.currency !~ '^[A-Z]{3}$')) THEN
    RAISE EXCEPTION 'reconciliation case: an unallocated refund names its payment, a closed reason and the verified figures or none'
      USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_unallocated_shape';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_case_08_unallocated BEFORE INSERT ON reconciliation_case FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_unallocated_case_guard();

-- the evidence of one unallocated-refund case, written in the case's own transaction
CREATE TABLE reconciliation_unallocated_evidence (
  "caseId"           uuid PRIMARY KEY REFERENCES reconciliation_case (id),
  "paymentId"        uuid NOT NULL,
  "refundFactId"     uuid NOT NULL,
  "refundAttemptId"  uuid NOT NULL,                                     -- Payment's refund attempt, as PAY-08 states it
  "relayId"          uuid REFERENCES refund_authorization_relay (id),   -- Billing's own relay of that attempt, of the same payment: derived, never supplied
  "captureFactId"    uuid,                                              -- derived from that relay's refund case, never supplied
  "blockedReason"    text NOT NULL,
  "recordedAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_unallocated_evidence_fact_once UNIQUE ("refundFactId"),
  CONSTRAINT reconciliation_unallocated_evidence_reason CHECK ("blockedReason" IN ('currency_mismatch', 'no_authorization'))
);
CREATE INDEX reconciliation_unallocated_evidence_relay_idx ON reconciliation_unallocated_evidence ("relayId") WHERE "relayId" IS NOT NULL;
CREATE FUNCTION billing_reconciliation_unallocated_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c reconciliation_case%ROWTYPE; rel uuid; relPayment uuid; cap uuid;
BEGIN
  SELECT * INTO c FROM reconciliation_case WHERE id = NEW."caseId";
  IF c."caseType" IS DISTINCT FROM 'refund_fact_unallocated' OR c."paymentId" IS DISTINCT FROM NEW."paymentId" OR c."evidenceKey" IS DISTINCT FROM NEW."refundFactId"
     OR c.detail IS DISTINCT FROM NEW."blockedReason" THEN
    RAISE EXCEPTION 'unallocated evidence: it belongs to exactly its case, payment, fact and reason' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_unallocated_evidence_case';
  END IF;
  IF NEW."relayId" IS NOT NULL OR NEW."captureFactId" IS NOT NULL THEN
    RAISE EXCEPTION 'unallocated evidence: the relay and capture are derived from Billing''s own rows, never supplied' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_unallocated_evidence_supplied';
  END IF;
  SELECT x.id, x."paymentId", r."captureFactId" INTO rel, relPayment, cap FROM refund_authorization_relay x JOIN refund_case r ON r.id = x."refundCaseId" WHERE x.id = NEW."refundAttemptId";
  IF rel IS NOT NULL AND relPayment IS DISTINCT FROM NEW."paymentId" THEN
    RAISE EXCEPTION 'unallocated evidence: the refund attempt is a relay of another payment' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_unallocated_evidence_attempt';
  END IF;
  NEW."relayId" := rel;
  NEW."captureFactId" := cap;
  IF NEW."captureFactId" IS DISTINCT FROM c."captureFactId" THEN
    RAISE EXCEPTION 'unallocated evidence: the case names another capture than its relay' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_unallocated_evidence_capture';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_unallocated_evidence_05_guard BEFORE INSERT ON reconciliation_unallocated_evidence FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_unallocated_evidence_guard();
CREATE TRIGGER reconciliation_unallocated_evidence_10_append_only BEFORE UPDATE OR DELETE ON reconciliation_unallocated_evidence FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER reconciliation_unallocated_evidence_11_no_truncate BEFORE TRUNCATE ON reconciliation_unallocated_evidence FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- no unallocated-refund case commits without its evidence (checked at commit: the case and its evidence are one transaction)
CREATE FUNCTION billing_reconciliation_unallocated_evidence_present() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."caseType" = 'refund_fact_unallocated' AND NOT EXISTS (SELECT 1 FROM reconciliation_unallocated_evidence e WHERE e."caseId" = NEW.id) THEN
    RAISE EXCEPTION 'reconciliation case %: an unallocated refund commits with its evidence', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_unallocated_evidence_missing';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reconciliation_case_09_unallocated_evidence AFTER INSERT ON reconciliation_case DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_unallocated_evidence_present();

-- an unallocated-refund case on the same payment and capture (a case or evidence without a capture covers the whole payment)
CREATE FUNCTION billing_case_movement_unallocated(p_case uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM reconciliation_case c JOIN reconciliation_case k
        ON k."caseType" = 'refund_fact_unallocated' AND k.id <> c.id
       AND k."paymentId" = coalesce(c."paymentId", (SELECT pr."paymentId" FROM payment_request pr WHERE pr.id = c."paymentRequestId"))
       AND (c."captureFactId" IS NULL OR k."captureFactId" IS NULL OR k."captureFactId" = c."captureFactId")
     WHERE c.id = p_case);
$$;

-- the one rule: no financial effect cannot be stated on a movement with verified unallocated refund money; "a duplicate" cannot be stated on the
-- blocked attempt's own discrepancy case. Any other duplicate review, and every reviewed provider statement, stays available.
CREATE FUNCTION billing_acknowledgement_refused_by_unallocated(p_case uuid, p_reason text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT (p_reason = 'reviewed_no_financial_effect' AND billing_case_movement_unallocated(p_case))
      OR (p_reason = 'duplicate_evidence_reviewed' AND EXISTS (
            SELECT 1 FROM reconciliation_case c JOIN reconciliation_unallocated_evidence e ON e."paymentId" = c."paymentId" AND e."refundAttemptId" = c."evidenceKey"
             WHERE c.id = p_case AND c."caseType" = 'refund_discrepancy'));
$$;

-- 0052's resolution guard, unchanged, plus the DO-73 rule. The new type appears in no resolution branch: every kind, `acknowledged` included, is refused.
CREATE OR REPLACE FUNCTION billing_reconciliation_resolution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c reconciliation_case%ROWTYPE; ok boolean;
BEGIN
  SELECT * INTO c FROM reconciliation_case WHERE id = NEW."caseId";
  IF NEW.kind = 'chargeback_returned' AND c."paymentRequestId" IS NOT NULL THEN
    -- serialized with the L-4 application and every refund case of the payment (they take the same lock)
    PERFORM 1 FROM payment_request WHERE id = c."paymentRequestId" FOR UPDATE;
  END IF;
  IF NEW.kind = 'acknowledged' AND NEW.reason = 'reviewed_no_financial_effect' AND billing_case_movement_overlap(c.id) THEN
    RAISE EXCEPTION 'reconciliation case %: no financial effect cannot be stated while a refund and chargeback overlap exists (S0-C14 item 9)', NEW."caseId"
      USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_overlap_acknowledgement';
  END IF;
  -- S0-C15A item 6: the one rule the service also calls
  IF NEW.kind = 'acknowledged' AND billing_acknowledgement_refused_by_exposure(c.id, NEW.reason) THEN
    RAISE EXCEPTION 'reconciliation case %: % cannot be stated while refund evidence beside a chargeback is unresolved (S0-C15A item 6)', NEW."caseId", NEW.reason
      USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_exposure_acknowledgement';
  END IF;
  -- S0-C15B (B-D4): contested refund or dispute evidence on the case's movement: the one rule the service also calls
  IF NEW.kind = 'acknowledged' AND billing_acknowledgement_refused_by_contest(c.id, NEW.reason) THEN
    RAISE EXCEPTION 'reconciliation case %: % cannot be stated while contested provider evidence on this movement is unresolved (S0-C15B)', NEW."caseId", NEW.reason
      USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_contest_acknowledgement';
  END IF;
  -- DO-73: verified refund money Payment could not allocate on the case's movement: the one rule the service also calls
  IF NEW.kind = 'acknowledged' AND billing_acknowledgement_refused_by_unallocated(c.id, NEW.reason) THEN
    RAISE EXCEPTION 'reconciliation case %: % cannot be stated while a verified unallocated refund on this movement is unresolved (DO-73)', NEW."caseId", NEW.reason
      USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_unallocated_acknowledgement';
  END IF;
  ok := CASE NEW.kind
    WHEN 'refund_completed' THEN (c."caseType" IN ('late_assisted_settlement', 'late_success', 'unmatched_capture', 'unrouted_settlement')
      AND EXISTS (SELECT 1 FROM refund_case r WHERE r.id = NEW."refundCaseId" AND r.status = 'completed' AND r."paymentId" = c."paymentId"
                   AND (c."captureFactId" IS NULL OR r."captureFactId" = c."captureFactId")
                   AND (c."caseType" <> 'late_assisted_settlement' OR r.eligibility = 'late_assisted_settlement')))
      -- S0-C14 item 12: the completed refund of exactly the loss's captured movement, and the effect was never applied
      OR (c."caseType" = 'chargeback_effect_waiting'
          AND EXISTS (SELECT 1 FROM refund_case r WHERE r.id = NEW."refundCaseId" AND r.status = 'completed')
          AND billing_refund_case_on_loss_movement(NEW."refundCaseId", c."evidenceKey")
          AND NOT billing_loss_effect_applied(c."evidenceKey"))
      -- S0-C15A item 5: the completed refund of exactly the loss's captured movement, once that movement's overlap case exists
      OR (c."caseType" = 'chargeback_refund_exposure'
          AND EXISTS (SELECT 1 FROM refund_case r WHERE r.id = NEW."refundCaseId" AND r.status = 'completed')
          AND billing_refund_case_on_loss_movement(NEW."refundCaseId", c."evidenceKey")
          AND EXISTS (SELECT 1 FROM reconciliation_case k WHERE k."caseType" = 'chargeback_refund_overlap' AND k."evidenceKey" = c."evidenceKey"))
    WHEN 'late_settlement_applied' THEN c."caseType" = 'late_assisted_settlement'
      AND EXISTS (SELECT 1 FROM late_settlement_application a WHERE a."lateSettlementId" = c."evidenceKey")
    WHEN 'surplus_refunded' THEN c."caseType" = 'recovery_surplus' AND EXISTS (SELECT 1 FROM recovery_surplus_refund r WHERE r."surplusId" = c."evidenceKey")
    WHEN 'surplus_repaid' THEN c."caseType" = 'recovery_surplus' AND EXISTS (SELECT 1 FROM recovery_surplus_confirmation r WHERE r."surplusId" = c."evidenceKey")
    WHEN 'recovery_counted' THEN c."caseType" = 'late_success'
      AND EXISTS (SELECT 1 FROM recovery_payment p WHERE p.id = NEW."recoveryPaymentId" AND p."lateSuccessId" = c."evidenceKey")
    WHEN 'loss_recognized' THEN c."caseType" = 'over_return'
      AND EXISTS (SELECT 1 FROM financial_loss f WHERE f.id = NEW."lossId" AND f.kind = 'over_return' AND f."evidenceKey" = c."evidenceKey")
    WHEN 'effect_applied' THEN (c."caseType" = 'contradictory_effect'
      AND (EXISTS (SELECT 1 FROM refund_case_effect e WHERE e."refundCaseId" = c."evidenceKey") OR EXISTS (SELECT 1 FROM dispute_loss_effect e WHERE e."disputeId" = c."evidenceKey")))
      -- S0-C14 item 12: only when the loss's obligation or direct write-off exists; never when nothing was applied
      OR (c."caseType" = 'chargeback_effect_waiting' AND billing_loss_effect_applied(c."evidenceKey"))
    WHEN 'authorization_resolved' THEN c."caseType" = 'authorization_pending'
      AND EXISTS (SELECT 1 FROM refund_authorization_relay r WHERE r.id = c."evidenceKey" AND r."attemptStatus" IS NOT NULL AND r."attemptStatus" <> 'authorization_pending')
    -- R6H-2: only review-only cases, whose evidence moves no money Billing could act on, may be acknowledged; the evidence stays
    WHEN 'acknowledged' THEN c."caseType" IN ('refund_discrepancy', 'partial_chargeback', 'second_reversal_cause')
    -- Core V2 S0-C9 item 5 (CB-4): the provider returned the WHOLE unsold late capture; nothing else is refunded, sold or changed
    WHEN 'chargeback_returned' THEN c."caseType" IN ('late_assisted_settlement', 'late_success') AND c."captureFactId" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM payment_dispute_loss l JOIN payment_late_success s ON s."factId" = l."captureFactId"
         WHERE l."disputeId" = NEW."disputeId" AND l."captureBasis" = 'late_capture' AND l."captureFactId" = c."captureFactId"
           AND l."paymentId" = c."paymentId" AND s."paymentId" = c."paymentId" AND s."paymentRequestId" = l."paymentRequestId"
           AND l."chargebackAmount" = s.amount AND l."chargebackCurrency" = trim(s.currency) AND l.currency = trim(s.currency)
           AND NOT EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."lateSuccessId" = s."lateSuccessId"))
      AND NOT billing_capture_refund_exists(c."paymentId", c."captureFactId")
      AND (c."caseType" <> 'late_assisted_settlement' OR NOT EXISTS (SELECT 1 FROM late_settlement_application a WHERE a."lateSettlementId" = c."evidenceKey"))
    ELSE false END;
  IF ok IS NOT TRUE OR (NEW.kind <> 'refund_completed' AND NEW."refundCaseId" IS NOT NULL) OR (NEW.kind <> 'loss_recognized' AND NEW."lossId" IS NOT NULL)
     OR (NEW.kind <> 'recovery_counted' AND NEW."recoveryPaymentId" IS NOT NULL) OR (NEW.kind <> 'chargeback_returned' AND NEW."disputeId" IS NOT NULL) THEN
    RAISE EXCEPTION 'reconciliation case %: % is not a resolution its evidence supports', NEW."caseId", NEW.kind USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_resolution_evidence';
  END IF;
  NEW."resolvedAt" := now();
  RETURN NEW;
END $$;

-- 0034's cancellation guard (R6B-10), unchanged, plus DO-73 (U-2, O1): a refund case is not cancelled while verified unallocated refund money is
-- recorded on one of its relays. Billing-local: it governs only what Billing already holds (see the header).
CREATE OR REPLACE FUNCTION billing_refund_case_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'cancelled' AND EXISTS (
    SELECT 1 FROM refund_authorization_relay r WHERE r."refundCaseId" = OLD.id
       AND (r."attemptStatus" IS NULL OR r."attemptStatus" NOT IN ('authorization_expired', 'authorization_refused', 'rejected'))) THEN
    RAISE EXCEPTION 'refund case %: refund processing has begun', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'refund_case_processing_started';
  END IF;
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' AND EXISTS (
    SELECT 1 FROM reconciliation_unallocated_evidence e JOIN refund_authorization_relay r ON r.id = e."relayId" WHERE r."refundCaseId" = OLD.id) THEN
    RAISE EXCEPTION 'refund case %: a verified unallocated refund is recorded on one of its relays (DO-73)', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'refund_case_refund_evidence_unallocated';
  END IF;
  RETURN NEW;
END $$;
