-- 0050 — billing-service: refund and chargeback overlap precedence (Core V2 S0-C14 WP B; S0 §1.5 S0-C14 items 2 to 15; register BIL-26 H,
-- BIL-28 H, BIL-29 G, BIL-33 M, BIL-34 H; findings DO-50, DO-51, DO-52). DEVELOPMENT AND SIMULATION ONLY. Expand only: one new table, new
-- functions and triggers, two replaced functions and one widened CHECK. No row is written, rewritten or deleted; every existing guard keeps
-- refusing what it refused.
--
--   * A loss's CAPTURED MOVEMENT (S0-C14 item 2): its payment and capture. A settling-capture loss's movement is the payment's ordinary refund
--     cases (no capture fact) and a capture-specific refund of that same capture; a late-capture loss's movement is exactly its capture fact's
--     refund cases. A refund of ANOTHER capture of the payment is never the same movement.
--   * Waiting effect (items 5, 6): a recovery obligation or a direct write-off is refused while any relay of its loss's movement may still
--     produce a refund: NULL (unconfirmed), authorization_pending, authorized, dispatching, submitted, unknown, discrepancy, or succeeded with its
--     case not completed. This is only the LOCAL half of item 6; the remote half (a fresh Payment read after the loss) is the application's, and
--     no lock spans Billing and Payment. A refund reported after a confirmed failure can still coexist with an effect; item 8 then applies.
--   * Overlap (item 2): a verified loss AND a completed refund of the same movement, decided from recorded facts whatever their order.
--   * Collection freeze (item 7): no NEW recovery settlement channel while the obligation's movement is in overlap. Channels already started,
--     verified recovery payments and every other discharge action are untouched.
--   * Suspension evidence (items 10, 11): append-only; T3 excludes an obligation with an active suspension. Nothing here creates a route.
--   * Waiting visibility (item 12): case type `chargeback_effect_waiting`, resolved only as `effect_applied` (the effect exists) or
--     `refund_completed` (the completed refund of the SAME movement, and no effect).
--   * Acknowledgement (item 9): `reviewed_no_financial_effect` is refused while an overlap exists on the case's movement.
-- Nothing here assigns liability, forgives debt, sets a timeout or ends an overlap (item 15; D9 and D15 stay open).

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the captured movement of a loss

CREATE FUNCTION billing_refund_case_on_loss_movement(p_case uuid, p_dispute uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM refund_case r JOIN payment_dispute_loss l ON l."disputeId" = p_dispute
     WHERE r.id = p_case AND r."paymentId" = l."paymentId"
       AND CASE WHEN l."captureBasis" = 'late_capture' THEN r."captureFactId" IS NOT NULL AND r."captureFactId" = l."captureFactId"
                ELSE r."captureFactId" IS NULL
                     OR (l."captureFactId" IS NOT NULL AND r."captureFactId" = l."captureFactId")
                     OR r."captureBasis" = 'unrouted_capture' END);
$$;

-- a relay of the loss's movement that may still produce a refund (item 5)
CREATE FUNCTION billing_loss_refund_live(p_dispute uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM refund_authorization_relay x JOIN refund_case r ON r.id = x."refundCaseId" JOIN payment_dispute_loss l ON l."disputeId" = p_dispute
     WHERE r."paymentId" = l."paymentId" AND billing_refund_case_on_loss_movement(r.id, p_dispute)
       AND (x."attemptStatus" IS NULL
            OR x."attemptStatus" IN ('authorization_pending', 'authorized', 'dispatching', 'submitted', 'unknown', 'discrepancy')
            OR (x."attemptStatus" = 'succeeded' AND r.status <> 'completed')));
$$;

