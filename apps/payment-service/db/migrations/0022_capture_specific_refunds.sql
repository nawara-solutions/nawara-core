-- Core V2 S6h R6H-5 (the Owner's decision, 2026-10-30; register PAY-07 H, PAY-13 G; Auth receipt contract §17f), for Core V2 DEVELOPMENT
-- AND SIMULATION ONLY: a CAPTURE-SPECIFIC refund returns, in full, exactly ONE verified captured money movement (a `capture`
-- provider_transaction_fact) under an Owner receipt whose binding names that fact (`captureFactId`). An ordinary refund is unchanged.
--
--   * `refund_attempt."captureSpecific"` (immutable, false for every existing and every ordinary attempt): the attempt's `captureFactId` is
--     then part of the receipt binding Payment presents to Auth, so an ordinary receipt never authorizes it, nor the reverse, nor another
--     capture. Its fact is either the payment's own (matched: a late capture after the payment ended, a capture of another attempt, a second
--     distinct capture of the settling attempt, or the settling capture itself) or an unmatched fact ASSOCIATED with the payment (S6h-P);
--     `capturedAttemptId` is then the fact's attempt, or, for an associated fact (which has none), the payment's first attempt with the
--     fact's provider (the attempt the association guard required): the anchor of the refund facts' binding, never a claim about the capture.
--   * Financial uniqueness, REPLACED scope-correctly (never relaxed):
--       - per CAPTURE FACT: at most one potentially effective attempt (any kind), one completed authorization, and no new attempt once any
--         refund evidence of an attempt on that capture exists;
--       - per PAYMENT, for ORDINARY attempts: exactly the rules of S6b and S6c (one potentially effective ordinary attempt, one completed
--         ordinary authorization). Every existing attempt and authorization is ordinary and on the sale's capture, so for them nothing changes;
--       - a second distinct capture of the settling attempt is refundable only while ANOTHER capture of that attempt stays unrefunded (the
--         sale keeps its money; the ordinary refund of an ambiguous capture stays refused, S6b).
--   * The composite foreign key from an attempt to its capture fact (0017) cannot express an associated fact (no payment, no attempt on the
--     fact): it is replaced by the insert guard's equivalent check (facts are immutable, so an insert-time check is permanent).
-- Expand only: new columns with safe defaults, new indexes, replaced guards. No fact, attempt or authorization changes meaning.

ALTER TABLE refund_attempt ADD COLUMN "captureSpecific" boolean NOT NULL DEFAULT false;
CREATE TRIGGER refund_attempt_12_capture_immutable BEFORE UPDATE ON refund_attempt
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('captureSpecific');
ALTER TABLE refund_attempt ADD CONSTRAINT refund_attempt_capture_binding UNIQUE (id, "captureFactId", "captureSpecific");
ALTER TABLE refund_attempt DROP CONSTRAINT refund_attempt_capture;

-- per payment for ORDINARY attempts (the S6b rule, same name); per capture fact for EVERY attempt
DROP INDEX refund_attempt_one_effective;
CREATE UNIQUE INDEX refund_attempt_one_effective ON refund_attempt ("paymentId")
  WHERE status NOT IN ('authorization_expired', 'authorization_refused', 'failed') AND NOT "captureSpecific";
CREATE UNIQUE INDEX refund_attempt_one_effective_capture ON refund_attempt ("captureFactId")
  WHERE status NOT IN ('authorization_expired', 'authorization_refused', 'failed');
CREATE INDEX refund_attempt_capture_idx ON refund_attempt ("captureFactId");

ALTER TABLE refund_attempt_refusal DROP CONSTRAINT refund_attempt_refusal_code;
ALTER TABLE refund_attempt_refusal ADD CONSTRAINT refund_attempt_refusal_code CHECK (code IN ('payment_not_refundable', 'refund_capture_unverified',
  'refund_amount_not_full', 'refund_dispute_open', 'refund_in_progress', 'refund_already_recorded', 'refund_case_completed', 'refund_capture_not_eligible'));

-- refund evidence of the capture: a matched refund fact of an attempt on it, or an associated unmatched refund fact allocated to (or
-- targeting) an authorization of an attempt on it
CREATE FUNCTION refund_capture_has_evidence(capture uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM provider_transaction_fact f JOIN refund_attempt a ON a.id = f."refundAttemptId"
                  WHERE f.kind = 'refund' AND a."captureFactId" = capture)
      OR EXISTS (SELECT 1 FROM provider_fact_association s JOIN refund_authorization z ON z.id = s."refundAuthorizationId"
                   JOIN refund_attempt a ON a.id = z."refundAttemptId"
                  WHERE s.status IN ('authorization_pending', 'associated') AND a."captureFactId" = capture)
$$;

