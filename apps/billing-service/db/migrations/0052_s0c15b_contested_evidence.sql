-- 0052 — billing-service: contested refund and dispute evidence stays Owner-visible (Core V2 S0-C15B; S0 §1.5 S0-C15B; register BIL-33 O; findings
-- DO-56, DO-57). DEVELOPMENT AND SIMULATION ONLY. Expand only: two case types, one evidence table, new functions, guards and one replaced function.
-- No existing row is written, rewritten or deleted; every existing guard keeps refusing what it refused; S0-C14 and S0-C15A rules are unchanged.
--
--   * `refund_fact_contested` (DO-57): one case per refund fact Payment holds as CONTESTED (a recorded provider_transaction_fact_conflict on it), opened only
--     when Payment's reads agree (B-D6). Its amount is the VERIFIED fact's amount; contested provider amounts never enter Billing. `detail` says whether the
--     fact was allocated before it was contested. Allocation blocks for currency_mismatch or no_authorization are NOT contests (B-D8; DO-73 is separate).
--   * `dispute_conflict_observed` (DO-56): one case per preserved dispute conflict of the payment, from Payment's REDACTED producer item: it can hold no
--     amount, currency, capture or detail (the S0-C13 Owner-only boundary, enforced here as well as in code).
--   * INTERIM FAIL-CLOSED CONDITION (B-D3): neither type can be acknowledged or resolved in this development and simulation phase, until P-2 (dispute-
--     conflict resolution) and the FD resolution decisions define the evidence that may close them. This is not a permanent business rule.
--   * Acknowledgement (B-D4): `billing_acknowledgement_refused_by_contest` is the ONE rule, called by this database's guard and by the service.
--     `reviewed_no_financial_effect` is refused on the contested movement; `duplicate_evidence_reviewed` only on the contested refund attempt's own case;
--     `provider_statement_reviewed` stays available.
--   * `reconciliation_contest_evidence` binds a refund-contest case to its payment, refund fact, Billing's own relay (if any) and that relay's capture. Its
--     constraints establish LOCAL referential integrity between Billing's own rows; they prove nothing about provider financial truth.
-- Nothing here records a fact, a loss, a debt or a liability, changes a purchase or an obligation, or resolves D9, D15, P-2 or the collection freeze.

ALTER TABLE reconciliation_case DROP CONSTRAINT reconciliation_case_type;
ALTER TABLE reconciliation_case ADD CONSTRAINT reconciliation_case_type CHECK ("caseType" IN ('late_assisted_settlement', 'recovery_surplus', 'late_success',
  'unmatched_capture', 'unrouted_settlement', 'over_return', 'refund_discrepancy', 'partial_chargeback', 'second_reversal_cause', 'contradictory_effect',
  'authorization_pending', 'chargeback_refund_overlap', 'capture_contradiction', 'chargeback_loss_review', 'chargeback_effect_waiting',
  'chargeback_refund_exposure', 'refund_fact_contested', 'dispute_conflict_observed'));

-- the shape of each new case: a contest names a payment and the verified figures with one of two closed classes; a dispute conflict names only its payment
CREATE FUNCTION billing_reconciliation_contest_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."caseType" = 'refund_fact_contested'
     AND (NEW."paymentId" IS NULL OR NEW.amount IS NULL OR NEW.detail IS NULL OR NEW.detail NOT IN ('contested_after_allocation', 'contested_unallocated')) THEN
    RAISE EXCEPTION 'reconciliation case: a refund contest names its payment, the verified amount and a closed class' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_contest_shape';
  END IF;
  IF NEW."caseType" = 'dispute_conflict_observed'
     AND (NEW."paymentId" IS NULL OR NEW.amount IS NOT NULL OR NEW.currency IS NOT NULL OR NEW."captureFactId" IS NOT NULL OR NEW.detail IS NOT NULL) THEN
    RAISE EXCEPTION 'reconciliation case: a dispute conflict names its payment only (redacted)' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_dispute_conflict_redacted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_case_08_contest BEFORE INSERT ON reconciliation_case FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_contest_case_guard();