-- the completed refund of the loss's movement, if any (deterministic)
CREATE FUNCTION billing_loss_completed_refund(p_dispute uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT r.id FROM refund_case r JOIN payment_dispute_loss l ON l."disputeId" = p_dispute
   WHERE r."paymentId" = l."paymentId" AND r.status = 'completed' AND billing_refund_case_on_loss_movement(r.id, p_dispute)
   ORDER BY r."completedAt", r.id LIMIT 1;
$$;

-- item 2: a verified loss and a completed refund of the same captured movement
CREATE FUNCTION billing_loss_overlap(p_dispute uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT billing_loss_completed_refund(p_dispute) IS NOT NULL;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── waiting effects: the local half (items 5, 6)

CREATE FUNCTION billing_recovery_obligation_refund_live_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF billing_loss_refund_live(NEW."disputeId") OR billing_loss_overlap(NEW."disputeId") THEN
    RAISE EXCEPTION 'recovery obligation: a refund of the captured movement of loss % is live or completed (S0-C14 items 5, 6)', NEW."disputeId"
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_refund_live';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_obligation_08_refund_live BEFORE INSERT ON recovery_obligation FOR EACH ROW EXECUTE FUNCTION billing_recovery_obligation_refund_live_guard();

CREATE FUNCTION billing_financial_loss_refund_live_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'direct_chargeback_write_off' AND (billing_loss_refund_live(NEW."disputeId") OR billing_loss_overlap(NEW."disputeId")) THEN
    RAISE EXCEPTION 'financial loss: a refund of the captured movement of loss % is live or completed (S0-C14 items 5, 6)', NEW."disputeId"
      USING ERRCODE = '23514', CONSTRAINT = 'financial_loss_refund_live';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_loss_08_refund_live BEFORE INSERT ON financial_loss FOR EACH ROW EXECUTE FUNCTION billing_financial_loss_refund_live_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── collection freeze (item 7)

CREATE FUNCTION billing_recovery_obligation_frozen(p_obligation uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM recovery_obligation o WHERE o.id = p_obligation AND billing_loss_overlap(o."disputeId"));
$$;

-- 0039's channel insert guard, unchanged, plus item 7 checked FIRST after its Organization and obligation locks: a frozen obligation starts no
-- NEW channel, whatever else the insert carries
CREATE OR REPLACE FUNCTION billing_recovery_channel_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o recovery_obligation%ROWTYPE;
BEGIN
  SELECT * INTO o FROM recovery_obligation WHERE id = NEW."obligationId";
  PERFORM billing_assistance_organization_lock(o."organizationId");
  PERFORM pg_advisory_xact_lock(hashtextextended('billing.recovery:' || NEW."obligationId", 0));
  IF billing_recovery_obligation_frozen(NEW."obligationId") THEN
    RAISE EXCEPTION 'recovery channel: obligation % is in a refund and chargeback overlap; no new settlement channel starts (S0-C14 item 7)', NEW."obligationId"
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_collection_frozen';
  END IF;
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

-- ─────────────────────────────────────────────────────────────────────────────────────────────── suspension evidence (items 10, 11)

CREATE TABLE recovery_restriction_suspension_event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "suspensionId"     uuid NOT NULL,                                     -- chosen before the Auth receipt, bound into it
  kind               text NOT NULL,
  "obligationId"     uuid NOT NULL REFERENCES recovery_obligation (id),
  "organizationId"   uuid NOT NULL,
  "companyId"        uuid NOT NULL,
  "disputeId"        uuid NOT NULL REFERENCES payment_dispute_loss ("disputeId"),
  "refundCaseId"     uuid NOT NULL REFERENCES refund_case (id),
  "reasonCode"       text NOT NULL,
  "actorUserId"      uuid NOT NULL,                                     -- the Owner Auth verified
  "receiptId"        uuid NOT NULL UNIQUE,                              -- Auth's consumed receipt
  "consumeRef"       uuid NOT NULL UNIQUE,
  "recordedAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recovery_restriction_suspension_event_once UNIQUE ("suspensionId", kind),
  CONSTRAINT recovery_restriction_suspension_event_kind CHECK (
       (kind = 'suspended' AND "reasonCode" = 'refund_chargeback_overlap')
    OR (kind = 'revoked' AND "reasonCode" = 'owner_reinstated_restriction'))
);
CREATE INDEX recovery_restriction_suspension_event_obligation_idx ON recovery_restriction_suspension_event ("obligationId");

-- an obligation's active suspension: suspended, never revoked
CREATE FUNCTION billing_recovery_restriction_suspended(p_obligation uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM recovery_restriction_suspension_event s WHERE s."obligationId" = p_obligation AND s.kind = 'suspended'
                   AND NOT EXISTS (SELECT 1 FROM recovery_restriction_suspension_event v WHERE v."suspensionId" = s."suspensionId" AND v.kind = 'revoked'));
$$;

CREATE FUNCTION billing_recovery_restriction_suspension_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o recovery_obligation%ROWTYPE; s recovery_restriction_suspension_event%ROWTYPE;
BEGIN
  SELECT * INTO o FROM recovery_obligation WHERE id = NEW."obligationId";
  -- the same lock as T3 at an assistance request, recovery and the channel guard: T3 is never read mid-change
  PERFORM billing_assistance_organization_lock(o."organizationId");
  SELECT * INTO o FROM recovery_obligation WHERE id = NEW."obligationId" FOR UPDATE;
  IF o.id IS NULL OR o."organizationId" <> NEW."organizationId" OR o."companyId" <> NEW."companyId" OR o."disputeId" <> NEW."disputeId"
     OR NOT EXISTS (SELECT 1 FROM refund_case r WHERE r.id = NEW."refundCaseId" AND r.status = 'completed')
     OR NOT billing_refund_case_on_loss_movement(NEW."refundCaseId", NEW."disputeId") THEN
    RAISE EXCEPTION 'recovery restriction suspension: not this obligation''s overlap evidence' USING ERRCODE = '23514', CONSTRAINT = 'recovery_restriction_suspension_evidence';
  END IF;
  IF NEW.kind = 'suspended' THEN
    IF o.status <> 'open' OR billing_recovery_outstanding(o.id) <= 0 OR NOT billing_loss_overlap(o."disputeId") THEN
      RAISE EXCEPTION 'recovery restriction suspension: obligation % is not open in an overlap', o.id USING ERRCODE = '23514', CONSTRAINT = 'recovery_restriction_suspension_eligible';
    END IF;
    IF billing_recovery_restriction_suspended(o.id) THEN
      RAISE EXCEPTION 'recovery restriction suspension: obligation % already has an active suspension', o.id USING ERRCODE = '23514', CONSTRAINT = 'recovery_restriction_suspension_active';
    END IF;
    IF EXISTS (SELECT 1 FROM recovery_restriction_suspension_event x WHERE x."suspensionId" = NEW."suspensionId") THEN
      RAISE EXCEPTION 'recovery restriction suspension: id % is already used', NEW."suspensionId" USING ERRCODE = '23514', CONSTRAINT = 'recovery_restriction_suspension_event_once';
    END IF;
  ELSE
    SELECT * INTO s FROM recovery_restriction_suspension_event x WHERE x."suspensionId" = NEW."suspensionId" AND x.kind = 'suspended';
    IF s.id IS NULL OR s."obligationId" <> NEW."obligationId" OR s."companyId" <> NEW."companyId" OR s."organizationId" <> NEW."organizationId"
       OR s."disputeId" <> NEW."disputeId" OR s."refundCaseId" <> NEW."refundCaseId" THEN
      RAISE EXCEPTION 'recovery restriction revocation: no matching suspension %', NEW."suspensionId" USING ERRCODE = '23514', CONSTRAINT = 'recovery_restriction_suspension_revocation';
    END IF;
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_restriction_suspension_event_05_guard BEFORE INSERT ON recovery_restriction_suspension_event
  FOR EACH ROW EXECUTE FUNCTION billing_recovery_restriction_suspension_guard();
CREATE TRIGGER recovery_restriction_suspension_event_10_append_only BEFORE UPDATE OR DELETE ON recovery_restriction_suspension_event
  FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER recovery_restriction_suspension_event_11_no_truncate BEFORE TRUNCATE ON recovery_restriction_suspension_event
  FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- T1 and T2 unchanged; T3 while a recovery obligation is open and has no active suspension (item 10). The debt is untouched (item 13)
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
     WHERE ro."organizationId" = p_organization AND ro.status = 'open' AND NOT billing_recovery_restriction_suspended(ro.id)
  ) r
  ORDER BY r.kind, r.since, r."sourceId";
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── reconciliation cases (items 8, 9, 12)

