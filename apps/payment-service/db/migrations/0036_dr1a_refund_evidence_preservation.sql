-- 0036 — payment-service: two escalation-only review items for refund finality evidence (Core V2 D-R1A; the Owner's D-R1 direction of 2026-11-23,
-- Q4 and Q5, foundation PR). DEVELOPMENT AND SIMULATION ONLY. Expand only, after 0033's and 0034's precedent: two escalation kinds, one nullable
-- column, the `factId` shape check widened by one kind, two partial unique indexes, and the 0034 insert guard extended by two branches (its four
-- existing branches textually unchanged). No existing row is rewritten; nothing is backfilled; no refund, dispatch, allocation, case, balance or
-- replacement-eligibility rule changes. Neither kind holds an attempt (the 0032 dispatch rule reads `dispatch_held` only).
--
--   * `failure_after_refund_evidence` (Q4): a provider-confirmed refund FAILURE reported for an attempt that already has its OWN verified refund
--     fact (`provider_transaction_fact` of kind `refund` naming this attempt and payment). Both observations are kept: the fact is unchanged, and
--     the failure's bounded code is recorded here. The attempt's status when the failure arrived is derived (in flight, `succeeded` or
--     `discrepancy`). One row per attempt. Whether an in-flight attempt should still move to `failed` on that report is NOT decided here: the
--     approved transition is unchanged (D-R1 open decision).
--   * `idempotency_retention_unproven` (Q5): the refund worker did NOT send an attempt again with its key, because no certified provider guarantee
--     establishes that the provider still de-duplicates that key (absent, uncertified, expired, revoked, or the retention window measured from
--     `authorizedAt` has passed). The attempt stays `dispatching` or `unknown`, unresolved; no evidence fact. One row per attempt. The capability
--     itself lives in Payment's reviewed code registry, not in the database: the guard checks the attempt's state only.

ALTER TABLE refund_safety_escalation ADD COLUMN "observedFailureCode" text;   -- failure_after_refund_evidence only: the reported failure's bounded code
ALTER TABLE refund_safety_escalation ADD CONSTRAINT refund_safety_escalation_observed_failure_shape
  CHECK ((kind = 'failure_after_refund_evidence') = ("observedFailureCode" IS NOT NULL)
     AND ("observedFailureCode" IS NULL OR "observedFailureCode" ~ '^[a-z][a-z0-9_]{0,63}$'));

ALTER TABLE refund_safety_escalation DROP CONSTRAINT refund_safety_escalation_fact_shape;
ALTER TABLE refund_safety_escalation ADD CONSTRAINT refund_safety_escalation_fact_shape
  CHECK ((kind IN ('dispatch_stalled', 'idempotency_retention_unproven')) = ("factId" IS NULL));

ALTER TABLE refund_safety_escalation DROP CONSTRAINT refund_safety_escalation_kind;
ALTER TABLE refund_safety_escalation ADD CONSTRAINT refund_safety_escalation_kind
  CHECK (kind IN ('dispatch_held', 'refund_fact_without_authorization', 'failed_attempt_refund_evidence', 'dispatch_stalled',
                  'failure_after_refund_evidence', 'idempotency_retention_unproven'));
CREATE UNIQUE INDEX refund_safety_escalation_failure_after_evidence_once ON refund_safety_escalation ("refundAttemptId") WHERE kind = 'failure_after_refund_evidence';
CREATE UNIQUE INDEX refund_safety_escalation_retention_unproven_once ON refund_safety_escalation ("refundAttemptId") WHERE kind = 'idempotency_retention_unproven';

-- 0034's guard, with two more branches. The `dispatch_held`, `failed_attempt_refund_evidence`, `dispatch_stalled` and
-- `refund_fact_without_authorization` branches are textually unchanged.
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
  ELSIF NEW.kind = 'dispatch_stalled' THEN
    -- Core V2 G3 (DO-44): still stuck, never acknowledged by the provider, 72 hours after its authorization (database time); no evidence fact
    IF NOT refund_attempt_dispatch_stuck(a.status, a."submittedAt") OR a."authorizedAt" IS NULL
       OR now() < a."authorizedAt" + refund_dispatch_stalled_threshold() THEN
      RAISE EXCEPTION 'refund_safety_escalation: attempt % is not stuck in dispatch past its threshold', a.id
        USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_not_due';
    END IF;
    NEW."factId" := NULL;
  ELSIF NEW.kind = 'failure_after_refund_evidence' THEN
    -- Core V2 D-R1A (Q4): the attempt's OWN verified refund fact exists, and the attempt can still receive a provider outcome or already holds that evidence
    IF a.status NOT IN ('dispatching', 'submitted', 'unknown', 'succeeded', 'discrepancy')
       OR NOT EXISTS (SELECT 1 FROM provider_transaction_fact f WHERE f.id = NEW."factId" AND f.kind = 'refund' AND f."refundAttemptId" = a.id
                        AND f."paymentId" = a."paymentId") THEN
      RAISE EXCEPTION 'refund_safety_escalation: fact % is not verified refund evidence of attempt % in a state a failure report can contradict', NEW."factId", a.id
        USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_evidence';
    END IF;
  ELSIF NEW.kind = 'idempotency_retention_unproven' THEN
    -- Core V2 D-R1A (Q5): only an attempt whose key may already be at the provider and that the worker would otherwise send again; no evidence fact
    IF a.status NOT IN ('dispatching', 'unknown') OR a."authorizedAt" IS NULL THEN
      RAISE EXCEPTION 'refund_safety_escalation: attempt % is not awaiting a same-key resend', a.id
        USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_evidence';
    END IF;
    NEW."factId" := NULL;
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