-- the evidence of one refund-contest case, written in the case's own transaction
CREATE TABLE reconciliation_contest_evidence (
  "caseId"           uuid PRIMARY KEY REFERENCES reconciliation_case (id),
  "paymentId"        uuid NOT NULL,
  "refundFactId"     uuid NOT NULL,
  "refundAttemptId"  uuid REFERENCES refund_authorization_relay (id),   -- Billing's own relay of the contested attempt, when Billing holds it
  "captureFactId"    uuid,                                              -- derived from that relay's refund case, never supplied
  "recordedAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_contest_evidence_fact_once UNIQUE ("refundFactId")
);
CREATE FUNCTION billing_reconciliation_contest_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c reconciliation_case%ROWTYPE; cap uuid;
BEGIN
  SELECT * INTO c FROM reconciliation_case WHERE id = NEW."caseId";
  IF c."caseType" IS DISTINCT FROM 'refund_fact_contested' OR c."paymentId" IS DISTINCT FROM NEW."paymentId" OR c."evidenceKey" IS DISTINCT FROM NEW."refundFactId" THEN
    RAISE EXCEPTION 'contest evidence: it belongs to exactly its refund-contest case, payment and fact' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_contest_evidence_case';
  END IF;
  IF NEW."captureFactId" IS NOT NULL THEN
    RAISE EXCEPTION 'contest evidence: the capture is derived from Billing''s own relay, never supplied' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_contest_evidence_capture_supplied';
  END IF;
  IF NEW."refundAttemptId" IS NOT NULL THEN
    SELECT r."captureFactId" INTO cap FROM refund_authorization_relay x JOIN refund_case r ON r.id = x."refundCaseId"
     WHERE x.id = NEW."refundAttemptId" AND x."paymentId" = NEW."paymentId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'contest evidence: the refund attempt is a relay of another payment' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_contest_evidence_attempt';
    END IF;
    NEW."captureFactId" := cap;
  END IF;
  IF NEW."captureFactId" IS DISTINCT FROM c."captureFactId" THEN
    RAISE EXCEPTION 'contest evidence: the case names another capture than its relay' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_contest_evidence_capture';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_contest_evidence_05_guard BEFORE INSERT ON reconciliation_contest_evidence FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_contest_evidence_guard();
CREATE TRIGGER reconciliation_contest_evidence_10_append_only BEFORE UPDATE OR DELETE ON reconciliation_contest_evidence FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER reconciliation_contest_evidence_11_no_truncate BEFORE TRUNCATE ON reconciliation_contest_evidence FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- no refund-contest case commits without its evidence (checked at commit: the case and its evidence are one transaction)
CREATE FUNCTION billing_reconciliation_contest_evidence_present() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."caseType" = 'refund_fact_contested' AND NOT EXISTS (SELECT 1 FROM reconciliation_contest_evidence e WHERE e."caseId" = NEW.id) THEN
    RAISE EXCEPTION 'reconciliation case %: a refund contest commits with its evidence', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_contest_evidence_missing';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reconciliation_case_09_contest_evidence AFTER INSERT ON reconciliation_case DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_contest_evidence_present();

-- B-D4: a contested case on the same payment and capture (a dispute conflict's capture is unattributed: the whole payment)
CREATE FUNCTION billing_case_movement_contested(p_case uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM reconciliation_case c JOIN reconciliation_case k
        ON k."caseType" IN ('refund_fact_contested', 'dispute_conflict_observed') AND k.id <> c.id
       AND k."paymentId" = coalesce(c."paymentId", (SELECT pr."paymentId" FROM payment_request pr WHERE pr.id = c."paymentRequestId"))
       AND (k."caseType" = 'dispute_conflict_observed' OR c."captureFactId" IS NULL OR k."captureFactId" IS NULL OR k."captureFactId" = c."captureFactId")
     WHERE c.id = p_case);
$$;

-- B-D4: the one rule. No financial effect cannot be stated on a contested movement; "a duplicate" cannot be stated on the contested refund attempt's own
-- discrepancy case. Any other duplicate review, and every reviewed provider statement, stays available.
CREATE FUNCTION billing_acknowledgement_refused_by_contest(p_case uuid, p_reason text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT (p_reason = 'reviewed_no_financial_effect' AND billing_case_movement_contested(p_case))
      OR (p_reason = 'duplicate_evidence_reviewed' AND EXISTS (
            SELECT 1 FROM reconciliation_case c JOIN reconciliation_contest_evidence e ON e."paymentId" = c."paymentId" AND e."refundAttemptId" = c."evidenceKey"
             WHERE c.id = p_case AND c."caseType" = 'refund_discrepancy'));
$$;

-- 0051's resolution guard, unchanged, plus B-D4. The two new types appear in no resolution branch: every kind, `acknowledged` included, is refused (B-D3).
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