ALTER TABLE reconciliation_case DROP CONSTRAINT reconciliation_case_type;
ALTER TABLE reconciliation_case ADD CONSTRAINT reconciliation_case_type CHECK ("caseType" IN ('late_assisted_settlement', 'recovery_surplus', 'late_success',
  'unmatched_capture', 'unrouted_settlement', 'over_return', 'refund_discrepancy', 'partial_chargeback', 'second_reversal_cause', 'contradictory_effect',
  'authorization_pending', 'chargeback_refund_overlap', 'capture_contradiction', 'chargeback_loss_review', 'chargeback_effect_waiting'));

-- a waiting case is about one verified loss
CREATE FUNCTION billing_reconciliation_waiting_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."caseType" = 'chargeback_effect_waiting' AND NOT EXISTS (SELECT 1 FROM payment_dispute_loss l WHERE l."disputeId" = NEW."evidenceKey") THEN
    RAISE EXCEPTION 'reconciliation case: a waiting effect names a verified loss' USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_waiting_evidence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_case_06_waiting BEFORE INSERT ON reconciliation_case FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_waiting_case_guard();

-- the loss's automatic effect exists: its recovery obligation, or its direct write-off
CREATE FUNCTION billing_loss_effect_applied(p_dispute uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM recovery_obligation o WHERE o."disputeId" = p_dispute)
      OR EXISTS (SELECT 1 FROM financial_loss f WHERE f.kind = 'direct_chargeback_write_off' AND f."disputeId" = p_dispute);
$$;

-- item 9: the movement of a case's evidence is in overlap (the case's own loss, or a loss of its payment and capture)
CREATE FUNCTION billing_case_movement_overlap(p_case uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM reconciliation_case c JOIN payment_dispute_loss l
        ON l."disputeId" = c."evidenceKey"
        OR (l."paymentId" = coalesce(c."paymentId", (SELECT pr."paymentId" FROM payment_request pr WHERE pr.id = c."paymentRequestId"))
            AND (c."captureFactId" IS NULL OR l."captureFactId" IS NULL OR l."captureFactId" = c."captureFactId"))
        OR l."paymentRequestId" = (SELECT s."paymentRequestId" FROM subscription_purchase s WHERE s.id = c."evidenceKey")
     WHERE c.id = p_case AND billing_loss_overlap(l."disputeId"));
$$;

-- 0045's guard, unchanged for every existing kind and type, plus: item 12's two resolutions of a waiting case (strictly the same captured
-- movement, and `effect_applied` only when the effect exists) and item 9's refusal of `reviewed_no_financial_effect` during an overlap
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

-- ─────────────────────────────────────────────────────────────────────────────────────────────── privileges: the evidence is append-only

DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON recovery_restriction_suspension_event FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'recovery_restriction_suspension_event' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE %s ON recovery_restriction_suspension_event FROM %s', r.priv, r.role);
  END LOOP;
END $$;
