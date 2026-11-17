-- 0033 — payment-service: verified refund evidence of a FAILED attempt that cannot become `discrepancy`, kept as an append-only exception
-- (Core V2 RLSC-1; the Owner's RLSC-1 GO, Phase A, 2026-11-17). DEVELOPMENT AND SIMULATION ONLY. Expand only: one escalation kind, two nullable
-- columns, one partial unique index, one shape check and the 0032 insert guard extended by one branch (its two existing branches unchanged).
-- No existing row, index, constraint or privilege is weakened; nothing is backfilled; no refund, allocation, case or balance rule changes.
--
-- RLSC-1: a verified refund success for a `failed` attempt moves it to `discrepancy` (S6b). `discrepancy` is an effective status of
-- `refund_attempt_one_effective` (per payment, ordinary attempts) and `refund_attempt_one_effective_capture` (per capture), so while ANOTHER
-- attempt of the same payment and capture is effective that move is impossible (23505) and, before this migration, the notification failed
-- forever (500, retried until exhausted) although its fact was durable. Both indexes stay exactly as they are: the failed attempt stays `failed`
-- and the observation is kept here, once per fact, with the competing attempt the database validated at the recording boundary.
--
--   * kind `failed_attempt_refund_evidence`: the attempt is `failed`; the fact is a verified `refund` fact of that attempt (its own, reported
--     under its id or reference); the competing attempt is ANOTHER attempt of the same payment and capture whose status is effective
--     (not authorization_expired, authorization_refused or failed) when the row is written. Payment, Company, capture and both statuses are
--     derived from the attempts; a caller supplies only the kind, the attempt, the fact and the competing attempt.
--   * Nothing releases, resolves, allocates, reverses or compensates anything here (OD-RLSC-1, OD-RLSC-3, OD-RLSC-4 open). It is evidence for
--     review, never a resolution of the financial conflict.
--
-- Limits (recorded): a superuser can bypass triggers; the allocation of the fact (S6c / R6C-4) is unchanged and is NOT an Owner approval of the
-- overlap it can produce (an early case completion while the competing attempt is in flight; OD-RLSC-1).

ALTER TABLE refund_safety_escalation ADD COLUMN "competingAttemptId" uuid REFERENCES refund_attempt (id);   -- failed_attempt_refund_evidence only
ALTER TABLE refund_safety_escalation ADD COLUMN "competingAttemptStatus" text;                              -- derived: its status when recorded

ALTER TABLE refund_safety_escalation DROP CONSTRAINT refund_safety_escalation_kind;
ALTER TABLE refund_safety_escalation ADD CONSTRAINT refund_safety_escalation_kind
  CHECK (kind IN ('dispatch_held', 'refund_fact_without_authorization', 'failed_attempt_refund_evidence'));
-- the competing attempt belongs to this kind, and only to it
ALTER TABLE refund_safety_escalation ADD CONSTRAINT refund_safety_escalation_competing_shape
  CHECK ((kind = 'failed_attempt_refund_evidence') = ("competingAttemptId" IS NOT NULL)
     AND ("competingAttemptId" IS NULL) = ("competingAttemptStatus" IS NULL));
CREATE UNIQUE INDEX refund_safety_escalation_failed_evidence_once ON refund_safety_escalation ("factId") WHERE kind = 'failed_attempt_refund_evidence';

-- 0032's guard, with one more branch. The `dispatch_held` and `refund_fact_without_authorization` branches are textually unchanged.
CREATE OR REPLACE FUNCTION refund_safety_escalation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a refund_attempt%ROWTYPE; c refund_attempt%ROWTYPE;
BEGIN
  SELECT * INTO a FROM refund_attempt WHERE id = NEW."refundAttemptId";
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'refund_safety_escalation: unknown refund attempt' USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_evidence';
  END IF;
  IF NEW.kind = 'dispatch_held' THEN
    -- only an attempt that may still be sent, and only on evidence the frozen rule counts: a hold never stops a refund without that evidence
    IF a.status <> 'authorized' OR NOT EXISTS (SELECT 1 FROM refund_capture_evidence_facts(a."captureFactId") e WHERE e = NEW."factId") THEN
      RAISE EXCEPTION 'refund_safety_escalation: attempt % is not held by evidence %', a.id, NEW."factId"
        USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_evidence';
    END IF;
  ELSIF NEW.kind = 'failed_attempt_refund_evidence' THEN
    -- Core V2 RLSC-1: the failed attempt's OWN verified refund fact, and a competing attempt of the same payment and capture that is effective NOW
    SELECT * INTO c FROM refund_attempt WHERE id = NEW."competingAttemptId";
    IF a.status <> 'failed'
       OR NOT EXISTS (SELECT 1 FROM provider_transaction_fact f WHERE f.id = NEW."factId" AND f.kind = 'refund' AND f."refundAttemptId" = a.id
                        AND f."paymentId" = a."paymentId")
       OR c.id IS NULL OR c.id = a.id OR c."paymentId" <> a."paymentId" OR c."captureFactId" <> a."captureFactId"
       OR c.status IN ('authorization_expired', 'authorization_refused', 'failed') THEN
      RAISE EXCEPTION 'refund_safety_escalation: fact % of failed attempt % has no effective competing attempt %', NEW."factId", a.id, NEW."competingAttemptId"
        USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_evidence';
    END IF;
    NEW."competingAttemptStatus" := c.status;
  ELSIF NOT EXISTS (SELECT 1 FROM refund_fact_allocation_block b JOIN provider_transaction_fact f ON f.id = b."factId"
                     WHERE b."factId" = NEW."factId" AND b.reason = 'no_authorization' AND f."refundAttemptId" = a.id) THEN
    RAISE EXCEPTION 'refund_safety_escalation: fact % is not a no_authorization block of attempt %', NEW."factId", a.id
      USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_evidence';
  END IF;
  NEW."paymentId" := a."paymentId";
  NEW."companyId" := a."companyId";
  NEW."captureFactId" := a."captureFactId";
  NEW."attemptStatus" := a.status;
  NEW."escalatedAt" := now();
  RETURN NEW;
END $$;