CREATE OR REPLACE FUNCTION refund_attempt_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payment%ROWTYPE; f provider_transaction_fact%ROWTYPE; remaining integer; bound boolean;
BEGIN
  IF NEW.status <> 'authorization_pending' OR NEW."workAfter" IS NOT NULL THEN
    RAISE EXCEPTION 'refund_attempt: a new attempt starts as authorization_pending' USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_insert_state';
  END IF;
  SELECT * INTO p FROM payment WHERE id = NEW."paymentId" FOR UPDATE;
  SELECT * INTO f FROM provider_transaction_fact WHERE id = NEW."captureFactId";
  IF NOT NEW."captureSpecific" THEN
    -- the S6b ordinary refund, unchanged: the succeeded payment's own verified capture, in full
    IF p.status <> 'succeeded' OR p."settledMethod" IS DISTINCT FROM 'gateway' OR p."sellerType" <> 'company' OR p."sellerId" <> NEW."companyId"::text
       OR p."succeededAttemptId" IS DISTINCT FROM NEW."capturedAttemptId" OR p.amount <> NEW.amount OR p.currency <> NEW.currency
       OR p.producer <> NEW.producer OR p."liveMode" IS DISTINCT FROM false
       OR p.purpose IS NULL OR p.purpose NOT IN ('direct_purchase', 'assisted_settlement', 'non_entitlement', 'recovery_settlement') THEN
      RAISE EXCEPTION 'refund_attempt: payment % is not refundable as requested', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_payment_refundable';
    END IF;
    IF f.id IS NULL OR f.kind <> 'capture' OR f."paymentId" IS DISTINCT FROM NEW."paymentId" OR f."attemptId" IS DISTINCT FROM NEW."capturedAttemptId"
       OR f.provider <> NEW.provider OR f.amount <> p.amount OR f.currency <> p.currency
       OR EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = NEW."captureFactId")
       -- R6H-5 (defence in depth behind the application): the settling attempt's ONE capture; two distinct captures leave the sale ambiguous
       OR (SELECT count(*) FROM provider_transaction_fact g WHERE g."paymentId" = p.id AND g."attemptId" = p."succeededAttemptId" AND g.kind = 'capture') <> 1 THEN
      RAISE EXCEPTION 'refund_attempt: the capture is not verified for the full amount' USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_capture_verified';
    END IF;
  ELSE
    -- R6H-5: one verified capture of this payment (matched, or associated with it), in full, from the Company's simulation payment
    IF p.id IS NULL OR p.status NOT IN ('succeeded', 'failed', 'expired', 'cancelled') OR p."sellerType" <> 'company' OR p."sellerId" <> NEW."companyId"::text
       OR p.producer <> NEW.producer OR p."liveMode" IS DISTINCT FROM false
       OR p.purpose IS NULL OR p.purpose NOT IN ('direct_purchase', 'assisted_settlement', 'non_entitlement', 'recovery_settlement') THEN
      RAISE EXCEPTION 'refund_attempt: payment % is not refundable as requested', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_payment_refundable';
    END IF;
    -- the capture is this payment's (matched to it and to the bound attempt) or associated with it (anchored on its first attempt of the
    -- provider). Computed as an explicit boolean: a NULL (an unmatched fact has no payment or attempt) is never read as "not refused"
    bound := COALESCE(f."paymentId" = NEW."paymentId" AND f."attemptId" = NEW."capturedAttemptId", false)
      OR (f."paymentId" IS NULL
          AND EXISTS (SELECT 1 FROM provider_fact_association s WHERE s."factId" = f.id AND s.status = 'associated' AND s."targetType" = 'payment'
                        AND s."paymentId" = NEW."paymentId")
          AND COALESCE(NEW."capturedAttemptId" = (SELECT t.id FROM payment_attempt t WHERE t."paymentId" = NEW."paymentId" AND t.provider = f.provider
                                                   ORDER BY t."attemptNumber", t.id LIMIT 1), false));
    IF f.id IS NULL OR f.kind <> 'capture' OR f."liveMode" IS DISTINCT FROM false OR f.provider <> NEW.provider
       OR f.amount <> NEW.amount OR f.currency <> NEW.currency
       OR EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id)
       OR bound IS NOT TRUE THEN
      RAISE EXCEPTION 'refund_attempt: the capture is not verified for the full amount' USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_capture_verified';
    END IF;
    -- a second distinct capture of the settling attempt: only while another capture of that attempt stays unrefunded (the sale's money)
    IF p.status = 'succeeded' AND f."attemptId" IS NOT DISTINCT FROM p."succeededAttemptId" AND f."attemptId" IS NOT NULL
       AND (SELECT count(*) FROM provider_transaction_fact g WHERE g."attemptId" = f."attemptId" AND g."paymentId" = p.id AND g.kind = 'capture') > 1 THEN
      SELECT count(*) INTO remaining FROM provider_transaction_fact g
       WHERE g."attemptId" = f."attemptId" AND g."paymentId" = p.id AND g.kind = 'capture' AND g.id <> f.id
         AND NOT EXISTS (SELECT 1 FROM refund_attempt a WHERE a."captureFactId" = g.id AND a.status NOT IN ('authorization_expired', 'authorization_refused', 'failed'))
         AND NOT refund_capture_has_evidence(g.id);
      IF remaining = 0 THEN
        RAISE EXCEPTION 'refund_attempt: capture % is the last of the settling attempt', f.id USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_capture_eligible';
      END IF;
    END IF;
  END IF;
  -- FC-5, per capture: no refund evidence of this captured money already (any kind of attempt)
  IF refund_capture_has_evidence(NEW."captureFactId") THEN
    RAISE EXCEPTION 'refund_attempt: capture % already has refund evidence', NEW."captureFactId" USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_no_refund_fact';
  END IF;
  IF EXISTS (SELECT 1 FROM refund_attempt_refusal r WHERE r.id = NEW.id) THEN
    RAISE EXCEPTION 'refund_attempt: % was refused' , NEW.id USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_refused_id';
  END IF;
  NEW."requestedAt" := now();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── authorizations and completion

ALTER TABLE refund_authorization ADD COLUMN "captureFactId" uuid;
ALTER TABLE refund_authorization ADD COLUMN "captureSpecific" boolean NOT NULL DEFAULT false;
UPDATE refund_authorization z SET "captureFactId" = a."captureFactId" FROM refund_attempt a WHERE a.id = z."refundAttemptId";
ALTER TABLE refund_authorization ALTER COLUMN "captureFactId" SET NOT NULL;
ALTER TABLE refund_authorization ADD CONSTRAINT refund_authorization_capture FOREIGN KEY ("refundAttemptId", "captureFactId", "captureSpecific")
  REFERENCES refund_attempt (id, "captureFactId", "captureSpecific");
CREATE TRIGGER refund_authorization_12_capture_immutable BEFORE UPDATE ON refund_authorization
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('captureFactId', 'captureSpecific');

-- the authorization's capture is DERIVED from its attempt, never a written value (the S6c guard, plus the derivation)
CREATE OR REPLACE FUNCTION refund_authorization_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a refund_attempt%ROWTYPE;
BEGIN
  SELECT * INTO a FROM refund_attempt WHERE id = NEW."refundAttemptId";
  IF a.id IS NULL OR a."receiptId" IS NULL OR a."receiptId" <> NEW."receiptId" OR a."approvedByUserId" <> NEW."approvedByUserId"
     OR a."paymentId" <> NEW."paymentId" OR a."refundCaseId" <> NEW."refundCaseId" OR a.producer <> NEW.producer
     OR a.amount <> NEW."approvedAmount" OR a.currency <> NEW.currency THEN
    RAISE EXCEPTION 'refund_authorization: not the consumed authorization of attempt %', NEW."refundAttemptId" USING ERRCODE = '23514', CONSTRAINT = 'refund_authorization_from_attempt';
  END IF;
  IF NEW."allocatedIntended" <> 0 OR NEW."completedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'refund_authorization: starts with nothing allocated' USING ERRCODE = '23514', CONSTRAINT = 'refund_authorization_created_empty';
  END IF;
  NEW."captureFactId" := a."captureFactId";
  NEW."captureSpecific" := a."captureSpecific";
  NEW."createdAt" := now();
  RETURN NEW;
END $$;

-- a completed refund is never refundable again: per payment for ORDINARY authorizations (S6c, same name), per capture fact for every one
DROP INDEX refund_authorization_payment_completed;
CREATE UNIQUE INDEX refund_authorization_payment_completed ON refund_authorization ("paymentId") WHERE "completedAt" IS NOT NULL AND NOT "captureSpecific";
CREATE UNIQUE INDEX refund_authorization_capture_completed ON refund_authorization ("captureFactId") WHERE "completedAt" IS NOT NULL;

CREATE OR REPLACE FUNCTION refund_attempt_case_completed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM refund_authorization z WHERE z."completedAt" IS NOT NULL
               AND (z."refundCaseId" = NEW."refundCaseId" OR z."captureFactId" = NEW."captureFactId"
                    OR (NOT NEW."captureSpecific" AND NOT z."captureSpecific" AND z."paymentId" = NEW."paymentId"))) THEN
    RAISE EXCEPTION 'refund_attempt: refund case % is completed', NEW."refundCaseId" USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_case_completed';
  END IF;
  RETURN NEW;
END $$;
