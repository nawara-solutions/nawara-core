-- 0051 — billing-service: unresolved refund and chargeback exposure (Core V2 S0-C15A; S0 §1.5 S0-C15A; register BIL-33 N; finding DO-72).
-- DEVELOPMENT AND SIMULATION ONLY. Expand only: new functions, one new trigger, one replaced function and one widened CHECK. No row is written,
-- rewritten or deleted; every existing guard keeps refusing what it refused, and S0-C14's overlap rule is unchanged.
--
--   * Exposure (item 1): a verified loss with a chargeback fact, no completed refund of its captured movement, and refund evidence of that movement
--     that is not resolved. It says what is established and no more: the chargeback is verified; the refund evidence may or may not be money. The
--     case's `detail` records which, at opening (item 4). Nothing here reads a balance.
--   * It is not an overlap (item 2): it freezes no collection, creates no restriction and changes no waiting effect.
--   * Acknowledgement (item 6): `billing_acknowledgement_refused_by_exposure` is the ONE rule, called by this database's guard and by the service.
--     `provider_statement_reviewed` makes no claim about money and stays available; the exposure case, which cannot be acknowledged, stays open.
--   * Exit (item 5): only `refund_completed`, of the same movement, once that movement's overlap case exists. No timer, no Owner action.
-- Nothing here assigns liability, forgives debt, sets a timeout or resolves D9, D15 or the collection freeze.

-- item 1: refund evidence of the loss's movement that is unresolved. A `refund_discrepancy` case whose relay Billing does not hold counts because
-- it cannot be shown to be other money (fail closed); a relay of ANOTHER capture never counts.
CREATE FUNCTION billing_loss_unresolved_exposure(p_dispute uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM payment_dispute_loss l
     WHERE l."disputeId" = p_dispute AND l."chargebackFactId" IS NOT NULL AND NOT billing_loss_overlap(p_dispute)
       AND (EXISTS (
              SELECT 1 FROM refund_authorization_relay x JOIN refund_case r ON r.id = x."refundCaseId"
               WHERE r."paymentId" = l."paymentId" AND billing_refund_case_on_loss_movement(r.id, p_dispute)
                 AND (x."attemptStatus" = 'discrepancy' OR (x."attemptStatus" = 'succeeded' AND r.status <> 'completed')))
            OR EXISTS (
              SELECT 1 FROM reconciliation_case k
               WHERE k."caseType" = 'refund_discrepancy' AND k."paymentId" = l."paymentId"
                 AND (NOT EXISTS (SELECT 1 FROM refund_authorization_relay x WHERE x.id = k."evidenceKey")
                      OR EXISTS (SELECT 1 FROM refund_authorization_relay x WHERE x.id = k."evidenceKey"
                                    AND billing_refund_case_on_loss_movement(x."refundCaseId", p_dispute)))))
  );
$$;

-- item 6: an exposure exists on the movement of a case's evidence (the same reach as S0-C14's billing_case_movement_overlap)
CREATE FUNCTION billing_case_movement_exposed(p_case uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM reconciliation_case c JOIN payment_dispute_loss l
        ON l."disputeId" = c."evidenceKey"
        OR (l."paymentId" = coalesce(c."paymentId", (SELECT pr."paymentId" FROM payment_request pr WHERE pr.id = c."paymentRequestId"))
            AND (c."captureFactId" IS NULL OR l."captureFactId" IS NULL OR l."captureFactId" = c."captureFactId"))
        OR l."paymentRequestId" = (SELECT s."paymentRequestId" FROM subscription_purchase s WHERE s.id = c."evidenceKey")
     WHERE c.id = p_case AND billing_loss_unresolved_exposure(l."disputeId"));
$$;

-- item 6: the two reasons that assert something the Owner cannot support while the evidence is unresolved
CREATE FUNCTION billing_acknowledgement_refused_by_exposure(p_case uuid, p_reason text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_reason IN ('reviewed_no_financial_effect', 'duplicate_evidence_reviewed') AND billing_case_movement_exposed(p_case);
$$;

ALTER TABLE reconciliation_case DROP CONSTRAINT reconciliation_case_type;
ALTER TABLE reconciliation_case ADD CONSTRAINT reconciliation_case_type CHECK ("caseType" IN ('late_assisted_settlement', 'recovery_surplus', 'late_success',
  'unmatched_capture', 'unrouted_settlement', 'over_return', 'refund_discrepancy', 'partial_chargeback', 'second_reversal_cause', 'contradictory_effect',
  'authorization_pending', 'chargeback_refund_overlap', 'capture_contradiction', 'chargeback_loss_review', 'chargeback_effect_waiting',
  'chargeback_refund_exposure'));

-- item 4: an exposure case is about one verified loss with a chargeback fact, and states one of the two closed evidence classes
CREATE FUNCTION billing_reconciliation_exposure_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."caseType" = 'chargeback_refund_exposure'
     AND (NEW.detail IS NULL OR NEW.detail NOT IN ('refund_money_verified', 'refund_evidence_unresolved')
          OR NOT EXISTS (SELECT 1 FROM payment_dispute_loss l WHERE l."disputeId" = NEW."evidenceKey" AND l."chargebackFactId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'reconciliation case: an exposure names a verified loss with a chargeback fact and a closed evidence class' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_exposure_evidence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_case_07_exposure BEFORE INSERT ON reconciliation_case FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_exposure_case_guard();

-- 0050's resolution guard, unchanged, plus items 5 and 6
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
